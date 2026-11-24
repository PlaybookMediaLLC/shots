import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'
import sharp from 'sharp'
import {
  type Browser,
  chooseOption,
  db,
  type E2EIdentity,
  expect,
  getActiveOrganizationId,
  getE2EUrl,
  grantWorkspacePlan,
  openCanvasTools,
  type Page,
  requestJson,
  signUpViaApi,
  test,
  trpcMutation,
  trpcQuery,
  uploadSignedAsset,
} from './framework'
import { z } from 'zod'
import type { CanvasDocument } from '@/lib/canvas/document'

test.setTimeout(600_000)
test.use({ actionTimeout: 30_000, viewport: { width: 1600, height: 1000 } })

const SCREENSHOT = 'public/demo/demo-1.png'
const OTHER_SCREENSHOT = 'public/demo/demo-2.png'
const out = path.resolve('.context/canvas-e2e')

async function setUp(identity: E2EIdentity, page: Page) {
  await signUpViaApi(identity, page)
  const created = await trpcMutation(page, 'workspace.create', {
    name: identity.workspaceName,
    slug: identity.email.split('@')[0],
  })
  expect(created.status).toBe(200)
  const organizationId = await getActiveOrganizationId(page)
  await grantWorkspacePlan(organizationId, 'pro')
  // Cold development compilation can cancel a concurrent client navigation.
  for (const route of [
    '/canvas',
    '/canvas/new',
    '/canvas/c000000000000000000000000',
    '/render/local',
  ])
    await page.request.get(getE2EUrl(route), { timeout: 180_000 })
  await mkdir(out, { recursive: true })
  return organizationId
}

async function saved(page: Page) {
  await expect(page.getByTestId('canvas-save-status')).toHaveText('Saved to workspace', {
    timeout: 60_000,
  })
}

function canvasIdOf(page: Page) {
  return new URL(page.url()).pathname.split('/').at(-1)!
}

async function stored(page: Page, canvasId: string) {
  const result = await trpcQuery(page, 'canvas.get', { canvasId })
  expect(result.status, JSON.stringify(result.body)).toBe(200)
  return result.body as { revision: number; name: string; document: CanvasDocument }
}

const size = (document: CanvasDocument['artboards'][number]['document']) => document.canvas?.size

async function previewsReady(page: Page) {
  await expect(page.locator('[data-artboard-id] img').first()).toBeVisible({ timeout: 120_000 })
}

/** Click empty board space: it leaves the open artboard and clears the selection. */
async function clickEmptyBoard(page: Page) {
  const board = (await page.getByTestId('canvas-board').boundingBox())!
  await page.mouse.click(board.x + 12, board.y + 12)
}

async function selectArtboard(page: Page, name: string) {
  await openCanvasTools(page)
  await page.getByRole('tab', { name: 'Artboards' }).click()
  await page
    .getByRole('list', { name: 'Artboards' })
    .getByRole('button', { name: new RegExp(`^${name}`) })
    .click()
}

/** Select an artboard in the list (which brings it into view) and open it in the editor. */
async function openArtboard(page: Page, name: string) {
  await selectArtboard(page, name)
  await page.keyboard.press('Enter')
  await expect
    .poll(
      () =>
        page
          .getByTestId('canvas-active-editor')
          .evaluate((element) => getComputedStyle(element).opacity),
      { timeout: 120_000 }
    )
    .toBe('1')
  await openCanvasTools(page)
  await page.getByRole('tab', { name: 'Insert' }).click()
}

