import { z } from 'zod'
import {
  automationActionTypeSchema,
  type AutomationActionType,
  type AutomationGraph,
  type AutomationOverview,
} from '@/lib/api/contracts/release-automation'

/** What an action reads and records; the Go validator checks the same names. */
export const workflowOutputSchema = z.enum(['releaseId', 'campaignId', 'reviewIds', 'canvasId'])

/**
 * Static facts about one executor action. Whether it can run right now
 * (worker, plan, model provider) comes from the backend overview, never from
 * this table.
 */
export const workflowActionSpecSchema = z.strictObject({
  type: automationActionTypeSchema,
  label: z.string(),
  description: z.string(),
  /** The output this action consumes, from an earlier action on every path. */
  input: workflowOutputSchema.nullable(),
  output: workflowOutputSchema,
  /** The lowest workflow language version that can contain this action. */
  minSchemaVersion: z.number().int().positive(),
  /** Who may configure or activate it; execution uses a scoped service principal. */
  permission: z.string(),
  integrations: z.array(z.string()),
  entitlement: z.string(),
  retry: z.string(),
  /** Whether it spends AI credits; such actions carry an explicit budget. */
  paid: z.boolean(),
  /** Whether a person must approve its result before anything is published. */
  humanApproval: z.boolean(),
})

/** One registered action's static metadata. */
export type WorkflowActionSpec = z.infer<typeof workflowActionSpecSchema>

const ADMIN = 'Workspace owner or admin session'

/** The executor's action catalogue, keyed so every registered type is covered. */
export const WORKFLOW_ACTIONS = {
  create_release: {
    type: 'create_release',
    label: 'Create release',
    description: 'Records a release linked to the verified GitHub event.',
    input: null,
    output: 'releaseId',
    minSchemaVersion: 1,
    permission: ADMIN,
    integrations: ['GitHub repository'],
    entitlement: 'release:create',
    retry: 'Up to 4 attempts, 2 minutes each. Idempotent per run and node.',
    paid: false,
    humanApproval: false,
  },
  create_campaign: {
    type: 'create_campaign',
    label: 'Create campaign drafts',
    description:
      'Creates a campaign with one draft post per destination from the release text, brand, and audience.',
    input: 'releaseId',
    output: 'campaignId',
    minSchemaVersion: 1,
    permission: ADMIN,
    integrations: ['Published brand kit', 'Connected destination'],
    entitlement: 'campaign:workflow',
    retry: 'Up to 4 attempts, 2 minutes each. Idempotent per run and node.',
    paid: false,
    humanApproval: false,
  },
  generate_copy: {
    type: 'generate_copy',
    label: 'Generate channel copy',
    description:
      'Rewrites each draft post for its channel in your brand voice with AI. Release text is treated as evidence, never as instructions.',
    input: 'campaignId',
    output: 'campaignId',
    minSchemaVersion: 2,
    permission: ADMIN,
    integrations: ['An AI model on the worker', 'AI credits'],
    entitlement: 'campaign:workflow',
    retry:
      'Up to 3 attempts, 5 minutes each. The model is called and credits are charged at most once per run.',
    paid: true,
    humanApproval: false,
  },
  capture_product: {
    type: 'capture_product',
    label: 'Capture this deployment',
    description:
      'Takes a screenshot of one product page or signed-in screen for this deployment, for a later render to show instead of the latest image. Your app must first report the deployed commit at a path you set; without that proof the image is labeled as the current state only.',
    input: 'campaignId',
    output: 'campaignId',
    minSchemaVersion: 3,
    permission: ADMIN,
    integrations: [
      'Public page or signed-in capture',
      'Deployment or release trigger',
      'Screenshot service',
    ],
    entitlement: 'campaign:workflow',
    retry:
      'Up to 8 attempts over about 10 minutes while the deployment goes live. A retry reuses a capture it already took.',
    paid: false,
    humanApproval: false,
  },
  render_creatives: {
    type: 'render_creatives',
    label: 'Render creatives',
    description:
      'Fills 1–3 design templates with the capture from an earlier step, or your latest product capture, and the release headline, styles them with the campaign brand kit, renders them, and attaches them to the campaign for review.',
    input: 'campaignId',
    output: 'campaignId',
    minSchemaVersion: 2,
    permission: ADMIN,
    integrations: ['Product surface with a capture', 'Design renderer'],
    entitlement: 'campaign:workflow',
    retry:
      'Up to 3 attempts, 5 minutes each. A retry reuses the designs and renders it already made.',
    paid: false,
    humanApproval: false,
  },
  render_code_visual: {
    type: 'render_code_visual',
    label: 'Render a code visual',
    description:
      'Reads the merged pull request’s diff (only with your consent), turns its first changed files into a Code Studio project, renders it and attaches the image to the campaign for review.',
    input: 'campaignId',
    output: 'campaignId',
    minSchemaVersion: 2,
    permission: ADMIN,
    integrations: ['GitHub App access to the repository’s code', 'Design renderer'],
    entitlement: 'campaign:workflow',
    retry: 'Up to 3 attempts, 5 minutes each. A retry reuses the code project and image.',
    paid: false,
    humanApproval: false,
  },
  create_canvas: {
    type: 'create_canvas',
    label: 'Create a canvas',
    description:
      'Lays out a canvas from the release with 1–3 canvas templates, using its screenshots or your latest product capture. Every claim quotes the release; the canvas opens for your team to refine and export.',
    input: 'releaseId',
    output: 'canvasId',
    minSchemaVersion: 2,
    permission: ADMIN,
    integrations: ['Release screenshots or a product capture', 'Canvas builder on the web'],
    entitlement: 'workspace:paid',
    retry: 'Up to 3 attempts, 5 minutes each. A retry finds the canvas this run already made.',
    paid: false,
    humanApproval: false,
  },
  submit_review: {
    type: 'submit_review',
    label: 'Submit for human review',
    description:
      'Sends the drafts to the review queue and notifies approvers. A person approves before anything publishes.',
    input: 'campaignId',
    output: 'reviewIds',
    minSchemaVersion: 1,
    permission: ADMIN,
    integrations: [],
    entitlement: 'release:create',
    retry: 'Up to 4 attempts, 2 minutes each. Review transitions are idempotent.',
    paid: false,
    humanApproval: true,
  },
} as const satisfies Record<AutomationActionType, WorkflowActionSpec>

