import {
  apiRequest,
  chooseOption,
  db,
  draftEditor,
  expect,
  expectSaved,
  openNewDraft,
  test,
} from './framework'

test.skip(
  process.env.TYPEFULLY_E2E_WORKER !== '1',
  'Requires the isolated test database and controlled Temporal provider worker.'
)

test(
  'reviewed content schedules, publishes once, notifies its brand, gains observations and repurposes',
  { tag: '@journey' },
  async ({ app, identity, page, startWorkspace }) => {
    page.setDefaultTimeout(20_000)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const workspace = await startWorkspace({ channels: ['x'] })
    // Only the HTTP peer is fake; canonical connections and permission checks remain live.
    await db.query(`UPDATE "Integration" SET token='valid' WHERE id=$1`, [
      `social-${workspace.id}-x`,
    ])
    expect(
      (
        await apiRequest(page, '/api/v1/content-draft-settings', {
          method: 'PUT',
          body: { requireApproval: true },
        })
      ).status
    ).toBe(200)
    const social = process.env.SOCIAL_E2E_URL!
    await fetch(`${social}/control`, { method: 'POST', body: JSON.stringify({ mode: 'normal' }) })
    await fetch(`${social}/control`, {
      method: 'POST',
      body: JSON.stringify({ engagement: { likes: 17, reposts: 3 } }),
    })
    const notices = process.env.NOTIFICATIONS_E2E_PROVIDER_URL!
    const sink = async () =>
      (await (await fetch(`${notices}/sink`)).json()) as {
        slack: { channel: string; text: string }[]
      }
    await app.open('/settings/notifications')
    await page.getByRole('button', { name: 'Delivery & Slack', exact: true }).click()
    await page.getByRole('button', { name: 'Connect Slack', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Local Slack fixture' })).toBeVisible()
    await page.getByRole('link', { name: 'Allow selected workspace' }).click()
    await chooseOption(page.getByLabel('Slack workspace'), 'Fixture team')
    await chooseOption(page.getByLabel('Slack channel', { exact: true }), '#workspace-activity')
    await chooseOption(
      page.getByLabel(`Slack channel for ${identity.workspaceName}`, { exact: true }),
      '#brand-publishing'
    )
    await page.getByRole('button', { name: 'Save workspace policy', exact: true }).click()
    await expect(page.getByText('Workspace policy saved.', { exact: true })).toBeVisible()
    await app.reload()
    await page.getByRole('button', { name: 'Delivery & Slack', exact: true }).click()
    await expect(
      page.getByLabel(`Slack channel for ${identity.workspaceName}`, { exact: true })
    ).toContainText('#brand-publishing')

    const id = await openNewDraft(page)
    await page.getByLabel('Draft title', { exact: true }).fill('Lifecycle release')
    await draftEditor(page).fill('A release worth reading.')
    await draftEditor(page).press('End')
    await page.keyboard.insertText(' Edited and reviewed.')
    await expectSaved(page)
    await page.getByRole('button', { name: 'Preview', exact: true }).click()
    await expect(page.getByTestId('preview-x')).toContainText('Edited and reviewed.')
    await page.getByRole('button', { name: 'Preview', exact: true }).click()
    await page.getByTestId('publish-button').click()
    await expect(page.getByTestId('publish-review')).toContainText('Ask for review first')
    await expect(
      page.getByTestId('publish-review').getByRole('button', { name: 'Publish now', exact: true })
    ).toBeDisabled()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Review', exact: true }).click()
    await page.getByLabel('Review note').fill('Ready for launch.')
    await page.getByRole('button', { name: 'Ask for review', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Review', exact: true })).toContainText(
      'In review'
    )
    await page.getByRole('button', { name: 'Approve', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Review', exact: true })).toContainText(
      'Approved'
    )
    await page.keyboard.press('Escape')
    await page.getByTestId('schedule-button').click()
    const schedule = page.getByTestId('schedule-dialog')
    // Minute resolution: choose the next whole minute with at least 65 seconds' lead.
    const at = new Date(Math.ceil((Date.now() + 65_000) / 60_000) * 60_000)
    await schedule.getByRole('button', { name: 'Today (UTC)', exact: true }).click()
    await schedule.getByLabel('Time', { exact: true }).fill(at.toISOString().slice(11, 16))
    await schedule.getByRole('checkbox', { name: 'Open a new draft after scheduling' }).uncheck()
    await schedule.getByRole('button', { name: 'Confirm schedule', exact: true }).click()
    await expect(page.getByTestId('draft-post')).toContainText('Scheduled')
    const queued = await db.query(
      `SELECT id,status,"scheduledFor" FROM scheduled_post WHERE "contentDraftId"=$1`,
      [id]
    )
    expect(queued.rows).toHaveLength(1)
    expect(new Date(queued.rows[0].scheduledFor).toISOString()).toBe(at.toISOString())
    const before = await (await fetch(`${social}/state`)).json()
    expect(before.posts).toHaveLength(0)
    await app.reload()
    await expect(page.getByTestId('draft-post')).toContainText('Scheduled')
    await expect
      .poll(
        async () =>
          (await db.query(`SELECT status FROM scheduled_post WHERE id=$1`, [queued.rows[0].id]))
            .rows[0]?.status,
        { timeout: 150_000, intervals: [2000] }
      )
      .toBe('PUBLISHED')
    await app.reload()
    await expect(page.getByTestId('draft-post')).toContainText('Published')
    const receipts = await (await fetch(`${social}/state`)).json()
    expect(receipts.posts).toHaveLength(1)
    expect(receipts.posts[0].caption).toBe('A release worth reading. Edited and reviewed.')
    await expect
      .poll(
        async () =>
          (await sink()).slack.filter(
            (m) => m.text.includes(identity.workspaceName) && m.text.includes('published')
          ).length,
        { timeout: 30_000 }
      )
      .toBe(1)
    const publishNotice = (await sink()).slack.find(
      (m) => m.text.includes(identity.workspaceName) && m.text.includes('published')
    )!
    expect(publishNotice.channel).toBe('C067890')
    await expect
      .poll(
        async () =>
          (
            await db.query(
              `SELECT metrics FROM platform_social_observation WHERE "subjectId"=$1 AND status='available'`,
              [queued.rows[0].id]
            )
          ).rows[0]?.metrics?.likes,
        { timeout: 30_000 }
      )
      .toBe(17)
    await app.open('/publish/analyze/observations')
    await expect(page.getByTestId('social-analytics')).toContainText('17')
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export CSV', exact: true }).click()
    expect((await download).suggestedFilename()).toBe('social-observations.csv')
    await page.getByRole('button', { name: 'New draft of another kind' }).click()
    await page.getByRole('menuitem', { name: 'Repurpose published content' }).click()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Lifecycle release', exact: true })
      .click()
    await expect(draftEditor(page)).toContainText('Edited and reviewed.')
    const reused = new URL(page.url()).pathname.split('/').at(-1)!
    expect(reused).not.toBe(id)
    await expectSaved(page)
    await app.reload()
    await expect(draftEditor(page)).toContainText('Edited and reviewed.')
    const reuse = await apiRequest(page, `/api/v1/content-drafts/${reused}`)
    expect((reuse.body as { reviewStatus: string }).reviewStatus).toBe('none')
    expect(
      (await db.query(`SELECT id FROM scheduled_post WHERE "contentDraftId"=$1`, [reused])).rows
    ).toHaveLength(0)
    expect((await (await fetch(`${social}/state`)).json()).posts).toHaveLength(1)
    expect(errors).toEqual([])
    await page.screenshot({ path: '.context/shots/typefully-lifecycle-repurposed.png' })
  }
)
