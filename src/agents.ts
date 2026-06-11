import { readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import type { AgentConfig, Config } from "@opencode-ai/sdk/v2"
import type { AgentName } from "./phases"

const sourceDir = dirname(fileURLToPath(import.meta.url))
const builtInPromptsDir = join(sourceDir, "..", "prompts")
const runtimeSafetyPrompt = "runtime-safety"

export function opencodeConfig(runDir: string, targetDir = process.cwd()): Config {
  const agent = {
    implementer: agentConfig(
      "Implements the feature described in the PRD respecting repo patterns",
      undefined,
      loadAgentPrompt("implementer", targetDir),
      runDir,
      targetDir,
      false,
    ),
    "pattern-auditor": agentConfig(
      "Audits patterns and best practices, applies refactoring without changing behavior",
      undefined,
      loadAgentPrompt("pattern-auditor", targetDir),
      runDir,
      targetDir,
      false,
    ),
    "security-auditor": agentConfig(
      "Audits the new implementation for security issues and fixes them",
      undefined,
      loadAgentPrompt("security-auditor", targetDir),
      runDir,
      targetDir,
      false,
    ),
    "design-polisher": agentConfig(
      "Polishes new UI following the repo's design system, without redesigning",
      0.2,
      loadAgentPrompt("design-polisher", targetDir),
      runDir,
      targetDir,
      false,
    ),
    "test-engineer": agentConfig(
      "Ensures automated tests and relevant E2E coverage",
      undefined,
      loadAgentPrompt("test-engineer", targetDir),
      runDir,
      targetDir,
      false,
    ),
    "adversarial-reviewer": agentConfig(
      "Final adversarial reviewer before PR creation",
      0.1,
      loadAgentPrompt("adversarial-reviewer", targetDir),
      runDir,
      targetDir,
      false,
    ),
  } satisfies Record<AgentName, AgentConfig>

  return {
    agent,
    provider: providerTimeouts(),
    permission: {
      question: "deny",
    },
  }
}

export function loadAgentPrompt(agentName: AgentName, targetDir = process.cwd()) {
  const agentPrompt = readProjectAgentPrompt(agentName, targetDir) ?? readBuiltInPrompt(agentName)
  const safetyPrompt = readBuiltInPrompt(runtimeSafetyPrompt)
  return [agentPrompt.trimEnd(), "", "---", "", safetyPrompt.trim()].join("\n")
}

export function projectAgentPromptPath(agentName: AgentName, targetDir: string) {
  return join(targetDir, ".archer", "agents", `${agentName}.md`)
}

export function builtInPromptPath(promptName: AgentName | typeof runtimeSafetyPrompt) {
  return join(builtInPromptsDir, `${promptName}.md`)
}

function readProjectAgentPrompt(agentName: AgentName, targetDir: string) {
  const path = projectAgentPromptPath(agentName, targetDir)
  if (!isFile(path)) return undefined
  return readFileSync(path, "utf8")
}

function readBuiltInPrompt(promptName: AgentName | typeof runtimeSafetyPrompt) {
  const path = builtInPromptPath(promptName)
  if (!isFile(path)) throw new Error(`missing built-in prompt: ${path}`)
  return readFileSync(path, "utf8")
}

function isFile(path: string) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const providerIdleTimeoutMs = 10 * 60 * 1000

function providerTimeouts(): Config["provider"] {
  const options = {
    timeout: false as const,
    chunkTimeout: providerIdleTimeoutMs,
  }

  return {
    anthropic: { options },
    openai: { options },
    openrouter: { options },
  }
}

function agentConfig(
  description: string,
  temperature: number | undefined,
  prompt: string,
  runDir: string,
  targetDir: string,
  webfetch: boolean,
): AgentConfig {
  return {
    description,
    mode: "primary",
    ...(temperature === undefined ? {} : { temperature }),
    tools: {
      read: true,
      write: true,
      edit: true,
      bash: true,
      webfetch,
    },
    permission: {
      edit: "allow",
      question: "deny",
      bash: bashPolicy(targetDir),
      external_directory: {
        "*": "deny",
        [join(runDir, "**")]: "allow",
      },
    },
    prompt,
  }
}

// Safe-by-default commands across the toolchains archer targets. Anything not
// listed falls through to "ask" (or auto-accept when --yolo / shift+tab is on).
export const baseAllowBashPatterns = [
  // Flutter / Dart toolchain
  "flutter analyze*",
    "flutter test*",
    "flutter pub get",
    "flutter pub upgrade",
    "flutter pub outdated",
    "flutter pub deps*",
    "flutter format*",
    "flutter clean",
    "flutter doctor*",
    "flutter --version",
    "dart analyze*",
    "dart test*",
    "dart format*",
    "dart pub get",
    "dart pub upgrade",
    "dart pub outdated",
    "dart pub deps*",
    "dart run build_runner*",
    "dart --version",
    // Web / JavaScript / TypeScript checks
    "npm test*",
    "npm run test*",
    "npm run lint*",
    "npm run typecheck*",
    "npm run check*",
    "npm run build*",
    "npm --version",
    "pnpm test*",
    "pnpm run test*",
    "pnpm run lint*",
    "pnpm run typecheck*",
    "pnpm run check*",
    "pnpm run build*",
    "pnpm lint*",
    "pnpm typecheck*",
    "pnpm check*",
    "pnpm build*",
    "pnpm --version",
    "yarn test*",
    "yarn run test*",
    "yarn run lint*",
    "yarn run typecheck*",
    "yarn run check*",
    "yarn run build*",
    "yarn lint*",
    "yarn typecheck*",
    "yarn check*",
    "yarn build*",
    "yarn --version",
    "bun test*",
    "bun run test*",
    "bun run lint*",
    "bun run typecheck*",
    "bun run check*",
    "bun run build*",
    "bun --version",
    "node --version",
    "tsc --noEmit*",
    "npm run format*",
    "pnpm run format*",
    "pnpm format*",
    "yarn run format*",
    "yarn format*",
    "bun run format*",
    // Python checks
    "pytest*",
    "python -m pytest*",
    "python3 -m pytest*",
    "ruff check*",
    "ruff format*",
    "mypy*",
    // Go checks
    "go test*",
    "go vet*",
    "go fmt*",
    // Rust checks
    "cargo test*",
    "cargo check*",
    "cargo fmt*",
    "cargo clippy*",
    // Make: only well-known read/check targets; bare "make*" could run anything
    "make test",
    "make lint",
    "make check",
    "make build",
    // Common E2E dry-run/listing commands
    "maestro test --dry-run*",
    "maestro --version",
    "npm run e2e -- --list*",
    "pnpm run e2e -- --list*",
    "yarn run e2e -- --list*",
    // read-only git
    "git status*",
    "git diff*",
    "git log*",
    "git show*",
    "git rev-parse*",
    // listing forms only: a bare "git branch*" would also allow -D/-m
    "git branch",
    "git branch -a",
    "git branch -r",
    "git branch -v",
    "git branch -vv",
    "git branch --list*",
    "git branch --show-current",
    "git ls-files*",
    "git ls-tree*",
    "git config --get*",
    "git stash list*",
    "git remote -v",
    "git --version",
    // Generic read-only shell. Note the policy matches command prefixes, so
    // shell redirection ("ls > file") can still write; that has to be caught
    // by opencode itself, not by patterns. find is excluded on purpose: its
    // -delete/-exec arguments execute arbitrary destructive commands.
    "pwd",
    "ls*",
    "cat*",
    "head*",
    "tail*",
    "grep*",
    "rg*",
    "wc*",
    "echo*",
    "printf*",
    "which*",
    "whoami",
    "file*",
    "tree*",
    "stat*",
    "jq*",
    "du -sh*",
    "true",
    "false",
]

// Hard denylist. Never relaxed — --yolo and the shift+tab auto-accept toggle
// only affect commands that would otherwise *ask*. This protects against
// accidents (pushes, recursive deletes, installs), not against a malicious
// agent: agents can edit repo code that later runs, so allowlisted scripts
// imply trusting the repo contents anyway.
export const denyBashPatterns = [
    // remote operations - always Archer's job
    "git push*",
    "git push",
    "git fetch*",
    "git pull*",
    "git remote add*",
    "git remote set-url*",
    "git remote rm*",
    "git remote remove*",
    // exact + spaced forms so ghc/ghq and similar tools aren't denied too
    "gh",
    "gh *",
    // publishing / deployment
    "npm publish*",
    "yarn publish*",
    "pnpm publish*",
    "bun publish*",
    "npm run deploy*",
    "yarn run deploy*",
    "pnpm run deploy*",
    "bun run deploy*",
    "vercel*",
    "netlify*",
    "firebase deploy*",
    // history rewrite or destructive git
    "git reset --hard*",
    "git reset --keep*",
    "git reset --merge*",
    "git rebase*",
    "git filter-branch*",
    "git filter-repo*",
    "git clean -f*",
    "git clean -d*",
    "git checkout .*",
    "git restore .*",
    "git worktree*",
    // recursive removes against the filesystem root or home
    "rm -rf /*",
    "rm -rf /",
    "rm -fr /*",
    "rm -fr /",
    "rm -rf ~*",
    "rm -fr ~*",
    "rm -rf $HOME*",
    "rm -fr $HOME*",
    "rm -rf ${HOME}*",
    "rm -fr ${HOME}*",
    // download-and-execute patterns
    "curl* | sh*",
    "curl* | bash*",
    "curl* | zsh*",
    "wget* | sh*",
    "wget* | bash*",
    "wget* | zsh*",
    "curl* |sh*",
    "curl* |bash*",
    "curl* |zsh*",
    "wget* |sh*",
    "wget* |bash*",
    "wget* |zsh*",
    // package install
    "npm install*",
    "npm i *",
    "npm ci*",
    "yarn install*",
    "yarn add*",
    "pnpm install*",
    "pnpm add*",
    "bun install*",
    "bun add*",
    "brew install*",
    "pip install*",
    "pipx install*",
    "cargo install*",
    "go install*",
    "gem install*",
    // privilege escalation (exact + spaced forms: "su*" would deny supabase, subl…)
    "sudo*",
    "su",
    "su *",
    "doas",
    "doas *",
]

// Script names safe to run through the package manager; suffixes like
// test:unit or build-storybook stay covered by the separator group.
const safeScriptName = /^(test|lint|typecheck|type-check|check|build|format|validate)([:._-].*)?$/
const dangerousScriptHint = /(deploy|publish|release|migrate|seed|reset)/i

/** Exact allow patterns for the target repo's own package.json scripts that look like checks. */
export function projectScriptAllowPatterns(targetDir = process.cwd()): string[] {
  const path = join(targetDir, "package.json")
  if (!isFile(path)) return []

  let scripts: Record<string, unknown>
  try {
    scripts = (JSON.parse(readFileSync(path, "utf8")) as { scripts?: Record<string, unknown> }).scripts ?? {}
  } catch {
    return []
  }

  const out: string[] = []
  for (const name of Object.keys(scripts)) {
    if (!safeScriptName.test(name) || dangerousScriptHint.test(name)) continue
    // Exact name plus a "name *" args form: "npm run build*" would also match
    // an unrelated "build-and-push" script, the space keeps it scoped.
    for (const runner of ["npm run", "pnpm run", "pnpm", "yarn run", "yarn", "bun run"]) {
      out.push(`${runner} ${name}`, `${runner} ${name} *`)
    }
  }
  return out
}

export function bashPolicy(targetDir = process.cwd()): Record<string, "allow" | "deny" | "ask"> {
  const policy: Record<string, "allow" | "deny" | "ask"> = {}
  const denied = new Set(denyBashPatterns)
  for (const pattern of denyBashPatterns) policy[pattern] = "deny"
  for (const pattern of [...baseAllowBashPatterns, ...projectScriptAllowPatterns(targetDir)]) {
    if (denied.has(pattern)) continue
    policy[pattern] = "allow"
  }
  policy["*"] = "ask"
  return policy
}
