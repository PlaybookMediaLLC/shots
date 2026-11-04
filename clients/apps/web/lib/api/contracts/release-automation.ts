import { z } from 'zod'
import { productionQualificationSchema } from 'screenshot-studio-backend-sdk'
import {
  automationActionSchema,
  automationActionTypeSchema,
  automationReferenceSchema,
} from './release-automation-actions'

export { automationActionSchema, automationActionTypeSchema, automationReferenceSchema }

/** Independent GitHub event families; selecting one does not correlate events. */
export const automationFamilySchema = z.enum([
  'release.published',
  'pull_request.merged',
  'deployment.succeeded',
  'tag.pushed',
  'milestone.closed',
])

/** A bounded predicate or nested group; semantic validation belongs to Go. */
export const automationConditionSchema = z.object({
  group: z.enum(['ALL', 'ANY', 'NOT']).optional(),
  get children() {
    return z.array(automationConditionSchema).max(32).optional()
  },
  field: z.string().max(100).optional(),
  operator: z.string().max(40).optional(),
  values: z.array(z.string().max(1000)).max(50).optional(),
})

/** An AI relevance check: the team's criteria, a confidence bar, and a budget. */
export const automationClassifySchema = z.object({
  criteria: z.string().max(1000),
  threshold: z.number().min(0).max(1),
  creditLimit: z.number().int().min(0).max(50),
})

/** Draft nodes may be incomplete; server activation requires valid configuration. */
export const automationNodeSchema = z.object({
  id: z.string().max(64),
  type: z.enum(['trigger', 'condition', 'classify', 'action', 'end']),
  condition: automationConditionSchema.optional(),
  classify: automationClassifySchema.optional(),
  action: automationActionSchema.optional(),
  outcome: z.string().max(40).optional(),
})

/** Execution semantics exclude node positions. */
export const automationGraphSchema = z.object({
  schemaVersion: z.number().int(),
  family: automationFamilySchema,
  qualification: automationConditionSchema,
  nodes: z.array(automationNodeSchema).max(64),
  edges: z
    .array(
      z.object({ from: z.string().max(64), to: z.string().max(64), branch: z.string().max(20) })
    )
    .max(128),
})

/** Canvas positions are saved separately and never interpreted by the worker. */
export const automationLayoutSchema = z.record(
  z.string().max(64),
  z.object({ x: z.number().min(-100000).max(100000), y: z.number().min(-100000).max(100000) })
)

/** Validation errors link to a node, or the definition when nodeId is empty. */
export const automationIssueSchema = z.object({
  nodeId: z.string(),
  code: z.string(),
  message: z.string(),
})

/** One definition with its editable draft and immutable active-version reference. */
export const automationDefinitionSchema = z.object({
  id: z.string(),
  sourceAppId: z.string(),
  name: z.string(),
  description: z.string(),
  priority: z.number(),
  revision: z.number(),
  enabled: z.boolean(),
  archived: z.boolean().optional(),
  activeVersionId: z.string().nullable(),
  activePriority: z.number(),
  draft: automationGraphSchema,
  layout: automationLayoutSchema,
  modifiedBy: z.string(),
  updatedAt: z.string(),
  issues: z.array(automationIssueSchema),
  lastRun: z
    .object({ id: z.string(), status: z.string(), createdAt: z.string() })
    .nullable()
    .optional(),
  recentRuns: z.number().int().optional(),
})

/** Optimistic concurrency prevents a stale tab from replacing another admin's draft. */
export const automationSaveSchema = z.object({
  id: z.string().max(64).default(''),
  sourceAppId: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(160),
  description: z.string().max(2000),
  priority: z.int().min(0, 'Must be 0–9999.').max(9999, 'Must be 0–9999.'),
  expectedRevision: z.number().int().nonnegative(),
  graph: automationGraphSchema,
  layout: automationLayoutSchema,
})

