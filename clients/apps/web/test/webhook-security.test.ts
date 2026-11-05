import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import {
  sourceAppCreateSchema,
  sourceAppUpdateSchema,
  sourceWebhookSetupSchema,
} from '@/lib/tenant/schemas'
import {
  getWebhookIntent,
  deriveSourceWebhookSecret,
  hasFreshWebhookTimestamp,
  verifyGenericWebhookSignature,
  verifyGitLabWebhookSignature,
  verifyWebhookSignature,
  type WebhookIntent,
  type WebhookSourceRule,
} from '@/lib/tenant/webhook-security'

const defaults = {
  branch: null,
  externalId: null,
  ignoreBotPullRequests: true,
  ignoredPullRequestAuthors: [],
  skipPrereleases: false,
}
const github: WebhookSourceRule = { ...defaults, provider: 'github' }
const gitlab: WebhookSourceRule = { ...defaults, provider: 'gitlab' }

function parse(
  source: WebhookSourceRule,
  eventName: string | null,
  payload: unknown,
  contentType = 'application/json'
) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return getWebhookIntent({ body, contentType, deliveryId: 'delivery-1', eventName, source })
}

/** The key a delivery's intent is stored under, so cases compare in one line. */
function key(intent: WebhookIntent | null): string | null {
  if (!intent) return null
  switch (intent.kind) {
    case 'change':
      return `pr:${intent.change.repositoryId}:${intent.change.number}`
    case 'deployment':
      return `deployment:${intent.deployment.externalId}`
    case 'release':
      return intent.eventId
  }
}

function releaseOf(intent: WebhookIntent | null) {
  assert.ok(intent?.kind === 'release', `expected a release, got ${intent?.kind}`)
  return intent
}

function changeOf(intent: WebhookIntent | null) {
  assert.ok(intent?.kind === 'change', `expected a change, got ${intent?.kind}`)
  return intent.change
}

function githubRelease(action: string, release: Record<string, unknown> = {}) {
  return {
    action,
    release: { body: 'Faster exports', id: 77, name: 'v1.2.0', tag_name: 'v1.2.0', ...release },
    repository: { id: 123 },
  }
}

function gitlabRelease(action: string) {
  return {
    action,
    description: 'Short notes',
    name: 'v3',
    tag: 'v3',
    url: 'https://gitlab.com/acme/app/-/releases/v3',
  }
}

function pullRequest(
  event: { action?: string; base?: string; defaultBranch?: string; repo?: number } = {},
  pr: Record<string, unknown> = {}
) {
  return {
    action: event.action ?? 'closed',
    number: 452,
    pull_request: {
      base: { ref: event.base ?? 'main' },
      body: null,
      html_url: 'https://github.com/acme/app/pull/452',
      merged: true,
      merged_at: '2026-10-16T10:00:00Z',
      number: 452,
      title: 'Add recurring invoices',
      ...pr,
    },
    repository: { default_branch: event.defaultBranch ?? 'main', id: event.repo ?? 123 },
  }
}

test('webhook signatures use a timing-safe HMAC comparison', () => {
  const body = '{"title":"Launch","benefitStatement":"Faster exports"}'
  const secret = 'webhook-secret'
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  assert.equal(verifyWebhookSignature(body, signature, secret), true)
  assert.equal(verifyWebhookSignature(body, `${signature}0`, secret), false)
  assert.equal(verifyWebhookSignature(`${body} `, signature, secret), false)
  assert.equal(verifyWebhookSignature(body, signature.replace('sha256=', 'sha1='), secret), false)
  assert.equal(verifyWebhookSignature(body, null, secret), false)
})

test('a published GitHub release is keyed on its release ID, not the delivery', () => {
  assert.deepEqual(parse(github, 'release', githubRelease('published')), {
    eventId: 'release:123:77',
    kind: 'release',
    notes: 'Faster exports',
    release: { benefitStatement: 'Faster exports', title: 'v1.2.0' },
    repositoryId: '123',
  })
  assert.equal(hasFreshWebhookTimestamp(new Date().toISOString()), true)
  assert.equal(
    hasFreshWebhookTimestamp(new Date(Date.now() - 10 * 60 * 1_000).toISOString()),
    false
  )
})

