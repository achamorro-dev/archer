import type { BoxOptions, BoxRenderable, CliRenderer, TextOptions, TextRenderable } from "@opentui/core"

import { log } from "./log"
import type { Phase } from "./types"

export type ProgressPhase = Pick<Phase, "name" | "description">

export type ProgressUI = {
  start(runID: string, targetDir: string): void
  phaseStarted(name: string, detail?: string): void
  phaseRunning(name: string, detail?: string): void
  phaseCompleted(name: string, detail?: string): void
  phaseSkipped(name: string): void
  phaseFailed(name: string, detail?: string): void
  message(message: string): void
  suspend(): void
  resume(): void
  stop(): void
}

type PhaseStatus = "pending" | "running" | "completed" | "skipped" | "failed"

type PhaseState = ProgressPhase & {
  status: PhaseStatus
  detail: string
}

export const noopProgress: ProgressUI = {
  start() {},
  phaseStarted() {},
  phaseRunning() {},
  phaseCompleted() {},
  phaseSkipped() {},
  phaseFailed() {},
  message() {},
  suspend() {},
  resume() {},
  stop() {},
}

export async function createProgressUI(phases: readonly ProgressPhase[], enabled: boolean): Promise<ProgressUI> {
  if (!enabled || !process.stdout.isTTY) return noopProgress

  try {
    const { BoxRenderable, TextRenderable, createCliRenderer } = await import("@opentui/core")
    const renderer = await createCliRenderer({
      screenMode: "split-footer",
      footerHeight: Math.min(18, Math.max(10, phases.length + 5)),
      consoleMode: "disabled",
      exitOnCtrlC: true,
    })

    return new OpenTuiProgress(renderer, BoxRenderable, TextRenderable, phases)
  } catch (error) {
    log.warn(`OpenTUI unavailable; falling back to plain logs: ${error instanceof Error ? error.message : String(error)}`)
    return noopProgress
  }
}

class OpenTuiProgress implements ProgressUI {
  private runID = ""
  private targetDir = ""
  private status = "starting"
  private readonly startedAt = Date.now()
  private readonly phases: PhaseState[]
  private readonly panel: BoxRenderable
  private readonly text: TextRenderable

  constructor(
    private readonly renderer: CliRenderer,
    BoxCtor: new (ctx: CliRenderer, options: BoxOptions) => BoxRenderable,
    TextCtor: new (ctx: CliRenderer, options: TextOptions) => TextRenderable,
    phases: readonly ProgressPhase[],
  ) {
    this.phases = phases.map((phase) => ({ ...phase, status: "pending", detail: "" }))
    this.panel = new BoxCtor(renderer, {
      width: "100%",
      height: "100%",
      borderStyle: "rounded",
      borderColor: "#7AA2F7",
      title: " Archer Harness ",
      titleAlignment: "center",
      paddingX: 1,
      paddingY: 0,
    })
    this.text = new TextCtor(renderer, {
      content: "",
      fg: "#C0CAF5",
      width: "100%",
      height: "100%",
    })
    this.panel.add(this.text)
    renderer.root.add(this.panel)
    this.render()
  }

  start(runID: string, targetDir: string) {
    this.runID = runID
    this.targetDir = targetDir
    this.status = "booting opencode"
    this.render()
  }

  phaseStarted(name: string, detail = "") {
    this.setPhase(name, "running", detail || "started")
  }

  phaseRunning(name: string, detail = "") {
    this.setPhase(name, "running", detail)
  }

  phaseCompleted(name: string, detail = "") {
    this.setPhase(name, "completed", detail || "done")
  }

  phaseSkipped(name: string) {
    this.setPhase(name, "skipped", "skipped by flag")
  }

  phaseFailed(name: string, detail = "") {
    this.setPhase(name, "failed", detail || "failed")
  }

  message(message: string) {
    this.status = message
    this.render()
  }

  suspend() {
    if (this.renderer.isDestroyed) return
    this.renderer.suspend()
  }

  resume() {
    if (this.renderer.isDestroyed) return
    this.renderer.resume()
    this.render()
  }

  stop() {
    if (this.renderer.isDestroyed) return
    this.renderer.destroy()
  }

  private setPhase(name: string, status: PhaseStatus, detail: string) {
    const phase = this.phases.find((item) => item.name === name)
    if (!phase) return
    phase.status = status
    phase.detail = detail
    this.status = `${name}: ${detail || status}`
    this.render()
  }

  private render() {
    if (this.renderer.isDestroyed) return
    const done = this.phases.filter((phase) => phase.status === "completed" || phase.status === "skipped").length
    const total = this.phases.length
    const bar = progressBar(done, total, Math.min(36, Math.max(12, this.renderer.width - 30)))
    const elapsed = formatElapsed(Date.now() - this.startedAt)
    const lines = [
      `run ${this.runID || "pending"} | ${done}/${total} phases | ${elapsed}`,
      bar,
      ...this.phases.map((phase) => phaseLine(phase)),
      `status: ${this.status}`,
      `target: ${this.targetDir || process.cwd()}`,
    ]

    this.text.content = lines.join("\n")
    this.renderer.requestRender()
  }
}

function phaseLine(phase: PhaseState) {
  const marker = phase.status === "completed" ? "[x]" : phase.status === "running" ? "[>]" : phase.status === "failed" ? "[!]" : phase.status === "skipped" ? "[-]" : "[ ]"
  const name = phase.name.padEnd(14)
  const detail = phase.detail ? ` - ${phase.detail}` : ""
  return `${marker} ${name} ${phase.status}${detail}`
}

function progressBar(done: number, total: number, width: number) {
  const safeTotal = Math.max(1, total)
  const filled = Math.round((done / safeTotal) * width)
  return `[${"#".repeat(filled)}${"-".repeat(Math.max(0, width - filled))}]`
}

function formatElapsed(ms: number) {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, "0")}`
}
