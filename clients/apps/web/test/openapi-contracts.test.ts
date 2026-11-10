import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'
import { type RouteContract, routeContractSchema } from '@/lib/api/contract'
import { documentedContracts } from '@/lib/api/contracts'
import * as ai from '@/lib/api/contracts/ai'
import * as approvals from '@/lib/api/contracts/approvals'
import * as assets from '@/lib/api/contracts/assets'
import * as audit from '@/lib/api/contracts/audit'
import * as billing from '@/lib/api/contracts/billing'
import * as blueskyConnections from '@/lib/api/contracts/bluesky-connections'
import * as campaigns from '@/lib/api/contracts/campaigns'
import * as canvases from '@/lib/api/contracts/canvases'
import * as codeProjects from '@/lib/api/contracts/code-projects'
import * as contentDrafts from '@/lib/api/contracts/content-drafts'
import * as posts from '@/lib/api/contracts/posts'
import * as draftMedia from '@/lib/api/contracts/draft-media'
import * as draftCollaboration from '@/lib/api/contracts/draft-collaboration'
import * as contentDraftPlatform from '@/lib/api/contracts/content-draft-platform'
import * as writeAi from '@/lib/api/contracts/write-ai'
import * as draftBatch from '@/lib/api/contracts/draft-batch'
import * as contentBatchRuns from '@/lib/api/contracts/content-batch-runs'
import * as permissionGroups from '@/lib/api/contracts/permission-groups'
import * as whitelabel from '@/lib/api/contracts/whitelabel'
import * as contentBatches from '@/lib/api/contracts/content-batches'
import * as socialAnalytics from '@/lib/api/contracts/social-analytics'
import * as draftComments from '@/lib/api/contracts/draft-comments'
import * as draftTags from '@/lib/api/contracts/draft-tags'
import * as integrations from '@/lib/api/contracts/integrations'
import * as githubProduction from '@/lib/api/contracts/github-production'
import * as internal from '@/lib/api/contracts/internal'
import * as founderHub from '@/lib/api/contracts/founder-hub'
import * as founderHubDevices from '@/lib/api/contracts/founder-hub-devices'
import * as founderHubResources from '@/lib/api/contracts/founder-hub-resources'
import * as linkPreview from '@/lib/api/contracts/link-preview'
import * as notifications from '@/lib/api/contracts/notifications'
import * as onboardingRuns from '@/lib/api/contracts/onboarding-runs'
import * as outboundWebhooks from '@/lib/api/contracts/outbound-webhooks'
import * as releases from '@/lib/api/contracts/releases'
import * as scheduledPosts from '@/lib/api/contracts/scheduled-posts'
import * as settingsPlatform from '@/lib/api/contracts/settings-platform'
import * as sharing from '@/lib/api/contracts/sharing'
import * as shell from '@/lib/api/contracts/shell'
import * as socialMentions from '@/lib/api/contracts/social-mentions'
import * as socialCommunities from '@/lib/api/contracts/social-communities'
import * as socialConnections from '@/lib/api/contracts/social-connections'
import * as socialAvailability from '@/lib/api/contracts/social-availability'
import * as socialInstances from '@/lib/api/contracts/social-instances'
import * as socialSets from '@/lib/api/contracts/social-sets'
import * as socialSetQueue from '@/lib/api/contracts/social-set-queue'
import * as sourceApps from '@/lib/api/contracts/source-apps'
import * as storePublishing from '@/lib/api/contracts/store-publishing'
import * as storeScreenshots from '@/lib/api/contracts/store-screenshots'
import * as unsubscribe from '@/lib/api/contracts/unsubscribe'
import * as webhooks from '@/lib/api/contracts/webhooks'
import * as write from '@/lib/api/contracts/write'
import * as planAnalyze from '@/lib/api/contracts/plan-analyze'
import * as calendarNotes from '@/lib/api/contracts/calendar-notes'
import { openApiSpec } from '@/lib/api/openapi'
import { getMinimumPlan } from '@/lib/billing/plans'

const ROOT = process.cwd()

const contracts = new Map<string, RouteContract>(
  [
    ai,
    approvals,
    assets,
    audit,
    whitelabel,
    permissionGroups,
    billing,
    blueskyConnections,
    campaigns,
    canvases,
    codeProjects,
    contentDraftPlatform,
    draftMedia,
    draftCollaboration,
    writeAi,
    contentDrafts,
    posts,
    draftTags,
    draftComments,
    draftBatch,
    contentBatches,
    contentBatchRuns,
    socialAnalytics,
    integrations,
    githubProduction,
    internal,
    founderHub,
    founderHubDevices,
    founderHubResources,
    linkPreview,
    onboardingRuns,
    outboundWebhooks,
    notifications,
    releases,
    scheduledPosts,
    settingsPlatform,
    sharing,
    shell,
    socialMentions,
    socialCommunities,
    socialConnections,
    socialAvailability,
    socialInstances,
    socialSets,
    socialSetQueue,
    sourceApps,
    storePublishing,
    storeScreenshots,
    unsubscribe,
    webhooks,
    write,
    planAnalyze,
    calendarNotes,
  ]
    .flatMap((module) => Object.entries(module))
    .filter(([, value]) => routeContractSchema.safeParse(value).success)
    .map(([name, value]) => [name, value as RouteContract])
)

