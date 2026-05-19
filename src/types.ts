export type RunOptions = {
  prompt: string
  files: string[]
  onlyPhases: string[]
  skipPhases: string[]
  resumeRunID: string
  keepRunDir: boolean
  modelOverride: string
  maxAttempts: number
  baseRef: string
  targetDir: string
  includeDirty: boolean
}

export type Phase = {
  name: string
  agentName: string
  model: string
  description: string
  inputFiles: readonly string[]
  inputDiff: boolean
  reportPath: string
}
