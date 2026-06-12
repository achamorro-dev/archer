import {
  BoxRenderable,
  StyledText,
  TextRenderable,
  bg,
  bold,
  createCliRenderer,
  fg,
  t,
} from "@opentui/core"

import { log } from "./log"
import { openOpencodeSessionWindow } from "./opencode"
import {
  formatAgo,
  formatCount,
  formatElapsed,
  formatMoney,
  formatTime,
  joinLines,
  padBetween,
  paletteForTerminal,
  plain,
  progressBar,
  raw,
  setTheme,
  shortID,
  shortPath,
  shortUrl,
  spinnerFrame,
  statusIcon,
  terminalBackgroundHex,
  theme,
  truncate,
} from "./tui-theme"

import type { BoxOptions, CliRenderer, KeyEvent, TextChunk } from "@opentui/core"
import type { PaletteColor, PhaseStatus } from "./tui-theme"
import type {
  ActivityKind,
  AutoAccept,
  PermissionPromptInfo,
  PermissionReply,
  ProgressAttempt,
  ProgressDiffSummary,
  ProgressPhase,
  ProgressPhaseSnapshot,
  ProgressStepUsage,
  ProgressTodo,
  ProgressTokens,
  ProgressUI,
  ProgressUsage,
} from "./progress"

const kindStyles: Record<ActivityKind, { icon: string; color: PaletteColor }> = {
  tool: { icon: "⚒", color: "cyan" },
  bash: { icon: "$", color: "green" },
  think: { icon: "✻", color: "magenta" },
  write: { icon: "✎", color: "accent" },
  step: { icon: "▸", color: "teal" },
  retry: { icon: "↻", color: "yellow" },
  permission: { icon: "⚿", color: "yellow" },
  todo: { icon: "☑", color: "teal" },
  diff: { icon: "±", color: "orange" },
  error: { icon: "✗", color: "red" },
  info: { icon: "·", color: "dim" },
  system: { icon: "◆", color: "dim" },
}

function kindStyle(kind: ActivityKind): { icon: string; color: string } {
  const style = kindStyles[kind]
  return { icon: style.icon, color: theme[style.color] }
}

const pipelineWidth = 32
const feedLimit = 100

const permissionChoices: ReadonlyArray<{ reply: PermissionReply; label: string; color: PaletteColor }> = [
  { reply: "once", label: "allow once", color: "green" },
  { reply: "always", label: "always allow", color: "accent" },
  { reply: "reject", label: "reject", color: "red" },
]

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
  sessionID: string
  attempt: number
  maxAttempts: number
  /** Model requested for the attempt; lastStepModel (from usage events) wins when present. */
  model: string
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
  /** Real duration replayed from a previous run; set only by phaseRestored. */
  restoredDurationMs?: number
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

export async function createTuiProgress(
  phases: readonly ProgressPhase[],
  onAbort?: () => void,
  autoAccept?: AutoAccept,
): Promise<ProgressUI> {
  // No backgroundColor yet: the palette is only chosen after the terminal
  // answers the background query, so a light terminal never flashes dark.
  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    consoleMode: "console-overlay",
    exitOnCtrlC: false,
    targetFps: 12,
  })
  const mode = await renderer.waitForThemeMode(1_000).catch(() => null)
  setTheme(paletteForTerminal(mode, terminalBackgroundHex(renderer)))
  return new TuiProgress(renderer, phases, onAbort, autoAccept)
}

