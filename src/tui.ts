import {
  BoxRenderable,
  StyledText,
  TextRenderable,
  bg,
  bold,
  createCliRenderer,
  fg,
  stringToStyledText,
  t,
} from "@opentui/core"

import { log } from "./log"
import { openOpencodeSessionWindow } from "./opencode"

import type { BoxOptions, CliRenderer, KeyEvent, TextChunk } from "@opentui/core"
import type {
  ActivityKind,
  PermissionPromptInfo,
  PermissionReply,
  ProgressDiffSummary,
  ProgressPhase,
  ProgressStepUsage,
  ProgressTodo,
  ProgressTokens,
  ProgressUI,
  ProgressUsage,
} from "./progress"

const theme = {
  bg: "#0A0E1A",
  panel: "#101626",
  panelAlt: "#0D1320",
  border: "#26324B",
  borderDim: "#1B2438",
  accent: "#7AA2F7",
  teal: "#73DACA",
  green: "#9ECE6A",
  red: "#F7768E",
  yellow: "#E0AF68",
  orange: "#FF9E64",
  magenta: "#BB9AF7",
  cyan: "#7DCFFF",
  text: "#C0CAF5",
  dim: "#565F89",
  faint: "#3B4261",
}

const kindStyle: Record<ActivityKind, { icon: string; color: string }> = {
  tool: { icon: "⚒", color: theme.cyan },
  bash: { icon: "$", color: theme.green },
  think: { icon: "✻", color: theme.magenta },
  write: { icon: "✎", color: theme.accent },
  step: { icon: "▸", color: theme.teal },
  retry: { icon: "↻", color: theme.yellow },
  permission: { icon: "⚿", color: theme.yellow },
  todo: { icon: "☑", color: theme.teal },
  diff: { icon: "±", color: theme.orange },
  error: { icon: "✗", color: theme.red },
  info: { icon: "·", color: theme.dim },
  system: { icon: "◆", color: theme.dim },
}

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const pipelineWidth = 32
const feedLimit = 100

const permissionChoices: ReadonlyArray<{ reply: PermissionReply; label: string; color: string }> = [
  { reply: "once", label: "allow once", color: theme.green },
  { reply: "always", label: "always allow", color: theme.accent },
  { reply: "reject", label: "reject", color: theme.red },
]

type PhaseStatus = "pending" | "running" | "completed" | "skipped" | "failed"

type UsageSessionState = {
  cost: number
  tokens: ProgressTokens
  steps: number
  model: string
  reported: boolean
  totalReported: boolean
}

type PhaseState = ProgressPhase & {
  status: PhaseStatus
  detail: string
  sessionID: string
  cost: number
  tokens: ProgressTokens
  stepCount: number
  lastStepModel: string
  usageReported: boolean
  usageSessions: Map<string, UsageSessionState>
  seenStepIDs: Set<string>
  now: { kind: ActivityKind; message: string }
  todos: ProgressTodo[]
  diff?: ProgressDiffSummary
  startedAt?: number
  endedAt?: number
  updatedAt: number
}

type FeedEntry = {
  time: number
  phase: string
  kind: ActivityKind
  message: string
}

type PendingPermission = {
  info: PermissionPromptInfo
  resolve: (reply: PermissionReply) => void
}

export async function createTuiProgress(phases: readonly ProgressPhase[], onAbort?: () => void): Promise<ProgressUI> {
  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    consoleMode: "console-overlay",
    exitOnCtrlC: false,
    targetFps: 12,
    backgroundColor: theme.bg,
  })
  return new TuiProgress(renderer, phases, onAbort)
}

export class TuiProgress implements ProgressUI {
  private runID = ""
  private targetDir = ""
  private serverUrl = ""
  private status = "starting"
  private activePhase = ""
  private lastActivityAt = Date.now()
  private readonly startedAt = Date.now()
  private readonly phases: PhaseState[]
  private readonly feed: FeedEntry[] = []
  private readonly ticker: ReturnType<typeof setInterval>
  private readonly headerText: TextRenderable
  private readonly pipelineText: TextRenderable
  private readonly sessionText: TextRenderable
  private readonly feedText: TextRenderable
  private readonly footerText: TextRenderable
  private readonly overlay: BoxRenderable
  private readonly modal: BoxRenderable
  private readonly modalText: TextRenderable
  private readonly permissionQueue: PendingPermission[] = []
  private permissionChoice = 0
  private readonly handleKeyPress = (key: KeyEvent) => {
    if ((key.ctrl && key.name === "c") || key.raw === "\u0003") {
      key.preventDefault()
      key.stopPropagation()
      this.addEvent("archer", "system", "ctrl+c received; shutting down")
      this.render()
      this.onAbort?.()
      return
    }
    if (this.permissionQueue.length > 0) {
      this.handlePermissionKey(key)
      return
    }
    if (key.name !== "o" || key.ctrl || key.meta || key.option) return
    key.preventDefault()
    key.stopPropagation()
    this.openActiveSessionWindow("key")
  }

