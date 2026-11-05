import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ScreenshotStudioBackendSDK } from '../../../packages/screenshot-studio-backend-sdk/src'
import { SignInPanel } from '@/components/workflows/CaptureSignInPanel'
import {
  captureConnectionInputSchema,
  captureConnectStartSchema,
  captureOverviewSchema,
  captureRecipeInputSchema,
  type CaptureOverview,
} from '@/lib/api/contracts/capture'
import {
  activeRecipeForSurface,
  captureConnectionInput,
  captureInProgress,
  captureRecipeInput,
  latestCaptureTest,
  workflowCaptureRecipes,
} from '@/lib/workflows/capture'

const recipeForm = {
  connectionId: 'connection_1',
  height: '900',
  marker: ' [data-testid=invoices] ',
  masks: '.email, .phone\n\n  .card > .number  \n',
  name: 'Billing',
  path: '/billing',
  surfaceId: 'surface_1',
  versionPath: ' ',
  width: '1440',
}

const connection = {
  createdAt: '2026-11-04T12:00:00Z',
  environment: 'demo',
  expectedAccount: 'demo@example.com',
  failureCode: null,
  generation: 0,
  hosts: ['app.example.com'],
  id: 'connection_1',
  identitySelector: '#account',
  connectPhase: null,
  loginHosts: [],
  name: 'Demo',
  origin: 'https://app.example.com',
  protectedPath: '/settings',
  revokedAt: null,
  sourceAppId: 'source_1',
  stateExpiresAt: null,
  status: 'READY',
  updatedAt: '2026-11-04T12:00:00Z',
  validatedAt: null,
} satisfies CaptureOverview['connections'][number]

const recipe = {
  connectionId: 'connection_1',
  createdAt: '2026-11-04T12:00:00Z',
  definition: captureRecipeInput(recipeForm).definition,
  hash: 'abc',
  id: 'recipe_1',
  name: 'Billing',
  status: 'ACTIVE',
  surfaceId: 'surface_1',
  testedAt: null,
  version: 2,
} satisfies CaptureOverview['recipes'][number]

const job = {
  assetId: null,
  attempts: 0,
  connectionId: 'connection_1',
  createdAt: '2026-11-04T12:00:00Z',
  deploymentEventId: null,
  expectedRevision: null,
  failureCode: null,
  id: 'job_1',
  kind: 'test',
  phase: 'QUEUED',
  recipeId: 'recipe_1',
  recipeVersion: 2,
  surfaceCaptureId: null,
  surfaceId: 'surface_1',
  updatedAt: '2026-11-04T12:00:00Z',
} satisfies CaptureOverview['jobs'][number]

const overview: CaptureOverview = {
  available: true,
  connections: [connection],
  jobs: [],
  recipes: [recipe],
}

test('the overview parses the records the backend returns', () => {
  const parsed = captureOverviewSchema.parse({ ...overview, jobs: [job] })
  assert.deepEqual(parsed, { ...overview, jobs: [job] })
})

test('the sign-in link must be https, and a refused link is never repeated', () => {
  const start = { expiresAt: '2026-11-04T12:00:00Z', intentId: 'intent' }
  const liveViewUrl = 'https://live.example/session?token=secret'
  assert.equal(captureConnectStartSchema.parse({ ...start, liveViewUrl }).liveViewUrl, liveViewUrl)
  for (const unsafe of ['javascript:alert(1)//secret', 'http://live.example/secret']) {
    const result = captureConnectStartSchema.safeParse({ ...start, liveViewUrl: unsafe })
    assert.equal(result.success, false)
    assert.doesNotMatch(JSON.stringify(result.error?.issues), /secret/)
  }
})

test('the sign-in link opens without sharing a referrer or reaching autocapture', () => {
  const html = renderToStaticMarkup(
    createElement(SignInPanel, {
      busy: false,
      onFinish: () => undefined,
      start: {
        expiresAt: '2026-11-04T12:00:00Z',
        intentId: 'intent',
        liveViewUrl: 'https://live.example/session',
      },
    })
  )
  assert.match(html, /<a [^>]*href="https:\/\/live\.example\/session"/)
  assert.match(html, /<a [^>]*target="_blank"/)
  assert.match(html, /<a [^>]*rel="noopener noreferrer"/)
  assert.match(html, /<a [^>]*referrerPolicy="no-referrer"/i)
  assert.match(html, /<a [^>]*class="[^"]*ph-no-capture/)
})

test('a connection form becomes bounded backend input', () => {
  const form = {
    environment: 'demo' as const,
    expectedAccount: 'demo@example.com',
    hosts: 'app.example.com, api.example.com\n*.cdn.example.com',
    identitySelector: '#account',
    loginHosts: '',
    name: 'Demo',
    origin: 'https://app.example.com',
    protectedPath: '/settings',
    sourceAppId: '',
  }
  const input = captureConnectionInput(form)
  assert.deepEqual(input.hosts, ['app.example.com', 'api.example.com', '*.cdn.example.com'])
  assert.deepEqual(input.loginHosts, [])
  assert.equal(input.sourceAppId, undefined)
  assert.equal(captureConnectionInputSchema.safeParse(input).success, true)
  assert.equal(
    captureConnectionInputSchema.safeParse(captureConnectionInput({ ...form, hosts: ' ' })).success,
    false
  )
  const hosts = Array.from({ length: 11 }, (_, index) => `h${index}.example.com`).join(',')
  const tooMany = captureConnectionInputSchema.safeParse(captureConnectionInput({ ...form, hosts }))
  assert.equal(tooMany.error?.issues[0]?.message, 'Approve at most 10 hosts.')
})