/** Render, then download, then return the saved file path. */
async function exportFiles(page: Page, options: { format?: string; only?: string[] } = {}) {
  // The header's Export; a selected artboard's inspector has its own.
  await page.getByRole('button', { name: 'Export', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Export artboards' })
  if (options.only) {
    const all = dialog.getByRole('checkbox', { name: /^All/ })
    if (await all.isChecked()) await all.uncheck()
    for (const name of options.only)
      await dialog.getByRole('checkbox', { name: new RegExp(`^${name}`) }).check()
  }
  if (options.format) await chooseOption(dialog.getByLabel('Export format'), options.format)
  await dialog.getByRole('button', { name: /^Render \d+/ }).click()
  const download = dialog.getByRole('button', { name: /^Download/ })
  const refused = dialog.getByRole('alert')
  // Stop at the first refusal and report why, rather than waiting out the timeout.
  await expect(download.and(page.locator(':enabled')).or(refused).first()).toBeVisible({
    timeout: 180_000,
  })
  expect(await refused.allTextContents()).toEqual([])
  const pending = page.waitForEvent('download')
  await download.click()
  const file = path.join(out, (await pending).suggestedFilename())
  await (await pending).saveAs(file)
  return { dialog, file }
}

async function notBlank(bytes: Buffer) {
  const stats = await sharp(bytes).stats()
  // A blank or single-colour file would have no spread in any channel.
  expect(Math.max(...stats.channels.map((channel) => channel.stdev))).toBeGreaterThan(8)
}

async function uploadWorkspaceImage(page: Page, file: string) {
  const bytes = await readFile(file)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const signed = await requestJson(page, '/api/tenant/assets/upload-url', {
    bytes: bytes.byteLength,
    classification: 'input',
    contentType: 'image/png',
    fileName: path.basename(file),
    sha256,
  })
  expect(signed.status).toBe(201)
  const body = z
    .object({ asset: z.object({ id: z.string() }), uploadUrl: z.string() })
    .parse(signed.body)
  expect(await uploadSignedAsset(page, body.uploadUrl, [...bytes], 'image/png')).toBe(200)
  expect(
    (await requestJson(page, `/api/tenant/assets/${body.asset.id}/complete`, { sha256 })).status
  ).toBe(200)
  return body.asset.id
}

test('A: a manual product announcement survives reload and exports what was composed', async ({
  app,
  identity,
  page,
}) => {
  await setUp(identity, page)
  await app.open('/projects')
  await page
    .getByRole('complementary', { name: 'Primary navigation' })
    .getByRole('link', { name: 'Library', exact: true })
    .click()
  await page.getByRole('link', { name: 'Canvas', exact: true }).first().click()
  await expect(page).toHaveURL(/\/library\?type=canvas$/)
  await page.getByRole('link', { name: /^Blank canvas/ }).click()
  await expect(page).toHaveURL(/\/canvas\/c[a-z0-9]{24}$/, { timeout: 180_000 })
  const canvasId = canvasIdOf(page)
  await previewsReady(page)
  await openCanvasTools(page)
  await page.getByRole('button', { name: '1:1 · 1080 × 1080' }).click()
  await saved(page)
  expect((await stored(page, canvasId)).document.artboards).toHaveLength(2)

  await openArtboard(page, '16:9')
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Replace screenshot' }).click()
  await (await chooser).setFiles(SCREENSHOT)
  // The file is checked before it lands, and framing an artboard with no screenshot
  // yet is refused, so the frame waits for the screenshot.
  await expect(page.locator('#image-render-card [data-main-image-layer]')).toBeVisible()
  await page.getByRole('button', { name: 'Browser window', exact: true }).click()
  await page.locator('#image-render-card [data-text-overlay-id]').first().click()
  await page.getByLabel('Text content').fill('Approvals in one place')
  await page.getByRole('button', { name: 'Subheadline', exact: true }).click()
  await page.locator('#image-render-card [data-text-overlay-id]').nth(1).click()
  await page.getByLabel('Text content').fill('Review every launch from one queue.')
  // Leave room for the headline to wrap when the artboard becomes portrait.
  const supporting = (await page
    .locator('#image-render-card [data-text-overlay-id]')
    .nth(1)
    .boundingBox())!
  const stage = (await page.locator('#image-render-card').boundingBox())!
  await page.mouse.move(supporting.x + supporting.width / 2, supporting.y + supporting.height / 2)
  await page.mouse.down()
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height * 0.8, { steps: 8 })
  await page.mouse.up()
  await saved(page)
  await page.screenshot({ path: path.join(out, 'a-composed.png') })

  // Move, resize and align on the board: each is one undo step.
  await clickEmptyBoard(page)
  await page.keyboard.press('Shift+Digit1')
  const square = page.locator('[data-artboard-label]').nth(1)
  const label = (await square.boundingBox())!
  await page.mouse.move(label.x + 8, label.y + 6)
  await page.mouse.down()
  await page.mouse.move(label.x + 8, label.y + 160, { steps: 10 })
  await page.mouse.up()
  await saved(page)
  const handle = page.locator('[data-resize-handle="e"]')
  const corner = (await handle.boundingBox())!
  await page.mouse.move(corner.x + 5, corner.y + 5)
  await page.mouse.down()
  await page.mouse.move(corner.x + 45, corner.y + 5, { steps: 6 })
  await page.mouse.up()
  await saved(page)
  await page.keyboard.press('ControlOrMeta+a')
  await page.getByRole('button', { name: 'Top', exact: true }).click()
  await saved(page)
  await selectArtboard(page, '16:9')
  await chooseOption(page.getByLabel('Size preset'), '4:5 · 1080 × 1350')
  await saved(page)

  const before = await stored(page, canvasId)
  await app.reload()
  await previewsReady(page)
  const after = await stored(page, canvasId)
  expect(after).toEqual(before)
  const [hero, other] = after.document.artboards
  expect(size(hero!.document)).toEqual({ width: 1080, height: 1350 })
  expect(hero!.document.texts.map((text) => text.text)).toEqual(
    expect.arrayContaining(['Approvals in one place', 'Review every launch from one queue.'])
  )
  expect(hero!.document.image.src).toMatch(/^asset:/)
  expect(hero!.document.image.frame?.type).toBe('browser')
  expect(other!.y).toBe(hero!.y)
  expect(size(other!.document)!.width).toBeGreaterThan(1080)
  await page.screenshot({ path: path.join(out, 'a-reloaded.png') })

  const { dialog, file } = await exportFiles(page, { only: ['16:9'] })
  const bytes = await readFile(file)
  expect(await sharp(bytes).metadata()).toMatchObject({ format: 'png', width: 1080, height: 1350 })
  await notBlank(bytes)

  // A rename from the header reaches the sidebar's Recents before its 30-second cache goes stale.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await page.getByRole('button', { name: 'Expand navigation' }).click()
  const recents = page.getByRole('region', { name: 'Recents' })
  await expect(recents.getByRole('link', { exact: true, name: 'Untitled canvas' })).toBeVisible()
  await page.getByTitle('Rename canvas', { exact: true }).click()
  const rename = page.getByRole('dialog', { name: 'Rename canvas' })
  await rename.getByLabel('Name').fill('Launch board')
  await rename.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(recents.getByRole('link', { exact: true, name: 'Launch board' })).toBeVisible()
})

test('B: a multi-artboard campaign adapts formats, persists and exports a ZIP', async ({
  app,
  identity,
  page,
}) => {
  await setUp(identity, page)
  await app.open('/canvas/new?start=template')
  await page.getByRole('button', { name: /^Feature announcement/ }).click()
  await page.getByLabel('Headline', { exact: true }).fill('Bulk approvals')
  await page.getByLabel('Supporting line').fill('Approve ten launches at once.')
  await page.getByLabel('Screenshots').setInputFiles(SCREENSHOT)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page).toHaveURL(/\/canvas\/c[a-z0-9]{24}$/, { timeout: 180_000 })
  const canvasId = canvasIdOf(page)
  await previewsReady(page)

  await selectArtboard(page, 'Bulk approvals')
  await page.getByRole('button', { name: 'Create formats…' }).first().click()
  for (const name of ['1:1 · 1080 × 1080', '4:5 · 1080 × 1350', '9:16 · 1080 × 1920'])
    await page.getByRole('checkbox', { name }).check()
  await page.getByRole('button', { name: 'Create 3' }).click()
  await saved(page)
  await selectArtboard(page, 'Bulk approvals · 1:1')
  await page.keyboard.press('ControlOrMeta+d')
  await saved(page)
  await page.getByLabel('Artboard name').fill('LinkedIn post')
  await page.getByLabel('Artboard name').press('Enter')
  await chooseOption(page.getByLabel('Size preset'), 'LinkedIn · 1200 × 627')
  await saved(page)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Tidy up' }).click()
  await saved(page)
  await page.keyboard.press('Shift+Digit1')
  await page.screenshot({ path: path.join(out, 'b-campaign-board.png') })

  await app.reload()
  await previewsReady(page)
  const document = (await stored(page, canvasId)).document
  expect(document.artboards.map((artboard) => [artboard.name, size(artboard.document)])).toEqual([
    ['Bulk approvals', { width: 1600, height: 900 }],
    ['Bulk approvals · 1:1', { width: 1080, height: 1080 }],
    ['Bulk approvals · 4:5', { width: 1080, height: 1350 }],
    ['Bulk approvals · 9:16', { width: 1080, height: 1920 }],
    ['LinkedIn post', { width: 1200, height: 627 }],
  ])
  for (const artboard of document.artboards)
    expect(artboard.document.texts.some((text) => text.text === 'Bulk approvals')).toBe(true)

  const { file } = await exportFiles(page, {
    only: ['Bulk approvals · 1:1', 'Bulk approvals · 9:16', 'LinkedIn post'],
  })
  const zip = await JSZip.loadAsync(await readFile(file))
  const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'))
  expect(manifest.canvasId).toBe(canvasId)
  const dimensions = []
  for (const entry of manifest.artboards) {
    expect(entry.documentHash).toMatch(/^[0-9a-f]{64}$/)
    const bytes = await zip.file(entry.fileName)!.async('nodebuffer')
    await notBlank(bytes)
    const metadata = await sharp(bytes).metadata()
    dimensions.push([entry.fileName.split('-').slice(2, 3)[0], metadata.width, metadata.height])
  }
  expect(dimensions.map(([, width, height]) => [width, height]).sort()).toEqual(
    [
      [1080, 1080],
      [1080, 1920],
      [1200, 627],
    ].sort()
  )
  expect(Object.keys(zip.files)).toHaveLength(4)
})

