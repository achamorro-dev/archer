export type RunOptions = {
  prompt: string
  files: string[]
  onlyPhases: string[]
  skipPhases: string[]
  resumeRunID: string
  keepRunDir: boolean
  modelOverride: string
  tui: boolean
  humanReview: boolean
  emulatorID: string
  appRunCommand: string
  interactiveModel: string
  interactiveVariant: string
  maxAttempts: number
  baseRef: string
  targetDir: string
  includeDirty: boolean
  /** Start with auto-accept enabled: ask-level permissions are allowed without prompting (denylist still applies). */
  yolo: boolean
}

export type Phase = {
  name: string
  agentName: string
  model: string
  variant?: string
  description: string
  inputFiles: readonly string[]
  inputDiff: boolean
  reportPath: string
}