  constructor(
    private readonly renderer: CliRenderer,
    phases: readonly ProgressPhase[],
    private readonly onAbort?: () => void,
  ) {
    this.phases = phases.map((phase) => ({
      ...phase,
      status: "pending",
      detail: "",
      sessionID: "",
      cost: 0,
      tokens: emptyTokens(),
      stepCount: 0,
      lastStepModel: "",
      usageReported: false,
      usageSessions: new Map<string, UsageSessionState>(),
      seenStepIDs: new Set<string>(),
      now: { kind: "info", message: "" },
      todos: [],
      updatedAt: Date.now(),
    }))

    const shell = new BoxRenderable(renderer, {
      id: "archer-shell",
      width: "100%",
      height: "100%",
      backgroundColor: theme.bg,
      flexDirection: "column",
      paddingX: 1,
      gap: 0,
    })

    const header = this.panel({
      id: "archer-header",
      height: 4,
      borderColor: theme.border,
      backgroundColor: theme.panel,
    })

    const body = new BoxRenderable(renderer, {
      id: "archer-body",
      width: "100%",
      flexGrow: 1,
      flexDirection: "row",
      gap: 1,
    })

    const pipeline = this.panel({
      id: "archer-pipeline",
      width: pipelineWidth,
      height: "100%",
      borderColor: theme.borderDim,
      backgroundColor: theme.panelAlt,
      title: " pipeline ",
      titleAlignment: "left",
    })

    const right = new BoxRenderable(renderer, {
      id: "archer-right",
      height: "100%",
      flexGrow: 1,
      flexDirection: "column",
      gap: 0,
    })

    const session = this.panel({
      id: "archer-session",
      height: 10,
      width: "100%",
      borderColor: theme.border,
      backgroundColor: theme.panel,
      title: " current phase ",
      titleAlignment: "left",
    })

    const feed = this.panel({
      id: "archer-feed",
      flexGrow: 1,
      width: "100%",
      borderColor: theme.borderDim,
      backgroundColor: theme.panelAlt,
      title: " activity ",
      titleAlignment: "left",
    })

    const openFromFooter = (event: { preventDefault(): void; stopPropagation(): void }) => {
      event.preventDefault()
      event.stopPropagation()
      this.openActiveSessionWindow("click")
    }

    const footer = this.panel({
      id: "archer-footer",
      height: 3,
      borderColor: theme.borderDim,
      backgroundColor: theme.panel,
      onMouseDown: openFromFooter,
    })
    footer.text.onMouseDown = openFromFooter

    this.headerText = header.text
    this.pipelineText = pipeline.text
    this.sessionText = session.text
    this.feedText = feed.text
    this.footerText = footer.text

    right.add(session.box)
    right.add(feed.box)
    body.add(pipeline.box)
    body.add(right)
    shell.add(header.box)
    shell.add(body)
    shell.add(footer.box)
    renderer.root.add(shell)

    this.overlay = new BoxRenderable(renderer, {
      id: "archer-permission-overlay",
      position: "absolute",
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      zIndex: 100,
      alignItems: "center",
      justifyContent: "center",
      visible: false,
    })
    this.modal = new BoxRenderable(renderer, {
      id: "archer-permission-modal",
      border: true,
      borderStyle: "rounded",
      borderColor: theme.yellow,
      backgroundColor: theme.panel,
      title: " ⚿ permission required ",
      titleAlignment: "left",
      width: 64,
      height: 10,
      paddingX: 2,
      paddingY: 1,
    })
    this.modalText = new TextRenderable(renderer, { content: "", fg: theme.text, width: "100%", height: "100%" })
    this.modal.add(this.modalText)
    this.overlay.add(this.modal)
    renderer.root.add(this.overlay)

    renderer.keyInput.on("keypress", this.handleKeyPress)

    this.ticker = setInterval(() => this.render(), 250)
    this.render()
  }

