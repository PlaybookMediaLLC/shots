import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

// State contains receipts only. Never expose credentials or signed media URLs.
const state = {
  actions: [],
  engagement: { likes: 0, reposts: 0 },
  mode: 'normal',
  requests: 0,
  posts: [],
}
const mediaOrigin = process.env.SOCIAL_E2E_MEDIA_ORIGIN

function reply(response, status, body) {
  const bytes = Buffer.from(JSON.stringify(body))
  response.writeHead(status, {
    'Content-Length': bytes.length,
    'Content-Type': 'application/json',
  })
  response.end(bytes)
}

async function readJSON(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString())
}

async function mediaReceipt(item) {
  const url = new URL(item.path)
  if (url.origin !== mediaOrigin || !url.searchParams.has('X-Amz-Signature')) {
    throw new Error('unsigned or unexpected media')
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error('media fetch failed')
  const bytes = Buffer.from(await response.arrayBuffer())
  return {
    bytes: bytes.length,
    contentType: response.headers.get('content-type'),
    expires: url.searchParams.get('X-Amz-Expires'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    signedAt: url.searchParams.get('X-Amz-Date'),
  }
}

createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname
    if (request.method === 'GET' && path === '/health')
      return reply(response, 200, { status: 'ok' })
    if (request.method === 'GET' && path === '/state') return reply(response, 200, state)
    if (request.method === 'POST' && path === '/control') {
      const { engagement, mode } = await readJSON(request)
      if (engagement) {
        state.engagement = {
          likes: Number(engagement.likes) || 0,
          reposts: Number(engagement.reposts) || 0,
        }
        return reply(response, 200, { ok: true })
      }
      if (!['normal', 'throttle-once', 'server-error-once', 'refuse-thumbnail'].includes(mode)) {
        return reply(response, 400, { error: 'invalid mode' })
      }
      Object.assign(state, { actions: [], mode, posts: [], requests: 0 })
      return reply(response, 200, { ok: true })
    }
    // RFC 025 follow-ups: comments, reposts and their removal, plug replies.
    if (request.method === 'GET' && path === '/engagement')
      return reply(response, 200, state.engagement)
    if (request.method === 'POST' && path === '/actions') {
      const { kind, postId, text } = await readJSON(request)
      const id = `fake-action-${state.actions.length + 1}`
      if (kind === 'thumbnail') {
        // An unverified YouTube channel cannot set custom thumbnails.
        if (state.mode === 'refuse-thumbnail')
          return reply(response, 403, { error: 'youtube.thumbnail' })
        state.actions.push({ id, kind, postId, media: await mediaReceipt({ path: text }) })
        return reply(response, 201, { id })
      }
      state.actions.push({ id, kind, postId, text })
      return reply(response, 201, { id })
    }
    if (request.method !== 'POST' || path !== '/posts') {
      return reply(response, 404, { error: 'not found' })
    }

    const body = await readJSON(request)
    state.requests++
    if (body.accessToken !== 'valid') return reply(response, 401, { error: 'expired credential' })
    if (state.requests === 1 && state.mode === 'throttle-once') {
      return reply(response, 429, { error: 'rate limited' })
    }
    if (state.requests === 1 && state.mode === 'server-error-once') {
      return reply(response, 500, { error: 'temporary failure' })
    }
    const media = await Promise.all((body.post?.media ?? []).map(mediaReceipt))
    const remoteId =
      body.platform === 'tiktok'
        ? `7234567890123456${String(state.posts.length + 1).padStart(3, '0')}`
        : `fake-remote-${state.posts.length + 1}`
    state.posts.push({
      caption: body.post?.message,
      id: remoteId,
      media,
      platform: body.platform,
      // Upload metadata only: settings can hold signed URLs, which stay out.
      settings: {
        board: body.post?.settings?.board,
        containsSyntheticMedia: body.post?.settings?.containsSyntheticMedia,
        link: body.post?.settings?.link,
        postType: body.post?.settings?.post_type,
        tags: body.post?.settings?.tags?.map((tag) => tag.value),
        title: body.post?.settings?.title,
      },
      sourceId: body.id,
    })
    return reply(response, 201, {
      postId: remoteId,
      releaseURL:
        body.platform === 'tiktok'
          ? `https://www.tiktok.com/@fixture/video/${remoteId}`
          : body.platform === 'youtube'
            ? `https://www.youtube.com/watch?v=${remoteId}`
            : `https://fake-social.invalid/posts/${remoteId}`,
    })
  } catch {
    return reply(response, 422, { error: 'invalid social request or media' })
  }
}).listen(Number(process.env.SOCIAL_E2E_PORT ?? 8080), '0.0.0.0')
