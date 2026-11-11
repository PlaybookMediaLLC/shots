import { db, expect, test, trpcMutation, trpcQuery } from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

const empty = { version: 2, image: { src: null } }

test(
  'previews settle on first load and opening an empty project reuses a blank canvas',
  { tag: '@journey' },
  async ({ app, page }) => {
    const created = await trpcMutation(page, 'project.create', {
      name: 'Empty project',
      document: empty,
    })
    const projectId = (created.body as { id: string }).id
    for (const name of ['First preview', 'Second preview', 'Third preview']) {
      await trpcMutation(page, 'project.create', {
        name,
        document: { ...empty, image: { src: '/demo/notion-showcase.webp' } },
      })
    }
    await app.open('/projects')
    const card = page.getByRole('link', { name: 'Open Empty project', exact: true })
    // The empty preview's label, not the hover overlay that repeats the project's name.
    await expect(
      card.locator('..').getByRole('paragraph').filter({ hasText: 'Empty project' })
    ).toBeVisible()
    for (const name of ['First preview', 'Second preview', 'Third preview']) {
      await expect(page.getByRole('img', { name: `Preview of ${name}` })).toBeVisible({
        timeout: 60_000,
      })
    }
    await page.getByRole('button', { name: 'Actions for Empty project' }).click()
    await page.getByRole('menuitem', { name: 'Create Canvas copy' }).click()
    await expect(page).toHaveURL(/\/canvas\/c[a-z0-9]{24}$/, { timeout: 60_000 })
    const canvasId = new URL(page.url()).pathname.split('/').at(-1)!
    const saved = (await trpcQuery(page, 'canvas.get', { canvasId })).body as {
      document: { artboards: { document: { image: { src: string | null } } }[] }
    }
    expect(saved.document.artboards[0].document.image.src).toBeNull()
    await app.open('/projects')
    await page.getByRole('button', { name: 'Actions for Empty project' }).click()
    await page.getByRole('menuitem', { name: 'Create Canvas copy' }).click()
    await expect(page).toHaveURL(new RegExp(`/canvas/${canvasId}$`))
    const reopened = await Promise.all([
      trpcMutation(page, 'canvas.openProject', { projectId }),
      trpcMutation(page, 'canvas.openProject', { projectId }),
    ])
    expect(reopened.map((result) => (result.body as { id: string }).id)).toEqual([
      canvasId,
      canvasId,
    ])
    const canvases = (await trpcQuery(page, 'canvas.list', {})).body as { items: unknown[] }
    expect(canvases.items).toHaveLength(1)
    const race = await trpcMutation(page, 'project.create', {
      name: 'Simultaneous opens',
      document: empty,
    })
    const raceProject = (race.body as { id: string }).id
    const firstOpens = await Promise.all([
      trpcMutation(page, 'canvas.openProject', { projectId: raceProject }),
      trpcMutation(page, 'canvas.openProject', { projectId: raceProject }),
    ])
    expect(firstOpens.map((result) => result.status)).toEqual([200, 200])
    expect((firstOpens[0].body as { id: string }).id).toBe(
      (firstOpens[1].body as { id: string }).id
    )
  }
)