test('GitLab signing tokens bind a fresh event ID, timestamp, and body', () => {
  const body = JSON.stringify({ action: 'create', description: 'GitLab release', name: 'v2.0.0' })
  const eventId = 'gitlab-event'
  const timestamp = Math.floor(Date.now() / 1_000).toString()
  const rawSecret = Buffer.from('gitlab-signing-secret')
  const signingToken = `whsec_${rawSecret.toString('base64')}`
  const message = `${eventId}.${timestamp}.${body}`
  const signature = `v1,${createHmac('sha256', rawSecret).update(message).digest('base64')}`
  assert.equal(
    verifyGitLabWebhookSignature({ body, eventId, signature, signingToken, timestamp }),
    true
  )
  assert.deepEqual(
    getWebhookIntent({
      body,
      contentType: 'application/json',
      deliveryId: eventId,
      eventName: 'Release Hook',
      source: gitlab,
    }),
    {
      eventId,
      kind: 'release',
      notes: 'GitLab release',
      release: { benefitStatement: 'GitLab release', title: 'v2.0.0' },
    }
  )
})

test('long release notes stay short in the brief and are kept in full as notes', () => {
  const url = 'https://github.com/acme/ledgerly/releases/tag/v2.0.0'
  const body = 'Recurring invoices send themselves. '.repeat(4_000)
  const release = releaseOf(
    parse(github, 'release', githubRelease('published', { body, html_url: url }))
  )
  assert.equal(release.release.benefitStatement.length, 500)
  assert.ok(release.release.benefitStatement.endsWith('…'))
  assert.deepEqual(release.release.sourceUrls, [url])
  // Notes keep up to 50,000 characters; the backend reads features from all of them.
  assert.equal(release.notes?.length, 50_000)
  const short = releaseOf(
    parse(github, 'release', githubRelease('published', { body: 'y'.repeat(501) }))
  )
  assert.equal(short.release.benefitStatement, `${'y'.repeat(499)}…`)
  assert.equal(short.notes, 'y'.repeat(501))
  const longName = releaseOf(
    parse(github, 'release', githubRelease('published', { name: 'n'.repeat(300) }))
  )
  assert.equal(longName.release.title.length, 160)
  const named = releaseOf(
    parse(github, 'release', {
      ...githubRelease('published'),
      repository: { full_name: 'acme/app', id: 123 },
    })
  )
  assert.equal(named.repositoryName, 'acme/app')
  const gitlabNotes = releaseOf(parse(gitlab, 'Release Hook', gitlabRelease('create')))
  assert.deepEqual(gitlabNotes.release.sourceUrls, ['https://gitlab.com/acme/app/-/releases/v3'])
})

test('a PR merged into the watched branch is held as a change keyed on the PR', () => {
  assert.deepEqual(parse(github, 'pull_request', pullRequest()), {
    change: {
      body: '',
      labels: [],
      mergedAt: '2026-10-16T10:00:00Z',
      number: 452,
      repositoryId: '123',
      title: 'Add recurring invoices',
      url: 'https://github.com/acme/app/pull/452',
    },
    kind: 'change',
  })
  const detailed = changeOf(
    parse(
      github,
      'pull_request',
      pullRequest(
        {},
        {
          body: 'Ships invoices.',
          labels: [{ name: 'feature' }, { name: 'billing' }],
          user: { login: 'octocat', type: 'User' },
        }
      )
    )
  )
  assert.equal(detailed.authorLogin, 'octocat')
  assert.deepEqual(detailed.labels, ['feature', 'billing'])
  assert.equal(detailed.body, 'Ships invoices.')
  const develop = { ...github, branch: 'develop', externalId: '123' }
  assert.equal(key(parse(develop, 'pull_request', pullRequest({ base: 'develop' }))), 'pr:123:452')
  const trunk = pullRequest({ base: 'trunk', defaultBranch: 'trunk' })
  assert.equal(key(parse(github, 'pull_request', trunk)), 'pr:123:452')
  const otherRepo = pullRequest({ repo: 456 })
  assert.equal(key(parse(github, 'pull_request', otherRepo)), 'pr:456:452')
})

