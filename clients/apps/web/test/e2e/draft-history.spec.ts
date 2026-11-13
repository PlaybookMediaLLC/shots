import { z } from 'zod'
import { apiRequest, expect, getE2EUrl, requestJson, test, trpcMutation } from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

const idSchema = z.object({ id: z.string() })

test(
  'draft history groups each author’s changes and names an API key, which no notification route admits',
  { tag: '@journey' },
  async ({ app, identity, page, request }) => {
    const created = await requestJson(page, '/api/v1/content-drafts', {
      plainText: 'First words',
      title: 'History',
    })
    expect(created.status).toBe(201)
    const id = idSchema.parse(created.body).id
    // Two quick renames by the owner.
    for (const [baseVersion, title] of [
      [1, 'History two'],
      [2, 'History three'],
    ] as const) {
      const renamed = await apiRequest(page, `/api/v1/content-drafts/${id}`, {
        body: { baseVersion, title },
        method: 'PATCH',
      })
      expect(renamed.status).toBe(200)
    }
    // Then one through a workspace API key, with no session.
    const key = z.object({ apiKey: z.object({ key: z.string().min(1) }) }).parse(
      (
        await trpcMutation(page, 'apiKey.create', {
          name: 'History bot',
          scopes: ['artifact:read', 'draft:write'],
        })
      ).body
    ).apiKey.key
    const keyHeaders = { origin: new URL(getE2EUrl('/')).origin, 'x-api-key': key }
    const byKey = await request.patch(getE2EUrl(`/api/v1/content-drafts/${id}`), {
      data: { baseVersion: 3, title: 'Renamed by the key' },
      headers: keyHeaders,
    })
    expect(byKey.status()).toBe(200)
    // Notifications are a person's: the key reaches none of them. Every
    // notification route is a shell route (api-route.test.ts).
    const refused = await request.get(getE2EUrl('/api/workspace/notifications/inbox'), {
      headers: keyHeaders,
    })
    expect(refused.status()).toBe(403)
    expect(await refused.text()).toContain('require a signed-in user session, not an API key')
    // A cursor reaches the backend: one it never issued is refused, not ignored.
    const badCursor = await request.get(
      getE2EUrl(`/api/v1/content-drafts/${id}/activity?cursor=not-a-cursor`),
      { headers: keyHeaders }
    )
    expect(badCursor.status()).toBe(400)
    // The key reads the history and sees who made each change, without key details.
    const history = await request.get(getE2EUrl(`/api/v1/content-drafts/${id}/activity`), {
      headers: keyHeaders,
    })
    expect(history.status()).toBe(200)
    const page1 = z
      .object({
        items: z.array(z.object({ source: z.string() })),
        nextCursor: z.string().nullable(),
      })
      .parse(await history.json())
    expect(page1.items.map((item) => item.source)).toEqual(['api', 'person', 'person', 'person'])
    expect(page1.nextCursor).toBeNull()
    expect(JSON.stringify(page1)).not.toContain(key.slice(0, 8))
    expect(JSON.stringify(page1)).not.toContain('History bot')

    await app.open(`/publish/${id}`)
    await page.getByRole('button', { name: 'Draft details', exact: true }).click()
    const groups = page.getByTestId('properties-panel').getByTestId('activity-group')
    await expect(groups).toHaveCount(2)
    // The newest entry: the key's rename, named as an API key, when it happened.
    await expect(groups.first()).toContainText('Edited · title')
    await expect(groups.first().getByTestId('activity-author')).toHaveText('API key')
    await expect(groups.first().getByTestId('activity-when').first()).toContainText(
      /^(now|\d+ seconds? ago|\d+ minutes? ago) · /
    )
    // The owner's creation and two renames are one entry that opens to each change.
    const owner = groups.nth(1)
    await expect(owner.getByTestId('activity-author')).toHaveText(identity.name)
    const creation = owner.getByText('Created the draft', { exact: true })
    await expect(creation).toBeHidden()
    await owner.getByRole('button', { name: '3 changes' }).click()
    await expect(creation).toBeVisible()
  }
)
