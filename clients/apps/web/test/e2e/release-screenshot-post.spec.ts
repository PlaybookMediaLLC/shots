import sharp from 'sharp'
import {
  caretAtDocumentEnd,
  createUploadedAsset,
  db,
  draftEditor,
  expect,
  expectSaved,
  openSchedule,
  type Page,
  requestJson,
  test,
  trpcMutation,
} from './framework'

/**
 * A release's screenshot becomes its posts: the release page opens the
 * screenshot in the editor with the workspace's active brand kit, the post
 * dialog writes X and LinkedIn captions from the release summary, and the
 * draft keeps the release and schedules one post per platform. A caption
 * the brand forbids is refused at scheduling, with the brand's reason.
 * Posts are scheduled for tomorrow, so nothing publishes during the test.
 */

test.use({ actionTimeout: 30_000, viewport: { height: 900, width: 1440 } })

const kitBackground = [0x0f, 0x76, 0x6e] as const
const summary = 'Named views ship to every plan.'

type PostRow = { caption: string; platform: string; status: string }

async function draftPosts(draftId: string): Promise<PostRow[]> {
  return await db.rows<PostRow>(
    `SELECT p.caption, c.platform, p.status::text AS status
       FROM scheduled_post p JOIN channel_connection c ON c.id = p."channelConnectionId"
       WHERE p."contentDraftId" = $1 ORDER BY c.platform`,
    [draftId]
  )
}

/** The RGB of the pixel 24 px in from the top-left corner of a stored asset. */
async function cornerOf(page: Page, assetId: string): Promise<number[]> {
  const stored = await page.request.get(`/api/v1/assets/${assetId}/content`)
  expect(stored.status()).toBe(200)
  const { data, info } = await sharp(await stored.body())
    .raw()
    .toBuffer({ resolveWithObject: true })
  const offset = (24 * info.width + 24) * info.channels
  return [data[offset]!, data[offset + 1]!, data[offset + 2]!]
}

