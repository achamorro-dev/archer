import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { stdin, stdout } from "node:process"
import { createInterface } from "node:readline/promises"

import { addAllAndCommit } from "./git"
import { log } from "./log"
import { noopProgress, type ProgressUI } from "./progress"
import type { RunOptions } from "./types"
import type { Workspace } from "./workspace"

type AppProcess = ReturnType<typeof Bun.spawn>
type HumanAction = "continue" | "iterate" | "rerun" | "abort" | "prepare"
type FlutterEmulator = { id?: string; name?: string; platformType?: string }

export async function runHumanReviewGate(workspace: Workspace, options: RunOptions, opencodeUrl: string, progress: ProgressUI = noopProgress) {
  if (!options.humanReview) return

  if (!stdin.isTTY || !stdout.isTTY) {
    progress.phaseSkipped("human-review")
    log.warn("[human-review] skipped because stdin/stdout are not interactive")
    return
  }

  progress.phaseStarted("human-review", "waiting for manual action")
  log.section("human-review - implementation checkpoint")
  log.info("choose an action now, or Archer will start the emulator and app automatically after 10 seconds")

  let iterations = 0
  let app: AppProcess | undefined
  let action = await askHumanActionWithProgress(progress, { timeoutMs: 10_000, timeoutAction: "prepare" })

  try {
    for (;;) {
      if (action === "continue") {
        await commitHumanChanges(options)
        await writeHumanReviewReport(workspace, options, "approved", iterations)
        progress.phaseCompleted("human-review", "approved")
        return
      }

      if (action === "prepare" || action === "rerun") {
        await stopApp(app)
        app = await prepareApp(options, progress)
        action = await askHumanActionWithProgress(progress)
        continue
      }

      if (action === "iterate") {
        iterations++
        await stopApp(app)
        app = undefined
        progress.phaseRunning("human-review", "interactive OpenCode iteration")
        await runInteractiveOpencode(options, opencodeUrl)
        await commitHumanChanges(options)
        action = "prepare"
        continue
      }

      await writeHumanReviewReport(workspace, options, "aborted", iterations)
      progress.phaseFailed("human-review", "aborted by user")
      throw new Error("aborted by human review")
    }
  } finally {
    await stopApp(app)
  }
}

async function prepareApp(options: RunOptions, progress: ProgressUI): Promise<AppProcess | undefined> {
  progress.phaseRunning("human-review", "launching emulator")
  await launchEmulator(options)
  progress.phaseRunning("human-review", "running app command")
  return await startApp(options)
}

async function launchEmulator(options: RunOptions) {
  const emulatorID = options.emulatorID || (await findDefaultEmulator(options.targetDir))
  if (!emulatorID) {
    log.warn("[human-review] no Flutter emulator configured or detected; starting app command without launching one")
    return
  }

  log.info(`[human-review] launching emulator ${emulatorID}`)
  const proc = Bun.spawn(["flutter", "emulators", "--launch", emulatorID], {
    cwd: options.targetDir,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  })
  const code = await proc.exited
  if (code !== 0) log.warn(`[human-review] emulator launch exited with code ${code}; start it manually if needed`)
}

async function findDefaultEmulator(targetDir: string) {
  const proc = Bun.spawn(["flutter", "emulators", "--machine"], {
    cwd: targetDir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  })
  const stdoutPromise = new Response(proc.stdout).text()
  const stderrPromise = new Response(proc.stderr).text()
  const code = await proc.exited
  const [stdoutText, stderrText] = await Promise.all([stdoutPromise, stderrPromise])

  if (code !== 0) {
    log.warn(`[human-review] couldn't list Flutter emulators: ${(stderrText || stdoutText).trim() || `exit ${code}`}`)
    return ""
  }

  try {
    const emulators = JSON.parse(stdoutText) as FlutterEmulator[]
    const emulator = emulators.find((item) => item.platformType === "android") ?? emulators[0]
    if (emulator?.id) log.info(`[human-review] selected emulator ${emulator.id}${emulator.name ? ` (${emulator.name})` : ""}`)
    return emulator?.id ?? ""
  } catch {
    log.warn("[human-review] couldn't parse `flutter emulators --machine` output; pass --emulator explicitly if needed")
    return ""
  }
}

