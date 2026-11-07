import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  activeLink,
  AREA_LINKS,
  areaLocked,
  automateLinks,
  campaignLinks,
  matchesDestination,
  paidCapability,
  platformArea,
  publishLinks,
  platformHref,
  safeReturnPath,
  PLATFORM_DESTINATIONS,
  CREATE_LINKS,
  CREATE_TOOLS,
  LIBRARY_LINKS,
  STORE_SCREENSHOTS,
} from '@/lib/platform/navigation'
import { palettePages, searchPages, visitedPages } from '@/components/platform-shell/palette-pages'
import { SIGNED_IN_PATHS } from '@/lib/auth/sign-in-gate'
import { followsTheme, parseNavigation } from '@/lib/settings/appearance'
import {
  hasLinkNavigationGuards,
  prepareLinkNavigation,
  prepareWorkspaceSwitch,
  registerNavigationGuard,
} from '@/lib/platform/navigation-guard'
import { draftAssetNode, draftPostBody, supportedDraftMedia } from '@/lib/platform/asset-handoff'
import { draftAttachHref, readEditorReturn } from '@/lib/platform/editor-handoff'
import { serializeDraft } from '@/lib/content-drafts/serialize'

test('canonical editors, aliases and localized routes select the owning job', () => {
  for (const [path, area] of [
    ['/?project=abc', 'create'],
    ['/?editor=app-store', 'create'],
    ['/create/store', 'create'],
    ['/fr/create/store/abc', 'create'],
    ['/fr/canvas/abc', 'create'],
    ['/creative-sets/abc', 'create'],
    ['/library?type=store', 'library'],
    ['/campaigns/deliveries', 'campaigns'],
    ['/publish/calendar?set=abc', 'publish'],
    ['/de/drafts/abc', 'publish'],
    ['/publish/link-checks', 'publish'],
    ['/campaigns/a/copy#post-a', 'campaigns'],
    ['/releases/a', 'campaigns'],
    ['/workflows/runs/a', 'automate'],
    ['/fr/workflows/connections', 'automate'],
    ['/settings/brand-kit', 'settings'],
  ] as const)
    assert.equal(platformArea(path), area, path)
  for (const path of [
    '/campaigns-unrelated',
    '/review/token',
    '/s/token',
    '/api/render',
    '/sign-in',
  ])
    assert.equal(platformArea(path), undefined)
  assert.equal(PLATFORM_DESTINATIONS.length, 8)
})

test('locale and supported return context survive without external redirects', () => {
  assert.equal(platformHref('/fr', '/home'), '/fr/home')
  assert.equal(platformHref('/fr/canvas/a', '/publish?set=b#c'), '/fr/publish?set=b#c')
  assert.equal(platformHref('/fr/canvas/a', '/fr/library'), '/fr/library')
  assert.equal(platformHref('/canvas/a', '/home'), '/home')
  for (const unsafe of [
    undefined,
    '',
    'https://other.test',
    '//other.test',
    '/\\other.test',
    '/x\ny',
  ])
    assert.equal(safeReturnPath(unsafe), '/home')
  assert.equal(
    safeReturnPath('/fr/workflows/a?node=b#inspector'),
    '/fr/workflows/a?node=b#inspector'
  )
  assert.equal(safeReturnPath('/?project=keep'), '/?project=keep')
})

test('new navigation is labeled and every explicit old preference survives', () => {
  assert.equal(parseNavigation(undefined), 'expanded')
  assert.equal(parseNavigation('invalid'), 'expanded')
  for (const value of ['compact', 'expanded', 'dynamic'])
    assert.equal(parseNavigation(value), value)
})

