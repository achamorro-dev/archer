#!/usr/bin/env bun
import { parseAndRun } from "./cli"

parseAndRun(Bun.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
