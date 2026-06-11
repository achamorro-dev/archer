import { stdin, stdout } from "node:process"
import { createInterface } from "node:readline/promises"

import type { OpencodeClient } from "@opencode-ai/sdk/v2"

import { log } from "./log"
import { noopProgress, type AutoAccept, type PermissionPromptInfo, type PermissionReply, type ProgressUI } from "./progress"

type PermissionRequest = {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  always: string[]
  tool?: { messageID: string; callID: string }
}

type Reply = PermissionReply

export type PermissionGate = {
  stop(): Promise<void>
  /** While paused, permission requests are left for whoever owns the terminal (e.g. an interactive OpenCode TUI). */
  pause(): void
  resume(): void
}

export type StartGateOptions = {
  client: OpencodeClient
  progress?: ProgressUI
  interactive: boolean
  directory: string
  /** When enabled, ask-level requests are auto-allowed ("once") instead of prompting. */
  autoAccept?: AutoAccept
}

export function startPermissionGate(options: StartGateOptions): PermissionGate {
  const progress = options.progress ?? noopProgress
  const controller = new AbortController()
  const handled = new Set<string>()
  const queue = serialQueue()
  let paused = false
  let listenerDone: Promise<void> = Promise.resolve()

  const loop = async () => {
    // permission.asked is delivered on the directory-scoped event bus, so the
    // subscription must be pinned to the directory the sessions run in.
    while (!controller.signal.aborted) {
      try {
        const stream = await options.client.event.subscribe({ directory: options.directory }, { signal: controller.signal })
        for await (const event of stream.stream) {
          if (controller.signal.aborted) return
          const payload = event && typeof event === "object" && "payload" in event ? (event as { payload?: unknown }).payload : event
          if (!isPermissionAsked(payload)) continue
          if (paused) continue
          const request = payload.properties
          if (handled.has(request.id)) continue
          handled.add(request.id)
          queue(() => handleRequest(options.client, request, options.interactive, progress, options.directory, options.autoAccept))
        }
      } catch (error) {
        if (controller.signal.aborted) return
        log.warn(`permission gate stream dropped; reconnecting: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (controller.signal.aborted) return
      await sleep(1_000)
    }
  }

  listenerDone = loop()

  return {
    async stop() {
      controller.abort(new Error("permission gate stopped"))
      try {
        // Aborting ends the subscription promptly; the race is a safety net.
        await Promise.race([listenerDone, sleep(2_000)])
      } catch {
        // ignore
      }
    },
    pause() {
      paused = true
    },
    resume() {
      paused = false
    },
  }
}

function isPermissionAsked(payload: unknown): payload is { type: "permission.asked"; properties: PermissionRequest } {
  if (!payload || typeof payload !== "object") return false
  const type = (payload as { type?: unknown }).type
  if (type !== "permission.asked") return false
  const properties = (payload as { properties?: unknown }).properties
  return Boolean(properties && typeof properties === "object" && "id" in properties)
}

async function handleRequest(
  client: OpencodeClient,
  request: PermissionRequest,
  interactive: boolean,
  progress: ProgressUI,
  directory: string,
  autoAccept?: AutoAccept,
) {
  const summary = describeRequest(request)
  // Read at handling time, not subscription time: the TUI flips this live.
  // Opencode's denylist already rejected anything hard-denied, so whatever
  // reaches here is exactly the "ask" bucket auto-accept is meant to cover.
  if (autoAccept?.enabled) {
    log.info(`[permission] auto-allowed (auto-accept on): ${summary}`)
    progress.message(`auto-allowed: ${summary}`)
    await reply(client, request.id, directory, "once")
    return
  }
  if (!interactive) {
    log.warn(`[permission] auto-rejecting ${request.permission} (no TTY): ${summary}`)
    await reply(client, request.id, directory, "reject", "Archer rejected: non-interactive run")
    return
  }

  // The TUI resolves the prompt in-place; suspending to readline is only the
  // plain-logs fallback so the run never drops to a bare black screen.
  const ask = progress.askPermission?.bind(progress)
  if (ask) {
    const answer = await ask(promptInfo(request))
    log.info(`[permission] replied ${answer} for ${request.permission}`)
    await reply(client, request.id, directory, answer, answer === "reject" ? "rejected by user" : undefined)
    return
  }

  progress.suspend()
  try {
    log.section("permission request")
    stdout.write(formatRequest(request))
    const answer = await askReply()
    log.info(`[permission] replied ${answer} for ${request.permission}`)
    await reply(client, request.id, directory, answer, answer === "reject" ? "rejected by user" : undefined)
  } finally {
    progress.resume()
  }
}

function promptInfo(request: PermissionRequest): PermissionPromptInfo {
  return {
    id: request.id,
    permission: request.permission,
    patterns: request.patterns.slice(0, 5),
    command: pickString(request.metadata, ["command", "cmd"]) || undefined,
    target: pickString(request.metadata, ["path", "file", "url"]) || undefined,
    description: pickString(request.metadata, ["description"]) || undefined,
    sessionID: request.sessionID,
  }
}

async function reply(client: OpencodeClient, requestID: string, directory: string, choice: Reply, message?: string) {
  // The reply must carry the same directory scope as the session that asked,
  // or a server hosting multiple instances routes it to the wrong one.
  const result = await client.permission.reply({ requestID, directory, reply: choice, ...(message ? { message } : {}) })
  if (result.error) log.warn(`[permission] reply error for ${requestID}: ${String((result.error as { message?: unknown }).message ?? result.error)}`)
}

function describeRequest(request: PermissionRequest) {
  const command = pickString(request.metadata, ["command", "cmd", "path", "url", "file"])
  if (command) return `${request.permission}: ${truncate(command, 200)}`
  if (request.patterns.length > 0) return `${request.permission}: ${request.patterns.slice(0, 3).join(", ")}`
  return request.permission
}

function formatRequest(request: PermissionRequest) {
  const lines: string[] = [""]
  lines.push(`category: ${request.permission}`)
  if (request.tool) lines.push(`tool call: ${request.tool.callID}`)
  lines.push(`session: ${request.sessionID}`)
  if (request.patterns.length > 0) lines.push(`patterns: ${request.patterns.slice(0, 5).join(", ")}`)
  const command = pickString(request.metadata, ["command", "cmd"])
  if (command) lines.push(`command: ${truncate(command, 400)}`)
  const path = pickString(request.metadata, ["path", "file", "url"])
  if (path) lines.push(`target: ${truncate(path, 400)}`)
  const description = pickString(request.metadata, ["description"])
  if (description) lines.push(`note: ${truncate(description, 240)}`)
  lines.push("")
  return `${lines.join("\n")}\n`
}

function pickString(metadata: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = metadata[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return ""
}

function truncate(value: string, max: number) {
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}…`
}

async function askReply(): Promise<Reply> {
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    for (;;) {
      const raw = (await rl.question("approve? [o]nce, [a]lways, [r]eject > ")).trim().toLowerCase()
      if (raw === "o" || raw === "once" || raw === "y" || raw === "yes") return "once"
      if (raw === "a" || raw === "always") return "always"
      if (raw === "r" || raw === "reject" || raw === "n" || raw === "no") return "reject"
      stdout.write("Choose o, a, or r.\n")
    }
  } finally {
    rl.close()
  }
}

function serialQueue() {
  let tail: Promise<unknown> = Promise.resolve()
  return (job: () => Promise<unknown>) => {
    tail = tail.then(job, job)
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}
