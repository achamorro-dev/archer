import { isAbsolute, relative } from "node:path"

import { describe, expect, test } from "bun:test"

import { isValidRunID, runDir, runsRoot } from "../src/workspace"

describe("workspace run IDs", () => {
  test("accepts generated run ID shape", () => {
    expect(isValidRunID("20260519-103045-x7q2")).toBe(true)
  })

  test("rejects traversal and arbitrary names", () => {
    expect(isValidRunID("../20260519-103045-x7q2")).toBe(false)
    expect(isValidRunID("latest")).toBe(false)
    expect(() => runDir("../20260519-103045-x7q2")).toThrow("run id invalido")
  })

  test("resolves run dirs under the archer runs root", () => {
    const id = "20260519-103045-x7q2"
    const pathFromRoot = relative(runsRoot(), runDir(id))

    expect(pathFromRoot).toBe(id)
    expect(pathFromRoot.startsWith("..")).toBe(false)
    expect(isAbsolute(pathFromRoot)).toBe(false)
  })
})
