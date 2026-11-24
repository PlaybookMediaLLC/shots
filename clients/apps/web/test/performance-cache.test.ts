import assert from 'node:assert/strict'
import test from 'node:test'
import { QueryClient } from '@tanstack/react-query'
import { ScreenshotStudioBackendSDK } from '../../../packages/screenshot-studio-backend-sdk/src'
import { createTRPCClient, httpBatchLink, TRPCClientError } from '@trpc/client'
import { observable } from '@trpc/server/observable'
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query'
import superjson from 'superjson'
import type { AppRouter } from '@/lib/trpc/router'
import { invalidateListsLink } from '@/lib/trpc/invalidate-lists'
import { browserTRPCFetch } from '@/lib/trpc/browser-fetch'
import { productQueryOptions } from '@/lib/platform/query-options'
import { cachedThumbnail, thumbnailKey } from '@/lib/workspace/thumbnail-cache'
import { requestRead, withRequestReads } from '@/lib/auth/request-reads'
import { createTRPCContext } from '@/lib/trpc/context'
import { publicProcedure, router } from '@/lib/trpc/init'
import { loadWork, recentWorkQuery } from '@/components/platform-hub/work'

const newClient = () => new QueryClient({ defaultOptions: { queries: productQueryOptions } })

test('work discovery bounds each enabled collection and isolates partial failures and workspace caches', async () => {
  const requests: { path: string; input: unknown }[] = []
  const client = createTRPCClient<AppRouter>({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            requests.push({ path: op.path, input: op.input })
            if (op.path === 'campaign.list') {
              observer.error(TRPCClientError.from(new Error('Campaign service unavailable')))
              return
            }
            observer.next({
              result: {
                data:
                  op.path === 'release.list'
                    ? {
                        releases: [
                          {
                            id: 'release-1',
                            title: 'Older launch',
                            updatedAt: '2026-11-20T00:00:00Z',
                          },
                        ],
                      }
                    : { items: [] },
              },
            })
            observer.complete()
          }),
    ],
  })
  const work = await loadWork(client, {
    campaignsEnabled: true,
    draftsEnabled: false,
    limit: 4,
    paidPlan: true,
    search: 'Older',
  })
  assert.equal(work.partial, true)
  assert.deepEqual(
    work.items.map(({ href, title, type }) => ({ href, title, type })),
    [{ href: '/releases/release-1', title: 'Older launch', type: 'Release' }]
  )
  assert.equal(requests.length, 4)
  assert.deepEqual(requests.find(({ path }) => path === 'campaign.list')?.input, {
    limit: 4,
    search: 'Older',
    sort: 'updated',
  })
  assert.deepEqual(requests.find(({ path }) => path === 'release.list')?.input, {
    limit: 4,
    search: 'Older',
  })
  requests.length = 0
  await loadWork(client, {
    campaignsEnabled: false,
    draftsEnabled: false,
    limit: 4,
    paidPlan: true,
  })
  assert.deepEqual(
    requests.map(({ path }) => path),
    ['project.list', 'canvas.list']
  )
  requests.length = 0
  assert.deepEqual(
    await loadWork(client, {
      campaignsEnabled: true,
      draftsEnabled: false,
      limit: 4,
      paidPlan: false,
    }),
    { items: [], partial: false }
  )
  assert.equal(requests.length, 0)
  assert.notDeepEqual(
    recentWorkQuery(client, 'a', true, true, true).queryKey,
    recentWorkQuery(client, 'b', true, true, true).queryKey
  )
  assert.notDeepEqual(
    recentWorkQuery(client, 'a', true, true, true).queryKey,
    recentWorkQuery(client, 'a', true, true, false).queryKey
  )
})

