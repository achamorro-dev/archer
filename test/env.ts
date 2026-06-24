import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Isolate every test run from the developer's real ~/.archer so tests never
// read or write the user's actual config, runs, or agent prompts. ARCHER_HOME
// points at the directory that holds `.archer` (the same convention as a repo
// root), so the global config resolves to <tmp>/.archer/config.yaml.
process.env.ARCHER_HOME ??= join(tmpdir(), `archer-test-home-${process.pid}`)
mkdirSync(process.env.ARCHER_HOME, { recursive: true })