test('workspace switching waits for saves and stops before any later action on failure', async () => {
  const events: string[] = []
  const removeFirst = registerNavigationGuard(async () => {
    await Promise.resolve()
    events.push('saved')
  })
  const removeFailure = registerNavigationGuard(() => {
    throw new Error('save failed')
  })
  const removeLast = registerNavigationGuard(() => {
    events.push('switch')
  })
  try {
    await assert.rejects(prepareWorkspaceSwitch(), /save failed/)
    assert.deepEqual(events, ['saved'])
    removeFailure()
    await prepareWorkspaceSwitch()
    assert.deepEqual(events, ['saved', 'saved', 'switch'])
  } finally {
    removeFirst()
    removeFailure()
    removeLast()
  }
  await prepareWorkspaceSwitch()
})

test('library attachment keeps immutable media identity through writing serialization', () => {
  const id = 'cm123456789012345678901234'
  const image = draftAssetNode({ id, mediaType: 'image/png' })
  assert.equal(image.url, `/api/v1/assets/${id}/content`)
  assert.equal(image.type, 'img')
  assert.equal(image.mimeType, 'image/png')
  assert.deepEqual(serializeDraft([image], 'linkedin').assetIds, [id])
  assert.equal(draftAssetNode({ id, mediaType: 'video/mp4' }).type, 'video')
  assert.equal(supportedDraftMedia('image/svg+xml'), false)
  assert.throws(() => draftAssetNode({ id, mediaType: 'application/pdf' }), /supported/)
  assert.throws(() => draftAssetNode({ id: '../../another-tenant', mediaType: 'image/png' }))
})

test('a post made from studio output carries its caption and its rendered image', () => {
  const id = 'cm123456789012345678901234'
  const body = draftPostBody({
    caption: 'Shipped the new editor',
    media: [{ alt: 'The editor with a gradient background', id, mediaType: 'image/png' }],
  })

  // One post: the break gives it the identity and settings the composer edits.
  assert.equal(body[0].type, 'post_break')
  const serialized = serializeDraft(body, 'x')
  assert.equal(serialized.posts.length, 1)
  assert.equal(serialized.posts[0].caption, 'Shipped the new editor')
  // The post references the stored asset, never a copy of its bytes, and
  // keeps the alt text and media type the studio already knew.
  assert.deepEqual(serialized.assetIds, [id])
  assert.equal(serialized.posts[0].media[0].alt, 'The editor with a gradient background')
  assert.equal(serialized.posts[0].media[0].mimeType, 'image/png')
  // An image with no words is a post; an empty one is the blocker the publish
  // dialog shows while its render is still running.
  const silent = serializeDraft(draftPostBody({ media: [{ id, mediaType: 'image/png' }] }), 'x')
  assert.equal(silent.posts.length, 1)
  assert.equal(silent.posts[0].images, 1)
  assert.deepEqual(serializeDraft(draftPostBody({ media: [] }), 'x').errors, [
    'Write something to post.',
  ])
})

test('an export returns only to a draft the return address actually names', () => {
  const draft = 'cm123456789012345678901234'
  assert.equal(readEditorReturn(`?fromDraft=${draft}`).draftId, draft)
  assert.equal(readEditorReturn('?fromDraft=').draftId, undefined)
  assert.equal(readEditorReturn('').draftId, undefined)
  // A hand-edited address cannot send the export somewhere else.
  for (const unsafe of ['../../other', 'https://other.test/publish/x', 'a b'])
    assert.equal(readEditorReturn(`?fromDraft=${encodeURIComponent(unsafe)}`).draftId, undefined)

  // The composer opens the returned export for review; the media type travels
  // with it so each destination's formats can be checked before scheduling.
  assert.equal(
    draftAttachHref(draft, 'cm999999999999999999999999', 'image/png'),
    `/publish/${draft}?attach=cm999999999999999999999999&attachType=image%2Fpng`
  )
  // Without a known type, only the asset travels.
  assert.equal(
    draftAttachHref(draft, 'cm999999999999999999999999'),
    `/publish/${draft}?attach=cm999999999999999999999999`
  )
})

