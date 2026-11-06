import {
  apiRequest,
  db,
  draftEditor,
  expect,
  expectSaved,
  openNewDraft,
  settleSelection,
  test,
} from './framework'

test(
  'brand defaults survive reload and dragging a draft onto the weekly board only plans it after review',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    await startWorkspace({ channels: ['x'] })
    const oldId = await openNewDraft(page)
    const oldResponse = await apiRequest(page, `/api/v1/content-drafts/${oldId}`)
    const old = oldResponse.body as { socialSetId: string; engagement: unknown }
    await app.open(`/settings/publishing-brands/${old.socialSetId}/new-draft`)
    await page.getByRole('switch', { name: 'Auto-Retweet', exact: true }).check()
    await page.getByLabel('Auto-Retweet likes', { exact: true }).fill('7')
    await page.getByRole('switch', { name: 'Auto-Plug', exact: true }).check()
    await page.getByLabel('Auto-Plug likes', { exact: true }).fill('9')
    // The defaults save once complete: here, when the reply text is filled in and left.
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        response.ok() &&
        response.request().postDataJSON()?.engagementDefaults?.autoPlug?.text ===
          'The release guide is ready'
    )
    const reply = page.getByLabel('Auto-Plug reply text', { exact: true })
    await reply.fill('The release guide is ready')
    await reply.blur()
    await saved
    await expect(page.getByRole('status').filter({ hasText: 'Saved' }).first()).toBeVisible()
    await app.reload()
    await expect(page.getByLabel('Auto-Plug reply text', { exact: true })).toHaveValue(
      'The release guide is ready'
    )
    const nextId = await openNewDraft(page)
    const next = (await apiRequest(page, `/api/v1/content-drafts/${nextId}`)).body as {
      engagement: { autoRepost: { atLikes: number }; autoPlug: { text: string } }
    }
    expect(next.engagement.autoRepost.atLikes).toBe(7)
    expect(next.engagement.autoPlug.text).toBe('The release guide is ready')
    expect(
      (
        (await apiRequest(page, `/api/v1/content-drafts/${oldId}`)).body as {
          engagement: unknown
        }
      ).engagement
    ).toEqual(old.engagement)
    await draftEditor(page).click()
    await settleSelection(page)
    await page.keyboard.press('ControlOrMeta+End')
    await settleSelection(page)
    await page.keyboard.type('Board draft for review')
    await expectSaved(page)
    await page.getByRole('button', { name: 'Draft details', exact: true }).first().click()
    const resize = page.getByRole('separator', { name: /Resize/ })
    await resize.focus()
    const width = Number(await resize.getAttribute('aria-valuenow'))
    await page.keyboard.press('ArrowLeft')
    await expect(resize).not.toHaveAttribute('aria-valuenow', String(width))
    await page.keyboard.press('ControlOrMeta+Shift+F')
    await expect(page.getByTestId('write-rail')).not.toBeVisible()
    await page.keyboard.press('ControlOrMeta+Shift+F')
    const anchor = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10)
    await app.open(`/publish/calendar?view=week&week=${anchor}`)
    await expect(page.locator('[data-calendar-date]')).toHaveCount(7)
    await page.getByRole('button', { name: 'Drafts', exact: true }).first().click()
    const source = page.getByRole('link', { name: /Board draft for review/ })
    await source.dragTo(page.locator('[data-calendar-date]').nth(2))
    await expect(page.getByRole('dialog')).toBeVisible()
    let posts = await apiRequest(page, `/api/v1/content-drafts/${nextId}/posts`)
    expect(posts.status).toBe(200)
    expect((posts.body as { posts: unknown[] }).posts).toHaveLength(0)
    await page.getByRole('checkbox', { name: 'Open in editor' }).uncheck()
    await page.getByRole('button', { name: 'Plan', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    posts = await apiRequest(page, `/api/v1/content-drafts/${nextId}/posts`)
    expect((posts.body as { posts: unknown[] }).posts).toHaveLength(0)
    await app.open(`/publish/calendar?view=week&week=${anchor}&scope=workspace`)
    await expect(page.getByTestId('calendar-planned').filter({ visible: true })).toContainText(
      'Board draft for review'
    )
    await page.screenshot({ path: '.context/shots/typefully-weekly-board.png', fullPage: true })
  }
)

test(
  'X reply settings and disclosures and LinkedIn first comments persist into publication snapshots',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    await startWorkspace({ channels: ['x', 'linkedin'] })
    const id = await openNewDraft(page)
    await draftEditor(page).click()
    await settleSelection(page)
    await page.keyboard.press('ControlOrMeta+End')
    await settleSelection(page)
    await page.keyboard.type('A post with native options')
    await page.getByRole('button', { name: 'Audience and disclosures for post 1' }).click()
    await page.getByRole('combobox', { name: 'Who can reply' }).click()
    await page.getByRole('option', { name: 'Verified accounts', exact: true }).click()
    await page.getByRole('switch', { name: 'Paid partnership', exact: true }).check()
    await page.getByRole('switch', { name: 'Made with AI', exact: true }).check()
    await page.keyboard.press('Escape')
    await expectSaved(page)
    await page.getByTestId('platform-tab-linkedin').click()
    await page.getByTestId('options-chip').click()
    await page.getByRole('button', { name: 'Add LinkedIn comment', exact: true }).click()
    await page.getByLabel('First comment', { exact: true }).fill('Here is the first comment')
    await page.keyboard.press('Escape')
    await expectSaved(page)
    await app.reload()
    await page.getByTestId('platform-tab-linkedin').click()
    await page.getByRole('button', { name: 'Preview', exact: true }).first().click()
    await page
      .getByTestId('preview-panel')
      .getByRole('button', { name: 'LinkedIn', exact: true })
      .click()
    await expect(page.getByTestId('preview-linkedin')).toContainText('Here is the first comment')
    await page.getByTestId('schedule-button').click()
    const dialog = page.getByTestId('schedule-dialog')
    await dialog.getByRole('button', { name: /^Tomorrow 9:00/ }).click()
    await dialog.getByLabel('Open a new draft after scheduling').uncheck()
    await dialog.getByRole('button', { name: /^Confirm schedule/ }).click()
    await expect(dialog).toHaveCount(0)
    const response = await apiRequest(page, `/api/v1/content-drafts/${id}/posts`)
    expect(response.status).toBe(200)
    expect((response.body as { posts: unknown[] }).posts).toHaveLength(2)
    const rows = await db.rows<{
      platform: string
      publishOptions: {
        paidPartnership?: boolean
        madeWithAi?: boolean
        replySettings?: string
        firstComment?: string
      }
    }>(
      'SELECT c.platform, p."publishOptions" FROM scheduled_post p JOIN channel_connection c ON c.id=p."channelConnectionId" WHERE p."contentDraftId"=$1',
      [id]
    )
    const x = rows.find((row) => row.platform === 'x')!.publishOptions
    expect(x.paidPartnership).toBe(true)
    expect(x.madeWithAi).toBe(true)
    expect(x.replySettings).toBe('verified')
    expect(rows.find((row) => row.platform === 'linkedin')!.publishOptions.firstComment).toBe(
      'Here is the first comment'
    )
    await page.screenshot({ path: '.context/shots/typefully-post-options.png', fullPage: true })
  }
)
