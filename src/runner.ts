import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import type { FilePartInput, OpencodeClient, Part } from "@opencode-ai/sdk/v2"

import { opencodeConfig } from "./agents"
import { fileParts } from "./attachments"
import { addAllAndCommit, createCleanRepoSnapshot, ensureRepoReady, restoreRepoSnapshot, type RepoSnapshot, writeDiff } from "./git"
import { runHumanReviewGate } from "./human"
import { log } from "./log"
import { startOpencode } from "./opencode"
import { phases } from "./phases"
import { createProgressUI, noopProgress, type ProgressPhase, type ProgressUI } from "./progress"
import type { Phase, RunOptions } from "./types"
import { cleanupWorkspace, createWorkspace, resumeWorkspace, type Workspace, writeSummary } from "./workspace"

export async function run(options: RunOptions) {
  await ensureRepoReady(options.targetDir, { includeDirty: options.includeDirty, maxAttempts: options.maxAttempts })

  const workspace = options.resumeRunID
    ? await resumeWorkspace(options.resumeRunID)
    : await createWorkspace(options.prompt)

  let runErr: unknown
  let opencode: Awaited<ReturnType<typeof startOpencode>> | undefined
  let progress: ProgressUI = noopProgress

  try {
    progress = await createProgressUI(progressPhases(options), options.tui)
    progress.start(workspace.runID, options.targetDir)
    log.info(`Run ${workspace.runID} - dir: ${workspace.dir}`)

    const extraFiles = await fileParts(options.files, options.targetDir, "error")
    if (extraFiles.length > 0) log.info(`User attachments: ${extraFiles.map((file) => file.filename).join(", ")}`)

    opencode = await startOpencode(opencodeConfig(workspace.dir))
    progress.message("opencode SDK ready")
    log.info(`opencode SDK ready at ${opencode.url}`)

    for (const phase of phases) {
      if (shouldSkip(phase.name, options)) {
        progress.phaseSkipped(phase.name)
        if (phase.name === "implementer" && options.humanReview) progress.phaseSkipped("human-review")
        log.warn(`[${phase.name}] skipped by flag`)
        continue
      }
      await runPhase(opencode.client, workspace, phase, options, extraFiles, progress)
      if (phase.name === "implementer") await runHumanReviewGate(workspace, options, opencode.url, progress)
    }

    progress.message("writing run summary")
    await writeSummary(workspace, summaryReportNames(options.humanReview))
  } catch (error) {
    runErr = error
    throw error
  } finally {
    progress.stop()
    opencode?.close()

    if (runErr || options.keepRunDir) {
      log.warn(`Run dir preserved at ${workspace.dir}`)
    } else {
      await cleanupWorkspace(workspace).catch((error) => log.warn(`couldn't clean ${workspace.dir}: ${String(error)}`))
    }
  }
}

async function runPhase(
  client: OpencodeClient,
  workspace: Workspace,
  phase: Phase,
  options: RunOptions,
  extraFiles: FilePartInput[],
  progress: ProgressUI,
) {
  progress.phaseStarted(phase.name, phase.description)
  log.section(`${phase.name} - ${phase.description}`)

  try {
    const prepared = await preparePhaseRun(workspace, phase, options, extraFiles)
    const baseline = await createCleanRepoSnapshot(options.targetDir)
    const assistantText = await runPhaseWithRetries(client, workspace, phase, options.targetDir, prepared, baseline, progress)

    const reportAbs = await persistPhaseReport(workspace, phase, assistantText)
    await commitPhase(phase, reportAbs, options.targetDir)
    progress.phaseCompleted(phase.name, "report saved and commit checked")
  } catch (error) {
    progress.phaseFailed(phase.name, formatSdkError(error))
    throw error
  }
}

type PreparedPhaseRun = {
  attachments: FilePartInput[]
  prompt: string
  model: ModelSelection
  maxAttempts: number
}