test('shell links wait only for opted-in editor saves and retain failures', async () => {
  let saved = 0
  const remove = registerNavigationGuard(() => {
    saved++
  }, true)
  const removeSwitch = registerNavigationGuard(() => {
    throw new Error('workspace-only guard')
  })
  try {
    assert.equal(hasLinkNavigationGuards(), true)
    await prepareLinkNavigation()
    assert.equal(saved, 1)
    const removeFailure = registerNavigationGuard(() => {
      throw new Error('save offline')
    }, true)
    try {
      await assert.rejects(prepareLinkNavigation(), /save offline/)
    } finally {
      removeFailure()
    }
  } finally {
    remove()
    removeSwitch()
  }
  assert.equal(hasLinkNavigationGuards(), false)
})

test('workspace and editor routes follow appearance in every locale', () => {
  for (const path of [
    '/',
    '/fr',
    '/home',
    '/fr/library',
    '/canvas/design',
    '/workflows',
    ...SIGNED_IN_PATHS,
  ]) {
    assert.equal(followsTheme(path), true, path)
  }
  for (const path of ['/landing', '/fr/landing', '/pricing', '/guides', '/sign-in']) {
    assert.equal(followsTheme(path), false, path)
  }
})

test('the plan page names the paid capability a free workspace asked for', () => {
  assert.equal(paidCapability('/create'), 'Create')
  assert.equal(paidCapability('/create/code'), 'Code image')
  assert.equal(paidCapability('/create/code/cabc'), 'Code image')
  assert.equal(paidCapability('/library?view=assets'), 'Library')
  assert.equal(paidCapability('/assets'), 'Library')
  assert.equal(paidCapability('/activity'), 'Activity')
  assert.equal(paidCapability('/workflows/new'), 'Automate')
  assert.equal(paidCapability('/'), 'The screenshot editor')
  // New → Screenshot and Use template name the editor, so the plan page can send them back.
  assert.equal(
    paidCapability('/?start=new&template=template-violet-showcase'),
    'The screenshot editor'
  )
  assert.equal(paidCapability('/?editor=app-store'), 'Store screenshots')
  assert.equal(paidCapability('/create/store'), 'Store screenshots')
  assert.equal(paidCapability('/create/store/abc'), 'Store screenshots')
  assert.equal(paidCapability('/canvas/new'), 'Canvas')
  assert.equal(paidCapability('/compress-image'), 'Image tools')
  assert.equal(paidCapability('/campaigns/deliveries'), 'Campaigns')
  // There is no free plan: Publish is on Pro too (RFC 023, 2026-10-29).
  assert.equal(paidCapability('/publish'), 'Publish')
  // Home, Settings, and unsafe or missing destinations name nothing.
  for (const from of ['/home', '/settings', '//evil.test', 'https://evil.test', null])
    assert.equal(paidCapability(from), null, String(from))
})

test('destination search understands task words, not just area names', () => {
  const find = (query: string) =>
    PLATFORM_DESTINATIONS.filter((item) => matchesDestination(item.key, item.label, query)).map(
      (item) => item.key
    )
  assert.deepEqual(find('draft'), ['publish'])
  assert.deepEqual(find('drafts'), ['publish'])
  assert.deepEqual(find('Write'), ['publish'])
  assert.ok(find('screenshot').includes('create'))
  assert.deepEqual(find('billing'), ['settings'])
  assert.equal(find('').length, PLATFORM_DESTINATIONS.length)
  assert.deepEqual(find('zzz'), [])
})

test('the in-app plan page follows the theme like the rest of the app', () => {
  assert.equal(followsTheme('/upgrade'), true)
})

test('Campaigns lists Deliveries only where content drafts are rolled out', () => {
  assert.deepEqual(
    publishLinks('?set=a').map((item) => item.label),
    ['Posts', 'Calendar', 'Bulk tools', 'Analyze', 'Link checks']
  )
  assert.deepEqual(
    campaignLinks(true).map((item) => item.label),
    ['All campaigns', 'Release inbox', 'Deliveries', 'Archived']
  )
  assert.deepEqual(
    campaignLinks(false).map((item) => item.label),
    ['All campaigns', 'Release inbox', 'Archived']
  )
})

