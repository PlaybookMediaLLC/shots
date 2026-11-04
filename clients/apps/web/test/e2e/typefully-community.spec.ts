import { db, draftEditor, expect, expectSaved, openNewDraft, test } from './framework'

test(
  'community timeline choice persists through audience, publish review and schedule snapshot',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    await startWorkspace({ channels: ['x'] })
    const id = await openNewDraft(page)
    await draftEditor(page).pressSequentially('A community update.')
    await expectSaved(page)
    await page.getByTestId('options-chip').click()
    await page.getByRole('button', { name: 'Audience: everyone', exact: true }).click()
    const audience = page.getByRole('dialog', { name: 'Audience', exact: true })
    await audience.getByLabel('Community URL or id').fill('https://x.com/i/communities/42')
    await audience.getByLabel('Name, for your reference').fill('Builders')
    await expect(audience.getByLabel('Share to timeline')).toBeChecked()
    await audience.getByLabel('Share to timeline').uncheck()
    await audience.getByRole('button', { name: 'Post to this community' }).click()
    await expectSaved(page)
    await app.reload()
    await page.getByTestId('publish-button').click()
    const review = page.getByTestId('publish-review')
    await expect(review.getByLabel('Share to timeline')).not.toBeChecked()
    await expect(review).toContainText('remains public')
    await review.getByLabel('Share to timeline').check()
    await review.getByRole('button', { name: 'Close', exact: true }).click()
    await expectSaved(page)
    await app.reload()
    await page.getByTestId('schedule-button').click()
    const schedule = page.getByTestId('schedule-dialog')
    await expect(schedule.getByLabel('Share to timeline')).toBeChecked()
    await schedule.getByLabel('Share to timeline').uncheck()
    await schedule.getByRole('button', { name: /^Tomorrow 9:00/ }).click()
    await schedule.getByLabel('Open a new draft after scheduling').uncheck()
    await schedule.getByRole('button', { name: /^Confirm schedule/ }).click()
    await expect(schedule).toHaveCount(0)
    const rows = await db.rows<{
      options: { communityId: string; shareWithFollowers?: boolean }
    }>('SELECT "publishOptions" AS options FROM scheduled_post WHERE "contentDraftId"=$1', [id])
    expect(rows).toHaveLength(1)
    expect(rows[0].options.communityId).toBe('42')
    // Go omits a false JSON scalar, but the community identity makes it an explicit
    // no-broadcast choice in the native adapter (covered by its wire tests).
    expect(rows[0].options.shareWithFollowers ?? false).toBe(false)
    await page.screenshot({ path: '.context/shots/typefully-community.png', fullPage: true })
  }
)