test('the shared recent cache retains visuals even when releases and campaigns are newer', async () => {
  const client = createTRPCClient<AppRouter>({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            const newer = op.path === 'release.list' || op.path === 'campaign.list'
            const items = Array.from({ length: 5 }, (_, index) => ({
              id: `${op.path}-${index}`,
              name: `${op.path} ${index}`,
              title: `${op.path} ${index}`,
              updatedAt: newer ? '2026-11-20T00:00:00Z' : '2026-11-19T00:00:00Z',
              document: null,
            }))
            observer.next({
              result: {
                data:
                  op.path === 'release.list'
                    ? { releases: items }
                    : op.path === 'campaign.list'
                      ? { campaigns: items }
                      : { items },
              },
            })
            observer.complete()
          }),
    ],
  })
  const work = await recentWorkQuery(client, 'workspace', false, true, true).queryFn({
    signal: new AbortController().signal,
  })
  assert.equal(work.partial, false)
  assert.equal(work.items.length, 20)
  assert.equal(
    work.items.filter(({ type }) => type === 'Screenshot' || type === 'Canvas').length,
    10
  )
  assert.ok(work.items.slice(0, 8).every(({ type }) => type === 'Release' || type === 'Campaign'))
})

test('list pages reuse thirty-second results and imperative writes invalidate every filter', async (t) => {
  const queryClient = newClient()
  t.after(() => queryClient.clear())
  let reads = 0
  const client = createTRPCClient<AppRouter>({
    links: [
      invalidateListsLink(queryClient),
      () =>
        ({ op }) =>
          observable((observer) => {
            if (op.type === 'query') reads++
            observer.next({ result: { data: { items: [], nextCursor: null } } })
            observer.complete()
          }),
    ],
  })
  const trpc = createTRPCOptionsProxy<AppRouter>({ client, queryClient })
  const options = trpc.project.list.infiniteQueryOptions(
    { limit: 24 },
    { getNextPageParam: (page) => page.nextCursor }
  )
  const filtered = trpc.project.list.infiniteQueryOptions(
    { search: 'Launch' },
    { getNextPageParam: (page) => page.nextCursor }
  )
  await queryClient.fetchInfiniteQuery(options)
  await queryClient.fetchInfiniteQuery(options)
  assert.equal(reads, 1)
  await queryClient.fetchInfiniteQuery(filtered)
  await client.project.rename.mutate({ projectId: 'project-1', name: 'Renamed' })
  assert.equal(queryClient.getQueryState(options.queryKey)?.isInvalidated, true)
  assert.equal(queryClient.getQueryState(filtered.queryKey)?.isInvalidated, true)
  await queryClient.fetchInfiniteQuery(options)
  assert.equal(reads, 3)
  assert.equal(queryClient.getDefaultOptions().queries?.gcTime, 300_000)
  const otherSession = newClient()
  assert.equal(otherSession.getQueryData(options.queryKey), undefined)
  otherSession.clear()
})

test('the shell reuses the latest onboarding run until an onboarding change', async (t) => {
  const queryClient = newClient()
  t.after(() => queryClient.clear())
  let reads = 0
  const client = createTRPCClient<AppRouter>({
    links: [
      invalidateListsLink(queryClient),
      () =>
        ({ op }) =>
          observable((observer) => {
            if (op.type === 'query') reads++
            observer.next({ result: { data: { run: null } } })
            observer.complete()
          }),
    ],
  })
  const trpc = createTRPCOptionsProxy<AppRouter>({ client, queryClient })
  const latest = trpc.onboarding.latest.queryOptions()
  const recent = recentWorkQuery(client, 'workspace', true, true, true)
  queryClient.setQueryData(recent.queryKey, { items: [], partial: false })
  queryClient.setQueryData(['shell-search', 'workspace', 'release'], { items: [], partial: false })
  await queryClient.fetchQuery(latest)
  await queryClient.fetchQuery(latest)
  assert.equal(reads, 1)
  await client.onboarding.rerun.mutate({ runId: 'run-1' })
  assert.equal(queryClient.getQueryState(latest.queryKey)?.isInvalidated, true)
  assert.equal(queryClient.getQueryState(recent.queryKey)?.isInvalidated, true)
  assert.equal(
    queryClient.getQueryState(['shell-search', 'workspace', 'release'])?.isInvalidated,
    true
  )
})

test('a refused read (4xx) is not retried', () => {
  const retry = productQueryOptions.retry
  const refusal = Object.assign(new Error('Not on this plan.'), { status: 403 })
  const outage = Object.assign(new Error('Unavailable.'), { status: 503 })
  assert.equal(retry(0, refusal), false)
  assert.equal(retry(0, outage), true)
  assert.equal(retry(0, new Error('Network down.')), true)
  assert.equal(retry(2, outage), false)
})

