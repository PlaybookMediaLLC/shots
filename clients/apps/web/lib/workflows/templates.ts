import { z } from 'zod'
import {
  automationFamilySchema,
  type AutomationCondition,
  type AutomationGraph,
  type AutomationLayout,
  type AutomationNode,
  type AutomationOverview,
} from '@/lib/api/contracts/release-automation'
import { actionAvailability, connectedSources, graphSchemaVersion } from './actions'

/** Templates that open as editable, executable definitions. */
export const workflowTemplateIdSchema = z.enum([
  'release-launch',
  'tag-launch',
  'milestone-release',
  'feature-announcement',
  'deployment-marketing',
])

/** One template identifier. */
export type WorkflowTemplateId = z.infer<typeof workflowTemplateIdSchema>

/** What a template needs from the workspace before it can be saved. */
export const workflowTemplateInputSchema = z.strictObject({
  brandKitId: z.string().max(64),
  destinationIds: z.array(z.string().max(64)).max(10),
  /** Adds paid AI copy generation with this credit budget; 0 leaves it out. */
  creditLimit: z.number().int().min(0).max(500),
  /** The pull-request base branch a feature announcement requires. */
  branch: z.string().max(255),
  /** Replaces the rule-based gate with an AI "worth marketing?" check. */
  aiRelevance: z.boolean(),
  /** Version-based templates announce only major and minor versions. */
  majorMinorOnly: z.boolean(),
  /** Renders these design templates from the latest capture; empty leaves it out. */
  renderTemplateIds: z.array(z.string().max(64)).max(3),
  /** Lays out a canvas from the release for the team to refine. */
  canvas: z.boolean(),
  /** A deployment template captures this page before rendering, so creatives show this deployment. */
  capture: z
    .strictObject({
      surfaceId: z.string().max(64),
      /** The path that reports the deployed commit; without it the draft asks for a choice. */
      versionPath: z.string().max(256).optional(),
    })
    .optional(),
})

/** Template parameters chosen in the template picker. */
export type WorkflowTemplateInput = z.infer<typeof workflowTemplateInputSchema>

/** Display facts for one template. */
export const workflowTemplateSchema = z.strictObject({
  id: workflowTemplateIdSchema,
  family: automationFamilySchema,
  name: z.string(),
  description: z.string(),
  /** The rule the template starts with, in plain words. */
  rule: z.string(),
  /** What a matching event produces. */
  result: z.string(),
  /** A made-up draft, to show what the output reads like and where it goes. */
  sample: z.strictObject({ channel: z.string(), text: z.string() }),
  /** Whether the version-level option applies. */
  versioned: z.boolean(),
})

/** One template's display facts. */
export type WorkflowTemplate = z.infer<typeof workflowTemplateSchema>

