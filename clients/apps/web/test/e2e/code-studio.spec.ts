import {
  browserJson,
  db,
  expect,
  getActiveOrganizationId,
  getE2EUrl,
  grantWorkspacePlan,
  signUpViaApi,
  test,
  trpcMutation,
  trpcQuery,
  type Page,
} from './framework'

// Code Studio (docs/code-studio.md): every test starts in its own Pro workspace.
test.use({ workspaceOptions: { plan: 'pro' } })
test.setTimeout(300_000)

const SNIPPET = 'export function greet(name: string) {\n  return `Hello, ${name}`\n}'

type CodeProject = {
  id: string
  kind: string
  name: string
  revision: number
  document: { slides: { panes: { files: { code: string; lang: string }[] }[] }[] }
}

/** A minimal stored code document, as the studio saves one. */
function codeDocument(code: string) {
  const file = { id: 'file-1', name: 'greet.ts', lang: 'typescript', code }
  return {
    version: 1,
    kind: 'code',
    style: { theme: 'midnight' },
    slides: [{ id: 'slide-1', panes: [{ id: 'pane-1', activeFile: 'file-1', files: [file] }] }],
  }
}

async function openStudio(page: Page, path: string) {
  // Cold development compilation can cancel a concurrent client navigation.
  await page.request.get(getE2EUrl(path), { timeout: 180_000 })
  await page.goto(path)
  await expect(page.getByRole('textbox', { name: 'Code editor' })).toBeVisible({ timeout: 60_000 })
}

test('a member saves a code project, reopens it from the Library and posts it with the code as alt text', async ({
  page,
}) => {
  await openStudio(page, '/create/code')
  await expect(page.getByText('Your code stays in this browser until you save it.')).toBeVisible()
  await page.getByRole('textbox', { name: 'Code editor' }).fill(SNIPPET)
  await page.getByRole('textbox', { name: 'Project name' }).fill('Greeting')
  await page.getByRole('button', { name: 'Save to workspace' }).click()
  await page.waitForURL(/\/create\/code\/c[a-z0-9]{24}$/, { timeout: 60_000 })
  const id = new URL(page.url()).pathname.split('/').pop()!
  await expect(page.getByTestId('code-save-status')).toHaveText('Saved to workspace', {
    timeout: 60_000,
  })

  const stored = (await trpcQuery(page, 'codeProject.get', { projectId: id })).body as CodeProject
  expect(stored).toMatchObject({ id, kind: 'code', name: 'Greeting' })
  expect(stored.document.slides[0]!.panes[0]!.files[0]!.code).toBe(SNIPPET)

  // A canvas or Story Set read never returns a code project.
  expect((await trpcQuery(page, 'canvas.get', { canvasId: id })).status).toBe(404)
  expect((await trpcQuery(page, 'creativeSet.get', { creativeSetId: id })).status).toBe(404)

  await page.goto('/library?type=code')
  await page.getByRole('link', { name: /Greeting/ }).click()
  await page.waitForURL(new RegExp(`/create/code/${id}$`))
  await expect(page.getByRole('textbox', { name: 'Code editor' })).toHaveValue(SNIPPET)

  await page.getByRole('button', { name: 'Post this' }).click()
  const dialog = page.getByRole('dialog', { name: 'Post this' })
  await dialog.getByRole('switch', { name: 'Add the code as a reply' }).click()
  await dialog.getByRole('button', { name: 'Create draft' }).click()
  await page.waitForURL(/\/write\/[^/?]+/, { timeout: 120_000 })
  const draftId = new URL(page.url()).pathname.split('/').pop()!

  const draft = (await browserJson(page, `/api/v1/content-drafts/${draftId}`)) as {
    assetIds?: string[]
    body?: { type?: string; children?: { children?: { text: string }[] }[] }[]
  }
  expect(draft.assetIds).toHaveLength(1)
  const reply = draft.body?.find((node) => node.type === 'code_block')
  expect(reply?.children?.map((line) => line.children?.[0]?.text)).toEqual(SNIPPET.split('\n'))
  const asset = await db.row<{ altText: string; mediaType: string }>(
    'SELECT "altText", "mediaType" FROM asset WHERE id = $1',
    [draft.assetIds![0]]
  )
  expect(asset).toMatchObject({ altText: `TypeScript code:\n${SNIPPET}`, mediaType: 'image/png' })
})

test('code projects stay in their workspace and refuse invalid documents', async ({
  browser,
  identity,
  page,
  workspace,
}) => {
  const id = `c${'1'.repeat(8)}${Date.now().toString(36).padStart(16, '0')}`.slice(0, 25)
  const document = codeDocument('const a = 1')
  const created = await trpcMutation(page, 'codeProject.create', { id, document, name: 'Mine' })
  expect(created.status).toBe(200)
  // A retried create with the same id and document returns the same project.
  const replay = await trpcMutation(page, 'codeProject.create', { id, document, name: 'Mine' })
  expect(replay.status).toBe(200)
  expect(
    await db.row<{ count: string }>(
      'SELECT count(*) FROM platform_creative_set WHERE "organizationId" = $1 AND kind = $2',
      [workspace.id, 'code']
    )
  ).toMatchObject({ count: '1' })

  const tooLong = await trpcMutation(page, 'codeProject.create', {
    id: `${id.slice(0, 24)}x`,
    document: codeDocument('x'.repeat(100_001)),
    name: 'Too long',
  })
  expect(tooLong.status).toBe(400)
  const badLink = await trpcMutation(page, 'codeProject.importLink', {
    url: 'https://gitlab.com/acme/api/-/blob/main/a.ts',
  })
  expect(badLink.status).toBe(400)

  const context = await browser.newContext()
  try {
    const stranger = await context.newPage()
    await signUpViaApi(
      {
        ...identity,
        email: `other-${identity.email}`,
        workspaceName: `Other ${identity.workspaceName}`,
      },
      stranger
    )
    await trpcMutation(stranger, 'workspace.create', {
      name: `Other ${identity.workspaceName}`,
      slug: `other-${identity.email.split('@')[0]}`,
    })
    await grantWorkspacePlan(await getActiveOrganizationId(stranger), 'pro')
    expect((await trpcQuery(stranger, 'codeProject.get', { projectId: id })).status).toBe(404)
    const write = await trpcMutation(stranger, 'codeProject.updateDocument', {
      projectId: id,
      baseRevision: 1,
      document,
    })
    expect(write.status).toBe(404)
    const list = (await trpcQuery(stranger, 'codeProject.list', {})).body as { items: unknown[] }
    expect(list.items).toHaveLength(0)
  } finally {
    await context.close()
  }
})
