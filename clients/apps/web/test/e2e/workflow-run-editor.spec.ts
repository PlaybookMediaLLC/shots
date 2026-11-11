import { randomUUID } from 'node:crypto'
import { createUploadedAsset, db, expect, requestJson, test, trpcMutation } from './framework'

/**
 * A workflow run's captured screenshot opens in the editor on the workspace's
 * active brand kit, keeping the run's release for its export. The fixture has
 * no GitHub to deliver a release, so the test writes a finished run's rows
 * itself (no pinned version or node receipts: the editor action needs neither).
 */

test.use({ workspaceOptions: { plan: 'pro' } })

test('a run’s captured screenshot opens in the editor on the active brand kit', async ({
  app,
  page,
  workspace,
}) => {
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

  await db.query(`UPDATE release_automation_run SET outputs = outputs || $2::jsonb WHERE id = $1`, [
    runId,
    JSON.stringify({ captureAssetId }),
  ])
  await app.reload()
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
})
