'use client'

import { useState } from 'react'
import { ConfirmDialog } from '@/components/settings/ConfirmDialog'
import { Group, Pill, Row, Section } from '@/components/platform-ui'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { getErrorMessage } from '@/components/workspace/settings-client'
import {
  captureRecipeInputSchema,
  proposeCaptureRecipeInputSchema,
  type CaptureConnection,
  type CaptureJob,
  type CaptureRecipe,
  type ProposedCaptureRecipe,
} from '@/lib/api/contracts/capture'
import { captureFailureMessage } from '@/lib/tenant/surface-freshness'
import { useTRPCClient } from '@/lib/trpc/react'
import {
  CAPTURE_JOB_PHASE,
  CAPTURE_RECIPE_STATUS,
  captureJobFrames,
  captureNavigationSummary,
  captureRecipeInput,
  latestCaptureTest,
  type CaptureRecipeForm,
} from '@/lib/workflows/capture'
import { CaptureError, CaptureField, CaptureFrameList, useCaptureAction } from './capture-ui'
import { automationSelectClass } from './ConditionEditor'
import { relativeTime } from './workflow-ui'

/** The recipe form's text fields; the rest are checkboxes or selects. */
type RecipeTextField = Exclude<
  keyof CaptureRecipeForm,
  | 'sharp'
  | 'cropToMarker'
  | 'verifyWithVision'
  | 'useVision'
  | 'allowSearchFill'
  | 'colorScheme'
  | 'maskStyle'
>

/** Radix selects cannot hold an empty value. */
const EMPTY_OPTION = '__empty_option__'

const blankRecipe: CaptureRecipeForm = {
  allowSearchFill: true,
  allowedPostPaths: '',
  colorScheme: '',
  connectionId: '',
  forbidden: '',
  height: '900',
  marker: '',
  maskStyle: 'blur',
  masks: '',
  name: '',
  optionalMasks: '',
  path: '',
  sequenceShots: '1',
  sharp: true,
  surfaceId: '',
  useVision: true,
  verifyWithVision: true,
  versionPath: '',
  versionSelector: '',
  width: '1440',
  objective: '',
  navigationSteps: '6',
  navigationCredits: '8',
}

/** A test's outcome. The image goes through the authorized asset route, which rechecks access. */
function TestResult({ job, recipeName }: { job: CaptureJob; recipeName: string }) {
  const phase = CAPTURE_JOB_PHASE[job.phase]
  const navigation = captureNavigationSummary(job)
  const frames = captureJobFrames(job)
  return (
    <div className="space-y-2 rounded-lg bg-muted/40 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span>Last test {relativeTime(job.createdAt)}</span>
        <Pill tone={phase.tone}>{phase.label}</Pill>
        {frames.length > 1 ? <Pill>{frames.length}-shot sequence</Pill> : null}
      </div>
      {job.failureCode ? (
        <p className="text-muted-foreground">{captureFailureMessage(job.failureCode)}</p>
      ) : null}
      {navigation ? <p className="text-muted-foreground">{navigation}</p> : null}
      <CaptureFrameList frames={frames} name={recipeName} />
    </div>
  )
}

