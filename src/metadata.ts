import { readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { log } from "./log"

import type {
  ProgressPhaseSnapshot,
  ProgressStepUsage,
  ProgressTokens,
  ProgressUI,
  ProgressUsage,
} from "./progress"
import type { Workspace } from "./workspace"

export type PhaseMetadataStatus = "pending" | "running" | "completed" | "skipped" | "failed"

export type PhaseMetadata = {
  status: PhaseMetadataStatus
  sessionID?: string
  startedAt?: number
  endedAt?: number
  durationMs?: number
  cost?: number
  tokens?: ProgressTokens
  model?: string
}

export type RunMetadata = {
  schemaVersion: 1
  runID: string
  targetDir: string
  createdAt: number
  updatedAt: number
  phases: Record<string, PhaseMetadata>
}

export type RunMetadataStore = {
  snapshot(name: string): ProgressPhaseSnapshot | undefined
  phaseStarted(name: string): void
  phaseSession(name: string, sessionID: string): void
  phaseStepUsage(name: string, usage: ProgressStepUsage): void
  phaseUsageTotal(name: string, usage: ProgressUsage): void
  phaseEnded(name: string, status: "completed" | "skipped" | "failed"): void
  flush(): Promise<void>
}

const saveDebounceMs = 2_000

export async function openRunMetadata(workspace: Workspace, targetDir: string): Promise<RunMetadataStore> {
  const path = join(workspace.dir, "metadata.json")
  const data = (await loadMetadata(path, workspace.runID)) ?? newMetadata(workspace.runID, targetDir)
  // Usage events carry cumulative totals per opencode session; keeping the
  // accumulators out of the persisted shape avoids ever re-counting on resume.
  const usage = new Map<string, Map<string, UsageAccumulator>>()
  const seenStepIDs = new Set<string>()

  let timer: ReturnType<typeof setTimeout> | undefined
  // Single chain so a slow write can never interleave with the next one.
  let writing: Promise<void> = Promise.resolve()

  const persist = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    data.updatedAt = Date.now()
    const body = JSON.stringify(data, null, 2)
    writing = writing.then(async () => {
      try {
        // tmp + rename: a kill mid-write must never corrupt the resume data.
        await writeFile(`${path}.tmp`, body)
        await rename(`${path}.tmp`, path)
      } catch (error) {
        log.warn(`couldn't write run metadata: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    return writing
  }

  const scheduleSave = () => {
    if (timer) return
    timer = setTimeout(() => void persist(), saveDebounceMs)
    timer.unref?.()
  }

  const phase = (name: string) => (data.phases[name] ??= { status: "pending" })

  const recalculate = (name: string) => {
    const sessions = usage.get(name)
    if (!sessions || sessions.size === 0) return
    const entry = phase(name)
    let cost = 0
    let tokens = emptyTokens()
    let model = ""
    for (const session of sessions.values()) {
      cost += session.cost
      tokens = addTokens(tokens, session.tokens)
      model = session.model || model
    }
    entry.cost = cost
    entry.tokens = tokens
    if (model) entry.model = model
  }

  void persist()

  return {
    snapshot(name) {
      const entry = data.phases[name]
      if (!entry) return undefined
      return {
        // Callers only restore phases whose report exists, so a stale
        // "running" left by a crash still means the phase finished its work.
        status: entry.status === "skipped" || entry.status === "failed" ? entry.status : "completed",
        sessionID: entry.sessionID,
        durationMs: entry.durationMs,
        cost: entry.cost,
        tokens: entry.tokens,
        model: entry.model,
      }
    },
    phaseStarted(name) {
      const entry = phase(name)
      entry.status = "running"
      entry.startedAt ??= Date.now()
      void persist()
    },
    phaseSession(name, sessionID) {
      phase(name).sessionID = sessionID
      void persist()
    },
    phaseStepUsage(name, usage_) {
      if (usage_.stepID) {
        if (seenStepIDs.has(usage_.stepID)) return
        seenStepIDs.add(usage_.stepID)
      }
      const session = usageSession(usage, name, usage_.sessionID)
      if (!session.totalReported) {
        session.cost += safeCost(usage_.cost)
        if (usage_.tokens) session.tokens = addTokens(session.tokens, usage_.tokens)
      }
      session.model = usage_.model || session.model
      recalculate(name)
      scheduleSave()
    },
    phaseUsageTotal(name, usage_) {
      const session = usageSession(usage, name, usage_.sessionID)
      if (typeof usage_.cost === "number") session.cost = safeCost(usage_.cost)
      if (usage_.tokens) session.tokens = { ...usage_.tokens }
      session.model = usage_.model || session.model
      session.totalReported = true
      recalculate(name)
      scheduleSave()
    },
    phaseEnded(name, status) {
      const entry = phase(name)
      entry.status = status
      entry.endedAt = Date.now()
      if (entry.startedAt !== undefined) entry.durationMs = entry.endedAt - entry.startedAt
      void persist()
    },
    async flush() {
      await persist()
    },
  }
}

/** Forwards every ProgressUI call unchanged while recording phase lifecycle and usage into the store. */
export function recordProgress(progress: ProgressUI, store: RunMetadataStore): ProgressUI {
  const recorder: ProgressUI = {
    start: (runID, targetDir) => progress.start(runID, targetDir),
    serverReady: (url) => progress.serverReady(url),
    phaseStarted(name, detail) {
      store.phaseStarted(name)
      progress.phaseStarted(name, detail)
    },
    phaseRunning: (name, detail) => progress.phaseRunning(name, detail),
    phaseSession(name, sessionID) {
      store.phaseSession(name, sessionID)
      progress.phaseSession(name, sessionID)
    },
    phaseActivity: (name, detail, kind, pulse) => progress.phaseActivity(name, detail, kind, pulse),
    phaseStepUsage(name, usage) {
      store.phaseStepUsage(name, usage)
      progress.phaseStepUsage(name, usage)
    },
    phaseUsageTotal(name, usage) {
      store.phaseUsageTotal(name, usage)
      progress.phaseUsageTotal(name, usage)
    },
    phaseTodos: (name, todos) => progress.phaseTodos(name, todos),
    phaseDiff: (name, summary) => progress.phaseDiff(name, summary),
    phaseCompleted(name, detail) {
      store.phaseEnded(name, "completed")
      progress.phaseCompleted(name, detail)
    },
    phaseSkipped(name) {
      store.phaseEnded(name, "skipped")
      progress.phaseSkipped(name)
    },
    phaseFailed(name, detail) {
      store.phaseEnded(name, "failed")
      progress.phaseFailed(name, detail)
    },
    phaseRestored: (name, snapshot) => progress.phaseRestored(name, snapshot),
    message: (message) => progress.message(message),
    suspend: () => progress.suspend(),
    resume: () => progress.resume(),
    stop: () => progress.stop(),
  }
  // The gate decides between in-place prompts and the readline fallback by
  // probing for askPermission, so its presence must mirror the wrapped UI.
  if (progress.askPermission) recorder.askPermission = progress.askPermission.bind(progress)
  return recorder
}

type UsageAccumulator = {
  cost: number
  tokens: ProgressTokens
  model: string
  totalReported: boolean
}

function usageSession(usage: Map<string, Map<string, UsageAccumulator>>, name: string, sessionID?: string) {
  let sessions = usage.get(name)
  if (!sessions) {
    sessions = new Map()
    usage.set(name, sessions)
  }
  const key = sessionID || "phase"
  let session = sessions.get(key)
  if (!session) {
    session = { cost: 0, tokens: emptyTokens(), model: "", totalReported: false }
    sessions.set(key, session)
  }
  return session
}

async function loadMetadata(path: string, runID: string): Promise<RunMetadata | undefined> {
  const parsed = await readRunMetadata(path)
  return parsed ? { ...parsed, runID } : undefined
}

/** Reads a run's metadata.json without taking ownership of it (also used by the run-history browser). */
export async function readRunMetadata(path: string): Promise<RunMetadata | undefined> {
  let body: string
  try {
    body = await readFile(path, "utf8")
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(body) as Partial<RunMetadata>
    if (parsed.schemaVersion !== 1 || typeof parsed.phases !== "object" || !parsed.phases) {
      log.warn(`ignoring run metadata with unknown shape at ${path}`)
      return undefined
    }
    return { ...parsed, schemaVersion: 1, phases: parsed.phases } as RunMetadata
  } catch {
    log.warn(`ignoring corrupt run metadata at ${path}`)
    return undefined
  }
}

function newMetadata(runID: string, targetDir: string): RunMetadata {
  const now = Date.now()
  return { schemaVersion: 1, runID, targetDir, createdAt: now, updatedAt: now, phases: {} }
}

function emptyTokens(): ProgressTokens {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
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

function safeCost(cost: number | undefined) {
  return typeof cost === "number" && Number.isFinite(cost) ? cost : 0
}
