import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { stripInvisible } from '@/lib/launch/sanitize'
import { releaseCreateSchema, sourceProviderSchema } from './schemas'

const webhookMaxAgeMilliseconds = 5 * 60 * 1_000

/** GitHub events a source reads; any other event is acknowledged and ignored. */
export const githubEventSchema = z.enum(['deployment_status', 'pull_request', 'release'])

/** The GitLab event a source reads; any other event is acknowledged and ignored. */
export const gitlabEventSchema = z.enum(['Release Hook'])

/**
 * The one action per event that ships something: a closed (and merged) pull
 * request, a published GitHub release, a created deployment status, a created
 * GitLab release.
 */
export const shippedActionSchema = z.enum(['closed', 'create', 'created', 'published'])

// Every delivery of these events carries an action; only the shipped one is
// parsed in full, so an edit or label change never fails on its shape.
const actionSchema = z.object({ action: z.string() })

// GitHub sends null, not an absent key, for an empty body or name. Lengths are
// not capped here: long notes are cut to fit, never rejected.
const githubReleaseSchema = z.object({
  release: z.object({
    body: z.string().nullish(),
    html_url: z.string().url().optional(),
    id: z.number().int(),
    name: z.string().nullish(),
    prerelease: z.boolean().nullish(),
    tag_name: z.string().optional(),
  }),
  repository: z.object({ full_name: z.string().nullish(), id: z.number().int() }),
})

/**
 * The fields of a closed `pull_request` event that decide and describe a
 * merge. The GitHub App webhook reads the same shape.
 */
export const githubPullRequestEventSchema = z.object({
  pull_request: z.object({
    base: z.object({ ref: z.string() }),
    body: z.string().nullish(),
    html_url: z.string().url(),
    labels: z.array(z.object({ name: z.string() })).nullish(),
    merged: z.boolean().nullish(),
    merged_at: z.string().nullish(),
    number: z.number().int().positive(),
    title: z.string(),
    // The author, not whoever merged: a merge bot landing a person's PR is not noise.
    user: z.object({ login: z.string(), type: z.string() }).nullish(),
  }),
  repository: z.object({ default_branch: z.string(), id: z.number().int() }),
})

/** A `deployment_status` event: one state change of one deployment. */
const githubDeploymentStatusSchema = z.object({
  deployment: z.object({
    environment: z.string().nullish(),
    id: z.number().int(),
    production_environment: z.boolean().nullish(),
    sha: z.string().nullish(),
  }),
  deployment_status: z.object({
    environment: z.string().nullish(),
    environment_url: z.string().nullish(),
    state: z.string(),
    target_url: z.string().nullish(),
  }),
  repository: z.object({ id: z.number().int() }),
})

/** The account type GitHub gives an App bot, whose login also ends in `[bot]`. */
const githubBotType = 'Bot'
const githubBotSuffix = '[bot]'
/** The deployment state and environment that mean the product is live. */
const githubDeploymentSuccess = 'success'
const productionEnvironment = 'production'

/** The source facts that decide which deliveries become releases. */
export const webhookSourceRuleSchema = z.object({
  branch: z.string().nullable(),
  externalId: z.string().nullable(),
  ignoreBotPullRequests: z.boolean(),
  ignoredPullRequestAuthors: z.array(z.string()),
  provider: z.string(),
  skipPrereleases: z.boolean(),
})

/** One of {@link webhookSourceRuleSchema}. */
export type WebhookSourceRule = z.infer<typeof webhookSourceRuleSchema>

/** What a verified delivery asks the backend to record. */
export const webhookIntentKindSchema = z.enum(['change', 'deployment', 'release'])

/**
 * A release to ingest under `eventId`, the key that makes a redelivery a
 * no-op, with its full notes for the backend to read features from.
 */
export const releaseIntentSchema = z.object({
  eventId: z.string().min(1).max(255),
  kind: z.literal(webhookIntentKindSchema.enum.release),
  notes: z.string().optional(),
  release: releaseCreateSchema,
  repositoryId: z.string().optional(),
  repositoryName: z.string().optional(),
})

