/** Where a connected app runs; deployment captures match on it. */
export type CaptureEnvironment = 'production' | 'staging' | 'demo' | 'development'
/** A connection and whether its stored session can still be used. Never any session material. */
export type CaptureConnection = {
  id: string
  name: string
  sourceAppId: string | null
  environment: CaptureEnvironment
  origin: string
  hosts: string[]
  loginHosts: string[]
  protectedPath: string
  identitySelector: string
  expectedAccount: string
  status: 'CONNECTING' | 'READY' | 'NEEDS_AUTH' | 'REVOKED'
  generation: number
  validatedAt: string | null
  stateExpiresAt: string | null
  connectPhase: string | null
  failureCode: string | null
  revokedAt: string | null
  createdAt: string
  updatedAt: string
}
/** The app to sign in to. Origins and the expected account never change on a connection. */
export type CaptureConnectionInput = {
  name: string
  sourceAppId?: string
  environment: CaptureEnvironment
  origin: string
  hosts: string[]
  loginHosts: string[]
  protectedPath: string
  identitySelector: string
  expectedAccount: string
}
/**
 * The sign-in browser's Live View link is a bearer credential: pass it to the
 * person connecting and nowhere else, and never log or store it.
 */
export type CaptureConnectStart = { intentId: string; liveViewUrl: string; expiresAt: string }
/** A reviewed capture of one screen. The Go validator is the authority on what can run. */
export type CaptureRecipeDefinition = {
  schemaVersion: 1
  viewport: { width: number; height: number }
  steps: {
    kind: 'NAVIGATE' | 'WAIT_FOR' | 'SELECT_TAB'
    path?: string
    selector?: string
    timeoutMs?: number
  }[]
  markers: string[]
  forbidden?: string[]
  masks?: string[]
  version?: { path?: string; selector?: string }
  allowedPostPaths?: string[]
}
/** One immutable recipe version. */
export type CaptureRecipe = {
  id: string
  name: string
  version: number
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED'
  surfaceId: string | null
  connectionId: string | null
  hash: string | null
  definition: CaptureRecipeDefinition
  testedAt: string | null
  createdAt: string
}
/** A new version of a screen's capture; it runs only as a test until activated. */
export type CaptureRecipeInput = {
  name: string
  surfaceId: string
  connectionId: string
  definition: CaptureRecipeDefinition
}
/** A capture job's status: IDs and safe codes, no browser state. */
export type CaptureJob = {
  id: string
  recipeId: string
  recipeVersion: number
  kind: 'test' | 'manual' | 'deployment'
  phase:
    | 'QUEUED'
    | 'WAITING_DEPLOYMENT'
    | 'RUNNING'
    | 'NEEDS_AUTH'
    | 'SUCCEEDED'
    | 'FAILED'
    | 'CANCELLED'
  surfaceId: string | null
  connectionId: string | null
  deploymentEventId: string | null
  expectedRevision: string | null
  surfaceCaptureId: string | null
  assetId: string | null
  failureCode: string | null
  attempts: number
  createdAt: string
  updatedAt: string
}
/** Everything a member may read about this workspace's authenticated capture. */
export type CaptureOverview = {
  available: boolean
  connections: CaptureConnection[]
  recipes: CaptureRecipe[]
  jobs: CaptureJob[]
}