function RecipeRow({
  canManage,
  connection,
  jobs,
  onChanged,
  recipe,
  surfaceName,
}: {
  canManage: boolean
  connection?: CaptureConnection
  jobs: CaptureJob[]
  onChanged: () => Promise<void>
  recipe: CaptureRecipe
  surfaceName?: string
}) {
  const client = useTRPCClient()
  const { busy, error, run } = useCaptureAction()
  const status = CAPTURE_RECIPE_STATUS[recipe.status]
  const test = latestCaptureTest(jobs, recipe.id)
  return (
    <Row>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-ui-lg text-foreground">
              {recipe.name} · version {recipe.version}
            </h3>
            <Pill tone={status.tone}>{status.label}</Pill>
            {recipe.definition.navigation?.useVision ? <Pill tone="blue">AI Vision</Pill> : null}
            {(recipe.definition.sequenceShots ?? 1) > 1 ? (
              <Pill>{recipe.definition.sequenceShots}-shot sequence</Pill>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {surfaceName ?? 'Deleted page'} · {connection?.name ?? 'Deleted connection'} ·{' '}
            {recipe.definition.version
              ? 'Proves the deployed commit'
              : 'Current state only, no version proof'}
          </p>
          <p className="text-xs text-muted-foreground">
            {recipe.testedAt
              ? `Tested ${relativeTime(recipe.testedAt)}`
              : 'Needs a successful test before it can run after deployment'}
          </p>
          {recipe.definition.navigation ? (
            <p className="text-xs text-muted-foreground">
              AI objective: {recipe.definition.navigation.objective} · Up to{' '}
              {recipe.definition.navigation.maxSteps} actions ·{' '}
              {recipe.definition.navigation.creditLimit} credits per attempt
            </p>
          ) : null}
        </div>
        {canManage && recipe.status !== 'ARCHIVED' ? (
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await client.capture.testRecipe.mutate({ id: recipe.id })
                  await onChanged()
                })
              }
              type="button"
              variant="outline"
            >
              Test capture
            </Button>
            {recipe.status === 'DRAFT' ? (
              <Button
                disabled={busy || !recipe.testedAt}
                onClick={() =>
                  void run(async () => {
                    await client.capture.activateRecipe.mutate({ id: recipe.id })
                    await onChanged()
                  })
                }
                type="button"
              >
                Enable after deployment
              </Button>
            ) : null}
            <ConfirmDialog
              confirmLabel="Archive"
              description="This version stops running for future work. Its captures and history stay."
              onConfirm={async () => {
                try {
                  await client.capture.archiveRecipe.mutate({ id: recipe.id })
                  await onChanged()
                  return null
                } catch (failure) {
                  return getErrorMessage(failure)
                }
              }}
              title={`Archive “${recipe.name}” version ${recipe.version}?`}
              triggerLabel="Archive"
            />
          </div>
        ) : null}
      </div>
      {test ? <TestResult job={test} recipeName={recipe.name} /> : null}
      <CaptureError message={error} />
    </Row>
  )
}

function applyProposalToForm(
  old: CaptureRecipeForm,
  proposal: ProposedCaptureRecipe
): CaptureRecipeForm {
  const def = proposal.definition
  return {
    ...old,
    name: proposal.name,
    path: def.steps[0]?.path ?? old.path,
    marker: def.markers[0] ?? '',
    masks: (def.masks ?? []).join('\n'),
    optionalMasks: (def.optionalMasks ?? []).join('\n'),
    forbidden: (def.forbidden ?? []).join('\n'),
    allowedPostPaths: (def.allowedPostPaths ?? []).join('\n'),
    colorScheme: def.colorScheme ?? '',
    maskStyle: def.maskStyle ?? 'blur',
    sharp: def.viewport.scale === 2,
    width: String(def.viewport.width),
    height: String(def.viewport.height),
    cropToMarker: def.crop === 'marker',
    verifyWithVision: def.verifyWithVision ?? true,
    sequenceShots: String(def.sequenceShots ?? 1),
    objective: def.navigation?.objective ?? '',
    navigationSteps: String(def.navigation?.maxSteps ?? 6),
    navigationCredits: String(def.navigation?.creditLimit ?? 8),
    useVision: def.navigation?.useVision ?? true,
    allowSearchFill: def.navigation?.allowSearchFill ?? true,
  }
}

