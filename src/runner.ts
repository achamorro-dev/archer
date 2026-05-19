import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import type { FilePartInput, OpencodeClient, Part } from "@opencode-ai/sdk/v2"

import { opencodeConfig } from "./agents"
import { fileParts } from "./attachments"
import { addAllAndCommit, createCleanRepoSnapshot, ensureRepoReady, restoreRepoSnapshot, type RepoSnapshot, writeDiff } from "./git"
import { log } from "./log"
import { startOpencode } from "./opencode"
import { phases } from "./phases"
import type { Phase, RunOptions } from "./types"
import { cleanupWorkspace, createWorkspace, resumeWorkspace, type Workspace, writeSummary } from "./workspace"

export async function run(options: RunOptions) {
  await ensureRepoReady(options.targetDir, { includeDirty: options.includeDirty, maxAttempts: options.maxAttempts })

  const workspace = options.resumeRunID
    ? await resumeWorkspace(options.resumeRunID)
    : await createWorkspace(options.prompt)

  let runErr: unknown
  let opencode: Awaited<ReturnType<typeof startOpencode>> | undefined

  try {
    log.info(`Run ${workspace.runID} - dir: ${workspace.dir}`)

    const extraFiles = await fileParts(options.files, options.targetDir, "error")
    if (extraFiles.length > 0) log.info(`Adjuntos de usuario: ${extraFiles.map((file) => file.filename).join(", ")}`)

    opencode = await startOpencode(opencodeConfig(workspace.dir))
    log.info(`opencode SDK listo en ${opencode.url}`)

    for (const phase of phases) {
      if (shouldSkip(phase.name, options)) {
        log.warn(`[${phase.name}] saltada por flag`)
        continue
      }
      await runPhase(opencode.client, workspace, phase, options, extraFiles)
    }

    await writeSummary(workspace, phases.map((phase) => phase.name))
  } catch (error) {
    runErr = error
    throw error
  } finally {
    opencode?.close()

    if (runErr || options.keepRunDir) {
      log.warn(`Run dir preservado en ${workspace.dir}`)
    } else {
      await cleanupWorkspace(workspace).catch((error) => log.warn(`no pude limpiar ${workspace.dir}: ${String(error)}`))
    }
  }
}

async function runPhase(
  client: OpencodeClient,
  workspace: Workspace,
  phase: Phase,
  options: RunOptions,
  extraFiles: FilePartInput[],
) {
  log.section(`${phase.name} - ${phase.description}`)

  const prepared = await preparePhaseRun(workspace, phase, options, extraFiles)
  const baseline = await createCleanRepoSnapshot(options.targetDir)
  const assistantText = await runPhaseWithRetries(client, workspace, phase, options.targetDir, prepared, baseline)

  const reportAbs = await persistPhaseReport(workspace, phase, assistantText)
  await commitPhase(phase, reportAbs, options.targetDir)
}

type PreparedPhaseRun = {
  attachments: FilePartInput[]
  prompt: string
  model: { providerID: string; modelID: string }
  maxAttempts: number
}

async function preparePhaseRun(workspace: Workspace, phase: Phase, options: RunOptions, extraFiles: FilePartInput[]): Promise<PreparedPhaseRun> {
  const inputs = [...phase.inputFiles]
  if (phase.inputDiff) {
    const diffRel = join("diffs", `${phase.name}.pre.diff`)
    const diffAbs = join(workspace.dir, diffRel)
    await writeDiff(diffAbs, options.baseRef, options.targetDir)
    inputs.push(diffRel)
  }

  const phaseFiles = await fileParts(inputs, workspace.dir, "skip")
  const attachments = [...phaseFiles, ...extraFiles]
  const prompt = buildPhasePrompt(workspace, phase)
  const model = parseModel(options.modelOverride || phase.model)
  const maxAttempts = Math.max(1, options.maxAttempts)

  return { attachments, prompt, model, maxAttempts }
}

async function runPhaseWithRetries(
  client: OpencodeClient,
  workspace: Workspace,
  phase: Phase,
  targetDir: string,
  prepared: PreparedPhaseRun,
  baseline: RepoSnapshot | undefined,
) {
  if (!baseline && prepared.maxAttempts > 1) {
    throw new Error(`[${phase.name}] no puedo reintentar con working tree sucio; usa --max-attempts 1 o limpia el repo`)
  }

  let lastError: unknown

  for (let attempt = 1; attempt <= prepared.maxAttempts; attempt++) {
    log.info(`[${phase.name}] intento ${attempt}/${prepared.maxAttempts} con ${prepared.model.providerID}/${prepared.model.modelID}`)
    try {
      return await runPhaseAttempt(client, workspace, phase, targetDir, prepared, attempt)
    } catch (error) {
      lastError = error
      log.warn(`[${phase.name}] intento ${attempt} fallo: ${formatSdkError(error)}`)
      if (!(error instanceof LoggedAttemptError)) {
        await writeAttemptLog(workspace, phase, attempt, { error: formatSdkError(error) })
      }
      if (attempt < prepared.maxAttempts) await restorePhaseBaseline(phase, baseline, targetDir, error)
    }
  }

  if (lastError) {
    await restorePhaseBaseline(phase, baseline, targetDir, lastError)
    throw lastError
  }

  return ""
}

