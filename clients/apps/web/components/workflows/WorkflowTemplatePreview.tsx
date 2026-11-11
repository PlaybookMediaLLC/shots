import { ArticleIcon } from '@phosphor-icons/react/dist/ssr/Article'
import { CameraIcon } from '@phosphor-icons/react/dist/ssr/Camera'
import { CodeIcon } from '@phosphor-icons/react/dist/ssr/Code'
import { FlagCheckeredIcon } from '@phosphor-icons/react/dist/ssr/FlagCheckered'
import { FlowArrowIcon } from '@phosphor-icons/react/dist/ssr/FlowArrow'
import { GitBranchIcon } from '@phosphor-icons/react/dist/ssr/GitBranch'
import { GitMergeIcon } from '@phosphor-icons/react/dist/ssr/GitMerge'
import { ImageSquareIcon } from '@phosphor-icons/react/dist/ssr/ImageSquare'
import { LayoutIcon } from '@phosphor-icons/react/dist/ssr/Layout'
import { MegaphoneIcon } from '@phosphor-icons/react/dist/ssr/Megaphone'
import { PackageIcon } from '@phosphor-icons/react/dist/ssr/Package'
import { RocketLaunchIcon } from '@phosphor-icons/react/dist/ssr/RocketLaunch'
import { SparkleIcon } from '@phosphor-icons/react/dist/ssr/Sparkle'
import { TagIcon } from '@phosphor-icons/react/dist/ssr/Tag'
import { UserCheckIcon } from '@phosphor-icons/react/dist/ssr/UserCheck'
import { Fragment, type ComponentType } from 'react'
import type {
  AutomationActionType,
  AutomationFamily,
  AutomationNode,
} from '@/lib/api/contracts/release-automation'
import { cn } from '@/lib/utils'
import {
  buildWorkflowTemplate,
  type WorkflowTemplate,
  type WorkflowTemplateInput,
} from '@/lib/workflows/templates'
import { FAMILY_NAMES } from './workflow-canvas'

/**
 * What sets a template apart, in words: what starts it, its rule, and what you get.
 * Inside a grid that gives it three rows, its rows line up with its neighbors'.
 */
export function WorkflowTemplatePreview({ template }: { template: WorkflowTemplate }) {
  const steps = [
    ['When', FAMILY_NAMES[template.family]],
    ['Rule', template.rule],
    ['You get', template.result],
  ]
  return (
    <dl className="row-span-3 grid w-full grid-rows-subgrid gap-2 text-left text-sm">
      {steps.map(([label, text]) => (
        <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2" key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="font-normal text-foreground">{text}</dd>
        </div>
      ))}
    </dl>
  )
}

/** A made-up draft in the shape a run produces: its channel, its words, and who decides. */
export function WorkflowTemplateSample({ template }: { template: WorkflowTemplate }) {
  return (
    <div className="grid w-full grid-rows-[auto_1fr_auto] gap-1.5 rounded-lg bg-muted/60 p-3 text-left text-sm font-normal">
      <span className="text-xs text-muted-foreground">
        Example draft for {template.sample.channel}
      </span>
      <span className="text-foreground">{template.sample.text}</span>
      <span className="text-xs text-muted-foreground">Waits for a person to approve it</span>
    </div>
  )
}

type StepIcon = ComponentType<{ className?: string }>

const TRIGGER_ICONS: Record<AutomationFamily, StepIcon> = {
  'release.published': PackageIcon,
  'pull_request.merged': GitMergeIcon,
  'deployment.succeeded': RocketLaunchIcon,
  'tag.pushed': TagIcon,
  'milestone.closed': FlagCheckeredIcon,
}

/** Short names, as a diagram tile has room for one or two words. */
const ACTION_STEPS: Record<AutomationActionType, { icon: StepIcon; label: string }> = {
  create_release: { icon: ArticleIcon, label: 'Release' },
  create_campaign: { icon: MegaphoneIcon, label: 'Campaign' },
  generate_copy: { icon: SparkleIcon, label: 'AI copy' },
  capture_product: { icon: CameraIcon, label: 'Capture' },
  render_creatives: { icon: ImageSquareIcon, label: 'Creatives' },
  render_code_visual: { icon: CodeIcon, label: 'Code visual' },
  create_canvas: { icon: LayoutIcon, label: 'Canvas' },
  submit_review: { icon: UserCheckIcon, label: 'Review' },
}

