import { HocuspocusProvider, MessageType } from '@hocuspocus/provider'
import {
  acceptInvitation,
  apiRequest,
  createWorkspace,
  db,
  draftEditor,
  expect,
  expectSaved,
  getActiveOrganizationId,
  openNewDraft,
  quietProductToursIn,
  type Page,
  requestJson,
  settleSelection,
  signUpViaApi,
  test,
  trpcMutation,
  trpcQuery,
} from './framework'
import { createDecoder, readVarString, readVarUint } from 'lib0/decoding'
import { z } from 'zod'
import { importedBody } from '@/lib/write/import-text'
import * as Y from 'yjs'

/** The collaboration server as the browser reaches it. */
const collabUrl = process.env.E2E_COLLAB_URL ?? 'ws://localhost:1234'

test('a saved draft stays readable until a failed live connection is retried', async ({
  app,
  page,
  startWorkspace,
}, testInfo) => {
  await startWorkspace()
  const draftId = await openNewDraft(page)
  await draftEditor(page).click()
  await page.keyboard.insertText('Saved before connecting.')
  await expectSaved(page)
  const path = `/api/v1/content-drafts/${draftId}`
  const saved = z
    .object({ body: z.array(z.unknown()), plainText: z.string() })
    .parse((await apiRequest(page, path)).body)
  await app.open('/publish')
  // A returning reader can have no browser copy; the saved server document must still win.
  await page.evaluate(async (name) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('The test draft browser copy is still open.'))
    })
  }, `content-draft:${draftId}`)

  let unavailable = true
  // Interrupt only this page's transport; the retry authenticates with the real server.
  await page.routeWebSocket(
    (url) => url.origin === new URL(collabUrl).origin,
    (socket) => {
      if (!unavailable) socket.connectToServer()
    }
  )
  const writes: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === path && request.method() === 'PATCH')
      writes.push(request.method())
  })
  await app.open(`/publish/${draftId}`)
  const preview = page.getByRole('region', { name: 'Saved draft' })
  await expect(preview).toContainText(saved.plainText)
  await expect(page.getByText('Connecting… Showing the last saved version.')).toBeVisible()
  await expect(page.locator('[contenteditable="true"][aria-label="Draft body"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Add to thread', exact: true })).toHaveCount(0)
  await preview.click()
  await page.keyboard.insertText('Must not edit while connecting.')
  await expect(preview).not.toContainText('Must not edit while connecting.')
  await expect(page.getByRole('button', { name: 'Retry connection' })).toBeVisible()
  expect(writes).toEqual([])
  expect((await apiRequest(page, path)).body).toMatchObject(saved)
  await page.screenshot({ path: testInfo.outputPath('saved-draft-connection-retry.png') })

  unavailable = false
  await page.getByRole('button', { name: 'Retry connection' }).click()
  await expect(draftEditor(page)).toContainText(saved.plainText)
  await expect
    .poll(async () =>
      (await draftEditor(page).locator('[data-slate-string]').allTextContents()).join('')
    )
    .toBe(saved.plainText)
  await expect(preview).toHaveCount(0)
  await endOfText(page, saved.plainText)
  await page.keyboard.insertText(' Editing after retry.')
  await expectSaved(page)
  await app.reload()
  await expect(draftEditor(page)).toContainText(`${saved.plainText} Editing after retry.`)
  await expect(draftEditor(page)).not.toContainText('Must not edit while connecting.')
})

