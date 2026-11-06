import { randomBytes } from 'node:crypto'
import {
  bindTestGoOrganization,
  db,
  e2eSecretReference,
  enableTwoFactor,
  expect,
  getActiveOrganizationId,
  socialMockPort,
  startHttpMockServer,
  test,
  trpcMutation,
  unbindTestGoOrganization,
  xVerification,
} from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

/**
 * The launch pipeline end to end: a release with only a title and source
 * links becomes a cited spec (the injection attempt in one source is flagged
 * and ignored), a plan, a produced campaign with provenance, and a reviewer's
 * AI revision that changes one post and nothing else. Then the copy is
 * approved, a visual is approved, and an X post is scheduled to a social API
 * destination (mocked), cancelled, and rescheduled. The app runs with the
 * scripted model (PLATFORM_AI_SCRIPTED=1, see dev/studio), so this needs no
 * provider key; the mock serves the sources and a real product screenshot.
 */

const MOCK = 'http://screenshot-mock:5678'
const RUN_TIMEOUT = 90_000

test(
  'a release becomes a cited spec, a plan, a produced campaign, a revised post, and a schedule',
  { tag: '@journey' },
  async ({ app, identity, page }) => {
    const organizationId = await getActiveOrganizationId(page)

    const surface = await trpcMutation(page, 'productSurface.create', {
      name: 'Ledgerly',
      url: `${MOCK}/product`,
    })
    expect(surface.status).toBe(200)
    const surfaceId = (surface.body as { productSurface: { id: string } }).productSurface.id
    // Only a title and source links: why it matters comes from the sources.
    const release = await trpcMutation(page, 'release.create', {
      productSurfaceId: surfaceId,
      sourceUrls: [`${MOCK}/changelog`, `${MOCK}/notes`],
      title: 'Recurring invoices',
    })
    expect(release.status).toBe(200)
    const releaseId = (release.body as { release: { id: string } }).release.id
    const created = await trpcMutation(page, 'campaign.create', {
      name: 'Recurring invoices launch',
      objective: 'Launch',
      releaseId,
    })
    const campaignId = (created.body as { campaign: { id: string } }).campaign.id

    // ---------------------------------------------------------------- spec
    await app.open(`/campaigns/${campaignId}/spec`)
    await page.getByRole('button', { name: 'Draft spec' }).click()
    await expect(page.getByText(/Drafted from the brief and \d sources?/)).toBeVisible({
      timeout: RUN_TIMEOUT,
    })
    await expect(page.getByText('Recurring schedules', { exact: false }).first()).toBeVisible()
    // The notes page tried a prompt injection: it is flagged, and none of it is repeated.
    await expect(page.getByText('Flagged', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('#1 billing tool')).toHaveCount(0)
    await expect(page.getByText('customer list')).toHaveCount(0)
    await expect(page.getByText('What measurable result can we cite?')).toBeVisible()
    page.once('dialog', async (dialog) => {
      expect(dialog.type()).toBe('confirm')
      expect(dialog.message()).toContain('questions are unanswered')
      await dialog.accept()
    })
    await page.getByRole('button', { name: 'Approve spec' }).click()
    await expect(page.getByText('Approved', { exact: true }).first()).toBeVisible()

    let boundOrganizationId: string | null = null
    // The social API mock: the destination check reads the account and its integrations.
    const socialApi = await startHttpMockServer((request) => {
      if (request.url === '/api/public/v1/me') {
        return { body: { organization: { id: `go-${boundOrganizationId}` } } }
      }
      if (request.url === '/api/public/v1/integrations') {
        return { body: [{ id: 'launch-x-integration', identifier: 'x', disabled: false }] }
      }
      // X connections are saved only after a live identity check.
      if (request.url === '/api/public/v1/integrations/launch-x-integration/identity') {
        return {
          body: {
            id: 'launch-x-integration',
            provider: 'x',
            name: 'Shots on x',
            handle: 'shots_x',
            active: true,
            verifiedAt: new Date().toISOString(),
            nativeId: '123456789',
            verification: xVerification,
          },
        }
      }
      return { body: { error: 'Not found.' }, status: 404 }
    }, socialMockPort)
    const getPosts = () =>
      db.rows<{
        channel: string
        claims: unknown
        copy: string
        id: string
        specVersion: number | null
      }>(
        `SELECT id, channel, copy, claims, "specVersion" FROM campaign_post
       WHERE "campaignId" = $1 ORDER BY "createdAt"`,
        [campaignId]
      )
    try {
      const spec = await db.row<{
        content: unknown
        id: string
        sources: unknown
        status: string
      }>('SELECT id, status, content, sources FROM release_spec WHERE "releaseId" = $1 LIMIT 1', [
        releaseId,
      ])
      if (!spec) throw new Error('The release spec was not created.')
      expect(spec.status).toBe('APPROVED')
      const sources = spec.sources as Array<{
        flagged: boolean
        id: string
        status: string
        url: string
      }>
      expect(sources.find((source) => source.url.endsWith('/notes'))?.flagged).toBe(true)
      expect(sources.find((source) => source.url.endsWith('/changelog'))?.flagged).toBe(false)
      const flaggedId = sources.find((source) => source.flagged)!.id
      expect(JSON.stringify(spec.content)).not.toContain(`"${flaggedId}"`)

      // A person's edit may not cite a source that does not exist.
      const content = spec.content as { problem: Array<{ sources: string[]; text: string }> }
      const forged = await trpcMutation(page, 'launch.spec.update', {
        baseSpecId: spec.id,
        campaignId,
        content: { ...content, problem: [{ sources: ['S9'], text: 'Invented claim' }] },
        summary: 'Forged citation',
      })
      expect(forged.status).toBe(400)
      expect(JSON.stringify(forged.body)).toContain('S9')

      // ---------------------------------------------------------------- plan
      await app.open(`/campaigns/${campaignId}/plan`)
      await page.getByRole('button', { name: 'Plan campaign' }).click()
      await expect(page.getByText('Planned from spec v1').first()).toBeVisible({
        timeout: RUN_TIMEOUT,
      })
      await expect(page.getByText('Launch day').first()).toBeVisible()
      await page.getByRole('button', { name: 'Approve plan' }).click()
      await expect(page.getByText('Approved', { exact: true }).first()).toBeVisible()

      // ------------------------------------------------------------- produce
      await app.open(`/campaigns/${campaignId}/assets`)
      await page.getByRole('button', { name: 'Produce campaign' }).click()
      await expect(page.getByText('Variant B').first()).toBeVisible({ timeout: RUN_TIMEOUT })

      const assets = await db.rows<{
        kind: string
        planAssetKey: string | null
        variantLabel: string | null
      }>(
        'SELECT kind, "planAssetKey", "variantLabel" FROM campaign_asset WHERE "campaignId" = $1',
        [campaignId]
      )
      const shots = assets.filter((asset) => asset.kind === 'product-shot')
      expect(shots.map((shot) => `${shot.planAssetKey}${shot.variantLabel ?? ''}`).sort()).toEqual([
        'A1A',
        'A1B',
        'A2',
      ])
      const posts = await getPosts()
      expect(new Set(posts.map((post) => post.channel))).toEqual(
        new Set(['x', 'linkedin', 'product_hunt', 'changelog', 'email'])
      )
      for (const post of posts) {
        expect(post.specVersion).toBe(1)
        expect((post.claims as Array<{ ref: string }>).length).toBeGreaterThan(0)
      }

      // -------------------------------------------------------------- revise
      const target = posts.find((post) => post.channel === 'linkedin')!
      await app.open(`/campaigns/${campaignId}/copy`)
      await page.getByRole('tab', { name: /LinkedIn/ }).click()
      const card = page.getByRole('article').filter({ hasText: target.copy.slice(0, 40) })
      await card.getByRole('button', { name: 'Revise with AI' }).click()
      await page.getByLabel('What should change?').fill('Lead with the time saved')
      await page.getByRole('button', { name: 'Propose changes' }).click()
      await expect(
        page.locator('ins').filter({ hasText: 'Get hours back each month.' })
      ).toBeVisible({
        timeout: RUN_TIMEOUT,
      })
      await page.getByRole('button', { name: 'Apply changes' }).click()
      // The diff shows the new text too; wait for the apply itself, then the card.
      await expect(page.getByText('Revision applied')).toBeVisible({ timeout: RUN_TIMEOUT })
      await expect(card.getByText(/^Get hours back each month\./)).toBeVisible()

      const after = await getPosts()
      const revised = after.find((post) => post.id === target.id)!
      expect(revised.copy.startsWith('Get hours back each month.')).toBe(true)
      // One piece changed; every other post is exactly as it was.
      for (const post of after.filter((entry) => entry.id !== target.id)) {
        expect(post.copy).toBe(posts.find((entry) => entry.id === post.id)!.copy)
      }
      expect(
        await db.row(
          'SELECT status, comment FROM campaign_revision WHERE "campaignId" = $1 LIMIT 1',
          [campaignId]
        )
      ).toEqual({ comment: 'Lead with the time saved', status: 'APPLIED' })

      // ------------------------------------------------------------- approve
      await page.getByRole('button', { name: /^Submit all \d+ for review$/ }).click()
      await expect(page.getByText(/sent for review$/)).toBeVisible()
      await page.getByRole('button', { name: /^Approve all \d+$/ }).click()
      await expect(page.getByText(/posts? approved$/)).toBeVisible()
      // Every channel tab stays mounted; check the one on screen.
      await expect(
        page
          .getByRole('tabpanel')
          .filter({ visible: true })
          .getByText(/^Approved by /)
          .first()
      ).toBeVisible()

      // ---------------------------------------------------------- hand edit
      // Saving an edited approved post sends it back to draft.
      const editedCopy = `${revised.copy} Edited by hand.`
      await page.getByRole('tab', { name: /LinkedIn/ }).click()
      await page
        .getByRole('article')
        .filter({ hasText: revised.copy.slice(0, 40) })
        .getByRole('button', { name: 'Edit', exact: true })
        .click()
      const editor = page
        .getByRole('article')
        .filter({ has: page.getByRole('button', { name: 'Save changes' }) })
      await expect(editor.getByText(/^Editing sends this post back to draft\./)).toBeVisible()
      await editor.getByLabel('Copy', { exact: true }).fill(editedCopy)
      await editor.getByRole('button', { name: 'Save changes' }).click()
      const editedCard = page.getByRole('article').filter({ hasText: editedCopy })
      await expect(editedCard.getByText('Review: Draft', { exact: true })).toBeVisible()
      await editedCard.getByRole('button', { name: 'Edit', exact: true }).click()
      const postRow = () =>
        db.row<{ copy: string; status: string }>(
          'SELECT copy, status FROM campaign_post WHERE id = $1',
          [target.id]
        )
      expect(await postRow()).toEqual({ copy: editedCopy, status: 'DRAFT' })

      // A prohibited term is refused with the brand's reason, and nothing saves.
      const brand = await trpcMutation(page, 'brandProfile.upsert', {
        audience: 'Finance leads',
        productDescription: 'Invoicing for small teams',
        prohibitedTerms: [{ matchMode: 'word', reason: 'A competitor name', term: 'Zorblax' }],
        tone: 'Plain',
      })
      expect(brand.status, JSON.stringify(brand.body)).toBe(200)
      await editor.getByLabel('Copy', { exact: true }).fill(`${editedCopy} Better than Zorblax.`)
      await editor.getByRole('button', { name: 'Save changes' }).click()
      await expect(editor.getByRole('alert').filter({ hasText: '“Zorblax”' })).toContainText(
        'A competitor name'
      )
      expect((await postRow())?.copy).toBe(editedCopy)
      await editor.getByLabel('Copy', { exact: true }).fill(editedCopy)
      await editor.getByRole('button', { name: 'Save changes' }).click()
      await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0)

      // Production made product shots (no renderer in e2e), so the approvable
      // design is one rendered from the A1 shot.
      const shot = await db.row<{ assetId: string; organizationId: string }>(
        `SELECT "assetId", "organizationId" FROM campaign_asset
       WHERE "campaignId" = $1 AND "planAssetKey" = 'A1' ORDER BY "createdAt" LIMIT 1`,
        [campaignId]
      )
      if (!shot) throw new Error('No A1 product shot was produced.')
      await db.query(
        `INSERT INTO design (id, "organizationId", "campaignId", name, document, "renderedAssetId",
         "planAssetKey", "updatedAt")
       VALUES ($1, $2, $3, 'Launch hero', '{}', $4, 'A1', now())`,
        [`c${randomBytes(12).toString('hex')}`, shot.organizationId, campaignId, shot.assetId]
      )
      await app.open(`/campaigns/${campaignId}/assets`)
      const hero = page.getByRole('listitem').filter({ hasText: 'Launch hero' })
      await hero.getByRole('button', { name: 'Approve visual' }).click()
      await expect(page.getByText('Visual approved')).toBeVisible()
      await expect(hero.getByText('Approved', { exact: true })).toBeVisible()
      await expect(hero.getByRole('button', { name: 'Approve visual' })).toHaveCount(0)

      // ------------------------------------------------------------ schedule
      await enableTwoFactor(page, identity.password)
      boundOrganizationId = await bindTestGoOrganization(page)
      const connection = await trpcMutation(page, 'channelConnection.create', {
        externalAccountId: 'launch-x-integration',
        platform: 'x',
        secretReference: e2eSecretReference,
      })
      expect(connection.status, JSON.stringify(connection.body)).toBe(200)

      const xPost = after.find((post) => post.channel === 'x')!
      await app.open(`/campaigns/${campaignId}/copy`)
      await page.getByRole('tab', { name: /^X/ }).click()
      const xCard = page.getByRole('article').filter({ hasText: xPost.copy.slice(0, 40) })
      const dialog = page.getByRole('dialog')
      const submitSchedule = async (label: 'Reschedule' | 'Schedule', done: RegExp) => {
        await xCard.getByRole('button', { name: label, exact: true }).click()
        await expect(dialog.getByLabel('Account')).toHaveText('launch-x-integration (x)')
        await dialog.getByRole('button', { name: label, exact: true }).click()
        // Mock links preview badly; skipping the check is the user's call.
        const skip = dialog.getByRole('button', { name: 'Schedule without the link check' })
        await expect(page.getByText(done).or(skip)).toBeVisible()
        if (await skip.isVisible()) await skip.click()
        await expect(page.getByText(done)).toBeVisible()
      }
      const scheduledPost = () =>
        db.row<{ scheduledPostId: string | null; status: string }>(
          'SELECT status, "scheduledPostId" FROM campaign_post WHERE id = $1',
          [xPost.id]
        )

      await submitSchedule('Schedule', /^Post scheduled$/)
      // Queued until the worker picks the post up, then Scheduled; both are waiting to publish.
      await expect(xCard.getByText(/^Scheduled for .+ · (Queued|Scheduled)$/)).toBeVisible()
      const first = await scheduledPost()
      expect(first?.status).toBe('SCHEDULED')

      await xCard.getByRole('button', { name: 'Cancel schedule' }).click()
      await expect(page.getByText('Scheduled post cancelled')).toBeVisible()
      await expect(xCard.getByText(/· Cancelled$/)).toBeVisible()

      await submitSchedule('Reschedule', /^Post rescheduled$/)
      // Queued until the worker picks the post up, then Scheduled; both are waiting to publish.
      await expect(xCard.getByText(/^Scheduled for .+ · (Queued|Scheduled)$/)).toBeVisible()
      const second = await scheduledPost()
      expect(second?.status).toBe('SCHEDULED')
      expect(second?.scheduledPostId).not.toBe(first?.scheduledPostId)

      const actions = (
        await db.rows<{ action: string }>(
          'SELECT action FROM audit_log WHERE "organizationId" = $1',
          [organizationId]
        )
      ).map((entry) => entry.action)
      for (const action of [
        'product.release_spec_generated',
        'product.release_spec_approved',
        'product.campaign_plan_generated',
        'product.campaign_plan_approved',
        'product.campaign_produced',
        'product.campaign_copy_generated',
        'product.campaign_revision_proposed',
        'product.campaign_revision_applied',
      ]) {
        expect(actions).toContain(action)
      }
    } finally {
      await socialApi.close()
      await unbindTestGoOrganization(boundOrganizationId)
    }
  }
)