test('every sidebar item stays in its section, and each section opens its own first page', () => {
  const sections = PLATFORM_DESTINATIONS.flatMap((destination) => {
    const links =
      destination.key === 'publish'
        ? publishLinks()
        : destination.key === 'campaigns'
          ? campaignLinks(true)
          : AREA_LINKS[destination.key]
    return links ? [{ destination, links }] : []
  })
  assert.deepEqual(
    sections.map((section) => section.destination.key),
    ['create', 'campaigns', 'publish', 'library', 'automate']
  )
  for (const { destination, links } of sections) {
    // A sub-item never changes which section the sidebar highlights.
    for (const link of links)
      assert.equal(platformArea(link.href), destination.key, `${destination.label} › ${link.label}`)
    // The section opens its first page, which has its own name.
    assert.equal(links[0]!.href, destination.href, destination.label)
    assert.notEqual(links[0]!.label, destination.label, destination.label)
  }
})

test('the highlighted page matches the address, query views included', () => {
  const library = AREA_LINKS.library!
  const on = (path: string, query = '') =>
    activeLink(library, path, new URLSearchParams(query))?.label
  assert.equal(on('/library'), 'Screenshots')
  assert.equal(on('/library', 'type=canvas'), 'Canvas')
  assert.equal(on('/library', 'view=brand'), 'Brand assets')
  // An extra parameter, like a search, keeps the page it narrows.
  assert.equal(on('/library', 'type=story&search=launch'), 'Story Sets')
  assert.equal(on('/library', 'search=launch'), 'Screenshots')
  assert.equal(on('/create'), undefined)
  // Signed-in capture is its own page, not the Workflows list it nests under.
  assert.equal(
    activeLink(AREA_LINKS.automate ?? [], '/workflows/connections', new URLSearchParams())?.label,
    'Signed-in capture'
  )
})

test('Repositories is its own page, and signed-in capture setup is for owners and admins', () => {
  const on = (path: string) =>
    activeLink(AREA_LINKS.automate ?? [], path, new URLSearchParams())?.label
  // Automate opens an overview, and each page below it has its own address.
  assert.equal(on('/workflows/overview'), 'Overview')
  assert.equal(platformArea('/workflows/overview'), 'automate')
  const links = (AREA_LINKS.automate ?? []).map((link) => link.href)
  assert.equal(new Set(links).size, links.length)
  assert.equal(on('/workflows'), 'Workflows')
  assert.equal(on('/workflows/sources'), 'Repositories')
  assert.ok(automateLinks(true).some((link) => link.label === 'Signed-in capture'))
  assert.equal(
    automateLinks(false).some((link) => link.label === 'Signed-in capture'),
    false
  )
})

test('search finds what people mean to do in Automate, if they can do it', () => {
  const pages = (canManage: boolean) =>
    palettePages({ campaignsEnabled: true, canManage, draftsEnabled: true, sectionLabel: String })
  const labels = (query: string, canManage = true) =>
    searchPages(pages(canManage), query).map((page) => page.label)
  assert.ok(labels('workflow').includes('New workflow'))
  assert.ok(labels('github').includes('Watch a repository'))
  assert.deepEqual(labels('github', false), [])
  assert.deepEqual(labels('signed-in', false), [])
  assert.equal(matchesDestination('automate', 'Automate', 'github'), true)
})

