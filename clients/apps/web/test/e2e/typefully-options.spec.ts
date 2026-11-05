import { draftEditor, expect, expectSaved, openNewDraft, settleSelection, test } from './framework'

test(
  'scheduling opens a fresh draft in the same publishing brand and keeps the commitment in Queue',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    await startWorkspace({ channels: ['x'] })
    const original = await openNewDraft(page)
    await draftEditor(page).click()
    await settleSelection(page)
    await page.keyboard.press('ControlOrMeta+End')
    await settleSelection(page)
    await page.keyboard.type('A scheduled post followed by a fresh draft')
    await expectSaved(page)
    await page.getByTestId('schedule-button').click()
    const dialog = page.getByTestId('schedule-dialog')
    await dialog.getByRole('button', { name: /^Tomorrow 9:00/ }).click()
    await expect(dialog.getByLabel('Open a new draft after scheduling')).toBeChecked()
    await dialog.getByRole('button', { name: /^Confirm schedule/ }).click()
    await page.waitForURL(
      (url) => /\/publish\/[a-z0-9]+/.test(url.pathname) && !url.pathname.endsWith(original)
    )
    await expect(draftEditor(page)).not.toContainText('A scheduled post followed')
    await expect(page.getByTestId('platform-tab-x')).toBeVisible()
    await app.open('/publish?tab=queue')
    await expect(page.getByTestId('write-rail')).toContainText(
      'A scheduled post followed by a fresh draft'
    )
  }
)

