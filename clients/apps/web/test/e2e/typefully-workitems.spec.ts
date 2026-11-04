import { ShotsClient } from '../../../../integrations/raycast/src/lib/client'
import { createRequire } from 'node:module'
import sharp from 'sharp'
import { importedBody } from '@/lib/write/import-text'
import {
  addBatchRows,
  apiRequest,
  db,
  draftEditor,
  enableDraftTags,
  expect,
  expectSaved,
  openNewBatch,
  saveBatchDrafts,
  test,
  trpcMutation,
  editorMore,
} from './framework'

test.use({ actionTimeout: 30_000 })

test(
  'URL import, paste undo, poll copying, and refresh preserve editable content',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    await startWorkspace({ channels: ['x', 'linkedin'] })
    await app.open(`/?new=${encodeURIComponent('What comes next? 100% + 🚀')}`)
    await expect(page.getByLabel('Imported draft text')).toHaveValue('What comes next? 100% + 🚀')
    await page.getByRole('button', { name: 'Create draft', exact: true }).click()
    await page.waitForURL(/\/write\/[a-z0-9]+$/)
    await expect(draftEditor(page)).toContainText('100% + 🚀')
    const paste = async () => {
      await page.getByRole('button', { name: 'More draft actions' }).click()
      await page.getByRole('menuitem', { name: 'Paste as thread…' }).click()
      await page.getByLabel('Thread text').fill('Second post\n---\nThird post')
      await page.getByRole('button', { name: 'Append 2 posts' }).click()
    }
    await paste()
    await expect(page.getByTestId('post-header')).toHaveCount(3)
    await page.keyboard.press('ControlOrMeta+z')
    await expect(page.getByTestId('post-header')).toHaveCount(1)
    await paste()
    await expectSaved(page)
    await app.reload()
    await expect(page.getByTestId('post-header')).toHaveCount(3)
    await expect(draftEditor(page)).toContainText('Third post')

    // A post's poll sits in the bar under that post.
    await page
      .getByRole('toolbar', { name: 'Post 1 tools', exact: true })
      .getByRole('button', { name: 'Add a poll', exact: true })
      .click()
    await page.getByRole('button', { name: 'Add poll', exact: true }).click()
    await page.getByLabel('Poll option 1').fill('Choice one')
    await page.getByLabel('Poll option 2').fill('Choice two')
    await page.keyboard.press('Escape')
    await expectSaved(page)
    await page.getByRole('button', { name: 'More draft actions' }).click()
    await page.getByRole('menuitem', { name: 'Copy poll to channel…' }).click()
    await page.getByLabel('Poll destination').selectOption('linkedin')
    await page.getByLabel('Poll question').fill('Which option?')
    await page.getByRole('button', { name: 'Review destination version' }).click()
    await page.getByRole('button', { name: 'Copy poll', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expectSaved(page)
    await app.reload()
    await page.getByTestId('platform-tab-linkedin').click()
    await page.getByRole('button', { name: 'Edit the poll', exact: true }).click()
    await expect(page.getByLabel('Poll question')).toHaveValue('Which option?')
    await expect(page.getByLabel('Poll option 1')).toHaveValue('Choice one')
    await page.screenshot({ path: '.context/shots/typefully-poll-copy.png' })
    await page.keyboard.press('Escape')
    await page.getByTestId('new-draft').first().click()
    await expect(draftEditor(page)).toBeVisible()
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.evaluate(() => navigator.clipboard.writeText('https://x.com/example/status/123456'))
    await draftEditor(page).click()
    await draftEditor(page).press('ControlOrMeta+v')
    await page.getByRole('button', { name: 'Open as quote draft' }).click()
    await expect(page.getByText('Quoting', { exact: true })).toBeVisible()
    await expectSaved(page)
    await app.reload()
    const quoteId = new URL(page.url()).pathname.split('/').at(-1)!
    const quote = await apiRequest(page, `/api/v1/content-drafts/${quoteId}`)
    expect((quote.body as { kind: string }).kind).toBe('quote')
    expect((quote.body as { target: { remoteId: string } }).target.remoteId).toBe('123456')
  }
)

test(
  '25-post threads retain rich paste and remain editable on mobile after refresh',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await startWorkspace({ channels: ['x', 'linkedin'] })
    const text = Array.from(
      { length: 25 },
      (_, index) => `Post ${index + 1}: a distinct thought with enough room to edit.`
    ).join('\n---\n')
    await app.open(`/write?new=${encodeURIComponent(text)}`)
    await page.getByRole('button', { name: 'Create draft', exact: true }).click()
    await page.waitForURL(/\/write\/[a-z0-9]+$/)
    await expect(page.getByTestId('post-header')).toHaveCount(25)
    const editor = draftEditor(page)
    await editor.click()
    await editor.press('ControlOrMeta+End')
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.evaluate(async () => {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob(
            [
              '<p><strong>Imported evidence</strong> and <em>careful reasoning</em></p><ul><li>First source</li><li>Second source</li></ul>',
            ],
            { type: 'text/html' }
          ),
          'text/plain': new Blob(
            ['Imported evidence and careful reasoning\n• First source\n• Second source'],
            { type: 'text/plain' }
          ),
        }),
      ])
    })
    await editor.press('ControlOrMeta+v')
    await expect(editor).toContainText('Imported evidence')
    await expectSaved(page)
    const id = new URL(page.url()).pathname.split('/').at(-1)!
    const persisted = await apiRequest(page, `/api/v1/content-drafts/${id}`)
    expect(JSON.stringify(persisted.body)).toContain('"bold":true')
    expect(JSON.stringify(persisted.body)).toContain('"italic":true')
    await page.setViewportSize({ width: 390, height: 844 })
    await app.reload()
    await expect(page.getByTestId('post-header')).toHaveCount(25)
    await editor.click()
    await editor.press('ControlOrMeta+End')
    await page.keyboard.insertText(' Mobile revision.')
    await expectSaved(page)
    await app.reload()
    await expect(editor).toContainText('Mobile revision.')
    await expect(editor).toContainText('Second source')
    await page.screenshot({ path: '.context/shots/typefully-large-mobile.png' })
    expect(errors).toEqual([])
  }
)