function routeFileFor(contract: RouteContract): string {
  return `app${contract.path.replace(/\{(\w+)\}/g, '[$1]')}/route.ts`
}

function routeFiles(directory: string): string[] {
  return readdirSync(join(ROOT, directory)).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(join(ROOT, path)).isDirectory()) return routeFiles(path)
    return entry === 'route.ts' ? [relative(ROOT, join(ROOT, path))] : []
  })
}

test('every contract is served by the route file its path names, at its method', () => {
  assert.ok(contracts.size >= 30, `only ${contracts.size} contracts were found`)
  for (const [name, contract] of contracts) {
    const file = routeFileFor(contract)
    assert.ok(existsSync(join(ROOT, file)), `${name}: ${file} does not exist`)
    const binding = new RegExp(`export const ${contract.method} = route\\(${name}\\b`)
    assert.match(readFileSync(join(ROOT, file), 'utf8'), binding, `${name} is not bound in ${file}`)
  }
})

test('every route() binding uses the contract for its own path and method', () => {
  for (const file of routeFiles('app/api')) {
    const source = readFileSync(join(ROOT, file), 'utf8')
    for (const [, method, name] of source.matchAll(/export const (\w+) = route\((\w+)\b/g)) {
      const contract = contracts.get(name)
      assert.ok(contract, `${file} binds unknown contract ${name}`)
      assert.equal(routeFileFor(contract), file, `${name} belongs to another route file`)
      assert.equal(contract.method, method, `${file} binds ${name} as ${method}`)
    }
  }
})

test('contract names and operation ids are unique', () => {
  const names = [...contracts.values()].map((contract) => `${contract.method} ${contract.name}`)
  assert.equal(new Set(names).size, names.length)
  const operationIds = documentedContracts.map((contract) => contract.docs?.operationId)
  assert.equal(new Set(operationIds).size, operationIds.length)
})

test('every documented contract appears in the public spec as generated', () => {
  const paths = openApiSpec.paths as Record<string, Record<string, { operationId?: string }>>
  for (const contract of documentedContracts) {
    const operation = paths[contract.path]?.[contract.method.toLowerCase()]
    assert.equal(operation?.operationId, contract.docs?.operationId, contract.name)
  }
})

test('the spec error envelope lists every platform error code', () => {
  const schemas = openApiSpec.components.schemas as Record<
    string,
    { properties?: { code?: { enum?: string[] } } }
  >
  assert.ok(schemas.Error.properties?.code?.enum?.includes('conflict'))
})

test('contracts accept what the Go backend actually sends', () => {
  // GET /v1/workspace omits createdAt even though the SDK type declares it;
  // a required field here would turn a working response into a 500.
  const parsed = shell.getOrganizationContract.output.safeParse({
    organization: { id: 'org_1', logo: null, name: 'Acme', role: 'owner', slug: 'acme' },
  })
  assert.ok(parsed.success)
})

test('a contract that declares access binds it, and the spec publishes it', () => {
  const paths = openApiSpec.paths as Record<string, Record<string, Record<string, unknown>>>
  for (const [name, contract] of contracts) {
    if (!contract.access) continue
    const tenant = 'apiKeyScope' in contract.access
    const auth = tenant ? 'tenantAccess' : 'memberAccess'
    const source = readFileSync(join(ROOT, routeFileFor(contract)), 'utf8')
    assert.match(
      source,
      new RegExp(`auth: ${auth}\\(${name}\\.access\\)`),
      `${name} must bind ${auth}`
    )
    if (!contract.docs) continue
    const operation = paths[contract.path][contract.method.toLowerCase()]
    const feature = contract.access.feature ?? 'workspace:use'
    assert.deepEqual(
      operation['x-shots-entitlement'],
      {
        feature,
        minimumPlan: getMinimumPlan(feature),
        ...(contract.access.quota ? { quota: contract.access.quota } : {}),
      },
      name
    )
    assert.deepEqual(
      operation.security,
      'apiKeyScope' in contract.access
        ? [{ workspaceApiKey: [contract.access.apiKeyScope] }, { workspaceSession: [] }]
        : [{ workspaceSession: [] }],
      name
    )
  }
})

test('every tenant /api/v1 operation and editor utility publishes its plan gate', () => {
  const paths = openApiSpec.paths as Record<string, Record<string, Record<string, unknown>>>
  const ungated = Object.entries(paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([, operation]) => {
        const security = JSON.stringify(operation.security ?? [])
        return security.includes('workspaceApiKey') && !operation['x-shots-entitlement']
      })
      .map(([method]) => `${method.toUpperCase()} ${path}`)
  )
  assert.deepEqual(ungated, [])
})

