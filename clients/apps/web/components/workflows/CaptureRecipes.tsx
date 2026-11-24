'use client'

import { useState } from 'react'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { ConfirmDialog } from '@/components/settings/ConfirmDialog'
import { Group, Pill, Row, Section } from '@/components/platform-ui'
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
import { Textarea } from '@/components/ui/textarea'
import { getErrorMessage } from '@/components/workspace/settings-client'
import {
  captureRecipeInputSchema,
  type CaptureConnection,
  type CaptureJob,
  type CaptureRecipe,
} from '@/lib/api/contracts/capture'
import { editorHref } from '@/lib/platform/editor-handoff'
import { captureFailureMessage } from '@/lib/tenant/surface-freshness'
import { useTRPCClient } from '@/lib/trpc/react'
import {
  CAPTURE_JOB_PHASE,
  CAPTURE_RECIPE_STATUS,
  captureNavigationSummary,
  captureRecipeInput,
  latestCaptureTest,
  type CaptureRecipeForm,
} from '@/lib/workflows/capture'
import { CaptureError, CaptureField, useCaptureAction } from './capture-ui'
import { automationSelectClass } from './ConditionEditor'
import { relativeTime } from './workflow-ui'

/** The recipe form's text fields; the rest are checkboxes or selects. */
type RecipeTextField = Exclude<
  keyof CaptureRecipeForm,
  'sharp' | 'cropToMarker' | 'verifyWithVision' | 'colorScheme' | 'maskStyle'
>

/** Radix selects cannot hold an empty value. */
const EMPTY_OPTION = '__empty_option__'

const blankRecipe: CaptureRecipeForm = {
  allowedPostPaths: '',
  colorScheme: '',
  connectionId: '',
  forbidden: '',
  height: '900',
  marker: '',
  maskStyle: 'solid',
  masks: '',
  name: '',
  optionalMasks: '',
  path: '',
  surfaceId: '',
  versionPath: '',
  versionSelector: '',
  width: '1440',
  objective: '',
  navigationSteps: '4',
  navigationCredits: '10',
}

