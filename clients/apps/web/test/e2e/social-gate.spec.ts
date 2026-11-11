import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  apiRequest,
  chooseOption,
  connectionSchema,
  createApprovedVariant,
  createScheduledPost,
  createUploadedAsset,
  createWorkspace,
  db,
  enableTwoFactor,
  expect,
  expectSaved,
  getActiveOrganizationId,
  png,
  test,
  trpcMutation,
  type Page,
} from './framework'
import { z } from 'zod'

const secretReference = 'SOCIAL_API_KEY_GATE'
const fakeURL = process.env.E2E_SOCIAL_GATE_FAKE_URL ?? 'http://127.0.0.1:5680'

const fakeStateSchema = z.object({
  posts: z.array(
    z.object({
      caption: z.string(),
      id: z.string(),
      media: z.array(
        z.object({
          bytes: z.number(),
          contentType: z.string(),
          expires: z.string(),
          sha256: z.string(),
          signedAt: z.string(),
        })
      ),
    })
  ),
  requests: z.number(),
})

async function fakeState() {
  return fakeStateSchema.parse(await (await fetch(`${fakeURL}/state`)).json())
}

async function resetFake(mode: 'normal' | 'throttle-once' | 'server-error-once'): Promise<void> {
  const response = await fetch(`${fakeURL}/control`, {
    body: JSON.stringify({ mode }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })
  expect(response.status).toBe(200)
}

/** Due soon enough for the Temporal timer to fire inside the test. */
function soon(): Date {
  return new Date(Date.now() + 15_000)
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/** The fake destinations and social organization dev/social-gate created. */
async function readBootstrap() {
  return z
    .object({
      destinationId: z.string().min(1),
      expiredDestinationId: z.string().min(1),
      goOrganizationId: z.string().min(1),
      tiktokDestinationId: z.string().min(1),
      youtubeDestinationId: z.string().min(1),
    })
    .parse(JSON.parse(await readFile(process.env.E2E_SOCIAL_GATE_BOOTSTRAP!, 'utf8')))
}

/** Bind a workspace to the gate's social organization. */
async function bindWorkspace(organizationId: string, goOrganizationId: string): Promise<void> {
  await db.query('DELETE FROM social_tenant_binding WHERE "secretReference" = $1', [
    secretReference,
  ])
  await db.query(
    `INSERT INTO social_tenant_binding ("organizationId", "goOrganizationId", "secretReference")
     VALUES ($1, $2, $3)`,
    [organizationId, goOrganizationId, secretReference]
  )
}

async function connect(page: Page, externalAccountId: string, platform = 'e2e'): Promise<string> {
  const response = await trpcMutation(page, 'channelConnection.create', {
    externalAccountId,
    platform,
    secretReference,
  })
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  return connectionSchema.parse(response.body).connection.id
}

async function statusOf(id: string) {
  return (await db.row<{ status: string }>('SELECT status FROM scheduled_post WHERE id = $1', [id]))
    ?.status
}

function awaitStatus(id: string, status: string) {
  return expect.poll(() => statusOf(id), { intervals: [1_000], timeout: 180_000 }).toBe(status)
}

function attemptsOf(id: string) {
  return db.rows<{ outcome: string | null; providerPostId: string | null }>(
    'SELECT outcome, "providerPostId" FROM publication_attempt WHERE "scheduledPostId" = $1',
    [id]
  )
}

// dev/social-gate connects fake-provider destinations through an isolated
// product API; outside that script there is nothing to publish to.
test.skip(!process.env.E2E_SOCIAL_GATE_BOOTSTRAP, 'Run through dev/social-gate.')

test('the backend worker publishes once through Go, retries, honors cancellation, and fails closed', async ({
  identity,
  page,
}) => {
  test.setTimeout(15 * 60_000)
  const bootstrap = await readBootstrap()
  await resetFake('normal')
  await createWorkspace(identity, page)
  await enableTwoFactor(page, identity.password)
  const organizationId = await getActiveOrganizationId(page)
  try {
    await bindWorkspace(organizationId, bootstrap.goOrganizationId)
    const variantId = await createApprovedVariant(page)
    const connectionId = await connect(page, bootstrap.destinationId)

    // One canonical post, even when the request is repeated.
    const first = await createScheduledPost(
      page,
      connectionId,
      'social-gate-success',
      variantId,
      soon()
    )
    expect(first.response.status, JSON.stringify(first.response.body)).toBe(200)
    expect(first.scheduledPost.status).toBe('SCHEDULED')
    const duplicate = await createScheduledPost(
      page,
      connectionId,
      'social-gate-success',
      variantId
    )
    expect(duplicate.scheduledPost.id).toBe(first.scheduledPost.id)
    expect((await fakeState()).requests).toBe(0)

    await expect.poll(async () => (await fakeState()).posts.length, { timeout: 180_000 }).toBe(1)
    await awaitStatus(first.scheduledPost.id, 'PUBLISHED')
    const remote = await fakeState()
    expect(remote.requests).toBe(1)
    expect(remote.posts[0]).toMatchObject({
      caption: 'The launch is ready.',
      media: [
        {
          bytes: png.length,
          contentType: 'image/png',
          expires: '86400',
          sha256: sha256(png),
        },
      ],
    })
    const [attempt, ...extraAttempts] = await attemptsOf(first.scheduledPost.id)
    expect(extraAttempts).toHaveLength(0)
    expect(attempt?.outcome).toBe('SUCCEEDED')
    expect(attempt?.providerPostId).toBe(remote.posts[0]?.id)
    expect(remote.posts[0]?.media[0]?.signedAt).toMatch(/^\d{8}T\d{6}Z$/)
    expect(
      await db.row<{ count: string }>(
        'SELECT count(*)::text AS count FROM "Post" WHERE "organizationId" = $1',
        [bootstrap.goOrganizationId]
      )
    ).toEqual({ count: '0' })

    // A cancelled post never reaches the destination after its due time.
    const cancelled = await createScheduledPost(
      page,
      connectionId,
      'social-gate-cancelled',
      variantId,
      soon()
    )
    expect(
      await trpcMutation(page, 'scheduledPost.cancel', {
        scheduledPostId: cancelled.scheduledPost.id,
      })
    ).toMatchObject({ body: { scheduledPost: { status: 'CANCELLED' } }, status: 200 })
    // Proving an absence needs a boundary. A second post, scheduled after the
    // cancelled one and due no earlier, is that boundary: once the worker has
    // published it, it has worked through the cancelled post's due time, and
    // the cancelled row is still untouched. A fixed wait only proved that
    // nothing happened within the wait, and cost the gate 30 s every run.
    const marker = await createScheduledPost(
      page,
      connectionId,
      'social-gate-cancel-marker',
      variantId,
      soon()
    )
    await awaitStatus(marker.scheduledPost.id, 'PUBLISHED')
    expect(await statusOf(cancelled.scheduledPost.id)).toBe('CANCELLED')
    expect((await fakeState()).requests).toBe(2)
    const actions = await db.rows<{ action: string }>(
      `SELECT action FROM audit_log WHERE "organizationId" = $1 AND action LIKE 'post.%'`,
      [organizationId]
    )
    expect(new Set(actions.map((row) => row.action))).toEqual(
      new Set(['post.connection_created', 'post.scheduled', 'post.cancelled', 'post.published'])
    )

    // A throttled provider accepted nothing, so it is retried into exactly one remote post.
    await resetFake('throttle-once')
    const retry = await createScheduledPost(
      page,
      connectionId,
      'social-gate-throttle-once',
      variantId,
      soon()
    )
    await expect.poll(async () => (await fakeState()).posts.length, { timeout: 180_000 }).toBe(1)
    await awaitStatus(retry.scheduledPost.id, 'PUBLISHED')
    const retried = await fakeState()
    expect(retried.requests).toBe(2)
    expect(retried.posts).toHaveLength(1)
    expect(
      (await attemptsOf(retry.scheduledPost.id)).filter((item) => item.outcome === 'SUCCEEDED')
    ).toHaveLength(1)

    // A server error after the publish request may hide an accepted post, so it is
    // never resent: one request, and the outcome is unknown until a person checks.
    await resetFake('server-error-once')
    const failed = await createScheduledPost(
      page,
      connectionId,
      'social-gate-server-error-once',
      variantId,
      soon()
    )
    await awaitStatus(failed.scheduledPost.id, 'UNKNOWN_DELIVERY')
    // eslint-disable-next-line no-restricted-syntax -- Proves no durable retry resends the post later; an absence needs a window.
    await page.waitForTimeout(30_000)
    expect(await statusOf(failed.scheduledPost.id)).toBe('UNKNOWN_DELIVERY')
    const unresent = await fakeState()
    expect(unresent.requests).toBe(1)
    expect(unresent.posts).toHaveLength(0)

    // An expired provider credential fails the post without publishing.
    await resetFake('normal')
    const expiredConnectionId = await connect(page, bootstrap.expiredDestinationId)
    const expired = await createScheduledPost(
      page,
      expiredConnectionId,
      'social-gate-expired',
      variantId,
      soon()
    )
    await awaitStatus(expired.scheduledPost.id, 'FAILED')
    expect((await fakeState()).posts).toHaveLength(0)
    expect(
      (await attemptsOf(expired.scheduledPost.id)).some((item) => item.outcome === 'FAILED')
    ).toBe(true)
  } finally {
    await db.query('DELETE FROM social_tenant_binding WHERE "organizationId" = $1', [
      organizationId,
    ])
  }
})

/** Two more 1x1 PNGs (red, blue), so an image's position in a post is visible by its hash. */
const red = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64'
)
const blue = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC',
  'base64'
)