/** The executable templates, in the same order as the event lists (`automationFamilySchema`). */
export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'release-launch',
    family: 'release.published',
    name: 'Product launch from a GitHub release',
    description:
      'When a stable GitHub Release is published, create a release and campaign drafts and send them for review.',
    rule: 'Skips pre-releases and patch versions.',
    result: 'A release and a draft post for each channel, sent to a person for review.',
    sample: {
      channel: 'LinkedIn',
      text: 'Acme 2.4 is out. Scheduled exports and a faster editor are ready for your team today.',
    },
    versioned: true,
  },
  {
    id: 'feature-announcement',
    family: 'pull_request.merged',
    name: 'Feature announcement from a merged pull request',
    description:
      'When a human-authored pull request merges into your branch and is worth announcing, by label rules or an AI check, announce it.',
    rule: 'Skips bots. Needs the label feature, marketing or release, or a title starting with feat.',
    result: 'An announcement and a draft post for each channel, sent to a person for review.',
    sample: {
      channel: 'X',
      text: 'New in Acme: scheduled exports. Pick a time, and your report lands in your inbox.',
    },
    versioned: false,
  },
  {
    id: 'deployment-marketing',
    family: 'deployment.succeeded',
    name: 'Deployment-driven marketing',
    description:
      'When a production deployment succeeds, draft a campaign for review. Production capture of your product pages still runs for every production deployment.',
    rule: 'Only production deployments.',
    result: 'A campaign with a draft post for each channel, sent to a person for review.',
    sample: {
      channel: 'LinkedIn',
      text: 'Now live in Acme: a faster editor, rolling out to every workspace today.',
    },
    versioned: false,
  },
  {
    id: 'tag-launch',
    family: 'tag.pushed',
    name: 'Launch from a version tag',
    description:
      'For teams that tag without GitHub Releases: a new version tag becomes a release of every PR merged since the last one.',
    rule: 'Only tags starting with v. Skips pre-releases and patch versions.',
    result: 'A release of every PR merged since the last one, with draft posts for review.',
    sample: {
      channel: 'X',
      text: 'Acme 2.4 ships 12 improvements, led by scheduled exports and a faster editor.',
    },
    versioned: true,
  },
  {
    id: 'milestone-release',
    family: 'milestone.closed',
    name: 'Release a closed milestone',
    description:
      'When a milestone closes with nothing left open, its assigned pull requests become one release and campaign.',
    rule: 'Only when nothing in the milestone is still open.',
    result: 'One release of its pull requests, with draft posts for review.',
    sample: {
      channel: 'LinkedIn',
      text: 'Our reporting milestone is done: scheduled exports, shared dashboards and CSV imports.',
    },
    versioned: false,
  },
]

/** What a template starts with in this workspace; its Setup tab in the editor changes these. */
export function defaultTemplateInput(
  template: WorkflowTemplate,
  overview: AutomationOverview
): WorkflowTemplateInput {
  return {
    brandKitId: overview.brands[0]?.id ?? '',
    destinationIds: overview.destinations[0] ? [overview.destinations[0].id] : [],
    creditLimit: actionAvailability(overview, 'generate_copy').available ? 25 : 0,
    branch: connectedSources(overview)[0]?.branch || 'main',
    aiRelevance: false,
    majorMinorOnly: template.versioned,
    renderTemplateIds: [],
    canvas: false,
  }
}

/** The criteria an AI relevance check starts with. */
export const DEFAULT_RELEVANCE_CRITERIA =
  'Customer-visible features, improvements, or fixes a user would notice. Not refactors, dependency bumps, tests, or CI.'

const majorMinor: AutomationCondition = {
  field: 'version.level',
  operator: 'in',
  values: ['major', 'minor'],
}

function gates(id: WorkflowTemplateId, input: WorkflowTemplateInput) {
  const qualification: Record<WorkflowTemplateId, AutomationCondition> = {
    'release-launch': input.majorMinorOnly
      ? {
          group: 'ALL',
          children: [{ field: 'release.tag', operator: 'glob', values: ['v*'] }, majorMinor],
        }
      : { field: 'release.tag', operator: 'glob', values: ['v*'] },
    'tag-launch': input.majorMinorOnly
      ? {
          group: 'ALL',
          children: [{ field: 'tag.name', operator: 'glob', values: ['v*'] }, majorMinor],
        }
      : { field: 'tag.name', operator: 'glob', values: ['v*'] },
    'milestone-release': { field: 'milestone.closed_items', operator: 'gte', values: ['1'] },
    'feature-announcement': {
      group: 'ALL',
      children: [
        { field: 'pr.base', operator: 'eq', values: [input.branch || 'main'] },
        { field: 'pr.bot', operator: 'is_false' },
      ],
    },
    'deployment-marketing': {
      field: 'deployment.environment',
      operator: 'eq',
      values: ['production'],
    },
  }
  const condition: Record<WorkflowTemplateId, AutomationCondition> = {
    'release-launch': { field: 'release.prerelease', operator: 'is_false' },
    'tag-launch': { field: 'version.level', operator: 'ne', values: ['prerelease'] },
    'milestone-release': { field: 'milestone.open_items', operator: 'eq', values: ['0'] },
    'feature-announcement': {
      group: 'ANY',
      children: [
        { field: 'pr.labels', operator: 'in', values: ['feature', 'marketing', 'release'] },
        { field: 'pr.title', operator: 'starts_with', values: ['feat'] },
      ],
    },
    'deployment-marketing': { field: 'deployment.production', operator: 'is_true' },
  }
  return { qualification: qualification[id], condition: condition[id] }
}