test("a hook on GitHub's default form content type delivers the same JSON in a payload field", () => {
  const form = `payload=${encodeURIComponent(JSON.stringify(pullRequest()))}`
  const contentType = 'application/x-www-form-urlencoded'
  assert.equal(key(parse(github, 'pull_request', form, contentType)), 'pr:123:452')
  const ping = `payload=${encodeURIComponent(JSON.stringify({ zen: 'Design for failure.' }))}`
  assert.equal(parse(github, 'ping', ping, contentType), null)
})

test('pings, pushes, unmerged, off-branch, and other-repo PRs, and release edits are ignored', () => {
  const ignored = [
    parse(github, 'ping', { zen: 'Keep it simple.' }),
    parse(github, 'ping', ''),
    parse(github, 'push', { ref: 'refs/heads/main' }),
    parse(github, 'issues', { action: 'opened' }),
    parse(github, null, pullRequest()),
    parse(github, 'pull_request', pullRequest({}, { merged: false })),
    parse(github, 'pull_request', pullRequest({ base: 'develop' })),
    parse({ ...github, externalId: '999' }, 'pull_request', pullRequest()),
    parse({ ...github, branch: 'develop' }, 'pull_request', pullRequest()),
    // Every other PR action, whatever shape its payload takes.
    parse(github, 'pull_request', pullRequest({ action: 'opened' }, { merged: false })),
    parse(github, 'pull_request', pullRequest({ action: 'labeled' }, { merged: null })),
    parse(github, 'pull_request', { action: 'synchronize', pull_request: {} }),
    // A pre-release fires published too; every other release action is noise.
    ...['created', 'edited', 'deleted', 'released', 'prereleased', 'unpublished'].map((action) =>
      parse(github, 'release', { action, release: 'not parsed' })
    ),
  ]
  assert.deepEqual(ignored, Array(ignored.length).fill(null))
})

test('GitLab creates a release only for a new release; other hooks would get it disabled', () => {
  assert.equal(
    releaseOf(parse(gitlab, 'Release Hook', gitlabRelease('create'))).release.title,
    'v3'
  )
  const ignored = [
    parse(gitlab, 'Release Hook', gitlabRelease('update')),
    parse(gitlab, 'Release Hook', gitlabRelease('delete')),
    parse(gitlab, 'Push Hook', 'not json'),
    parse(gitlab, 'Merge Request Hook', { object_attributes: { action: 'merge' } }),
    parse(gitlab, null, gitlabRelease('create')),
  ]
  assert.deepEqual(ignored, Array(ignored.length).fill(null))
})

test('third-party text is cleaned and cut to fit before it reaches Postgres', () => {
  const change = (pr: Record<string, unknown>) =>
    changeOf(parse(github, 'pull_request', pullRequest({}, pr)))
  assert.equal(change({ body: 'a\u0000b\u200Bc' }).body, 'abc')
  assert.equal(change({ title: 'Dark\u0000 mode' }).title, 'Dark mode')
  assert.equal(
    change({ body: '<!-- Describe your change -->\nDark mode everywhere.' }).body,
    'Dark mode everywhere.'
  )
  assert.equal(change({ body: '<!-- TODO -->\n  ' }).body, '')
  assert.equal(change({ body: 'Visible <!-- unclosed' }).body, 'Visible')
  assert.equal(change({ title: 'x'.repeat(300) }).title, 'x'.repeat(300))
  assert.equal(change({ title: 'x'.repeat(301) }).title, `${'x'.repeat(299)}…`)
  // An emoji across the cut is dropped whole, never split into a lone surrogate.
  assert.equal(change({ title: `${'x'.repeat(298)}🚀🚀` }).title, `${'x'.repeat(298)}…`)
  assert.equal(change({ body: 'y'.repeat(10_001) }).body.length, 10_000)
  const notes = releaseOf(
    parse(github, 'release', githubRelease('published', { body: '<!-- x -->Notes\u0000 here' }))
  )
  assert.equal(notes.notes, 'Notes here')
})

