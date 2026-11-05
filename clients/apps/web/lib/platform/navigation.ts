import { z } from 'zod'
import { withoutLocale } from '@/lib/settings/appearance'

/** Stable jobs; document URLs remain owned by their existing editors. */
export const PLATFORM_DESTINATIONS = [
  { href: '/home', label: 'Home', key: 'home' },
  { href: '/create', label: 'Create', key: 'create' },
  { href: '/campaigns', label: 'Campaigns', key: 'campaigns' },
  { href: '/publish', label: 'Publish', key: 'publish' },
  { href: '/library', label: 'Library', key: 'library' },
  { href: '/workflows', label: 'Automate', key: 'automate' },
  { href: '/activity', label: 'Activity', key: 'activity' },
  { href: '/settings', label: 'Settings', key: 'settings' },
] as const

export type PlatformArea = (typeof PLATFORM_DESTINATIONS)[number]['key']

/** The App Store and Google Play studio, one name and route on every surface; projects open at `/create/store/<id>`. */
export const STORE_SCREENSHOTS = { href: '/create/store', label: 'Store screenshots' } as const

/** What the workspace's plan and rollout flags open, as the sidebar shows it. */
export const platformAccessSchema = z.object({
  campaignsEnabled: z.boolean(),
  /** Content drafts are rolled out (PLATFORM_CONTENT_DRAFTS); otherwise Publish opens link checks. */
  draftsEnabled: z.boolean(),
  /** The plan includes content drafts. */
  draftsPlan: z.boolean(),
  paidPlan: z.boolean(),
})
export type PlatformAccess = z.infer<typeof platformAccessSchema>

/** Areas that need a paid plan; a workspace without one sees them marked Pro. */
const PAID_AREAS: ReadonlySet<PlatformArea> = new Set([
  'create',
  'campaigns',
  'library',
  'automate',
  'activity',
])

/** Whether the plan leaves an area out: the sidebar marks it Pro and opens the plan page. */
export function areaLocked(
  key: PlatformArea,
  access: Pick<PlatformAccess, 'draftsEnabled' | 'draftsPlan' | 'paidPlan'>
): boolean {
  // Home, and Publish where it opens drafts, need content drafts.
  return key === 'home' || (key === 'publish' && access.draftsEnabled)
    ? !access.draftsPlan
    : !access.paidPlan && PAID_AREAS.has(key)
}

/** The task words people search with, so "draft" finds Publish and "screenshot" finds Create. */
const DESTINATION_ALIASES: Record<PlatformArea, string[]> = {
  home: ['dashboard', 'start'],
  create: ['screenshot', 'editor', 'canvas', 'visual', 'design', 'mockup', 'store', 'image'],
  campaigns: ['launch', 'release', 'brief'],
  publish: ['write', 'draft', 'post', 'schedule', 'calendar', 'thread', 'link check', 'brand'],
  library: ['project', 'asset', 'template', 'brand kit', 'media'],
  automate: ['workflow', 'automation', 'source', 'run'],
  activity: ['history', 'log', 'feed'],
  settings: ['billing', 'plan', 'member', 'team', 'account', 'integration', 'workspace'],
}

/** Whether a destination search matches an area by its label or a task word, either way round. */
export function matchesDestination(key: PlatformArea, label: string, query: string): boolean {
  const search = query.trim().toLowerCase()
  return (
    !search ||
    [label, ...DESTINATION_ALIASES[key]].some((term) => {
      const word = term.toLowerCase()
      return word.includes(search) || search.includes(word)
    })
  )
}

/** One page of an area, as a link. */
export type AreaLink = { href: string; label: string }

/** One row of Library categories: each kind of project, then reusable resources. */
export const LIBRARY_LINKS = [
  { href: '/library', label: 'Screenshots' },
  { href: '/library?type=canvas', label: 'Canvas' },
  { href: '/library?type=story', label: 'Story Sets' },
  { href: '/library?type=store', label: STORE_SCREENSHOTS.label },
  { href: '/library?type=code', label: 'Code' },
  { href: '/library?view=assets', label: 'Assets' },
  { href: '/library?view=brand', label: 'Brand assets' },
]
const CAMPAIGN_LINKS = [
  { href: '/campaigns', label: 'All campaigns' },
  { href: '/campaigns/releases', label: 'Release inbox' },
  { href: '/campaigns/deliveries', label: 'Deliveries' },
  { href: '/campaigns?status=ARCHIVED', label: 'Archived' },
]
export const AUTOMATE_LINKS = [
  { href: '/workflows', label: 'Workflows' },
  { href: '/workflows/runs', label: 'Runs' },
  { href: '/workflows/deployments', label: 'Deployments' },
  { href: '/workflows/connections', label: 'Signed-in capture' },
  { href: '/workflows?view=sources', label: 'Sources' },
]
export const CREATE_LINKS = [
  { href: '/create', label: 'New' },
  STORE_SCREENSHOTS,
  { href: '/create?view=recent', label: 'Recent' },
  { href: '/create?view=templates', label: 'Templates' },
  { href: '/create?view=tools', label: 'Tools' },
]

/** Campaigns' pages; Deliveries lists posts, so it needs content drafts (PLATFORM_CONTENT_DRAFTS). */
export function campaignLinks(draftsEnabled: boolean): AreaLink[] {
  return draftsEnabled
    ? CAMPAIGN_LINKS
    : CAMPAIGN_LINKS.filter((link) => link.href !== '/campaigns/deliveries')
}

