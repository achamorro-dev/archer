import { spawn, type ChildProcess } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { stdin, stdout } from "node:process"
import { createInterface } from "node:readline/promises"

import { addAllAndCommit } from "./git"
import { log } from "./log"
import { noopProgress, type ProgressUI } from "./progress"
import type { PermissionGate } from "./permissions"
import type { RunOptions } from "./types"
import type { Workspace } from "./workspace"

type AppProcess = ChildProcess
type HumanAction = "continue" | "iterate" | "rerun" | "abort" | "prepare"

export async function runHumanReviewGate(
  workspace: Workspace,
  options: RunOptions,
  opencodeUrl: string,
  progress: ProgressUI = noopProgress,
  permissions?: PermissionGate,
) {
  if (!options.humanReview) return

  if (!stdin.isTTY || !stdout.isTTY) {
    progress.phaseSkipped("human-review")
    log.warn("[human-review] skipped because stdin/stdout are not interactive")
    return
  }

  if (options.resumeRunID && (await humanReviewApproved(workspace))) {
    progress.phaseCompleted("human-review", "already approved in previous run")
    log.info("[human-review] already approved in previous run; skipping on resume")
    return
  }

  progress.phaseStarted("human-review", "waiting for manual action")

  let iterations = 0
  let app: AppProcess | undefined

  // The whole gate runs with the TUI suspended: the readline prompts, the app
  // command's inherited stdout, and the interactive OpenCode TUI all need the
  // terminal to themselves.
  progress.suspend()
  try {
    log.section("human-review - implementation checkpoint")
    log.info("choose an action now, or Archer will prepare the configured app command after 10 seconds")
    let action = await askHumanAction({ timeoutMs: 10_000, timeoutAction: "prepare" })

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
        action = await askHumanAction()
        continue
      }

      if (action === "iterate") {
        iterations++
        await stopApp(app)
        app = undefined
        progress.phaseRunning("human-review", "interactive OpenCode iteration")
        // The interactive OpenCode TUI answers its own permission prompts;
        // Archer's gate must not race it for the same requests.
        permissions?.pause()
        try {
          await runInteractiveOpencode(options, opencodeUrl)
        } finally {
          permissions?.resume()
        }
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
    progress.resume()
  }
}

async function humanReviewApproved(workspace: Workspace) {
  try {
    const report = await readFile(join(workspace.dir, "reports", "human-review.md"), "utf8")
    return /^- Result: approved$/m.test(report)
  } catch {
    return false
  }
}

async function prepareApp(options: RunOptions, progress: ProgressUI): Promise<AppProcess | undefined> {
  progress.phaseRunning("human-review", "preparing app")
  await launchEmulator(options)
  progress.phaseRunning("human-review", "running app command")
  return startApp(options)
}

async function launchEmulator(options: RunOptions) {
  const emulatorID = options.emulatorID
  if (!emulatorID) {
    log.info("[human-review] no emulator configured; starting app command without launching one")
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

function startApp(options: RunOptions): AppProcess | undefined {
  if (!options.appRunCommand) {
    log.warn("[human-review] app launch disabled; start the app manually before continuing")
    return undefined
  }

  log.info(`[human-review] starting app: ${options.appRunCommand}`)
  // detached gives the shell its own process group, so stopApp can signal the
  // whole tree (pnpm/flutter spawn the real servers as grandchildren).
  return spawn("sh", ["-c", options.appRunCommand], {
    cwd: options.targetDir,
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
    env: process.env,
  })
}

async function askHumanAction(options: { timeoutMs?: number; timeoutAction?: HumanAction } = {}): Promise<HumanAction> {
  const rl = createInterface({ input: stdin, output: stdout })
  const controller = new AbortController()
  let interrupted = false
  // Raw-mode input never raises a process SIGINT; readline surfaces Ctrl+C
  // here instead, so without this listener the prompt would just hang.
  rl.on("SIGINT", () => {
    interrupted = true
    controller.abort()
  })
  const timeout = options.timeoutMs ? setTimeout(() => controller.abort(), options.timeoutMs) : undefined
  const timeoutHint = options.timeoutMs ? ` (auto-starts in ${Math.round(options.timeoutMs / 1000)}s)` : ""

  try {
    for (;;) {
      const answer = (await rl.question(`Human review: [c]ontinue, [i]terate, [s]tart app, [r]erun app, [a]bort${timeoutHint} > `, {
        signal: controller.signal,
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
    if (error instanceof Error && error.name === "AbortError") {
      stdout.write("\n")
      if (interrupted) {
        log.warn("[human-review] Ctrl+C received; aborting")
        return "abort"
      }
      if (options.timeoutAction) {
        log.info("[human-review] no response; preparing configured app command")
        return options.timeoutAction
      }
    }
    throw error
  } finally {
    if (timeout) clearTimeout(timeout)
    rl.close()
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
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return

  const exited = new Promise<number | null>((resolve) => proc.once("exit", (code) => resolve(code)))
  killAppGroup(proc, "SIGTERM")
  const code = await Promise.race([exited, sleep(5_000).then(() => undefined)])
  if (code === undefined) {
    killAppGroup(proc, "SIGKILL")
    await exited
    return
  }
  if (code !== null && ![0, 130, 143].includes(code)) log.warn(`[human-review] stopped app process with code ${code}`)
}

// The app runs in its own process group (detached); signal the group so dev
// servers spawned by the wrapper shell die too, not just the shell.
function killAppGroup(proc: AppProcess, signal: NodeJS.Signals) {
  if (!proc.pid) return
  try {
    process.kill(-proc.pid, signal)
  } catch {
    try {
      proc.kill(signal)
    } catch {
      // already gone
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