test('C: a generated campaign design is refined on a canvas without touching its approval', async ({
  app,
  identity,
  page,
}) => {
  await setUp(identity, page)
  const assetId = await uploadWorkspaceImage(page, SCREENSHOT)
  const release = await requestJson(page, '/api/tenant/releases', {
    benefitStatement: 'Approve launches from one queue.',
    title: 'Approvals 2.0',
  })
  expect(release.status).toBe(201)
  const releaseId = z.object({ release: z.object({ id: z.string() }) }).parse(release.body)
    .release.id
  const campaign = await trpcMutation(page, 'campaign.create', {
    name: 'Approvals launch',
    objective: 'Explain approvals',
    releaseId,
    posts: [],
  })
  expect(campaign.status, JSON.stringify(campaign.body)).toBe(200)
  const campaignId = (campaign.body as { campaign: { id: string } }).campaign.id
  const designId = `c${randomBytes(12).toString('hex')}`
  const original = {
    version: 2,
    canvas: { aspectRatio: 'custom', padding: 40, size: { width: 1600, height: 900 } },
    background: { type: 'solid', value: '#eef2ff' },
    image: { src: `asset:${assetId}`, name: 'demo-1.png', scale: 80 },
    texts: [
      {
        id: 'headline',
        text: 'Generated headline',
        role: 'headline',
        fontSize: 0.045,
        color: '#111111',
        position: { x: 50, y: 12 },
      },
    ],
  }
  const organizationId = await getActiveOrganizationId(page)
  await db.query(
    `INSERT INTO design (id, "organizationId", "campaignId", name, document, "renderedAssetId", "planAssetKey", "updatedAt")
       VALUES ($1, $2, $3, 'Launch hero', $4, $5, 'A1', now())`,
    [designId, organizationId, campaignId, JSON.stringify(original), assetId]
  )
  // Production records a render's size when it renders; this seeded render needs it too.
  const { width, height } = await sharp(await readFile(SCREENSHOT)).metadata()
  await db.query('UPDATE asset SET width = $2, height = $3 WHERE id = $1', [assetId, width, height])
  const approval = await trpcMutation(page, 'campaign.approveDesign', { campaignId, designId })
  expect(approval.status, JSON.stringify(approval.body)).toBe(200)
  const approvedBefore = await db.row<{ id: string; sourceAssetId: string }>(
    `SELECT id, "sourceAssetId" FROM creative_variant WHERE "designId" = $1`,
    [designId]
  )
  expect(approvedBefore).not.toBeNull()

  await app.open(`/campaigns/${campaignId}/assets`)
  await page.getByRole('link', { name: 'Edit in Canvas' }).first().click()
  await expect(page).toHaveURL(/\/canvas\/c[a-z0-9]{24}$/, { timeout: 180_000 })
  const canvasId = canvasIdOf(page)
  await previewsReady(page)
  await selectArtboard(page, 'Launch hero')
  await expect(page.getByTestId('artboard-lineage')).toContainText('campaign design')

  await openArtboard(page, 'Launch hero')
  await page.locator('#image-render-card [data-text-overlay-id]').first().click()
  await page.getByLabel('Text content').fill('Approve every launch in one queue')
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Replace screenshot' }).click()
  await (await chooser).setFiles(OTHER_SCREENSHOT)
  await saved(page)
  await clickEmptyBoard(page)
  await selectArtboard(page, 'Launch hero')
  await chooseOption(page.getByLabel('Size preset'), '1:1 · 1080 × 1080')
  await saved(page)
  await page.getByRole('button', { name: 'History', exact: true }).click()
  await page.getByLabel('Version name').fill('Refined by hand')
  await page.getByRole('button', { name: 'Save version' }).click()
  await expect(page.getByRole('list', { name: 'Versions' })).toContainText('Refined by hand')
  await page.keyboard.press('Escape')

  const canvas = (await stored(page, canvasId)).document
  const artboard = canvas.artboards[0]!
  expect(artboard.origin).toMatchObject({ kind: 'design', id: designId, campaignId })
  expect(artboard.document.texts[0]!.text).toBe('Approve every launch in one queue')
  expect(artboard.document.image.src).not.toBe(`asset:${assetId}`)
  const untouched = await trpcQuery(page, 'design.get', { designId })
  expect(
    (
      untouched.body as {
        design: { document: { texts: { text: string }[]; image: { src: string } } }
      }
    ).design.document
  ).toMatchObject({ texts: [{ text: 'Generated headline' }], image: { src: `asset:${assetId}` } })

  const { dialog } = await exportFiles(page)
  await dialog.getByRole('button', { name: 'Save to workspace' }).click()
  await expect(dialog.getByRole('button', { name: 'Saved to workspace' })).toBeVisible({
    timeout: 90_000,
  })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Campaign', exact: true }).click()
  const handoff = page.getByRole('dialog', { name: 'Send to a campaign for review' })
  await chooseOption(handoff.getByLabel('Campaign'), 'Approvals launch')
  await handoff.getByLabel('Post copy').fill('Approve every launch in one queue.')
  await handoff.getByRole('button', { name: 'Attach for review' }).click()
  await expect(handoff.getByText('Attached as a draft for review.')).toBeVisible({
    timeout: 60_000,
  })
  await page.screenshot({ path: path.join(out, 'c-handoff.png') })

  const candidate = await db.row<{
    name: string
    critique: { storyHandoff: { setId: string } }
  }>(`SELECT name, critique FROM design WHERE "campaignId" = $1 AND id <> $2`, [
    campaignId,
    designId,
  ])
  expect(candidate?.name).toBe(`${(await stored(page, canvasId)).name} · canvas artboard`)
  expect(candidate?.critique.storyHandoff.setId).toBe(canvasId)
  expect(
    await db.row(`SELECT status FROM campaign_post WHERE "campaignId" = $1`, [campaignId])
  ).toEqual({ status: 'DRAFT' })
  const approvedAfter = await db.row<{ id: string; sourceAssetId: string }>(
    `SELECT id, "sourceAssetId" FROM creative_variant WHERE "designId" = $1`,
    [designId]
  )
  expect(approvedAfter).toEqual(approvedBefore)
})

