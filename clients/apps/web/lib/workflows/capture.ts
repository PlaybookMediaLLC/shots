import type {
  CaptureConnection,
  CaptureConnectionInput,
  CaptureJob,
  CaptureOverview,
  CaptureRecipe,
  CaptureRecipeInput,
} from '@/lib/api/contracts/capture'

/** Where a connected app runs, as a person reads it. */
export const CAPTURE_ENVIRONMENTS: Record<CaptureConnection['environment'], string> = {
  production: 'Production',
  staging: 'Staging',
  demo: 'Demo',
  development: 'Development',
}

/** A connection's state, for the person deciding whether to sign in again. */
export const CAPTURE_CONNECTION_STATUS = {
  CONNECTING: { label: 'Waiting for sign-in', tone: 'gray' },
  READY: { label: 'Ready', tone: 'green' },
  NEEDS_AUTH: { label: 'Needs sign-in', tone: 'yellow' },
  REVOKED: { label: 'Revoked', tone: 'gray' },
} as const satisfies Record<CaptureConnection['status'], { label: string; tone: string }>

/** A recipe version's state. */
export const CAPTURE_RECIPE_STATUS = {
  DRAFT: { label: 'Draft', tone: 'gray' },
  ACTIVE: { label: 'Runs after deployment', tone: 'green' },
  ARCHIVED: { label: 'Archived', tone: 'gray' },
} as const satisfies Record<CaptureRecipe['status'], { label: string; tone: string }>

/** A capture job's state. */
export const CAPTURE_JOB_PHASE = {
  QUEUED: { label: 'Queued', tone: 'gray' },
  WAITING_DEPLOYMENT: { label: 'Waiting for the deployment', tone: 'blue' },
  RUNNING: { label: 'Running', tone: 'blue' },
  NEEDS_AUTH: { label: 'Needs sign-in', tone: 'yellow' },
  SUCCEEDED: { label: 'Succeeded', tone: 'green' },
  FAILED: { label: 'Failed', tone: 'red' },
  CANCELLED: { label: 'Cancelled', tone: 'gray' },
} as const satisfies Record<CaptureJob['phase'], { label: string; tone: string }>

/** Whether a job can still be stopped. */
export function captureJobOpen(phase: CaptureJob['phase']) {
  return phase !== 'SUCCEEDED' && phase !== 'FAILED' && phase !== 'CANCELLED'
}

/**
 * Whether the backend is working right now, so the page should poll. A job
 * waiting for a person (`NEEDS_AUTH`) holds no browser and changes only when
 * someone reconnects, which itself shows up as a finishing connection.
 */
export function captureInProgress({ connections, jobs }: CaptureOverview) {
  return (
    connections.some((connection) => connection.connectPhase === 'FINISHING') ||
    jobs.some((job) => captureJobOpen(job.phase) && job.phase !== 'NEEDS_AUTH')
  )
}

/** The newest test of a recipe version; the overview lists jobs newest first. */
export function latestCaptureTest(jobs: CaptureJob[], recipeId: string) {
  return jobs.find((job) => job.recipeId === recipeId && job.kind === 'test')
}

/** The version that runs for a screen; anything else may capture a public page. */
export function activeRecipeForSurface(recipes: CaptureRecipe[], surfaceId: string) {
  return recipes.find((recipe) => recipe.status === 'ACTIVE' && recipe.surfaceId === surfaceId)
}

/**
 * Recipes a workflow on this repository can use. The backend refuses, at run
 * time, an inactive recipe or one whose connection belongs to another repository.
 */
export function workflowCaptureRecipes(overview: CaptureOverview, sourceAppId: string) {
  const connections = overview.connections.filter(
    (connection) => connection.sourceAppId === sourceAppId && connection.status !== 'REVOKED'
  )
  return overview.recipes.filter(
    (recipe) =>
      recipe.status === 'ACTIVE' &&
      connections.some((connection) => connection.id === recipe.connectionId)
  )
}

/** Comma- or space-separated host names. */
function hostList(text: string) {
  return text.split(/[\s,]+/).filter(Boolean)
}

/** One CSS selector per line: a selector may itself hold spaces and commas. */
function selectorList(text: string) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/** A connection form's text, before it is parsed. */
export type CaptureConnectionForm = Omit<
  CaptureConnectionInput,
  'hosts' | 'loginHosts' | 'sourceAppId'
> & { hosts: string; loginHosts: string; sourceAppId: string }

/** A connection form as the backend's input. */
export function captureConnectionInput(form: CaptureConnectionForm) {
  return {
    ...form,
    hosts: hostList(form.hosts),
    loginHosts: hostList(form.loginHosts),
    sourceAppId: form.sourceAppId || undefined,
  }
}

/** A recipe form's text, before it is parsed. */
export type CaptureRecipeForm = {
  name: string
  surfaceId: string
  connectionId: string
  path: string
  marker: string
  masks: string
  versionPath: string
  width: string
  height: string
  objective: string
  navigationSteps: string
  navigationCredits: string
}

/**
 * A recipe form as the backend's input: open the screen, then require its
 * element. The runner waits for every marker, so no separate wait step is needed.
 */
export function captureRecipeInput(form: CaptureRecipeForm): CaptureRecipeInput {
  const masks = selectorList(form.masks)
  const versionPath = form.versionPath.trim()
  const objective = form.objective.trim()
  return {
    connectionId: form.connectionId,
    definition: {
      markers: [form.marker.trim()],
      schemaVersion: 1,
      steps: [{ kind: 'NAVIGATE', path: form.path.trim() }],
      viewport: { height: Number(form.height), width: Number(form.width) },
      ...(masks.length ? { masks } : {}),
      ...(versionPath ? { version: { path: versionPath } } : {}),
      ...(objective
        ? {
            navigation: {
              objective,
              maxSteps: Number(form.navigationSteps),
              creditLimit: Number(form.navigationCredits),
            },
          }
        : {}),
    },
    name: form.name,
    surfaceId: form.surfaceId,
  }
}