/** Registered actions in palette order. */
export const workflowActionTypes = automationActionTypeSchema.options

/** Actions whose recorded output another action can consume. */
export function producersOf(type: AutomationActionType): AutomationActionType[] {
  const input = WORKFLOW_ACTIONS[type].input
  return workflowActionTypes.filter((candidate) => WORKFLOW_ACTIONS[candidate].output === input)
}

/** Static facts about the AI relevance check node, shown beside its editor. */
export const WORKFLOW_CLASSIFY = {
  label: 'AI: worth marketing?',
  description:
    'Asks the AI whether this change is worth announcing under your criteria. The true branch needs a "worth marketing" verdict at or above your confidence threshold. Event text is evidence, never instructions.',
  integrations: ['An AI model on the worker', 'AI credits'],
  entitlement: 'release:create',
  retry:
    'Up to 3 attempts, 5 minutes each. The verdict is recorded once; retries and replays reuse it and never charge twice.',
} as const

/**
 * The language version the editor saves. Version 2 holds everything version
 * 1 does with the same meaning, so a re-saved v1 draft behaves the same;
 * it only needs a worker that runs v2, which activation checks. A graph with
 * a newer action saves as that action's version: see graphSchemaVersion.
 */
export const WORKFLOW_SCHEMA_VERSION = 2

/** The language version a graph needs, so only graphs using a newer action need a newer worker. */
export function graphSchemaVersion(graph: Pick<AutomationGraph, 'nodes'>): number {
  return Math.max(
    WORKFLOW_SCHEMA_VERSION,
    ...graph.nodes.map((node) =>
      node.action ? WORKFLOW_ACTIONS[node.action.type].minSchemaVersion : 0
    )
  )
}

/** The repositories Shots is watching now, the only ones a workflow can run for. */
export function connectedSources(overview: Pick<AutomationOverview, 'sources'>) {
  return overview.sources.filter((source) => source.connectionState === 'connected')
}

/** The backend's verdict for an action or AI check, unavailable when unreported. */
export function actionAvailability(
  overview: AutomationOverview,
  type: AutomationActionType | 'classify'
) {
  const reported = overview.actions?.find((action) => action.type === type)
  if (reported) return reported
  return {
    type,
    available: false,
    reason: overview.executorAvailable
      ? 'This backend does not report the capability yet.'
      : 'No workflow worker is running.',
  }
}

/** The graph as the editor saves it. */
export function savedGraph(graph: AutomationGraph): AutomationGraph {
  return { ...graph, schemaVersion: graphSchemaVersion(graph) }
}