test('a viewer promoted to creator can edit after client navigation', async ({
  browser,
  identity,
  page,
  workspace,
}) => {
  const memberIdentity = { ...identity, email: `promoted-${identity.email}` }
  const invited = await requestJson(page, '/api/auth/organization/invite-member', {
    email: memberIdentity.email,
    organizationId: workspace.id,
    role: 'viewer',
  })
  expect(invited.status).toBe(200)
  const invitationId = z.object({ id: z.string() }).parse(invited.body).id
  const context = await browser.newContext()
  try {
    await quietProductToursIn(context)
    const member = await context.newPage()
    await signUpViaApi(memberIdentity, member)
    await acceptInvitation(member, invitationId)
    const members = z
      .object({
        members: z.array(z.object({ id: z.string(), user: z.object({ email: z.string() }) })),
      })
      .parse((await trpcQuery(page, 'workspace.listMembers')).body)
    const membership = members.members.find((entry) => entry.user.email === memberIdentity.email)
    if (!membership) throw new Error('Accepted membership was not listed.')
    const draftId = await openNewDraft(page)
    await draftEditor(page).click()
    await page.keyboard.insertText('Visible to the viewer.')
    await expectSaved(page)
    await member.goto(`/publish/${draftId}`)
    await expect(member.getByTestId('draft-editor')).toContainText('Visible to the viewer.')
    await expect(draftEditor(member)).toHaveCount(0)
    expect(
      (
        await requestJson(page, '/api/auth/organization/update-member-role', {
          memberId: membership.id,
          organizationId: workspace.id,
          role: 'creator',
        })
      ).status
    ).toBe(200)
    const navigationStart = await member.evaluate(() => performance.timeOrigin)
    await member.locator(`a[href^="/publish/${draftId}?"]`).click()
    await expect(draftEditor(member)).toBeVisible()
    expect(await member.evaluate(() => performance.timeOrigin)).toBe(navigationStart)
    await endOfText(member, 'Visible to the viewer.')
    await member.keyboard.insertText(' Promoted member update.')
    await expectSaved(member)
    await expect(draftEditor(page)).toContainText('Promoted member update.')
    await page.reload()
    await expect(draftEditor(page)).toContainText('Promoted member update.')
  } finally {
    await context.close()
  }
})

/** Confirm the browser caret moved before typing into the live editor. */
async function endOfText(page: Page, text: string): Promise<void> {
  const sentence = draftEditor(page).getByText(text, { exact: true })
  await sentence.click()
  // A re-render before slate copies the moved caret into its model puts it
  // back at the click, so press End until it stays at the end.
  await expect(async () => {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End')
    await settleSelection(page)
    expect(
      await sentence.evaluate(() => {
        const selection = window.getSelection()
        return { text: selection?.focusNode?.textContent, offset: selection?.focusOffset }
      })
    ).toEqual({ text, offset: text.length })
  }).toPass({ timeout: 20_000 })
}

/** Try to join a draft's document with a token; resolves to whether it was refused. */
async function joinIsRefused(documentName: string, token: string): Promise<boolean> {
  const document = new Y.Doc()
  return new Promise<boolean>((resolve, reject) => {
    const timeout = setTimeout(() => {
      provider.destroy()
      document.destroy()
      reject(new Error('Collaboration authorization did not complete.'))
    }, 10_000)
    const finish = (refused: boolean) => {
      clearTimeout(timeout)
      provider.destroy()
      document.destroy()
      resolve(refused)
    }
    const provider = new HocuspocusProvider({
      document,
      name: documentName,
      onAuthenticationFailed: () => {
        finish(true)
      },
      onSynced: () => {
        finish(false)
      },
      token,
      url: collabUrl,
    })
  })
}