/** A merged pull request, held until the source's next release takes it. */
export const changeIntentSchema = z.object({
  change: z.object({
    authorLogin: z.string().optional(),
    body: z.string(),
    labels: z.array(z.string()),
    mergedAt: z.string(),
    number: z.number().int().positive(),
    repositoryId: z.string(),
    title: z.string().min(1),
    url: z.string().url(),
  }),
  kind: z.literal(webhookIntentKindSchema.enum.change),
})

/** A deployment that went live in production, for the product to be captured. */
export const deploymentIntentSchema = z.object({
  deployment: z.object({
    environment: z.string().min(1),
    externalId: z.string().min(1),
    sha: z.string().optional(),
    url: z.string().url().optional(),
  }),
  kind: z.literal(webhookIntentKindSchema.enum.deployment),
})

/** Any one of the intents a delivery can carry. */
export const webhookIntentSchema = z.discriminatedUnion('kind', [
  releaseIntentSchema,
  changeIntentSchema,
  deploymentIntentSchema,
])

/** One of {@link webhookIntentSchema}. */
export type WebhookIntent = z.infer<typeof webhookIntentSchema>

const TITLE_MAX = 160

const gitlabReleaseSchema = z.object({
  description: z.string().nullish(),
  name: z.string().nullish(),
  tag: z.string().optional(),
  url: z.string().url().optional(),
})

const BENEFIT_MAX = 500

// A PR template's guidance lives in HTML comments; an unclosed one hides the rest.
const htmlComments = /<!--[\s\S]*?(?:-->|$)/g

/**
 * The first value with text left once HTML comments and invisible or control
 * characters are removed. Postgres text cannot hold NUL, so a stray one would
 * fail the delivery on every redelivery.
 */
function firstText(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const text = value && stripInvisible(value.replace(htmlComments, '')).trim()
    if (text) return text
  }
  return ''
}

/** Cut to `max` UTF-16 units, the unit zod counts, without splitting a surrogate pair. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text
    .slice(0, max - 1)
    .replace(/[\uD800-\uDBFF]$/, '')
    .trimEnd()}…`
}

/**
 * Release notes run long; the benefit statement holds their opening, and the
 * release page becomes a source the spec drafter reads in full (fetched and
 * fenced as untrusted, like any source link).
 */
function sourceRelease(title: string, notes: string, url: string | undefined) {
  return {
    benefitStatement: truncate(notes, BENEFIT_MAX),
    ...(url ? { sourceUrls: [url] } : {}),
    title: truncate(title, TITLE_MAX),
  }
}

