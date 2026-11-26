import { apiRequest, draftEditor, expect, expectSaved, test } from './framework'

test(
  'prompt examples and reviewed voice notes enter the editable assistant composer',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const workspace = await startWorkspace({ channels: ['x', 'linkedin'] })
    const created = await apiRequest(page, '/api/v1/content-drafts', {
      method: 'POST',
      body: {
        title: 'Voice notes',
        plainText: 'Original evidence',
        body: [{ type: 'p', children: [{ text: 'Original evidence' }] }],
        channelConnectionIds: [workspace.channels.x],
      },
    })
    expect(created.status).toBe(201)
    const id = (created.body as { id: string }).id
    await app.open(`/publish/${id}?panel=assistant`)
    const panel = page.getByRole('region', { name: 'Assistant' })
    const box = panel.getByRole('textbox', { name: 'Ask the assistant' })
    await panel.getByRole('combobox', { name: 'Prompt library' }).click()
    await page.getByRole('option', { name: 'Share a lesson', exact: true }).click()
    await expect(box).toHaveValue(/Ask what happened/)
    await expect(draftEditor(page)).toContainText('Original evidence')
    await expect(page.getByTestId('post-header')).toHaveCount(1)
    await box.fill('')
    const attach = panel.getByLabel('Attach an image or voice memo file')
    await attach.setInputFiles({
      name: 'bad.wav',
      mimeType: 'audio/wav',
      buffer: Buffer.from('not an audio recording'),
    })
    await expect(page.getByText(/does not match/)).toBeVisible()
    // A valid silent WAV exercises upload/protocol wiring against the explicitly scripted
    // AI model. This is not evidence of live speech recognition accuracy.
    const wav = Buffer.alloc(16044)
    wav.write('RIFF')
    wav.writeUInt32LE(wav.length - 8, 4)
    wav.write('WAVE', 8)
    wav.write('fmt ', 12)
    wav.writeUInt32LE(16, 16)
    wav.writeUInt16LE(1, 20)
    wav.writeUInt16LE(1, 22)
    wav.writeUInt32LE(8000, 24)
    wav.writeUInt32LE(16000, 28)
    wav.writeUInt16LE(2, 32)
    wav.writeUInt16LE(16, 34)
    wav.write('data', 36)
    wav.writeUInt32LE(16000, 40)
    await attach.setInputFiles({ name: 'memo.wav', mimeType: 'audio/wav', buffer: wav })
    // The transcript lands in the composer to review; nothing is sent by itself.
    await expect(box).toHaveValue(/Today we shipped/, { timeout: 60_000 })
    await expect(panel.getByRole('button', { name: 'Accept' })).toHaveCount(0)
    await box.fill('Offer a closing post. We shipped it, and the results still need review.')
    await box.press('Enter')
    await panel.getByRole('button', { name: 'Accept' }).click({ timeout: 60_000 })
    await expect(page.getByTestId('post-header')).toHaveCount(2)
    await expectSaved(page)
    await app.reload()
    await expect(page.getByTestId('post-header')).toHaveCount(2)
    await expect(draftEditor(page)).toContainText('Original evidence')
    expect(
      (
        (await apiRequest(page, `/api/v1/content-drafts/${id}/posts`)).body as {
          posts: unknown[]
        }
      ).posts
    ).toHaveLength(0)
    await page.screenshot({ path: '.context/shots/typefully-voice-reviewed.png' })
    expect(errors).toEqual([])
  }
)

test(
  'saved voice samples and style guidance survive reload, configure the assistant, and honor the workspace AI switch',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    const workspace = await startWorkspace({ channels: ['x', 'linkedin'] })
    const sets = (await apiRequest(page, '/api/v1/social-sets')).body as {
      items: { id: string }[]
    }
    const setId = sets.items[0].id
    await app.open(`/settings/publishing-brands/${setId}/writing-assistant`)
    await page.getByLabel('Tone', { exact: true }).fill('Direct, warm and specific')
    await page.getByLabel('Phrases to avoid', { exact: true }).fill('game changer')
    await page.getByLabel('Preferred terms', { exact: true }).fill('workspace')
    await page.getByRole('button', { name: 'Save style guide', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Saved' }).first()).toBeVisible()
    await page
      .getByLabel('New writing sample', { exact: true })
      .fill('We shipped a smaller release. It solved one concrete customer problem.')
    await page.getByRole('button', { name: 'Add sample', exact: true }).click()
    await expect(page.getByText('Writing samples (1 of 20)', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Create assistant', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Turn off', exact: true })).toBeVisible()
    await app.reload()
    await expect(page.getByLabel('Tone', { exact: true })).toHaveValue('Direct, warm and specific')
    await expect(page.getByLabel('Phrases to avoid', { exact: true })).toHaveValue('game changer')
    await expect(page.getByText('Writing samples (1 of 20)', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Turn off', exact: true })).toBeVisible()
    const created = await apiRequest(page, '/api/v1/content-drafts', {
      method: 'POST',
      body: {
        socialSetId: setId,
        plainText: 'A specific lesson',
        body: [{ type: 'p', children: [{ text: 'A specific lesson' }] }],
        channelConnectionIds: [workspace.channels.x],
      },
    })
    expect(created.status).toBe(201)
    const id = (created.body as { id: string }).id
    await app.open(`/publish/${id}?panel=assistant`)
    const panel = page.getByRole('region', { name: 'Assistant' })
    await expect(panel.getByRole('link', { name: 'Style guide and samples' })).toBeVisible()
    const box = panel.getByRole('textbox', { name: 'Ask the assistant' })
    await box.fill('Suggest one concrete improvement.')
    await box.press('Enter')
    await expect(panel.getByText(/^You are on /)).toBeVisible({ timeout: 60_000 })
    await expect(draftEditor(page)).toContainText('A specific lesson')
    const audio = Buffer.from('RIFF0000WAVEfmt fixture audio').toString('base64')
    for (const [endpoint, body] of [
      [
        'transcribe',
        { draftId: 'cforeign000000000000000000', channel: 'x', mediaType: 'audio/wav', audio },
      ],
      [
        'assistant',
        {
          draftId: 'cforeign000000000000000000',
          channel: 'x',
          draft: ['Private context'],
          messages: [{ role: 'user', content: 'Summarize' }],
        },
      ],
      [
        'refine',
        {
          draftId: 'cforeign000000000000000000',
          channel: 'x',
          action: 'condense',
          scope: 'post',
          limit: 280,
          texts: ['Private context'],
        },
      ],
    ] as const)
      expect(
        (await apiRequest(page, `/api/v1/content-drafts/${endpoint}`, { method: 'POST', body }))
          .status,
        endpoint
      ).toBe(404)
    await app.open('/settings')
    await page.getByRole('checkbox', { name: 'Let AI draft campaigns', exact: true }).uncheck()
    await page.getByRole('button', { name: 'Save workspace', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'All changes saved' })).toBeVisible()
    await app.reload()
    await expect(
      page.getByRole('checkbox', { name: 'Let AI draft campaigns', exact: true })
    ).not.toBeChecked()
    expect(
      (
        await apiRequest(page, '/api/v1/content-drafts/transcribe', {
          method: 'POST',
          body: { draftId: id, channel: 'x', mediaType: 'audio/wav', audio },
        })
      ).status
    ).toBe(403)
    expect(
      (
        (await apiRequest(page, `/api/v1/content-drafts/${id}/posts`)).body as {
          posts: unknown[]
        }
      ).posts
    ).toHaveLength(0)
  }
)