async function runPhaseAttempt(
  client: OpencodeClient,
  workspace: Workspace,
  phase: Phase,
  targetDir: string,
  prepared: PreparedPhaseRun,
  attempt: number,
) {
  const result = await promptPhase(client, {
    phase,
    workspace,
    targetDir,
    prompt: prepared.prompt,
    model: prepared.model,
    attachments: prepared.attachments,
  })
  const assistantText = extractAssistantText(result.parts)

  await writeAttemptLog(workspace, phase, attempt, {
    session: result.info.sessionID,
    agent: phase.agentName,
    model: prepared.model,
    attachments: prepared.attachments.map((file) => ({ filename: file.filename, mime: file.mime, url: file.url })),
    finish: result.info.finish,
    error: result.info.error,
    text: assistantText,
  })

  if (result.info.error) throw new LoggedAttemptError(formatSdkError(result.info.error))

  return assistantText
}

async function persistPhaseReport(workspace: Workspace, phase: Phase, assistantText: string) {
  const reportAbs = join(workspace.dir, phase.reportPath)
  if (!(await exists(reportAbs)) && assistantText.trim() !== "") {
    await mkdir(dirname(reportAbs), { recursive: true })
    await writeFile(reportAbs, assistantText)
  }

  if (!(await exists(reportAbs))) {
    log.warn(`[${phase.name}] el agente no escribio el reporte esperado en ${reportAbs}`)
  }

  return reportAbs
}

async function commitPhase(phase: Phase, reportAbs: string, targetDir: string) {
  const message = `archer(${phase.name}): ${await summaryFromReport(reportAbs)}`
  const committed = await addAllAndCommit(message, targetDir)
  if (!committed) {
    log.info(`[${phase.name}] sin cambios - sin commit`)
  } else {
    log.info(`[${phase.name}] commit: ${message}`)
  }
}

async function restorePhaseBaseline(phase: Phase, baseline: RepoSnapshot | undefined, targetDir: string, originalError: unknown) {
  if (!baseline) return
  try {
    await restoreRepoSnapshot(baseline, targetDir)
  } catch (restoreError) {
    throw new Error(
      `[${phase.name}] fallo y no pude restaurar el snapshot git: ${formatSdkError(restoreError)}; error original: ${formatSdkError(
        originalError,
      )}`,
    )
  }
}

async function promptPhase(
  client: OpencodeClient,
  input: {
    phase: Phase
    workspace: Workspace
    targetDir: string
    prompt: string
    model: { providerID: string; modelID: string }
    attachments: FilePartInput[]
  },
) {
  const session = await client.session.create({
    directory: input.targetDir,
    title: `archer ${input.workspace.runID} ${input.phase.name}`,
  })
  if (session.error) throw new Error(formatSdkError(session.error))
  if (!session.data?.id) throw new Error("opencode no devolvio session id")

  const response = await client.session.prompt({
    sessionID: session.data.id,
    directory: input.targetDir,
    agent: input.phase.agentName,
    model: input.model,
    parts: [...input.attachments, { type: "text", text: input.prompt }],
  })

  if (response.error) throw new Error(formatSdkError(response.error))
  if (!response.data) throw new Error("opencode no devolvio respuesta")
  return response.data
}

function buildPhasePrompt(workspace: Workspace, phase: Phase) {
  return [
    `# Fase del pipeline: ${phase.name}`,
    "",
    phase.description,
    "",
    "## Contexto del run",
    `- Run dir: ${workspace.dir}`,
    `- Escribe tu reporte final en: ${join(workspace.dir, phase.reportPath)}`,
    "- Working directory: el directorio donde se invoco `archer` (raiz del repo target).",
    "",
    "## Adjuntos",
    "Recibiras como ficheros adjuntos: el PRD original, los reportes de fases previas, el diff acumulado contra la rama base y cualquier `--file` pasado por el usuario. Leelos antes de actuar.",
    "",
    "## Cierre",
    "Antes de terminar, asegurate de:",
    "1. Haber aplicado los cambios necesarios al codigo del repo.",
    "2. Haber escrito el reporte (markdown, max ~80 lineas) en la ruta absoluta indicada arriba. Si no puedes escribirlo, responde con el contenido exacto del reporte y Archer lo guardara.",
    "3. Dejar el arbol en estado compilable.",
    "",
    "Sigue las instrucciones de tu system prompt para lo demas.",
  ].join("\n")
}

export function parseModel(value: string) {
  const [providerID, ...rest] = value.split("/")
  const modelID = rest.join("/")
  if (!providerID || !modelID) throw new Error(`modelo invalido: ${value}`)
  return { providerID, modelID }
}

export function shouldSkip(name: string, options: Pick<RunOptions, "onlyPhases" | "skipPhases">) {
  if (options.onlyPhases.length > 0) return !options.onlyPhases.includes(name)
  return options.skipPhases.includes(name)
}

class LoggedAttemptError extends Error {}

function extractAssistantText(parts: Part[]) {
  return parts
    .filter((part): part is Part & { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
}

async function summaryFromReport(path: string) {
  try {
    const content = await readFile(path, "utf8")
    for (const raw of content.split("\n")) {
      let line = raw.trim().replace(/^#+\s*/, "")
      if (!line) continue
      if (line.length > 72) line = line.slice(0, 72)
      return line
    }
  } catch {
    return "sin resumen"
  }
  return "sin resumen"
}

async function writeAttemptLog(workspace: Workspace, phase: Phase, attempt: number, payload: unknown) {
  await writeFile(join(workspace.dir, "logs", `${phase.name}.${attempt}.json`), JSON.stringify(payload, null, 2))
}

async function exists(path: string) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function formatSdkError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error && "data" in error) {
    const data = (error as { data?: unknown }).data
    if (typeof data === "object" && data && "message" in data) return String((data as { message?: unknown }).message)
  }
  if (typeof error === "object" && error && "name" in error) return String((error as { name?: unknown }).name)
  return String(error)
}
