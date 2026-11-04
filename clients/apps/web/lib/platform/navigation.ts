import { z } from 'zod'
import { withoutLocale } from '@/lib/settings/appearance'

/** Stable jobs; document URLs remain owned by their existing editors. */
export const PLATFORM_DESTINATIONS = [
  { href: '/home', label: 'Home', key: 'home' },
  { href: '/create', label: 'Create', key: 'create' },
  { href: '/campaigns', label: 'Campaigns', key: 'campaigns' },
  { href: '/write', label: 'Publish', key: 'publish' },
  { href: '/library', label: 'Library', key: 'library' },
  { href: '/workflows', label: 'Automate', key: 'automate' },
  { href: '/activity', label: 'Activity', key: 'activity' },
  { href: '/workspace', label: 'Settings', key: 'settings' },
] as const

export type PlatformArea = (typeof PLATFORM_DESTINATIONS)[number]['key']

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

/**
 * One Publish vocabulary for every page in the area; `scope` keeps the publishing brand.
 * Campaign deliveries only shows where campaigns can be used (a paid plan in the rollout).
 */
export function publishLinks(scope = '', returnTo = `/write${scope}`, campaigns = true) {
  return [
    { href: `/write${scope}`, label: 'Drafts' },
    { href: `/write/plan${scope}`, label: 'Calendar' },
    { href: `/write/analyze${scope}`, label: 'Analyze' },
    ...(campaigns ? [{ href: `/write/deliveries${scope}`, label: 'Campaign deliveries' }] : []),
    { href: `/link-preview?returnTo=${encodeURIComponent(returnTo)}`, label: 'Link checks' },
  ]
}

/** Without drafts, Publish still owns Link checks, so it opens there instead of disappearing. */
export function withPublishAccess<T extends { href: string; key: string }>(
  item: T,
  draftsEnabled: boolean
): T {
  return item.key === 'publish' && !draftsEnabled ? { ...item, href: '/link-preview' } : item
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
  ['publish', ['/write', '/drafts', '/link-preview']],
  ['library', ['/library', '/projects', '/assets']],
  ['automate', ['/workflows']],
  ['activity', ['/activity']],
  ['settings', ['/workspace']],
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
    ['/store-screenshots', 'Store screenshots'],
    ['/code', 'Code images'],
    ['/tweet', 'Post images'],
    ['/projects', 'Library'],
    ['/assets', 'Library'],
    ['/write/deliveries', 'Campaign deliveries'],
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
