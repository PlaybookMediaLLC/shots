import { z } from 'zod'
import { needsSignIn } from '@/lib/auth/sign-in-gate'
import { routing } from '@/i18n/routing'
import { navigationLayoutSchema } from '@/lib/api/contracts/settings-platform'

/**
 * Appearance (RFC 024). The platform's pages follow a person's theme; the
 * marketing site keeps its dark design. Editor artwork has its own colors.
 */

/** Route prefixes whose pages follow the chosen theme. */
export const THEMED_ROUTE_PREFIXES = [
  '/home',
  '/editor',
  '/canvas',
  '/creative-sets',
  '/store-screenshots',
  '/code',
  '/tweet',
  '/tools',
  '/create',
  '/library',
  '/publish',
  '/workflows',
  '/activity',
  '/assets',
  '/campaigns',
  '/drafts',
  '/p',
  '/projects',
  '/releases',
  '/settings',
  '/upgrade',
] as const

/** The storage key next-themes keeps this browser's theme under. */
export const THEME_STORAGE_KEY = 'shots-theme'

/** A pathname without its locale prefix, such as `/fr/drafts` → `/drafts`. */
export function withoutLocale(pathname: string): string {
  const [, first, ...rest] = pathname.split('/')
  if (first && (routing.locales as readonly string[]).includes(first)) return `/${rest.join('/')}`
  return pathname
}

/** Whether the page at `pathname` follows the chosen theme. */
export function followsTheme(pathname: string): boolean {
  const path = withoutLocale(pathname)
  return (
    path === '/' ||
    needsSignIn(path) ||
    THEMED_ROUTE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
  )
}

/** The calendar week's first day as a JavaScript weekday (0 is Sunday). */
export const weekStartDaySchema = z
  .enum(['monday', 'sunday'])
  .transform((day) => (day === 'monday' ? 1 : 0))

/** The first day of the week holding `date`, at local midnight. */
export function startOfWeek(date: Date, weekStart: z.input<typeof weekStartDaySchema>): Date {
  const first = weekStartDaySchema.parse(weekStart)
  const start = new Date(date)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - ((start.getDay() - first + 7) % 7))
  return start
}

/** The cookie the shell reads to render the chosen navigation on first paint. */
export const NAVIGATION_COOKIE = 'shots-nav'

/** A navigation cookie's layout, or expanded for a new user. */
export function parseNavigation(value: string | undefined): z.infer<typeof navigationLayoutSchema> {
  return navigationLayoutSchema.catch('expanded').parse(value)
}

/** The width from which a dynamic navigation shows its labels. */
export const DYNAMIC_NAVIGATION_QUERY = '(min-width: 1280px)'

/** The cookie remembering which social set the drafts pages last showed. */
export const SOCIAL_SET_COOKIE = 'shots-social-set'
