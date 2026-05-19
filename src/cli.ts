import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { run } from "./runner"
import type { RunOptions } from "./types"

type ParsedArgs = Omit<RunOptions, "prompt"> & {
  prompt?: string
  promptFile?: string
  help?: boolean
}

export type CliCommand = { type: "help"; text: string } | { type: "run"; options: RunOptions }

export async function parseAndRun(argv: string[]) {
  const command = await parseCommand(argv)
  if (command.type === "help") {
    process.stdout.write(command.text)
    return
  }

  await run(command.options)
}

export async function parseCommand(argv: string[]): Promise<CliCommand> {
  const parsed = parseArgs(argv)
  if (parsed.help) return { type: "help", text: help() }

  let prompt = parsed.prompt ?? ""
  if (parsed.promptFile) {
    prompt = await readFile(resolve(process.cwd(), parsed.promptFile), "utf8")
  }

  if (!prompt && !parsed.resumeRunID) {
    throw new Error("hace falta un prompt (posicional o --prompt-file) o --resume <id>")
  }

  const { help: _help, prompt: _parsedPrompt, promptFile: _promptFile, ...options } = parsed
  return { type: "run", options: { ...options, prompt } }
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    files: [],
    onlyPhases: [],
    skipPhases: [],
    resumeRunID: "",
    keepRunDir: false,
    modelOverride: "",
    maxAttempts: 2,
    baseRef: "main",
    targetDir: process.cwd(),
    includeDirty: false,
  }
  const positional: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!
    if (raw === "--") {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (!raw.startsWith("-")) {
      positional.push(raw)
      continue
    }

    const { flag, value } = splitFlag(raw)
    const takeValue = () => {
      if (value !== undefined) return value
      const next = argv[++i]
      if (!next) throw new Error(`${flag} requiere un valor`)
      return next
    }

    switch (flag) {
      case "--help":
      case "-h":
        parsed.help = true
        return parsed
      case "--prompt-file":
      case "--prd":
        parsed.promptFile = takeValue()
        break
      case "--file":
      case "-f":
        parsed.files.push(takeValue())
        break
      case "--only":
        parsed.onlyPhases.push(...listValue(takeValue()))
        break
      case "--skip":
        parsed.skipPhases.push(...listValue(takeValue()))
        break
      case "--resume":
        parsed.resumeRunID = takeValue()
        break
      case "--keep-run-dir":
        parsed.keepRunDir = true
        break
      case "--include-dirty":
        parsed.includeDirty = true
        break
      case "--model":
        parsed.modelOverride = takeValue()
        break
      case "--max-attempts":
        parsed.maxAttempts = parseInt(takeValue(), 10)
        if (!Number.isInteger(parsed.maxAttempts) || parsed.maxAttempts < 1) {
          throw new Error("--max-attempts debe ser un entero positivo")
        }
        break
      case "--base":
        parsed.baseRef = takeValue()
        break
      case "--dir":
        parsed.targetDir = resolve(process.cwd(), takeValue())
        break
      default:
        throw new Error(`flag desconocido: ${flag}`)
    }
  }

  if (positional.length > 0) parsed.prompt = positional.join(" ")
  return parsed
}

function splitFlag(raw: string) {
  const index = raw.indexOf("=")
  if (index === -1) return { flag: raw, value: undefined }
  return { flag: raw.slice(0, index), value: raw.slice(index + 1) }
}

function listValue(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function help() {
  return `archer [prompt]

Pipeline secuencial de agentes OpenCode para implementar features.

Uso:
  archer "Añade onboarding"
  archer --prompt-file prd.md --file lib/onboarding --file test/onboarding_test.dart

Flags:
  --prompt-file <path>     Lee el PRD/prompt desde un archivo
  --file, -f <path>        Adjunta un archivo o directorio a todas las fases (repetible)
  --only <fases>           Ejecuta solo estas fases (implementer,patterns,security,design,tests)
  --skip <fases>           Salta estas fases
  --resume <id>            Retoma un run previo por su ID
  --keep-run-dir           No borra el run dir al terminar
  --include-dirty          Incluye cambios existentes en el primer commit (requiere --max-attempts 1)
  --model <provider/model> Fuerza un modelo para todas las fases
  --max-attempts <n>       Intentos por fase antes de fallar (default: 2)
  --base <ref>             Rama/base para calcular diffs (default: main)
  --dir <path>             Repo target (default: cwd)
`
}