// RFC 013: two members edit one draft live through the Hocuspocus server,
// which authorizes and persists only through the Go backend. A member of
// another workspace gets no token for the draft, and their own token does not
// open it.
test(
  'two members co-edit a draft live, and another workspace is refused',
  { tag: '@journey' },
  async ({ app, browser, identity, page }, testInfo) => {
    await createWorkspace(identity, page)
    const organizationId = await getActiveOrganizationId(page)
    const memberIdentity = {
      ...identity,
      email: `member-${identity.email}`,
      name: 'Bea Collaborator',
    }
    const invitation = await requestJson(page, '/api/auth/organization/invite-member', {
      email: memberIdentity.email,
      organizationId,
      role: 'creator',
    })
    expect(invitation.status, JSON.stringify(invitation.body)).toBe(200)
    const invitationId = z.object({ id: z.string() }).parse(invitation.body).id

    const memberContext = await browser.newContext()
    const strangerContext = await browser.newContext()
    try {
      await quietProductToursIn(memberContext)
      const memberPage = await memberContext.newPage()
      await signUpViaApi(memberIdentity, memberPage)
      await acceptInvitation(memberPage, invitationId)

      const draftId = await openNewDraft(page)
      await draftEditor(page).click()
      await page.keyboard.type('Written by the owner.')

      await memberPage.goto(`/publish/${draftId}`)
      await expect(draftEditor(memberPage)).toContainText('Written by the owner.', {
        timeout: 60_000,
      })
      // Presence names the workspace members, not demo users.
      await expect(page.getByTestId('presence')).toContainText('Bea Collaborator')
      await expect(memberPage.getByTestId('presence')).toContainText(identity.name)

      // Put the caret at the end of the owner's sentence.
      await endOfText(memberPage, 'Written by the owner.')
      await memberPage.keyboard.type(' Edited by Bea.')
      await expect(draftEditor(page)).toContainText('Written by the owner. Edited by Bea.')
      // The member's caret shows in the owner's editor, labelled with their name.
      await expect(
        page.getByTestId('remote-cursor').filter({ hasText: 'Bea Collaborator' })
      ).toBeVisible()

      // Two independent editors submit live changes at the same position.
      // CRDT ordering may differ, but both contributions must converge and save.
      await endOfText(page, 'Written by the owner. Edited by Bea.')
      await endOfText(memberPage, 'Written by the owner. Edited by Bea.')
      await Promise.all([
        page.keyboard.insertText(' Owner concurrent.'),
        memberPage.keyboard.insertText(' Bea concurrent.'),
      ])
      for (const participant of [page, memberPage]) {
        await expect(draftEditor(participant)).toContainText('Owner concurrent.')
        await expect(draftEditor(participant)).toContainText('Bea concurrent.')
      }
      const expectedContent = (
        await draftEditor(page).locator('[data-slate-string]').allTextContents()
      ).join('')
      await expect
        .poll(async () =>
          (await draftEditor(memberPage).locator('[data-slate-string]').allTextContents()).join('')
        )
        .toBe(expectedContent)
      await expect
        .poll(
          async () =>
            z
              .object({ plainText: z.string() })
              .parse((await apiRequest(page, `/api/v1/content-drafts/${draftId}`)).body).plainText
        )
        .toContain('Owner concurrent.')
      await expect
        .poll(
          async () =>
            z
              .object({ plainText: z.string() })
              .parse((await apiRequest(page, `/api/v1/content-drafts/${draftId}`)).body).plainText
        )
        .toContain('Bea concurrent.')

      // Decode the stored CRDT, not merely a non-null or earlier snapshot.
      const storedText = async () => {
        const result = await db.query(
          'SELECT "collabState" AS state FROM content_draft WHERE id=$1',
          [draftId]
        )
        const state = z
          .object({ state: z.instanceof(Buffer).nullable() })
          .parse(result.rows[0]).state
        if (!state) return ''
        const document = new Y.Doc()
        try {
          Y.applyUpdate(document, state)
          return document.get('content', Y.XmlText).toString()
        } finally {
          document.destroy()
        }
      }
      await expect.poll(storedText, { timeout: 30_000 }).toContain('Owner concurrent.')
      await expect.poll(storedText, { timeout: 30_000 }).toContain('Bea concurrent.')
      await app.reload()
      await expect
        .poll(
          async () =>
            (await draftEditor(page).locator('[data-slate-string]').allTextContents()).join(''),
          { timeout: 60_000 }
        )
        .toBe(expectedContent)
      await page.screenshot({ path: testInfo.outputPath('collaboration-converged.png') })

      const strangerPage = await strangerContext.newPage()
      await createWorkspace(
        {
          ...identity,
          email: `stranger-${identity.email}`,
          workspaceName: `Stranger ${identity.workspaceName}`,
        },
        strangerPage
      )
      const foreignToken = await apiRequest(
        strangerPage,
        `/api/v1/content-drafts/${draftId}/collab-token`,
        { body: {}, method: 'POST' }
      )
      expect(foreignToken.status).toBe(404)
      const theirDraft = z
        .object({ id: z.string() })
        .parse(
          (await apiRequest(strangerPage, '/api/v1/content-drafts', { body: {}, method: 'POST' }))
            .body
        )
      const theirToken = z.object({ token: z.string() }).parse(
        (
          await apiRequest(strangerPage, `/api/v1/content-drafts/${theirDraft.id}/collab-token`, {
            body: {},
            method: 'POST',
          })
        ).body
      ).token
      expect(await joinIsRefused(`content-draft:${draftId}`, theirToken)).toBe(true)
      // The same token does open the stranger's own draft.
      expect(await joinIsRefused(`content-draft:${theirDraft.id}`, theirToken)).toBe(false)
    } finally {
      await memberContext.close()
      await strangerContext.close()
    }
  }
)