test(
  'Bluesky link cards persist removal and convert a pasted native link into a quote draft',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    await startWorkspace({ channels: ['bluesky'] })
    await page.route('**/api/v1/content-drafts/link-card?*', (route) =>
      route.fulfill({
        json: {
          title: 'A native source post',
          description: 'A source preview',
          image: null,
          url: 'https://bsky.app/profile/example.com/post/3kabc123',
        },
      })
    )
    await page.route('**/api/v1/link-preview?*', (route) =>
      route.fulfill({ status: 422, json: { message: 'Fixture page could not be read.' } })
    )
    const original = await openNewDraft(page)
    await draftEditor(page).click()
    await settleSelection(page)
    await page.keyboard.press('ControlOrMeta+End')
    await settleSelection(page)
    await page.keyboard.type('My commentary https://bsky.app/profile/example.com/post/3kabc123')
    await expect(page.getByRole('region', { name: 'Link previews' })).toContainText(
      'A native source post'
    )
    await expect(page.getByRole('region', { name: 'Link previews' })).toContainText(
      'Link check: Fixture page could not be read.'
    )
    await page.getByRole('button', { name: 'Remove preview', exact: true }).click()
    await expectSaved(page)
    await app.reload()
    await expect(page.getByRole('button', { name: 'Restore preview', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Restore preview', exact: true }).click()
    await expectSaved(page)
    await page.getByRole('button', { name: 'Open as quote draft', exact: true }).click()
    await page.waitForURL(
      (url) => /\/publish\/[a-z0-9]+/.test(url.pathname) && !url.pathname.endsWith(original)
    )
    await expect(draftEditor(page)).toContainText('My commentary')
    await app.reload()
    await expect(draftEditor(page)).toContainText('My commentary')
    await page.screenshot({ path: '.context/shots/typefully-native-quote.png', fullPage: true })
  }
)

test(
  'LinkedIn Threads and Mastodon polls copy choices and retain separate settings after reload',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    await startWorkspace({ channels: ['threads', 'mastodon-custom', 'linkedin'] })
    await openNewDraft(page)
    await page.getByTestId('platform-tab-threads').click()
    const editThreads = page.getByRole('button', { name: 'Edit for Threads independently' })
    if (await editThreads.isVisible()) await editThreads.click()
    await draftEditor(page).click()
    await settleSelection(page)
    await page.keyboard.press('ControlOrMeta+End')
    await settleSelection(page)
    await page.keyboard.type('Which release should ship?')
    await page.getByRole('button', { name: 'Add a poll', exact: true }).first().click()
    await page.getByRole('button', { name: 'Add poll', exact: true }).click()
    await page.getByLabel('Poll option 1', { exact: true }).fill('Alpha')
    await page.getByLabel('Poll option 2', { exact: true }).fill('Beta')
    await expect(page.getByLabel('Poll duration', { exact: true })).toContainText(
      'Set by the platform'
    )
    await page.keyboard.press('Escape')
    await expectSaved(page)
    await page.getByTestId('platform-tab-mastodon').click()
    const edit = page.getByRole('button', { name: 'Edit for Mastodon independently' })
    if (await edit.isVisible()) await edit.click()
    await expect(
      page.getByRole('button', { name: /^(Edit the poll|Add a poll)$/ }).first()
    ).toBeVisible()
    const poll = page.getByRole('button', { name: 'Edit the poll', exact: true }).first()
    if (await poll.isVisible()) await poll.click()
    else {
      await page.getByRole('button', { name: 'Add a poll', exact: true }).first().click()
      await page.getByRole('button', { name: 'Add poll', exact: true }).click()
    }
    await page.getByLabel('Allow multiple choices').check()
    await page.getByLabel('Poll duration in minutes').fill('45')
    await page.getByRole('combobox', { name: 'Copy poll options from' }).click()
    await page.getByRole('option', { name: 'Threads · post 1', exact: true }).click()
    await expect(page.getByLabel('Poll option 1', { exact: true })).toHaveValue('Alpha')
    await expect(page.getByLabel('Allow multiple choices')).toBeChecked()
    await expect(page.getByLabel('Poll duration in minutes')).toHaveValue('45')
    await page.keyboard.press('Escape')
    await expectSaved(page)
    await app.reload()
    await page.getByTestId('platform-tab-mastodon').click()
    await page.getByRole('button', { name: 'Edit the poll', exact: true }).first().click()
    await expect(page.getByLabel('Allow multiple choices')).toBeChecked()
    await expect(page.getByLabel('Poll duration in minutes')).toHaveValue('45')
    await page.keyboard.press('Escape')
    await page.getByTestId('platform-tab-threads').click()
    await page.getByRole('button', { name: 'Edit the poll', exact: true }).first().click()
    await expect(page.getByLabel('Poll duration', { exact: true })).toContainText(
      'Set by the platform'
    )
    await expect(page.getByLabel('Poll option 1', { exact: true })).toHaveValue('Alpha')
    await page.keyboard.press('Escape')
    await page.getByTestId('platform-tab-linkedin').click()
    const editLinkedIn = page.getByRole('button', { name: 'Edit for LinkedIn independently' })
    if (await editLinkedIn.isVisible()) await editLinkedIn.click()
    const linkedPoll = page.getByRole('button', { name: 'Edit the poll', exact: true }).first()
    if (await linkedPoll.isVisible()) await linkedPoll.click()
    else {
      await page.getByRole('button', { name: 'Add a poll', exact: true }).first().click()
      await page.getByRole('button', { name: 'Add poll', exact: true }).click()
    }
    await page.getByLabel('Poll question', { exact: true }).fill('Which release for LinkedIn?')
    await page.getByRole('combobox', { name: 'Poll duration', exact: true }).click()
    await page.getByRole('option', { name: '1 week', exact: true }).click()
    await page.getByLabel('Poll option 1', { exact: true }).fill('😀'.repeat(30))
    await expect(page.getByLabel('Poll option 1', { exact: true })).toHaveValue('😀'.repeat(30))
    await page.getByRole('combobox', { name: 'Copy poll options from' }).click()
    await page.getByRole('option', { name: 'Threads · post 1', exact: true }).click()
    await expect(page.getByLabel('Poll question', { exact: true })).toHaveValue(
      'Which release for LinkedIn?'
    )
    await expect(page.getByLabel('Poll duration', { exact: true })).toContainText('1 week')
    await page.keyboard.press('Escape')
    await expectSaved(page)
    await app.reload()
    await page.getByTestId('platform-tab-linkedin').click()
    await page.getByRole('button', { name: 'Edit the poll', exact: true }).first().click()
    await expect(page.getByLabel('Poll option 2', { exact: true })).toHaveValue('Beta')
    await expect(page.getByLabel('Poll question', { exact: true })).toHaveValue(
      'Which release for LinkedIn?'
    )
    await expect(page.getByLabel('Poll duration', { exact: true })).toContainText('1 week')
    await page.keyboard.press('Escape')
    await page.getByTestId('platform-tab-mastodon').click()
    await page.getByRole('button', { name: 'Edit the poll', exact: true }).first().click()
    await page
      .getByLabel('Poll option 1', { exact: true })
      .fill('A choice that exceeds LinkedIn limits')
    await page.keyboard.press('Escape')
    await page.getByTestId('platform-tab-linkedin').click()
    await page.getByRole('button', { name: 'Edit the poll', exact: true }).first().click()
    await page.getByRole('combobox', { name: 'Copy poll options from' }).click()
    await page.getByRole('option', { name: 'Mastodon · post 1', exact: true }).click()
    await expect(page.getByLabel('Poll option 1', { exact: true })).toHaveValue(
      'A choice that exceeds LinkedIn limits'
    )
    await expect(page.getByTestId('poll-editor-linkedin').getByRole('alert')).toContainText(
      'Keep each option to 30 characters.'
    )
    await expect(page.getByLabel('Poll duration', { exact: true })).toContainText('1 week')
    await page.getByRole('combobox', { name: 'Copy poll options from' }).click()
    await page.getByRole('option', { name: 'Threads · post 1', exact: true }).click()
    await expect(page.getByTestId('poll-editor-linkedin').getByRole('alert')).toHaveCount(0)
    await page.getByRole('textbox', { name: 'Draft title', exact: true }).click()
    await expect(page.getByTestId('poll-editor-linkedin')).toHaveCount(0)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'Edit the poll', exact: true }).first().click()
    const copyControl = page.getByRole('combobox', { name: 'Copy poll options from' })
    await copyControl.scrollIntoViewIfNeeded()
    await expect(copyControl).toBeInViewport()
    await page.screenshot({ path: '.context/shots/typefully-native-polls.png', fullPage: true })
  }
)
