import type {
  CaptureAuthAttempt,
  CaptureConnection,
  CaptureConnectionCreate,
  CaptureEmailAuth,
  CaptureLoginRecipe,
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
  CaptureConnectionCreate,
  'hosts' | 'loginHosts' | 'sourceAppId'
> & {
  hosts: string
  loginHosts: string
  sourceAppId: string
}

/** A connection form as the backend's input. */
export function captureConnectionInput(form: CaptureConnectionForm) {
  const bootstrapUrl = (form.bootstrapUrl ?? '').trim()
  const bootstrapSecret = (form.bootstrapSecret ?? '').trim()
  const { bootstrapUrl: _u, bootstrapSecret: _s, ...rest } = form
  return {
    ...rest,
    hosts: hostList(form.hosts),
    loginHosts: hostList(form.loginHosts),
    sourceAppId: form.sourceAppId || undefined,
    ...(bootstrapUrl ? { bootstrapUrl, bootstrapSecret } : {}),
  }
}

/** Fallback marker when the user omits a custom CSS selector for a zero-config AI capture. */
export const DEFAULT_ZERO_CONFIG_MARKER = 'main, [role=main], body'

/** A recipe form's text, before it is parsed. */
export type CaptureRecipeForm = {
  name: string
  surfaceId: string
  connectionId: string
  path: string
  marker: string
  masks: string
  optionalMasks?: string
  forbidden?: string
  allowedPostPaths?: string
  versionPath: string
  versionSelector?: string
  width: string
  height: string
  colorScheme?: '' | 'light' | 'dark'
  maskStyle?: 'solid' | 'blur'
  objective: string
  navigationSteps: string
  navigationCredits: string
  /** Attach Set-of-Mark annotated screenshots during AI navigation. */
  useVision?: boolean
  /** Allow read-only typing into safe search and filter inputs during AI navigation. */
  allowSearchFill?: boolean
  /** Number of ordered frames to capture (1 to 4). */
  sequenceShots?: string
  /** Capture at twice the pixel density. */
  sharp?: boolean
  /** Make the image the proving element and a small margin around it. */
  cropToMarker?: boolean
  /** Run fast multimodal verification before committing captures. */
  verifyWithVision?: boolean
}

/**
 * A recipe form as the backend's input: open the screen, then require its
 * element. The runner waits for every marker, so no separate wait step is needed.
 */
export function captureRecipeInput(form: CaptureRecipeForm): CaptureRecipeInput {
  const masks = selectorList(form.masks)
  const optionalMasks = selectorList(form.optionalMasks ?? '')
  const forbidden = selectorList(form.forbidden ?? '')
  const allowedPostPaths = selectorList(form.allowedPostPaths ?? '')
  const versionPath = form.versionPath.trim()
  const versionSelector = (form.versionSelector ?? '').trim()
  const objective = form.objective.trim()
  const marker = form.marker.trim() || DEFAULT_ZERO_CONFIG_MARKER
  const sequenceShotsText = (form.sequenceShots ?? '').trim()
  const parsedShots = sequenceShotsText ? Number(sequenceShotsText) : undefined
  return {
    connectionId: form.connectionId,
    definition: {
      markers: [marker],
      schemaVersion: 1,
      steps: [{ kind: 'NAVIGATE', path: form.path.trim() }],
      viewport: {
        height: Number(form.height),
        width: Number(form.width),
        ...(form.sharp ? { scale: 2 as const } : {}),
      },
      ...(form.cropToMarker ? { crop: 'marker' as const } : {}),
      ...(form.colorScheme ? { colorScheme: form.colorScheme } : {}),
      ...(form.maskStyle === 'blur' ? { maskStyle: 'blur' as const } : {}),
      ...(form.verifyWithVision ? { verifyWithVision: true } : {}),
      ...(objective && parsedShots !== undefined && parsedShots !== 1
        ? { sequenceShots: parsedShots }
        : {}),
      ...(masks.length ? { masks } : {}),
      ...(optionalMasks.length ? { optionalMasks } : {}),
      ...(forbidden.length ? { forbidden } : {}),
      ...(allowedPostPaths.length ? { allowedPostPaths } : {}),
      ...(versionPath
        ? { version: { path: versionPath } }
        : versionSelector
          ? { version: { selector: versionSelector } }
          : {}),
      ...(objective
        ? {
            navigation: {
              objective,
              maxSteps: Number(form.navigationSteps),
              creditLimit: Number(form.navigationCredits),
              ...(form.useVision ? { useVision: true } : {}),
              ...(form.allowSearchFill ? { allowSearchFill: true } : {}),
            },
          }
        : {}),
    },
    name: form.name,
    surfaceId: form.surfaceId,
  }
}

const NAVIGATION_STEP: Record<string, string> = {
  link: 'opened',
  tab: 'selected a tab on',
  button: 'pressed a button on',
  fill: 'filtered on',
  scroll: 'scrolled on',
  frame: 'framed the result on',
}

/** The AI's path to the screen as one sentence, or null without one. */
export function captureNavigationSummary(job: Pick<CaptureJob, 'navigationActions'>) {
  if (!job.navigationActions?.length) return null
  return `AI ${job.navigationActions
    .map((step) => `${NAVIGATION_STEP[step.kind] ?? step.kind} ${step.path}`)
    .join(', then ')}.`
}

/** Ordered asset IDs for a capture job (multi-shot sequence when present, else primary asset). */
export function captureJobFrames(job: Pick<CaptureJob, 'assetId' | 'sequenceAssetIds'>): string[] {
  if (job.sequenceAssetIds && job.sequenceAssetIds.length > 1) return job.sequenceAssetIds
  return job.assetId ? [job.assetId] : []
}

/** An email sign-in setup's state (RFC 007A). */
export const CAPTURE_EMAIL_AUTH_STATUS = {
  DRAFT: { label: 'Not tested', tone: 'gray' },
  VERIFIED: { label: 'Tested', tone: 'green' },
  PAUSED: { label: 'Paused', tone: 'yellow' },
  REVOKED: { label: 'Removed', tone: 'gray' },
} as const satisfies Record<CaptureEmailAuth['status'], { label: string; tone: string }>

/** The states in which an email sign-in attempt is still running. */
export const ACTIVE_AUTH_ATTEMPT_STATES: ReadonlySet<CaptureAuthAttempt['state']> = new Set([
  'ADMITTED',
  'BROWSER_STARTING',
  'CHALLENGE_REQUESTED',
  'WAITING_FOR_EMAIL',
  'EMAIL_MATCHED',
  'APPLYING_CHALLENGE',
  'VERIFYING',
  'COMMITTING',
])

const EMAIL_AUTH_FAILURES: Record<string, string> = {
  auth_policy_review_required: 'A person must sign in again before automatic sign-in can renew this session.',
  cancelled: 'The sign-in was stopped.',
  challenge_ambiguous: 'The email held more than one possible link or code. Shots chose neither.',
  challenge_consumed_unknown: 'The sign-in stopped after the link or code may have been used. Start a new test.',
  challenge_expired: 'The app refused the code as wrong or expired.',
  challenge_host_refused: 'The email’s link points to a host or path the recipe does not approve.',
  challenge_not_found: 'No approved link or code was in the email.',
  config_incomplete: 'Save a login recipe and the sender list first.',
  email_delivery_timeout: 'No sign-in email arrived in time. Check that the app sends to the test address.',
  email_unmatched: 'The email did not come from an approved sender.',
  feature_disabled: 'Automatic email sign-in is off.',
  generation_stale: 'The setup or the session changed during the sign-in.',
  human_reconnect: 'A person started signing in, so the automatic sign-in stopped.',
  login_page_changed: 'The sign-in page no longer matches the recipe. Update the selectors.',
  provider_read_failed: 'Shots could not read the email from the provider.',
  rate_limited: 'This connection used today’s sign-in attempts.',
  revoked: 'Email sign-in was removed.',
  session_restore_failed: 'A fresh browser could not restore the session.',
  session_restore_unsupported: 'This app keeps its session where Shots cannot save it.',
  sign_in_incomplete: 'The app did not finish the sign-in.',
  unsupported_factor: 'The app asked for a password, CAPTCHA, or another factor. A person must sign in.',
  wrong_account: 'The app signed in as another account.',
}

/** A safe sign-in failure code, as a person reads it. */
export function emailAuthFailureMessage(code: string): string {
  return Object.hasOwn(EMAIL_AUTH_FAILURES, code)
    ? EMAIL_AUTH_FAILURES[code]!
    : `The sign-in failed (${code.replaceAll('_', ' ')}).`
}

/** A login recipe form's text, before it is parsed. */
export type LoginRecipeForm = {
  method: CaptureLoginRecipe['method']
  startPath: string
  emailInput: string
  requestChallenge: string
  challengeConfirmation: string
  submitPaths: string
  linkHosts: string
  linkPaths: string
  codeInput: string
  codeLength: string
  submitCode: string
  expectedSenders: string
}

/** An empty login recipe form, or one filled from the saved version. */
export function loginRecipeForm(setup: CaptureEmailAuth | null): LoginRecipeForm {
  const recipe = setup?.recipe
  return {
    method: recipe?.method ?? 'MAGIC_LINK',
    startPath: recipe?.startPath ?? '/login',
    emailInput: recipe?.emailInput ?? '',
    requestChallenge: recipe?.requestChallenge ?? '',
    challengeConfirmation: recipe?.challengeConfirmation ?? '',
    submitPaths: (recipe?.submitPaths ?? []).join(', '),
    linkHosts: (recipe?.linkHosts ?? []).join(', '),
    linkPaths: (recipe?.linkPaths ?? []).join(', '),
    codeInput: recipe?.codeInput ?? '',
    codeLength: recipe?.codeLength ? String(recipe.codeLength) : '6',
    submitCode: recipe?.submitCode ?? '',
    expectedSenders: (setup?.expectedSenders ?? []).join(', '),
  }
}

/** A login recipe form as the backend's input; only the chosen method's fields go. */
export function loginRecipeInput(form: LoginRecipeForm): {
  recipe: CaptureLoginRecipe
  expectedSenders: string[]
} {
  const optional = (value: string) => (value.trim() ? value.trim() : undefined)
  const base = {
    schemaVersion: 1 as const,
    method: form.method,
    startPath: form.startPath.trim(),
    emailInput: form.emailInput.trim(),
    requestChallenge: form.requestChallenge.trim(),
    challengeConfirmation: optional(form.challengeConfirmation),
    submitPaths: hostList(form.submitPaths),
  }
  const recipe: CaptureLoginRecipe =
    form.method === 'MAGIC_LINK'
      ? { ...base, linkHosts: hostList(form.linkHosts), linkPaths: hostList(form.linkPaths) }
      : {
          ...base,
          codeInput: form.codeInput.trim(),
          codeLength: Number.parseInt(form.codeLength, 10),
          submitCode: optional(form.submitCode),
        }
  return { recipe, expectedSenders: hostList(form.expectedSenders) }
}