test('the backend worker publishes draft photos, video, and ordered images once through Go', async ({
  identity,
  page,
}) => {
  test.setTimeout(10 * 60_000)
  const bootstrap = await readBootstrap()
  await resetFake('normal')
  await createWorkspace(identity, page)
  await enableTwoFactor(page, identity.password)
  const organizationId = await getActiveOrganizationId(page)
  try {
    await bindWorkspace(organizationId, bootstrap.goOrganizationId)
    const connectionId = await connect(page, bootstrap.destinationId)
    const mp4 = await readFile('../../../server/internal/mediavideo/testdata/portrait.mp4')
    // Each through the signed-upload flow, as the composer uploads.
    const upload = async (bytes: Buffer, contentType: string, fileName: string) => ({
      bytes,
      contentType,
      id: await createUploadedAsset(page, bytes, contentType, fileName),
    })
    const photo = await upload(png, 'image/png', 'photo.png')
    const clip = await upload(mp4, 'video/mp4', 'clip.mp4')
    const first = await upload(red, 'image/png', 'red.png')
    const last = await upload(blue, 'image/png', 'blue.png')
    const tiktokConnection = await connect(page, bootstrap.tiktokDestinationId, 'tiktok')
    const youtubeConnection = await connect(page, bootstrap.youtubeDestinationId, 'youtube')
    const drafts = [
      { caption: 'Unicode survives: café, naïve, 日本語, emoji 🚀 ✓', media: [photo] },
      { caption: 'A short clip.', media: [clip] },
      {
        caption: 'TikTok private clip.',
        media: [clip],
        connectionId: tiktokConnection,
        channel: 'tiktok',
        options: {
          tiktok: {
            privacy: 'SELF_ONLY',
            allowComments: false,
            allowDuet: false,
            allowStitch: false,
            brandOrganic: false,
            brandedContent: false,
            madeWithAi: false,
            consent: true,
          },
        },
      },
      {
        caption: 'YouTube private clip.',
        media: [clip],
        connectionId: youtubeConnection,
        channel: 'youtube',
        options: { youtube: { title: 'Fixture video', privacy: 'private', madeForKids: false } },
      },
      // Not the upload order, so the post's order is the draft's.
      { caption: 'Three images, in order.', media: [first, photo, last] },
    ]

    const postIds: string[] = []
    for (const draft of drafts) {
      const targetConnection = draft.connectionId ?? connectionId
      const created = await apiRequest(page, '/api/v1/content-drafts', {
        body: {
          assetIds: draft.media.map((item) => item.id),
          body: [
            { children: [{ text: draft.caption }], type: 'p' },
            ...draft.media.map((item) => ({
              assetId: item.id,
              children: [{ text: '' }],
              mimeType: item.contentType,
              type: item.contentType.startsWith('video/') ? 'video' : 'img',
              url: `/api/v1/assets/${item.id}/content`,
            })),
          ],
          channelConnectionIds: [targetConnection],
          primaryPlatform: draft.channel ?? 'x',
          platformVersions: {
            schemaVersion: 1,
            versions: draft.channel
              ? [{ channel: draft.channel, mode: 'synced', options: {} }]
              : [],
          },
          plainText: draft.caption,
        },
        method: 'POST',
      })
      expect(created.status, JSON.stringify(created.body)).toBe(201)
      const { id } = z.object({ id: z.string() }).parse(created.body)
      let { version } = z.object({ version: z.number() }).parse(created.body)
      if (draft.channel) {
        const incomplete = await apiRequest(page, `/api/v1/content-drafts/${id}/schedule`, {
          body: {
            channelConnectionIds: [targetConnection],
            scheduledFor: new Date(Date.now() + 60_000).toISOString(),
            version,
          },
          method: 'POST',
        })
        expect(incomplete.status).toBe(409)
        await page.goto(`/publish/${id}`)
        // What a video platform must have is on the page, above the post.
        if (draft.channel === 'youtube') {
          await page.getByLabel('YouTube title', { exact: true }).fill('Fixture video')
          await page.getByRole('combobox', { name: 'YouTube privacy' }).click()
          await page.getByRole('option', { name: 'Private', exact: true }).click()
          await page.getByRole('combobox', { name: 'YouTube audience' }).click()
          await page.getByRole('option', { name: 'Not made for kids', exact: true }).click()
        } else {
          await page.getByRole('combobox', { name: 'TikTok privacy' }).click()
          await page.getByRole('option', { name: 'Only me', exact: true }).click()
          await page
            .getByRole('checkbox', {
              name: 'I consent to send this video to TikTok at the scheduled time.',
            })
            .check()
        }
        await expectSaved(page)
        await page.reload()
        if (draft.channel === 'youtube') {
          await expect(page.getByLabel('YouTube title', { exact: true })).toHaveValue(
            'Fixture video'
          )
          await expect(page.getByRole('combobox', { name: 'YouTube privacy' })).toHaveText(
            'Private'
          )
          await expect(page.getByRole('combobox', { name: 'YouTube audience' })).toHaveText(
            'Not made for kids'
          )
        } else {
          await expect(page.getByRole('combobox', { name: 'TikTok privacy' })).toHaveText('Only me')
          await expect(
            page.getByRole('checkbox', {
              name: 'I consent to send this video to TikTok at the scheduled time.',
            })
          ).toBeChecked()
        }
        const saved = await apiRequest(page, `/api/v1/content-drafts/${id}`)
        expect(saved.status).toBe(200)
        expect(saved.body).toMatchObject({
          platformVersions: { versions: [{ channel: draft.channel, options: draft.options }] },
        })
        version = z.object({ version: z.number() }).parse(saved.body).version
      }
      // A draft is scheduled at least 30 seconds out.
      const scheduledFor = new Date(Date.now() + 35_000).toISOString()
      const response = await apiRequest(page, `/api/v1/content-drafts/${id}/schedule`, {
        body: { channelConnectionIds: [targetConnection], scheduledFor, version },
        method: 'POST',
      })
      expect(response.status, JSON.stringify(response.body)).toBe(201)
      const { posts } = z
        .object({ posts: z.array(z.object({ id: z.string(), status: z.string() })) })
        .parse(response.body)
      expect(posts.map((post) => post.status)).toEqual(['SCHEDULED'])
      postIds.push(posts[0]!.id)
    }

    await expect
      .poll(async () => (await fakeState()).posts.length, { timeout: 180_000 })
      .toBe(drafts.length)
    for (const postId of postIds) await awaitStatus(postId, 'PUBLISHED')
    const remote = await fakeState()
    expect(remote.requests).toBe(drafts.length)
    for (const [index, draft] of drafts.entries()) {
      const [received, ...duplicates] = remote.posts.filter(
        (post) => post.caption === draft.caption
      )
      expect(duplicates).toHaveLength(0)
      expect(received).toMatchObject({
        media: draft.media.map((item) => ({
          bytes: item.bytes.length,
          contentType: item.contentType,
          expires: '86400',
          sha256: sha256(item.bytes),
        })),
      })
      const [attempt, ...extraAttempts] = await attemptsOf(postIds[index]!)
      expect(extraAttempts).toHaveLength(0)
      expect(attempt).toEqual({ outcome: 'SUCCEEDED', providerPostId: received?.id })
    }
  } finally {
    await db.query('DELETE FROM social_tenant_binding WHERE "organizationId" = $1', [
      organizationId,
    ])
  }
})