test('D: an interrupted save is recovered and a conflicting edit is kept as a copy', async ({
  app,
  identity,
  page,
}) => {
  await setUp(identity, page)
  await app.open('/canvas/new?blank=1')
  await expect(page).toHaveURL(/\/canvas\/c[a-z0-9]{24}$/, { timeout: 180_000 })
  const canvasId = canvasIdOf(page)
  await previewsReady(page)
  await selectArtboard(page, '16:9')
  await page.getByLabel('Artboard name').fill('Saved name')
  await page.getByLabel('Artboard name').press('Enter')
  await saved(page)

  const block = (route: { abort: () => Promise<void> }) => route.abort()
  const updates = '**/api/trpc/**canvas.updateDocument**'
  await page.route(updates, block)
  await page.getByLabel('Artboard name').fill('Offline name')
  await page.getByLabel('Artboard name').press('Enter')
  await expect(page.getByTestId('canvas-save-status')).toHaveText('Offline · kept on this device', {
    timeout: 30_000,
  })
  await openCanvasTools(page)
  await page.getByRole('tab', { name: 'Insert' }).click()
  await page.getByRole('button', { name: '1:1 · 1080 × 1080' }).click()
  await expect
    .poll(async () => (await stored(page, canvasId)).document.artboards[0]!.name)
    .toBe('Saved name')
  // Leaving with unsaved work asks first; the reload goes ahead and the draft stays on the device.
  page.once('dialog', (dialog) => void dialog.accept())
  await app.reload()
  const recovery = page.getByRole('dialog', { name: 'Recover unsaved work' })
  await expect(recovery).toBeVisible({ timeout: 60_000 })
  await page.unroute(updates, block)
  await recovery.getByRole('button', { name: 'Recover draft' }).click()
  await saved(page)
  const recovered = (await stored(page, canvasId)).document
  expect(recovered.artboards.map((artboard) => artboard.name)).toEqual(['Offline name', '1:1'])

  // This tab renames an artboard while offline; another editor renames the same one meanwhile.
  await page.route(updates, block)
  await selectArtboard(page, 'Offline name')
  await page.getByLabel('Artboard name').fill('My name')
  await page.getByLabel('Artboard name').press('Enter')
  await expect(page.getByTestId('canvas-save-status')).toHaveText('Offline · kept on this device', {
    timeout: 30_000,
  })
  const remote = await stored(page, canvasId)
  const theirs = structuredClone(remote.document)
  theirs.artboards[0]!.name = 'Their name'
  const write = await page.request.post(getE2EUrl('/api/trpc/canvas.updateDocument'), {
    data: { json: { canvasId, baseRevision: remote.revision, document: theirs } },
    headers: { origin: new URL(getE2EUrl('/')).origin },
  })
  expect(write.status(), await write.text()).toBe(200)
  await page.unroute(updates, block)
  await expect(page.getByTestId('canvas-save-status')).toHaveText('Save conflict', {
    timeout: 30_000,
  })
  await page.screenshot({ path: path.join(out, 'd-conflict.png') })
  await page.getByRole('button', { name: 'Keep mine as a copy' }).click()
  await expect(page).not.toHaveURL(new RegExp(canvasId), { timeout: 60_000 })
  const copy = await stored(page, canvasIdOf(page))
  expect(copy.document.artboards[0]!.name).toBe('My name')
  expect((await stored(page, canvasId)).document.artboards[0]!.name).toBe('Their name')
})

