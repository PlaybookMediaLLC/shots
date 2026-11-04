import {
  apiRequest,
  db,
  draftEditor,
  expect,
  expectSaved,
  openNewDraft,
  test,
  toolbarTool,
} from './framework'

test(
  'LinkedIn recent people and companies preserve native identities from picker through scheduled snapshot',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await startWorkspace({ channels: ['linkedin'] })
    const oldId = await openNewDraft(page)
    const old = (await apiRequest(page, `/api/v1/content-drafts/${oldId}`)).body as {
      version: number
      socialSetId: string
    }
    const mention = (kind: string, providerId: string, label: string) => ({
      type: 'social_mention',
      platform: 'linkedin',
      kind,
      providerId,
      label,
      children: [{ text: '' }],
    })
    const seeded = await apiRequest(page, `/api/v1/content-drafts/${oldId}`, {
      method: 'PATCH',
      body: {
        baseVersion: old.version,
        body: [
          {
            type: 'p',
            children: [
              { text: 'Thanks ' },
              mention('person', 'urn:li:person:Abc_123', 'Anne (AJ) Doe'),
              { text: ' and ' },
              mention('organization', 'urn:li:organization:42', 'Acme [Labs]'),
              { text: '!' },
            ],
          },
        ],
      },
    })
    expect(seeded.status, JSON.stringify(seeded.body)).toBe(200)
    const removed = await apiRequest(page, `/api/v1/content-drafts/${oldId}`, {
      method: 'DELETE',
    })
    expect(removed.status).toBe(200)
    const id = await openNewDraft(page)
    await draftEditor(page).click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type('Thanks ')
    await toolbarTool(page, 'More tools', 'Add mention')
    let picker = page.getByTestId('mention-picker')
    await picker.getByRole('button', { name: 'People', exact: true }).click()
    await picker.getByRole('button', { name: 'Recently mentioned people', exact: true }).click()
    await picker.getByTestId('mention-result').filter({ hasText: 'Anne (AJ) Doe' }).click()
    await expect(draftEditor(page).getByTestId('social-mention')).toContainText('Anne (AJ) Doe')
    await toolbarTool(page, 'More tools', 'Add mention')
    picker = page.getByTestId('mention-picker')
    await picker.getByRole('button', { name: 'Companies', exact: true }).click()
    await picker.getByRole('button', { name: 'Recently mentioned companies', exact: true }).click()
    await picker.getByTestId('mention-result').filter({ hasText: 'Acme [Labs]' }).click()
    await expectSaved(page)
    await app.reload()
    await expect(draftEditor(page).getByTestId('social-mention')).toHaveCount(2)
    await page.getByRole('button', { name: 'Preview', exact: true }).first().click()
    const preview = page.getByTestId('preview-linkedin')
    await expect(preview).toContainText('Anne (AJ) Doe')
    await expect(preview).toContainText('Acme [Labs]')
    await expect(preview).not.toContainText('urn:li:')
    await expect(preview).not.toContainText(String.raw`\(`)
    const saved = (await apiRequest(page, `/api/v1/content-drafts/${id}`)).body
    expect(JSON.stringify(saved)).toContain('urn:li:person:Abc_123')
    expect(JSON.stringify(saved)).toContain('urn:li:organization:42')
    await page.getByTestId('schedule-button').click()
    const dialog = page.getByTestId('schedule-dialog')
    await dialog.getByRole('button', { name: /^Tomorrow 9:00/ }).click()
    await dialog.getByLabel('Open a new draft after scheduling').uncheck()
    await dialog.getByRole('button', { name: /^Confirm schedule/ }).click()
    await expect(dialog).toHaveCount(0)
    const rows = await db.rows<{ caption: string }>(
      'SELECT caption FROM scheduled_post WHERE "contentDraftId"=$1',
      [id]
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].caption).toContain(String.raw`@[Anne \(AJ\) Doe](urn:li:person:Abc_123)`)
    expect(rows[0].caption).toContain(String.raw`@[Acme \[Labs\]](urn:li:organization:42)`)
    expect(pageErrors).toEqual([])
    await page.screenshot({
      path: '.context/shots/typefully-linkedin-mentions.png',
      fullPage: true,
    })
  }
)