/** Evidence state distinguishes absent metadata from unfinished/failed enrichment. */
export const automationValueSchema = z.object({
  state: z.string(),
  values: z.array(z.string()).optional(),
  boolean: z.boolean().optional(),
})

/** Normalized evidence; raw GitHub payloads and credentials are never retained. */
export const automationEventSchema = z.object({
  family: automationFamilySchema,
  semanticKey: z.string().max(255),
  repositoryId: z.string().min(1).max(64),
  repositoryName: z.string().max(200),
  objectId: z.string().max(64),
  number: z.number().int().positive().optional(),
  occurredAt: z.string().datetime(),
  origin: z.string(),
  title: z
    .string()
    .min(1)
    .refine((value) => [...value].length <= 160),
  notes: z.string().refine((value) => [...value].length <= 50000),
  url: z.string().max(2000),
  defaultBranch: z.string().max(200).optional(),
  fields: z.record(z.string(), automationValueSchema),
  production: productionQualificationSchema.optional(),
})

/** Pure preview against exactly one supplied example or tenant-owned stored event. */
export const automationPreviewInputSchema = z
  .object({
    sourceAppId: z.string().min(1).max(64),
    graph: automationGraphSchema,
    eventId: z.string().min(1).max(64).optional(),
    example: automationEventSchema.optional(),
    assumeIrrelevant: z.boolean().optional(),
  })
  .refine(({ eventId, example }) => !!eventId !== !!example, 'Choose one event or example.')

/** A condition's explicit result; unresolved evidence never chooses an else branch. */
export const automationDecisionSchema = z.object({
  status: z.string(),
  match: z.boolean(),
  reason: z.string(),
  score: z.number().optional(),
})

/** A prediction lists actions without fabricating IDs or invoking their side effects. */
export const automationPreviewSchema = z.object({
  issues: z.array(automationIssueSchema),
  qualification: automationDecisionSchema,
  steps: z.array(
    z.object({
      nodeId: z.string(),
      type: z.string(),
      decision: automationDecisionSchema.optional(),
      action: z.string().optional(),
      outcome: z.string().optional(),
    })
  ),
  outcome: z.string(),
  evidence: z.string(),
})

/** The newest graph language and capabilities that some live worker advertises. */
export const automationExecutorSchema = z.object({
  available: z.boolean(),
  schemaVersion: z.number().int(),
  capabilities: z.array(z.string()),
})

/** Whether the backend can execute an action or AI check now, and what to configure if not. */
export const automationActionAvailabilitySchema = z.object({
  type: z.union([automationActionTypeSchema, z.literal('classify')]),
  available: z.boolean(),
  reason: z.string(),
})

/** Safe workspace resources and the live worker capability reported by the backend. */
export const automationOverviewSchema = z.object({
  definitions: z.array(automationDefinitionSchema),
  sources: z.array(
    z.object({
      branch: z.string().optional(),
      id: z.string(),
      name: z.string(),
      repositoryId: z.string(),
      status: z.string(),
      mode: z.string(),
      account: z.string(),
      installationStatus: z.string(),
      connectionState: z.string(),
      collectUnmatched: z.boolean(),
    })
  ),
  brands: z.array(z.object({ id: z.string(), name: z.string() })),
  destinations: z.array(z.object({ id: z.string(), name: z.string() })),
  surfaces: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
  /** Design templates a render node can fill, from the web's catalog. */
  templates: z
    .array(z.object({ id: z.string(), name: z.string(), aspectRatio: z.string() }))
    .optional(),
  fields: z.record(automationFamilySchema, z.record(z.string(), z.string())),
  executorAvailable: z.boolean(),
  executor: automationExecutorSchema.optional(),
  actions: z.array(automationActionAvailabilitySchema).optional(),
  legacyRunCounts: z.record(z.string(), z.number().int()).optional(),
  runCounts: z.record(z.string(), z.number().int()).optional(),
})

