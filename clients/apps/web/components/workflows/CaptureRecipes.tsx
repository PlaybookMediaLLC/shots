'use client'

import { useState } from 'react'
import { ConfirmDialog } from '@/components/settings/ConfirmDialog'
import { Group, Pill, Row, Section } from '@/components/platform-ui'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import { captureFailureMessage } from '@/lib/tenant/surface-freshness'
import { useTRPCClient } from '@/lib/trpc/react'
import {
  CAPTURE_JOB_PHASE,
  CAPTURE_RECIPE_STATUS,
  captureRecipeInput,
  latestCaptureTest,
  type CaptureRecipeForm,
} from '@/lib/workflows/capture'
import { CaptureError, CaptureField, useCaptureAction } from './capture-ui'
import { automationSelectClass } from './ConditionEditor'
import { relativeTime } from './workflow-ui'

/** Radix selects cannot hold an empty value. */
const EMPTY_OPTION = '__empty_option__'

const blankRecipe: CaptureRecipeForm = {
  connectionId: '',
  height: '900',
  marker: '',
  masks: '',
  name: '',
  path: '',
  surfaceId: '',
  versionPath: '',
  width: '1440',
  objective: '',
  navigationSteps: '4',
  navigationCredits: '10',
}

/** A test's outcome. The image goes through the authorized asset route, which rechecks access. */
function TestResult({ job, recipeName }: { job: CaptureJob; recipeName: string }) {
  const phase = CAPTURE_JOB_PHASE[job.phase]
  return (
    <div className="space-y-2 rounded-lg bg-muted/40 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span>Last test {relativeTime(job.createdAt)}</span>
        <Pill tone={phase.tone}>{phase.label}</Pill>
      </div>
      {job.failureCode ? (
        <p className="text-muted-foreground">{captureFailureMessage(job.failureCode)}</p>
      ) : null}
      {job.assetId ? (
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
  const set = (key: keyof CaptureRecipeForm, value: string) =>
    setForm((old) => ({ ...old, [key]: value }))
  const text = (key: keyof CaptureRecipeForm, label: string, hint: string, required = true) => (
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
          hint="AI can follow the app's navigation links and tabs to find this feature. Leave empty to capture the path directly. Page paths, headings and navigation labels are sent to the AI provider; the account marker, form values, and configured masks are excluded."
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