export class TuiProgress implements ProgressUI {
  private runID = ""
  private targetDir = ""
  private serverUrl = ""
  private activePhase = ""
  private lastActivityAt = Date.now()
  private readonly startedAt = Date.now()
  private readonly phases: PhaseState[]
  private readonly feed: FeedEntry[] = []
  private readonly ticker: ReturnType<typeof setInterval>
  private readonly dirText: TextRenderable
  private readonly headerText: TextRenderable
  private readonly pipelineText: TextRenderable
  private readonly stepBox: BoxRenderable
  private readonly stepText: TextRenderable
  private readonly todosBox: BoxRenderable
  private readonly todosText: TextRenderable
  private readonly feedText: TextRenderable
  private readonly footerText: TextRenderable
  // Rebuilt on every pipeline render: panel row index → phase name, so clicks
  // resolve against exactly what is on screen (the active phase adds a row).
  private pipelineRowPhases: (string | undefined)[] = []
  private readonly overlay: BoxRenderable
  private readonly modal: BoxRenderable
  private readonly modalText: TextRenderable
  // Panels repainted when the terminal reports a theme change mid-run.
  private readonly paletteTargets: Array<{ box: BoxRenderable; background: PaletteColor; border?: PaletteColor }> = []
  private readonly permissionQueue: PendingPermission[] = []
  private permissionChoice = 0
  // Suspension nests: outer scopes (human-review gate) and inner prompts may
  // both suspend; only the outermost transition touches the renderer.
  private suspendDepth = 0
  private readonly handleThemeMode = (mode: unknown) => {
    if (mode !== "dark" && mode !== "light") return
    setTheme(paletteForTerminal(mode, terminalBackgroundHex(this.renderer)))
    this.applyPalette()
    this.addEvent("archer", "system", `terminal theme changed: ${mode}`)
    this.render()
  }

