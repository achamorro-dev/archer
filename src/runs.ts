import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { stdin, stdout } from "node:process"
import { createInterface } from "node:readline/promises"

import { readRunMetadata, type RunMetadata } from "./metadata"
import { isValidRunID, runsRoot } from "./workspace"

export type RunEntry = {
  runID: string
  dir: string
  title: string
  targetDir?: string
  status: string
  cost?: number
}

export type RunsResolution = { type: "exit" } | { type: "resume"; runID: string; targetDir?: string }

export async function listRuns(root = runsRoot()): Promise<RunEntry[]> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return []
  }
  // Run IDs start with the wall-clock timestamp, so lexicographic order is chronological.
  const ids = names.filter(isValidRunID).sort().reverse()
  return Promise.all(ids.map((runID) => loadRunEntry(root, runID)))
}

/** Interactive run-history browser: pick a run, then resume it, read its reports, or open a subshell in its dir. */
export async function browseRuns(initialRunID?: string): Promise<RunsResolution> {
  const runs = await listRuns()
  if (runs.length === 0) {
    stdout.write(`no runs found in ${runsRoot()}\n`)
    return { type: "exit" }
  }

  let selected: RunEntry | undefined
  if (initialRunID) {
    selected = runs.find((run) => run.runID === initialRunID)
    if (!selected) throw new Error(`run ${initialRunID} doesn't exist in ${runsRoot()}`)
  }

  if (!stdin.isTTY || !stdout.isTTY) {
    printRunList(runs)
    return { type: "exit" }
  }

  for (;;) {
    if (!selected) {
      printRunList(runs)
      const answer = await ask(`run [1-${runs.length}] or [q]uit > `)
      if (answer === "q" || answer === "quit" || answer === "") return { type: "exit" }
      const index = Number.parseInt(answer, 10)
      if (!Number.isInteger(index) || index < 1 || index > runs.length) {
        stdout.write("pick a number from the list\n")
        continue
      }
      selected = runs[index - 1]!
    }

    printRunDetails(selected)
    const action = await ask("[r]esume, [s]ummary, [d]ir subshell, [b]ack, [q]uit > ")
    switch (action) {
      case "r":
      case "resume":
        return { type: "resume", runID: selected.runID, targetDir: selected.targetDir }
      case "s":
      case "summary":
        await printRunSummary(selected)
        break
      case "d":
      case "dir":
        await openSubshell(selected)
        break
      case "b":
      case "back":
        selected = undefined
        break
      case "q":
      case "quit":
        return { type: "exit" }
      default:
        stdout.write("choose r, s, d, b, or q\n")
    }
  }
}

async function loadRunEntry(root: string, runID: string): Promise<RunEntry> {
  const dir = join(root, runID)
  const metadata = await readRunMetadata(join(dir, "metadata.json"))
  return {
    runID,
    dir,
    title: await runTitle(dir),
    targetDir: metadata?.targetDir,
    status: statusSummary(metadata),
    cost: totalCost(metadata),
  }
}

async function runTitle(dir: string) {
  const prd = await readIfExists(join(dir, "prd.md"))
  if (prd === undefined) return "(no prd)"
  const line = prd
    .split("\n")
    .map((raw) => raw.replace(/^#+\s*/, "").trim())
    .find(Boolean)
  return truncate(line ?? "(empty prd)", 60)
}

// Only phases that started get an entry, so the totals describe what the run
// recorded, not the full pipeline. Pre-metadata runs show "-".
function statusSummary(metadata: RunMetadata | undefined) {
  if (!metadata) return "-"
  const statuses = Object.values(metadata.phases).map((phase) => phase.status)
  if (statuses.length === 0) return "empty"
  const done = statuses.filter((status) => status === "completed" || status === "skipped").length
  if (statuses.some((status) => status === "failed")) return `failed (${done}/${statuses.length} ok)`
  if (done === statuses.length) return "completed"
  return `incomplete (${done}/${statuses.length})`
}

function totalCost(metadata: RunMetadata | undefined) {
  if (!metadata) return undefined
  let cost = 0
  let seen = false
  for (const phase of Object.values(metadata.phases)) {
    if (typeof phase.cost !== "number") continue
    cost += phase.cost
    seen = true
  }
  return seen ? cost : undefined
}

function printRunList(runs: RunEntry[]) {
  const numberWidth = String(runs.length).length
  const statusWidth = Math.max(...runs.map((run) => run.status.length))
  stdout.write(`\nruns in ${runsRoot()}:\n`)
  for (const [index, run] of runs.entries()) {
    const number = String(index + 1).padStart(numberWidth)
    const cost = (run.cost !== undefined ? `$${run.cost.toFixed(2)}` : "").padStart(8)
    stdout.write(`  ${number}. ${run.runID}  ${run.status.padEnd(statusWidth)}  ${cost}  ${run.title}\n`)
  }
}

function printRunDetails(run: RunEntry) {
  stdout.write(`\n${run.runID} - ${run.title}\n`)
  stdout.write(`  dir:    ${run.dir}\n`)
  if (run.targetDir) stdout.write(`  target: ${run.targetDir}\n`)
  stdout.write(`  status: ${run.status}${run.cost !== undefined ? `, $${run.cost.toFixed(2)}` : ""}\n`)
}

async function printRunSummary(run: RunEntry) {
  const summary = await readIfExists(join(run.dir, "SUMMARY.md"))
  if (summary !== undefined) {
    stdout.write(`\n${summary}\n`)
    return
  }

  // Failed runs usually die before SUMMARY.md exists; show whatever reports landed.
  let reports: string[] = []
  try {
    reports = (await readdir(join(run.dir, "reports"))).filter((name) => name.endsWith(".md")).sort()
  } catch {
    // no reports dir
  }
  if (reports.length === 0) {
    stdout.write("no summary or reports for this run\n")
    return
  }
  for (const name of reports) {
    const body = await readIfExists(join(run.dir, "reports", name))
    if (body !== undefined) stdout.write(`\n--- reports/${name} ---\n${body}\n`)
  }
}

// A child process can't change the parent shell's cwd, so "go to the run dir"
// means dropping the user into their own shell already positioned there.
async function openSubshell(run: RunEntry) {
  const shell = process.env.SHELL || "/bin/sh"
  stdout.write(`opening ${shell} in ${run.dir}; type "exit" to return to archer\n`)
  const proc = Bun.spawn([shell], {
    cwd: run.dir,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  })
  await proc.exited
}

async function ask(question: string) {
  const rl = createInterface({ input: stdin, output: stdout })
  const controller = new AbortController()
  // Raw-mode input never raises a process SIGINT; readline surfaces Ctrl+C
  // here instead, so without this listener the prompt would just hang.
  rl.on("SIGINT", () => controller.abort())
  try {
    return (await rl.question(question, { signal: controller.signal })).trim().toLowerCase()
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      stdout.write("\n")
      return "q"
    }
    throw error
  } finally {
    rl.close()
  }
}

async function readIfExists(path: string) {
  try {
    return await readFile(path, "utf8")
  } catch {
    return undefined
  }
}

function truncate(value: string, max: number) {
  const singleLine = value.replace(/\s+/g, " ").trim()
  if (singleLine.length <= max) return singleLine
  return `${singleLine.slice(0, Math.max(0, max - 3))}...`
}