test('a shipped event with a malformed payload is rejected, so the failure is visible', () => {
  assert.throws(() => parse(github, 'pull_request', { action: 'closed', pull_request: {} }))
  assert.throws(() => parse(github, 'release', { action: 'published', release: {} }))
  assert.throws(() => parse(github, 'pull_request', 'not json'))
  const form = 'application/x-www-form-urlencoded'
  assert.throws(() => parse(github, 'pull_request', 'other=1', form))
})

test('a GitHub source must name a repository by ID and a branch by name', () => {
  const source = {
    allowedHosts: ['https://api.github.com'],
    name: 'GitHub',
    provider: 'github',
  }
  const valid = (input: Record<string, unknown>) =>
    sourceAppCreateSchema.safeParse({ ...source, ...input }).success
  assert.equal(valid({ branch: 'release/2026.10', externalId: '123' }), true)
  assert.equal(valid({ branch: '  main  ' }), true)
  assert.equal(valid({ branch: 'refs/heads/main' }), false)
  assert.equal(valid({ branch: 'my branch' }), false)
  assert.equal(valid({ branch: '   ' }), false)
  assert.equal(valid({ branch: 'b'.repeat(256) }), false)
  assert.equal(valid({ externalId: 'acme/app' }), false)
  assert.equal(valid({ externalId: 'acme/app', provider: 'generic' }), true)
})

const human = { login: 'octocat', type: 'User' }

test('bot-authored pull requests are ignored by default; a merge bot landing a person’s PR is not', () => {
  const merged = (user: unknown, source = github, extra: Record<string, unknown> = {}) =>
    key(parse(source, 'pull_request', pullRequest({}, { user, ...extra })))
  assert.equal(merged(human), 'pr:123:452')
  assert.equal(merged(null), 'pr:123:452')
  assert.equal(merged(undefined), 'pr:123:452')
  assert.equal(merged({ login: 'dependabot[bot]', type: 'Bot' }), null)
  assert.equal(merged({ login: 'renovate[bot]', type: 'Bot' }), null)
  assert.equal(merged({ login: 'some-app', type: 'Bot' }), null)
  assert.equal(merged({ login: 'Mergify[BOT]', type: 'User' }), null)
  assert.equal(
    merged(human, github, { merged_by: { login: 'mergify[bot]', type: 'Bot' } }),
    'pr:123:452'
  )
  const keepBots = { ...github, ignoreBotPullRequests: false }
  assert.equal(merged({ login: 'dependabot[bot]', type: 'Bot' }, keepBots), 'pr:123:452')
})

test('listed authors are ignored case-insensitively, with or without the bot filter', () => {
  const merged = (login: string, type: string, source: WebhookSourceRule) =>
    key(parse(source, 'pull_request', pullRequest({}, { user: { login, type } })))
  const listed = { ...github, ignoredPullRequestAuthors: ['Snyk-Bot', 'dependabot[bot]'] }
  assert.equal(merged('snyk-bot', 'User', listed), null)
  assert.equal(merged('SNYK-BOT', 'User', listed), null)
  assert.equal(merged('octocat', 'User', listed), 'pr:123:452')
  // Only Dependabot: bots in general are kept, the listed one is not.
  const onlyDependabot = { ...listed, ignoreBotPullRequests: false }
  assert.equal(merged('dependabot[bot]', 'Bot', onlyDependabot), null)
  assert.equal(merged('renovate[bot]', 'Bot', onlyDependabot), 'pr:123:452')
})

