import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  releaseQualificationSchema,
  releaseKitSchema,
  kitExportSchema,
  releaseClaimsPageSchema,
  releaseEvidencePageSchema,
  releaseSourceSelectionSchema,
  releaseLineageResultSchema,
} from 'screenshot-studio-backend-sdk'
import {
  acceptInvitation,
  browserRequest,
  chooseOption,
  createUploadedAsset,
  createWorkspace,
  db,
  e2eSecretReference,
  expect,
  getE2EUrl,
  openWorkspaceSetting,
  requestJson,
  signUpViaApi,
  test,
  trpcMutation,
  triggerTenantOutbox,
  waitForHydration,
  type Page,
} from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

// Provider intake is covered by Go integration tests; this browser fixture starts
// with retained external evidence, using real tenant and immutable-row constraints.
async function sourceFixture(page: Page, organizationId: string) {
  const response = await requestJson(page, '/api/tenant/source-apps', {
    name: 'Qualification deployment',
    provider: 'vercel',
    allowedHosts: ['https://api.vercel.com'],
    externalId: 'qualification-project',
    secretReference: e2eSecretReference,
  })
  expect(response.status).toBe(201)
  const source = z
    .object({ sourceApp: z.object({ id: z.string() }) })
    .parse(response.body).sourceApp
  // Match frontend-deployments.spec.ts: this paused provider fixture makes no
  // external calls; workspace membership and source access use the real owners.
  await db.query(
    `INSERT INTO frontend_source (id,"organizationId",provider,"accountId","projectId",policy,enabled)
     VALUES ($1,$2,'vercel','isolated-team','qualification-project',$3,false)`,
    [
      source.id,
      organizationId,
      {
        schemaVersion: 1,
        environments: ['production'],
        branch: '',
        tag: '',
        domain: '',
        workflowId: '',
        job: '',
        checks: [],
        alerts: [],
        workflowVersionId: '',
      },
    ]
  )
  const bindingId = crypto.randomUUID()
  await db.query(
    `INSERT INTO platform_release_source_binding
      (id, "organizationId", "sourceAppId", provider, "objectKind", "repositoryId", "providerObjectId")
      VALUES ($1,$2,$3::text,'vercel','DEPLOYMENT',$3::text,'deployment-42')`,
    [bindingId, organizationId, source.id]
  )
  const observe = async (sequence: number, title: string) => {
    const id = crypto.randomUUID()
    await db.query(
      `INSERT INTO platform_release_source_observation
       (id,"organizationId","sourceAppId","bindingId","eventKey",sequence,"bodySha256",
        "sourceUpdatedAt","occurredAt",origin,snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,'LIVE',$9)`,
      [
        id,
        organizationId,
        source.id,
        bindingId,
        `fixture-${sequence}`,
        sequence,
        sequence.toString(16).padStart(64, '0'),
        new Date(Date.UTC(2026, 10, 20, 12, sequence)).toISOString(),
        JSON.stringify({
          title,
          notes: 'Retained deployment facts.',
          url: 'https://example.vercel.app',
          repositoryName: 'example/frontend',
          commit: sequence.toString(16).repeat(40),
          environment: 'production',
          providerState: 'ready',
        }),
      ]
    )
    await db.query(
      `UPDATE platform_release_source_binding SET "currentObservationId"=$2,
       "lastEventSequence"=$3,"changeSequence"=$3,"updatedAt"=now() WHERE id=$1`,
      [bindingId, id, sequence]
    )
    return id
  }
  const observationId = await observe(1, 'Clearer deployment progress')
  return { bindingId, observationId, observe }
}