test('E: another workspace can neither read nor change a canvas or its images', async ({
  identity,
  page,
  browser,
}) => {
  await setUp(identity, page)
  const assetId = await uploadWorkspaceImage(page, SCREENSHOT)
  const canvasId = `c${randomBytes(12).toString('hex')}`
  const document = {
    version: 1,
    kind: 'canvas',
    artboards: [
      {
        id: 'hero',
        name: 'Private hero',
        x: 0,
        y: 0,
        document: {
          version: 2,
          image: { src: `asset:${assetId}` },
          canvas: { aspectRatio: 'custom', size: { width: 1600, height: 900 } },
        },
      },
    ],
  }
  const created = await trpcMutation(page, 'canvas.create', {
    id: canvasId,
    name: 'Private launch',
    document,
  })
  expect(created.status, JSON.stringify(created.body)).toBe(200)

  const other = await otherWorkspace(browser, identity)
  try {
    const denied = [
      await trpcQuery(other, 'canvas.get', { canvasId }),
      await trpcQuery(other, 'canvas.versions', { canvasId }),
      await trpcMutation(other, 'canvas.updateDocument', { canvasId, baseRevision: 1, document }),
      await trpcMutation(other, 'canvas.rename', { canvasId, name: 'Taken' }),
      await trpcMutation(other, 'canvas.duplicate', { canvasId }),
      await trpcMutation(other, 'canvas.archive', { canvasId }),
      await trpcQuery(other, 'creativeSet.get', { creativeSetId: canvasId }),
    ]
    for (const response of denied) expect(response.status, JSON.stringify(response.body)).toBe(404)
    const list = await trpcQuery(other, 'canvas.list', {})
    expect(JSON.stringify(list.body)).not.toContain(canvasId)
    const image = await trpcQuery(other, 'asset.signDownload', { assetId })
    expect(image.status).toBeGreaterThanOrEqual(400)
    const stolen = await trpcMutation(other, 'canvas.create', {
      id: `c${randomBytes(12).toString('hex')}`,
      name: 'Stolen',
      document,
    })
    expect(stolen.status).toBeGreaterThanOrEqual(400)
    await other.goto(getE2EUrl(`/canvas/${canvasId}`))
    await expect(other.getByText('This canvas could not be opened')).toBeVisible({
      timeout: 120_000,
    })
    await expect(other.getByText('Private hero')).toHaveCount(0)
  } finally {
    await other.context().close()
  }
  expect((await stored(page, canvasId)).name).toBe('Private launch')
})

