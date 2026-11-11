import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  voiceNoteDetailSchema,
  voiceNoteIndexSchema,
  voiceTranscriptResultSchema,
} from '../../lib/api/contracts/voice-schemas'
import {
  acceptInvitation,
  browserRequest,
  expect,
  openWorkspaceSetting,
  type Page,
  quietProductToursIn,
  requestJson,
  signUpViaApi,
  test,
} from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

const voice = '/api/v1/voice'

/** A transcript revision's row in the open note, found by the origin it shows. */
function revisionRow(page: Page, origin: 'On the phone' | 'Your edit') {
  // The origin is a span in the row's first line; the row is that line's parent.
  return page.getByText(origin, { exact: true }).locator('xpath=../..')
}

async function readNote(page: Page, id: string) {
  const response = await browserRequest(page, `${voice}/notes/${id}`)
  expect(response.status).toBe(200)
  return voiceNoteDetailSchema.parse(response.body)
}

// Real sessions through the web routes and the Go backend. Drafts and spoken
// commands need a model, and the e2e stack has no stand-in for the Go
// backend's, so both stay off here.
test(
  'a member reads, edits, redacts and deletes their own voice note, which no one else sees',
  { tag: ['@journey', '@smoke'] },
  async ({ app, browser, identity, page, workspace }) => {
    await openWorkspaceSetting(page, 'Voice notes')
    const voiceNotes = page.getByRole('switch', { name: 'Voice notes', exact: true })
    await expect(voiceNotes).toBeEnabled()
    await expect(voiceNotes).not.toBeChecked()
    const switched = page.waitForResponse(
      (response) =>
        response.url().endsWith(`${voice}/settings/workspace`) &&
        response.request().method() === 'PUT'
    )
    await voiceNotes.click()
    expect((await switched).status()).toBe(200)
    await expect(voiceNotes).toBeChecked()
    await app.reload()
    await expect(voiceNotes).toBeChecked()

    const memberContext = await browser.newContext()
    try {
      await quietProductToursIn(memberContext)
      const member = await memberContext.newPage()
      const email = `voice-${identity.email}`
      const invited = await requestJson(page, '/api/auth/organization/invite-member', {
        email,
        organizationId: workspace.id,
        role: 'creator',
      })
      expect(invited.status).toBe(200)
      await signUpViaApi({ ...identity, email, name: 'Voice Member' }, member)
      await acceptInvitation(member, z.object({ id: z.string() }).parse(invited.body).id)

      // Only an owner or admin changes the workspace switches.
      await openWorkspaceSetting(member, 'Voice notes')
      const memberSwitch = member.getByRole('switch', { name: 'Voice notes', exact: true })
      await expect(memberSwitch).toBeChecked()
      await expect(memberSwitch).toBeDisabled()
      expect(
        (await requestJson(member, `${voice}/settings/workspace`, { voiceNotes: false }, 'PUT'))
          .status
      ).toBe(403)

      // The phone syncs a note, then its on-device transcript.
      const recording = {
        clientNoteId: `phone-${randomUUID()}`,
        durationMs: 42_000,
        locale: 'en-US',
        recordedAt: new Date().toISOString(),
        recordedTimeZone: 'Europe/Berlin',
        title: 'Pricing page idea',
      }
      const created = await requestJson(member, `${voice}/notes`, recording)
      expect(created.status).toBe(201)
      const note = voiceNoteDetailSchema.parse(created.body)
      const replayed = await requestJson(member, `${voice}/notes`, recording)
      expect(replayed.status).toBe(200)
      expect(voiceNoteDetailSchema.parse(replayed.body).id).toBe(note.id)
      const invalid = { ...recording, clientNoteId: `phone-${randomUUID()}`, recordedAt: 'today' }
      expect((await requestJson(member, `${voice}/notes`, invalid)).status).toBe(400)
      const phoneText = 'Lead with the annual plan on the pricing page.'
      const transcribed = await requestJson(member, `${voice}/notes/${note.id}/transcripts`, {
        clientRevisionId: `phone-${randomUUID()}`,
        engine: 'on-device',
        locale: 'en-US',
        origin: 'on_device',
        segments: [{ endMs: 4_000, startMs: 0, text: phoneText }],
        text: phoneText,
      })
      expect(transcribed.status).toBe(201)
      const phoneRevision = voiceTranscriptResultSchema.parse(transcribed.body).revision

      // Nobody else in the workspace can see it, the owner included.
      expect((await browserRequest(page, `${voice}/notes/${note.id}`)).status).toBe(404)
      await app.open('/create/voice')
      await expect(page.getByText('No voice notes yet', { exact: true })).toBeVisible()

      await member.goto('/create/voice')
      const item = member
        .getByRole('navigation', { name: 'Voice notes', exact: true })
        .getByRole('button', { name: /Pricing page idea/ })
      await expect(item).toContainText('(Europe/Berlin) · 0:42')
      await expect(item).toContainText(phoneText)
      await item.click()
      await expect(
        member.getByRole('heading', { name: 'Pricing page idea', exact: true })
      ).toBeVisible()
      const phoneRow = revisionRow(member, 'On the phone')
      await expect(phoneRow).toContainText('Current')
      await expect(phoneRow).toContainText(phoneText)

      // An edit is a new revision that becomes current; the phone's stays.
      await phoneRow.getByRole('button', { name: 'Edit', exact: true }).click()
      const editor = member.getByRole('textbox', { name: /^Transcript/ })
      await expect(editor).toHaveValue(phoneText)
      const editedText = 'Lead with the annual plan, then the monthly one.'
      await editor.fill(editedText)
      const saved = member.waitForResponse(
        (response) =>
          response.url().endsWith(`${voice}/notes/${note.id}/transcripts`) &&
          response.request().method() === 'POST'
      )
      await member.getByRole('button', { name: 'Save as a new revision', exact: true }).click()
      expect((await saved).status()).toBe(201)
      const editRow = revisionRow(member, 'Your edit')
      await expect(editRow).toContainText('Current')
      await expect(editRow).toContainText(editedText)
      await expect(phoneRow).not.toContainText('Current')
      await expect(phoneRow).toContainText(phoneText)
      await expect(item).toContainText(editedText)
      let detail = await readNote(member, note.id)
      expect(detail.transcripts).toHaveLength(2)
      const edit = detail.transcripts.find(({ id }) => id === detail.currentTranscriptRevisionId)
      expect(edit).toMatchObject({
        origin: 'user_edit',
        parentId: phoneRevision.id,
        redacted: false,
        text: editedText,
      })

      // Redacting the older revision clears its text for good.
      await phoneRow.getByRole('button', { name: 'Redact', exact: true }).click()
      const redacted = member.waitForResponse(
        (response) =>
          response.url().endsWith(`/transcripts/${phoneRevision.id}/redact`) &&
          response.request().method() === 'POST'
      )
      await member
        .getByRole('alertdialog')
        .getByRole('button', { name: 'Redact', exact: true })
        .click()
      expect((await redacted).status()).toBe(200)
      await expect(phoneRow).toContainText('Redacted')
      await expect(phoneRow).not.toContainText(phoneText)
      await expect(phoneRow.getByRole('button')).toHaveCount(0)
      await expect(editRow).toContainText(editedText)
      detail = await readNote(member, note.id)
      expect(detail.transcripts.find(({ id }) => id === phoneRevision.id)).toMatchObject({
        redacted: true,
        segments: [],
        text: '',
      })
      expect(detail.currentTranscriptRevisionId).toBe(edit?.id)

      // Deleting leaves a tombstone, so a phone that syncs later cannot recreate it.
      await member.getByRole('button', { name: 'Delete note', exact: true }).click()
      const deleted = member.waitForResponse(
        (response) =>
          response.url().endsWith(`${voice}/notes/${note.id}`) &&
          response.request().method() === 'DELETE'
      )
      await member
        .getByRole('alertdialog')
        .getByRole('button', { name: 'Delete note', exact: true })
        .click()
      expect((await deleted).status()).toBe(204)
      await expect(member.getByText('No voice notes yet', { exact: true })).toBeVisible()
      detail = await readNote(member, note.id)
      expect(detail).toMatchObject({ deleted: true, title: '' })
      expect(detail.transcripts.every(({ redacted, text }) => redacted && text === '')).toBe(true)
      expect((await requestJson(member, `${voice}/notes`, recording)).status).toBe(409)
      const index = await browserRequest(member, `${voice}/notes/index`)
      expect(voiceNoteIndexSchema.parse(index.body).notes).toEqual([
        expect.objectContaining({ deleted: true, id: note.id }),
      ])

      // The owner's own sync index never held it.
      const ownerIndex = await browserRequest(page, `${voice}/notes/index`)
      expect(voiceNoteIndexSchema.parse(ownerIndex.body).notes).toEqual([])
    } finally {
      await memberContext.close()
    }
  }
)
