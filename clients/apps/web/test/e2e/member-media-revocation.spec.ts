import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  browserRequest,
  db,
  expect,
  grantWorkspacePlan,
  requestJson,
  signUpViaApi,
  test,
  uploadSignedAsset,
} from './framework'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64'
)
const idSchema = z.object({ id: z.string() })
const downloadSchema = z.object({ downloadUrl: z.string().url() })

test('removal invalidates an outstanding media link and stale audit and notification reads', async ({
  app,
  browser,
  identity,
  page,
}, testInfo) => {
  await signUpViaApi(identity, page)
  const created = await requestJson(page, '/api/auth/organization/create', {
    name: identity.workspaceName,
    slug: `media-${randomUUID()}`,
    idempotencyKey: randomUUID(),
  })
  expect(created.status).toBe(200)
  const org = idSchema.parse(created.body).id
  await grantWorkspacePlan(org, 'business')
  const memberContext = await browser.newContext()
  const anonymous = await browser.newContext()
  const member = await memberContext.newPage()
  try {
    const email = `member-${identity.email}`
    await signUpViaApi({ ...identity, email }, member)
    const invitation = await requestJson(page, '/api/auth/organization/invite-member', {
      email,
      role: 'admin',
    })
    expect(invitation.status).toBe(200)
    const accepted = await requestJson(member, '/api/auth/organization/accept-invitation', {
      invitationId: idSchema.parse(invitation.body).id,
    })
    expect(accepted.status).toBe(200)
    const memberId = z.object({ member: idSchema }).parse(accepted.body).member.id
    const sha256 = createHash('sha256').update(png).digest('hex')
    const upload = await requestJson(page, '/api/v1/assets/upload-url', {
      bytes: png.length,
      classification: 'input',
      contentType: 'image/png',
      fileName: 'private.png',
      sha256,
    })
    expect(upload.status).toBe(201)
    const signed = z.object({ asset: idSchema, uploadUrl: z.string().url() }).parse(upload.body)
    expect(await uploadSignedAsset(page, signed.uploadUrl, [...png], 'image/png')).toBe(200)
    expect(
      (await requestJson(page, `/api/v1/assets/${signed.asset.id}/complete`, { sha256 })).status
    ).toBe(200)
    const download = await browserRequest(member, `/api/v1/assets/${signed.asset.id}/download-url`)
    expect(download.status).toBe(200)
    const url = downloadSchema.parse(download.body).downloadUrl
    expect(new URL(url).origin).toBe(new URL(page.url()).origin)
    expect(new URL(url).searchParams.has('X-Amz-Signature')).toBe(false)
    const publicRead = await anonymous.request.get(url)
    expect(publicRead.status()).toBe(200)
    expect(await publicRead.body()).toEqual(png)
    expect(publicRead.headers()['cache-control']).toBe('private, no-store')
    expect(publicRead.headers()['location']).toBeUndefined()
    const partial = await anonymous.request.get(url, { headers: { range: 'bytes=0-7' } })
    expect(partial.status()).toBe(206)
    expect(await partial.body()).toEqual(png.subarray(0, 8))
    expect(partial.headers()['content-range']).toBe(`bytes 0-7/${png.length}`)
    const invalidRange = await anonymous.request.get(url, { headers: { range: 'bytes=9999-' } })
    expect(invalidRange.status()).toBe(416)
    const content = `/api/v1/assets/${signed.asset.id}/content`
    expect((await member.request.get(new URL(content, url).toString())).status()).toBe(200)
    expect((await anonymous.request.get(new URL(content, url).toString())).status()).toBe(401)
    for (const path of [
      `/api/audit-logs?organizationId=${encodeURIComponent(org)}`,
      '/api/workspace/notifications/inbox',
      '/api/workspace/notifications/count',
    ]) {
      expect((await browserRequest(member, path)).status, path).toBe(200)
    }
    await app.open('/settings/members')
    await expect(page.getByText(email, { exact: true })).toBeVisible()
    expect(
      (
        await requestJson(page, '/api/auth/organization/remove-member', {
          organizationId: org,
          memberIdOrEmail: memberId,
        })
      ).status
    ).toBe(200)
    // Replay the exact old URL from a clean browser, with no session cookie.
    // Expiry cannot explain the result: the same request succeeded moments ago.
    const denied = await anonymous.request.get(url)
    expect(denied.status()).toBe(401)
    expect(denied.headers()['x-request-id']).toBeTruthy()
    await testInfo.attach('media-revocation-requests', {
      body: JSON.stringify({
        assetId: signed.asset.id,
        before: { requestId: publicRead.headers()['x-request-id'], status: publicRead.status() },
        after: { requestId: denied.headers()['x-request-id'], status: denied.status() },
      }),
      contentType: 'application/json',
    })
    expect(await denied.body()).not.toEqual(png)
    for (const path of [
      content,
      `/api/v1/assets/${signed.asset.id}/download-url`,
      `/api/audit-logs?organizationId=${encodeURIComponent(org)}`,
      '/api/workspace/notifications/inbox',
      '/api/workspace/notifications/count',
    ]) {
      expect((await browserRequest(member, path)).status, path).toBe(401)
    }
    expect((await page.request.get(new URL(content, url).toString())).status()).toBe(200)
    await app.reload()
    await expect(page.getByText('1 member', { exact: true })).toBeVisible()
    await expect(page.getByText(email, { exact: true })).toHaveCount(0)
    await page.screenshot({ path: '.context/member-media-revoked.png' })
    expect(
      (await db.query('SELECT count(*)::int AS n FROM member WHERE id=$1', [memberId])).rows[0].n
    ).toBe(0)
    expect(
      (
        await db.query('SELECT status FROM asset WHERE id=$1 AND "organizationId"=$2', [
          signed.asset.id,
          org,
        ])
      ).rows[0].status
    ).toBe('UPLOADED')
  } finally {
    await memberContext.close()
    await anonymous.close()
  }
})
