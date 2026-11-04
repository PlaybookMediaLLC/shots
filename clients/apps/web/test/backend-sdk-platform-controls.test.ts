import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ScreenshotStudioBackendSDK } from '../../../packages/screenshot-studio-backend-sdk/src'

type RecordedRequest = { body?: unknown; headers: Headers; method?: string; path: string }

function recordingSDK(scope: ConstructorParameters<typeof ScreenshotStudioBackendSDK>[2]) {
  const requests: RecordedRequest[] = []
  const sdk = new ScreenshotStudioBackendSDK(
    'https://backend.example',
    'service-secret',
    scope,
    async (input, init) => {
      requests.push({
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: new Headers(init?.headers),
        method: init?.method,
        path: new URL(String(input)).pathname,
      })
      return Response.json({})
    }
  )
  return { requests, sdk }
}

test('audit-control SDK forwards the sealed secret and the audit fingerprint', async () => {
  const { requests, sdk } = recordingSDK({
    organizationId: 'org-1',
    requestId: 'req-1',
    sessionId: 'session-1',
    userId: 'user-1',
  })
  const audit = { ipHash: 'hash-1', userAgentSummary: 'agent' }

  await sdk.listAuditDrains()
  await sdk.createAuditDrain(
    {
      encryptedSigningSecret: 'iv.tag.body',
      endpoint: 'https://logs.example',
      name: 'SIEM',
      provider: 'GENERIC',
    },
    audit
  )
  await sdk.deleteAuditDrain('drain/1', audit)
  await sdk.getAuditRetention()
  await sdk.updateAuditRetention({ legalHold: true, retentionDays: 120 }, audit)
  await sdk.getWhitelabel()
  await sdk.updateWhitelabel({ brandName: 'Acme' }, audit)

  assert.deepEqual(
    requests.map((request) => `${request.method} ${request.path}`),
    [
      'GET /v1/audit-drains',
      'POST /v1/audit-drains',
      'DELETE /v1/audit-drains/drain%2F1',
      'GET /v1/audit-retention',
      'PUT /v1/audit-retention',
      'GET /v1/whitelabel',
      'PUT /v1/whitelabel',
    ]
  )
  assert.equal(requests[1].headers.get('x-audit-ip-hash'), 'hash-1')
  assert.equal(requests[2].headers.get('x-audit-user-agent-summary'), 'agent')
  assert.equal(requests[0].headers.get('x-audit-ip-hash'), null)
  assert.deepEqual(requests[1].body, {
    encryptedSigningSecret: 'iv.tag.body',
    endpoint: 'https://logs.example',
    name: 'SIEM',
    provider: 'GENERIC',
  })
})

test('source webhook SDK resolves the source as the facade and ingests as the webhook', async () => {
  const facade = recordingSDK({
    display: 'web',
    kind: 'service',
    organizationId: '',
    requestId: 'r',
  })
  await facade.sdk.getWebhookSource('source-1')
  assert.equal(facade.requests[0].path, '/v1/internal/source-apps/source-1/webhook')
  assert.equal(facade.requests[0].headers.get('x-principal-kind'), 'service')

  const webhook = recordingSDK({
    display: 'source-1',
    kind: 'webhook',
    organizationId: 'org-1',
    requestId: 'delivery-1',
  })
  await webhook.sdk.ingestSourceRelease({
    benefitStatement: 'Faster exports.',
    eventId: 'delivery-1',
    sourceAppId: 'source-1',
    title: 'v2',
  })
  const [ingest] = webhook.requests
  assert.equal(`${ingest.method} ${ingest.path}`, 'POST /v1/source-releases')
  assert.equal(ingest.headers.get('x-principal-kind'), 'webhook')
  assert.equal(ingest.headers.get('x-principal-display'), 'source-1')
  assert.equal(ingest.headers.get('x-request-id'), 'delivery-1')
})

test('service-only SDK calls reach the replay and billing routes; the contract read is scoped', async () => {
  const facade = recordingSDK({
    display: 'web',
    kind: 'service',
    organizationId: '',
    requestId: 'r',
  })
  await facade.sdk.replayOutboxEvent('event/1')
  await facade.sdk.syncWorkspaceEntitlement({
    eventId: 'evt-1',
    eventType: 'subscription.updated',
    expectedVersion: 0,
    featureOverrides: { 'asset:delete': true },
    organizationId: 'org-1',
    plan: 'enterprise',
    provider: 'billing',
    status: 'active',
    validUntil: new Date('2027-01-01T00:00:00.000Z'),
  })
  assert.deepEqual(
    facade.requests.map((request) => `${request.method} ${request.path}`),
    ['POST /v1/internal/outbox-events/event%2F1/replay', 'POST /v1/internal/billing/entitlements']
  )
  assert.equal(
    (facade.requests[1].body as { validUntil: string }).validUntil,
    '2027-01-01T00:00:00.000Z'
  )

  const owner = recordingSDK({
    organizationId: 'org-1',
    requestId: 'req-1',
    sessionId: 'session-1',
    userId: 'user-1',
  })
  await owner.sdk.getWorkspaceEntitlement()
  assert.equal(owner.requests[0].path, '/v1/entitlements/contract')
  assert.equal(owner.requests[0].headers.get('x-session-id'), 'session-1')
})