test('a grid video rendered in the browser and scheduled in the background publishes once', async ({
  identity,
  page,
}) => {
  test.setTimeout(10 * 60_000)
  const bootstrap = await readBootstrap()
  await resetFake('normal')
  await createWorkspace(identity, page)
  await enableTwoFactor(page, identity.password)
  const organizationId = await getActiveOrganizationId(page)
  try {
    await bindWorkspace(organizationId, bootstrap.goOrganizationId)
    const connectionId = await connect(page, bootstrap.destinationId)
    const created = await apiRequest(page, '/api/v1/content-batches', {
      body: { title: 'Grid gate' },
      method: 'POST',
    })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const batch = z.object({ id: z.string(), timeZone: z.string() }).parse(created.body)

    // The real wizard and browser render: nothing in the video is a fixture file.
    await page.goto(`/publish/batches/${batch.id}?start=grid`)
    await chooseOption(page.getByLabel('Quick start'), 'Tech')
    await page.getByLabel('Caption 1', { exact: true }).fill('Grid gate video')
    await page.getByRole('slider', { name: 'Number of videos' }).focus()
    await page.keyboard.press('Home')
    await page.getByRole('button', { name: 'Make 1 video concept', exact: true }).click()
    await expect(page.getByTestId('grid-concept')).toHaveCount(1)
    await page.getByLabel('Upload images for all videos').setInputFiles(
      (['red', 'green', 'blue', 'black'] as const).map((name, index) => ({
        buffer: [red, png, blue, png][index]!,
        mimeType: 'image/png',
        name: `${name}.png`,
      }))
    )
    await expect(page.getByTestId('grid-readiness')).toContainText('1 of 1 videos ready', {
      timeout: 120_000,
    })
    await page.getByRole('button', { name: 'Continue to render', exact: true }).click()
    await page.getByRole('button', { name: 'Render 1 video', exact: true }).click()
    await expect(
      page.getByTestId('grid-render-list').getByText('Done', { exact: true })
    ).toBeVisible({ timeout: 300_000 })

    const itemsSchema = z.object({
      items: z.array(
        z.object({
          draft: z.object({ version: z.number() }).nullable(),
          draftId: z.string().nullable(),
          id: z.string(),
          media: z.array(z.object({ assetId: z.string() })),
        })
      ),
    })
    const read = async () =>
      itemsSchema.parse((await apiRequest(page, `/api/v1/content-batches/${batch.id}`)).body)
    const [concept] = (await read()).items
    const caption = 'Grid gate caption, delivered once'
    // Due shortly: local minutes, at least 30 seconds out as a draft must be.
    const due = new Date(Date.now() + 120_000)
    const localTime = new Intl.DateTimeFormat('sv-SE', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: batch.timeZone,
    })
      .format(due)
      .replace(' ', 'T')
    const staged = await apiRequest(
      page,
      `/api/v1/content-batches/${batch.id}/items/${concept!.id}`,
      {
        body: {
          caption,
          channelConnectionIds: [connectionId],
          timing: { localTime, mode: 'time', timeZone: batch.timeZone },
        },
        method: 'PATCH',
      }
    )
    expect(staged.status, JSON.stringify(staged.body)).toBe(200)

    await page.reload()
    await page.getByRole('button', { name: 'Save ready items as drafts', exact: true }).click()
    await expect(page.getByRole('link', { name: /^Open draft/ })).toBeVisible({ timeout: 60_000 })

    const submit = {
      items: [{ channelConnectionIds: [connectionId], itemId: concept!.id }],
      requestKey: `grid-gate-${organizationId}`,
    }
    const started = await apiRequest(page, `/api/v1/content-batches/${batch.id}/submit`, {
      body: submit,
      method: 'POST',
    })
    expect(started.status, JSON.stringify(started.body)).toBe(200)
    const runSchema = z.object({
      id: z.string(),
      items: z.array(
        z.object({
          error: z.string().optional(),
          postIds: z.array(z.string()).optional(),
          status: z.string(),
        })
      ),
      status: z.string(),
    })
    const run = runSchema.parse(started.body)
    // Nobody is watching from here: the worker finishes the schedule on its own.
    await page.goto('/publish')
    await expect
      .poll(
        async () =>
          runSchema.parse(
            (await apiRequest(page, `/api/v1/content-batches/${batch.id}/runs/${run.id}`)).body
          ).status,
        { timeout: 120_000 }
      )
      .toBe('FINISHED')
    const finished = runSchema.parse(
      (await apiRequest(page, `/api/v1/content-batches/${batch.id}/runs/${run.id}`)).body
    )
    expect(finished.items[0]?.status, finished.items[0]?.error).toBe('DONE')
    const [postId, ...others] = finished.items[0]?.postIds ?? []
    expect(others).toHaveLength(0)
    // Submitting again replays the run: no second post, no second charge.
    const replayed = await apiRequest(page, `/api/v1/content-batches/${batch.id}/submit`, {
      body: submit,
      method: 'POST',
    })
    expect(runSchema.parse(replayed.body).id).toBe(run.id)

    await awaitStatus(postId!, 'PUBLISHED')
    const remote = await fakeState()
    const [received, ...duplicates] = remote.posts.filter((post) => post.caption === caption)
    expect(duplicates).toHaveLength(0)
    const assetId = (await read()).items[0]!.media[0]!.assetId
    const video = await page.context().request.get(`/api/v1/assets/${assetId}/content`)
    const bytes = await video.body()
    expect(received).toMatchObject({
      media: [{ bytes: bytes.length, contentType: 'video/mp4', sha256: sha256(bytes) }],
    })
    const [attempt, ...extraAttempts] = await attemptsOf(postId!)
    expect(extraAttempts).toHaveLength(0)
    expect(attempt).toEqual({ outcome: 'SUCCEEDED', providerPostId: received?.id })
  } finally {
    await db.query('DELETE FROM social_tenant_binding WHERE "organizationId" = $1', [
      organizationId,
    ])
  }
})
