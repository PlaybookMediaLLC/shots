'use client'

import { ArrowRightIcon } from '@phosphor-icons/react/dist/ssr/ArrowRight'
import { PlusIcon } from '@phosphor-icons/react/dist/ssr/Plus'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useState } from 'react'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { Page, Section } from '@/components/platform-ui'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { GitHubSetup, useGitHubConnections } from '@/components/workspace/GitHubConnections'
import { getErrorMessage } from '@/components/workspace/settings-client'
import {
  automationFamilySchema,
  type AutomationDefinition,
  type AutomationFamily,
  type AutomationOverview,
} from '@/lib/api/contracts/release-automation'
import { useTRPC } from '@/lib/trpc/react'
import { connectedSources, WORKFLOW_SCHEMA_VERSION } from '@/lib/workflows/actions'
import {
  buildWorkflowTemplate,
  defaultTemplateInput,
  WORKFLOW_TEMPLATES,
  type WorkflowTemplate,
} from '@/lib/workflows/templates'
import { AutomateBreadcrumb } from './workflow-ui'
import { WorkflowEditor } from './WorkflowEditor'
import {
  WorkflowTemplateDiagram,
  WorkflowTemplatePreview,
  WorkflowTemplateSample,
} from './WorkflowTemplatePreview'
import { FAMILY_NAMES } from './workflow-canvas'

/** A workflow the editor holds until it is saved, so a look at a template leaves nothing behind. */
function newDefinition(
  sourceAppId: string,
  fields: Pick<AutomationDefinition, 'description' | 'draft' | 'layout' | 'name'>
): AutomationDefinition {
  return {
    ...fields,
    activePriority: 0,
    activeVersionId: null,
    enabled: false,
    id: '',
    issues: [],
    modifiedBy: '',
    priority: 100,
    revision: 0,
    sourceAppId,
    updatedAt: '',
  }
}

/** Keeps brand kits and repositories current when someone returns from another tab. */
function useAutomationOverview(enabled = true) {
  const trpc = useTRPC()
  return useQuery(
    trpc.releaseAutomation.overview.queryOptions(undefined, {
      enabled,
      refetchOnWindowFocus: true,
    })
  )
}

/** Pick a template, which opens as an editable draft; the address keeps the choice. */
export function WorkflowTemplates() {
  const params = useSearchParams()
  const template = WORKFLOW_TEMPLATES.find((candidate) => candidate.id === params.get('template'))
  return template ? <TemplateStart key={template.id} template={template} /> : <TemplatePicker />
}

/** Ask for only what is missing, on this page, then open the editor. */
function TemplateStart({ template }: { template: WorkflowTemplate }) {
  const overview = useAutomationOverview()
  const github = useGitHubConnections()
  if (overview.data && connectedSources(overview.data).length > 0)
    return <TemplateDraft overview={overview.data} template={template} />
  const hasConnection = github.data?.connections.some(({ status }) => status === 'ACTIVE')
  return (
    <Page
      description={
        !overview.data || !github.data
          ? undefined
          : !github.data.configured
            ? 'This template needs a watched repository.'
            : hasConnection
              ? 'Watch a repository to use this template.'
              : 'Connect GitHub to use this template. Then choose a repository to watch.'
      }
      title={template.name}
      width="md"
    >
      <AutomateBreadcrumb
        current={template.name}
        trail={[
          { href: '/workflows', label: 'Workflows' },
          { href: '/workflows/new', label: 'New' },
        ]}
      />
      {overview.error ? (
        <Alert variant="destructive">
          <AlertDescription>{getErrorMessage(overview.error)}</AlertDescription>
        </Alert>
      ) : overview.data ? (
        <GitHubSetup returnTo={`/workflows/new?template=${template.id}`} />
      ) : (
        <Skeleton aria-label="Loading" className="h-24 w-full rounded-xl" role="status" />
      )}
    </Page>
  )
}

function TemplateDraft({
  overview,
  template,
}: {
  overview: AutomationOverview
  template: WorkflowTemplate
}) {
  const router = useRouter()
  const [definition] = useState(() => {
    const { graph, layout } = buildWorkflowTemplate(
      template.id,
      defaultTemplateInput(template, overview)
    )
    return newDefinition(connectedSources(overview)[0]?.id ?? '', {
      description: template.description,
      draft: graph,
      layout,
      name: template.name,
    })
  })
  return (
    <WorkflowEditor
      definition={definition}
      history={[]}
      onClose={() => router.push('/workflows/new')}
      onSaved={(saved) => router.replace(`/workflows/${saved.id}`)}
      overview={overview}
      presentation="page"
      template={template}
    />
  )
}

