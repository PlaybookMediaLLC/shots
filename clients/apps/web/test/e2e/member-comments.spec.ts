import { z } from 'zod'
import {
  acceptInvitation,
  browserRequest,
  expect,
  grantWorkspacePlan,
  requestJson,
  signUpViaApi,
  test,
  trpcMutation,
  trpcQuery,
} from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

const state = z.object({
  id: z.string(),
  title: z.string(),
  plainText: z.string(),
  version: z.number(),
  approvedVersion: z.number().nullable(),
  reviewStatus: z.string(),
  discussions: z.object({
    threads: z
      .array(
        z.object({
          id: z.string(),
          isResolved: z.boolean(),
          comments: z.array(z.object({ id: z.string(), userId: z.string() })),
        })
      )
      .default([]),
  }),
})

// Actual sessions, persisted comments and membership changes; only one response
// is lost after the real API has committed to test reconciliation.
test(
  'read-only members discuss approved content and reconcile a lost reply without duplicate comments',
  { tag: '@journey' },
  async ({ browser, identity, page, workspace }, testInfo) => {
    const org = workspace.id
    await grantWorkspacePlan(org, 'business')
    const created = await requestJson(page, '/api/v1/content-drafts', {
      title: 'Comment permissions',
      plainText: 'Approved body',
      body: [{ type: 'p', children: [{ text: 'Approved body' }] }],
    })
    expect(created.status).toBe(201)
    const draft = state.parse(created.body)
    const path = `/api/v1/content-drafts/${draft.id}`
    expect((await requestJson(page, `${path}/review`, { action: 'approve' })).status).toBe(200)
    const viewerContext = await browser.newContext()
    const reviewerContext = await browser.newContext()
    const viewer = await viewerContext.newPage(),
      reviewer = await reviewerContext.newPage()
    try {
      for (const [role, name, target] of [
        ['viewer', 'Comment Viewer', viewer],
        ['approver', 'Comment Reviewer', reviewer],
      ] as const) {
        const email = `${role}-${identity.email}`
        const invited = await requestJson(page, '/api/auth/organization/invite-member', {
          email,
          role,
          organizationId: org,
        })
        expect(invited.status).toBe(200)
        const invitation = z.object({ id: z.string() }).parse(invited.body)
        await signUpViaApi({ ...identity, email, name }, target)
        await acceptInvitation(target, invitation.id)
      }
      await viewer.goto(`/publish/${draft.id}?panel=comments`)
      await expect(viewer.getByRole('textbox', { name: 'Draft title' })).toBeDisabled()
      await viewer.getByLabel('Comment on draft').fill('Please review the last sentence.')
      await viewer.getByRole('button', { name: 'Mention teammates' }).click()
      const reviewerOption = viewer.getByRole('menuitemcheckbox', {
        name: 'Comment Reviewer',
        exact: true,
      })
      await expect(reviewerOption).toBeVisible()
      await reviewerOption.click()
      await expect(reviewerOption).toBeChecked()
      await viewer.keyboard.press('Escape')
      let sends = 0
      await viewer.route(
        `**${path}/comments`,
        async (route) => {
          sends++
          const response = await route.fetch()
          expect(response.status()).toBe(200)
          await route.abort('failed')
        },
        { times: 1 }
      )
      await viewer.getByRole('button', { name: 'Add comment', exact: true }).click()
      await expect(viewer.getByTestId('member-comments-panel').getByRole('alert')).toContainText(
        'not confirmed'
      )
      await expect(viewer.getByRole('button', { name: 'Add comment', exact: true })).toBeDisabled()
      await viewer.getByRole('button', { name: 'Refresh comments' }).click()
      await expect(viewer.getByTestId('member-comment')).toContainText(
        'Please review the last sentence.'
      )
      await expect(viewer.getByTestId('member-comment')).toContainText('@Comment Reviewer')
      await expect(viewer.getByLabel('Comment on draft')).toHaveValue('')
      expect(sends).toBe(1)
      let saved = state.parse((await browserRequest(page, path)).body)
      expect(saved.discussions.threads).toHaveLength(1)
      expect(saved.approvedVersion).toBe(saved.version)
      expect(saved.reviewStatus).toBe('approved')
      expect(saved.plainText).toBe('Approved body')
      expect(saved.title).toBe('Comment permissions')
      const thread = saved.discussions.threads[0]
      await reviewer.goto(`/publish/${draft.id}?panel=comments`)
      await expect(reviewer.getByRole('button', { name: 'Edit comment', exact: true })).toHaveCount(
        0
      )
      expect(
        (
          await requestJson(reviewer, `${path}/comments`, {
            action: 'edit',
            baseVersion: saved.version,
            threadId: thread.id,
            commentId: thread.comments[0].id,
            text: 'Forged edit',
          })
        ).status
      ).toBe(403)
      expect(
        (
          await requestJson(reviewer, `${path}/comments`, {
            action: 'add',
            baseVersion: saved.version,
            commentId: 'forged',
            text: 'No',
            body: [],
          })
        ).status
      ).toBe(400)
      await reviewer.getByRole('button', { name: 'Reply', exact: true }).click()
      await reviewer.getByLabel('Reply to discussion').fill('The wording is clear.')
      await reviewer.getByRole('button', { name: 'Send reply', exact: true }).click()
      await expect(reviewer.getByTestId('member-comment')).toHaveCount(2)
      await viewer.getByRole('button', { name: 'Refresh comments' }).click()
      await expect(viewer.getByTestId('member-comment')).toHaveCount(2)
      await viewer.getByRole('button', { name: 'Edit comment', exact: true }).click()
      await viewer.getByLabel('Edit your comment').fill('Thanks for checking.')
      await viewer.getByRole('button', { name: 'Save comment', exact: true }).click()
      await expect(viewer.getByTestId('member-comment').first()).toContainText(
        'Thanks for checking.'
      )
      await viewer.getByRole('button', { name: 'Resolve', exact: true }).click()
      await expect(viewer.getByRole('button', { name: 'Reopen', exact: true })).toBeVisible()
      await viewer.getByRole('button', { name: 'Reopen', exact: true }).click()
      await viewer.getByRole('button', { name: 'Edit comment', exact: true }).click()
      await expect(viewer.getByLabel('Edit your comment')).toBeVisible()
      await viewer.getByRole('button', { name: 'Delete comment', exact: true }).click()
      await expect(viewer.getByLabel('Comment on draft')).toBeVisible()
      await expect(viewer.getByTestId('member-comment')).toHaveCount(1)
      await expect(viewer.getByTestId('member-comment')).toContainText('The wording is clear.')
      await viewer.reload()
      await expect(viewer.getByTestId('member-comment')).toContainText('The wording is clear.')
      await viewer.screenshot({ path: testInfo.outputPath('member-comments.png') })
      await viewer.setViewportSize({ width: 390, height: 844 })
      await expect(viewer.getByRole('dialog', { name: 'Comments' })).toBeVisible()
      await expect(viewer.getByRole('dialog', { name: 'Comments' })).toBeInViewport({ ratio: 0.99 })
      await expect(viewer.getByTestId('member-comment')).toContainText('The wording is clear.')
      expect(
        await viewer.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true)
      await viewer.screenshot({ path: testInfo.outputPath('member-comments-mobile.png') })
      const membership = z
        .object({
          members: z.array(z.object({ id: z.string(), user: z.object({ email: z.string() }) })),
        })
        .parse((await trpcQuery(page, 'workspace.listMembers')).body)
        .members.find((member) => member.user.email === `viewer-${identity.email}`)
      if (!membership) throw new Error('Viewer membership missing.')
      expect(
        (await trpcMutation(page, 'workspace.removeMember', { memberId: membership.id })).status
      ).toBe(200)
      await viewer.getByLabel('Comment on draft').fill('Stale member cannot post this.')
      await viewer.getByRole('button', { name: 'Add comment', exact: true }).click()
      await expect(viewer.getByTestId('member-comments-panel').getByRole('alert')).toContainText(
        'no longer have permission'
      )
      saved = state.parse((await browserRequest(page, path)).body)
      expect(saved.discussions.threads).toHaveLength(1)
      expect(saved.discussions.threads[0].comments).toHaveLength(1)
      expect(saved.approvedVersion).toBe(saved.version)
      expect(saved.plainText).toBe('Approved body')
    } finally {
      await viewerContext.close()
      await reviewerContext.close()
    }
  }
)
