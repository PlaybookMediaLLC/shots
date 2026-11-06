import { z } from 'zod'
import { contentDraftSchema } from '../../lib/api/contracts/content-drafts'
import {
  acceptInvitation,
  browserRequest,
  expect,
  expectSaved,
  grantWorkspacePlan,
  openWorkspaceSetting,
  requestJson,
  signUpViaApi,
  test,
  trpcMutation,
  trpcQuery,
} from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

// Check the persisted facts used here; Date inputs in the server contract have
// already been serialized to ISO strings in this HTTP response.
const draftStateSchema = contentDraftSchema.pick({
  approvedVersion: true,
  id: true,
  reviewStatus: true,
  title: true,
  version: true,
})

test(
  'writing, approval and billing stay separate, and a demoted editor loses access immediately',
  { tag: '@journey' },
  async ({ browser, identity, page, workspace }, testInfo) => {
    const organizationId = workspace.id
    await grantWorkspacePlan(organizationId, 'business')
    expect(
      (await requestJson(page, '/api/v1/content-draft-settings', { requireApproval: true }, 'PUT'))
        .status
    ).toBe(200)
    const created = await requestJson(page, '/api/v1/content-drafts', {
      title: 'Team review policy',
      body: [{ type: 'p', children: [{ text: 'Team policy' }] }],
      plainText: 'Team policy',
    })
    expect(created.status).toBe(201)
    const draft = draftStateSchema.parse(created.body)
    const path = `/api/v1/content-drafts/${draft.id}`
    const writerContext = await browser.newContext()
    const approverContext = await browser.newContext()
    const writer = await writerContext.newPage()
    const approver = await approverContext.newPage()
    const writerEmail = `writer-${identity.email}`

    try {
      for (const [role, label, memberPage, email] of [
        ['writer_publisher', 'Write & Publish', writer, writerEmail],
        ['approver', 'Approver', approver, `approver-${identity.email}`],
      ] as const) {
        await openWorkspaceSetting(page, 'Members')
        // The invite form's own Role select: after an invitation, the page
        // lists more Role controls, and `.last()` could pick one of those.
        const invite = page.locator('form').filter({ has: page.locator('input[name="email"]') })
        await invite.locator('input[name="email"]').fill(email)
        const roleSelect = invite.getByRole('combobox', { name: 'Role', exact: true })
        await roleSelect.click()
        // The option's name also carries its description, so match by label.
        await page.getByRole('option', { name: label }).click()
        await expect(roleSelect).toContainText(label)
        await invite.getByRole('button', { name: 'Invite', exact: true }).click()
        await expect(page.getByText('Invitation created.')).toBeVisible()
        const { invitations } = z
          .object({
            invitations: z.array(z.object({ id: z.string(), email: z.string(), role: z.string() })),
          })
          .parse((await trpcQuery(page, 'workspace.listInvitations')).body)
        const invitation = invitations.find((candidate) => candidate.email === email)
        expect(invitation?.role).toBe(role)
        if (!invitation) throw new Error('Invitation was not persisted.')
        await signUpViaApi({ ...identity, email, name: label }, memberPage)
        await acceptInvitation(memberPage, invitation.id)
      }

      await writer.goto(`/publish/${draft.id}`)
      await expect(
        writer.getByRole('button', { name: 'Connect account', exact: true })
      ).toHaveCount(0)
      await writer.getByRole('textbox', { name: 'Draft title' }).fill('Edited by writer')
      await expectSaved(writer)
      await writer.getByRole('button', { name: 'Review', exact: true }).click()
      await expect(writer.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0)
      await writer.getByRole('button', { name: 'Ask for review', exact: true }).click()
      await expect(writer.getByRole('button', { name: 'Review', exact: true })).toContainText(
        'In review'
      )
      await writer.keyboard.press('Escape')
      expect((await requestJson(writer, `${path}/review`, { action: 'approve' })).status).toBe(403)
      expect(draftStateSchema.parse((await browserRequest(writer, path)).body).reviewStatus).toBe(
        'pending'
      )

      await approver.goto(`/publish/${draft.id}`)
      await expect(
        approver.getByRole('button', { name: 'Connect account', exact: true })
      ).toHaveCount(0)
      await expect(approver.getByRole('textbox', { name: 'Draft title' })).toBeDisabled()
      await approver.getByRole('button', { name: 'Review', exact: true }).click()
      await expect(
        approver.getByRole('button', { name: 'Ask for review', exact: true })
      ).toHaveCount(0)
      await approver.getByRole('button', { name: 'Approve', exact: true }).click()
      await expect(approver.getByRole('button', { name: 'Review', exact: true })).toContainText(
        'Approved'
      )
      await approver.keyboard.press('Escape')
      await expect(approver.getByRole('textbox', { name: 'Review note' })).toBeHidden()
      await expect(approver.getByTestId('draft-row')).not.toContainText('In review')
      const approved = draftStateSchema.parse((await browserRequest(approver, path)).body)
      expect(approved.approvedVersion).toBe(approved.version)
      expect(
        (
          await browserRequest(approver, path, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ baseVersion: approved.version, title: 'Forbidden edit' }),
          })
        ).status
      ).toBe(403)
      expect((await requestJson(approver, `${path}/review`, { action: 'request' })).status).toBe(
        403
      )
      await testInfo.attach('approver-can-approve-without-writing', {
        body: await approver.screenshot({ path: testInfo.outputPath('approver-permissions.png') }),
        contentType: 'image/png',
      })

      // The writer's editor stays open while the owner changes the membership.
      const { members } = z
        .object({
          members: z.array(z.object({ id: z.string(), user: z.object({ email: z.string() }) })),
        })
        .parse((await trpcQuery(page, 'workspace.listMembers')).body)
      const member = members.find((candidate) => candidate.user.email === writerEmail)
      if (!member) throw new Error('Accepted member was not persisted.')
      expect(
        (
          await trpcMutation(page, 'workspace.updateMemberRole', {
            memberId: member.id,
            role: 'viewer',
          })
        ).status
      ).toBe(200)
      await expect(writer.getByRole('textbox', { name: 'Draft title' })).toBeEnabled()
      const failedSave = writer.waitForResponse(
        (response) => response.url().endsWith(path) && response.request().method() === 'PATCH'
      )
      await writer
        .getByRole('textbox', { name: 'Draft title' })
        .fill('Rejected stale editor change')
      expect((await failedSave).status()).toBe(403)
      expect(draftStateSchema.parse((await browserRequest(page, path)).body).title).toBe(
        'Edited by writer'
      )
      expect((await requestJson(writer, `${path}/review`, { action: 'request' })).status).toBe(403)
      await writer.reload()
      await expect(writer.getByRole('textbox', { name: 'Draft title' })).toBeDisabled()
      await expect(writer.getByRole('textbox', { name: 'Draft title' })).toHaveValue(
        'Edited by writer'
      )

      await openWorkspaceSetting(writer, 'Billing')
      await expect(writer.getByText('Only workspace owners can change the plan.')).toBeVisible()
      await expect(writer.getByRole('button', { name: 'Manage subscription' })).toHaveCount(0)
      await openWorkspaceSetting(page, 'Billing')
      await expect(page.getByRole('button', { name: 'Manage subscription' })).toBeVisible()
      // Rendering the owner control proves the positive UI path without opening Stripe.
      await testInfo.attach('owner-billing-authority', {
        body: await page.screenshot({
          path: testInfo.outputPath('owner-billing.png'),
          fullPage: true,
        }),
        contentType: 'image/png',
      })
    } finally {
      await writerContext.close()
      await approverContext.close()
    }
  }
)