function RecipeForm({
  connections,
  onChanged,
  surfaces,
}: {
  connections: CaptureConnection[]
  onChanged: () => Promise<void>
  surfaces: { id: string; name: string }[]
}) {
  const client = useTRPCClient()
  const activeConnections = connections.filter((connection) => connection.status !== 'REVOKED')
  const defaultConnectionId = activeConnections.length === 1 ? activeConnections[0].id : ''
  const defaultSurfaceId = surfaces.length === 1 ? surfaces[0].id : ''
  const [form, setForm] = useState<CaptureRecipeForm>(() => ({
    ...blankRecipe,
    connectionId: defaultConnectionId,
    surfaceId: defaultSurfaceId,
  }))
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiShots, setAiShots] = useState('auto')
  const [aiNote, setAiNote] = useState<string | null>(null)
  const aiAction = useCaptureAction()
  const saveAction = useCaptureAction()
  const set = (key: RecipeTextField, value: string) => setForm((old) => ({ ...old, [key]: value }))
  const selectedConnection = activeConnections.find((item) => item.id === form.connectionId)
  const text = (key: RecipeTextField, label: string, hint: string, required = true) => (
    <CaptureField hint={hint} label={label}>
      <Input
        onChange={(event) => set(key, event.target.value)}
        required={required}
        value={form[key] ?? ''}
      />
    </CaptureField>
  )
  const buildProposeInput = () => {
    const parsed = proposeCaptureRecipeInputSchema.safeParse({
      connectionId: form.connectionId,
      surfaceId: form.surfaceId,
      prompt: aiPrompt,
      ...(aiShots !== 'auto' ? { sequenceShots: Number(aiShots) } : {}),
    })
    if (!parsed.success) {
      throw new Error(
        parsed.error.issues[0]?.message ??
          'Choose a product page, connection, and describe what you want captured.'
      )
    }
    return parsed.data
  }
  const autoCapture = () =>
    aiAction.run(async () => {
      const input = buildProposeInput()
      const result = await client.capture.autoCapture.mutate(input)
      setAiPrompt('')
      setAiNote(`Started AI capture “${result.recipe.name}” — watch Recent captures below.`)
      await onChanged()
    })
  const proposeIntoForm = () =>
    aiAction.run(async () => {
      const input = buildProposeInput()
      const { proposal } = await client.capture.proposeRecipe.mutate(input)
      setForm((old) => applyProposalToForm(old, proposal))
      setAiNote(proposal.reasoning || 'Filled form with AI. Review or click Add screen to save.')
    })
  const submit = () =>
    saveAction.run(async () => {
      const input = captureRecipeInputSchema.safeParse(captureRecipeInput(form))
      if (!input.success) throw new Error(input.error.issues[0]?.message ?? 'Check this form.')
      await client.capture.createRecipe.mutate(input.data)
      setForm({
        ...blankRecipe,
        connectionId: defaultConnectionId,
        surfaceId: defaultSurfaceId,
      })
      setAiNote(null)
      await onChanged()
    })
  return (
    <div className="space-y-4">
      <div className="grid gap-4 rounded-lg border p-4 md:grid-cols-2">
        <CaptureField hint="The page whose current image this belongs to." label="Product page">
          <Select
            onValueChange={(next) => set('surfaceId', next === EMPTY_OPTION ? '' : next)}
            value={form.surfaceId || EMPTY_OPTION}
          >
            <SelectTrigger className={automationSelectClass}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={EMPTY_OPTION}>Choose a page</SelectItem>
              {surfaces.map((surface) => (
                <SelectItem key={surface.id} value={surface.id}>
                  {surface.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CaptureField>
        <CaptureField hint="The signed-in app connection to drive." label="Connection">
          <Select
            onValueChange={(next) => set('connectionId', next === EMPTY_OPTION ? '' : next)}
            value={form.connectionId || EMPTY_OPTION}
          >
            <SelectTrigger className={automationSelectClass}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={EMPTY_OPTION}>Choose a connection</SelectItem>
              {activeConnections.map((connection) => (
                <SelectItem key={connection.id} value={connection.id}>
                  {connection.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CaptureField>
      </div>

      <div className="space-y-4 rounded-lg border bg-muted/20 p-5">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium">Capture with AI (zero config)</h3>
            <Pill tone="blue">Hands-free</Pill>
          </div>
          <p className="text-sm text-muted-foreground">
            Describe the screen or user flow in plain English. AI chooses the route, navigates your
            app visually with Set-of-Mark vision, detects the feature focus box, and verifies the
            screenshot — no CSS selectors required.
          </p>
        </div>
        <CaptureField
          hint="Example: “Show the dark-mode analytics cohort chart” or “Capture a 3-shot walkthrough opening the invoice export dialog”."
          label="What should AI capture?"
        >
          <Textarea
            maxLength={600}
            onChange={(event) => setAiPrompt(event.target.value)}
            placeholder="Describe the feature, screen, theme, or walkthrough in plain English…"
            rows={2}
            value={aiPrompt}
          />
        </CaptureField>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-44">
            <CaptureField label="Shots">
              <Select onValueChange={setAiShots} value={aiShots}>
                <SelectTrigger className={automationSelectClass}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto (infer from prompt)</SelectItem>
                  <SelectItem value="1">1 shot (single image)</SelectItem>
                  <SelectItem value="2">2 shots (before + after)</SelectItem>
                  <SelectItem value="3">3 shots (walkthrough)</SelectItem>
                  <SelectItem value="4">4 shots (full carousel)</SelectItem>
                </SelectContent>
              </Select>
            </CaptureField>
          </div>
          <Button disabled={aiAction.busy} onClick={() => void autoCapture()} type="button">
            {aiAction.busy ? 'Working…' : 'Auto-capture now'}
          </Button>
          <Button
            disabled={aiAction.busy}
            onClick={() => void proposeIntoForm()}
            type="button"
            variant="outline"
          >
            Fill form with AI
          </Button>
        </div>
        {aiNote ? <p className="text-sm text-muted-foreground">{aiNote}</p> : null}
        <CaptureError message={aiAction.error} />
      </div>

      <form
        className="space-y-4 rounded-lg border p-5"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <h3 className="font-medium">Add or customize a screen</h3>
        <p className="text-sm text-muted-foreground">
          Saving under an existing name adds a new version. A new version runs only as a test until
          you enable it.
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          {text('name', 'Name', 'Such as Billing dashboard.')}
          {text('path', 'Starting path', 'On the connected app: /billing.')}
        </div>
        {selectedConnection?.discoveredRoutes?.length ? (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">
              Discovered routes on {selectedConnection.name}:
            </p>
            <div className="flex flex-wrap gap-1.5">
              {selectedConnection.discoveredRoutes.slice(0, 12).map((route) => (
                <Button
                  key={route.path}
                  onClick={() =>
                    setForm((old) => ({
                      ...old,
                      path: route.path,
                      name: old.name || route.label || route.path,
                    }))
                  }
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {route.label ? `${route.label} (${route.path})` : route.path}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
        <CaptureField
          hint="AI can follow links, tabs, menus, dialogs, and read-only search filters to find this feature. Leave empty to capture the starting path directly."
          label="Feature to find (optional)"
        >
          <Textarea
            maxLength={1000}
            onChange={(event) => set('objective', event.target.value)}
            rows={2}
            value={form.objective}
          />
        </CaptureField>
        {form.objective.trim() ? (
          <div className="space-y-3 rounded-md bg-muted/30 p-3">
            <div className="grid gap-4 sm:grid-cols-3">
              <CaptureField hint="1–6 navigation actions." label="Action limit">
                <Input
                  max={6}
                  min={1}
                  onChange={(event) => set('navigationSteps', event.target.value)}
                  required
                  type="number"
                  value={form.navigationSteps}
                />
              </CaptureField>
              <CaptureField hint="1–20 credits per attempt." label="AI credit limit">
                <Input
                  max={20}
                  min={1}
                  onChange={(event) => set('navigationCredits', event.target.value)}
                  required
                  type="number"
                  value={form.navigationCredits}
                />
              </CaptureField>
              <CaptureField hint="Multi-shot carousel frames." label="Sequence shots">
                <Select
                  onValueChange={(next) => set('sequenceShots', next)}
                  value={form.sequenceShots ?? '1'}
                >
                  <SelectTrigger className={automationSelectClass}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1 shot</SelectItem>
                    <SelectItem value="2">2 shots</SelectItem>
                    <SelectItem value="3">3 shots</SelectItem>
                    <SelectItem value="4">4 shots</SelectItem>
                  </SelectContent>
                </Select>
              </CaptureField>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <Label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={form.useVision ?? true}
                  onCheckedChange={(checked) =>
                    setForm((old) => ({ ...old, useVision: checked === true }))
                  }
                />
                <span>
                  Use AI vision (Set-of-Mark)
                  <span className="block text-xs leading-5 text-muted-foreground">
                    Sends masked viewport previews with numbered control badges so AI sees visual
                    layout, icons, and charts.
                  </span>
                </span>
              </Label>
              <Label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={form.allowSearchFill ?? true}
                  onCheckedChange={(checked) =>
                    setForm((old) => ({ ...old, allowSearchFill: checked === true }))
                  }
                />
                <span>
                  Allow safe search & filter typing
                  <span className="block text-xs leading-5 text-muted-foreground">
                    Lets AI type read-only queries into search bars or filter inputs without ever
                    submitting forms.
                  </span>
                </span>
              </Label>
            </div>
          </div>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2">
          <CaptureField
            hint="Emulate prefers-color-scheme on the captured page."
            label="Color scheme"
          >
            <Select
              onValueChange={(next) =>
                setForm((old) => ({
                  ...old,
                  colorScheme: next === EMPTY_OPTION ? '' : (next as 'light' | 'dark'),
                }))
              }
              value={form.colorScheme || EMPTY_OPTION}
            >
              <SelectTrigger className={automationSelectClass}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={EMPTY_OPTION}>App default</SelectItem>
                <SelectItem value="light">Light mode</SelectItem>
                <SelectItem value="dark">Dark mode</SelectItem>
              </SelectContent>
            </Select>
          </CaptureField>
          <CaptureField
            hint="How hidden private elements are masked in the image."
            label="Mask style"
          >
            <Select
              onValueChange={(next) =>
                setForm((old) => ({ ...old, maskStyle: next as 'solid' | 'blur' }))
              }
              value={form.maskStyle ?? 'blur'}
            >
              <SelectTrigger className={automationSelectClass}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="blur">Clean Gaussian blur</SelectItem>
                <SelectItem value="solid">Solid black box</SelectItem>
              </SelectContent>
            </Select>
          </CaptureField>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <Label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={form.verifyWithVision ?? true}
              onCheckedChange={(checked) =>
                setForm((old) => ({ ...old, verifyWithVision: checked === true }))
              }
            />
            <span>
              Verify screenshot & detect focus with AI vision
              <span className="block text-xs leading-5 text-muted-foreground">
                Rejects blank views or error banners and automatically frames the highlighted
                feature for creatives.
              </span>
            </span>
          </Label>
          <Label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={form.sharp ?? true}
              onCheckedChange={(checked) => setForm((old) => ({ ...old, sharp: checked === true }))}
            />
            <span>
              Capture at double resolution (2× retina)
              <span className="block text-xs leading-5 text-muted-foreground">
                Sharper creatives; captures at twice the pixel density.
              </span>
            </span>
          </Label>
        </div>

        <Disclosure>
          <DisclosureTrigger
            className="rounded-md border px-3 py-2 text-sm font-medium"
            summary="Optional — AI works without these"
          >
            Advanced selectors, version proof & viewport
          </DisclosureTrigger>
          <DisclosureContent className="space-y-4 pt-4">
            <div className="grid gap-4 md:grid-cols-2">
              {text(
                'marker',
                'Element that proves the screen (optional)',
                'Leave blank to match the main app container automatically (main, [role=main], body), or enter a CSS selector such as [data-testid=invoice-table].',
                false
              )}
              {text(
                'versionPath',
                'Version proof path (optional)',
                'Reports the deployed commit, such as /api/version. Without it, images are labeled as the current state.',
                false
              )}
              {text(
                'versionSelector',
                'Version proof CSS selector (optional)',
                'Alternative to a path: element whose text or content attribute holds the commit SHA, such as meta[name=build].',
                false
              )}
              <Label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={form.cropToMarker ?? false}
                  onCheckedChange={(checked) =>
                    setForm((old) => ({ ...old, cropToMarker: checked === true }))
                  }
                />
                <span>
                  Crop tightly to the proving element
                  <span className="block text-xs leading-5 text-muted-foreground">
                    Only recommended when you set a specific CSS selector above.
                  </span>
                </span>
              </Label>
              <CaptureField
                hint="One CSS selector per line, for private details. If one is missing, nothing is captured."
                label="Elements to hide (optional)"
              >
                <Textarea
                  onChange={(event) => set('masks', event.target.value)}
                  rows={2}
                  value={form.masks}
                />
              </CaptureField>
              <CaptureField
                hint="One CSS selector per line. Hidden whenever present without failing if absent on a navigated route."
                label="Optional elements to hide (optional)"
              >
                <Textarea
                  onChange={(event) => set('optionalMasks', event.target.value)}
                  rows={2}
                  value={form.optionalMasks ?? ''}
                />
              </CaptureField>
              <CaptureField
                hint="One CSS selector per line for error banners, empty states, or loading skeletons that should fail the capture."
                label="Forbidden views (optional)"
              >
                <Textarea
                  onChange={(event) => set('forbidden', event.target.value)}
                  rows={2}
                  value={form.forbidden ?? ''}
                />
              </CaptureField>
              <CaptureField
                hint="Up to 5 exact read-only POST paths (one per line), such as /graphql. Other POSTs remain blocked."
                label="Read-only POST paths (optional)"
              >
                <Textarea
                  onChange={(event) => set('allowedPostPaths', event.target.value)}
                  rows={2}
                  value={form.allowedPostPaths ?? ''}
                />
              </CaptureField>
            </div>
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                <Button
                  onClick={() => setForm((old) => ({ ...old, height: '900', width: '1440' }))}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Desktop 1440×900
                </Button>
                <Button
                  onClick={() => setForm((old) => ({ ...old, height: '800', width: '1280' }))}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Laptop 1280×800
                </Button>
                <Button
                  onClick={() => setForm((old) => ({ ...old, height: '844', width: '390' }))}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Mobile 390×844
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <CaptureField label="Width">
                  <Input
                    onChange={(event) => set('width', event.target.value)}
                    required
                    type="number"
                    value={form.width}
                  />
                </CaptureField>
                <CaptureField label="Height">
                  <Input
                    onChange={(event) => set('height', event.target.value)}
                    required
                    type="number"
                    value={form.height}
                  />
                </CaptureField>
              </div>
            </div>
          </DisclosureContent>
        </Disclosure>

        <CaptureError message={saveAction.error} />
        <Button disabled={saveAction.busy} type="submit">
          {saveAction.busy ? 'Saving…' : 'Add screen'}
        </Button>
      </form>
    </div>
  )
}

/** The screens to capture, each version with its test result. */
export function CaptureRecipes({
  canManage,
  connections,
  jobs,
  onChanged,
  recipes,
  surfaces,
}: {
  canManage: boolean
  connections: CaptureConnection[]
  jobs: CaptureJob[]
  onChanged: () => Promise<void>
  recipes: CaptureRecipe[]
  surfaces: { id: string; name: string }[]
}) {
  return (
    <Section
      title="Screens"
      description="Each version is reviewed and fixed. Test it and check the image before it runs after deployments."
    >
      {recipes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No screens yet.</p>
      ) : (
        <Group>
          {recipes.map((recipe) => (
            <RecipeRow
              canManage={canManage}
              connection={connections.find((item) => item.id === recipe.connectionId)}
              jobs={jobs}
              key={recipe.id}
              onChanged={onChanged}
              recipe={recipe}
              surfaceName={surfaces.find((surface) => surface.id === recipe.surfaceId)?.name}
            />
          ))}
        </Group>
      )}
      {canManage ? (
        <RecipeForm connections={connections} onChanged={onChanged} surfaces={surfaces} />
      ) : null}
    </Section>
  )
}
