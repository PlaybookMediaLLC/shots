import { db, expect, getE2EUrl, openWorkspaceSetting, signUp, test, trpcQuery } from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

test('an owner can invite a viewer and remove their workspace access', async ({
  browser,
  identity,
  page,
}) => {
  const memberIdentity = {
    ...identity,
    email: `member-${identity.email}`,
    name: 'E2E Viewer',
  }
  const memberContext = await browser.newContext()
  const memberPage = await memberContext.newPage()

  try {
    await signUp(memberIdentity, memberPage)
    await openWorkspaceSetting(page, 'Members')
    await page.locator('input[name="email"]').fill(memberIdentity.email)
    await page.getByRole('button', { name: 'Invite' }).click()
    await expect(page.getByText('Invitation created.')).toBeVisible()

    const invitation = await db.row<{ id: string }>(
      `SELECT id FROM invitation WHERE email = $1 AND status = 'pending' LIMIT 1`,
      [memberIdentity.email]
    )
    if (!invitation) throw new Error('Invitation was not created.')

    await memberPage.goto(getE2EUrl(`/accept-invitation?invitationId=${invitation.id}`))
    await memberPage.getByRole('button', { name: 'Accept invitation' }).click()
    await expect.poll(() => new URL(memberPage.url()).pathname).toBe('/settings')

    await memberPage.goto(getE2EUrl('/'))
    await expect(memberPage.getByRole('button', { exact: true, name: 'Export' })).toBeVisible()
    expect((await trpcQuery(memberPage, 'apiKey.list')).status).toBe(403)

    await openWorkspaceSetting(page, 'Members')
    await expect(page.getByText(memberIdentity.email, { exact: true })).toBeVisible()
    const memberRow = page
      .getByText(memberIdentity.email, { exact: true })
      .locator('xpath=..')
      .locator('xpath=..')
    await memberRow.getByRole('button', { name: 'Remove' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove member' }).click()
    await expect(page.getByText(memberIdentity.email, { exact: true })).toHaveCount(0)

    await memberPage.goto(getE2EUrl('/'))
    await expect.poll(() => new URL(memberPage.url()).pathname).toBe('/sign-in')
  } finally {
    await memberContext.close()
  }
})
