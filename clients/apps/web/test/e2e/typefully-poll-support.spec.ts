import { apiRequest, draftEditor, expect, expectSaved, test } from './framework'
import { importedBody } from '@/lib/write/import-text'

test(
  'Threads keeps its native poll duration while Bluesky and Instagram explain unavailable polls',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    const workspace = await startWorkspace({ channels: ['threads', 'bluesky', 'instagram'] })
    const result = await apiRequest(page, '/api/v1/content-drafts', {
      method: 'POST',
      body: {
        primaryPlatform: 'threads',
        body: importedBody(['Which change helps?']),
        plainText: 'Which change helps?',
        channelConnectionIds: Object.values(workspace.channels),
      },
    })
    expect(result.status).toBe(201)
    const id = (result.body as { id: string }).id
    await app.open(`/publish/${id}`)
    await expect(draftEditor(page)).toContainText('Which change helps?')
    await page.getByRole('button', { name: 'Add a poll', exact: true }).click()
    await page.getByRole('button', { name: 'Add poll', exact: true }).click()
    await page.getByLabel('Poll option 1').fill('Faster review')
    await page.getByLabel('Poll option 2').fill('Clearer status')
    await page.keyboard.press('Escape')
    await expectSaved(page)
    await page.getByRole('button', { name: 'Preview', exact: true }).click()
    await expect(page.getByTestId('preview-poll-threads')).toContainText(
      'Duration set by the platform'
    )
    await expect(page.getByTestId('preview-poll-threads')).not.toContainText('0 minutes')
    await page.getByRole('button', { name: 'Preview', exact: true }).click()
    for (const channel of ['bluesky', 'instagram']) {
      await page.getByTestId(`platform-tab-${channel}`).click()
      await expect(
        page.getByText(`${channel === 'bluesky' ? 'Bluesky' : 'Instagram'}: polls unavailable`, {
          exact: true,
        })
      ).toBeVisible()
      await expect(page.getByRole('button', { name: 'Add a poll', exact: true })).toHaveCount(0)
    }
    await page.getByTestId('platform-tab-threads').click()
    await page.getByRole('button', { name: 'Edit the poll', exact: true }).click()
    await expect(page.getByLabel('Poll option 1')).toHaveValue('Faster review')
    await page.keyboard.press('Escape')
    await app.reload()
    await page.getByRole('button', { name: 'Edit the poll', exact: true }).click()
    await expect(page.getByLabel('Poll option 2')).toHaveValue('Clearer status')
  }
)