  start(runID: string, targetDir: string) {
    this.runID = runID
    this.targetDir = targetDir
    this.status = "booting opencode"
    this.addEvent("archer", "system", `run ${runID} started`)
    this.render()
  }

  serverReady(url: string) {
    this.serverUrl = url
    this.status = "opencode ready"
    this.addEvent("archer", "system", `opencode server at ${url}`)
    this.render()
  }

  phaseStarted(name: string, detail = "") {
    this.setPhase(name, "running", detail || "started")
    this.addEvent(name, "system", detail || "phase started")
  }

  phaseRunning(name: string, detail = "") {
    this.setPhase(name, "running", detail)
    if (detail) this.addEvent(name, "info", detail)
  }

  phaseSession(name: string, sessionID: string) {
    const phase = this.findPhase(name)
    if (!phase) return
    phase.sessionID = sessionID
    phase.updatedAt = Date.now()
    this.activePhase = name
    this.addEvent(name, "system", `session ${shortID(sessionID)}`)
    this.render()
  }

  phaseActivity(name: string, detail: string, kind: ActivityKind = "info", pulse = false) {
    const phase = this.findPhase(name)
    if (!phase) return
    phase.now = { kind, message: detail }
    phase.updatedAt = Date.now()
    this.activePhase = name
    this.status = `${name}: ${detail}`
    if (pulse) this.lastActivityAt = Date.now()
    else this.addEvent(name, kind, detail)
    this.render()
  }

  phaseStepUsage(name: string, usage: ProgressStepUsage) {
    const phase = this.findPhase(name)
    if (!phase || isDuplicateStep(phase, usage.stepID)) return

    const session = this.usageSession(phase, usage.sessionID)
    if (!session.totalReported) {
      session.cost += safeCost(usage.cost)
      if (usage.tokens) session.tokens = addTokens(session.tokens, usage.tokens)
    }
    session.steps += 1
    session.model = usage.model || session.model
    session.reported = true

    phase.lastStepModel = usage.model || phase.lastStepModel
    phase.updatedAt = Date.now()
    this.recalculateUsage(phase)
    this.render()
  }

  phaseUsageTotal(name: string, usage: ProgressUsage) {
    const phase = this.findPhase(name)
    if (!phase) return

    const session = this.usageSession(phase, usage.sessionID)
    if (typeof usage.cost === "number") session.cost = safeCost(usage.cost)
    if (usage.tokens) session.tokens = cloneTokens(usage.tokens)
    session.model = usage.model || session.model
    session.reported = true
    session.totalReported = true

    if (usage.model) phase.lastStepModel = usage.model
    phase.updatedAt = Date.now()
    this.recalculateUsage(phase)
    this.render()
  }

  phaseTodos(name: string, todos: ProgressTodo[]) {
    const phase = this.findPhase(name)
    if (!phase) return
    phase.todos = todos
    phase.updatedAt = Date.now()
    this.render()
  }

  phaseDiff(name: string, summary: ProgressDiffSummary) {
    const phase = this.findPhase(name)
    if (!phase) return
    phase.diff = summary
    phase.updatedAt = Date.now()
    this.render()
  }

  phaseCompleted(name: string, detail = "") {
    this.setPhase(name, "completed", detail || "done")
    this.addEvent(name, "system", detail || "phase completed")
  }

  phaseSkipped(name: string) {
    this.setPhase(name, "skipped", "skipped")
    this.addEvent(name, "system", "skipped by flag")
  }

  phaseFailed(name: string, detail = "") {
    this.setPhase(name, "failed", detail || "failed")
    this.addEvent(name, "error", detail || "failed")
  }

  askPermission(info: PermissionPromptInfo): Promise<PermissionReply> {
    if (this.renderer.isDestroyed) return Promise.resolve("reject")
    return new Promise((resolve) => {
      this.permissionQueue.push({ info, resolve })
      if (this.permissionQueue.length === 1) this.permissionChoice = 0
      this.addEvent("archer", "permission", `approval needed: ${permissionSummary(info)}`)
      this.render()
    })
  }

  message(message: string) {
    this.status = message
    this.addEvent("archer", "system", message)
    this.render()
  }

  suspend() {
    if (this.renderer.isDestroyed) return
    log.mute(false)
    this.renderer.suspend()
  }

  resume() {
    if (this.renderer.isDestroyed) return
    log.mute(true)
    this.renderer.resume()
    this.render()
  }