/** A test's outcome. The image goes through the authorized asset route, which rechecks access. */
function TestResult({ job, recipeName }: { job: CaptureJob; recipeName: string }) {
  const phase = CAPTURE_JOB_PHASE[job.phase]
  const navigation = captureNavigationSummary(job)
  return (
    <div className="space-y-2 rounded-lg bg-muted/40 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span>Last test {relativeTime(job.createdAt)}</span>
        <Pill tone={phase.tone}>{phase.label}</Pill>
      </div>
      {job.failureCode ? (
        <p className="text-muted-foreground">{captureFailureMessage(job.failureCode)}</p>
      ) : null}
      {navigation ? <p className="text-muted-foreground">{navigation}</p> : null}
      {job.assetId ? (
        <div className="space-y-2">
          <a
            aria-label={`Open the test capture of ${recipeName} at full size`}
            className="block w-full max-w-md overflow-hidden rounded-lg ring-1 ring-foreground/[0.08] focus-visible:ring-2"
            href={`/api/v1/assets/${encodeURIComponent(job.assetId)}/content`}
            rel="noopener noreferrer"
            target="_blank"
          >
            <img
              alt={`Test capture of ${recipeName}`}
              className="w-full"
              loading="lazy"
              src={`/api/v1/assets/${encodeURIComponent(job.assetId)}/content?variant=thumbnail`}
            />
          </a>
          <ButtonLink href={editorHref({ assetId: job.assetId })} size="sm" variant="outline">
            Open in editor
          </ButtonLink>
        </div>
      ) : null}
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
  const [form, setForm] = useState(blankRecipe)
  const { busy, error, run } = useCaptureAction()
  const set = (key: RecipeTextField, value: string) => setForm((old) => ({ ...old, [key]: value }))
  const text = (key: RecipeTextField, label: string, hint: string, required = true) => (
    <CaptureField hint={hint} label={label}>
      <Input
        onChange={(event) => set(key, event.target.value)}
        required={required}
        value={form[key]}
      />
    </CaptureField>
  )
  const submit = () =>
    run(async () => {
      const input = captureRecipeInputSchema.safeParse(captureRecipeInput(form))
      if (!input.success) throw new Error(input.error.issues[0]?.message ?? 'Check this form.')
      await client.capture.createRecipe.mutate(input.data)
      setForm(blankRecipe)
      await onChanged()
    })
  return (
    <form
      className="space-y-4 rounded-lg border p-5"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <h3 className="font-medium">Add a screen</h3>
      <p className="text-sm text-muted-foreground">
        Saving under an existing name adds a new version. A new version runs only as a test until
        you enable it.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        {text('name', 'Name', 'Such as Billing dashboard.')}
        <CaptureField hint="The page whose current image this replaces." label="Product page">
          <Select
            onValueChange={(next) => set('surfaceId', next === EMPTY_OPTION ? '' : next)}
            required
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
        <CaptureField hint="The sign-in this screen uses." label="Connection">
          <Select
            onValueChange={(next) => set('connectionId', next === EMPTY_OPTION ? '' : next)}
            required
            value={form.connectionId || EMPTY_OPTION}
          >
            <SelectTrigger className={automationSelectClass}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={EMPTY_OPTION}>Choose a connection</SelectItem>
              {connections
                .filter((connection) => connection.status !== 'REVOKED')
                .map((connection) => (
                  <SelectItem key={connection.id} value={connection.id}>
                    {connection.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </CaptureField>
        {text('path', 'Path', 'On the connected app: /billing.')}
        <CaptureField
          hint="AI can follow the app's links and tabs and open its menus, panels and dialogs to find this feature. Leave empty to capture the path directly. Page paths, headings and the labels of links, tabs and buttons are sent to the AI provider; the account marker, form values, and configured masks are excluded."
          label="Feature to find (optional)"
        >
          <Textarea
            maxLength={1000}
            onChange={(event) => set('objective', event.target.value)}
            rows={3}
            value={form.objective}
          />
        </CaptureField>
        {form.objective.trim() ? (
          <div className="grid grid-cols-2 gap-4">
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
            <CaptureField
              hint="1–20 credits per attempt. A retry has its own budget."
              label="AI credit limit"
            >
              <Input
                max={20}
                min={1}
                onChange={(event) => set('navigationCredits', event.target.value)}
                required
                type="number"
                value={form.navigationCredits}
              />
            </CaptureField>
          </div>
        ) : null}
        {text(
          'marker',
          'Element that proves the screen',
          'A CSS selector that exists only once this screen has loaded: [data-testid=invoice-table].'
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
        <CaptureField
          hint="One CSS selector per line, for private details. If one is missing, nothing is captured."
          label="Elements to hide (optional)"
        >
          <Textarea
            onChange={(event) => set('masks', event.target.value)}
            rows={3}
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
        <CaptureField hint="Emulate prefers-color-scheme on the captured page." label="Color scheme">
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
        <CaptureField hint="How hidden private elements are masked in the image." label="Mask style">
          <Select
            onValueChange={(next) =>
              setForm((old) => ({ ...old, maskStyle: next as 'solid' | 'blur' }))
            }
            value={form.maskStyle ?? 'solid'}
          >
            <SelectTrigger className={automationSelectClass}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="solid">Solid black box</SelectItem>
              <SelectItem value="blur">Clean Gaussian blur</SelectItem>
            </SelectContent>
          </Select>
        </CaptureField>
        <Label className="flex items-start gap-2 text-sm">
          <Checkbox
            checked={form.sharp ?? false}
            onCheckedChange={(checked) => setForm((old) => ({ ...old, sharp: checked === true }))}
          />
          <span>
            Capture at double resolution
            <span className="block text-xs leading-5 text-muted-foreground">
              Sharper creatives; the image is twice the width and height.
            </span>
          </span>
        </Label>
        <Label className="flex items-start gap-2 text-sm">
          <Checkbox
            checked={form.cropToMarker ?? false}
            onCheckedChange={(checked) =>
              setForm((old) => ({ ...old, cropToMarker: checked === true }))
            }
          />
          <span>
            Crop to the element that proves the screen
            <span className="block text-xs leading-5 text-muted-foreground">
              The image shows that element and a small margin, so creatives zoom in on the change.
            </span>
          </span>
        </Label>
        <Label className="flex items-start gap-2 text-sm">
          <Checkbox
            checked={form.verifyWithVision ?? false}
            onCheckedChange={(checked) =>
              setForm((old) => ({ ...old, verifyWithVision: checked === true }))
            }
          />
          <span>
            Verify screenshot with AI vision
            <span className="block text-xs leading-5 text-muted-foreground">
              Checks the captured image before attaching it to a campaign, rejecting blank views,
              loading skeletons, or error banners.
            </span>
          </span>
        </Label>
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
      </div>
      <CaptureError message={error} />
      <Button disabled={busy} type="submit">
        {busy ? 'Saving…' : 'Add screen'}
      </Button>
    </form>
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
