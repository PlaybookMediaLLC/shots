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
  discoveredRoutes?: { path: string; label: string }[]
  bootstrapUrl?: string | null
  hasBootstrap?: boolean
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
  bootstrapUrl?: string
  bootstrapSecret?: string
}
/** A new connection; with assignTestEmail Shots assigns the expected account. */
export type CaptureConnectionCreate = Omit<CaptureConnectionInput, 'expectedAccount'> & {
  expectedAccount: string
  assignTestEmail?: boolean
}
/** A typed first-factor email sign-in (RFC 007A). */
export type CaptureLoginRecipe = {
  schemaVersion: 1
  method: 'MAGIC_LINK' | 'EMAIL_CODE'
  startPath: string
  emailInput: string
  requestChallenge: string
  challengeConfirmation?: string
  submitPaths: string[]
  linkHosts?: string[]
  linkPaths?: string[]
  codeInput?: string
  codeLength?: number
  submitCode?: string
}
/** An email sign-in attempt's safe progress. */
export type CaptureAuthAttempt = {
  id: string
  connectionId: string
  mode: 'TEST' | 'AUTO_RECOVER'
  state:
    | 'ADMITTED'
    | 'BROWSER_STARTING'
    | 'CHALLENGE_REQUESTED'
    | 'WAITING_FOR_EMAIL'
    | 'EMAIL_MATCHED'
    | 'APPLYING_CHALLENGE'
    | 'VERIFYING'
    | 'COMMITTING'
    | 'SUCCEEDED'
    | 'FAILED'
    | 'EXPIRED'
    | 'CANCELLED'
    | 'HUMAN_REQUIRED'
  startedAt: string
  deadlineAt: string
  emailRequestedAt: string | null
  emailReceivedAt: string | null
  completedAt: string | null
  failureCode: string | null
  safeMessage: string
}
/** A connection's email sign-in setup. */
export type CaptureEmailAuth = {
  id: string
  connectionId: string
  method: 'MAGIC_LINK' | 'EMAIL_CODE'
  status: 'DRAFT' | 'VERIFIED' | 'PAUSED' | 'REVOKED'
  testEmail: string
  expectedSenders: string[]
  autoReconnect: boolean
  revision: number
  testedRevision: number | null
  recipeVersion: number | null
  recipe: CaptureLoginRecipe | null
  lastTestedAt: string | null
  lastSuccessAt: string | null
  lastFailureCode: string | null
  approvedByUserId: string | null
  approvedAt: string | null
  autoReconnectAvailable: boolean
  latestAttempt: CaptureAuthAttempt | null
  createdAt: string
  updatedAt: string
}
/** A new login recipe version for the revision the owner last saw. */
export type SaveCaptureEmailAuthRecipeInput = {
  expectedRevision: number
  recipe: CaptureLoginRecipe
  expectedSenders: string[]
}
/** Resend's delivery as the web received it: the exact signed bytes and headers. */
export type CaptureAuthInboundEmail = {
  payload: string
  svixId: string
  svixTimestamp: string
  svixSignature: string
}
/**
 * The sign-in browser's Live View link is a bearer credential: pass it to the
 * person connecting and nowhere else, and never log or store it.
 */
export type CaptureConnectStart = { intentId: string; liveViewUrl: string; expiresAt: string }
/** A reviewed capture of one screen. The Go validator is the authority on what can run. */
export type CaptureRecipeDefinition = {
  schemaVersion: 1
  viewport: { width: number; height: number; scale?: 1 | 2 }
  steps: {
    kind: 'NAVIGATE' | 'WAIT_FOR' | 'SELECT_TAB'
    path?: string
    selector?: string
    timeoutMs?: number
  }[]
  markers: string[]
  forbidden?: string[]
  masks?: string[]
  optionalMasks?: string[]
  maskStyle?: 'solid' | 'blur'
  colorScheme?: 'light' | 'dark'
  verifyWithVision?: boolean
  sequenceShots?: number
  crop?: 'marker'
  version?: { path?: string; selector?: string }
  allowedPostPaths?: string[]
  navigation?: {
    objective: string
    maxSteps: number
    creditLimit: number
    useVision?: boolean
    allowSearchFill?: boolean
  }
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
  kind: 'test' | 'manual' | 'agent' | 'deployment'
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
  releaseChange?: string | null
  navigationActions?: { kind: string; path: string }[]
  focusBox?: { x: number; y: number; w: number; h: number }
  sequenceAssetIds?: string[]
}
/** Plain-English input for zero-config AI capture authoring or 1-click auto-capture. */
export type ProposeCaptureRecipeInput = {
  connectionId: string
  surfaceId: string
  prompt: string
  sequenceShots?: number
}
/** A validated, ready-to-save AI capture recipe proposed from a plain-English prompt. */
export type ProposedCaptureRecipe = {
  name: string
  definition: CaptureRecipeDefinition
  reasoning: string
}
/** Both the newly created zero-config AI recipe and its queued capture job. */
export type AutoCaptureResult = {
  recipe: CaptureRecipe
  job: CaptureJob
}
/** Everything a member may read about this workspace's authenticated capture. */
export type CaptureOverview = {
  available: boolean
  connections: CaptureConnection[]
  recipes: CaptureRecipe[]
  jobs: CaptureJob[]
}