/**
 * Each area's pages, for the sidebar and the page tabs. Publish's pages carry
 * the publishing brand and Campaigns' depend on drafts, so they come from
 * `publishLinks` and `campaignLinks` instead.
 */
export const AREA_LINKS: Partial<Record<PlatformArea, AreaLink[]>> = {
  automate: AUTOMATE_LINKS,
  create: CREATE_LINKS,
  library: LIBRARY_LINKS,
}

/**
 * The link among `items` a page (a pathname without its locale) is on: its
 * path and query match, a link without a query only wins when no more
 * specific sibling matches, and failing both, the link to this path.
 */
export function activeLink<T extends { href: string }>(
  items: readonly T[],
  pathname: string,
  params: URLSearchParams
): T | undefined {
  // A store project (`/create/store/<id>`) is a page of Store screenshots.
  const page = pathname.startsWith(`${STORE_SCREENSHOTS.href}/`) ? STORE_SCREENSHOTS.href : pathname
  const matches = (href: string) => {
    const [path, query] = href.split('?')
    return (
      page === path &&
      [...new URLSearchParams(query)].every(([key, value]) => params.get(key) === value)
    )
  }
  return (
    items.find((item) => item.href.includes('?') && matches(item.href)) ??
    items.find((item) => matches(item.href)) ??
    // A link that only carries context, like a publishing brand, still marks its page.
    items.find((item) => item.href.split('?')[0] === page)
  )
}

/** One Publish vocabulary for every page in the area; `scope` keeps the publishing brand. */
export function publishLinks(scope = '') {
  return [
    { href: `/publish${scope}`, label: 'Drafts' },
    { href: `/publish/calendar${scope}`, label: 'Calendar' },
    { href: `/publish/analyze${scope}`, label: 'Analyze' },
    { href: `/publish/link-checks${scope}`, label: 'Link checks' },
  ]
}

/** Without drafts, Publish still owns Link checks, so it opens there instead of disappearing. */
export function withPublishAccess<T extends { href: string; key: string }>(
  item: T,
  draftsEnabled: boolean
): T {
  return item.key === 'publish' && !draftsEnabled ? { ...item, href: '/publish/link-checks' } : item
}

const ROUTES: [PlatformArea, string[]][] = [
  ['home', ['/home']],
  [
    'create',
    [
      '/create',
      '/editor',
      '/canvas',
      '/creative-sets',
      '/store-screenshots',
      '/code',
      '/tweet',
      '/tools',
    ],
  ],
  ['campaigns', ['/campaigns', '/releases']],
  ['publish', ['/publish', '/drafts']],
  ['library', ['/library']],
  ['automate', ['/workflows']],
  ['activity', ['/activity']],
  ['settings', ['/settings']],
]

/** Match complete path segments, including localized legacy URLs. */
export function platformArea(pathname: string): PlatformArea | undefined {
  const path = withoutLocale(pathname.split(/[?#]/)[0]!)
  if (path === '/') return 'create'
  return ROUTES.find(([, routes]) =>
    routes.some((route) => path === route || path.startsWith(`${route}/`))
  )?.[0]
}

/** Carry the current locale through shell destinations without double prefixing. */
export function platformHref(pathname: string, href: string): string {
  const path = withoutLocale(pathname)
  const prefix = path === pathname ? '' : `/${pathname.split('/')[1]}`
  return withoutLocale(href) !== href ? href : `${prefix}${href}`
}

/** Only internal paths can be used as return destinations. */
export function safeReturnPath(value: string | null | undefined, fallback = '/home'): string {
  if (
    !value ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  )
    return fallback
  return value
}

/**
 * The paid capability an in-app path opens, named for the plan page, or null
 * when the path names none. Areas use their navigation label; the editors and
 * tools inside Create are named for themselves.
 */
export function paidCapability(from: string | null | undefined): string | null {
  const target = safeReturnPath(from, '')
  if (!target) return null
  const [path = '', query = ''] = target.split('?')
  const params = new URLSearchParams(query)
  if (path === '/' || path === '/editor')
    return params.get('editor') === 'app-store' ? 'Store screenshots' : 'The screenshot editor'
  const tools: [string, string][] = [
    ['/canvas', 'Canvas'],
    ['/creative-sets', 'Story Sets'],
    [STORE_SCREENSHOTS.href, STORE_SCREENSHOTS.label],
    ['/store-screenshots', 'Store screenshots'],
    ['/create/code', 'Code Studio'],
    ['/code', 'Code Studio'],
    ['/tweet', 'Post images'],
    ['/projects', 'Library'],
    ['/assets', 'Library'],
  ]
  const tool = tools.find(([route]) => path === route || path.startsWith(`${route}/`))
  if (tool) return tool[1]
  const area = platformArea(path)
  const destination = PLATFORM_DESTINATIONS.find((item) => item.key === area)
  // Home is where the app starts, not a capability; Settings is not on a plan.
  return destination && area !== 'home' && area !== 'settings'
    ? destination.label
    : needsSignInTool(path)
}

/** Image tools sit outside the areas; they share one name on the plan page. */
function needsSignInTool(path: string): string | null {
  return /^\/(tools|[a-z]+-to-[a-z]+|(compress|convert|resize|crop|rotate)-(image|video)|remove-background|mockup-generator)(\/|$)/.test(
    path
  )
    ? 'Image tools'
    : null
}