/** Product references produced by completed actions. */
export const automationOutputsSchema = z.object({
  releaseId: z.string().optional(),
  campaignId: z.string().optional(),
  postIds: z.array(z.string()).optional(),
  brandKitId: z.string().optional(),
  brandKitVersion: z.number().int().optional(),
  destinationIds: z.array(z.string()).optional(),
  creditsCharged: z.number().int().optional(),
  designIds: z.array(z.string()).optional(),
  renderedAssetIds: z.array(z.string()).optional(),
  canvasId: z.string().optional(),
  codeProjectId: z.string().optional(),
})

/** Persisted event/run history remains readable during a Temporal outage. */
export const automationHistoryItemSchema = z.object({
  event: z.object({
    id: z.string(),
    sourceAppId: z.string(),
    deliveryId: z.string(),
    snapshot: automationEventSchema,
    versionIds: z.array(z.string()),
    mode: z.string(),
    disposition: z.string(),
    reason: z.string(),
    receivedAt: z.string(),
    enrichedAt: z.string().nullable(),
    enrichment: z.record(z.string(), automationValueSchema),
  }),
  run: z.object({
    id: z.string(),
    eventId: z.string(),
    definitionId: z.string().nullable(),
    versionId: z.string().nullable(),
    versionRevision: z.number().int().nullable().optional(),
    workflowId: z.string(),
    temporalRunId: z.string(),
    status: z.string(),
    cancelRequested: z.boolean(),
    recoveryAttempt: z.number(),
    failureCode: z.string(),
    reason: z.string(),
    outputs: automationOutputsSchema,
    createdAt: z.string(),
    completedAt: z.string().nullable(),
  }),
})

/** Node-level decisions, receipts, and attempts for one tenant run. */
export const automationRunDetailSchema = automationHistoryItemSchema.extend({
  nodes: z.array(
    z.object({
      nodeId: z.string(),
      actionKey: z.string(),
      status: z.string(),
      attempts: z.number(),
      failureCode: z.string(),
      decision: automationDecisionSchema,
      outputs: automationOutputsSchema,
      startedAt: z.string(),
      completedAt: z.string().nullable(),
    })
  ),
})

/** Identity input for tenant-owned records. */
export const automationIdentitySchema = z.object({ id: z.string().min(1).max(64) })

/** A version transition must use the last saved revision. */
export const automationRevisionSchema = automationIdentitySchema.extend({
  revision: z.number().int().positive(),
})

/** The condition type inferred from its transport contract. */
export type AutomationCondition = z.infer<typeof automationConditionSchema>
/** The graph type inferred from its transport contract. */
export type AutomationGraph = z.infer<typeof automationGraphSchema>
/** One graph node inferred from its transport contract. */
export type AutomationNode = z.infer<typeof automationNodeSchema>
/** One action configuration inferred from its discriminated union. */
export type AutomationAction = z.infer<typeof automationActionSchema>
/** A registered action identifier. */
export type AutomationActionType = z.infer<typeof automationActionTypeSchema>
/** A GitHub event family. */
export type AutomationFamily = z.infer<typeof automationFamilySchema>
/** Canvas positions keyed by node ID. */
export type AutomationLayout = z.infer<typeof automationLayoutSchema>
/** A definition with its draft and dashboard run summary. */
export type AutomationDefinition = z.infer<typeof automationDefinitionSchema>
/** The workspace's workflows, sources, resources, and executor capability. */
export type AutomationOverview = z.infer<typeof automationOverviewSchema>
/** A normalized event snapshot. */
export type AutomationEvent = z.infer<typeof automationEventSchema>
/** A dry-run prediction. */
export type AutomationPreview = z.infer<typeof automationPreviewSchema>
/** One persisted event and its logical run. */
export type AutomationHistoryItem = z.infer<typeof automationHistoryItemSchema>
/** A run with its node receipts. */
export type AutomationRunDetail = z.infer<typeof automationRunDetailSchema>
