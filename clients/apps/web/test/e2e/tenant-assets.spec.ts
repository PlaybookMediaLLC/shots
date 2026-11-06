import { createHash } from 'node:crypto'
import {
  type Browser,
  browserRequest,
  createWorkspace,
  db,
  downloadSignedAsset,
  type E2EIdentity,
  expect,
  grantWorkspacePlan,
  type Page,
  requestJson,
  test,
  uploadSignedAsset,
} from './framework'
import { z } from 'zod'

test.use({ workspaceOptions: { plan: 'pro' } })

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64'
)
const signedAssetSchema = z.object({
  asset: z.object({ id: z.string().uuid(), status: z.string() }),
  uploadUrl: z.string().url(),
})
const completedAssetSchema = z.object({
  asset: z.object({ id: z.string().uuid(), status: z.string() }),
})
const downloadSchema = z.object({ downloadUrl: z.string().url() })
type AssetRequest = {
  bytes: number
  classification: 'input'
  contentType: 'image/png'
  fileName: string
  sha256: string
}
type CrossTenantInput = {
  browser: Browser
  downloadUrl: string
  identity: E2EIdentity
  request: AssetRequest
  signed: z.infer<typeof signedAssetSchema>
}

/** The backend presigns private bucket URLs; S3 carries the lifetime in seconds. */
function getSignedUrlLifetime(url: string): number {
  const expires = new URL(url).searchParams.get('X-Amz-Expires')
  if (!expires) {
    throw new Error('The signed URL did not carry an expiry.')
  }
  return Number(expires)
}

async function signAsset(page: Page, request: AssetRequest) {
  return signedAssetSchema.parse(
    (await requestJson(page, '/api/tenant/assets/upload-url', request)).body
  )
}

async function assertCrossTenantIsolation({
  browser,
  downloadUrl,
  identity,
  request,
  signed,
}: CrossTenantInput): Promise<void> {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await createWorkspace(
      {
        ...identity,
        email: `other-${identity.email}`,
        workspaceName: `Other ${identity.workspaceName}`,
      },
      page
    )
    const [download, completion, deletion, upload, invalid, oversized, unsafe, thumbnail] =
      await Promise.all([
        browserRequest(page, `/api/tenant/assets/${signed.asset.id}/download-url`),
        requestJson(page, `/api/tenant/assets/${signed.asset.id}/complete`, {}),
        requestJson(page, `/api/tenant/assets/${signed.asset.id}`, {}, 'DELETE'),
        uploadSignedAsset(page, signed.uploadUrl, [...png], request.contentType),
        requestJson(page, '/api/tenant/assets/upload-url', {
          ...request,
          contentType: 'text/plain',
        }),
        requestJson(page, '/api/tenant/assets/upload-url', {
          ...request,
          bytes: 50 * 1024 * 1024 + 1,
        }),
        requestJson(page, '/api/tenant/assets/upload-url', {
          ...request,
          fileName: '../unsafe.png',
        }),
        browserRequest(page, `/api/v1/assets/${signed.asset.id}/content?variant=thumbnail`),
      ])
    expect(download.status).toBe(404)
    expect(thumbnail.status).toBe(404)
    expect(completion.status).toBe(404)
    expect(deletion.status).toBe(404)
    // Signed uploads are write-once, so a leaked URL cannot replace the bytes.
    expect(upload).toBe(412)
    // The short-lived link rechecks its original principal on every download.
    // It carries no storage signature; the expiry test below covers rejection.
    expect(new URL(downloadUrl).searchParams.has('downloadToken')).toBe(true)
    expect(new URL(downloadUrl).searchParams.has('X-Amz-Signature')).toBe(false)
    expect((await browserRequest(page, `/api/v1/assets/${signed.asset.id}/content`)).status).toBe(
      404
    )
    expect(invalid.status).toBe(400)
    expect(oversized.status).toBe(400)
    expect(unsafe.status).toBe(400)
  } finally {
    await context.close()
  }
}

