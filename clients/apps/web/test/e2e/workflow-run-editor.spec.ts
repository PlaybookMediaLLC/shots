import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  createUploadedAsset,
  db,
  draftEditor,
  expect,
  expectSaved,
  requestJson,
  test,
  trpcMutation,
} from './framework'

/**
 * A workflow run's captured screenshot opens in the editor on the workspace's
 * active brand kit, keeping the run's release for its export. The fixture has
 * no GitHub to deliver a release, so the test writes a finished run's rows
 * itself (no pinned version or node receipts: the editor action needs neither).
 */

test.use({ workspaceOptions: { plan: 'pro' } })

test(
  'a run’s capture opens editable drafts and the screenshot editor',
  { tag: '@journey' },
  async ({ app, page, workspace }) => {
    const kit = await trpcMutation(page, 'brandKit.create', {
      definition: {
        colors: { accent: '#f59e0b', background: '#1d4ed8', text: '#111111' },
        schemaVersion: 1,
        typography: { headingFamily: 'inter' },
      },
      name: 'Run brand',
      publish: true,
    })
    expect(kit.status, JSON.stringify(kit.body)).toBe(200)
    const kitId = (kit.body as { brandKit: { id: string } }).brandKit.id
    const captureAssetId = await createUploadedAsset(page)
    const created = await requestJson(page, '/api/tenant/releases', {
      benefitStatement: 'Saved views have names now.',
      title: 'Named views',
    })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const releaseId = (created.body as { release: { id: string } }).release.id

    const suffix = randomUUID()
    const sourceId = `src_${suffix}`
    const eventId = `evt_${suffix}`
    const runId = `run_${suffix}`
    await db.query(
      `INSERT INTO source_app (id, "organizationId", name, provider, "externalId", "allowedHosts", status, "updatedAt")
     VALUES ($1, $2, 'fixture/product', 'github', $1, '[]', 'ACTIVE', now())`,
      [sourceId, workspace.id]
    )
    await db.query(
      `INSERT INTO release_source_event (id, "organizationId", "sourceAppId", "semanticKey", "deliveryId", snapshot, "versionIds", mode, disposition)
     VALUES ($1, $2, $3, $4, $4, $5::jsonb, '[]', 'automation', 'succeeded')`,
      [
        eventId,
        workspace.id,
        sourceId,
        `release:${suffix}`,
        JSON.stringify({
          family: 'release.published',
          fields: {},
          notes: 'Saved views have names now.',
          objectId: suffix,
          occurredAt: new Date().toISOString(),
          origin: 'live',
          repositoryId: '1',
          repositoryName: 'fixture/product',
          semanticKey: `release:${suffix}`,
          title: 'Named views',
          url: 'https://github.com/fixture/product/releases/tag/v1',
        }),
      ]
    )
    await db.query(
      `INSERT INTO release_automation_run (id, "organizationId", "eventId", "workflowId", status, outputs, "startedAt", "completedAt")
     VALUES ($1, $2, $3, $1, 'succeeded', $4::jsonb, now(), now())`,
      [runId, workspace.id, eventId, JSON.stringify({ releaseId })]
    )

    // A run that captured nothing offers nothing to open.
    await app.open(`/workflows/runs/${runId}`)
    await expect(page.getByRole('link', { name: 'Open release' })).toBeVisible()
    await expect(page.getByTestId('run-open-editor')).toHaveCount(0)
    await expect(page.getByRole('link', { name: /^Open draft/ })).toHaveCount(0)

    // Exercise the UI handoff with real drafts and storage. Go integration tests
    // cover the workflow that produces these outputs; this fixture does not.
    const draftIds: string[] = []
    for (const platform of ['x', 'linkedin']) {
      const draft = await requestJson(page, '/api/v1/content-drafts', {
        title: `Named views for ${platform}`,
        primaryPlatform: platform,
        plainText: 'Saved views have names now.',
        releaseId,
        assetIds: [captureAssetId],
        body: [
          { type: 'post_break', children: [{ text: '' }] },
          { type: 'p', children: [{ text: 'Saved views have names now.' }] },
          {
            type: 'img',
            assetId: captureAssetId,
            url: `/api/v1/assets/${captureAssetId}/content`,
            children: [{ text: '' }],
          },
        ],
      })
      expect(draft.status, JSON.stringify(draft.body)).toBe(201)
      draftIds.push(z.object({ id: z.string() }).parse(draft.body).id)
    }

    await db.query(
      `UPDATE release_automation_run SET outputs = outputs || $2::jsonb WHERE id = $1`,
      [runId, JSON.stringify({ captureAssetId, draftIds })]
    )
    await app.reload()
    await expect(page.getByRole('link', { name: /^Open draft/ })).toHaveCount(2)
    await page.getByRole('link', { name: 'Open draft 1', exact: true }).click()
    await page.waitForURL((url) => url.pathname.endsWith(`/publish/${draftIds[0]}`))
    await expect(draftEditor(page)).toContainText('Saved views have names now.')
    await expect(draftEditor(page).locator(`img[src*="${captureAssetId}"]`)).toBeVisible()
    await page.getByRole('textbox', { name: 'Draft title' }).fill('Reviewed named views')
    await expectSaved(page)
    await app.reload()
    await expect(page.getByRole('textbox', { name: 'Draft title' })).toHaveValue(
      'Reviewed named views'
    )
    await expect(draftEditor(page).locator(`img[src*="${captureAssetId}"]`)).toBeVisible()
    await app.open(`/workflows/runs/${runId}`)
    const open = page.getByTestId('run-open-editor')
    await expect(open).toBeVisible()
    const href = new URL((await open.getAttribute('href')) ?? '', 'http://shots.test')
    expect(Object.fromEntries(href.searchParams)).toEqual({
      asset: captureAssetId,
      fromRelease: releaseId,
      kit: kitId,
    })

    await open.click()
    await page.waitForURL((url) => url.pathname.endsWith('/editor'))
    await expect(page.locator('img[alt="Main image"]')).toHaveCount(1, { timeout: 60_000 })
    await expect(page.getByText('Applied Run brand')).toBeVisible({ timeout: 30_000 })
    // The export still knows its release once the editor has dropped the asset and kit.
    await expect.poll(() => new URL(page.url()).searchParams.get('kit')).toBeNull()
    expect(new URL(page.url()).searchParams.get('fromRelease')).toBe(releaseId)
  }
)
