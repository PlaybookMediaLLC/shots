import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { apiRequest, expect, grantWorkspacePlan, requestJson, test } from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

const idSchema = z.object({ id: z.string() })
const setsSchema = z.object({ items: z.array(z.object({ id: z.string(), name: z.string() })) })

test(
  'a profile moves to another workspace its owner manages, with its drafts, after showing what changes',
  { tag: '@journey' },
  async ({ app, page }) => {
    const session = z
      .object({ session: z.object({ activeOrganizationId: z.string() }) })
      .parse((await apiRequest(page, '/api/auth/get-session')).body)
    const source = session.session.activeOrganizationId
    // The workspace keeps another shared profile; this one moves.
    for (const name of ['Stays', 'Moving brand']) {
      const created = await requestJson(page, '/api/v1/social-sets', { name })
      expect(created.status).toBeLessThan(300)
    }
    // Reads follow the session's workspace; this tab stays bound to the one it shows.
    const sets = async () => {
      const response = await apiRequest(page, '/api/v1/social-sets')
      expect(response.status).toBe(200)
      return setsSchema.parse(response.body).items
    }
    const setId = (await sets()).find((set) => set.name === 'Moving brand')?.id ?? ''
    expect(setId).not.toBe('')
    const draft = await requestJson(page, '/api/v1/content-drafts', {
      plainText: 'It goes along.',
      socialSetId: setId,
      title: 'Travels',
    })
    expect(draft.status).toBe(201)
    const draftId = idSchema.parse(draft.body).id

    // A second workspace the person owns, with no plan yet.
    const other = await requestJson(page, '/api/auth/organization/create', {
      idempotencyKey: randomUUID(),
      name: 'Destination',
      slug: `destination-${randomUUID()}`,
    })
    expect(other.status).toBe(200)
    const destination = idSchema.parse(other.body).id
    const activate = async (organizationId: string) =>
      expect(
        (await requestJson(page, '/api/auth/organization/set-active', { organizationId })).status
      ).toBe(200)
    await activate(source)

    await app.open(`/settings/publishing-brands/${setId}`)
    const open = async () => {
      await page.getByRole('button', { name: 'Move to another workspace', exact: true }).click()
      return page.getByRole('alertdialog')
    }
    // No eligible destination: the dialog says why and offers no move.
    let dialog = await open()
    await expect(dialog.getByTestId('move-unavailable')).toContainText(
      'has a plan that includes drafts'
    )
    await expect(dialog.getByRole('button', { name: 'Move profile' })).toBeDisabled()
    await dialog.getByRole('button', { name: 'Cancel' }).click()

    // A workspace it does not manage is refused, and nothing moves.
    const refused = await requestJson(
      page,
      `/api/v1/social-sets/${setId}/transfer`,
      { destinationOrganizationId: `org-${randomUUID()}`, version: 1 },
      'POST'
    )
    expect([403, 404]).toContain(refused.status)

    await grantWorkspacePlan(destination, 'business')
    dialog = await open()
    await expect(dialog.getByTestId('move-consequences')).toContainText(
      '1 draft move with their comments, backups and tags'
    )
    await expect(dialog.getByRole('combobox', { name: 'Destination workspace' })).toContainText(
      'Destination'
    )
    await dialog.getByRole('button', { name: 'Move profile' }).click()
    await expect(page).toHaveURL(/\/settings\/publishing-brands$/)

    // The source no longer has the profile or its draft.
    expect((await sets()).map((set) => set.id)).not.toContain(setId)
    expect([403, 404]).toContain(
      (await apiRequest(page, `/api/v1/content-drafts/${draftId}`)).status
    )
    // The destination has the same profile and draft.
    await activate(destination)
    expect((await sets()).map((set) => set.id)).toContain(setId)
    const arrived = await apiRequest(page, `/api/v1/content-drafts/${draftId}`)
    expect(arrived.status).toBe(200)
    expect(z.object({ title: z.string() }).parse(arrived.body).title).toBe('Travels')
  }
)