async function otherWorkspace(browser: Browser, identity: E2EIdentity) {
  const context = await browser.newContext({
    storageState: {
      cookies: [],
      origins: [
        {
          origin: new URL(getE2EUrl('/')).origin,
          localStorage: [{ name: 'shots-consent', value: '{"analytics":false,"ads":false}' }],
        },
      ],
    },
  })
  const page = await context.newPage()
  const suffix = randomBytes(4).toString('hex')
  await setUp(
    {
      ...identity,
      email: `e2e-other-${suffix}@example.test`,
      name: 'Other workspace',
      workspaceName: `Other ${suffix}`,
    },
    page
  )
  return page
}

test('F: the Library page manager reorders, duplicates, deletes and adds pages in one save', async ({
  app,
  identity,
  page,
}) => {
  await setUp(identity, page)
  await app.open('/canvas/new?recipe=product-launch')
  await expect(page).toHaveURL(/\/canvas\/c[a-z0-9]{24}$/, { timeout: 180_000 })
  const canvasId = canvasIdOf(page)
  const before = (await stored(page, canvasId)).document.artboards.map((board) => board.name)
  expect(before).toHaveLength(5)

  await app.open('/library?type=canvas')
  await page.getByRole('button', { name: /^Manage the pages of / }).click()
  const dialog = page.getByRole('dialog')
  const pages = dialog.getByRole('list', { name: 'Pages' }).locator(':scope > li[draggable]')
  await expect(pages).toHaveCount(5)
  // Drag the last page in front of the first, then use the keyboard-reachable arrows.
  await pages.nth(4).dragTo(pages.nth(0), { targetPosition: { x: 8, y: 40 } })
  await dialog.getByRole('button', { name: 'Move page 2 later' }).click()
  await dialog.getByRole('button', { name: 'Duplicate page 1' }).click()
  await dialog.getByRole('button', { name: 'Delete page 3' }).click()
  await dialog.getByRole('button', { name: 'Add page' }).click()
  await expect(dialog.getByText('6 pages · Unsaved changes')).toBeVisible()
  await dialog.getByRole('button', { name: 'Save pages' }).click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })
  const saved = await stored(page, canvasId)
  expect(saved.document.artboards.map((board) => board.name)).toEqual([
    before[4],
    `${before[4]} (copy)`,
    before[0],
    before[2],
    before[3],
    'Page 6',
  ])
  await expect(page.getByRole('group', { name: /artboards$/ })).toContainText('+2')

  // A save based on an older revision is refused and nothing is lost.
  await page.getByRole('button', { name: /^Manage the pages of / }).click()
  await dialog.getByRole('button', { name: 'Delete page 6' }).click()
  const elsewhere = await trpcMutation(page, 'canvas.updateDocument', {
    canvasId,
    baseRevision: saved.revision,
    document: saved.document,
  })
  expect(elsewhere.status).toBe(200)
  await dialog.getByRole('button', { name: 'Save pages' }).click()
  await expect(dialog.getByRole('alert')).toHaveText(/changed somewhere else/)
  expect((await stored(page, canvasId)).document.artboards).toHaveLength(6)
})
