import { describe, expect, test } from "bun:test"

import { parseArgs, parseCommand } from "../src/cli"

describe("cli parsing", () => {
  test("parses pipeline flags without side effects", () => {
    const parsed = parseArgs([
      "--only",
      "implementer,tests",
      "--skip=design",
      "--file",
      "lib/onboarding",
      "--include-dirty",
      "add",
      "onboarding",
    ])

    expect(parsed.onlyPhases).toEqual(["implementer", "tests"])
    expect(parsed.skipPhases).toEqual(["design"])
    expect(parsed.files).toEqual(["lib/onboarding"])
    expect(parsed.includeDirty).toBe(true)
    expect(parsed.prompt).toBe("add onboarding")
  })

  test("returns help as a command", async () => {
    const command = await parseCommand(["--help"])

    expect(command.type).toBe("help")
    if (command.type === "help") expect(command.text).toContain("archer [prompt]")
  })

  test("requires prompt unless resuming", async () => {
    await expect(parseCommand([])).rejects.toThrow("need a prompt")

    const command = await parseCommand(["--resume", "20260519-103045-x7q2"])
    expect(command.type).toBe("run")
    if (command.type === "run") expect(command.options.resumeRunID).toBe("20260519-103045-x7q2")
  })

  test("rejects invalid max attempts", () => {
    expect(() => parseArgs(["--max-attempts", "0", "prompt"])).toThrow("--max-attempts")
  })

  test("rejects unknown phase names", () => {
    expect(() => parseArgs(["--only", "secuirty", "prompt"])).toThrow('unknown phase "secuirty"')
    expect(() => parseArgs(["--skip", "desing", "prompt"])).toThrow('unknown phase "desing"')
    expect(() => parseArgs(["--skip", "human-review", "prompt"])).toThrow("--no-human-review")
  })

  test("rejects a flag where a value is expected", () => {
    expect(() => parseArgs(["--prompt-file", "--only"])).toThrow("--prompt-file requires a value")
  })

  test("rejects conflicting prompt sources", async () => {
    await expect(parseCommand(["--prompt-file", "prd.md", "inline prompt"])).rejects.toThrow("not both")
    await expect(parseCommand(["--resume", "20260519-103045-x7q2", "new prompt"])).rejects.toThrow("--resume")
  })

  test("parses human review flags", () => {
    const parsed = parseArgs([
      "--human-review",
      "--no-tui",
      "--emulator",
      "Pixel_8",
      "--app-run-command",
      "flutter run -d emulator-5554",
      "--interactive-model",
      "openai/gpt-5.5-pro",
      "--interactive-variant",
      "xhigh",
      "prompt",
    ])

    expect(parsed.humanReview).toBe(true)
    expect(parsed.tui).toBe(false)
    expect(parsed.emulatorID).toBe("Pixel_8")
    expect(parsed.appRunCommand).toBe("flutter run -d emulator-5554")
    expect(parsed.interactiveModel).toBe("openai/gpt-5.5-pro")
    expect(parsed.interactiveVariant).toBe("xhigh")
  })

  test("does not configure a Flutter app command by default", () => {
    const parsed = parseArgs(["prompt"])

    expect(parsed.appRunCommand).toBe("")
    expect(parsed.emulatorID).toBe("")
  })

  test("yolo is opt-in", () => {
    expect(parseArgs(["prompt"]).yolo).toBe(false)
    expect(parseArgs(["--yolo", "prompt"]).yolo).toBe(true)
  })

  test("parses the runs subcommand", async () => {
    const bare = await parseCommand(["runs"])
    expect(bare.type).toBe("runs")
    if (bare.type === "runs") expect(bare.runID).toBeUndefined()

    const withID = await parseCommand(["runs", "20260519-103045-x7q2"])
    expect(withID.type).toBe("runs")
    if (withID.type === "runs") expect(withID.runID).toBe("20260519-103045-x7q2")
  })

  test("rejects bad runs subcommand arguments", async () => {
    await expect(parseCommand(["runs", "latest"])).rejects.toThrow("invalid run id")
    await expect(parseCommand(["runs", "20260519-103045-x7q2", "extra"])).rejects.toThrow("usage: archer runs")
  })
})
