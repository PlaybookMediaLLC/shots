import type { z } from 'zod'
import type { productionQualificationSchema } from './github-production.ts'
/** The v1/v2 execution language; the Go validator is the execution authority. */
export type AutomationFamily =
  | 'release.published'
  | 'pull_request.merged'
  | 'deployment.succeeded'
  | 'tag.pushed'
  | 'milestone.closed'
export type AutomationCondition = {
  group?: 'ALL' | 'ANY' | 'NOT'
  children?: AutomationCondition[]
  field?: string
  operator?: string
  values?: string[]
}
export type AutomationAction =
  | { type: 'create_release'; audience?: string; include?: 'unreleased' }
  | {
      type: 'create_campaign'
      input?: { nodeId: string; output: string }
      brandKitId?: string
      destinationIds?: string[]
      audience?: string
      callToAction?: string
    }
  | { type: 'generate_copy'; input?: { nodeId: string; output: string }; creditLimit?: number }
  | {
      type: 'capture_product'
      input?: { nodeId: string; output: string }
      surfaceId?: string
      versionPath?: string
      currentState?: boolean
      recipeId?: string
    }
  | {
      type: 'render_creatives'
      input?: { nodeId: string; output: string }
      templateIds?: string[]
      surfaceId?: string
    }
  | {
      type: 'create_canvas'
      input?: { nodeId: string; output: string }
      recipeIds?: string[]
      surfaceId?: string
    }
  | {
      type: 'render_code_visual'
      input?: { nodeId: string; output: string }
      /** The owner's consent to read the merged pull request's diff. */
      readSourceCode?: boolean
    }
  | { type: 'submit_review'; input?: { nodeId: string; output: string } }
export type AutomationClassify = { criteria: string; threshold: number; creditLimit: number }
export type AutomationNode = {
  id: string
  type: 'trigger' | 'condition' | 'classify' | 'action' | 'end'
  condition?: AutomationCondition
  classify?: AutomationClassify
  action?: AutomationAction
  outcome?: string
}
export type AutomationGraph = {
  schemaVersion: number
  family: AutomationFamily
  qualification: AutomationCondition
  nodes: AutomationNode[]
  edges: { from: string; to: string; branch: string }[]
}
export type AutomationLayout = Record<string, { x: number; y: number }>
export type AutomationIssue = { nodeId: string; code: string; message: string }
export type AutomationDefinition = {
  id: string
  sourceAppId: string
  name: string
  description: string
  priority: number
  revision: number
  archived?: boolean
  enabled: boolean
  activeVersionId: string | null
  activePriority: number
  draft: AutomationGraph
  layout: AutomationLayout
  modifiedBy: string
  updatedAt: string
  issues: AutomationIssue[]
  lastRun?: { id: string; status: string; createdAt: string } | null
  recentRuns?: number
}
export type SaveAutomationInput = {
  id: string
  sourceAppId: string
  name: string
  description: string
  priority: number
  expectedRevision: number
  graph: AutomationGraph
  layout: AutomationLayout
}
export type AutomationValue = { state: string; values?: string[]; boolean?: boolean }
export type AutomationEventSnapshot = {
  family: AutomationFamily
  semanticKey: string
  repositoryId: string
  repositoryName: string
  objectId: string
  number?: number
  occurredAt: string
  origin: string
  title: string
  notes: string
  url: string
  defaultBranch?: string
  fields: Record<string, AutomationValue>
  production?: z.infer<typeof productionQualificationSchema>
}
export type AutomationDecision = { status: string; match: boolean; reason: string; score?: number }
export type AutomationPreview = {
  issues: AutomationIssue[]
  qualification: AutomationDecision
  steps: {
    nodeId: string
    type: string
    decision?: AutomationDecision
    action?: string
    outcome?: string
  }[]
  outcome: string
  evidence: string
}
export type AutomationOverview = {
  definitions: AutomationDefinition[]
  sources: {
    branch?: string
    id: string
    name: string
    repositoryId: string
    status: string
    mode: string
    account: string
    installationStatus: string
    connectionState: string
    collectUnmatched: boolean
  }[]
  brands: { id: string; name: string }[]
  destinations: { id: string; name: string }[]
  surfaces?: { id: string; name: string }[]
  fields: Record<AutomationFamily, Record<string, string>>
  executorAvailable: boolean
  executor?: { available: boolean; schemaVersion: number; capabilities: string[] }
  actions?: { type: AutomationAction['type'] | 'classify'; available: boolean; reason: string }[]
  runCounts?: Record<string, number>
  legacyRunCounts?: Record<string, number>
}
export type AutomationOutputs = {
  releaseId?: string
  campaignId?: string
  postIds?: string[]
  brandKitId?: string
  brandKitVersion?: number
  destinationIds?: string[]
  creditsCharged?: number
  designIds?: string[]
  renderedAssetIds?: string[]
  canvasId?: string
  codeProjectId?: string
  captureId?: string
  captureAssetId?: string
  captureProof?: 'version' | 'current_state'
}
export type AutomationHistoryItem = {
  event: {
    id: string
    sourceAppId: string
    deliveryId: string
    snapshot: AutomationEventSnapshot
    versionIds: string[]
    mode: string
    disposition: string
    reason: string
    receivedAt: string
    enrichedAt: string | null
    enrichment: Record<string, AutomationValue>
  }
  run: {
    id: string
    eventId: string
    definitionId: string | null
    versionId: string | null
    versionRevision?: number | null
    workflowId: string
    temporalRunId: string
    status: string
    cancelRequested: boolean
    recoveryAttempt: number
    failureCode: string
    reason: string
    outputs: AutomationOutputs
    createdAt: string
    completedAt: string | null
  }
}
export type AutomationRunDetail = AutomationHistoryItem & {
  nodes: {
    nodeId: string
    actionKey: string
    status: string
    attempts: number
    failureCode: string
    decision: AutomationDecision
    outputs: AutomationOutputs
    startedAt: string
    completedAt: string | null
  }[]
}
export type AutomationVersion = {
  id: string
  definitionId: string
  revision: number
  graph: AutomationGraph
  contentHash: string
  activatedBy?: string
  createdAt?: string
}
/** Optional run-history filters; the backend scopes them to the caller's workspace. */
export type AutomationHistoryFilter = {
  mode?: 'automation' | 'legacy'
  before?: string
  definitionId?: string
  versionId?: string
  sourceAppId?: string
  family?: AutomationFamily
  status?: string
  since?: string
  until?: string
}

/** List evidence without release notes or enrichment. */
export type AutomationRunSummary = {
  event: Pick<AutomationHistoryItem['event'], 'id' | 'sourceAppId' | 'receivedAt' | 'mode'> & {
    snapshot: Pick<
      AutomationEventSnapshot,
      'family' | 'repositoryName' | 'objectId' | 'number' | 'title' | 'fields'
    >
  }
  run: AutomationHistoryItem['run']
}