// @quarantine until fixed: on the production build the owner's update does not reach the demoted reader (2 of 3 runs).
test(
  'demotion blocks live edits and removal stops an already open reader',
  { tag: ['@quarantine', '@journey'] },
  async ({ browser, identity, page, workspace }, testInfo) => {
    const organizationId = workspace.id
    const memberIdentity = {
      ...identity,
      email: `revoked-${identity.email}`,
      name: 'Revoked collaborator',
    }
    const invited = await requestJson(page, '/api/auth/organization/invite-member', {
      email: memberIdentity.email,
      organizationId,
      role: 'creator',
    })
    expect(invited.status).toBe(200)
    const invitationId = z.object({ id: z.string() }).parse(invited.body).id
    const context = await browser.newContext()
    try {
      const member = await context.newPage()
      let closedDocuments = 0
      member.on('websocket', (socket) => {
        if (socket.url().startsWith(collabUrl))
          socket.on('framereceived', ({ payload }) => {
            // Hocuspocus closes one logical document on a multiplexed socket.
            const decoder = createDecoder(
              typeof payload === 'string' ? Buffer.from(payload) : payload
            )
            readVarString(decoder)
            if (readVarUint(decoder) === MessageType.CLOSE) closedDocuments++
          })
      })
      await signUpViaApi(memberIdentity, member)
      await acceptInvitation(member, invitationId)
      const members = z
        .object({
          members: z.array(z.object({ id: z.string(), user: z.object({ email: z.string() }) })),
        })
        .parse((await trpcQuery(page, 'workspace.listMembers')).body)
      const membership = members.members.find((entry) => entry.user.email === memberIdentity.email)
      if (!membership) throw new Error('Accepted membership was not listed.')
      const draftId = await openNewDraft(page)
      await draftEditor(page).click()
      await page.keyboard.type('Visible to the team.')
      await expectSaved(page)
      await member.goto(`/publish/${draftId}`)
      await expect(draftEditor(member)).toContainText('Visible to the team.')
      await expect(page.getByTestId('presence')).toContainText(memberIdentity.name)

      expect(
        (
          await requestJson(page, '/api/auth/organization/update-member-role', {
            memberId: membership.id,
            organizationId,
            role: 'viewer',
          })
        ).status
      ).toBe(200)
      const deniedSave = member.waitForResponse(
        (response) =>
          response.request().method() === 'PATCH' &&
          response.url().endsWith(`/api/v1/content-drafts/${draftId}`)
      )
      await draftEditor(member).click()
      await member.keyboard.press('ControlOrMeta+End')
      await member.keyboard.type(' Forbidden live edit.')
      expect((await deniedSave).status()).toBe(403)
      await expect(draftEditor(page)).not.toContainText('Forbidden live edit.')
      await endOfText(page, 'Visible to the team.')
      await page.keyboard.type(' Allowed owner update.')
      await expectSaved(page)
      await expect(draftEditor(member)).toContainText('Allowed owner update.')

      const storedText = async () => {
        const result = await db.query(
          'SELECT "collabState" AS state FROM content_draft WHERE id=$1',
          [draftId]
        )
        const state = z
          .object({ state: z.instanceof(Buffer).nullable() })
          .parse(result.rows[0]).state
        if (!state) return ''
        const document = new Y.Doc()
        try {
          Y.applyUpdate(document, state)
          return document.get('content', Y.XmlText).toString()
        } finally {
          document.destroy()
        }
      }
      await expect.poll(storedText, { timeout: 20_000 }).toContain('Allowed owner update.')
      expect(await storedText()).not.toContain('Forbidden live edit.')
      const navigationStart = await member.evaluate(() => performance.timeOrigin)
      await member.locator(`a[href^="/publish/${draftId}?"]`).click()
      await expect(member.getByTestId('draft-editor')).toContainText('Allowed owner update.')
      await expect(draftEditor(member)).toHaveCount(0)
      expect(await member.evaluate(() => performance.timeOrigin)).toBe(navigationStart)
      await endOfText(page, 'Visible to the team. Allowed owner update.')
      await page.keyboard.insertText(' Still live after the access change.')
      await expectSaved(page)
      await expect(member.getByTestId('draft-editor')).toContainText(
        'Still live after the access change.'
      )
      await member.goto(`/publish/${draftId}`)
      const reader = member.getByTestId('draft-editor')
      await expect(reader).toBeVisible()
      await expect(reader).toContainText('Allowed owner update.')
      await expect(reader).not.toContainText('Forbidden live edit.')
      await member.screenshot({ path: testInfo.outputPath('collaboration-demoted-reader.png') })
      const oldToken = z
        .object({ token: z.string() })
        .parse(
          (await requestJson(member, `/api/v1/content-drafts/${draftId}/collab-token`, {})).body
        ).token

      const closedBeforeRemoval = closedDocuments
      expect(
        (await trpcMutation(page, 'workspace.removeMember', { memberId: membership.id })).status
      ).toBe(200)
      await draftEditor(page).click()
      await page.keyboard.press('ControlOrMeta+End')
      await page.keyboard.type(' Private after removal.')
      await expectSaved(page)
      await expect.poll(() => closedDocuments).toBeGreaterThan(closedBeforeRemoval)
      await expect(reader).not.toContainText('Private after removal.')
      await expect(page.getByTestId('presence')).not.toContainText(memberIdentity.name)
      expect(await joinIsRefused(`content-draft:${draftId}`, oldToken)).toBe(true)
      expect((await apiRequest(member, `/api/v1/content-drafts/${draftId}`)).status).toBe(401)
      await expect.poll(storedText, { timeout: 20_000 }).toContain('Private after removal.')
      expect(await storedText()).not.toContain('Forbidden live edit.')
      await page.screenshot({ path: testInfo.outputPath('collaboration-after-removal.png') })
      await member.reload()
      await expect.poll(() => new URL(member.url()).pathname).toBe('/sign-in')
    } finally {
      await context.close()
    }
  }
)