test(
  'calendar slots pick saved drafts and queue board drops open the same scheduling review',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    const workspace = await startWorkspace({ channels: ['x', 'linkedin'] })
    const created = await apiRequest(page, '/api/v1/content-drafts', {
      method: 'POST',
      body: {
        title: 'Calendar choice',
        plainText: 'Pick this saved draft',
        body: importedBody(['Pick this saved draft']),
        channelConnectionIds: [workspace.channels.x],
      },
    })
    expect(created.status).toBe(201)
    const id = (created.body as { id: string }).id
    const calendarURL = `/write/plan?view=queue&week=${new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10)}`
    // Plan commits nothing itself: both paths open the draft's one scheduling review.
    const reviewAndSchedule = async () => {
      await page.getByRole('button', { name: 'Review and schedule…', exact: true }).click()
      const review = page.getByTestId('schedule-dialog')
      await expect(review.getByTestId('destinations')).toBeVisible()
      await review.getByRole('checkbox', { name: 'Open a new draft after scheduling' }).uncheck()
      await review.getByRole('button', { name: /^Confirm schedule/ }).click()
      await expect(review).toHaveCount(0)
    }
    await page.goto(calendarURL)
    await page.getByLabel('Calendar view').selectOption('week')
    await expect(page.getByLabel('week calendar', { exact: true })).toBeVisible()
    const slot = page.getByRole('button', { name: /Available ·/ }).first()
    await slot.click()
    await page.getByRole('button', { name: 'Choose existing content' }).click()
    await page.getByRole('button', { name: /Pick this saved draft/ }).click()
    await page.getByRole('checkbox', { name: 'Open in editor' }).uncheck()
    await reviewAndSchedule()
    const committed = await apiRequest(page, `/api/v1/content-drafts/${id}/posts`)
    expect(committed.status).toBe(200)
    expect((committed.body as { posts: unknown[] }).posts).toHaveLength(1)
    await page.goto(calendarURL)
    await expect(
      page.getByTestId('calendar-post').filter({ hasText: 'Pick this saved draft', visible: true })
    ).toHaveCount(1)
    await app.reload()
    await expect(page.getByTestId('calendar-post').filter({ visible: true })).toHaveCount(1)
    const dropped = await apiRequest(page, '/api/v1/content-drafts', {
      method: 'POST',
      body: {
        title: 'Drag from sidebar',
        plainText: 'Dropped draft',
        body: importedBody(['Dropped draft']),
        channelConnectionIds: [workspace.channels.x],
      },
    })
    expect(dropped.status).toBe(201)
    await app.reload()
    await page.getByRole('button', { name: 'Drafts', exact: true }).first().click()
    const dragSource = page.getByRole('link', { name: /Dropped draft.*Edited/ })
    await expect(dragSource).toHaveAttribute('draggable', 'true')
    await dragSource.dragTo(page.getByRole('button', { name: /Available ·/ }).first())
    await expect(page.getByRole('dialog', { name: 'Choose a draft', exact: true })).toBeVisible()
    await page.getByRole('checkbox', { name: 'Open in editor' }).uncheck()
    // A drop only opens human review; it has not scheduled anything yet.
    const beforeConfirm = await apiRequest(
      page,
      `/api/v1/content-drafts/${(dropped.body as { id: string }).id}/posts`
    )
    expect(beforeConfirm.status).toBe(200)
    expect((beforeConfirm.body as { posts: unknown[] }).posts).toHaveLength(0)
    await reviewAndSchedule()
    await page.goto(calendarURL)
    await expect(page.getByTestId('calendar-post').filter({ visible: true })).toHaveCount(2)
    await app.reload()
    await expect(page.getByTestId('calendar-post').filter({ visible: true })).toHaveCount(2)
    await page.screenshot({ path: '.context/shots/typefully-queue-board.png' })
  }
)