  stop() {
    clearInterval(this.ticker)
    log.mute(false)
    this.renderer.keyInput.off("keypress", this.handleKeyPress)
    for (const pending of this.permissionQueue.splice(0)) pending.resolve("reject")
    if (this.renderer.isDestroyed) return
    this.renderer.destroy()
  }

  private panel(options: BoxOptions) {
    const box = new BoxRenderable(this.renderer, {
      border: true,
      borderStyle: "rounded",
      paddingX: 1,
      paddingY: 0,
      ...options,
    })
    const text = new TextRenderable(this.renderer, {
      content: "",
      fg: theme.text,
      width: "100%",
      height: "100%",
    })
    box.add(text)
    return { box, text }
  }

  private handlePermissionKey(key: KeyEvent) {
    key.preventDefault()
    key.stopPropagation()
    switch (key.name) {
      case "left":
        this.permissionChoice = (this.permissionChoice + permissionChoices.length - 1) % permissionChoices.length
        break
      case "right":
      case "tab":
        this.permissionChoice = (this.permissionChoice + 1) % permissionChoices.length
        break
      case "return":
      case "linefeed":
        this.resolvePermission(permissionChoices[this.permissionChoice]!.reply)
        break
      case "o":
      case "y":
        this.resolvePermission("once")
        break
      case "a":
        this.resolvePermission("always")
        break
      case "r":
      case "n":
      case "escape":
        this.resolvePermission("reject")
        break
    }
    this.render()
  }

  private resolvePermission(reply: PermissionReply) {
    const pending = this.permissionQueue.shift()
    if (!pending) return
    this.permissionChoice = 0
    const verdict = reply === "once" ? "allowed once" : reply === "always" ? "always allowed" : "rejected"
    this.addEvent("archer", "permission", `${verdict}: ${permissionSummary(pending.info)}`)
    pending.resolve(reply)
    this.render()
  }