test('query retries do not multiply the transport retry budget', async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return new Response('unavailable', { status: 503, headers: { 'content-type': 'text/html' } })
  })
  const queryClient = newClient()
  t.after(() => queryClient.clear())
  const client = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: 'https://example.test/api/trpc',
        transformer: superjson,
        fetch: browserTRPCFetch,
      }),
    ],
  })
  await assert.rejects(
    queryClient.fetchQuery({
      queryKey: [['project', 'list']],
      queryFn: () => client.project.list.query({}),
    })
  )
  assert.equal(calls, 3)
})

test('request reads coalesce only queries in the same request; mutations and later requests recheck', async () => {
  let reads = 0
  let allowed = true
  const access = () =>
    requestRead('access', async () => {
      reads++
      return { allowed }
    })
  const app = router({
    first: publicProcedure.query(access),
    second: publicProcedure
      .use(async ({ next }) => {
        if (!(await access()).allowed) throw new Error('forbidden')
        return next()
      })
      .query(access),
    write: publicProcedure.mutation(access),
  })
  const caller = app.createCaller(createTRPCContext(new Headers()))
  await Promise.all([caller.first(), caller.second()])
  assert.equal(reads, 1)
  await Promise.all([caller.write(), caller.write()])
  assert.equal(reads, 3)
  allowed = false
  const next = app.createCaller(createTRPCContext(new Headers()))
  await assert.rejects(next.second(), /forbidden/)
  assert.equal(reads, 4)
  await Promise.all([withRequestReads(new Map(), access), withRequestReads(new Map(), access)])
  assert.equal(reads, 6)
})

test('thumbnail cache authorizes every hit, shares generation, and isolates workspaces', async () => {
  const values = new Map<string, string>()
  const store = async () => ({
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string, options: { EX: number }) => {
      assert.equal(options.EX, 86_400)
      values.set(key, value)
    },
  })
  let renders = 0,
    checks = 0
  let allowed = true
  const authorize = async () => {
    checks++
    if (!allowed) throw new Error('forbidden')
  }
  const load = async () => {
    renders++
    return Buffer.from('webp')
  }
  const key = thumbnailKey('org-1', 'asset-1')
  const read = () => cachedThumbnail(key, authorize, load, store)
  await Promise.all([read(), read(), read()])
  assert.equal(renders, 1)
  assert.equal(checks, 3)
  await read()
  assert.equal(renders, 1)
  allowed = false
  await assert.rejects(read(), /forbidden/)
  assert.equal(renders, 1)
  assert.notEqual(key, thumbnailKey('org-2', 'asset-1'))
  assert.notEqual(key, thumbnailKey('org-1', 'asset-2'))
  assert.notEqual(thumbnailKey('a:b', 'c'), thumbnailKey('a', 'b:c'))
})

test('failed thumbnail renders are not retained and cache outages still serve images', async () => {
  const key = thumbnailKey('org-error', 'asset')
  const authorize = async () => {}
  const unavailable = async () => {
    throw new Error('redis unavailable')
  }
  await assert.rejects(
    cachedThumbnail(
      key,
      authorize,
      async () => {
        throw new Error('invalid image')
      },
      unavailable
    ),
    /invalid image/
  )
  const body = await cachedThumbnail(
    key,
    authorize,
    async () => Buffer.from('recovered'),
    unavailable
  )
  assert.equal(body.toString(), 'recovered')
})

test('page access uses one session-scoped backend request and bypasses HTTP caching', async () => {
  const calls: string[] = []
  const snapshot = { active: null, count: 0, workspace: null, features: {} }
  const sdk = new ScreenshotStudioBackendSDK(
    'https://backend.example',
    'service-secret',
    {
      kind: 'session',
      organizationId: '',
      requestId: 'request',
      sessionId: 'session',
      userId: 'user',
      display: '',
    },
    async (url, init) => {
      calls.push(new URL(String(url)).pathname)
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('x-session-id'), 'session')
      assert.equal(init?.cache, 'no-store')
      return Response.json(snapshot)
    }
  )
  assert.deepEqual(await sdk.getPageAccess(), snapshot)
  assert.deepEqual(calls, ['/v1/page-access'])
})