test(
  'bulk Spread, month filtering, precise rescheduling and stored analytics complete through the UI',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    const workspace = await startWorkspace({ channels: ['x', 'linkedin'] })
    for (const title of ['Batch first', 'Batch second']) {
      const created = await apiRequest(page, '/api/v1/content-drafts', {
        method: 'POST',
        body: {
          title,
          plainText: title,
          body: [{ type: 'p', children: [{ text: title }] }],
          channelConnectionIds: [workspace.channels.x],
        },
      })
      expect(created.status, JSON.stringify(created.body)).toBe(201)
    }
    await app.open('/write')
    const first = page.getByTestId('draft-row').filter({ hasText: 'Batch first' })
    const second = page.getByTestId('draft-row').filter({ hasText: 'Batch second' })
    await first.getByRole('link').click({ modifiers: ['Shift'] })
    await second.getByRole('link').click()
    await page
      .getByRole('toolbar', { name: 'Selected drafts' })
      .getByRole('button', { name: 'Schedule', exact: true })
      .click()
    await page.getByLabel('Batch mode').selectOption('spread')
    await page.getByRole('button', { name: 'Preview and validate' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Ready')
    await expect(dialog.getByRole('listitem')).toHaveCount(2)
    await page.getByRole('button', { name: 'Schedule valid drafts' }).click()
    await expect(dialog.getByRole('listitem').filter({ hasText: 'Scheduled' })).toHaveCount(2)
    await page.keyboard.press('Escape')
    await app.open('/write/plan?view=month')
    await expect(page.getByTestId('calendar-post').filter({ visible: true })).toHaveCount(2)
    await page.getByLabel('Calendar view').selectOption('month')
    await page.getByTestId('calendar-post').filter({ visible: true }).first().click()
    await page.getByLabel('Time', { exact: true }).fill('16:35')
    await page.getByRole('button', { name: 'Move', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await app.reload()
    await expect(page.getByTestId('calendar-post').filter({ visible: true })).toHaveCount(2)
    const result = await db.query(
      `SELECT p.id,p.caption,p."scheduledFor",p."socialSetId",p."channelConnectionId",p."contentDraftId" FROM scheduled_post p WHERE p."organizationId"=$1 AND status='SCHEDULED' ORDER BY p."scheduledFor"`,
      [workspace.id]
    )
    expect(result.rows).toHaveLength(2)
    await page
      .getByTestId('calendar-post')
      .filter({ hasText: result.rows[0].caption, visible: true })
      .click()
    await page
      .getByLabel(`Swap queue position for ${result.rows[0].caption}`)
      .selectOption(result.rows[1].id)
    await expect
      .poll(
        async () =>
          (
            await db.query(
              `SELECT count(*)::int AS count FROM scheduled_post WHERE id=ANY($1::text[]) AND status='CANCELLED'`,
              [result.rows.map((row) => row.id)]
            )
          ).rows[0].count
      )
      .toBe(2)
    await app.reload()
    const swapped = await db.query(
      `SELECT id,caption,"scheduledFor","socialSetId","channelConnectionId","contentDraftId" FROM scheduled_post WHERE "organizationId"=$1 AND status='SCHEDULED'`,
      [workspace.id]
    )
    expect(swapped.rows).toHaveLength(2)
    for (const [index, original] of result.rows.entries()) {
      const replacement = swapped.rows.find((row) => row.caption === original.caption)
      expect(new Date(replacement?.scheduledFor).toISOString()).toBe(
        new Date(result.rows[1 - index].scheduledFor).toISOString()
      )
    }
    const post = swapped.rows[0]
    // A deliberate storage fixture tests dashboard attribution; it is not a provider read.
    await db.query(
      `INSERT INTO platform_social_observation (id,"organizationId","socialSetId","connectionId","subjectId",kind,platform,day,"observedAt",metrics,status) VALUES ($1,$2,$3,$4,$5,'post','x',date_trunc('day',now()),now(),'{"likes":12,"impressions":90}','available')`,
      [`observation-${post.id}`, workspace.id, post.socialSetId, post.channelConnectionId, post.id]
    )
    await page.getByRole('button', { name: 'Show only', exact: true }).first().click()
    await page.getByText('Filters', { exact: true }).click()
    await page.getByRole('checkbox', { name: 'linkedin', exact: true }).check()
    await page.getByText('Filters', { exact: true }).click()
    await expect(page.getByTestId('calendar-post').filter({ visible: true })).toHaveCount(0)
    await app.reload()
    await page.getByText('Filters', { exact: true }).click()
    await expect(page.getByRole('checkbox', { name: 'linkedin', exact: true })).toBeChecked()
    await page.getByRole('checkbox', { name: 'linkedin', exact: true }).uncheck()
    await page.getByRole('checkbox', { name: 'x', exact: true }).check()
    await page.getByText('Filters', { exact: true }).click()
    await expect(page.getByTestId('calendar-post').filter({ visible: true })).toHaveCount(2)
    const period = page.getByRole('heading', { level: 1 })
    const previousPeriod = await period.textContent()
    await period.click()
    await page.keyboard.press('ArrowRight')
    await expect(period).not.toHaveText(previousPeriod!)
    await page.keyboard.press('ArrowLeft')
    await expect(period).toHaveText(previousPeriod!)
    await expect(page.getByTestId('calendar-post').filter({ visible: true })).toHaveCount(2)
    await enableDraftTags(page)
    const tagged = await apiRequest(page, `/api/v1/social-sets/${post.socialSetId}/tags`, {
      method: 'POST',
      body: { name: 'Calendar evidence' },
    })
    expect(tagged.status, JSON.stringify(tagged.body)).toBe(201)
    const tagId = (tagged.body as { id: string }).id
    const taggedDraft = await apiRequest(
      page,
      `/api/v1/content-drafts/${post.contentDraftId}/properties`,
      { method: 'PATCH', body: { addTagIds: [tagId] } }
    )
    expect(taggedDraft.status, JSON.stringify(taggedDraft.body)).toBe(200)
    await app.reload()
    await page.getByText('Filters', { exact: true }).click()
    await page.getByRole('checkbox', { name: 'Calendar evidence', exact: true }).check()
    await page.getByText('Filters', { exact: true }).click()
    await expect(page.getByTestId('calendar-post').filter({ visible: true })).toHaveCount(1)
    await expect(page.getByTestId('calendar-post').filter({ visible: true })).toContainText(
      'Calendar evidence'
    )
    await app.reload()
    await page.getByText('Filters', { exact: true }).click()
    await expect(
      page.getByRole('checkbox', { name: 'Calendar evidence', exact: true })
    ).toBeChecked()
    await page.getByText('Filters', { exact: true }).click()
    await expect(page.getByTestId('calendar-post').filter({ visible: true })).toHaveCount(1)
    // A second explicit storage fixture verifies account series rendering and CSV values.
    const today = new Date().toISOString().slice(0, 10)
    const yesterday = new Date(Date.now() - 9 * 86400_000).toISOString().slice(0, 10)
    await db.query(
      `INSERT INTO platform_social_observation (id,"organizationId","socialSetId","connectionId","subjectId",kind,platform,day,"observedAt",series,status) VALUES ($1,$2,$3,$4,$4,'account','x',date_trunc('day',now()),now(),$5::jsonb,'available') ON CONFLICT ("organizationId",kind,"subjectId",day) DO UPDATE SET series=EXCLUDED.series,status=EXCLUDED.status,"observedAt"=EXCLUDED."observedAt"`,
      [
        `account-${post.id}`,
        workspace.id,
        post.socialSetId,
        post.channelConnectionId,
        JSON.stringify([
          {
            label: 'Followers',
            average: false,
            data: [
              { date: yesterday, total: '120' },
              { date: today, total: '123' },
            ],
          },
        ]),
      ]
    )
    // Controlled published receipts supply a measured timing score, not a live-provider claim.
    for (let index = 0; index < 5; index++)
      await db.query(
        `INSERT INTO scheduled_post (id,"organizationId","channelConnectionId","contentDraftId","socialSetId","scheduledFor","publishedAt",status,caption,"idempotencyKey","remotePostId",metrics,"metricsAt","updatedAt") VALUES ($1,$2,$3,$4,$5,date_trunc('hour',now())-interval '1 hour',date_trunc('hour',now())-interval '1 hour','PUBLISHED','Observed fixture post',$1,$1,'{"likes":8}',now(),now())`,
        [
          `${post.id}best${index}`,
          workspace.id,
          post.channelConnectionId,
          post.contentDraftId,
          post.socialSetId,
        ]
      )
    const currentSet = await apiRequest(page, `/api/v1/social-sets/${post.socialSetId}`)
    expect(
      (
        await apiRequest(page, `/api/v1/social-sets/${post.socialSetId}/queue`, {
          method: 'PATCH',
          body: {
            baseVersion: (currentSet.body as { version: number }).version,
            postingSlots: [],
          },
        })
      ).status
    ).toBe(200)
    await db.query(
      `INSERT INTO platform_social_observation (id,"organizationId","socialSetId","connectionId","subjectId",kind,platform,day,"observedAt",metrics,status,"externalPost") VALUES ($1,$2,$3,$4,$1,'post','x',date_trunc('day',now()),now(),'{"likes":4}','available',$5::jsonb)`,
      [
        `external-${post.id}`,
        workspace.id,
        post.socialSetId,
        post.channelConnectionId,
        JSON.stringify({
          id: 'external-post',
          url: 'https://x.com/i/status/42',
          caption: 'Observed outside Shots',
          publishedAt: new Date().toISOString(),
          metrics: { likes: 4 },
        }),
      ]
    )
    await app.open('/write/analyze/observations')
    await expect(
      page.getByRole('img', { name: 'Average engagement score 8.0 from 5 posts' }).first()
    ).toBeVisible()
    await page.getByRole('button', { name: '+ Add weekly slot', exact: true }).first().click()
    await expect(
      page.getByText('Added to the weekly posting schedule.', { exact: true })
    ).toBeVisible()
    await app.reload()
    const updatedSet = await apiRequest(page, `/api/v1/social-sets/${post.socialSetId}`)
    expect((updatedSet.body as { postingSlots: unknown[] }).postingSlots).toHaveLength(1)
    await page.getByRole('button', { name: '+ Add weekly slot', exact: true }).first().click()
    await expect(
      page.getByText('This time is already in the posting schedule.', { exact: true })
    ).toBeVisible()
    await expect(page.getByTestId('social-analytics')).toContainText('Observed outside Shots')
    await expect(page.getByRole('img', { name: /x · Followers/ })).toBeVisible()
    await expect(page.getByRole('img', { name: /x · Followers/ }).locator('circle')).toHaveCount(2)
    await expect(page.getByTestId('social-analytics')).toContainText('12')
    await expect(page.getByTestId('social-analytics')).toContainText('Unavailable')
    await page.getByLabel('Period', { exact: true }).selectOption('month')
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export CSV' }).click()
    expect((await download).suggestedFilename()).toBe('social-observations.csv')
    await app.reload()
    await expect(page.getByTestId('social-analytics')).toContainText('12')
    await page.screenshot({ path: '.context/shots/typefully-analytics.png' })
  }
)

test(
  'a bulk batch uploads assets once, resumes after refresh, and media edits persist',
  { tag: ['@dev-server', '@journey'] },
  async ({ app, page, startWorkspace }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const workspace = await startWorkspace({ channels: ['x', 'linkedin'] })
    await openNewBatch(page, app)
    const png = await sharp({
      create: { width: 48, height: 48, channels: 4, background: '#2563eb' },
    })
      .png()
      .toBuffer()
    let uploads = 0
    // Each file's bytes go to storage once, as a presigned PUT.
    page.on('request', (request) => {
      if (request.method() === 'PUT') uploads++
    })
    await addBatchRows(
      page,
      'caption,asset,channels\nFirst imported,one.png,x\nSecond imported,two.png,x',
      [
        { name: 'one.png', mimeType: 'image/png', buffer: png },
        { name: 'two.png', mimeType: 'image/png', buffer: png },
      ]
    )
    const ids = await saveBatchDrafts(page)
    expect(ids).toHaveLength(2)
    await app.reload()
    const saved = page.getByTestId('batch-item').getByRole('link', { name: /^Open draft/ })
    await expect(saved).toHaveCount(2)
    expect(
      await saved.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')))
    ).toEqual(ids.map((id) => `/write/${id}`))
    await expect(
      page.getByRole('button', { name: 'Save ready items as drafts', exact: true })
    ).toBeDisabled()
    expect(uploads).toBe(2)
    await page.screenshot({ path: '.context/shots/typefully-import-resumed.png' })

    const drafts = await Promise.all(
      ids.map((id) => apiRequest(page, `/api/v1/content-drafts/${id}`))
    )
    const assets = drafts.map((result) => (result.body as { assetIds: string[] }).assetIds[0])
    expect(assets.every(Boolean)).toBe(true)
    const combined = await apiRequest(page, '/api/v1/content-drafts', {
      method: 'POST',
      body: {
        title: 'Media review',
        plainText: 'Root\nTail',
        channelConnectionIds: [workspace.channels.x],
        assetIds: assets,
        body: [
          { type: 'p', children: [{ text: 'Root' }] },
          ...assets.map((assetId) => ({
            type: 'img',
            assetId,
            url: `/api/v1/assets/${assetId}/content`,
            children: [{ text: '' }],
          })),
          { type: 'post_break', children: [{ text: '' }] },
          { type: 'p', children: [{ text: 'Tail' }] },
        ],
      },
    })
    expect(combined.status, JSON.stringify(combined.body)).toBe(201)
    const id = (combined.body as { id: string }).id
    await app.open(`/write/${id}`)
    await expect(page.getByTestId('post-header')).toHaveCount(2)
    await app.open(`/write/${id}?panel=properties`)
    await page.getByRole('switch', { name: 'Skip Slack publish notice', exact: true }).click()
    await expect(
      page.getByRole('switch', { name: 'Skip Slack publish notice', exact: true })
    ).toBeChecked()
    await app.reload()
    await expect(
      page.getByRole('switch', { name: 'Skip Slack publish notice', exact: true })
    ).toBeChecked()
    await page.getByRole('button', { name: 'More draft actions' }).click()
    await page.getByRole('menuitem', { name: 'Manage media…' }).click()
    const media = page.getByTestId('draft-media-tools')
    await media
      .getByRole('button', { name: 'Drag media 1', exact: true })
      .dragTo(media.getByText('Post 1, media 2', { exact: true }))
    await expect(media.getByAltText('Media 1')).toHaveAttribute('src', new RegExp(assets[1]))
    await media.getByLabel('Media destination post').selectOption('1')
    await media.getByRole('button', { name: 'Move to post 2', exact: true }).first().click()
    await expect(media).toContainText('Post 2, media 2')
    await page.keyboard.press('Escape')
    await editorMore(page, 'Alt text')
    await page.getByRole('button', { name: 'Suggest with AI', exact: true }).first().click()
    await expect(page.getByLabel('Description of image 1')).not.toHaveValue('', {
      timeout: 60_000,
    })
    await page
      .getByLabel('Description of image 1')
      .fill('A small light square, reviewed by the author.')
    await page.getByRole('button', { name: 'Save descriptions', exact: true }).click()
    await page.route('**/api/v1/social-sets/*/mentions?*', (route) =>
      route.fulfill({
        json: {
          items: [
            { handle: 'first', kind: 'person', label: 'First person', providerId: '123' },
            { handle: 'second', kind: 'person', label: 'Second person', providerId: '456' },
          ],
        },
      })
    )
    await editorMore(page, 'Manage media')
    await page
      .getByTestId('media-manager')
      .getByRole('button', { name: 'Tag people', exact: true })
      .first()
      .click()
    await page.getByLabel('X username to tag').fill('first')
    await page.getByRole('button', { name: 'Find person', exact: true }).click()
    await page.getByRole('button', { name: 'Add First person @first', exact: true }).click()
    await page.getByRole('button', { name: 'Add Second person @second', exact: true }).click()
    await page.getByRole('button', { name: 'Save photo tags', exact: true }).click()
    await page.keyboard.press('Escape')
    await expectSaved(page)
    await app.reload()
    await editorMore(page, 'Alt text')
    await expect(page.getByLabel('Description of image 1')).toHaveValue(
      'A small light square, reviewed by the author.'
    )
    await page.keyboard.press('Escape')
    await editorMore(page, 'Manage media')
    await page
      .getByTestId('media-manager')
      .getByRole('button', { name: 'Tag people', exact: true })
      .first()
      .click()
    await expect(
      page.getByRole('button', { name: 'Remove First person', exact: true })
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Remove Second person', exact: true })
    ).toBeVisible()
    await page.getByRole('button', { name: 'Save photo tags', exact: true }).click()
    // eslint-disable-next-line no-restricted-syntax -- Sheets finish animating before the report screenshot.
    await page.waitForTimeout(300)
    await page.screenshot({ path: '.context/shots/typefully-media-persisted.png' })
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Share', exact: true }).click()
    await page.getByLabel('Public link', { exact: true }).click()
    const share = await page.getByLabel('Public link to share').inputValue()
    const guest = await page.context().browser()!.newContext()
    try {
      const view = await guest.newPage()
      await view.goto(share)
      const ogImage = await view.locator('meta[property="og:image"]').getAttribute('content')
      expect(ogImage).toMatch(/\/api\/drafts\/shared\/[^/]+\/image$/)
      const image = await guest.request.get(ogImage!)
      expect(image.status(), await image.text()).toBe(200)
      expect(image.headers()['content-type']).toBe('image/webp')
      expect((await image.body()).length).toBeGreaterThan(20)
      await page.getByLabel('Public link', { exact: true }).click()
      await expect(page.getByRole('switch', { name: 'Public link', exact: true })).not.toBeChecked()
      expect((await guest.request.get(ogImage!)).status()).toBe(404)
    } finally {
      await guest.close()
    }
    expect(errors).toEqual([])
  }
)

test(
  'published reading links show delivered snapshots and revoke access',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    const workspace = await startWorkspace({ channels: ['x', 'linkedin'] })
    const created = await apiRequest(page, '/api/v1/content-drafts', {
      method: 'POST',
      body: {
        title: 'Reading view',
        plainText: 'Delivered root\nDelivered reply\nUnsent reply',
        body: importedBody(['Delivered root', 'Delivered reply', 'Unsent reply']),
        channelConnectionIds: [workspace.channels.x],
      },
    })
    expect(created.status).toBe(201)
    const draft = created.body as { id: string; version: number }
    const scheduled = await apiRequest(page, `/api/v1/content-drafts/${draft.id}/schedule`, {
      method: 'POST',
      body: {
        version: draft.version,
        scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
        channelConnectionIds: [workspace.channels.x],
      },
    })
    expect(scheduled.status, JSON.stringify(scheduled.body)).toBe(201)
    await app.open(`/write/${draft.id}`)
    // The composer can append only once the live session has loaded the draft;
    // until then the reading link has no editor to go into.
    await expect(draftEditor(page)).toContainText('Unsent reply', { timeout: 60_000 })
    await page.getByRole('button', { name: 'Share', exact: true }).click()
    await page.getByLabel('Public link', { exact: true }).click()
    const link = await page.getByLabel('Public link to share').inputValue()
    await page.getByRole('button', { name: 'Add reading link to thread', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(draftEditor(page)).toContainText('Read the thread:')
    await expectSaved(page)
    // A confirmed receipt fixture verifies the public reading projection only;
    // no provider publication is represented as having been exercised here.
    await db.query(
      `UPDATE scheduled_post SET status='PUBLISHED',"remotePostId"='123',"publishedAt"=now(),"threadProgress"='{"posted":1,"total":2,"lastReplyId":"456"}' WHERE "contentDraftId"=$1`,
      [draft.id]
    )
    await page.goto(link)
    await expect(page.getByText('Published thread · reading view', { exact: true })).toBeVisible()
    await expect(page.getByText('Delivered reply', { exact: false }).first()).toBeVisible()
    await expect(page.getByText('Unsent reply', { exact: false })).toHaveCount(0)
    await app.reload()
    await expect(page.getByText('Delivered root', { exact: false }).first()).toBeVisible()
    await page.screenshot({ path: '.context/shots/typefully-published-reading.png' })
    await app.open(`/write/${draft.id}`)
    await page.getByRole('button', { name: 'Share', exact: true }).click()
    await page.getByLabel('Public link', { exact: true }).click()
    await expect(page.getByLabel('Public link to share')).toHaveCount(0)
    const response = await page.goto(link)
    expect(response?.status()).toBe(404)
  }
)

test(
  'external clients create retry-safe drafts and scoped agent comments appear in the composer',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    await startWorkspace({ channels: ['x', 'linkedin'] })
    const issued = await trpcMutation(page, 'apiKey.create', {
      name: 'Review assistant',
      scopes: ['artifact:read', 'draft:write', 'draft:comment', 'queue:write'],
    })
    expect(issued.status, JSON.stringify(issued.body)).toBe(200)
    const key = (issued.body as { apiKey: { id: string; key: string } }).apiKey
    await app.open('/write')
    const origin = new URL(page.url()).origin
    const api = new ShotsClient(origin, key.key)
    const sets = await api.sets()
    expect(sets.length).toBeGreaterThan(0)
    // Run the packaged Zapier action against the actual web/Go/database API.
    // Only the fixture transport maps the required HTTPS deployment URL to localhost.
    const zapier = createRequire(`${process.cwd()}/package.json`)(
      '../../integrations/zapier/client.js'
    ) as {
      createDraft: (
        z: {
          request: (options: {
            url: string
            method: string
            headers: Record<string, string>
            body?: unknown
          }) => Promise<unknown>
        },
        bundle: unknown
      ) => Promise<{ id: string }>
    }
    const z = {
      request: async (options: {
        url: string
        method: string
        headers: Record<string, string>
        body?: unknown
      }) => {
        const destination = new URL(options.url)
        expect(destination.origin).toBe('https://shots.example')
        const response = await fetch(origin + destination.pathname + destination.search, {
          method: options.method,
          headers: options.headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        })
        const json = (await response.json()) as unknown
        return {
          status: response.status,
          json,
          throwForStatus() {
            if (!response.ok) throw new Error(`Shots returned ${response.status}`)
          },
        }
      },
    }
    const zapInput = {
      authData: { origin: 'https://shots.example', apiKey: key.key },
      inputData: {
        requestId: crypto.randomUUID(),
        socialSetId: sets[0].id,
        text: 'From a source document.\n---\nNeeds human review.',
        title: 'Zapier source',
      },
    }
    const zapDraft = await zapier.createDraft(z, zapInput)
    expect((await zapier.createDraft(z, zapInput)).id).toBe(zapDraft.id)
    await app.open(`/write/${zapDraft.id}`)
    await expect(draftEditor(page)).toContainText('From a source document.')
    await expect(page.getByTestId('post-header')).toHaveCount(2)
    await app.reload()
    await expect(draftEditor(page)).toContainText('Needs human review.')
    expect(((await api.posts(zapDraft.id)) as { posts: unknown[] }).posts).toHaveLength(0)
    const setDetails = (await api.request(`/api/v1/social-sets/${sets[0].id}`)) as {
      version: number
    }
    const queueBody = {
      baseVersion: setDetails.version,
      timeZone: 'Europe/Paris',
      naturalPostingTimes: true,
      postingSlots: [{ weekday: 1, time: '09:15' }],
    }
    const queue = (await api.request(
      `/api/v1/social-sets/${sets[0].id}/queue`,
      'PATCH',
      queueBody
    )) as { timeZone: string }
    expect(queue.timeZone).toBe('Europe/Paris')
    await expect(
      api.request(`/api/v1/social-sets/${sets[0].id}/queue`, 'PATCH', queueBody)
    ).rejects.toThrow()
    await app.open(`/workspace/social-sets/${sets[0].id}/scheduling`)
    await expect(
      page.getByRole('switch', { name: 'Natural posting times for new drafts', exact: true })
    ).toBeChecked()
    await app.reload()
    await expect(
      page.getByRole('switch', { name: 'Natural posting times for new drafts', exact: true })
    ).toBeChecked()
    const input = {
      requestId: crypto.randomUUID(),
      socialSetId: sets[0].id,
      platforms: ['x'],
      text: 'Evidence matters.\n---\nHuman review remains required.',
      title: 'External review',
    }
    const created = await api.create(input)
    expect((await api.create(input)).id).toBe(created.id)
    expect((await api.list()).filter((item) => item.id === created.id)).toHaveLength(1)
    const copy = await api.duplicate(created.id)
    expect(copy.id).not.toBe(created.id)
    await api.delete(copy.id)
    await api.plan(created.id, new Date(Date.now() + 86400_000).toISOString(), 'UTC')
    const posts = (await api.posts(created.id)) as { posts: unknown[] }
    expect(posts.posts).toHaveLength(0)
    const current = await api.get(created.id)
    const body = current.body as { type: string; id?: string }[]
    const postId = body.find((node) => node.type === 'post_break')!.id!
    const action = {
      action: 'add',
      baseVersion: current.version,
      commentId: 'client-comment',
      text: 'Check the source.',
      anchor: { platform: 'x', postId, quote: 'Evidence matters.' },
    }
    const response = await fetch(`${origin}/api/v1/content-drafts/${created.id}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key.key },
      body: JSON.stringify(action),
    })
    expect(response.status, await response.clone().text()).toBe(200)
    const comment = (await response.json()) as { version: number }
    const replay = await fetch(`${origin}/api/v1/content-drafts/${created.id}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key.key },
      body: JSON.stringify(action),
    })
    expect(replay.status).toBe(409)
    await app.open(`/write/${created.id}?panel=comments`)
    await expect(page.getByTestId('comment-thread')).toContainText('Review assistant (API key)')
    await expect(page.getByTestId('comment-thread')).toContainText('Check the source.')
    await expect(page.getByTestId('orphaned-thread')).toHaveCount(0)
    await app.reload()
    await expect(page.getByTestId('comment-thread')).toContainText('Evidence matters.')
    await page.screenshot({ path: '.context/shots/typefully-agent-comments.png' })
    const resolve = await fetch(`${origin}/api/v1/content-drafts/${created.id}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key.key },
      body: JSON.stringify({
        action: 'resolve',
        baseVersion: comment.version,
        threadId: 'client-comment',
        resolved: true,
      }),
    })
    expect(resolve.status, await resolve.clone().text()).toBe(200)
    const filtered = (await api.request(
      `/api/v1/content-drafts/${created.id}/comments?status=resolved&platform=x`
    )) as { discussions: { threads: unknown[] } }
    expect(filtered.discussions.threads).toHaveLength(1)
    // A comment-capable key still cannot approve or schedule a content draft.
    for (const operation of ['review', 'schedule']) {
      const denied = await fetch(`${origin}/api/v1/content-drafts/${created.id}/${operation}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key.key },
        body: JSON.stringify({ action: 'approve' }),
      })
      expect(denied.status).toBe(403)
    }
    expect((await trpcMutation(page, 'apiKey.revoke', { keyId: key.id })).status).toBe(200)
    await expect(api.sets()).rejects.toThrow()
  }
)