function TemplatePicker() {
  const router = useRouter()
  const [blank, setBlank] = useState(false)
  const [blankDraft, setBlankDraft] = useState<{
    definition: AutomationDefinition
    overview: AutomationOverview
  } | null>(null)
  if (blankDraft)
    return (
      <WorkflowEditor
        definition={blankDraft.definition}
        history={[]}
        onClose={() => setBlankDraft(null)}
        onSaved={(saved) => router.replace(`/workflows/${saved.id}`)}
        overview={blankDraft.overview}
        presentation="page"
      />
    )
  return (
    <Page description="Turn shipped code into ready-to-review campaigns." title="New workflow">
      <AutomateBreadcrumb current="New" trail={[{ href: '/workflows', label: 'Workflows' }]} />
      <Section
        description="Each one opens as a draft you can edit. Nothing runs until you activate it."
        title="Choose a template"
      >
        {/* Each card spans seven shared rows (picture, name, When, Rule, You get, sample, action), so they line up across a row. */}
        <ul className="grid gap-4 lg:grid-cols-2" data-tour-id="automate-templates">
          {WORKFLOW_TEMPLATES.map((candidate) => (
            <li className="row-span-7 grid grid-rows-subgrid" key={candidate.id}>
              <ButtonLink
                aria-describedby={`template-${candidate.id}`}
                aria-labelledby={`template-${candidate.id}-name`}
                className="group row-span-7 grid grid-cols-[minmax(0,1fr)] grid-rows-subgrid gap-3 rounded-xl border border-border bg-card p-4 text-left transition-[border-color,box-shadow] duration-200 hover:border-foreground/20 hover:shadow-[0_6px_20px_-12px_rgb(0_0_0/0.25)] motion-reduce:transition-none"
                href={`/workflows/new?template=${candidate.id}`}
                size={null}
                variant="custom"
              >
                <WorkflowTemplateDiagram template={candidate} />
                <span
                  className="mt-1 text-ui-lg font-medium text-pretty text-foreground"
                  id={`template-${candidate.id}-name`}
                >
                  {candidate.name}
                </span>
                <div className="row-span-4 grid grid-rows-subgrid" id={`template-${candidate.id}`}>
                  <WorkflowTemplatePreview template={candidate} />
                  <WorkflowTemplateSample template={candidate} />
                </div>
                <span
                  aria-hidden="true"
                  className="flex items-center gap-1.5 pt-1 text-sm font-medium text-foreground"
                >
                  Use this template
                  <ArrowRightIcon className="size-4 transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none" />
                </span>
              </ButtonLink>
            </li>
          ))}
          <li className="row-span-7 grid">
            <Button
              aria-describedby="template-blank"
              aria-labelledby="template-blank-name"
              className="group flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-foreground/20 p-5 text-center text-sm text-muted-foreground transition-colors hover:border-foreground/40 hover:bg-muted/40 hover:text-foreground"
              onClick={() => setBlank(true)}
              size={null}
              type="button"
              variant="custom"
            >
              <span className="mb-1 grid size-9 place-items-center rounded-[10px] bg-background text-foreground shadow-xs ring-1 ring-border ring-inset transition-transform duration-200 group-hover:scale-105 motion-reduce:transition-none">
                <PlusIcon aria-hidden="true" className="size-4" />
              </span>
              <span className="text-ui-lg font-medium text-foreground" id="template-blank-name">
                Start with a blank workflow
              </span>
              <span id="template-blank">Choose a trigger, then build each step yourself.</span>
            </Button>
          </li>
        </ul>
      </Section>
      <p className="text-sm text-muted-foreground">
        Rather write the posts yourself?{' '}
        <Link className="text-foreground underline underline-offset-4" href="/campaigns/new">
          Build a campaign by hand
        </Link>
      </p>
      <BlankWorkflowDialog onOpenChange={setBlank} onStart={setBlankDraft} open={blank} />
    </Page>
  )
}

function BlankWorkflowDialog({
  onOpenChange,
  onStart,
  open,
}: {
  onOpenChange: (open: boolean) => void
  onStart: (draft: { definition: AutomationDefinition; overview: AutomationOverview }) => void
  open: boolean
}) {
  const overview = useAutomationOverview(open)
  const sources = overview.data ? connectedSources(overview.data) : []
  const [chosen, setChosen] = useState('')
  const [family, setFamily] = useState<AutomationFamily>('release.published')
  const sourceId = chosen || (sources[0]?.id ?? '')
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="platform-overlay max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Blank workflow</DialogTitle>
          <DialogDescription>
            {overview.data && sources.length === 0
              ? 'A workflow runs for one repository. Watch one to start.'
              : 'Choose a trigger, then build the steps. Nothing is saved until you save the draft.'}
          </DialogDescription>
        </DialogHeader>
        {overview.error ? (
          <Alert variant="destructive">
            <AlertDescription>{getErrorMessage(overview.error)}</AlertDescription>
          </Alert>
        ) : !overview.data ? (
          <Skeleton aria-label="Loading" className="h-24 w-full rounded-xl" role="status" />
        ) : sources.length === 0 ? (
          <GitHubSetup returnTo="/workflows/new" />
        ) : (
          <div className="grid gap-4">
            <Label className="grid gap-2">
              Repository
              <Select onValueChange={setChosen} value={sourceId}>
                <SelectTrigger aria-label="Blank workflow repository" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {sources.map((source) => (
                    <SelectItem key={source.id} value={source.id}>
                      {source.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Label>
            <Label className="grid gap-2">
              Event
              <Select
                onValueChange={(value) => setFamily(automationFamilySchema.parse(value))}
                value={family}
              >
                <SelectTrigger aria-label="Blank workflow event" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {automationFamilySchema.options.map((option) => (
                    <SelectItem key={option} value={option}>
                      {FAMILY_NAMES[option]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Label>
          </div>
        )}
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={!sourceId || !overview.data}
            onClick={() =>
              overview.data &&
              onStart({
                definition: newDefinition(sourceId, {
                  description: '',
                  draft: {
                    edges: [{ branch: 'next', from: 'trigger', to: 'end' }],
                    family,
                    nodes: [
                      { id: 'trigger', type: 'trigger' },
                      { id: 'end', outcome: 'completed', type: 'end' },
                    ],
                    qualification: { field: 'event.family', operator: 'eq', values: [family] },
                    schemaVersion: WORKFLOW_SCHEMA_VERSION,
                  },
                  layout: { end: { x: 100, y: 220 }, trigger: { x: 100, y: 50 } },
                  name: 'Untitled workflow',
                }),
                overview: overview.data,
              })
            }
            type="button"
          >
            Open blank draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
