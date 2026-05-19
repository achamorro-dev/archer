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
    await expect(parseCommand([])).rejects.toThrow("hace falta un prompt")

    const command = await parseCommand(["--resume", "20260519-103045-x7q2"])
    expect(command.type).toBe("run")
    if (command.type === "run") expect(command.options.resumeRunID).toBe("20260519-103045-x7q2")
  })

  test("rejects invalid max attempts", () => {
    expect(() => parseArgs(["--max-attempts", "0", "prompt"])).toThrow("--max-attempts")
  })
})
