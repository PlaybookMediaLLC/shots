import assert from 'node:assert/strict'
import test from 'node:test'
import { listSenjaVideos, SenjaError, senjaVideoFile } from '../lib/content-drafts/senja'
import type { Transport } from '../lib/launch/safe-fetch'

// Senja's API and its media, answered here: no key or network reaches Senja.
const testimonial = (id: string, video_url: string | null = `https://media.example/${id}.mp4`) => ({
  customer_name: 'Ada Lovelace',
  id,
  thumbnail_url: 'https://media.example/thumb.jpg',
  video: { duration: 42 },
  video_url,
})

const media = (
  contentType: string
): { resolve: () => Promise<{ address: string; family: number }[]>; transport: Transport } => ({
  resolve: async () => [{ address: '93.184.216.34', family: 4 }],
  transport: async () => ({
    status: 200,
    headers: { 'content-type': contentType },
    body: (async function* () {
      yield Buffer.from([0, 0, 0, 24, 102, 116, 121, 112])
    })(),
    destroy() {},
  }),
})

test('the newest approved video testimonials are listed with the workspace key alone', async () => {
  const seen: URL[] = []
  const request: typeof fetch = async (input, init) => {
    seen.push(new URL(String(input)))
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer senja-key-1')
    return Response.json({
      testimonials: [
        testimonial('t1'),
        testimonial('text-only', null),
        { ...testimonial('pending'), approved: false },
        // One odd testimonial drops only itself.
        { customer_name: 'No id' },
      ],
    })
  }
  const videos = await listSenjaVideos('senja-key-1', request)
  assert.deepEqual(videos, [
    {
      customerName: 'Ada Lovelace',
      durationSeconds: 42,
      id: 't1',
      thumbnailUrl: 'https://media.example/thumb.jpg',
    },
  ])
  assert.equal(seen[0]!.origin + seen[0]!.pathname, 'https://api.senja.io/v1/testimonials')
  assert.deepEqual(Object.fromEntries(seen[0]!.searchParams), {
    approved: 'true',
    limit: '100',
    order: 'desc',
    sort: 'date',
    type: 'video',
  })
})

test('a refused key, an unreachable Senja and an unreadable answer each say so', async () => {
  const answer = (response: Response | null) => async () => {
    if (!response) throw new TypeError('fetch failed')
    return response
  }
  const failure = async (request: typeof fetch) =>
    listSenjaVideos('key-12345', request).then(
      () => assert.fail('listed'),
      (error: unknown) => {
        assert.ok(error instanceof SenjaError)
        return error.status
      }
    )
  // A refused key is the workspace's to fix.
  assert.equal(await failure(answer(new Response('', { status: 401 }))), 422)
  assert.equal(await failure(answer(null)), 503)
  assert.equal(await failure(answer(new Response('', { status: 500 }))), 503)
  assert.equal(await failure(answer(Response.json({ items: [] }))), 503)
})

test('an import re-reads the testimonial by id and takes only its MP4', async () => {
  const paths: string[] = []
  const request: typeof fetch = async (input) => {
    const url = new URL(String(input))
    paths.push(url.pathname)
    if (url.pathname.endsWith('/gone')) return new Response('', { status: 404 })
    if (url.pathname.endsWith('/text')) return Response.json(testimonial('text', null))
    return Response.json({ testimonial: testimonial('t/1') })
  }
  const file = await senjaVideoFile('key-12345', 't/1', { media: media('video/mp4'), request })
  assert.deepEqual(paths, ['/v1/testimonials/t%2F1'])
  assert.equal(file.contentType, 'video/mp4')
  assert.equal(file.fileName, 'senja-Ada-Lovelace.mp4')
  assert.equal(file.bytes.length, 8)

  const status = (promise: Promise<unknown>) =>
    promise.then(
      () => assert.fail('imported'),
      (error: unknown) => (error instanceof SenjaError ? error.status : error)
    )
  assert.equal(await status(senjaVideoFile('key-12345', 'gone', { request })), 404)
  assert.equal(await status(senjaVideoFile('key-12345', 'text', { request })), 422)
  assert.equal(
    await status(senjaVideoFile('key-12345', 't1', { media: media('text/html'), request })),
    422
  )
})

test('an imported file name is ASCII, as Go stores it, and an unapproved one is refused', async () => {
  const named = (customer_name: string, approved?: boolean) => {
    const request: typeof fetch = async () =>
      Response.json({ ...testimonial('t1'), approved, customer_name })
    return senjaVideoFile('key-12345', 't1', { media: media('video/mp4'), request })
  }
  assert.equal((await named('José García')).fileName, 'senja-Jose-Garcia.mp4')
  assert.equal((await named('山田 太郎')).fileName, 'senja-testimonial.mp4')
  await assert.rejects(named('Ada', false), /not approved/)
  // A CDN may label an MP4 generically; Go probes the bytes when they are stored.
  const generic = await senjaVideoFile('key-12345', 't1', {
    media: media('application/octet-stream'),
    request: async () => Response.json(testimonial('t1')),
  })
  assert.equal(generic.contentType, 'video/mp4')
})
