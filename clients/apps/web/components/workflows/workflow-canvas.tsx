'use client'

import { CheckIcon as Check } from '@phosphor-icons/react/dist/ssr/Check'
import { StopCircleIcon as CircleStop } from '@phosphor-icons/react/dist/ssr/StopCircle'
import { GitBranchIcon as GitBranch } from '@phosphor-icons/react/dist/ssr/GitBranch'
import { SparkleIcon as Sparkles } from '@phosphor-icons/react/dist/ssr/Sparkle'
import { FlowArrowIcon as Workflow } from '@phosphor-icons/react/dist/ssr/FlowArrow'
import { XIcon as X } from '@phosphor-icons/react/dist/ssr/X'
import { LightningIcon as Zap } from '@phosphor-icons/react/dist/ssr/Lightning'
import { Handle, MarkerType, Position, type Edge, type Node, type NodeProps } from '@xyflow/react'
import type {
  AutomationCondition,
  AutomationFamily,
  AutomationGraph,
  AutomationLayout,
  AutomationNode,
} from '@/lib/api/contracts/release-automation'
import { WORKFLOW_ACTIONS, WORKFLOW_CLASSIFY } from '@/lib/workflows/actions'
import { cn } from '@/lib/utils'

/** Event family names as customers read them. */
export const FAMILY_NAMES: Record<AutomationFamily, string> = {
  'release.published': 'Release published',
  'pull_request.merged': 'Pull request merged',
  'deployment.succeeded': 'Deployment succeeded',
  'tag.pushed': 'Tag pushed',
  'milestone.closed': 'Milestone closed',
}

const nodeIcons = {
  trigger: Zap,
  condition: GitBranch,
  classify: Sparkles,
  action: Workflow,
  end: CircleStop,
}

/** One canvas node's display state, shared by the editor and run inspection. */
export type CanvasNode = Node<{
  label: string
  detail: string
  kind: AutomationNode['type']
  /** On the highlighted path: a preview's prediction or a run's executed path. */
  visited: boolean
  invalid: boolean
}>

/** A compact sentence for a condition or group. */
export function conditionSummary(condition?: AutomationCondition) {
  if (!condition) return 'Choose a condition'
  if (condition.group) return `${condition.group} of ${condition.children?.length ?? 0} conditions`
  return `${condition.field} ${condition.operator?.replaceAll('_', ' ') ?? ''} ${(condition.values ?? []).join(', ')}`.trim()
}

/** The node's title on the canvas and in lists. */
export function nodeLabel(node: AutomationNode, family: AutomationFamily) {
  if (node.type === 'action')
    return node.action ? WORKFLOW_ACTIONS[node.action.type].label : 'Choose an action'
  if (node.type === 'trigger') return FAMILY_NAMES[family]
  if (node.type === 'end')
    return node.outcome === 'skipped' ? 'Skip this event' : 'Workflow complete'
  if (node.type === 'classify') return WORKFLOW_CLASSIFY.label
  return 'If / then / else'
}

/** The node's one-line detail under its title. */
export function nodeDetail(node: AutomationNode, sourceName?: string) {
  if (node.type === 'condition') return conditionSummary(node.condition)
  if (node.type === 'classify')
    return `Confidence ≥ ${node.classify?.threshold ?? 0} · up to ${node.classify?.creditLimit ?? 0} credits`
  if (node.type === 'trigger') return sourceName ?? 'Connected repository'
  if (node.type === 'end')
    return node.outcome === 'skipped' ? 'No further actions' : 'End of this path'
  switch (node.action?.type) {
    case 'create_campaign':
      return `${node.action.destinationIds?.length ?? 0} draft destinations`
    case 'generate_copy':
      return `AI copy · up to ${node.action.creditLimit ?? 0} credits`
    case 'capture_product':
      if (node.action.recipeId) {
        return node.action.currentState
          ? 'Signed-in screen, current state only'
          : 'Signed-in screen, after the app reports this commit'
      }
      return node.action.currentState
        ? 'Current state, without version proof'
        : 'After the app reports this commit'
    case 'render_creatives':
      return `${node.action.templateIds?.length ?? 0} templates from the product capture`
    case 'create_canvas':
      return `${node.action.recipeIds?.length ?? 0} canvas templates from the release`
    case 'render_code_visual':
      return node.action.readSourceCode
        ? 'Code visual from the merged pull request'
        : 'Needs consent to read the pull request’s code'
    case 'submit_review':
      return 'A person approves before publishing'
    case 'create_release':
      return node.action.include === 'unreleased'
        ? 'Event plus every unreleased merged PR'
        : 'From the GitHub event'
  }
  return 'From the GitHub event'
}

