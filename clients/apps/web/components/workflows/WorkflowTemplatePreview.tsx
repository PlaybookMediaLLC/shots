import { FAMILY_NAMES } from './workflow-canvas'
import type { WorkflowTemplate } from '@/lib/workflows/templates'

/** What sets a template apart, in words: what starts it, its rule, and what you get. */
export function WorkflowTemplatePreview({ template }: { template: WorkflowTemplate }) {
  const steps = [
    ['When', FAMILY_NAMES[template.family]],
    ['Rule', template.rule],
    ['You get', template.result],
  ]
  return (
    <dl className="grid w-full gap-2 text-left text-sm">
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
    <div className="grid w-full gap-1.5 rounded-lg bg-muted/60 p-3 text-left text-sm font-normal">
      <span className="text-xs text-muted-foreground">
        Example draft for {template.sample.channel}
      </span>
      <span className="text-foreground">{template.sample.text}</span>
      <span className="text-xs text-muted-foreground">Waits for a person to approve it</span>
    </div>
  )
}