  private readonly handleKeyPress = (key: KeyEvent) => {
    if ((key.ctrl && key.name === "c") || key.raw === "\u0003") {
      key.preventDefault()
      key.stopPropagation()
      this.addEvent("archer", "system", "ctrl+c received; shutting down")
      this.render()
      this.onAbort?.()
      return
    }
    // Checked before the permission modal so the toggle also resolves an
    // open prompt (enabling auto-accept flushes the whole queue).
    if (key.name === "tab" && key.shift) {
      key.preventDefault()
      key.stopPropagation()
      this.toggleAutoAccept()
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
    private readonly autoAccept?: AutoAccept,
  ) {
    this.phases = phases.map((phase) => ({
      ...phase,
      status: "pending",
      sessionID: "",
      attempt: 0,
      maxAttempts: 0,
      model: "",
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

    // The working directory sits above the header as a bare line, outside the
    // bordered box, so the header itself stays a single clean row of totals.
    const dirLine = new TextRenderable(renderer, {
      id: "archer-dir",
      content: "",
      fg: theme.text,
      width: "100%",
      height: 1,
    })

    const header = this.panel({
      id: "archer-header",
      height: 3,
      borderColor: theme.border,
      backgroundColor: theme.bg,
    })

    const body = new BoxRenderable(renderer, {
      id: "archer-body",
      width: "100%",
      flexGrow: 1,
      flexDirection: "row",
      gap: 1,
    })

    const openFromPipeline = (event: { y: number; preventDefault(): void; stopPropagation(): void }) => {
      event.preventDefault()
      event.stopPropagation()
      const name = this.pipelineRowPhases[event.y - this.pipelineText.y]
      if (name) this.openSessionWindowForPhase(name, "click")
    }

    const pipeline = this.panel({
      id: "archer-pipeline",
      width: pipelineWidth,
      height: "100%",
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      title: " pipeline ",
      titleAlignment: "left",
      onMouseDown: openFromPipeline,
    })
    pipeline.text.onMouseDown = openFromPipeline

    const right = new BoxRenderable(renderer, {
      id: "archer-right",
      height: "100%",
      flexGrow: 1,
      flexDirection: "column",
      gap: 0,
    })

    const openFromStep = (event: { preventDefault(): void; stopPropagation(): void }) => {
      event.preventDefault()
      event.stopPropagation()
      this.openActiveSessionWindow("click")
    }

    const step = this.panel({
      id: "archer-step",
      width: "100%",
      height: 8,
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      title: " current step ",
      titleAlignment: "left",
      onMouseDown: openFromStep,
    })
    step.text.onMouseDown = openFromStep

    // Todos live in their own panel below the step meta; its border is the
    // divider between session usage above and the todo list itself.
    const todos = this.panel({
      id: "archer-todos",
      width: "100%",
      height: 3,
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      title: " todos ",
      titleAlignment: "left",
      visible: false,
      onMouseDown: openFromStep,
    })
    todos.text.onMouseDown = openFromStep

    const feed = this.panel({
      id: "archer-feed",
      width: "100%",
      flexGrow: 1,
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      title: " logs ",
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
      backgroundColor: theme.bg,
      onMouseDown: openFromFooter,
    })
    footer.text.onMouseDown = openFromFooter

    this.dirText = dirLine
    this.headerText = header.text
    this.pipelineText = pipeline.text
    this.stepBox = step.box
    this.stepText = step.text
    this.todosBox = todos.box
    this.todosText = todos.text
    this.feedText = feed.text
    this.footerText = footer.text

    this.paletteTargets.push(
      { box: shell, background: "bg" },
      { box: header.box, background: "bg", border: "border" },
      { box: pipeline.box, background: "bg", border: "borderDim" },
      { box: step.box, background: "bg", border: "borderDim" },
      { box: todos.box, background: "bg", border: "borderDim" },
      { box: feed.box, background: "bg", border: "borderDim" },
      { box: footer.box, background: "bg", border: "borderDim" },
    )

    body.add(pipeline.box)
    right.add(step.box)
    right.add(todos.box)
    right.add(feed.box)
    body.add(right)
    shell.add(dirLine)
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
      backgroundColor: theme.overlay,
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
    this.paletteTargets.push({ box: this.modal, background: "overlay", border: "yellow" })

    renderer.keyInput.on("keypress", this.handleKeyPress)
    renderer.on("theme_mode", this.handleThemeMode)

    this.ticker = setInterval(() => this.render(), 250)
    this.render()
  }

  start(runID: string, targetDir: string) {
    this.runID = runID
    this.targetDir = targetDir
    this.addEvent("archer", "system", `run ${runID} started`)
    this.render()
  }

  serverReady(url: string) {
    this.serverUrl = url
    this.addEvent("archer", "system", `opencode server at ${url}`)
    this.render()
  }

  phaseStarted(name: string, detail = "") {
    this.setPhase(name, "running")
    this.addEvent(name, "system", detail || "phase started")
  }

  phaseRunning(name: string, detail = "") {
    this.setPhase(name, "running")
    if (!detail) return
    const phase = this.findPhase(name)
    if (phase) phase.now = { kind: "info", message: detail }
    this.addEvent(name, "info", detail)
    this.render()
  }

  phaseAttempt(name: string, info: ProgressAttempt) {
    const phase = this.findPhase(name)
    if (!phase) return
    phase.attempt = info.attempt
    phase.maxAttempts = info.maxAttempts
    if (info.model) phase.model = info.model
    phase.updatedAt = Date.now()
    this.activePhase = name
    this.addEvent(name, "step", `attempt ${info.attempt}/${info.maxAttempts}${info.model ? ` · ${info.model}` : ""}`)
    this.render()
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
    this.setPhase(name, "completed")
    this.addEvent(name, "system", detail || "phase completed")
  }

  phaseSkipped(name: string) {
    this.setPhase(name, "skipped")
    this.addEvent(name, "system", "skipped by flag")
  }

  phaseFailed(name: string, detail = "") {
    this.setPhase(name, "failed")
    this.addEvent(name, "error", detail || "failed")
  }

  phaseRestored(name: string, snapshot: ProgressPhaseSnapshot) {
    const phase = this.findPhase(name)
    if (!phase) return
    // Written directly instead of via setPhase: a restored phase must not
    // claim the active slot or reset the quiet timer of the live run.
    phase.status = snapshot.status
    phase.sessionID = snapshot.sessionID ?? ""
    phase.restoredDurationMs = snapshot.durationMs
    if (snapshot.cost !== undefined || snapshot.tokens) {
      const session = this.usageSession(phase, snapshot.sessionID || "restored")
      session.cost = safeCost(snapshot.cost)
      if (snapshot.tokens) session.tokens = cloneTokens(snapshot.tokens)
      session.model = snapshot.model ?? ""
      session.reported = true
      session.totalReported = true
      this.recalculateUsage(phase)
    }
    if (snapshot.model) phase.lastStepModel = snapshot.model
    phase.updatedAt = Date.now()
    const parts = [
      snapshot.durationMs !== undefined ? formatElapsed(snapshot.durationMs) : "",
      snapshot.cost !== undefined ? formatMoney(snapshot.cost) : "",
      snapshot.sessionID ? `session ${shortID(snapshot.sessionID)}` : "",
    ].filter(Boolean)
    this.addEvent(name, "system", `restored from previous run${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`)
    this.render()
  }

  askPermission(info: PermissionPromptInfo): Promise<PermissionReply> {
    if (this.renderer.isDestroyed) return Promise.resolve("reject")
    // The gate checks auto-accept before prompting, but the toggle can flip
    // between that check and this call; never show a prompt in auto mode.
    if (this.autoAccept?.enabled) {
      this.addEvent("archer", "permission", `auto-allowed: ${permissionSummary(info)}`)
      this.render()
      return Promise.resolve("once")
    }
    return new Promise((resolve) => {
      this.permissionQueue.push({ info, resolve })
      if (this.permissionQueue.length === 1) this.permissionChoice = 0
      this.addEvent("archer", "permission", `approval needed: ${permissionSummary(info)}`)
      this.render()
    })
  }

  message(message: string) {
    this.addEvent("archer", "system", message)
    this.render()
  }

  suspend() {
    if (this.renderer.isDestroyed) return
    if (this.suspendDepth++ > 0) return
    log.mute(false)
    this.renderer.suspend()
  }

  resume() {
    if (this.renderer.isDestroyed) return
    if (this.suspendDepth === 0) return
    if (--this.suspendDepth > 0) return
    log.mute(true)
    this.renderer.resume()
    this.render()
  }

  stop() {
    clearInterval(this.ticker)
    log.mute(false)
    this.renderer.keyInput.off("keypress", this.handleKeyPress)
    this.renderer.off("theme_mode", this.handleThemeMode)
    for (const pending of this.permissionQueue.splice(0)) pending.resolve("reject")
    if (this.renderer.isDestroyed) return
    this.renderer.destroy()
  }

  private applyPalette() {
    for (const target of this.paletteTargets) {
      target.box.backgroundColor = theme[target.background]
      if (target.border) target.box.borderColor = theme[target.border]
    }
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

  private toggleAutoAccept() {
    if (!this.autoAccept) return
    this.autoAccept.enabled = !this.autoAccept.enabled
    this.addEvent(
      "archer",
      "permission",
      this.autoAccept.enabled
        ? "auto-accept ON: ask-level permissions will be allowed (denylist still applies)"
        : "auto-accept OFF: permissions prompt again",
    )
    if (this.autoAccept.enabled) {
      for (const pending of this.permissionQueue.splice(0)) {
        this.addEvent("archer", "permission", `auto-allowed: ${permissionSummary(pending.info)}`)
        pending.resolve("once")
      }
      this.permissionChoice = 0
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
    if (!active) {
      this.addEvent("archer", "system", "no active opencode session to open yet")
      this.render()
      return
    }
    this.openSessionWindowForPhase(active.name, source)
  }

  private openSessionWindowForPhase(name: string, source: "click" | "key") {
    const phase = this.findPhase(name)
    if (!phase) return
    if (!this.serverUrl) {
      this.addEvent("archer", "system", "opencode server is not ready yet")
      this.render()
      return
    }
    if (!phase.sessionID) {
      this.addEvent("archer", "system", `no opencode session for ${name} yet`)
      this.render()
      return
    }

    this.addEvent("archer", "system", `${source === "key" ? "[o]" : "click"}: opening ${name} session ${shortID(phase.sessionID)}`)
    openOpencodeSessionWindow({ url: this.serverUrl, targetDir: this.targetDir || process.cwd(), sessionID: phase.sessionID })
      .then((backend) => {
        this.addEvent("archer", "system", `${name} session opened in ${backend}`)
        this.render()
      })
      .catch((error: unknown) => {
        this.addEvent("archer", "error", `couldn't open opencode session: ${error instanceof Error ? error.message : String(error)}`)
        this.render()
      })
    this.render()
  }

  private setPhase(name: string, status: PhaseStatus) {
    const phase = this.findPhase(name)
    if (!phase) return
    if (status === "running" && phase.startedAt === undefined) phase.startedAt = Date.now()
    if (status === "completed" || status === "failed" || status === "skipped") phase.endedAt = Date.now()
    phase.status = status
    phase.updatedAt = Date.now()
    this.activePhase = name
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

    // Body rows left after the dir line (1), header (3), and footer (3); the
    // step and todos panels grow with their content but never starve the logs.
    const bodyHeight = Math.max(8, this.renderer.height - 7)
    const stepLines = this.stepContent(active, now, rightWidth)
    this.stepBox.height = stepLines.length + 2

    const todoRows =
      active && active.todos.length > 0
        ? todoLines(active.todos, Math.max(3, Math.floor(bodyHeight * 0.6) - stepLines.length - 4), rightWidth)
        : []
    this.todosBox.visible = todoRows.length > 0
    if (active && todoRows.length > 0) {
      const completed = active.todos.filter((todo) => todo.status === "completed").length
      this.todosBox.height = todoRows.length + 2
      this.todosBox.title = ` todos ${completed}/${active.todos.length} `
      this.todosText.content = joinLines(todoRows)
    }
    const todosHeight = this.todosBox.visible ? todoRows.length + 2 : 0

    this.dirText.content = this.dirContent(innerWidth)
    this.headerText.content = this.headerContent(now, innerWidth)
    this.pipelineText.content = this.pipelineContent(now)
    this.stepText.content = joinLines(stepLines)
    this.feedText.content = joinLines(this.feedLines(rightWidth, Math.max(3, bodyHeight - stepLines.length - todosHeight - 4)))
    this.footerText.content = this.footerContent(now, innerWidth)
    this.renderPermissionModal()
    this.renderer.requestRender()
  }

  // Header owns the session-wide totals in a single row: clock, elapsed time,
  // cost, and tokens. Phase status lives in the pipeline panel.
  private headerContent(now: number, width: number) {
    const usage = totalUsage(this.phases)
    const totals: TextChunk[] = [
      fg(theme.dim)(formatTime(now)),
      fg(theme.faint)("  ·  "),
      fg(theme.text)(formatElapsed(now - this.startedAt)),
      fg(theme.faint)("  ·  "),
      fg(theme.green)(formatMoney(usage.cost)),
      fg(theme.faint)("  ·  "),
      fg(theme.dim)(`↑${formatCount(usage.tokens.input)} ↓${formatCount(usage.tokens.output)} tokens`),
    ]
    return padBetween([bold(fg(theme.accent)("◆ archer"))], totals, width)
  }

  // The working directory renders above the header box, outside its border.
  private dirContent(width: number) {
    return t`${fg(theme.dim)("dir ")}${fg(theme.text)(shortPath(this.targetDir, width - 4))}`
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

  // The pipeline owns run progress: the overall bar plus one row per phase
  // (status, elapsed, and final cost once a phase ends).
  private pipelineContent(now: number) {
    const width = pipelineWidth - 4
    const done = this.phases.filter((phase) => phase.status === "completed" || phase.status === "skipped").length
    const failed = this.phases.some((phase) => phase.status === "failed")
    const finished = this.phases.length > 0 && done === this.phases.length
    const barColor = failed ? theme.red : finished ? theme.green : theme.accent
    const counter = ` ${done}/${this.phases.length}`

    const out: StyledText[] = [
      new StyledText([
        ...progressBar(this.overallFraction(), Math.max(6, width - counter.length), barColor),
        fg(theme.text)(counter),
      ]),
      plain(""),
    ]
    const rows: (string | undefined)[] = [undefined, undefined]
    for (const phase of this.phases) {
      const name =
        phase.status === "pending"
          ? fg(theme.dim)(phase.name)
          : phase.status === "skipped"
            ? fg(theme.faint)(phase.name)
            : phase.status === "running"
              ? bold(fg(theme.text)(phase.name))
              : fg(theme.text)(phase.name)
      const left: TextChunk[] = [statusIcon(phase.status, now), raw(" "), name]
      rows.push(phase.name)
      out.push(padBetween(left, phaseMetaChunks(phase, now), width))
    }
    this.pipelineRowPhases = rows
    return joinLines(out)
  }

  // The current-step panel owns everything about the phase in flight: live
  // activity, model, attempt, session usage, and diff. Todos render in their
  // own panel below this one.
  private stepContent(active: PhaseState | undefined, now: number, width: number): StyledText[] {
    if (!active) return [t`${fg(theme.dim)("waiting for the first phase to start…")}`]

    const out: StyledText[] = []
    const head: TextChunk[] =
      active.status === "running"
        ? [fg(theme.accent)(`${spinnerFrame(now)} `), bold(fg(theme.text)(active.name))]
        : [statusIcon(active.status, now), raw(" "), bold(fg(theme.text)(active.name))]
    // Live activity sits to the right of the name; truncation reserves room
    // for the name, the separators, and a possible quiet indicator.
    if (active.now.message) {
      const style = kindStyle(active.now.kind)
      head.push(
        fg(theme.faint)("  ·  "),
        fg(style.color)(`${style.icon} `),
        fg(theme.text)(truncate(active.now.message, Math.max(10, width - active.name.length - 28))),
      )
    } else {
      head.push(fg(theme.faint)("  ·  "), fg(theme.dim)("waiting for opencode events…"))
    }
    const quiet = now - active.updatedAt
    if (quiet > 10_000 && active.status === "running") {
      head.push(fg(quiet > 60_000 ? theme.yellow : theme.faint)(`  ·  quiet ${Math.floor(quiet / 1000)}s`))
    }
    out.push(new StyledText(head))

    const meta: TextChunk[] = []
    const model = active.lastStepModel || active.model
    if (model) meta.push(fg(theme.faint)("model "), fg(theme.dim)(truncate(model, 30)))
    if (active.attempt > 0) {
      if (meta.length > 0) meta.push(fg(theme.faint)(" · "))
      meta.push(fg(theme.faint)("attempt "), fg(active.attempt > 1 ? theme.yellow : theme.dim)(`${active.attempt}/${active.maxAttempts}`))
    }
    if (active.sessionID) {
      if (meta.length > 0) meta.push(fg(theme.faint)(" · "))
      meta.push(fg(theme.faint)(shortID(active.sessionID)))
    }
    if (meta.length > 0) out.push(new StyledText(meta))

    out.push(
      new StyledText([
        fg(theme.faint)("cost "),
        fg(theme.dim)(active.usageReported ? formatMoney(active.cost) : "—"),
        fg(theme.faint)(" · tokens "),
        fg(theme.dim)(active.usageReported ? `↑${formatCount(active.tokens.input)} ↓${formatCount(active.tokens.output)}` : "—"),
        fg(theme.faint)(" · steps "),
        fg(theme.dim)(String(active.stepCount)),
      ]),
    )

    if (active.diff && active.diff.files > 0) {
      out.push(
        t`${fg(theme.dim)("changes ")}${fg(theme.text)(`${active.diff.files} files`)} ${fg(theme.green)(`+${active.diff.additions}`)} ${fg(theme.red)(`−${active.diff.deletions}`)}`,
      )
    }
    return out
  }

  private feedLines(width: number, visible: number): StyledText[] {
    const events = this.feed.slice(-visible).reverse()
    if (events.length === 0) return [t`${fg(theme.dim)("no activity yet…")}`]

    return events.map((entry, index) => {
      const style = kindStyle(entry.kind)
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
    })
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
        fg(theme.dim)(" rejects · "),
        fg(theme.accent)("shift+tab"),
        fg(theme.dim)(" auto-accept"),
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
    if (this.autoAccept) {
      left.push(fg(theme.dim)(" · "), fg(theme.accent)("shift+tab"))
      left.push(this.autoAccept.enabled ? bold(fg(theme.yellow)(" auto-accept ON")) : fg(theme.dim)(" auto-accept off"))
    }
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
      buttons.push(index === this.permissionChoice ? bold(bg(theme[choice.color])(fg(theme.chipText)(label))) : fg(theme.dim)(label))
    })
    lines.push(new StyledText(buttons))

    this.modal.width = boxWidth
    this.modal.height = lines.length + 4
    this.modalText.content = joinLines(lines)
  }
}

function phaseMetaChunks(phase: PhaseState, now: number): TextChunk[] {
  if (phase.status === "pending") return []
  if (phase.status === "skipped" && phase.restoredDurationMs === undefined) return [fg(theme.faint)("skipped")]
  const parts: TextChunk[] = []
  const elapsed = phase.restoredDurationMs ?? (phase.startedAt !== undefined ? (phase.endedAt ?? now) - phase.startedAt : undefined)
  if (elapsed !== undefined) {
    parts.push(fg(phase.status === "failed" ? theme.red : theme.dim)(formatElapsed(elapsed)))
  }
  // Live cost belongs to the current-step panel; a phase's final cost lands here once it ends.
  if (phase.usageReported && phase.status !== "running") parts.push(fg(theme.faint)(` ${formatMoney(phase.cost)}`))
  return parts
}

// One row per todo, windowed around the first unfinished item when the list
// outgrows the panel; the edges collapse into "↑ n completed" / "↓ n more".
function todoLines(todos: ProgressTodo[], cap: number, width: number): StyledText[] {
  if (todos.length <= cap) return todos.map((todo) => todoRow(todo, width))
  const firstOpen = todos.findIndex((todo) => todo.status !== "completed")
  const anchor = firstOpen === -1 ? todos.length : firstOpen
  const start = Math.min(anchor, todos.length - (cap - 1))
  const head = start > 0 ? 1 : 0
  let end = start + cap - head
  if (end < todos.length) end -= 1
  const out: StyledText[] = []
  if (head > 0) out.push(t`  ${fg(theme.faint)(`↑ ${start} completed`)}`)
  for (const todo of todos.slice(start, end)) out.push(todoRow(todo, width))
  if (end < todos.length) out.push(t`  ${fg(theme.faint)(`↓ ${todos.length - end} more`)}`)
  return out
}

function todoRow(todo: ProgressTodo, width: number): StyledText {
  const text = truncate(todo.content, Math.max(10, width - 4))
  switch (todo.status) {
    case "completed":
      return new StyledText([fg(theme.green)("  ✓ "), fg(theme.dim)(text)])
    case "in_progress":
      return new StyledText([fg(theme.accent)("  ● "), bold(fg(theme.text)(text))])
    case "cancelled":
      return new StyledText([fg(theme.faint)("  ⊘ "), fg(theme.faint)(text)])
    default:
      return new StyledText([fg(theme.dim)("  ○ "), fg(theme.text)(text)])
  }
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