test(
  'a release screenshot opens on the brand kit and schedules X and LinkedIn posts written from the release',
  // The captions come from the scripted AI model (an e2e hook, lib/e2e-hooks.ts).
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await startWorkspace({ channels: ['x', 'linkedin'], plan: 'pro' })

    const kit = await trpcMutation(page, 'brandKit.create', {
      definition: {
        colors: { accent: '#f59e0b', background: '#0f766e', text: '#111111' },
        schemaVersion: 1,
        typography: { headingFamily: 'inter' },
      },
      name: 'Release brand',
      publish: true,
    })
    expect(kit.status, JSON.stringify(kit.body)).toBe(200)
    const brand = await trpcMutation(page, 'brandProfile.upsert', {
      audience: 'Product teams',
      productDescription: 'Release-ready screenshots',
      prohibitedTerms: [{ matchMode: 'word', reason: 'A competitor name', term: 'Zorblax' }],
      tone: 'Plain',
    })
    expect(brand.status, JSON.stringify(brand.body)).toBe(200)

    // A release with a screenshot. GitHub release notes attach screenshots;
    // this workspace has no GitHub, so the fixture records the one it uploads.
    const screenshotId = await createUploadedAsset(page)
    const created = await requestJson(page, '/api/tenant/releases', {
      benefitStatement: summary,
      title: 'Named views',
    })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const releaseId = (created.body as { release: { id: string } }).release.id
    await db.query('UPDATE release SET "screenshotAssetIds" = $1::jsonb WHERE id = $2', [
      JSON.stringify([screenshotId]),
      releaseId,
    ])

    // One action from the release opens its screenshot in the editor; the link shows the screenshot.
    await app.open(`/releases/${releaseId}`)
    const openScreenshot = page.getByTestId('release-open-editor')
    await expect
      .poll(() =>
        openScreenshot.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)
      )
      .toBeGreaterThan(0)
    await openScreenshot.click()
    await page.waitForURL((url) => url.pathname.endsWith('/editor'))
    await expect(page.locator('img[alt="Main image"]')).toHaveCount(1, { timeout: 60_000 })
    // The kit applies after the image opens and says so; then the loader drops it from the address.
    await expect(page.getByText('Applied Release brand')).toBeVisible({ timeout: 30_000 })
    await expect
      .poll(() => new URL(page.url()).searchParams.has('kit'), { timeout: 30_000 })
      .toBe(false)
    expect(new URL(page.url()).searchParams.get('fromRelease')).toBe(releaseId)

    await page.getByRole('button', { exact: true, name: 'Export' }).click()
    await page.getByRole('button', { exact: true, name: 'PNG' }).click()
    await page.getByRole('button', { exact: true, name: 'Use in post' }).click()
    const prepare = page.getByRole('dialog', { name: 'Prepare post' })
    const fromRelease = prepare.getByTestId('release-summary')
    await expect(fromRelease).toContainText(summary)
    // The brief is the release's own text, so nothing is flagged to verify.
    await expect(fromRelease.getByRole('status')).toHaveCount(0)

    // The captions request carries the release summary as the writer's notes.
    const captionsRequest = page.waitForRequest((request) =>
      request.url().includes('editorAi.captions')
    )
    await fromRelease
      .getByRole('button', { name: 'Write X and LinkedIn captions from the release' })
      .click()
    expect((await captionsRequest).postData() ?? '').toContain(summary)
    await prepare.getByRole('checkbox', { name: /^X · / }).check()
    await prepare.getByRole('checkbox', { name: /^LinkedIn · / }).check()
    const caption = prepare.getByRole('textbox', { name: /^Caption · X/ })
    await expect(caption).toHaveValue(/^Meet /, { timeout: 60_000 })
    // Each platform posts the caption written for it.
    await expect(prepare.getByText('Has its own caption')).toHaveCount(2)
    const xCaption = await caption.inputValue()

    // A phrase the brand forbids reaches the draft but not the schedule.
    await caption.fill(`${xCaption} Zorblax approved.`)
    await prepare.getByRole('button', { exact: true, name: 'Create draft' }).click()
    await page.waitForURL((url) => /^\/publish\/[a-z0-9]+$/.test(url.pathname), {
      timeout: 90_000,
    })
    const draftId = new URL(page.url()).pathname.split('/').pop() ?? ''
    await expect(page.getByTestId('media-strip-item')).toHaveCount(1, { timeout: 60_000 })
    await expectSaved(page)
    const refused = await openSchedule(page)
    await refused.getByRole('button', { name: /^Tomorrow 9:00/ }).click()
    await refused.getByRole('button', { name: /^Confirm schedule/ }).click()
    await expect(refused).toContainText('A competitor name')
    expect(await draftPosts(draftId)).toEqual([])
    await page.keyboard.press('Escape')
    await expect(refused).toHaveCount(0)

    // Removed, the captions pass the brand rules and schedule once per platform.
    await caretAtDocumentEnd(page)
    const added = ' Zorblax approved.'
    for (let typed = 0; typed < added.length; typed += 1) await page.keyboard.press('Backspace')
    await expect(draftEditor(page)).not.toContainText('Zorblax')
    await expectSaved(page)
    const schedule = await openSchedule(page)
    await schedule.getByRole('button', { name: /^Tomorrow 9:00/ }).click()
    await schedule.getByRole('button', { name: /^Confirm schedule/ }).click()
    await expect.poll(async () => (await draftPosts(draftId)).length, { timeout: 30_000 }).toBe(2)
    const posts = await draftPosts(draftId)
    expect(posts.map((post) => [post.platform, post.status])).toEqual([
      ['linkedin', 'SCHEDULED'],
      ['x', 'SCHEDULED'],
    ])
    // X posts exactly what was written for it; LinkedIn posts its own caption.
    const [linkedin, x] = posts
    expect(x?.caption).toBe(xCaption)
    expect(linkedin?.caption).toMatch(/^Meet .*what changed for your team\.$/)

    // The draft keeps its release, and its picture carries the brand kit.
    const draft = await db.row<{
      assetIds: string[]
      releaseId: string | null
      scratchpad: string
    }>('SELECT "assetIds", "releaseId", scratchpad FROM content_draft WHERE id = $1', [draftId])
    expect(draft?.releaseId).toBe(releaseId)
    expect(draft?.scratchpad).toBe('')
    expect(draft?.assetIds.length).toBeGreaterThan(0)
    expect(draft?.assetIds).not.toContain(screenshotId)
    const corner = await cornerOf(page, draft!.assetIds[0]!)
    corner.forEach((value, index) =>
      expect(Math.abs(value - kitBackground[index]!)).toBeLessThan(24)
    )
    expect(errors).toEqual([])
  }
)