test('the plan locks an area as the sidebar shows it, for the sidebar and the product tours', () => {
  const plan = (draftsEnabled: boolean, draftsPlan: boolean, paidPlan: boolean) => ({
    draftsEnabled,
    draftsPlan,
    paidPlan,
  })
  // Home needs content drafts in the plan, whatever the rollout.
  assert.equal(areaLocked('home', plan(true, false, true)), true)
  assert.equal(areaLocked('home', plan(false, true, false)), false)
  // Publish opens drafts when they are rolled out, so it needs them in the plan.
  assert.equal(areaLocked('publish', plan(true, true, false)), false)
  assert.equal(areaLocked('publish', plan(true, false, true)), true)
  // Without the rollout, Publish opens link checks, which every plan has.
  assert.equal(areaLocked('publish', plan(false, false, false)), false)
  // The paid areas need a paid plan; Settings never locks.
  for (const area of ['create', 'campaigns', 'library', 'automate', 'activity'] as const) {
    assert.equal(areaLocked(area, plan(true, true, false)), true, area)
    assert.equal(areaLocked(area, plan(true, true, true)), false, area)
  }
  assert.equal(areaLocked('settings', plan(false, false, false)), false)
})

test('Store screenshots has one name and route on every Create and Library surface', () => {
  assert.deepEqual(STORE_SCREENSHOTS, { href: '/create/store', label: 'Store screenshots' })
  assert.deepEqual(CREATE_LINKS.slice(0, 2), [{ href: '/create', label: 'New' }, STORE_SCREENSHOTS])
  assert.ok(LIBRARY_LINKS.some((link) => link.label === STORE_SCREENSHOTS.label))
  // Search lists the studio as a page of Create.
  const pages = palettePages({ campaignsEnabled: true, draftsEnabled: true, sectionLabel: String })
  assert.ok(
    searchPages(pages, 'store').some(
      (page) => page.href === STORE_SCREENSHOTS.href && page.section === 'create'
    )
  )
})

test('every tool has one name and a place in Library', () => {
  assert.deepEqual(
    CREATE_TOOLS.map((tool) => tool.label),
    ['Screenshot', 'Canvas', 'Story Set', 'Store screenshots', 'Code image']
  )
  for (const tool of CREATE_TOOLS) assert.ok(LIBRARY_LINKS.includes(tool.library), tool.label)
  // Library's first category keeps the area's own address.
  assert.equal(LIBRARY_LINKS[0]!.href, '/library')
})

test('search finds every page by name, with its section, and the pages visited before', () => {
  const pages = palettePages({
    campaignsEnabled: true,
    draftsEnabled: true,
    sectionLabel: (key) => PLATFORM_DESTINATIONS.find((item) => item.key === key)!.label,
  })
  const named = (query: string) =>
    searchPages(pages, query).map((page) => `${page.label} · ${page.section}`)
  assert.deepEqual(named('deliveries'), ['Deliveries · Campaigns'])
  assert.deepEqual(named('runs'), ['Runs · Automate'])
  assert.ok(named('billing').includes('Billing · Settings'))
  // Settings pages also answer to their keywords.
  assert.ok(named('timezone').includes('General · Settings'))
  assert.deepEqual(named(''), [])
  // Pages a workspace cannot open are not offered.
  const without = palettePages({
    campaignsEnabled: false,
    draftsEnabled: false,
    sectionLabel: String,
  })
  assert.equal(
    without.some((page) => page.section === 'campaigns'),
    false
  )
  assert.deepEqual(
    without.filter((page) => page.section === 'publish').map((page) => page.label),
    ['Link checks']
  )
  // Visits name their page once, newest first; drafts and other unnamed pages are skipped.
  assert.deepEqual(
    visitedPages(pages, [
      '/library?view=brand',
      '/publish/abc123def4',
      '/home',
      '/library?view=brand',
      '/settings/billing',
    ]).map((page) => page.label),
    ['Brand assets', 'Home', 'Billing']
  )
})

test('every Publish link keeps the profile it was opened from', () => {
  for (const link of publishLinks('?set=brand'))
    assert.ok(link.href.endsWith('?set=brand'), link.href)
})
