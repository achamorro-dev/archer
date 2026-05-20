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
})