type ModelSelection = { providerID: string; modelID: string; variant?: string }

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
  const model = selectedModel(phase, options.modelOverride)
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
  progress: ProgressUI,
) {
  if (!baseline && prepared.maxAttempts > 1) {
    throw new Error(`[${phase.name}] can't retry with dirty working tree; use --max-attempts 1 or clean the repo`)
  }

  let lastError: unknown

  for (let attempt = 1; attempt <= prepared.maxAttempts; attempt++) {
    progress.phaseRunning(phase.name, `attempt ${attempt}/${prepared.maxAttempts} ${formatModel(prepared.model)}`)
    log.info(`[${phase.name}] attempt ${attempt}/${prepared.maxAttempts} with ${formatModel(prepared.model)}`)
    try {
      return await runPhaseAttempt(client, workspace, phase, targetDir, prepared, attempt)
    } catch (error) {
      lastError = error
      progress.phaseRunning(phase.name, `attempt ${attempt} failed`)
      log.warn(`[${phase.name}] attempt ${attempt} failed: ${formatSdkError(error)}`)
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
    log.warn(`[${phase.name}] agent didn't write the expected report at ${reportAbs}`)
  }

  return reportAbs
}

async function commitPhase(phase: Phase, reportAbs: string, targetDir: string) {
  const message = `archer(${phase.name}): ${await summaryFromReport(reportAbs)}`
  const committed = await addAllAndCommit(message, targetDir)
  if (!committed) {
    log.info(`[${phase.name}] no changes - no commit`)
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
      `[${phase.name}] failed and couldn't restore git snapshot: ${formatSdkError(restoreError)}; original error: ${formatSdkError(
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
    model: ModelSelection
    attachments: FilePartInput[]
  },
) {
  const session = await client.session.create({
    directory: input.targetDir,
    title: `archer ${input.workspace.runID} ${input.phase.name}`,
  })
  if (session.error) throw new Error(formatSdkError(session.error))
  if (!session.data?.id) throw new Error("opencode didn't return session id")

  const response = await client.session.prompt({
    sessionID: session.data.id,
    directory: input.targetDir,
    agent: input.phase.agentName,
    model: { providerID: input.model.providerID, modelID: input.model.modelID },
    variant: input.model.variant,
    parts: [...input.attachments, { type: "text", text: input.prompt }],
  })

  if (response.error) throw new Error(formatSdkError(response.error))
  if (!response.data) throw new Error("opencode didn't return response")
  return response.data
}

function buildPhasePrompt(workspace: Workspace, phase: Phase) {
  return [
    `# Pipeline phase: ${phase.name}`,
    "",
    phase.description,
    "",
    "## Run context",
    `- Run dir: ${workspace.dir}`,
    `- Write your final report to: ${join(workspace.dir, phase.reportPath)}`,
    "- Working directory: the directory where `archer` was invoked (root of the target repo).",
    "",
    "## Attachments",
    "You will receive as file attachments: the original PRD, previous phase reports, the cumulative diff against the base branch, and any `--file` passed by the user. Read them before acting.",
    "",
    "## Closing",
    "Before finishing, make sure to:",
    "1. Have applied necessary changes to the repo code.",
    "2. Have written the report (markdown, max ~80 lines) at the absolute path indicated above. If you can't write it, respond with the exact report content and Archer will save it.",
    "3. Leave the tree in a compilable state.",
    "",
    "Follow your system prompt instructions for everything else.",
  ].join("\n")
}

export function parseModel(value: string) {
  const [providerID, ...rest] = value.split("/")
  const modelID = rest.join("/")
  if (!providerID || !modelID) throw new Error(`invalid model: ${value}`)
  return { providerID, modelID }
}

function selectedModel(phase: Phase, override: string): ModelSelection {
  const model = parseModel(override || phase.model)
  if (override || !phase.variant) return model
  return { ...model, variant: phase.variant }
}

function formatModel(model: ModelSelection) {
  const base = `${model.providerID}/${model.modelID}`
  return model.variant ? `${base}#${model.variant}` : base
}

export function shouldSkip(name: string, options: Pick<RunOptions, "onlyPhases" | "skipPhases">) {
  if (options.onlyPhases.length > 0) return !options.onlyPhases.includes(name)
  return options.skipPhases.includes(name)
}

function summaryReportNames(includeHumanReview: boolean) {
  return phases.flatMap((phase) => (phase.name === "implementer" && includeHumanReview ? [phase.name, "human-review"] : [phase.name]))
}

function progressPhases(options: RunOptions): ProgressPhase[] {
  return phases.flatMap((phase) => {
    const progressPhase: ProgressPhase = { name: phase.name, description: phase.description }
    if (phase.name === "implementer" && options.humanReview) {
      return [progressPhase, { name: "human-review", description: "Manual implementation checkpoint" }]
    }
    return [progressPhase]
  })
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
    return "no summary"
  }
  return "no summary"
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