/**
 * Builds a template's graph and canvas layout. The graph is an ordinary
 * draft: every condition and action stays editable before activation, and
 * the Go validator remains the authority on whether it can run.
 */
export function buildWorkflowTemplate(
  id: WorkflowTemplateId,
  input: WorkflowTemplateInput
): { graph: AutomationGraph; layout: AutomationLayout } {
  const template = WORKFLOW_TEMPLATES.find((candidate) => candidate.id === id)
  if (!template) throw new Error(`Unknown workflow template ${id}`)
  const { qualification, condition } = gates(id, input)
  const gate: AutomationNode = input.aiRelevance
    ? {
        id: 'condition',
        type: 'classify',
        classify: { criteria: DEFAULT_RELEVANCE_CRITERIA, threshold: 0.7, creditLimit: 5 },
      }
    : { id: 'condition', type: 'condition', condition }
  const steps: AutomationNode[] = [
    {
      id: 'release',
      type: 'action',
      action: {
        type: 'create_release',
        ...(id === 'tag-launch' ? { include: 'unreleased' as const } : {}),
      },
    },
    {
      id: 'campaign',
      type: 'action',
      action: {
        type: 'create_campaign',
        input: { nodeId: 'release', output: 'releaseId' },
        brandKitId: input.brandKitId,
        destinationIds: input.destinationIds,
      },
    },
  ]
  const after = () => steps.at(-1)?.id ?? 'campaign'
  if (input.capture && template.family === 'deployment.succeeded') {
    steps.push({
      id: 'capture',
      type: 'action',
      action: {
        type: 'capture_product',
        input: { nodeId: after(), output: 'campaignId' },
        surfaceId: input.capture.surfaceId,
        ...(input.capture.versionPath ? { versionPath: input.capture.versionPath } : {}),
      },
    })
  }
  if (input.creditLimit > 0) {
    steps.push({
      id: 'copy',
      type: 'action',
      action: {
        type: 'generate_copy',
        input: { nodeId: after(), output: 'campaignId' },
        creditLimit: input.creditLimit,
      },
    })
  }
  if (input.renderTemplateIds.length > 0) {
    steps.push({
      id: 'art',
      type: 'action',
      action: {
        type: 'render_creatives',
        input: { nodeId: after(), output: 'campaignId' },
        templateIds: input.renderTemplateIds,
      },
    })
  }
  const campaign = after()
  if (input.canvas) {
    steps.push({
      id: 'board',
      type: 'action',
      action: {
        type: 'create_canvas',
        input: { nodeId: campaign, output: 'campaignId' },
        recipeIds: ['feature-announcement', 'social-pack'],
      },
    })
  }
  steps.push({
    id: 'review',
    type: 'action',
    action: { type: 'submit_review', input: { nodeId: campaign, output: 'campaignId' } },
  })
  const nodes: AutomationNode[] = [
    { id: 'trigger', type: 'trigger' },
    gate,
    ...steps,
    { id: 'done', type: 'end', outcome: 'completed' },
    { id: 'skip', type: 'end', outcome: 'skipped' },
  ]
  const chain = ['trigger', 'condition', ...steps.map((step) => step.id), 'done']
  const edges = chain.slice(1).map((to, index) => ({
    from: chain[index] ?? 'trigger',
    to,
    branch: to === 'release' ? 'true' : 'next',
  }))
  edges.splice(2, 0, { from: 'condition', to: 'skip', branch: 'false' })
  const layout: AutomationLayout = { skip: { x: 340, y: 230 } }
  chain.forEach((nodeId, index) => {
    layout[nodeId] = { x: 0, y: index * 115 }
  })
  return {
    graph: {
      schemaVersion: graphSchemaVersion({ nodes }),
      family: template.family,
      qualification,
      nodes,
      edges,
    },
    layout,
  }
}