test('approving is human-only; agents ask for review and schedule only with post:schedule', () => {
  assert.ok(
    !('apiKeyScope' in approvals.decideCampaignApprovalContract.access),
    'approving must refuse API keys'
  )
  assert.equal(approvals.requestCampaignReviewContract.access.apiKeyScope, 'release:create')
  assert.equal(scheduledPosts.listScheduledPostsContract.access.apiKeyScope, 'artifact:read')
  for (const contract of [
    campaigns.scheduleCampaignPostContract,
    scheduledPosts.createScheduledPostContract,
    scheduledPosts.cancelScheduledPostContract,
  ]) {
    assert.equal(contract.access.apiKeyScope, 'post:schedule', contract.name)
    assert.equal(contract.access.quota, 'api:write:minute', contract.name)
  }
  // A session still needs a fresh second factor where RFC 030 asks for one.
  assert.equal(scheduledPosts.createScheduledPostContract.access.sensitive, true)
  assert.equal(scheduledPosts.cancelScheduledPostContract.access.sensitive, true)
  const schedule = campaigns.scheduleCampaignPostContract.body
  const channel = { channelConnectionId: 'cl0000000000000000000000' }
  assert.equal(schedule.parse(channel).skipLinkCheck, false)
  assert.ok(!schedule.safeParse({ ...channel, scheduledAt: '2020-01-01T09:00:00Z' }).success)
  assert.ok(!schedule.safeParse({ ...channel, status: 'APPROVED' }).success)
  const body = approvals.decideCampaignApprovalContract.body
  assert.ok(!body.safeParse({ decision: 'submit' }).success, 'submit is a review request')
  assert.ok(body.safeParse({ decision: 'approve' }).success)
  assert.ok(!body.safeParse({ decision: 'approve', organizationId: 'org_2' }).success)
})

test('posting directly takes its own opt-in scope and an idempotency key', () => {
  const contract = posts.createPostContract
  assert.equal(contract.access.apiKeyScope, 'post:publish')
  assert.equal(contract.access.feature, 'content:drafts')
  assert.equal(contract.access.quota, 'api:write:minute')
  // A stored draft stays with a person.
  assert.equal(
    (contentDrafts.scheduleContentDraftContract as { access?: unknown }).access,
    undefined
  )
  const parts = [{ text: 'Shipped' }]
  const accounts = ['cl0000000000000000000000']
  const body = { channelConnectionIds: accounts, posts: parts, publishNow: true }
  assert.ok(contract.body.safeParse(body).success)
  assert.ok(!contract.body.safeParse({ ...body, posts: [] }).success)
  assert.ok(!contract.body.safeParse({ ...body, channelConnectionIds: [] }).success)
  assert.ok(!contract.body.safeParse({ ...body, organizationId: 'org_2' }).success)
  assert.ok(
    contract.body.safeParse({
      ...body,
      platforms: { linkedin: { options: { firstComment: 'Link below' } } },
    }).success
  )
  assert.ok(
    !contract.body.safeParse({ ...body, platforms: { linkedin: { options: { automation: {} } } } })
      .success,
    'follow-ups are not part of this call'
  )
  assert.ok(!contract.headers?.safeParse({}).success, 'a retry must not be able to post twice')
  assert.ok(!contract.headers?.safeParse({ 'idempotency-key': 'short' }).success)
  assert.ok(contract.headers?.safeParse({ 'idempotency-key': 'a'.repeat(16) }).success)
})

test('new mutation bodies reject unknown fields', () => {
  const campaign = { name: 'Launch', objective: 'Adoption' }
  assert.ok(campaigns.createCampaignContract.body.safeParse(campaign).success)
  assert.ok(
    !campaigns.createCampaignContract.body.safeParse({ ...campaign, status: 'APPROVED' }).success
  )
  assert.ok(
    !campaigns.transitionCampaignContract.body.safeParse({ campaignId: 'c1', status: 'DRAFT' })
      .success
  )
  assert.ok(
    !approvals.requestCampaignReviewContract.body.safeParse({ decision: 'approve' }).success
  )
  const scheduled = {
    caption: 'Hello',
    channelConnectionId: 'cl0000000000000000000000',
    scheduledFor: '2999-01-01T09:00:00Z',
    variantId: 'cl0000000000000000000001',
  }
  assert.ok(scheduledPosts.createScheduledPostContract.body.safeParse(scheduled).success)
  assert.ok(
    !scheduledPosts.createScheduledPostContract.body.safeParse({
      ...scheduled,
      scheduledFor: '2000-01-01T00:00:00Z',
    }).success
  )
})

test('the committed OpenAPI snapshot is the document /openapi.json serves', () => {
  const committed = readFileSync(
    join(ROOT, '../../../server/internal/shotsapi/openapi.json'),
    'utf8'
  )
  assert.equal(committed, `${JSON.stringify(openApiSpec, null, 2)}\n`, 'run npm run api:generate')
})