/** The editor canvas's colors: green starts, amber decides, violet is AI; a person ends it. */
const TONES = {
  trigger: 'bg-emerald-500/10 text-emerald-600 ring-emerald-500/25 dark:text-emerald-400',
  rule: 'bg-amber-500/10 text-amber-600 ring-amber-500/25 dark:text-amber-400',
  ai: 'bg-violet-500/10 text-violet-600 ring-violet-500/25 dark:text-violet-300',
  action: 'bg-background text-foreground ring-border',
  review: 'bg-foreground text-background ring-foreground',
}

/** What a workspace starts a template with by default, so a card can draw it before the workspace loads. */
const SAMPLE_INPUT: WorkflowTemplateInput = {
  brandKitId: '',
  destinationIds: [],
  creditLimit: 25,
  branch: 'main',
  aiRelevance: false,
  majorMinorOnly: false,
  renderTemplateIds: [],
  canvas: false,
}

function diagramStep(node: AutomationNode, family: AutomationFamily) {
  if (node.type === 'trigger')
    return { icon: TRIGGER_ICONS[family], label: FAMILY_NAMES[family], tone: TONES.trigger }
  if (node.type === 'condition') return { icon: GitBranchIcon, label: 'Rule', tone: TONES.rule }
  if (node.type === 'classify') return { icon: SparkleIcon, label: 'AI check', tone: TONES.ai }
  if (!node.action) return { icon: FlowArrowIcon, label: 'Action', tone: TONES.action }
  const { type } = node.action
  const tone =
    type === 'generate_copy' ? TONES.ai : type === 'submit_review' ? TONES.review : TONES.action
  return { ...ACTION_STEPS[type], tone }
}

/**
 * A picture of the workflow a template builds: its real steps, from the trigger to the
 * person who approves. Labels show once the picture is wide enough to fit them.
 */
export function WorkflowTemplateDiagram({ template }: { template: WorkflowTemplate }) {
  // A template's nodes come in run order; its end nodes add nothing to the picture.
  const steps = buildWorkflowTemplate(template.id, SAMPLE_INPUT)
    .graph.nodes.filter((node) => node.type !== 'end')
    .map((node) => ({ id: node.id, ...diagramStep(node, template.family) }))
  return (
    <div
      aria-hidden="true"
      className="@container relative flex h-28 items-center overflow-hidden rounded-lg bg-muted/40 px-4 ring-1 ring-border/70 ring-inset"
    >
      <span className="absolute inset-0 bg-[radial-gradient(var(--border)_1px,transparent_1px)] [mask-image:radial-gradient(ellipse_at_center,black_35%,transparent_80%)] bg-size-[12px_12px]" />
      <span className="relative flex w-full items-start">
        {steps.map(({ icon: Icon, id, label, tone }, index) => (
          <Fragment key={id}>
            {index > 0 ? (
              <span
                className="mt-[17.5px] h-px min-w-1.5 flex-1 bg-border transition-colors duration-300 group-hover:bg-emerald-500/70 motion-reduce:transition-none"
                style={{ transitionDelay: `${index * 60}ms` }}
              />
            ) : null}
            <span className="flex w-9 flex-none flex-col items-center gap-1.5 @[24.5rem]:w-15">
              <span
                className={cn(
                  'grid size-9 place-items-center rounded-[10px] shadow-xs ring-1 ring-inset',
                  tone
                )}
              >
                <Icon className="size-4" />
              </span>
              <span className="hidden min-h-[2.5em] w-[4.25rem] text-center text-[11px] leading-tight text-muted-foreground @[24.5rem]:block">
                {label}
              </span>
            </span>
          </Fragment>
        ))}
      </span>
    </div>
  )
}