test(
  'a draft opened for the first time shows its stored body even when its browser copy loads last',
  // @quarantine: held out of the production lane with no reason recorded.
  { tag: '@quarantine' },
  async ({ page, startWorkspace }) => {
    await startWorkspace()
    // Plate seeds a never-opened live document from the stored body only while no
    // local copy is still loading, and never retries. IndexedDB opening after the
    // server sync once left a recovered backup's editor empty, so every open here
    // is held past the sync and Plate's five-second timeout.
    await page.addInitScript(() => {
      const open = IDBFactory.prototype.open
      IDBFactory.prototype.open = function (this: IDBFactory, ...args: [string, number?]) {
        const request = open.apply(this, args)
        let onsuccess: IDBOpenDBRequest['onsuccess'] = null
        Object.defineProperty(request, 'onsuccess', {
          configurable: true,
          get: () => onsuccess,
          set: (handler: IDBOpenDBRequest['onsuccess']) => {
            onsuccess = handler
          },
        })
        request.addEventListener('success', (event) => {
          setTimeout(() => onsuccess?.call(request, event), 8_000)
        })
        return request
      }
    })
    const created = await apiRequest(page, '/api/v1/content-drafts', {
      method: 'POST',
      body: {
        title: 'Opened late',
        plainText: 'Stored before anyone opened it',
        body: importedBody(['Stored before anyone opened it']),
      },
    })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const { id } = z.object({ id: z.string() }).parse(created.body)
    await page.goto(`/publish/${id}`)
    await expect(page.getByRole('region', { name: 'Saved draft' })).toContainText(
      'Stored before anyone opened it'
    )
    await expect(page.locator('[contenteditable="true"][aria-label="Draft body"]')).toHaveCount(0)
    await expect(draftEditor(page)).toContainText('Stored before anyone opened it', {
      timeout: 60_000,
    })
    await expect(page.getByRole('region', { name: 'Saved draft' })).toHaveCount(0)
  }
)

