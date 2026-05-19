import { describe, expect, test } from "bun:test"

import { parseModel, shouldSkip } from "../src/runner"

describe("runner helpers", () => {
  test("parses provider/model values", () => {
    expect(parseModel("anthropic/claude-sonnet-4-6")).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-6",
    })
    expect(parseModel("custom/provider/model")).toEqual({ providerID: "custom", modelID: "provider/model" })
    expect(() => parseModel("claude-sonnet-4-6")).toThrow("modelo invalido")
  })

  test("applies only and skip phase filters", () => {
    expect(shouldSkip("security", { onlyPhases: ["implementer"], skipPhases: [] })).toBe(true)
    expect(shouldSkip("implementer", { onlyPhases: ["implementer"], skipPhases: ["implementer"] })).toBe(false)
    expect(shouldSkip("design", { onlyPhases: [], skipPhases: ["design"] })).toBe(true)
    expect(shouldSkip("tests", { onlyPhases: [], skipPhases: [] })).toBe(false)
  })
})