function hasFreshTimestamp(timestamp: number): boolean {
  return Math.abs(Date.now() - timestamp) <= webhookMaxAgeMilliseconds
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

export function hasFreshWebhookTimestamp(value: string | null): boolean {
  if (!value) {
    return false
  }

  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && hasFreshTimestamp(timestamp)
}

export function verifyWebhookSignature(
  body: string,
  signature: string | null,
  secret: string
): boolean {
  if (!signature?.startsWith('sha256=')) {
    return false
  }

  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  return secureEqual(signature, expected)
}

/**
 * The webhook secret of a source with no operator-managed secret: derived from
 * the platform signing key and the source ID, so it is never stored. It is
 * shown once, when the source is created.
 *
 * ponytail: one key derives every secret, so rotating it re-keys every such
 * source and a single source cannot be rotated except by replacing it; store
 * per-source secrets in a secret manager when that matters.
 */
export function deriveSourceWebhookSecret(signingKey: string, sourceAppId: string): string {
  const digest = createHmac('sha256', signingKey).update(`source-webhook:${sourceAppId}`)
  return `whsec_${digest.digest('base64url')}`
}

/**
 * A generic source signs `<event id>.<timestamp>.<raw body>` with HMAC-SHA-256
 * and sends `v1=<hex digest>`. Binding the ID and time to the body means a
 * captured request cannot be replayed under a new ID or a fresh timestamp;
 * a replay of the same ID is a duplicate the backend already ignores.
 */
export function verifyGenericWebhookSignature(input: {
  body: string
  eventId: string | null
  secret: string
  signature: string | null
  timestamp: string | null
}): boolean {
  if (
    !input.eventId ||
    !input.signature?.startsWith('v1=') ||
    !hasFreshWebhookTimestamp(input.timestamp)
  ) {
    return false
  }

  const message = `${input.eventId}.${input.timestamp}.${input.body}`
  return secureEqual(
    input.signature,
    `v1=${createHmac('sha256', input.secret).update(message).digest('hex')}`
  )
}

export function verifyGitLabWebhookSignature(input: {
  body: string
  eventId: string | null
  signature: string | null
  signingToken: string
  timestamp: string | null
}): boolean {
  if (
    !input.eventId ||
    !input.signature ||
    !input.timestamp ||
    !input.signingToken.startsWith('whsec_')
  ) {
    return false
  }

  const seconds = Number(input.timestamp)
  if (!Number.isSafeInteger(seconds) || !hasFreshTimestamp(seconds * 1_000)) {
    return false
  }

  const secret = Buffer.from(input.signingToken.slice('whsec_'.length), 'base64')
  const message = `${input.eventId}.${input.timestamp}.${input.body}`
  const expected = `v1,${createHmac('sha256', secret).update(message).digest('base64')}`
  return input.signature.split(' ').some((signature) => secureEqual(signature, expected))
}

/**
 * Whether the source ignores a pull request by this author: any App bot when
 * bot filtering is on, and any listed login. GitHub logins are case-insensitive.
 */
function isIgnoredAuthor(
  source: WebhookSourceRule,
  user: { login: string; type: string } | null | undefined
): boolean {
  if (!user) return false
  const login = user.login.toLowerCase()
  const bot = user.type === githubBotType || login.endsWith(githubBotSuffix)
  return (
    (source.ignoreBotPullRequests && bot) ||
    source.ignoredPullRequestAuthors.some((author) => author.toLowerCase() === login)
  )
}

/** A pull request description or release notes, cleaned and cut to fit. */
function cleanText(value: string | null | undefined, max: number): string {
  return truncate(firstText(value), max)
}

const CHANGE_TITLE_MAX = 300
const CHANGE_BODY_MAX = 10_000
const NOTES_MAX = 50_000

/**
 * A pull request merged into the source's branch (the repository default when
 * unset), from the source's repository when it names one. It is held as a
 * change, keyed on the repository and PR number, for the next release.
 */
function getMergedPullRequest(source: WebhookSourceRule, payload: unknown): WebhookIntent | null {
  const { pull_request: pr, repository } = githubPullRequestEventSchema.parse(payload)
  const merged =
    pr.merged === true &&
    pr.base.ref === (source.branch ?? repository.default_branch) &&
    (source.externalId === null || source.externalId === String(repository.id)) &&
    !isIgnoredAuthor(source, pr.user)
  if (!merged) {
    return null
  }
  return webhookIntentSchema.parse({
    change: {
      ...(pr.user ? { authorLogin: pr.user.login } : {}),
      body: cleanText(pr.body, CHANGE_BODY_MAX),
      labels: (pr.labels ?? [])
        .map((label) => label.name)
        .filter(Boolean)
        .slice(0, 50),
      mergedAt: pr.merged_at ?? new Date().toISOString(),
      number: pr.number,
      repositoryId: String(repository.id),
      title: truncate(firstText(pr.title), CHANGE_TITLE_MAX),
      url: pr.html_url,
    },
    kind: webhookIntentKindSchema.enum.change,
  })
}

/**
 * A published release from the source's repository when it names one, keyed
 * on its release ID rather than the delivery ID: the signature covers the body
 * but not the delivery header, so a replayed delivery under a new ID must
 * still be a no-op.
 */
function getPublishedRelease(source: WebhookSourceRule, payload: unknown): WebhookIntent | null {
  const { release, repository } = githubReleaseSchema.parse(payload)
  if (
    (source.skipPrereleases && release.prerelease === true) ||
    (source.externalId !== null && source.externalId !== String(repository.id))
  ) {
    return null
  }
  const notes = cleanText(release.body, NOTES_MAX)
  return webhookIntentSchema.parse({
    eventId: `release:${repository.id}:${release.id}`,
    kind: webhookIntentKindSchema.enum.release,
    ...(notes ? { notes } : {}),
    release: sourceRelease(
      firstText(release.name, release.tag_name),
      firstText(release.body, release.tag_name, release.name),
      release.html_url
    ),
    repositoryId: String(repository.id),
    ...(repository.full_name ? { repositoryName: repository.full_name } : {}),
  })
}

/**
 * A deployment that succeeded in production, from the source's repository
 * when it names one, keyed on the deployment (not the status) so each
 * deployment is captured once. Only an https URL is kept.
 */
function getProductionDeployment(
  source: WebhookSourceRule,
  payload: unknown
): WebhookIntent | null {
  const {
    deployment,
    deployment_status: status,
    repository,
  } = githubDeploymentStatusSchema.parse(payload)
  const environment = status.environment ?? deployment.environment ?? ''
  const live =
    status.state === githubDeploymentSuccess &&
    (deployment.production_environment === true || environment === productionEnvironment) &&
    (source.externalId === null || source.externalId === String(repository.id))
  if (!live) {
    return null
  }
  const url = [status.environment_url, status.target_url].find(
    (value) => value && URL.canParse(value) && new URL(value).protocol === 'https:'
  )
  return webhookIntentSchema.parse({
    deployment: {
      environment: environment || productionEnvironment,
      externalId: String(deployment.id),
      ...(deployment.sha ? { sha: deployment.sha.slice(0, 64) } : {}),
      ...(url ? { url } : {}),
    },
    kind: webhookIntentKindSchema.enum.deployment,
  })
}

/** GitHub signs the body as sent; a hook left on its default `form` content type wraps the JSON in a `payload` field. */
function githubPayload(body: string, contentType: string | null): unknown {
  const form = contentType?.startsWith('application/x-www-form-urlencoded')
  return JSON.parse(form ? (new URLSearchParams(body).get('payload') ?? '') : body)
}

/**
 * What a verified delivery asks for: a release, a change, or a deployment to
 * record, or `null` for an event that ships nothing (a ping, an unmerged or
 * off-branch PR, a release edit, a push, a failed deploy). Ignored deliveries
 * are acknowledged, not rejected: a `4xx` marks the delivery failed, and
 * GitLab disables a hook after four.
 */
export function getWebhookIntent(input: {
  body: string
  contentType: string | null
  deliveryId: string
  eventName: string | null
  source: WebhookSourceRule
}): WebhookIntent | null {
  const { body, deliveryId, eventName, source } = input
  if (source.provider === sourceProviderSchema.enum.gitlab) {
    const payload = gitlabEventSchema.safeParse(eventName).success ? JSON.parse(body) : null
    if (actionSchema.safeParse(payload).data?.action !== shippedActionSchema.enum.create) {
      return null
    }
    const release = gitlabReleaseSchema.parse(payload)
    const notes = cleanText(release.description, NOTES_MAX)
    return webhookIntentSchema.parse({
      eventId: deliveryId,
      kind: webhookIntentKindSchema.enum.release,
      ...(notes ? { notes } : {}),
      release: sourceRelease(
        firstText(release.name, release.tag),
        firstText(release.description, release.tag, release.name),
        release.url
      ),
    })
  }
  if (source.provider !== sourceProviderSchema.enum.github) {
    return webhookIntentSchema.parse({
      eventId: deliveryId,
      kind: webhookIntentKindSchema.enum.release,
      release: JSON.parse(body),
    })
  }

  const event = githubEventSchema.safeParse(eventName)
  if (!event.success) {
    return null
  }
  const payload = githubPayload(body, input.contentType)
  const action = actionSchema.safeParse(payload).data?.action
  switch (event.data) {
    case githubEventSchema.enum.pull_request:
      return action === shippedActionSchema.enum.closed
        ? getMergedPullRequest(source, payload)
        : null
    case githubEventSchema.enum.deployment_status:
      return action === shippedActionSchema.enum.created
        ? getProductionDeployment(source, payload)
        : null
    case githubEventSchema.enum.release:
      return action === shippedActionSchema.enum.published
        ? getPublishedRelease(source, payload)
        : null
  }
}