test('a recipe form opens the screen and requires its element', () => {
  const input = captureRecipeInput(recipeForm)
  assert.deepEqual(input.definition, {
    markers: ['[data-testid=invoices]'],
    // One selector per line, because a selector may hold a comma.
    masks: ['.email, .phone', '.card > .number'],
    schemaVersion: 1,
    steps: [{ kind: 'NAVIGATE', path: '/billing' }],
    viewport: { height: 900, width: 1440 },
  })
  assert.equal(captureRecipeInputSchema.safeParse(input).success, true)
  const proven = captureRecipeInput({ ...recipeForm, masks: '', versionPath: '/api/version' })
  assert.deepEqual(proven.definition.version, { path: '/api/version' })
  assert.equal('masks' in proven.definition, false)
  const huge = captureRecipeInputSchema.safeParse(
    captureRecipeInput({ ...recipeForm, width: '4000' })
  )
  assert.equal(huge.error?.issues[0]?.message, 'Use a viewport from 320×320 up to 1920×1080.')
})

test('the page polls while a sign-in is being checked or a job can still move', () => {
  assert.equal(captureInProgress(overview), false)
  const finishing = { ...connection, connectPhase: 'FINISHING' }
  assert.equal(captureInProgress({ ...overview, connections: [finishing] }), true)
  assert.equal(
    captureInProgress({ ...overview, connections: [{ ...connection, connectPhase: 'OPEN' }] }),
    false
  )
  for (const [phase, moving] of [
    ['QUEUED', true],
    ['WAITING_DEPLOYMENT', true],
    ['RUNNING', true],
    ['NEEDS_AUTH', false],
    ['SUCCEEDED', false],
    ['FAILED', false],
    ['CANCELLED', false],
  ] as const) {
    assert.equal(captureInProgress({ ...overview, jobs: [{ ...job, phase }] }), moving, phase)
  }
})

test('a recipe shows its own newest test, not a later job of another kind', () => {
  const later = { ...job, id: 'job_0', kind: 'manual' as const }
  const older = { ...job, id: 'job_2' }
  assert.equal(latestCaptureTest([later, job, older], 'recipe_1')?.id, 'job_1')
  assert.equal(latestCaptureTest([job], 'other'), undefined)
})

test('only an active recipe of this surface replaces a public screenshot', () => {
  const draft = { ...recipe, id: 'draft', status: 'DRAFT' as const }
  const elsewhere = { ...recipe, id: 'elsewhere', surfaceId: 'surface_2' }
  assert.equal(activeRecipeForSurface([draft, elsewhere], 'surface_1'), undefined)
  assert.equal(activeRecipeForSurface([draft, recipe, elsewhere], 'surface_1')?.id, 'recipe_1')
})

test('a workflow offers only active recipes the backend would run for its repository', () => {
  const list = (changes: Partial<CaptureOverview>) =>
    workflowCaptureRecipes({ ...overview, ...changes }, 'source_1').map((item) => item.id)
  assert.deepEqual(list({}), ['recipe_1'])
  assert.deepEqual(list({ recipes: [{ ...recipe, status: 'DRAFT' }] }), [])
  assert.deepEqual(list({ connections: [{ ...connection, sourceAppId: 'source_2' }] }), [])
  assert.deepEqual(list({ connections: [{ ...connection, status: 'REVOKED' }] }), [])
})

test('the SDK calls each capture route in the workspace scope', async () => {
  const requests: string[] = []
  const sdk = new ScreenshotStudioBackendSDK(
    'https://backend.example',
    'service-secret',
    {
      organizationId: 'org-1',
      requestId: 'req-1',
      sessionId: 'session-1',
      userId: 'user-1',
    },
    async (input, init) => {
      assert.equal(new Headers(init?.headers).get('x-organization-id'), 'org-1')
      requests.push(`${init?.method} ${new URL(String(input)).pathname} ${init?.body ?? ''}`.trim())
      return Response.json({})
    }
  )
  await sdk.captureOverview()
  await sdk.startCaptureConnect('c/1')
  await sdk.finishCaptureConnect('c1', 'intent')
  await sdk.revokeCaptureConnection('c1')
  await sdk.activateCaptureRecipe('r1')
  await sdk.archiveCaptureRecipe('r1')
  await sdk.requestCaptureJob('r1', { test: true })
  await sdk.cancelCaptureJob('j1')
  assert.deepEqual(requests, [
    'GET /v1/capture',
    'POST /v1/capture/connections/c%2F1/connect',
    'POST /v1/capture/connections/c1/connect/finish {"intentId":"intent"}',
    'POST /v1/capture/connections/c1/revoke',
    'POST /v1/capture/recipes/r1/activate',
    'POST /v1/capture/recipes/r1/archive',
    'POST /v1/capture/recipes/r1/jobs {"test":true}',
    'POST /v1/capture/jobs/j1/cancel',
  ])
})