test('pre-releases create releases unless the source skips them', () => {
  const published = (source: WebhookSourceRule, prerelease: unknown) =>
    key(parse(source, 'release', githubRelease('published', { prerelease })))
  const skipping = { ...github, skipPrereleases: true }
  assert.equal(published(github, true), 'release:123:77')
  assert.equal(published(skipping, true), null)
  assert.equal(published(skipping, false), 'release:123:77')
  assert.equal(published(skipping, null), 'release:123:77')
  assert.equal(published(skipping, undefined), 'release:123:77')
})

test('a correctly signed release from another repository is ignored by a source that names one', () => {
  const body = JSON.stringify({ ...githubRelease('published'), repository: { id: 999 } })
  const secret = 'webhook-secret'
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  assert.equal(verifyWebhookSignature(body, signature, secret), true)
  const published = (externalId: string | null) =>
    key(parse({ ...github, externalId }, 'release', body))
  assert.equal(published('123'), null)
  assert.equal(published('999'), 'release:999:77')
  // A source that names no repository takes releases from any.
  assert.equal(published(null), 'release:999:77')
})

test('a generic signature binds the event ID and timestamp to the body', () => {
  const secret = 'generic-secret'
  const body = '{"title":"Launch","benefitStatement":"Faster exports"}'
  const timestamp = new Date().toISOString()
  const sign = (eventId: string, at: string, signed = body) =>
    `v1=${createHmac('sha256', secret).update(`${eventId}.${at}.${signed}`).digest('hex')}`
  const verify = (input: Partial<Parameters<typeof verifyGenericWebhookSignature>[0]>) =>
    verifyGenericWebhookSignature({
      body,
      eventId: 'evt-1',
      secret,
      signature: sign('evt-1', timestamp),
      timestamp,
      ...input,
    })
  assert.equal(verify({}), true)
  // A captured request replayed under a new ID or a fresh timestamp fails.
  assert.equal(verify({ eventId: 'evt-2' }), false)
  assert.equal(verify({ timestamp: new Date(Date.now() + 1_000).toISOString() }), false)
  assert.equal(verify({ body: `${body} ` }), false)
  assert.equal(verify({ secret: 'other-secret' }), false)
  // The old body-only signature is no longer accepted.
  const bodyOnly = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  assert.equal(verify({ signature: bodyOnly }), false)
  assert.equal(verify({ signature: bodyOnly.replace('sha256=', 'v1=') }), false)
  assert.equal(verify({ signature: sign('evt-1', timestamp).replace('v1=', '') }), false)
  for (const missing of ['eventId', 'signature', 'timestamp'] as const) {
    assert.equal(verify({ [missing]: null }), false, missing)
  }
  // Correctly signed, but outside the five-minute window either way.
  for (const offset of [-6 * 60_000, 6 * 60_000]) {
    const at = new Date(Date.now() + offset).toISOString()
    assert.equal(verify({ signature: sign('evt-1', at), timestamp: at }), false, String(offset))
  }
  const almost = new Date(Date.now() - 4 * 60_000).toISOString()
  assert.equal(verify({ signature: sign('evt-1', almost), timestamp: almost }), true)
})

test('source rules validate on create and update', () => {
  const source = { allowedHosts: ['https://api.github.com'], name: 'GitHub', provider: 'github' }
  const create = (input: Record<string, unknown>) =>
    sourceAppCreateSchema.safeParse({ ...source, ...input }).success
  assert.equal(create({ ignoreBotPullRequests: false, skipPrereleases: true }), true)
  assert.equal(create({ ignoredPullRequestAuthors: ['dependabot[bot]', 'Snyk-Bot'] }), true)
  assert.equal(create({ ignoredPullRequestAuthors: ['bad login!'] }), false)
  assert.equal(create({ ignoredPullRequestAuthors: ['-leading'] }), false)
  assert.equal(create({ ignoredPullRequestAuthors: ['a'.repeat(40)] }), false)
  assert.equal(create({ ignoredPullRequestAuthors: Array(101).fill('octocat') }), false)
  assert.equal(create({ ignoreBotPullRequests: 'yes' }), false)
  const update = (input: unknown) => sourceAppUpdateSchema.safeParse(input).success
  assert.equal(update({ branch: null }), true)
  assert.equal(update({ branch: 'develop' }), true)
  assert.equal(update({ ignoredPullRequestAuthors: [] }), true)
  assert.equal(update({ skipPrereleases: true }), true)
  assert.equal(update({}), false)
  assert.equal(update({ branch: undefined }), false)
  assert.equal(update({ provider: 'gitlab' }), false)
  assert.equal(update({ branch: 'refs/heads/main' }), false)
  assert.equal(update({ branch: '' }), false)
})