test(
  'an assigned reviewer qualifies saved facts and prior evidence survives revisions',
  { tag: '@journey' },
  async ({ app, page, workspace, browser, identity }, testInfo) => {
    await openWorkspaceSetting(page, 'General')
    const optIn = page.getByRole('checkbox', { name: 'Enable manual release qualification' })
    await expect(optIn).not.toBeChecked()
    await optIn.check()
    await page.getByRole('button', { name: 'Save workspace' }).click()
    await expect(page.getByText('Workspace details updated.')).toBeVisible()
    await app.reload()
    await expect(optIn).toBeChecked()
    const release = z.object({ release: z.object({ id: z.string() }) }).parse(
      (
        await trpcMutation(page, 'release.create', {
          title: 'Manual qualification journey',
          benefitStatement: 'A confirmed customer improvement.',
          sourceUrls: ['https://example.test/release-evidence'],
        })
      ).body
    ).release
    const evidence = await createUploadedAsset(page)
    const path = `/api/v1/releases/${release.id}/qualification`
    const email = identity.email.replace('@', '-reviewer@')
    const invitation = z.object({ id: z.string() }).parse(
      (
        await requestJson(page, '/api/auth/organization/invite-member', {
          email,
          organizationId: workspace.id,
          role: 'approver',
        })
      ).body
    )
    const reviewerContext = await browser.newContext()
    try {
      const reviewer = await reviewerContext.newPage()
      await signUpViaApi({ ...identity, email, name: 'Facts reviewer' }, reviewer)
      await acceptInvitation(reviewer, invitation.id)
      await app.open(`/releases/${release.id}`)
      await chooseOption(page.getByLabel('Fact reviewer', { exact: true }), /Facts reviewer/)
      await page
        .getByLabel('Why this change matters')
        .fill('Customers can plan this improvement with clear rollout limits.')
      await chooseOption(page.getByLabel('Rollout state'), 'Planned')
      await page
        .getByLabel('Availability', { exact: true })
        .fill('All paid workspaces after rollout.')
      await page.getByLabel('Exclusions and limitations').fill('No exclusions.')
      await page
        .getByLabel('Planned availability', { exact: true })
        .fill('Expected next week; actual availability is not yet confirmed.')
      await page.getByRole('button', { name: 'Choose evidence from Library' }).click()
      const picker = page.getByRole('dialog', { name: 'Choose release evidence' })
      await picker.getByRole('checkbox', { name: /launch.png/ }).check()
      await picker.getByRole('button', { name: 'Use 1 selected files' }).click()
      await page.getByRole('button', { name: 'Add audience', exact: true }).click()
      await chooseOption(page.getByLabel('Fact sheet', { exact: true }), 'Required')
      const factsOnlyUrl = 'https://example.test/facts-only-evidence'
      await page.getByLabel('Source links (one per line)').fill(`${factsOnlyUrl}\n${factsOnlyUrl}`)
      await page.getByRole('button', { name: 'Save facts for review' }).click()
      await expect(page.getByText('Use each source link once.')).toBeVisible()
      await page.getByLabel('Source links (one per line)').fill(factsOnlyUrl)

      const keys: string[] = []
      const bodies: unknown[] = []
      await page.route(`**${path}/revisions`, async (route) => {
        if (route.request().method() !== 'POST') return route.fallback()
        keys.push(route.request().headers()['idempotency-key'])
        bodies.push(route.request().postDataJSON())
        if (keys.length === 3)
          return route.fulfill({ status: 429, json: { message: 'Wait before retrying facts.' } })
        const response = await route.fetch()
        if (keys.length === 1) {
          expect(response.status()).toBe(201)
          return route.abort('failed')
        }
        return route.fulfill({ response })
      })
      await page.getByRole('button', { name: 'Save facts for review' }).click()
      await expect(page.getByRole('button', { name: 'Retry saved request' })).toBeVisible()
      await expect(page.getByLabel('Why this change matters')).toHaveValue(
        'Customers can plan this improvement with clear rollout limits.'
      )
      await page.route(`**${path}`, (route) =>
        route.fulfill({
          status: 404,
          json: { message: 'The facts refresh could not find the release.' },
        })
      )
      await page.getByRole('button', { name: 'Retry saved request' }).click()
      await expect(page.getByText('The facts refresh could not find the release.')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Retry saved request' })).toBeVisible()
      await page.unroute(`**${path}`)
      await page.getByRole('button', { name: 'Retry saved request' }).click()
      await expect(page.getByText('Wait before retrying facts.')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Retry saved request' })).toBeVisible()
      await page.getByRole('button', { name: 'Retry saved request' }).click()
      await expect(
        page.getByText('Facts saved. The assigned reviewer can now record a decision.')
      ).toBeVisible()
      expect(keys).toHaveLength(4)
      expect(keys[0]).toBeTruthy()
      expect(new Set(keys).size).toBe(1)
      for (const body of bodies) expect(body).toEqual(bodies[0])
      await page.unroute(`**${path}/revisions`)
      const saved = releaseQualificationSchema.parse((await browserRequest(page, path)).body)
      expect(saved.state).toBe('NEEDS_FACTS')
      expect(saved.revision).toBe('1')
      expect(saved.current?.facts.readyAt).toBeNull()
      expect(saved.current?.facts.sourceAssetIds).toEqual([evidence])
      const denied = await requestJson(
        page,
        `${path}/decisions`,
        {
          expectedRevision: saved.revision,
          qualificationRevisionId: saved.current!.id,
          decision: 'QUALIFIED',
          reason: 'The owner is not the assigned reviewer.',
        },
        'POST',
        { 'idempotency-key': 'owner-cannot-decide' }
      )
      expect(denied.status).toBe(403)

      await reviewer.goto(getE2EUrl(`/releases/${release.id}`))
      await waitForHydration(reviewer)
      const sourceLink = reviewer.getByRole('link', {
        name: `${factsOnlyUrl} (opens in a new tab)`,
        exact: true,
      })
      await expect(sourceLink).toHaveAttribute('href', factsOnlyUrl)
      await sourceLink.focus()
      await expect(sourceLink).toBeFocused()
      await reviewerContext.route(factsOnlyUrl, (route) =>
        route.fulfill({ contentType: 'text/html', body: '<h1>Release source</h1>' })
      )
      const openedSource = reviewer.waitForEvent('popup')
      await sourceLink.press('Enter')
      const sourcePage = await openedSource
      await expect(sourcePage).toHaveURL(factsOnlyUrl)
      await expect(sourcePage.getByRole('heading', { name: 'Release source' })).toBeVisible()
      await sourcePage.close()
      await expect(
        reviewer.getByRole('link', { name: /launch.png.*opens in a new tab/ })
      ).toBeVisible()
      const source = await reviewer.request.get(getE2EUrl(`/api/v1/assets/${evidence}/content`))
      expect(source.status()).toBe(200)
      expect(source.headers()['content-type']).toContain('image/png')
      await reviewer
        .getByLabel('Reason for the decision')
        .fill('Confirmed the rollout facts and supporting source.')
      await reviewer.getByRole('button', { name: 'Record decision', exact: true }).click()
      await expect(
        reviewer.getByText(
          'Decision recorded. Campaign approvals and publishing remain separate steps.'
        )
      ).toBeVisible()
      const qualified = releaseQualificationSchema.parse(
        (await browserRequest(reviewer, path)).body
      )
      expect(qualified.state).toBe('QUALIFIED')
      expect(qualified.firstQualifiedAt).not.toBeNull()
      const qualifiedScreenshot = testInfo.outputPath('qualified-release.png')
      await reviewer.screenshot({ path: qualifiedScreenshot, fullPage: true })
      await testInfo.attach('qualified-release', {
        path: qualifiedScreenshot,
        contentType: 'image/png',
      })
      expect(
        await db.row(
          'SELECT count(*)::int AS count FROM scheduled_post WHERE "organizationId"=$1',
          [workspace.id]
        )
      ).toEqual({ count: 0 })

      await app.reload()
      await page
        .getByLabel('Why this change matters')
        .fill('The updated explanation needs another facts review.')
      await page.getByRole('button', { name: 'Save facts for review' }).click()
      await expect(
        page.getByText('Facts saved. The assigned reviewer can now record a decision.')
      ).toBeVisible()
      expect(
        (
          await trpcMutation(page, 'workspace.update', {
            name: identity.workspaceName,
            slug: `qualification-${workspace.id}`,
            releaseReadinessEnabled: false,
          })
        ).status
      ).toBe(200)
      await app.reload()
      await expect(
        page
          .getByRole('region', { name: 'Page content' })
          .getByText(/Manual qualification is disabled/)
      ).toBeVisible()
      await expect(page.getByRole('button', { name: 'Save facts for review' })).toBeDisabled()
      await page.getByRole('button', { name: 'Previous facts and decisions' }).click()
      await page.getByRole('button', { name: 'View previous version' }).click()
      const history = page.getByRole('article', { name: 'Facts version 1' })
      await expect(
        history.getByText('Confirmed the rollout facts and supporting source.')
      ).toBeVisible()
      await expect(history.getByRole('link', { name: /launch.png/ })).toBeVisible()
      expect(
        (await browserRequest(page, `/api/v1/assets/${evidence}`, { method: 'DELETE' })).status
      ).toBe(409)
      const latest = releaseQualificationSchema.parse((await browserRequest(page, path)).body)
      expect(latest.state).toBe('NEEDS_FACTS')
      expect(latest.current?.version).toBe('2')
      expect(latest.firstQualifiedAt).toBe(qualified.firstQualifiedAt)
      const historyScreenshot = testInfo.outputPath('qualification-history.png')
      await page.screenshot({ path: historyScreenshot, fullPage: true })
      await testInfo.attach('qualification-history', {
        path: historyScreenshot,
        contentType: 'image/png',
      })
      expect(
        (
          await requestJson(
            page,
            `${path}/revisions`,
            { expectedRevision: latest.revision, facts: latest.current!.facts },
            'POST',
            { 'idempotency-key': 'disabled-direct-write' }
          )
        ).status
      ).toBe(403)

      expect(
        (
          await trpcMutation(page, 'workspace.update', {
            name: identity.workspaceName,
            slug: `qualification-${workspace.id}`,
            releaseReadinessEnabled: true,
          })
        ).status
      ).toBe(200)
      expect(
        (
          await requestJson(
            page,
            `${path}/revisions`,
            {
              expectedRevision: latest.revision,
              facts: {
                ...latest.current!.facts,
                ownerUserId: null,
                rollout: 'UNKNOWN',
                sourceUrls: [],
                sourceAssetIds: [],
                humanBrief: null,
                humanBriefAuthorUserId: null,
                requirements: [],
              },
            },
            'POST',
            { 'idempotency-key': 'incomplete-recovery-facts' }
          )
        ).status
      ).toBe(201)
      await reviewer.reload()
      await waitForHydration(reviewer)
      await chooseOption(reviewer.getByLabel('Qualification decision'), 'Withdrawn')
      await reviewer
        .getByLabel('Reason for the decision')
        .fill('Stop the rollout while facts are incomplete.')
      await reviewer.getByRole('button', { name: 'Record decision', exact: true }).click()
      await expect(reviewer.getByRole('button', { name: 'Reopen for facts review' })).toBeVisible()
      const withdrawn = releaseQualificationSchema.parse(
        (await browserRequest(reviewer, path)).body
      )
      expect(withdrawn.state).toBe('WITHDRAWN')
      expect(withdrawn.current?.facts.ownerUserId).toBeNull()
      expect(
        (
          await requestJson(
            page,
            `${path}/decisions`,
            {
              expectedRevision: withdrawn.revision,
              qualificationRevisionId: withdrawn.current!.id,
              decision: 'REOPEN',
              reason: 'An unassigned owner cannot reopen.',
            },
            'POST',
            { 'idempotency-key': 'owner-cannot-reopen' }
          )
        ).status
      ).toBe(403)
      await reviewer
        .getByLabel('Why are you reopening this release?')
        .fill('The owner will confirm revised rollout facts.')
      await reviewer.getByRole('button', { name: 'Reopen for facts review' }).click()
      await expect(
        reviewer.getByText(
          'Release reopened for facts review. Confirm the rollout before qualifying it again.'
        )
      ).toBeVisible()
      await expect(reviewer.getByLabel('Why this change matters')).toBeDisabled()
      const reopened = releaseQualificationSchema.parse((await browserRequest(reviewer, path)).body)
      expect(reopened.state).toBe('NEEDS_FACTS')
      expect(reopened.current?.facts.rollout).toBe('UNKNOWN')
      expect(reopened.current?.decision).toBeNull()
      expect(reopened.current?.parentRevisionId).toBe(withdrawn.current?.id)
      expect(reopened.firstQualifiedAt).toBe(qualified.firstQualifiedAt)
    } finally {
      await reviewerContext.close()
    }
  }
)

test('a stale mobile facts form preserves edits until the user reloads explicitly', async ({
  app,
  page,
  workspace,
  identity,
}) => {
  expect(
    (
      await trpcMutation(page, 'workspace.update', {
        name: identity.workspaceName,
        slug: `qualification-${workspace.id}`,
        releaseReadinessEnabled: true,
      })
    ).status
  ).toBe(200)
  const release = z.object({ release: z.object({ id: z.string() }) }).parse(
    (
      await trpcMutation(page, 'release.create', {
        title: 'Conflicting facts',
        benefitStatement: 'A useful release.',
        sourceUrls: ['https://example.test/release'],
      })
    ).body
  ).release
  const path = `/api/v1/releases/${release.id}/qualification`
  await page.setViewportSize({ width: 390, height: 844 })
  await app.open(`/releases/${release.id}`)
  await page.getByLabel('Why this change matters').fill('First saved explanation.')
  await page.getByRole('button', { name: 'Save facts for review' }).click()
  await expect(
    page.getByText('Facts saved. The assigned reviewer can now record a decision.')
  ).toBeVisible()
  const saved = releaseQualificationSchema.parse((await browserRequest(page, path)).body)
  await page.getByLabel('Why this change matters').fill('My unsaved explanation.')
  await page.getByRole('button', { name: 'Load latest sources', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Load latest sources', exact: true })).toBeEnabled()
  await expect(page.getByLabel('Why this change matters')).toHaveValue('My unsaved explanation.')
  expect(
    (
      await requestJson(
        page,
        `${path}/revisions`,
        {
          expectedRevision: saved.revision,
          facts: { ...saved.current!.facts, rationale: 'A newer saved explanation.' },
        },
        'POST',
        { 'idempotency-key': 'concurrent-revision' }
      )
    ).status
  ).toBe(201)
  await page.getByRole('button', { name: 'Save facts for review' }).click()
  await expect(page.getByRole('button', { name: 'Discard edits and load latest' })).toBeVisible()
  await expect(page.getByLabel('Why this change matters')).toHaveValue('My unsaved explanation.')
  page.once('dialog', (dialog) => dialog.dismiss())
  await page.getByRole('button', { name: 'Discard edits and load latest' }).click()
  await expect(page.getByLabel('Why this change matters')).toHaveValue('My unsaved explanation.')
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Discard edits and load latest' }).click()
  await expect(page.getByLabel('Why this change matters')).toHaveValue('A newer saved explanation.')
  await page.getByLabel('Why this change matters').focus()
  await page.keyboard.press('Tab')
  await expect(page.getByLabel('Rollout state')).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  )
})

test(
  'source selection recovers a lost response and pins evidence without qualifying or publishing',
  { tag: '@journey' },
  async ({ app, page, workspace, identity, browser }, testInfo) => {
    expect(
      (
        await trpcMutation(page, 'workspace.update', {
          name: identity.workspaceName,
          slug: `sources-${workspace.id}`,
          releaseReadinessEnabled: true,
        })
      ).status
    ).toBe(200)
    const source = await sourceFixture(page, workspace.id)
    await app.open('/campaigns/releases')
    const checkbox = page.getByRole('checkbox', { name: 'Clearer deployment progress' })
    await checkbox.focus()
    await checkbox.press('Space')
    await expect(checkbox).toBeChecked()
    await page.getByLabel('Release title', { exact: true }).fill('A clearer rollout')
    await page
      .getByLabel('What changed for users?')
      .fill('Teams can see which deployment is ready.')
    const requests: { key: string; body: unknown }[] = []
    let releaseId = ''
    await page.route('**/api/v1/release-sources/selections', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      requests.push({
        key: route.request().headers()['idempotency-key'],
        body: route.request().postDataJSON(),
      })
      if (requests.length === 2)
        return route.fulfill({ status: 429, json: { message: 'Wait before retrying sources.' } })
      const response = await route.fetch()
      releaseId = releaseSourceSelectionSchema.parse(await response.json()).releaseId
      if (requests.length === 1) {
        expect(response.status()).toBe(201)
        return route.abort('failed')
      }
      expect(response.status()).toBe(200)
      return route.fulfill({ response })
    })
    await page.getByRole('button', { name: 'Save source selection', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Retry source selection' })).toBeVisible()
    await expect(page.getByLabel('Release title', { exact: true })).toHaveValue('A clearer rollout')
    await expect(page.getByLabel('Release title', { exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Retry source selection' }).click()
    await expect(page.getByText('Wait before retrying sources.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retry source selection' })).toBeVisible()
    await expect(page.getByLabel('Release title', { exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Retry source selection' }).click()
    await expect(page.getByRole('link', { name: 'Review release facts next' })).toBeVisible()
    expect(requests).toHaveLength(3)
    expect(requests[0].key).toBeTruthy()
    for (const request of requests) expect(request).toEqual(requests[0])
    await page.unroute('**/api/v1/release-sources/selections')
    expect(
      await db.row('SELECT count(*)::int AS count FROM release WHERE "organizationId"=$1', [
        workspace.id,
      ])
    ).toEqual({ count: 1 })
    const path = `/api/v1/releases/${releaseId}/qualification`
    const selected = releaseQualificationSchema.parse((await browserRequest(page, path)).body)
    expect(selected.state).toBe('NEEDS_FACTS')
    expect(selected.current).toBeNull()
    await page.getByRole('link', { name: 'Review release facts next' }).click()
    await expect(page.getByText('Saved snapshot: Clearer deployment progress')).toBeVisible()
    await page
      .getByLabel('Why this change matters')
      .fill('The release owner can explain the rollout.')
    await page.getByRole('button', { name: 'Save facts for review' }).click()
    await expect(
      page.getByText('Facts saved. The assigned reviewer can now record a decision.')
    ).toBeVisible()
    const saved = releaseQualificationSchema.parse((await browserRequest(page, path)).body)
    expect(saved.state).toBe('NEEDS_FACTS')
    expect(saved.current?.sources.map((item) => item.observation.id)).toEqual([
      source.observationId,
    ])
    expect(saved.current?.decision).toBeNull()
    expect(
      await db.row('SELECT count(*)::int AS count FROM scheduled_post WHERE "organizationId"=$1', [
        workspace.id,
      ])
    ).toEqual({ count: 0 })
    const screenshot = testInfo.outputPath('selected-release-sources.png')
    await page
      .getByRole('heading', { name: 'Selected source evidence', exact: true })
      .scrollIntoViewIfNeeded()
    await page.screenshot({ path: screenshot, fullPage: true })
    await testInfo.attach('selected-release-sources', {
      path: screenshot,
      contentType: 'image/png',
    })

    const newerObservation = await source.observe(2, 'Updated deployment limits')
    await page.getByRole('button', { name: 'Load latest sources', exact: true }).click()
    const newerSource = page.getByRole('checkbox', { name: 'Updated deployment limits' })
    await expect(newerSource).toBeVisible()
    await newerSource.check()
    await expect(page.getByLabel('Why this change matters')).toBeDisabled()
    const refreshRequests: { key: string; body: unknown }[] = []
    await page.route('**/api/v1/release-sources/selections', async (route) => {
      refreshRequests.push({
        key: route.request().headers()['idempotency-key'],
        body: route.request().postDataJSON(),
      })
      const response = await route.fetch()
      expect(response.status()).toBe(refreshRequests.length === 1 ? 201 : 200)
      return route.fulfill({ response })
    })
    await page.route(`**${path}`, (route) =>
      route.fulfill({
        status: 404,
        json: { message: 'The source facts refresh could not find the release.' },
      })
    )
    await page.getByRole('button', { name: 'Save source selection', exact: true }).click()
    await expect(
      page.getByText('The source facts refresh could not find the release.')
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retry source selection' })).toBeVisible()
    await expect(page.getByLabel('Why this change matters')).toBeDisabled()
    await page.unroute(`**${path}`)
    await page.getByRole('button', { name: 'Retry source selection' }).click()
    await expect(page.getByText('Saved snapshot: Updated deployment limits')).toBeVisible()
    await expect(page.getByLabel('Why this change matters')).toBeEnabled()
    expect(refreshRequests).toHaveLength(2)
    expect(refreshRequests[1]).toEqual(refreshRequests[0])
    await page.unroute('**/api/v1/release-sources/selections')
    // Changing the selection cannot rewrite the evidence pinned to saved facts.
    expect(
      releaseQualificationSchema.parse((await browserRequest(page, path)).body).current?.sources[0]
        .observation.id
    ).toBe(source.observationId)
    await page.getByRole('button', { name: 'Save facts for review' }).click()
    await expect(
      page.getByText('Facts saved. The assigned reviewer can now record a decision.')
    ).toBeVisible()
    expect(
      releaseQualificationSchema.parse((await browserRequest(page, path)).body).current?.sources[0]
        .observation.id
    ).toBe(newerObservation)

    const context = await browser.newContext()
    try {
      const reader = await context.newPage()
      const readerIdentity = {
        ...identity,
        email: identity.email.replace('@', '-reader@'),
        name: 'Source reader',
      }
      const invitation = z.object({ id: z.string() }).parse(
        (
          await requestJson(page, '/api/auth/organization/invite-member', {
            email: readerIdentity.email,
            organizationId: workspace.id,
            role: 'viewer',
          })
        ).body
      )
      await signUpViaApi(readerIdentity, reader)
      await acceptInvitation(reader, invitation.id)
      expect(
        (await browserRequest(reader, `/api/v1/release-sources/${source.bindingId}/observations`))
          .status
      ).toBe(200)
      expect(
        (
          await requestJson(
            reader,
            '/api/v1/release-sources/selections',
            requests[0].body,
            'POST',
            { 'idempotency-key': 'viewer-selection-denied' }
          )
        ).status
      ).toBe(403)
    } finally {
      await context.close()
    }
    const foreignContext = await browser.newContext()
    try {
      const foreign = await foreignContext.newPage()
      await createWorkspace(
        {
          ...identity,
          email: identity.email.replace('@', '-foreign@'),
          workspaceName: `${identity.workspaceName} foreign`,
        },
        foreign
      )
      expect(
        (await browserRequest(foreign, `/api/v1/release-sources/${source.bindingId}/observations`))
          .status
      ).toBe(404)
      expect((await browserRequest(foreign, path)).status).toBe(404)
    } finally {
      await foreignContext.close()
    }
  }
)

test('a changed mobile source selection keeps edits until explicit reload and supports an exact historical snapshot', async ({
  app,
  page,
  workspace,
  identity,
}, testInfo) => {
  expect(
    (
      await trpcMutation(page, 'workspace.update', {
        name: identity.workspaceName,
        slug: `sources-${workspace.id}`,
        releaseReadinessEnabled: true,
      })
    ).status
  ).toBe(200)
  const source = await sourceFixture(page, workspace.id)
  await page.setViewportSize({ width: 390, height: 844 })
  await app.open('/campaigns/releases')
  await page.getByRole('checkbox', { name: 'Clearer deployment progress' }).check()
  await page.getByLabel('Release title', { exact: true }).fill('My release brief')
  await page.getByLabel('What changed for users?').fill('Users understand the release.')
  await source.observe(2, 'Updated deployment limits')
  await page.getByRole('button', { name: 'Save source selection', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: /changed/i })).toBeVisible()
  await expect(page.getByLabel('Release title', { exact: true })).toHaveValue('My release brief')
  expect(
    await db.row('SELECT count(*)::int AS count FROM release WHERE "organizationId"=$1', [
      workspace.id,
    ])
  ).toEqual({ count: 0 })
  page.once('dialog', (dialog) => dialog.dismiss())
  await page.getByRole('button', { name: 'Discard selection and load latest' }).click()
  await expect(page.getByLabel('Release title', { exact: true })).toHaveValue('My release brief')
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Discard selection and load latest' }).click()
  await expect(page.getByRole('checkbox', { name: 'Updated deployment limits' })).toBeVisible()
  await page.getByRole('button', { name: 'View source history' }).click()
  const history = page.getByRole('dialog', { name: 'Source observation history' })
  const original = history.getByRole('article', { name: 'Observation 1', exact: true })
  await expect(original.getByText('Clearer deployment progress')).toBeVisible()
  await expect(original.getByText('Repository: example/frontend', { exact: true })).toBeVisible()
  await expect(original.getByText(`Commit: ${'1'.repeat(40)}`, { exact: true })).toBeVisible()
  await expect(original.getByText('Environment: production', { exact: true })).toBeVisible()
  await original.getByRole('button', { name: 'Use this snapshot' }).focus()
  await page.keyboard.press('Enter')
  await expect(history).not.toBeVisible()
  await expect(page.getByText('Selected to save: Clearer deployment progress')).toBeVisible()
  await page.getByLabel('Release title', { exact: true }).fill('Reviewed original snapshot')
  await page
    .getByLabel('What changed for users?')
    .fill('Explicitly use the reviewed original facts.')
  await page.getByRole('button', { name: 'Save source selection', exact: true }).click()
  const next = page.getByRole('link', { name: 'Review release facts next' })
  await expect(next).toBeVisible()
  await expect(page.getByRole('link', { name: /Reviewed original snapshot/ })).toBeVisible()
  expect(
    await db.row(
      'SELECT "selectedObservationId" FROM platform_release_source_binding WHERE id=$1',
      [source.bindingId]
    )
  ).toEqual({ selectedObservationId: source.observationId })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  )
  const screenshot = testInfo.outputPath('mobile-source-selection.png')
  await page.screenshot({ path: screenshot, fullPage: true })
  await testInfo.attach('mobile-source-selection', { path: screenshot, contentType: 'image/png' })

  const latestObservation = await source.observe(3, 'Final deployment limits')
  await page.getByRole('button', { name: 'Load latest sources', exact: true }).click()
  await page.getByRole('checkbox', { name: 'Final deployment limits' }).check()
  await chooseOption(page.getByLabel('Use these sources for'), 'Existing release')
  await chooseOption(
    page.getByLabel('Existing release', { exact: true }),
    'Reviewed original snapshot'
  )
  await expect(
    page.getByRole('button', { name: 'Save source selection', exact: true })
  ).toBeEnabled()
  await page.getByRole('button', { name: 'Save source selection', exact: true }).click()
  await expect(next).toBeVisible()
  expect(
    await db.row('SELECT count(*)::int AS count FROM release WHERE "organizationId"=$1', [
      workspace.id,
    ])
  ).toEqual({ count: 1 })
  expect(
    await db.row(
      'SELECT "selectedObservationId" FROM platform_release_source_binding WHERE id=$1',
      [source.bindingId]
    )
  ).toEqual({ selectedObservationId: latestObservation })
})

async function selectedGroupingRelease(page: Page, organizationId: string) {
  const source = await sourceFixture(page, organizationId)
  const response = await requestJson(
    page,
    '/api/v1/release-sources/selections',
    {
      releaseId: null,
      newRelease: {
        title: 'Deployment candidate',
        benefitStatement: 'Clearer deployment progress',
      },
      expectedRevision: '0',
      sources: [
        { bindingId: source.bindingId, observationId: source.observationId, expectedSequence: '1' },
      ],
    },
    'POST',
    { 'idempotency-key': crypto.randomUUID() }
  )
  expect(response.status).toBe(201)
  return { ...source, release: releaseSourceSelectionSchema.parse(response.body) }
}

test(
  'release grouping recovers exact retries and keeps old work and URLs usable',
  { tag: '@journey' },
  async ({ app, page, workspace, identity, browser }, testInfo) => {
    expect(
      (
        await trpcMutation(page, 'workspace.update', {
          name: identity.workspaceName,
          slug: `grouping-${workspace.id}`,
          releaseReadinessEnabled: true,
          campaignWorkflowEnabled: true,
        })
      ).status
    ).toBe(200)
    const source = await selectedGroupingRelease(page, workspace.id)
    const screenshotId = await createUploadedAsset(page)
    await db.query('UPDATE release SET "screenshotAssetIds" = $1::jsonb WHERE id = $2', [
      JSON.stringify([screenshotId]),
      source.release.releaseId,
    ])
    const survivor = z.object({ release: z.object({ id: z.string() }) }).parse(
      (
        await trpcMutation(page, 'release.create', {
          title: 'One customer rollout',
          benefitStatement: 'One change customers can understand.',
          sourceUrls: [],
        })
      ).body
    ).release
    const campaignResponse = await trpcMutation(page, 'campaign.create', {
      name: 'Existing release work',
      objective: 'Keep this campaign',
      releaseId: source.release.releaseId,
    })
    expect(campaignResponse.status).toBe(200)
    await app.open(`/releases/${survivor.id}`)
    await page.getByRole('button', { name: 'Merge another release', exact: true }).click()
    const mergeDialog = page.getByRole('dialog', { name: 'Merge another release into this one' })
    await chooseOption(
      mergeDialog.getByLabel('Release to merge into this one', { exact: true }),
      'Deployment candidate'
    )
    await expect(
      mergeDialog.getByText('Clearer deployment progress', { exact: true })
    ).toBeVisible()
    await mergeDialog
      .getByLabel('Reason for this change')
      .fill('These sources describe one customer rollout.')
    const requests: { key: string; body: unknown }[] = []
    const mergePath = `/api/v1/releases/${survivor.id}/qualification/merge`
    await page.route(`**${mergePath}`, async (route) => {
      requests.push({
        key: route.request().headers()['idempotency-key'],
        body: route.request().postDataJSON(),
      })
      if (requests.length === 2)
        return route.fulfill({ status: 429, json: { message: 'Wait before retrying grouping.' } })
      const response = await route.fetch()
      expect(response.status()).toBe(requests.length === 1 ? 201 : 200)
      if (requests.length === 1) return route.abort('failed')
      return route.fulfill({ response })
    })
    await mergeDialog.getByRole('button', { name: 'Merge into this release', exact: true }).click()
    await expect(mergeDialog.getByRole('button', { name: 'Retry grouping request' })).toBeVisible()
    await expect(mergeDialog.getByLabel('Reason for this change')).toBeDisabled()
    await expect(mergeDialog.getByRole('button', { name: 'Cancel grouping' })).toBeDisabled()
    await mergeDialog.getByRole('button', { name: 'Retry grouping request' }).click()
    await expect(mergeDialog.getByText('Wait before retrying grouping.')).toBeVisible()
    await mergeDialog.getByRole('button', { name: 'Retry grouping request' }).click()
    await expect(
      mergeDialog.getByText('Releases merged. Review the facts before qualification.')
    ).toBeVisible()
    expect(requests).toHaveLength(3)
    for (const request of requests) expect(request).toEqual(requests[0])
    await page.unroute(`**${mergePath}`)
    await mergeDialog.getByRole('button', { name: 'Done', exact: true }).click()
    await app.open(`/releases/${source.release.releaseId}`)
    await expect(page.getByRole('heading', { name: 'This release was merged' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open current release' })).toHaveAttribute(
      'href',
      `/releases/${survivor.id}`
    )
    await expect(page.getByRole('link', { name: 'Create campaign from this release' })).toHaveCount(
      0
    )
    await expect(
      page.getByRole('link', { name: 'Existing release work', exact: true })
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save facts for review' })).toBeDisabled()
    const original = page.getByRole('link', {
      name: 'Screenshot View original (opens in a new tab)',
      exact: true,
    })
    await expect(original).toHaveAttribute('href', `/api/v1/assets/${screenshotId}/content`)
    await expect(original).toHaveAttribute('target', '_blank')
    await expect(page.getByTestId('release-open-editor')).toHaveCount(0)
    const [preview] = await Promise.all([page.waitForEvent('popup'), original.click()])
    await preview.waitForLoadState('domcontentloaded')
    await expect
      .poll(() => preview.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0)
    await preview.close()
    await page.getByRole('button', { name: 'Merge and split history' }).click()
    const history = page.getByRole('dialog', { name: 'Merge and split history' })
    await expect(history.getByText('These sources describe one customer rollout.')).toBeVisible()
    await expect(history.getByRole('link', { name: 'Destination release' })).toHaveAttribute(
      'href',
      `/releases/${survivor.id}`
    )
    await history.getByRole('button', { name: 'Close history' }).click()
    await page.getByRole('link', { name: 'Open current release' }).click()
    await page.getByRole('button', { name: 'Split sources', exact: true }).click()
    const splitDialog = page.getByRole('dialog', { name: 'Split sources into a new release' })
    await splitDialog.getByLabel('New release title').fill('Independent rollout')
    await splitDialog
      .getByLabel('Why the new release matters')
      .fill('This rollout needs its own review.')
    const selection = splitDialog.getByRole('checkbox', { name: 'Clearer deployment progress' })
    await selection.focus()
    await selection.press('Space')
    await expect(selection).toBeChecked()
    await splitDialog
      .getByLabel('Reason for this change')
      .fill('The deployment ships independently.')
    const splitRequests: { key: string; body: unknown }[] = []
    let newReleaseId = ''
    const factsPath = `/api/v1/releases/${survivor.id}/qualification`
    await page.route(`**${factsPath}/split`, async (route) => {
      splitRequests.push({
        key: route.request().headers()['idempotency-key'],
        body: route.request().postDataJSON(),
      })
      const response = await route.fetch()
      expect(response.status()).toBe(splitRequests.length === 1 ? 201 : 200)
      newReleaseId = releaseLineageResultSchema.parse(await response.json()).releases[1].releaseId
      return route.fulfill({ response })
    })
    await page.route(`**${factsPath}`, (route) =>
      route.fulfill({ status: 404, json: { message: 'The grouping refresh is unavailable.' } })
    )
    await splitDialog.getByRole('button', { name: 'Create separate release', exact: true }).click()
    await expect(splitDialog.getByText('The grouping refresh is unavailable.')).toBeVisible()
    await expect(splitDialog.getByLabel('New release title')).toHaveValue('Independent rollout')
    await expect(splitDialog.getByLabel('New release title')).toBeDisabled()
    await page.unroute(`**${factsPath}`)
    await splitDialog.getByRole('button', { name: 'Retry grouping request' }).click()
    await expect(splitDialog.getByRole('link', { name: 'Open new release' })).toHaveAttribute(
      'href',
      `/releases/${newReleaseId}`
    )
    expect(splitRequests).toHaveLength(2)
    expect(splitRequests[1]).toEqual(splitRequests[0])
    await page.unroute(`**${factsPath}/split`)
    const screenshot = testInfo.outputPath('release-grouping-result.png')
    await page.screenshot({ path: screenshot, fullPage: true })
    await testInfo.attach('release-grouping-result', { path: screenshot, contentType: 'image/png' })
    await splitDialog.getByRole('button', { name: 'Done', exact: true }).click()
    expect(
      await db.row(
        'SELECT count(*)::int AS count FROM platform_release_lineage WHERE "organizationId"=$1',
        [workspace.id]
      )
    ).toEqual({ count: 2 })
    expect(
      await db.row('SELECT "canonicalReleaseId" FROM platform_release_source_binding WHERE id=$1', [
        source.bindingId,
      ])
    ).toEqual({ canonicalReleaseId: newReleaseId })
    expect(
      await db.row('SELECT "releaseId" FROM campaign WHERE "organizationId"=$1 AND name=$2', [
        workspace.id,
        'Existing release work',
      ])
    ).toEqual({ releaseId: source.release.releaseId })
    expect(
      await db.row('SELECT count(*)::int AS count FROM scheduled_post WHERE "organizationId"=$1', [
        workspace.id,
      ])
    ).toEqual({ count: 0 })
    for (const id of [survivor.id, newReleaseId]) {
      const facts = releaseQualificationSchema.parse(
        (await browserRequest(page, `/api/v1/releases/${id}/qualification`)).body
      )
      expect(facts.state).toBe('NEEDS_FACTS')
      expect(facts.firstQualifiedAt).toBeNull()
    }
    const context = await browser.newContext()
    try {
      const reader = await context.newPage()
      const readerIdentity = {
        ...identity,
        email: identity.email.replace('@', '-group-reader@'),
        name: 'Grouping reader',
      }
      const invitation = z.object({ id: z.string() }).parse(
        (
          await requestJson(page, '/api/auth/organization/invite-member', {
            email: readerIdentity.email,
            organizationId: workspace.id,
            role: 'viewer',
          })
        ).body
      )
      await signUpViaApi(readerIdentity, reader)
      await acceptInvitation(reader, invitation.id)
      expect((await browserRequest(reader, `${factsPath}/lineage`)).status).toBe(200)
      expect(
        (
          await requestJson(reader, mergePath, requests[0].body, 'POST', {
            'idempotency-key': 'reader-denied',
          })
        ).status
      ).toBe(403)
      await reader.goto(getE2EUrl(`/releases/${survivor.id}`))
      await waitForHydration(reader)
      await expect(
        reader.getByRole('button', { name: 'Split sources', exact: true })
      ).toBeDisabled()
    } finally {
      await context.close()
    }
    expect(
      (
        await trpcMutation(page, 'workspace.update', {
          name: identity.workspaceName,
          slug: `grouping-${workspace.id}`,
          releaseReadinessEnabled: false,
        })
      ).status
    ).toBe(200)
    await app.open(`/releases/${newReleaseId}`)
    await page.getByRole('button', { name: 'Merge and split history' }).click()
    await expect(
      page
        .getByRole('dialog', { name: 'Merge and split history' })
        .getByText('The deployment ships independently.')
    ).toBeVisible()
  }
)

test('mobile grouping keeps stale edits until explicit reload and prevents overlapping fact edits', async ({
  app,
  page,
  workspace,
  identity,
}, testInfo) => {
  expect(
    (
      await trpcMutation(page, 'workspace.update', {
        name: identity.workspaceName,
        slug: `group-mobile-${workspace.id}`,
        releaseReadinessEnabled: true,
      })
    ).status
  ).toBe(200)
  const source = await selectedGroupingRelease(page, workspace.id)
  await page.setViewportSize({ width: 390, height: 844 })
  await app.open(`/releases/${source.release.releaseId}`)
  await page.getByLabel('Why this change matters').fill('Unsaved facts')
  await expect(page.getByRole('button', { name: 'Split sources', exact: true })).toBeDisabled()
  await page.getByLabel('Why this change matters').fill('')
  await page.getByRole('button', { name: 'Split sources', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Split sources into a new release' })
  await dialog.getByLabel('New release title').fill('Mobile split')
  await dialog.getByLabel('Why the new release matters').fill('An independent improvement.')
  await dialog.getByRole('checkbox', { name: 'Clearer deployment progress' }).check()
  await dialog.getByLabel('Reason for this change').fill('A separate rollout needs review.')
  expect(
    (
      await trpcMutation(page, 'release.update', {
        releaseId: source.release.releaseId,
        title: 'Changed in another tab',
      })
    ).status
  ).toBe(200)
  await dialog.getByRole('button', { name: 'Create separate release', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Reload releases and sources' })).toBeVisible()
  await expect(dialog.getByLabel('New release title')).toHaveValue('Mobile split')
  expect(
    await db.row(
      'SELECT count(*)::int AS count FROM platform_release_lineage WHERE "organizationId"=$1',
      [workspace.id]
    )
  ).toEqual({ count: 0 })
  await dialog.getByRole('button', { name: 'Reload releases and sources' }).click()
  await expect(
    dialog.getByRole('checkbox', { name: 'Clearer deployment progress' })
  ).not.toBeChecked()
  await expect(dialog.getByLabel('New release title')).toHaveValue('Mobile split')
  await dialog.getByRole('checkbox', { name: 'Clearer deployment progress' }).focus()
  await page.keyboard.press('Space')
  await expect(dialog.getByRole('checkbox', { name: 'Clearer deployment progress' })).toBeChecked()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  )
  const screenshot = testInfo.outputPath('mobile-release-grouping.png')
  await page.screenshot({ path: screenshot, fullPage: true })
  await testInfo.attach('mobile-release-grouping', { path: screenshot, contentType: 'image/png' })
  await dialog.getByRole('button', { name: 'Create separate release', exact: true }).click()
  await expect(dialog.getByRole('link', { name: 'Open new release' })).toBeVisible()
  expect(
    await db.row(
      'SELECT count(*)::int AS count FROM platform_release_lineage WHERE "organizationId"=$1',
      [workspace.id]
    )
  ).toEqual({ count: 1 })
})

test(
  'claim review pins exact evidence and changed evidence removes support',
  { tag: '@journey' },
  async ({ app, page, workspace, identity }) => {
    expect(
      (
        await trpcMutation(page, 'workspace.update', {
          name: identity.workspaceName,
          slug: `claim-review-${workspace.id}`,
          releaseReadinessEnabled: true,
        })
      ).status
    ).toBe(200)
    const { release } = z.object({ release: z.object({ id: z.string() }) }).parse(
      (
        await trpcMutation(page, 'release.create', {
          title: 'Claim review journey',
          benefitStatement: 'Clear product facts.',
          sourceUrls: ['https://example.test/claim'],
        })
      ).body
    )
    const base = `/api/v1/releases/${release.id}`
    await app.open(`/releases/${release.id}`)
    await chooseOption(page.getByLabel('Fact reviewer', { exact: true }), new RegExp(identity.name))
    await page.getByLabel('Why this change matters').fill('Give customers a checked product fact.')
    await page.getByRole('button', { name: 'Save facts for review' }).click()
    await expect(
      page.getByText('Facts saved. The assigned reviewer can now record a decision.')
    ).toBeVisible()
    await page.getByRole('button', { name: 'Add evidence', exact: true }).click()
    const passage = 'Exports support UTF-8 names, including café and 日本語.'
    await page.getByLabel('Exact passage', { exact: true }).fill(passage)
    await page.getByLabel('Why this source is relevant').fill('The retained product specification.')
    await page.getByRole('button', { name: 'Retain evidence', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Add claim', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Add claim', exact: true }).click()
    const claimForm = page.getByRole('group', { name: 'New product claim' })
    await claimForm.getByLabel('Exact factual claim').fill('Exports retain international names.')
    for (const [name, text] of [
      ['Audience', 'All workspace members'],
      ['Availability', 'Available now'],
      ['Eligibility', 'Every plan'],
      ['Limitations', 'UTF-8 names only'],
    ]) {
      await claimForm.getByLabel(name, { exact: true }).fill(text)
    }
    const claimRequests: { key: string; body: unknown }[] = []
    await page.route(`**${base}/claims`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      claimRequests.push({
        key: route.request().headers()['idempotency-key'],
        body: route.request().postDataJSON(),
      })
      const response = await route.fetch()
      expect(response.status()).toBe(claimRequests.length === 1 ? 201 : 200)
      if (claimRequests.length === 1) return route.abort('failed')
      return route.fulfill({ response })
    })
    await page.getByRole('button', { name: 'Save claim for review' }).click()
    await expect(page.getByRole('button', { name: 'Retry saved request' })).toBeEnabled()
    await expect(claimForm.getByLabel('Exact factual claim')).toHaveValue(
      'Exports retain international names.'
    )
    await page.getByRole('button', { name: 'Retry saved request' }).click()
    await expect(claimForm).toBeHidden()
    expect(claimRequests).toHaveLength(2)
    expect(claimRequests[1]).toEqual(claimRequests[0])
    await page.unroute(`**${base}/claims`)

    await expect(
      page.getByText('Exports retain international names.', { exact: true })
    ).toBeVisible()
    let claim = releaseClaimsPageSchema.parse((await browserRequest(page, `${base}/claims`)).body)
      .items[0]!
    expect(claim.state).toBe('UNRESOLVED')
    expect(claim.decision).toBeNull()
    await page.getByRole('button', { name: 'Review supporting evidence' }).click()
    await chooseOption(page.getByLabel('Add a supporting or contradictory source'), passage)
    await page.getByLabel('Exact passage to review').fill('café and 日本語')
    await page.getByRole('button', { name: 'Add to review set' }).click()
    await page.getByRole('button', { name: 'Save support set' }).click()
    await expect(page.getByRole('button', { name: 'Review supporting evidence' })).toBeEnabled()
    await page.getByRole('button', { name: 'Review supporting evidence' }).click()
    const decision = page.getByRole('group', { name: 'Assigned human review' })
    await chooseOption(decision.getByLabel('Decision', { exact: true }), 'Supported')
    await decision
      .getByLabel('Rationale', { exact: true })
      .fill('I checked the retained UTF-8 passage against the wording and its conditions.')
    await page.getByRole('button', { name: 'Record factual decision' }).click()
    await expect(decision).toBeHidden()
    await expect(page.getByText('Supported', { exact: true })).toBeVisible()
    claim = releaseClaimsPageSchema.parse((await browserRequest(page, `${base}/claims`)).body)
      .items[0]!
    expect(claim.state).toBe('SUPPORTED')
    expect(claim.decision?.humanUserId).toBeTruthy()
    const apiKey = z.object({ apiKey: z.object({ key: z.string() }) }).parse(
      (
        await trpcMutation(page, 'apiKey.create', {
          name: 'Claim read check',
          scopes: ['artifact:read', 'release:create'],
        })
      ).body
    ).apiKey.key
    const machine = releaseClaimsPageSchema.parse(
      (await browserRequest(page, `${base}/claims`, { headers: { 'x-api-key': apiKey } })).body
    ).items[0]!
    expect(machine.evidence.every((item) => item.text === null && item.sourceUrl === null)).toBe(
      true
    )
    expect(machine.decision?.humanUserId).toBe('')
    expect(
      (
        await requestJson(
          page,
          `${base}/claims/${claim.id}/decisions`,
          {
            expectedRevision: releaseQualificationSchema.parse(
              (await browserRequest(page, `${base}/qualification`)).body
            ).revision,
            claimVersionId: claim.versionId,
            claimSha256: claim.sha256,
            supportSetId: claim.supportSetId,
            supportSha256: claim.supportSha256,
            decision: 'SUPPORTED',
            reason: 'API key must not approve',
          },
          'POST',
          { 'x-api-key': apiKey, 'idempotency-key': crypto.randomUUID() }
        )
      ).status
    ).toBe(403)

    const kitExportId = await reviewKitJourney(page, base, identity.name)

    const evidence = releaseEvidencePageSchema.parse(
      (await browserRequest(page, `${base}/evidence`)).body
    ).items[0]!
    const current = releaseQualificationSchema.parse(
      (await browserRequest(page, `${base}/qualification`)).body
    )
    const command = {
      expectedRevision: current.revision,
      sourceId: evidence.sourceId,
      expectedSourceSequence: evidence.sourceSequence,
      kind: 'TEXT',
      origin: 'HUMAN',
      text: 'Exports currently accept ASCII names only.',
      purpose: 'Corrected product specification.',
      observedAt: new Date().toISOString(),
    }
    const key = crypto.randomUUID()
    expect(
      (await requestJson(page, `${base}/evidence`, command, 'POST', { 'idempotency-key': key }))
        .status
    ).toBe(201)
    expect(
      (await requestJson(page, `${base}/evidence`, command, 'POST', { 'idempotency-key': key }))
        .status
    ).toBe(200)
    const blockedExport = await browserRequest(
      page,
      `${base}/kit-exports/${kitExportId}?download=true`
    )
    expect(blockedExport.status).toBe(409)
    expect(JSON.stringify(blockedExport.body)).toContain('SOURCE_CHANGED')
    await page.getByRole('button', { name: 'Reload review' }).click()
    await expect(page.getByText('Needs review', { exact: true })).toBeVisible()
    await expect(page.getByText('Source changed since capture', { exact: false })).toBeVisible()
    claim = releaseClaimsPageSchema.parse((await browserRequest(page, `${base}/claims`)).body)
      .items[0]!
    expect(claim.state).toBe('UNRESOLVED')
    expect(claim.decision?.decision).toBe('SUPPORTED')
    expect(claim.blockers.length).toBeGreaterThan(0)
    await page.getByRole('button', { name: 'Import next batch of legacy specs' }).click()
    await expect(
      page.getByRole('button', { name: 'Import next batch of legacy specs' })
    ).toBeHidden()
    const imported = releaseClaimsPageSchema.parse(
      (await browserRequest(page, `${base}/claims`)).body
    )
    expect(imported.importProgress.done).toBe(true)
    expect(imported.items).toHaveLength(1)
    expect(imported.items[0]!.state).toBe('UNRESOLVED')
  }
)

// The same real tenant journey continues through preparation, two human reviews,
// rejection/replacement and stored export. No social account or AI is involved.
async function reviewKitJourney(page: Page, base: string, reviewerName: string): Promise<string> {
  let qualification = releaseQualificationSchema.parse(
    (await browserRequest(page, `${base}/qualification`)).body
  )
  const facts = qualification.current!.facts
  expect(
    (
      await requestJson(
        page,
        `${base}/qualification/revisions`,
        {
          expectedRevision: qualification.revision,
          facts: {
            ...facts,
            rationale: 'A checked release is ready for the sales team.',
            rollout: 'GENERAL',
            availability: 'Available now.',
            eligibility: 'Paid plans.',
            exclusions: 'No trial accounts.',
            readyAt: new Date().toISOString(),
            requirements: [
              {
                id: 'sales',
                kind: 'SALES',
                label: 'Sales',
                materials: ['FACT_SHEET', 'SALES_NOTES'],
                omissions: [],
              },
            ],
          },
        },
        'POST',
        { 'idempotency-key': crypto.randomUUID() }
      )
    ).status
  ).toBe(201)
  qualification = releaseQualificationSchema.parse(
    (await browserRequest(page, `${base}/qualification`)).body
  )
  expect(
    (
      await requestJson(
        page,
        `${base}/qualification/decisions`,
        {
          expectedRevision: qualification.revision,
          qualificationRevisionId: qualification.current!.id,
          decision: 'QUALIFIED',
          reason: 'Confirmed availability, eligibility and audience requirements.',
        },
        'POST',
        { 'idempotency-key': crypto.randomUUID() }
      )
    ).status
  ).toBe(201)
  await page.reload()
  await page.getByRole('button', { name: 'Assemble release kit', exact: true }).click()
  const composer = page.getByRole('group', { name: 'Add material', exact: true })
  await composer.getByLabel('Exports retain international names.', { exact: true }).check()
  await composer.getByRole('button', { name: 'Add to candidate', exact: true }).click()
  await chooseOption(composer.getByLabel('Material', { exact: true }), 'SALES NOTES')
  await composer.getByLabel('Exports retain international names.', { exact: true }).check()
  await composer.getByRole('button', { name: 'Add to candidate', exact: true }).click()
  await chooseOption(page.getByLabel('Kit approver', { exact: true }), new RegExp(reviewerName))
  const requests: { key: string; body: unknown }[] = []
  await page.route(`**${base}/kits`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    requests.push({
      key: route.request().headers()['idempotency-key'],
      body: route.request().postDataJSON(),
    })
    const response = await route.fetch()
    expect(response.status()).toBe(requests.length === 1 ? 201 : 200)
    if (requests.length === 1) return route.abort('failed')
    return route.fulfill({ response })
  })
  await page.getByRole('button', { name: 'Save kit candidate', exact: true }).click()
  await page.getByRole('button', { name: 'Retry same kit request', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Freeze and prepare outputs', exact: true })
  ).toBeEnabled()
  expect(requests).toHaveLength(2)
  expect(requests[1]).toEqual(requests[0])
  await page.unroute(`**${base}/kits`)
  await prepareKitOutputs(page)
  await expect(page.getByRole('button', { name: 'Review prepared content' }).first()).toBeEnabled({
    timeout: 60_000,
  })
  await page.getByRole('button', { name: 'Review prepared content' }).first().click()
  await expect(
    page.getByRole('dialog').getByText('Preview — not approved for distribution', { exact: true })
  ).toBeVisible()
  await expect(page.getByRole('dialog').locator('pre')).toContainText(
    'Exports retain international names.'
  )
  await page.keyboard.press('Escape')
  await page
    .getByLabel('Review note', { exact: true })
    .fill('Please prepare a replacement fact sheet.')
  await page.getByRole('button', { name: 'Request changes', exact: true }).click()
  await expect(
    page.getByRole('paragraph').filter({ hasText: /^Revision 1 · rejected$/ })
  ).toBeVisible()
  const first = releaseKitSchema.parse((await browserRequest(page, `${base}/kits`)).body)
  await page.getByRole('button', { name: 'Create replacement revision', exact: true }).click()
  await page.getByRole('button', { name: 'Remove', exact: true }).first().click()
  await composer.getByLabel('Exports retain international names.', { exact: true }).check()
  await composer.getByRole('button', { name: 'Add to candidate', exact: true }).click()
  await page.getByRole('button', { name: 'Save kit candidate', exact: true }).click()
  await prepareKitOutputs(page)
  await expect(page.getByRole('button', { name: 'Review prepared content' }).last()).toBeEnabled({
    timeout: 60_000,
  })
  for (const text of [
    'Every factual assertion is mapped',
    'Screenshots match the qualified behavior',
    'Each artifact is suitable',
  ])
    await page.getByLabel(new RegExp(text)).check()
  await page
    .getByLabel('Review note', { exact: true })
    .fill('Every claim and qualifier has retained evidence. Sales material is internal.')
  await page.getByRole('button', { name: 'Confirm content coverage', exact: true }).click()
  await expect(page.getByLabel('Review note', { exact: true })).toHaveValue('')
  await page.getByLabel('Review note', { exact: true }).fill('I approve the exact prepared kit.')
  await page.getByRole('button', { name: 'Approve kit', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Prepare approved ZIP', exact: true })
  ).toBeVisible()
  const approved = releaseKitSchema.parse((await browserRequest(page, `${base}/kits`)).body)
  expect(approved.artifacts.some((artifact) => artifact.id === first.artifacts[1].id)).toBe(true)
  expect(approved.readiness.canExportApproved).toBe(true)
  expect(approved.history.find((revision) => revision.id === first.id)?.state).toBe('SUPERSEDED')
  await page.locator('#kit-export-sales').check()
  const [exportResponse] = await Promise.all([
    page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().endsWith('/exports')
    ),
    page.getByRole('button', { name: 'Prepare approved ZIP', exact: true }).click(),
  ])
  expect(exportResponse.status()).toBe(202)
  await triggerTenantOutbox()
  await expect(
    page.getByRole('button', { name: 'Download approved ZIP', exact: true })
  ).toBeEnabled({ timeout: 60_000 })
  const current = releaseKitSchema.parse((await browserRequest(page, `${base}/kits`)).body)
  const exportId = current.exportIds[0]
  const one = kitExportSchema.parse(
    (await browserRequest(page, `${base}/kit-exports/${exportId}?download=true`)).body
  )
  const two = kitExportSchema.parse(
    (await browserRequest(page, `${base}/kit-exports/${exportId}?download=true`)).body
  )
  expect(one.sha256).toBe(two.sha256)
  expect(one.fileIndex.files).toHaveLength(2)
  expect(one.downloadUrl).toBeTruthy()
  const download = await page.request.get(one.downloadUrl!)
  expect(download.status()).toBe(200)
  expect(download.headers()['cache-control']).toBe('private, no-store')
  expect(
    createHash('sha256')
      .update(await download.body())
      .digest('hex')
  ).toBe(one.sha256)
  expect(JSON.stringify(one.fileIndex)).not.toContain('sourceUrl')
  return exportId
}

async function prepareKitOutputs(page: Page): Promise<void> {
  const [response] = await Promise.all([
    page.waitForResponse(
      (reply) => reply.request().method() === 'POST' && reply.url().endsWith('/prepare')
    ),
    page.getByRole('button', { name: 'Freeze and prepare outputs', exact: true }).click(),
  ])
  expect(response.status()).toBe(202)
  await triggerTenantOutbox()
}