test('rename refreshes filters, duplicate names differ, and keyboard focus returns', async ({
  app,
  page,
}) => {
  await trpcMutation(page, 'project.create', { name: 'Pricing banner', document: empty })
  await app.open('/projects?search=pricing&sort=name')
  const search = page.getByRole('searchbox', { name: 'Search projects' })
  await expect(search).toHaveValue('pricing')
  await expect(page.getByRole('combobox', { name: 'Sort projects' })).toHaveText('Name')
  const actions = page.getByRole('button', { name: 'Actions for Pricing banner', exact: true })
  await actions.click()
  await page.keyboard.press('Escape')
  await expect(actions).toBeFocused()
  await actions.click()
  await page.getByRole('menuitem', { name: 'Rename…' }).click()
  await expect(page.getByLabel('Project name')).toHaveAttribute('maxlength', '200')
  // Exercise validation even when a script bypasses the browser's input limit.
  await page.getByLabel('Project name').evaluate((input) => input.removeAttribute('maxlength'))
  await page.getByLabel('Project name').fill('x'.repeat(201))
  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveText(
    'Use 200 characters or fewer.'
  )
  await expect(page.getByLabel('Project name')).toHaveValue('x'.repeat(201))
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(actions).toBeFocused()
  for (const name of ['Pricing banner copy', 'Pricing banner copy 2']) {
    await actions.click()
    await page.getByRole('menuitem', { name: 'Duplicate', exact: true }).click()
    await expect(page.getByRole('link', { name, exact: true })).toBeVisible()
  }
  await actions.click()
  await page.getByRole('menuitem', { name: 'Rename…' }).click()
  await page.getByLabel('Project name').fill('Launch banner')
  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  await expect(actions).toHaveCount(0)
  await expect(search).toBeFocused()
  const copy = page.getByRole('button', { name: 'Actions for Pricing banner copy', exact: true })
  await copy.click()
  await page.getByRole('menuitem', { name: 'Delete…' }).click()
  await expect(page.getByRole('alertdialog')).toContainText('Last edited')
  await page.getByRole('button', { name: 'Delete project', exact: true }).click()
  await expect(copy).toHaveCount(0)
  await expect(search).toBeFocused()
  await page.getByRole('link', { name: 'Pricing banner copy 2', exact: true }).click()
  await expect(page).toHaveURL(/[?]project=/)
  await page.goBack()
  await expect(search).toHaveValue('pricing')
  await expect(page.getByRole('combobox', { name: 'Sort projects' })).toHaveText('Name')
})

test('gateway errors retry automatically and persistent HTML failures have a useful message', async ({
  app,
  page,
}) => {
  let failures = 0
  let failing = true
  await page.route('**/api/trpc/**project.list**', async (route) => {
    if (failing) {
      failures++
      await route.fulfill({
        status: 503,
        contentType: 'text/html',
        body: '<!DOCTYPE html>Service unavailable',
      })
    } else await route.continue()
  })
  await app.open('/projects')
  const error = page.getByRole('alert').filter({ hasText: 'temporarily unavailable' })
  await expect(error).toBeVisible()
  expect(failures).toBe(3)
  await expect(page.getByText(/Unexpected token|not valid JSON/)).toHaveCount(0)
  failing = false
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(page.getByText('No projects yet')).toBeVisible()
  await expect(error).toHaveCount(0)

  // The reload control must work even when the root layout never hydrates.
  let blockedChunks = 0
  await page.route('**/_next/static/chunks/**', async (route) => {
    blockedChunks++
    await route.abort()
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('button', { name: 'Reload page', exact: true })).toBeVisible()
  expect(blockedChunks).toBeGreaterThan(0)
  await page.unroute('**/_next/static/chunks/**')
  await page.getByRole('button', { name: 'Reload page', exact: true }).click()
  await expect(page.getByText('No projects yet')).toBeVisible()
})

test('the story import picker reaches projects beyond the first hundred and searches across pages', async ({
  app,
  page,
  workspace,
}) => {
  await db.query(
    `UPDATE workspace_entitlement SET "featureOverrides" = $2::jsonb WHERE "organizationId" = $1`,
    [workspace.id, JSON.stringify({ 'creative-sets:create': true })]
  )
  await db.query(
    `INSERT INTO project (id, "organizationId", name, document, "documentVersion", "updatedAt")
    SELECT 'c' || substr(md5($1 || n::text), 1, 24), $1, 'Archive project ' || lpad(n::text, 3, '0'), $2::jsonb, 2, now() - n * interval '1 minute'
    FROM generate_series(1, 105) n`,
    [workspace.id, JSON.stringify(empty)]
  )
  await app.open('/creative-sets')
  await page.getByRole('button', { name: 'Copy from Projects', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Copy an existing project' })
  await expect(dialog.getByRole('button', { name: /^Archive project / })).toHaveCount(50)
  await dialog.getByRole('button', { name: 'Load more projects', exact: true }).click()
  await expect(dialog.getByRole('button', { name: /^Archive project / })).toHaveCount(100)
  await dialog.getByRole('button', { name: 'Load more projects', exact: true }).click()
  await expect(dialog.getByRole('button', { name: /^Archive project / })).toHaveCount(105)
  await expect(
    dialog.getByRole('button', { name: 'Archive project 105', exact: true })
  ).toBeVisible()
  await dialog.getByLabel('Search saved projects', { exact: true }).fill('105')
  await expect(dialog.getByRole('button', { name: /^Archive project / })).toHaveCount(1)
  await dialog.getByRole('button', { name: 'Archive project 105', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('This project needs a screenshot')
})