test(
  'a menu one editor opens stays its own: another editor neither shows it nor closes it',
  { tag: '@journey' },
  async ({ page, startWorkspace }) => {
    await startWorkspace()
    const draftId = await openNewDraft(page)
    await page.keyboard.type('Shared draft.')
    await expectSaved(page)
    const other = await page.context().newPage()
    try {
      await other.goto(`/write/${draftId}`)
      await expect(draftEditor(other)).toContainText('Shared draft.')
      await page.bringToFront()
      await page.keyboard.type(' /')
      await expect(page.getByRole('listbox')).toBeVisible()
      // The "/" reaches the other editor, but its menu and focus stay where they opened.
      await expect(draftEditor(other)).toContainText('Shared draft. /')
      await other.bringToFront()
      await expect(other.getByRole('listbox')).toHaveCount(0)
      expect(await other.evaluate(() => document.activeElement?.tagName)).not.toBe('INPUT')
      await other.keyboard.press('Escape')
      await page.bringToFront()
      await expect(page.getByRole('listbox')).toBeVisible()
      await page.keyboard.type('bullets')
      await expect(page.getByRole('option').filter({ hasText: 'Bulleted list' })).toBeVisible()
    } finally {
      await other.close()
    }
  }
)

test(
  'a menu left open in a closed editor is removed for everyone else',
  { tag: '@journey' },
  async ({ page, startWorkspace }) => {
    await startWorkspace()
    const draftId = await openNewDraft(page)
    await page.keyboard.type('Shared draft.')
    await expectSaved(page)
    const other = await page.context().newPage()
    await other.goto(`/write/${draftId}`)
    await endOfText(other, 'Shared draft.')
    await other.keyboard.type(' /')
    await expect(other.getByRole('listbox')).toBeVisible()
    // The menu is an inline node; the post's "14 / 280" counter is in the editor too.
    const menu = draftEditor(page).locator('[data-slate-inline]')
    await expect(menu).toHaveCount(1)
    // eslint-disable-next-line no-restricted-syntax -- A menu whose owner is still here must outlast the 45 s orphan grace and its 5 s check.
    await page.waitForTimeout(56_000)
    await expect(menu).toHaveCount(1)
    await expect(other.getByRole('listbox')).toBeVisible()
    // The tab closes with its menu still open; no "/" is left in the draft.
    await other.close()
    await expect(menu).toHaveCount(0, { timeout: 90_000 })
    await expect(draftEditor(page)).toContainText('Shared draft.')
  }
)