  private openActiveSessionWindow(source: "click" | "key") {
    const active = this.findPhase(this.activePhase) ?? this.phases.find((phase) => phase.status === "running")
    if (!this.serverUrl) {
      this.addEvent("archer", "system", "opencode server is not ready yet")
      this.render()
      return
    }
    if (!active?.sessionID) {
      this.addEvent("archer", "system", "no active opencode session to open yet")
      this.render()
      return
    }

    try {
      openOpencodeSessionWindow({ url: this.serverUrl, targetDir: this.targetDir || process.cwd(), sessionID: active.sessionID })
      this.addEvent("archer", "system", `${source === "key" ? "[o]" : "click"}: opening ${active.name} session ${shortID(active.sessionID)}`)
    } catch (error) {
      this.addEvent("archer", "error", `couldn't open opencode session: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.render()
  }

  private setPhase(name: string, status: PhaseStatus, detail: string) {
    const phase = this.findPhase(name)
    if (!phase) return
    if (status === "running" && phase.startedAt === undefined) phase.startedAt = Date.now()
    if (status === "completed" || status === "failed" || status === "skipped") phase.endedAt = Date.now()
    phase.status = status
    phase.detail = detail
    phase.updatedAt = Date.now()
    this.activePhase = name
    this.status = `${name}: ${detail || status}`
    this.lastActivityAt = Date.now()
    this.render()
  }

  private findPhase(name: string) {
    return this.phases.find((item) => item.name === name)
  }

  private addEvent(phase: string, kind: ActivityKind, message: string) {
    this.lastActivityAt = Date.now()
    const entry: FeedEntry = { time: this.lastActivityAt, phase, kind, message: truncate(message, 220) }
    const last = this.feed[this.feed.length - 1]

    // Streaming kinds update in place; identical repeats collapse. Keeps the feed calm.
    if (last && last.phase === phase && last.kind === kind) {
      if (kind === "think" || kind === "write" || last.message === entry.message) {
        this.feed[this.feed.length - 1] = entry
        return
      }
    }
    this.feed.push(entry)
    if (this.feed.length > feedLimit) this.feed.splice(0, this.feed.length - feedLimit)
  }

  private usageSession(phase: PhaseState, sessionID?: string) {
    const key = sessionID || phase.sessionID || "phase"
    const existing = phase.usageSessions.get(key)
    if (existing) return existing

    const created: UsageSessionState = { cost: 0, tokens: emptyTokens(), steps: 0, model: "", reported: false, totalReported: false }
    phase.usageSessions.set(key, created)
    return created
  }

  private recalculateUsage(phase: PhaseState) {
    let cost = 0
    let tokens = emptyTokens()
    let stepCount = 0
    let usageReported = false
    for (const session of phase.usageSessions.values()) {
      cost += session.cost
      tokens = addTokens(tokens, session.tokens)
      stepCount += session.steps
      usageReported ||= session.reported
    }
    phase.cost = cost
    phase.tokens = tokens
    phase.stepCount = stepCount
    phase.usageReported = usageReported
  }

  private render() {
    if (this.renderer.isDestroyed) return
    const now = Date.now()
    const active = this.findPhase(this.activePhase) ?? this.phases.find((phase) => phase.status === "running")
    const innerWidth = Math.max(40, this.renderer.width - 6)
    const rightWidth = Math.max(40, this.renderer.width - pipelineWidth - 9)

    this.headerText.content = this.headerContent(now, innerWidth)
    this.pipelineText.content = this.pipelineContent(now)
    this.sessionText.content = this.sessionContent(active, now, rightWidth)
    this.feedText.content = this.feedContent(now, rightWidth)
    this.footerText.content = this.footerContent(now, innerWidth)
    this.renderPermissionModal()
    this.renderer.requestRender()
  }

  private headerContent(now: number, width: number) {
    const usage = totalUsage(this.phases)
    const done = this.phases.filter((phase) => phase.status === "completed" || phase.status === "skipped").length
    const failed = this.phases.some((phase) => phase.status === "failed")
    const finished = this.phases.length > 0 && done === this.phases.length

    const title: TextChunk[] = [
      bold(fg(theme.accent)("◆ archer")),
      fg(theme.faint)("  ·  "),
      fg(theme.text)(truncate(projectName(this.targetDir), 28)),
    ]
    const line1 = padBetween(title, this.stateChunks(now), width)

    const barWidth = Math.max(16, Math.min(48, Math.floor(width * 0.42)))
    const barColor = failed ? theme.red : finished ? theme.green : theme.accent
    const line2 = new StyledText([
      ...progressBar(this.overallFraction(), barWidth, barColor),
      raw("  "),
      fg(theme.text)(`${done}/${this.phases.length}`),
      fg(theme.dim)(" phases"),
      fg(theme.faint)("  ·  "),
      fg(theme.text)(formatElapsed(now - this.startedAt)),
      fg(theme.faint)("  ·  "),
      fg(theme.green)(formatMoney(usage.cost)),
      fg(theme.faint)("  ·  "),
      fg(theme.dim)(`↑${formatCount(usage.tokens.input)} ↓${formatCount(usage.tokens.output)}`),
    ])
    return joinLines([line1, line2])
  }

  private stateChunks(now: number): TextChunk[] {
    if (this.permissionQueue.length > 0) return [bold(fg(theme.yellow)("⚿ waiting for your approval"))]
    const failed = this.phases.find((phase) => phase.status === "failed")
    if (failed) return [bold(fg(theme.red)(`✗ ${failed.name} failed`))]
    const running = this.phases.find((phase) => phase.status === "running")
    if (running) return [fg(theme.accent)(`${spinnerFrame(now)} `), bold(fg(theme.text)(running.name)), fg(theme.dim)(" running")]
    if (this.phases.length > 0 && this.phases.every((phase) => phase.status === "completed" || phase.status === "skipped")) {
      return [bold(fg(theme.green)("✓ run complete"))]
    }
    return [fg(theme.dim)(truncate(this.status, 36))]
  }

  private overallFraction() {
    const total = Math.max(1, this.phases.length)
    let done = 0
    for (const phase of this.phases) {
      if (phase.status === "completed" || phase.status === "skipped") done += 1
      else if (phase.status === "running") done += runningFraction(phase)
    }
    return Math.min(1, done / total)
  }

  private pipelineContent(now: number) {
    const width = pipelineWidth - 4
    const out: StyledText[] = []
    for (const phase of this.phases) {
      const isActive = phase.status === "running"
      const marker = isActive ? fg(theme.accent)("▎") : fg(theme.faint)(" ")
      const name =
        phase.status === "pending"
          ? fg(theme.dim)(phase.name)
          : phase.status === "skipped"
            ? fg(theme.faint)(phase.name)
            : isActive
              ? bold(fg(theme.text)(phase.name))
              : fg(theme.text)(phase.name)
      const left: TextChunk[] = [marker, raw(" "), statusIcon(phase.status, now), raw(" "), name]
      out.push(padBetween(left, phaseMetaChunks(phase, now), width))
      if (isActive && phase.detail) {
        out.push(t`    ${fg(theme.faint)(truncate(phase.detail, width - 5))}`)
      }
    }
    return joinLines(out)
  }

  private sessionContent(active: PhaseState | undefined, now: number, width: number) {
    if (!active) {
      return joinLines([plain(""), t`${fg(theme.dim)("waiting for the first phase to start…")}`])
    }

    const out: StyledText[] = []
    const head: TextChunk[] =
      active.status === "running"
        ? [fg(theme.accent)(`${spinnerFrame(now)} `), bold(fg(theme.text)(active.name))]
        : [statusIcon(active.status, now), raw(" "), bold(fg(theme.text)(active.name))]
    if (active.detail) {
      head.push(fg(theme.faint)("  ·  "), fg(theme.dim)(truncate(active.detail, Math.max(10, width - active.name.length - 8))))
    }
    out.push(new StyledText(head))
    out.push(plain(""))

    const style = kindStyle[active.now.kind]
    out.push(
      active.now.message
        ? new StyledText([fg(style.color)(`${style.icon} `), fg(theme.text)(truncate(active.now.message, width - 4))])
        : t`${fg(theme.dim)("waiting for opencode events…")}`,
    )
    out.push(plain(""))

    if (active.todos.length > 0) out.push(todoLine(active.todos, width))
    if (active.diff && active.diff.files > 0) {
      out.push(
        t`${fg(theme.dim)("changes ")}${fg(theme.text)(`${active.diff.files} files`)} ${fg(theme.green)(`+${active.diff.additions}`)} ${fg(theme.red)(`−${active.diff.deletions}`)}`,
      )
    }

    const quiet = now - active.updatedAt
    const stats: TextChunk[] = [
      fg(theme.faint)("steps "),
      fg(theme.dim)(String(active.stepCount)),
      fg(theme.faint)(" · cost "),
      fg(theme.dim)(active.usageReported ? formatMoney(active.cost) : "—"),
      fg(theme.faint)(" · tokens "),
      fg(theme.dim)(active.usageReported ? `↑${formatCount(active.tokens.input)} ↓${formatCount(active.tokens.output)}` : "—"),
    ]
    if (active.lastStepModel) stats.push(fg(theme.faint)(` · ${truncate(active.lastStepModel, 28)}`))
    if (active.sessionID) stats.push(fg(theme.faint)(` · ${shortID(active.sessionID)}`))
    if (quiet > 10_000 && active.status === "running") {
      stats.push(fg(quiet > 60_000 ? theme.yellow : theme.faint)(` · quiet ${Math.floor(quiet / 1000)}s`))
    }
    out.push(new StyledText(stats))
    return joinLines(out)
  }

  private feedContent(now: number, width: number) {
    const visible = Math.max(4, this.renderer.height - 21)
    const events = this.feed.slice(-visible).reverse()
    if (events.length === 0) return t`${fg(theme.dim)("no activity yet…")}`

    return joinLines(
      events.map((entry, index) => {
        const style = kindStyle[entry.kind]
        // Newest-first list: blank the phase label when the older neighbour
        // repeats it, so each phase shows once at the start of its group.
        const older = events[index + 1]
        const phaseLabel = older && older.phase === entry.phase ? raw(" ".repeat(12)) : fg(theme.dim)(entry.phase.padEnd(12).slice(0, 12))
        return new StyledText([
          fg(theme.faint)(formatTime(entry.time)),
          raw(" "),
          fg(style.color)(style.icon),
          raw(" "),
          phaseLabel,
          raw(" "),
          fg(entry.kind === "error" ? theme.red : theme.text)(truncate(entry.message, Math.max(20, width - 26))),
        ])
      }),
    )
  }

  private footerContent(now: number, width: number) {
    if (this.permissionQueue.length > 0) {
      const left: TextChunk[] = [
        fg(theme.yellow)("⚿ "),
        fg(theme.dim)("←/→ choose · "),
        fg(theme.accent)("enter"),
        fg(theme.dim)(" confirm · "),
        fg(theme.accent)("o"),
        fg(theme.dim)("nce · "),
        fg(theme.accent)("a"),
        fg(theme.dim)("lways · "),
        fg(theme.accent)("r"),
        fg(theme.dim)("eject · "),
        fg(theme.accent)("esc"),
        fg(theme.dim)(" rejects"),
      ]
      const right: TextChunk[] = this.permissionQueue.length > 1 ? [fg(theme.yellow)(`${this.permissionQueue.length} pending`)] : []
      return padBetween(left, right, width)
    }

    const left: TextChunk[] = [
      fg(theme.dim)("["),
      fg(theme.accent)("o"),
      fg(theme.dim)("] open session · "),
      fg(theme.yellow)("ctrl+c"),
      fg(theme.dim)(" abort"),
    ]
    const quiet = now - this.lastActivityAt
    const right: TextChunk[] = [
      fg(theme.faint)(this.runID ? `run ${this.runID}` : "run …"),
      fg(theme.faint)(" · "),
      fg(theme.faint)(this.serverUrl ? `⚡ ${shortUrl(this.serverUrl)}` : "⚡ starting…"),
      fg(theme.faint)(" · "),
      fg(quiet > 60_000 ? theme.yellow : theme.faint)(formatAgo(quiet)),
    ]
    return padBetween(left, right, width)
  }

  private renderPermissionModal() {
    const pending = this.permissionQueue[0]
    this.overlay.visible = Boolean(pending)
    if (!pending) return

    const boxWidth = Math.max(44, Math.min(68, this.renderer.width - 8))
    const width = boxWidth - 6
    const info = pending.info
    const lines: StyledText[] = []

    const headChunks: TextChunk[] = [bold(fg(theme.text)(info.permission))]
    if (this.permissionQueue.length > 1) headChunks.push(fg(theme.faint)(`  ·  ${this.permissionQueue.length - 1} more queued`))
    lines.push(new StyledText(headChunks))
    lines.push(plain(""))
    if (info.command) lines.push(new StyledText([fg(theme.green)("$ "), fg(theme.text)(truncate(info.command, width - 2))]))
    if (info.target) lines.push(new StyledText([fg(theme.dim)("target "), fg(theme.text)(truncate(info.target, width - 7))]))
    if (info.patterns.length > 0) {
      lines.push(new StyledText([fg(theme.dim)("pattern "), fg(theme.text)(truncate(info.patterns.join(", "), width - 8))]))
    }
    if (info.description) lines.push(t`${fg(theme.faint)(truncate(info.description, width))}`)
    if (info.sessionID) lines.push(t`${fg(theme.faint)(`session ${shortID(info.sessionID)}`)}`)
    lines.push(plain(""))

    const buttons: TextChunk[] = []
    permissionChoices.forEach((choice, index) => {
      if (index > 0) buttons.push(raw("   "))
      const label = ` ${choice.label} `
      buttons.push(index === this.permissionChoice ? bold(bg(choice.color)(fg(theme.bg)(label))) : fg(theme.dim)(label))
    })
    lines.push(new StyledText(buttons))

    this.modal.width = boxWidth
    this.modal.height = lines.length + 4
    this.modalText.content = joinLines(lines)
  }
}

function joinLines(lines: StyledText[]): StyledText {
  const chunks: TextChunk[] = []
  lines.forEach((line, index) => {
    if (index > 0) chunks.push(raw("\n"))
    chunks.push(...line.chunks)
  })
  return new StyledText(chunks)
}

function plain(text: string): StyledText {
  return stringToStyledText(text)
}

function raw(text: string): TextChunk {
  return stringToStyledText(text).chunks[0] ?? fg(theme.text)(text)
}

function padBetween(left: TextChunk[], right: TextChunk[], width: number): StyledText {
  const gap = Math.max(1, width - chunksLength(left) - chunksLength(right))
  if (right.length === 0) return new StyledText(left)
  return new StyledText([...left, raw(" ".repeat(gap)), ...right])
}

function chunksLength(chunks: TextChunk[]) {
  return chunks.reduce((sum, chunk) => sum + chunk.text.length, 0)
}

function statusIcon(status: PhaseStatus, now: number): TextChunk {
  switch (status) {
    case "completed":
      return fg(theme.green)("✓")
    case "running":
      return fg(theme.accent)(spinnerFrame(now))
    case "failed":
      return fg(theme.red)("✗")
    case "skipped":
      return fg(theme.faint)("⊘")
    default:
      return fg(theme.faint)("○")
  }
}

function phaseMetaChunks(phase: PhaseState, now: number): TextChunk[] {
  if (phase.status === "pending") return []
  if (phase.status === "skipped") return [fg(theme.faint)("skipped")]
  const parts: TextChunk[] = []
  if (phase.startedAt !== undefined) {
    parts.push(fg(phase.status === "failed" ? theme.red : theme.dim)(formatElapsed((phase.endedAt ?? now) - phase.startedAt)))
  }
  if (phase.usageReported) parts.push(fg(theme.faint)(` ${formatMoney(phase.cost)}`))
  return parts
}

function todoLine(todos: ProgressTodo[], width: number): StyledText {
  const completed = todos.filter((todo) => todo.status === "completed").length
  const inProgress = todos.find((todo) => todo.status === "in_progress")
  const chunks: TextChunk[] = [
    fg(theme.faint)("todos "),
    ...progressBar(todos.length === 0 ? 0 : completed / todos.length, 10, theme.teal),
    fg(theme.text)(` ${completed}/${todos.length}`),
  ]
  if (inProgress) {
    chunks.push(fg(theme.faint)(" · "), fg(theme.dim)(truncate(inProgress.content, Math.max(10, width - 28))))
  }
  return new StyledText(chunks)
}

// Box-drawing strokes render single-width everywhere, unlike the geometric
// shapes (▰▱) that draw unevenly in many terminal fonts.
function progressBar(fraction: number, width: number, color: string): TextChunk[] {
  const cells = Math.max(0, Math.min(1, fraction)) * width
  const filled = Math.floor(cells)
  const head = filled < width && cells - filled >= 0.5
  const track = width - filled - (head ? 1 : 0)
  const chunks: TextChunk[] = []
  if (filled > 0) chunks.push(fg(color)("━".repeat(filled)))
  if (head) chunks.push(fg(color)("╸"))
  if (track > 0) chunks.push(fg(theme.faint)("─".repeat(track)))
  return chunks
}

function runningFraction(phase: PhaseState) {
  if (phase.todos.length === 0) return 0.1
  const completed = phase.todos.filter((todo) => todo.status === "completed").length
  return Math.min(0.95, Math.max(0.1, completed / phase.todos.length))
}

function permissionSummary(info: PermissionPromptInfo) {
  const detail = info.command || info.target || info.patterns.join(", ")
  return detail ? `${info.permission} · ${truncate(detail, 120)}` : info.permission
}

function spinnerFrame(now: number) {
  return spinnerFrames[Math.floor(now / 100) % spinnerFrames.length]!
}

function emptyTokens(): ProgressTokens {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

function cloneTokens(tokens: ProgressTokens): ProgressTokens {
  return { ...tokens }
}

function addTokens(left: ProgressTokens, right: ProgressTokens): ProgressTokens {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    total: left.total + right.total,
  }
}

function totalUsage(phases: PhaseState[]) {
  return phases.reduce(
    (usage, phase) => ({ cost: usage.cost + phase.cost, tokens: addTokens(usage.tokens, phase.tokens) }),
    { cost: 0, tokens: emptyTokens() },
  )
}

function isDuplicateStep(phase: PhaseState, stepID?: string) {
  if (!stepID) return false
  if (phase.seenStepIDs.has(stepID)) return true
  phase.seenStepIDs.add(stepID)
  return false
}

function safeCost(cost: number | undefined) {
  return typeof cost === "number" && Number.isFinite(cost) ? cost : 0
}

function formatMoney(cost: number) {
  return `$${cost.toFixed(cost >= 1 ? 2 : 4)}`
}

function formatCount(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function formatElapsed(ms: number) {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

function formatAgo(ms: number) {
  const seconds = Math.floor(ms / 1000)
  if (seconds <= 1) return "now"
  if (seconds < 60) return `${seconds}s ago`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s ago`
}

function formatTime(time: number) {
  return new Date(time).toLocaleTimeString("en-GB", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function shortID(value: string) {
  if (value.length <= 12) return value
  return `${value.slice(0, 7)}…${value.slice(-4)}`
}

function shortUrl(value: string) {
  return value.replace(/^https?:\/\//, "")
}

function projectName(dir: string) {
  if (!dir) return "…"
  const parts = dir.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? dir
}

function truncate(value: string, max: number) {
  const singleLine = value.replace(/\s+/g, " ").trim()
  if (singleLine.length <= max) return singleLine
  return `${singleLine.slice(0, Math.max(0, max - 1))}…`
}
