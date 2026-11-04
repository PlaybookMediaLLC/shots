'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { Group, Page, Pill, Row, Section } from '@/components/platform-ui'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { DesignTemplatePreview } from '@/components/design/DesignTemplatePreview'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { getErrorMessage } from '@/components/workspace/settings-client'
import {
  automationFamilySchema,
  type AutomationDefinition,
  type AutomationFamily,
  type AutomationOverview,
} from '@/lib/api/contracts/release-automation'
import { useTRPCClient } from '@/lib/trpc/react'
import { actionAvailability } from '@/lib/workflows/actions'
import {
  buildWorkflowTemplate,
  WORKFLOW_TEMPLATES,
  type WorkflowTemplateId,
} from '@/lib/workflows/templates'

import { WorkflowEditor } from './WorkflowEditor'
import { WorkflowTemplatePreview } from './WorkflowTemplatePreview'
import { FAMILY_NAMES } from './workflow-canvas'
import { WORKFLOW_SCHEMA_VERSION } from '@/lib/workflows/actions'

const EMPTY = '__empty_option__'

/** Pick an executable template, fill in workspace resources, and open it as a draft. */
export function WorkflowTemplates() {
  const client = useTRPCClient()
  const router = useRouter()
  const [blank, setBlank] = useState(false)
  const [blankFamily, setBlankFamily] = useState<AutomationFamily>('release.published')
  const [blankDefinition, setBlankDefinition] = useState<AutomationDefinition | null>(null)
  const [overview, setOverview] = useState<AutomationOverview | null>(null)
  const [templateId, setTemplateId] = useState<WorkflowTemplateId | null>(null)
  const [sourceId, setSourceId] = useState('')
  const [name, setName] = useState('')
  const [brandKitId, setBrandKitId] = useState('')
  const [destinationIds, setDestinationIds] = useState<string[]>([])
  const [branch, setBranch] = useState('main')
  const [generate, setGenerate] = useState(false)
  const [creditLimit, setCreditLimit] = useState(25)
  const [aiRelevance, setAIRelevance] = useState(false)
  const [majorMinorOnly, setMajorMinorOnly] = useState(true)
  const [renderTemplateIds, setRenderTemplateIds] = useState<string[]>([])
  const [canvas, setCanvas] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    client.releaseAutomation.overview
      .query()
      .then((next) => {
        setOverview(next)
        setBrandKitId(next.brands[0]?.id ?? '')
        setDestinationIds(next.destinations[0] ? [next.destinations[0].id] : [])
        setGenerate(actionAvailability(next, 'generate_copy').available)
        const source = next.sources.find((item) => item.connectionState === 'connected')
        setSourceId(source?.id ?? '')
        setBranch(source?.branch || 'main')
      })
      .catch((failure) => setError(getErrorMessage(failure)))
  }, [client])

  useEffect(() => {
    const refresh = () => {
      void client.releaseAutomation.overview
        .query()
        .then(setOverview)
        .catch((failure) => setError(getErrorMessage(failure)))
    }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [client])

  if (!overview) {
    return (
      <Page title="New workflow">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : (
          <p className="text-sm text-muted-foreground" role="status">
            Loading templates…
          </p>
        )}
      </Page>
    )
  }

  const sources = overview.sources.filter((source) => source.connectionState === 'connected')
  const template = WORKFLOW_TEMPLATES.find((candidate) => candidate.id === templateId)
  const generation = actionAvailability(overview, 'generate_copy')
  const relevance = actionAvailability(overview, 'classify')
  const rendering = actionAvailability(overview, 'render_creatives')
  const canvases = actionAvailability(overview, 'create_canvas')

  async function create() {
    if (!template) return
    setBusy(true)
    setError(null)
    try {
      const { graph, layout } = buildWorkflowTemplate(template.id, {
        brandKitId,
        destinationIds,
        creditLimit: generate ? creditLimit : 0,
        branch: branch.trim() || 'main',
        aiRelevance,
        majorMinorOnly: template.versioned && majorMinorOnly,
        renderTemplateIds: rendering.available ? renderTemplateIds : [],
        canvas: canvases.available && canvas,
      })
      const saved = await client.releaseAutomation.save.mutate({
        id: '',
        sourceAppId: sourceId,
        name: name.trim() || template.name,
        description: template.description,
        priority: 100,
        expectedRevision: 0,
        graph,
        layout,
      })
      router.push(`/workflows/${saved.id}`)
    } catch (failure) {
      setError(getErrorMessage(failure))
      setBusy(false)
    }
  }

  if (blankDefinition)
    return (
      <WorkflowEditor
        presentation="page"
        definition={blankDefinition}
        overview={overview}
        history={[]}
        onClose={() => setBlankDefinition(null)}
        onSaved={(saved) => router.replace(`/workflows/${saved.id}`)}
      />
    )

  return (
    <Page
      title="New workflow"
      description="Start from a template that runs today. Every step stays editable before you activate it."
      width="md"
    >
      <ButtonLink className="self-start" href="/workflows" variant="outline">
        Back to workflows
      </ButtonLink>
      {blank ? (
        <Section
          title="Blank workflow"
          description="Choose a trigger, then build the steps. Nothing is saved until you save the draft."
        >
          <Label className="grid gap-2">
            Repository
            <Select
              value={sourceId || EMPTY}
              onValueChange={(value) => setSourceId(value === EMPTY ? '' : value)}
            >
              <SelectTrigger aria-label="Blank workflow repository">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={EMPTY}>Choose a repository</SelectItem>
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
              value={blankFamily}
              onValueChange={(value) => setBlankFamily(value as AutomationFamily)}
            >
              <SelectTrigger aria-label="Blank workflow event">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {automationFamilySchema.options.map((family) => (
                  <SelectItem key={family} value={family}>
                    {FAMILY_NAMES[family]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Label>
          <Button
            disabled={!sourceId}
            onClick={() =>
              setBlankDefinition({
                id: '',
                sourceAppId: sourceId,
                name: 'Untitled workflow',
                description: '',
                priority: 100,
                revision: 0,
                enabled: false,
                activeVersionId: null,
                activePriority: 0,
                modifiedBy: '',
                updatedAt: '',
                issues: [],
                layout: { trigger: { x: 100, y: 50 }, end: { x: 100, y: 220 } },
                draft: {
                  schemaVersion: WORKFLOW_SCHEMA_VERSION,
                  family: blankFamily,
                  qualification: { field: 'event.family', operator: 'eq', values: [blankFamily] },
                  nodes: [
                    { id: 'trigger', type: 'trigger' },
                    { id: 'end', type: 'end', outcome: 'completed' },
                  ],
                  edges: [{ from: 'trigger', to: 'end', branch: 'next' }],
                },
              })
            }
          >
            Open blank draft
          </Button>
        </Section>
      ) : null}
      <Section
        description="Each template is a normal, editable workflow."
        title="Choose a template"
      >
        <ul className="grid gap-4 md:grid-cols-2">
          <li className="md:col-span-2">
            <Button
              variant="outline"
              onClick={() => {
                setBlank(true)
                setTemplateId(null)
              }}
            >
              Start with a blank workflow
            </Button>
          </li>
          {WORKFLOW_TEMPLATES.map((candidate) => (
            <li key={candidate.id}>
              <Button
                aria-pressed={candidate.id === templateId}
                className="flex h-auto w-full flex-col items-start gap-2 rounded-xl p-5 text-left whitespace-normal aria-pressed:ring-2 aria-pressed:ring-emerald-500/60"
                onClick={() => {
                  setBlank(false)
                  setTemplateId(candidate.id)
                  setName(candidate.name)
                }}
                type="button"
                variant="outline"
              >
                <WorkflowTemplatePreview
                  name={candidate.name}
                  {...buildWorkflowTemplate(candidate.id, {
                    brandKitId,
                    destinationIds,
                    creditLimit: generate ? creditLimit : 0,
                    branch: branch.trim() || 'main',
                    aiRelevance,
                    majorMinorOnly: candidate.versioned && majorMinorOnly,
                    renderTemplateIds: rendering.available ? renderTemplateIds : [],
                    canvas: canvases.available && canvas,
                  })}
                />
                <span className="text-ui-lg font-medium text-foreground">{candidate.name}</span>
                <span className="text-sm font-normal text-muted-foreground">
                  {candidate.description}
                </span>
              </Button>
            </li>
          ))}
          <li className="flex flex-col gap-2 rounded-xl p-5 ring-1 ring-border">
            <span className="text-ui-lg font-medium text-foreground">Manual campaign</span>
            <span className="text-sm text-muted-foreground">
              Pick a release you already shipped and build its campaign by hand, with the same
              review rules.
            </span>
            <Link className="self-start text-sm underline" href="/campaigns/new">
              Start a manual campaign
            </Link>
          </li>
          <li
            aria-disabled
            className="flex flex-col gap-2 rounded-xl p-5 opacity-60 ring-1 ring-border"
          >
            <span className="flex items-center gap-2 text-ui-lg font-medium text-foreground">
              Weekly recurring campaign <Pill>Planned</Pill>
            </span>
            <span className="text-sm text-muted-foreground">
              Not available yet. Until it is, start a manual campaign after each release.
            </span>
          </li>
        </ul>
      </Section>

      {template ? (
        <Section
          description="You can change every step in the editor before activating."
          title="Configure"
        >
          {sources.length === 0 ? (
            <Alert>
              <AlertDescription>
                Connect GitHub and watch a repository on the{' '}
                <Link
                  className="underline"
                  href="/workflows?view=sources&returnTo=%2Fworkflows%2Fnew"
                >
                  Workflows page
                </Link>{' '}
                first.
              </AlertDescription>
            </Alert>
          ) : (
            <Group>
              <Row label="Name">
                <Input
                  aria-label="Workflow name"
                  onChange={(event) => setName(event.target.value)}
                  value={name}
                />
              </Row>
              <Row description="Workflows run for one watched repository." label="Repository">
                <Select
                  onValueChange={(next) => setSourceId(next === EMPTY ? '' : next)}
                  value={sourceId || EMPTY}
                >
                  <SelectTrigger aria-label="Repository" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={EMPTY}>Choose a repository</SelectItem>
                    {sources.map((source) => (
                      <SelectItem key={source.id} value={source.id}>
                        {source.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Row>
              {template.id === 'feature-announcement' ? (
                <Row
                  description="Only pull requests merged into this branch qualify."
                  label="Branch"
                >
                  <Input
                    aria-label="Pull request base branch"
                    onChange={(event) => setBranch(event.target.value)}
                    value={branch}
                  />
                </Row>
              ) : null}
              {overview.brands.length === 0 ? (
                <Row label="Visual brand kit required">
                  <Link
                    className="underline"
                    href="/workspace/brand-kit?returnTo=%2Fworkflows%2Fnew"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Create and publish a brand kit (new tab)
                  </Link>
                </Row>
              ) : null}
              <Row
                description="Drafts use this published visual brand kit."
                label="Visual brand kit"
              >
                <Select
                  onValueChange={(next) => setBrandKitId(next === EMPTY ? '' : next)}
                  value={brandKitId || EMPTY}
                >
                  <SelectTrigger aria-label="Visual brand kit" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={EMPTY}>Select a published brand kit</SelectItem>
                    {overview.brands.map((brand) => (
                      <SelectItem key={brand.id} value={brand.id}>
                        {brand.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Row>
              <Row
                description="One draft post per destination."
                label="Destinations"
                layout="stacked"
              >
                {overview.destinations.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Connect a destination in{' '}
                    <Link
                      className="underline"
                      href="/workspace/channels?returnTo=%2Fworkflows%2Fnew"
                    >
                      Channels
                    </Link>{' '}
                    first.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-4">
                    {overview.destinations.map((destination) => (
                      <Label className="flex items-center gap-2 text-sm" key={destination.id}>
                        <Checkbox
                          checked={destinationIds.includes(destination.id)}
                          onCheckedChange={(checked) =>
                            setDestinationIds(
                              checked === true
                                ? [...destinationIds, destination.id]
                                : destinationIds.filter((id) => id !== destination.id)
                            )
                          }
                        />
                        {destination.name}
                      </Label>
                    ))}
                  </div>
                )}
              </Row>
              <Row
                description={
                  generation.available
                    ? 'Rewrites each draft for its channel in your brand voice. Spends AI credits, at most the limit, once per run.'
                    : `Unavailable: ${generation.reason}`
                }
                label="AI channel copy"
                layout="stacked"
              >
                <div className="flex flex-wrap items-center gap-4">
                  <Label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={generate}
                      disabled={!generation.available}
                      onCheckedChange={(checked) => setGenerate(checked === true)}
                    />
                    Generate copy with AI
                  </Label>
                  {generate ? (
                    <Label className="flex items-center gap-2 text-sm">
                      Credit limit
                      <Input
                        className="w-24"
                        max={500}
                        min={1}
                        onChange={(event) =>
                          setCreditLimit(Math.trunc(Number(event.target.value)) || 1)
                        }
                        type="number"
                        value={creditLimit}
                      />
                    </Label>
                  ) : null}
                </div>
              </Row>
              {template.versioned ? (
                <Row
                  description="Patch releases (x.y.1) and prereleases are skipped. Tags that are not versions ask for attention."
                  label="What counts as a release"
                  layout="stacked"
                >
                  <Label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={majorMinorOnly}
                      onCheckedChange={(checked) => setMajorMinorOnly(checked === true)}
                    />
                    Only major and minor versions
                  </Label>
                </Row>
              ) : null}
              <Row
                description={
                  relevance.available
                    ? 'Replaces the rule-based check with an AI judgment of whether customers would care, under criteria you can edit. A few credits per event.'
                    : `Unavailable: ${relevance.reason}`
                }
                label="AI relevance check"
                layout="stacked"
              >
                <Label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={aiRelevance}
                    disabled={!relevance.available}
                    onCheckedChange={(checked) => setAIRelevance(checked === true)}
                  />
                  Let AI judge whether this is worth marketing
                </Label>
              </Row>
              <Row
                description={
                  rendering.available
                    ? 'Fills design templates with your latest product capture and the release headline, in your brand kit. Designs stay drafts until approved.'
                    : `Unavailable: ${rendering.reason}`
                }
                label="Rendered creatives"
                layout="stacked"
              >
                <div className="flex flex-wrap gap-4">
                  {(overview.templates ?? []).map((design) => (
                    <Label
                      className="grid w-full gap-2 rounded-lg border p-3 text-sm sm:w-64"
                      key={design.id}
                    >
                      <DesignTemplatePreview id={design.id} />
                      <Checkbox
                        checked={renderTemplateIds.includes(design.id)}
                        disabled={
                          !rendering.available ||
                          (!renderTemplateIds.includes(design.id) && renderTemplateIds.length >= 3)
                        }
                        onCheckedChange={(checked) =>
                          setRenderTemplateIds(
                            checked === true
                              ? [...renderTemplateIds, design.id]
                              : renderTemplateIds.filter((id) => id !== design.id)
                          )
                        }
                      />
                      {design.name} · {design.aspectRatio.replace('_', ':')}
                    </Label>
                  ))}
                </div>
              </Row>
              <Row
                description={
                  canvases.available
                    ? 'Lays out a feature announcement and social formats from the release on a new canvas, quoting only the release record. Your team refines and exports it.'
                    : `Unavailable: ${canvases.reason}`
                }
                label="Canvas"
              >
                <Label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={canvas}
                    disabled={!canvases.available}
                    onCheckedChange={(checked) => setCanvas(checked === true)}
                  />
                  Lay out a canvas from the release
                </Label>
              </Row>
              <Row>
                <div className="flex flex-wrap items-center gap-3">
                  <Button disabled={busy || !sourceId} onClick={() => void create()} type="button">
                    {busy ? 'Creating…' : 'Create draft'}
                  </Button>
                  <ButtonLink href="/workflows" variant="ghost">
                    Cancel
                  </ButtonLink>
                  <span className="text-xs text-muted-foreground">
                    The draft is validated by the backend; nothing runs until you activate it.
                  </span>
                </div>
              </Row>
            </Group>
          )}
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </Section>
      ) : null}
    </Page>
  )
}