async function startApp(options: RunOptions): Promise<AppProcess | undefined> {
  if (!options.appRunCommand) {
    log.warn("[human-review] app launch disabled; start the app manually before continuing")
    return undefined
  }

  log.info(`[human-review] starting app: ${options.appRunCommand}`)
  const proc = Bun.spawn(["sh", "-lc", options.appRunCommand], {
    cwd: options.targetDir,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  })

  return proc
}

async function askHumanAction(options: { timeoutMs?: number; timeoutAction?: HumanAction } = {}): Promise<HumanAction> {
  const rl = createInterface({ input: stdin, output: stdout })
  const controller = options.timeoutMs ? new AbortController() : undefined
  const timeout = options.timeoutMs ? setTimeout(() => controller?.abort(), options.timeoutMs) : undefined
  const timeoutHint = options.timeoutMs ? ` (auto-starts in ${Math.round(options.timeoutMs / 1000)}s)` : ""

  try {
    for (;;) {
      const answer = (await rl.question(`Human review: [c]ontinue, [i]terate, [s]tart app, [r]erun app, [a]bort${timeoutHint} > `, {
        signal: controller?.signal,
      }))
        .trim()
        .toLowerCase()
      if (answer === "c" || answer === "continue") return "continue" as const
      if (answer === "i" || answer === "iterate") return "iterate" as const
      if (answer === "s" || answer === "start" || answer === "prepare") return "prepare" as const
      if (answer === "r" || answer === "rerun") return "rerun" as const
      if (answer === "a" || answer === "abort") return "abort" as const
      stdout.write("Choose c, i, s, r, or a.\n")
    }
  } catch (error) {
    if (options.timeoutAction && error instanceof Error && error.name === "AbortError") {
      stdout.write("\n")
      log.info("[human-review] no response; starting emulator and app automatically")
      return options.timeoutAction
    }
    throw error
  } finally {
    if (timeout) clearTimeout(timeout)
    rl.close()
  }
}

async function askHumanActionWithProgress(progress: ProgressUI, options: { timeoutMs?: number; timeoutAction?: HumanAction } = {}) {
  progress.suspend()
  try {
    return await askHumanAction(options)
  } finally {
    progress.resume()
  }
}

async function runInteractiveOpencode(options: RunOptions, opencodeUrl: string) {
  const args = [
    "run",
    "--interactive",
    "--attach",
    opencodeUrl,
    "--dir",
    options.targetDir,
    "--model",
    options.interactiveModel,
  ]
  if (options.interactiveVariant) args.push("--variant", options.interactiveVariant)

  log.info(`[human-review] handing control to OpenCode (${options.interactiveModel}${options.interactiveVariant ? `#${options.interactiveVariant}` : ""})`)
  const proc = Bun.spawn(["opencode", ...args], {
    cwd: options.targetDir,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  })

  const code = await proc.exited
  if (code !== 0) throw new Error(`[human-review] interactive OpenCode exited with code ${code}`)
}

async function commitHumanChanges(options: RunOptions) {
  const committed = await addAllAndCommit("archer(human-review): apply manual iteration", options.targetDir)
  if (committed) log.info("[human-review] committed manual changes")
}

async function writeHumanReviewReport(workspace: Workspace, options: RunOptions, result: "approved" | "aborted", iterations: number) {
  const reportPath = join(workspace.dir, "reports", "human-review.md")
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(
    reportPath,
    [
      "# human review",
      "",
      `- Result: ${result}`,
      `- Manual OpenCode iterations: ${iterations}`,
      `- App command: ${options.appRunCommand || "disabled"}`,
      `- Emulator: ${options.emulatorID || "not launched by Archer"}`,
      `- Interactive model: ${options.interactiveModel}${options.interactiveVariant ? `#${options.interactiveVariant}` : ""}`,
      "",
    ].join("\n"),
  )
}

async function stopApp(proc: AppProcess | undefined) {
  if (!proc) return
  proc.kill("SIGTERM")
  const code = await Promise.race([
    proc.exited,
    sleep(5_000).then(() => {
      proc.kill("SIGKILL")
      return proc.exited
    }),
  ])
  if (![0, 130, 143].includes(code)) log.warn(`[human-review] stopped app process with code ${code}`)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