test(
  'an uploaded asset stays private to its workspace through completion and download',
  { tag: '@smoke' },
  async ({ browser, identity, page, workspace }) => {
    const organizationId = workspace.id
    const sha256 = createHash('sha256').update(png).digest('hex')
    const request: AssetRequest = {
      bytes: png.byteLength,
      classification: 'input',
      contentType: 'image/png',
      fileName: 'product.png',
      sha256,
    }
    const signed = await signAsset(page, request)
    const duplicate = await signAsset(page, request)
    const interrupted = await signAsset(page, request)

    expect(duplicate.asset.id).not.toBe(signed.asset.id)
    expect(duplicate.uploadUrl).not.toBe(signed.uploadUrl)
    expect(getSignedUrlLifetime(signed.uploadUrl)).toBeLessThanOrEqual(120)
    expect(
      (
        await requestJson(page, `/api/tenant/assets/${interrupted.asset.id}/complete`, {
          sha256,
        })
      ).status
    ).toBe(400)
    expect(await uploadSignedAsset(page, signed.uploadUrl, [...png], request.contentType)).toBe(200)
    const completed = completedAssetSchema.parse(
      (await requestJson(page, `/api/tenant/assets/${signed.asset.id}/complete`, { sha256 })).body
    )
    expect(completed.asset.status).toBe('UPLOADED')

    const download = downloadSchema.parse(
      (await browserRequest(page, `/api/tenant/assets/${signed.asset.id}/download-url`)).body
    )
    await expect(downloadSignedAsset(page, download.downloadUrl)).resolves.toEqual({
      bytes: png.byteLength,
      status: 200,
    })

    await assertCrossTenantIsolation({
      browser,
      downloadUrl: download.downloadUrl,
      identity,
      request,
      signed,
    })

    // There is no free plan: a workspace without a subscription can't touch its
    // assets. Drop the plan to assert the gate, then restore it the way billing
    // would so the deletion lifecycle can be exercised. Ownership resolves
    // before the plan check, so this 403 proves the caller owns the asset.
    await grantWorkspacePlan(organizationId, 'free')
    expect(
      await requestJson(page, `/api/tenant/assets/${signed.asset.id}`, {}, 'DELETE')
    ).toMatchObject({
      body: { code: 'workspace_feature_not_entitled' },
      status: 403,
    })
    await grantWorkspacePlan(organizationId, 'pro')

    // The backend reads the entitlement on every check, so the grant applies at once.
    expect(
      await requestJson(page, `/api/tenant/assets/${signed.asset.id}`, {}, 'DELETE')
    ).toMatchObject({ body: { accepted: true }, status: 202 })
    expect(
      (await browserRequest(page, `/api/tenant/assets/${signed.asset.id}/download-url`)).status
    ).toBe(404)

    // The Go maintenance worker removes the stored object when it dispatches
    // asset.deleted; the web path only has to queue it.
    expect(await db.row('SELECT status FROM asset WHERE id = $1', [signed.asset.id])).toEqual({
      status: 'DELETED',
    })
    expect(
      await db.row(
        `SELECT "deliveredAt" FROM outbox_event WHERE "aggregateId" = $1 AND type = 'asset.deleted' LIMIT 1`,
        [signed.asset.id]
      )
    ).toEqual({ deliveredAt: null })
  }
)

// The backend issues these for PLATFORM_ASSET_DOWNLOAD_TTL (dev/compose.e2e.yaml
// sets 5 s; the product default is 2 minutes). Waiting out the default here
// cost the suite two minutes of a single shard.
const downloadTtlMs = Number(process.env.E2E_ASSET_DOWNLOAD_TTL_MS ?? 5_000)

test(
  'a signed asset download URL expires at the authorization boundary',
  { tag: '@journey' },
  async ({ page }) => {
    const sha256 = createHash('sha256').update(png).digest('hex')
    const signed = await signAsset(page, {
      bytes: png.byteLength,
      classification: 'input',
      contentType: 'image/png',
      fileName: 'expiring-product.png',
      sha256,
    })
    expect(await uploadSignedAsset(page, signed.uploadUrl, [...png], 'image/png')).toBe(200)
    expect(
      (
        await requestJson(page, `/api/tenant/assets/${signed.asset.id}/complete`, {
          sha256,
        })
      ).status
    ).toBe(200)
    const downloadUrl = downloadSchema.parse(
      (await browserRequest(page, `/api/tenant/assets/${signed.asset.id}/download-url`)).body
    ).downloadUrl

    // The URL is live right up to the boundary, then refused after it.
    expect((await downloadSignedAsset(page, downloadUrl)).status).toBe(200)
    // eslint-disable-next-line no-restricted-syntax -- An expiry is a wall-clock fact; there is no event to await.
    await page.waitForTimeout(downloadTtlMs + 2_000)
    expect([400, 401, 403]).toContain((await downloadSignedAsset(page, downloadUrl)).status)
  }
)