test('a source without an operator secret gets one derived from the platform key', () => {
  const key = 'k'.repeat(32)
  const secret = deriveSourceWebhookSecret(key, 'source00001')
  assert.match(secret, /^whsec_[A-Za-z0-9_-]{43}$/)
  // Stable, so verification recomputes what was shown; distinct per source and key.
  assert.equal(deriveSourceWebhookSecret(key, 'source00001'), secret)
  assert.notEqual(deriveSourceWebhookSecret(key, 'source00002'), secret)
  assert.notEqual(deriveSourceWebhookSecret('j'.repeat(32), 'source00001'), secret)
  // A delivery GitHub signs with the shown secret verifies.
  const body = JSON.stringify({ zen: 'Practicality beats purity.' })
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  assert.equal(verifyWebhookSignature(body, signature, secret), true)
  assert.equal(
    verifyWebhookSignature(body, signature, deriveSourceWebhookSecret(key, 'source00002')),
    false
  )
  const setup = { secret, url: 'https://studio.example/api/webhooks/source/source00001' }
  assert.deepEqual(sourceWebhookSetupSchema.parse(setup), setup)
})

function deploymentStatus(
  status: Record<string, unknown> = {},
  deployment: Record<string, unknown> = {},
  repo = 123
) {
  return {
    action: 'created',
    deployment: { environment: 'production', id: 9001, sha: 'abc123', ...deployment },
    deployment_status: {
      environment: 'production',
      environment_url: 'https://app.acme.test',
      state: 'success',
      ...status,
    },
    repository: { id: repo },
  }
}

test('a successful production deployment is recorded once per deployment', () => {
  assert.deepEqual(parse(github, 'deployment_status', deploymentStatus()), {
    deployment: {
      environment: 'production',
      externalId: '9001',
      sha: 'abc123',
      url: 'https://app.acme.test',
    },
    kind: 'deployment',
  })
  // GitHub marks a production environment even when it is named otherwise.
  const named = deploymentStatus({ environment: 'prod-us' }, { production_environment: true })
  assert.equal(key(parse(github, 'deployment_status', named)), 'deployment:9001')
  // The status target URL is used when no environment URL is set; http is dropped.
  const target = deploymentStatus({ environment_url: null, target_url: 'https://ci.acme.test/1' })
  assert.equal(
    (parse(github, 'deployment_status', target) as { deployment: { url?: string } }).deployment.url,
    'https://ci.acme.test/1'
  )
  const insecure = deploymentStatus({ environment_url: 'http://app.acme.test', target_url: null })
  const noUrl = parse(github, 'deployment_status', insecure) as { deployment: { url?: string } }
  assert.equal(noUrl.deployment.url, undefined)
  const ignored = [
    parse(github, 'deployment_status', deploymentStatus({ state: 'failure' })),
    parse(github, 'deployment_status', deploymentStatus({ state: 'in_progress' })),
    parse(
      github,
      'deployment_status',
      deploymentStatus({ environment: 'staging' }, { environment: 'staging' })
    ),
    parse({ ...github, externalId: '999' }, 'deployment_status', deploymentStatus()),
    parse(github, 'deployment_status', { ...deploymentStatus(), action: 'edited' }),
    parse(github, 'deployment', { action: 'created' }),
  ]
  assert.deepEqual(ignored, Array(ignored.length).fill(null))
})