function WorkflowNode({ data, selected }: NodeProps<CanvasNode>) {
  const Icon = nodeIcons[data.kind]
  return (
    <div
      className={cn(
        'w-64 rounded-xl border bg-card text-card-foreground shadow-sm transition-[border-color,box-shadow] motion-reduce:transition-none',
        selected ? 'border-emerald-500 ring-4 ring-emerald-500/15' : 'border-border',
        data.visited && 'border-emerald-500/70',
        data.invalid && 'border-destructive'
      )}
    >
      {data.kind !== 'trigger' ? (
        <Handle
          type="target"
          position={Position.Top}
          className="!size-2.5 !border-2 !border-card !bg-muted-foreground"
          aria-label="Incoming connection"
        />
      ) : null}
      <div className="flex items-center gap-3 p-3">
        <span
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted',
            data.kind === 'condition' && 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
            data.kind === 'classify' && 'bg-violet-500/10 text-violet-600 dark:text-violet-300',
            data.kind === 'trigger' && 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
          )}
        >
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-ui-lg font-semibold leading-5">{data.label}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={data.detail}>
            {data.detail}
          </p>
        </div>
        {data.invalid ? (
          <X className="size-3.5 shrink-0 text-destructive" aria-label="Needs attention" />
        ) : data.visited ? (
          <Check className="size-3.5 shrink-0 text-emerald-500" aria-label="On preview path" />
        ) : null}
      </div>
      {data.kind === 'condition' || data.kind === 'classify' ? (
        <div className="relative grid grid-cols-2 border-t border-border text-center text-[10px] font-medium">
          <span className="border-r border-border py-1.5 text-emerald-600 dark:text-emerald-400">
            TRUE · Continue
          </span>
          <span className="py-1.5 text-amber-600 dark:text-amber-400">FALSE · Otherwise</span>
          <Handle
            type="source"
            id="true"
            position={Position.Bottom}
            className="!size-2.5 !border-2 !border-card !bg-emerald-500"
            style={{ left: '25%' }}
            aria-label="True branch"
          />
          <Handle
            type="source"
            id="false"
            position={Position.Bottom}
            className="!size-2.5 !border-2 !border-card !bg-amber-500"
            style={{ left: '75%' }}
            aria-label="False branch"
          />
        </div>
      ) : data.kind !== 'end' ? (
        <Handle
          type="source"
          id="next"
          position={Position.Bottom}
          className="!size-2.5 !border-2 !border-card !bg-muted-foreground"
          aria-label="Next step"
        />
      ) : null}
    </div>
  )
}

/** React Flow node renderers for workflow graphs. */
export const workflowNodeTypes = { workflow: WorkflowNode }

/** Canvas nodes for a graph, marking a highlighted path and nodes with problems. */
export function canvasNodes(
  graph: AutomationGraph,
  layout: AutomationLayout,
  options: { selected?: string; path: Set<string>; invalid: Set<string>; sourceName?: string }
): CanvasNode[] {
  return graph.nodes.map((node, index) => ({
    id: node.id,
    type: 'workflow',
    selected: node.id === options.selected,
    position: layout[node.id] ?? { x: 40, y: index * 150 },
    data: {
      kind: node.type,
      label: nodeLabel(node, graph.family),
      detail: nodeDetail(node, options.sourceName),
      visited: options.path.has(node.id),
      invalid: options.invalid.has(node.id),
    },
    ariaLabel: `${node.id}: ${node.type}`,
  }))
}

/** Canvas edges; a highlighted path dims every edge it did not take. */
export function canvasEdges(graph: AutomationGraph, path: string[] | null): Edge[] {
  return graph.edges.map((edge) => {
    const onPath = path?.some((id, index) => id === edge.from && path[index + 1] === edge.to)
    const color =
      edge.branch === 'false' ? '#d99a38' : onPath || edge.branch === 'true' ? '#2caa83' : '#7c8793'
    return {
      id: `${edge.from}:${edge.branch}:${edge.to}`,
      source: edge.from,
      target: edge.to,
      sourceHandle: edge.branch,
      type: 'smoothstep',
      label: edge.branch === 'next' ? undefined : edge.branch === 'true' ? 'True' : 'False',
      style: {
        stroke: color,
        strokeWidth: onPath ? 2.5 : 1.5,
        opacity: path && !onPath ? 0.25 : 1,
      },
      markerEnd: { type: MarkerType.ArrowClosed, color },
      labelStyle: { fill: color, fontSize: 11, fontWeight: 600 },
      labelBgStyle: { fill: 'var(--card)' },
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 4,
    }
  })
}
