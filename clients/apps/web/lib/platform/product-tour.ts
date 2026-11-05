import { z } from 'zod'
import { helpTipIdSchema } from '@/lib/api/contracts/settings-platform'
import { areaLocked, platformAccessSchema, type PlatformAccess } from '@/lib/platform/navigation'
import { withoutLocale } from '@/lib/settings/appearance'

/**
 * Product tours: one per feature, linked into one journey. To add one, mark
 * the elements with `data-tour-id` and add the tour to PRODUCT_TOURS;
 * docs/product-tours.md has the steps.
 */

/** In the help tip format, so `tour-<id>-v<version>` saves as a seen tour. */
const slugSchema = helpTipIdSchema.max(48)

/** The tab's tour in progress, so it survives the page changes that remount the shell. */
export const PRODUCT_TOUR_SESSION_KEY = 'shots:product-tour'
/** Tours finished or skipped in the tab while their save is in flight. */
export const PRODUCT_TOUR_RESOLVED_KEY = 'shots:product-tour:resolved'

/** One step: the element it points at and what it says. */
export const productTourStepSchema = z.object({
  id: slugSchema,
  /** The `data-tour-id` of the element the step points at. */
  anchor: slugSchema,
  title: z.string().min(1).max(60),
  description: z.string().min(1).max(240),
  /** The page the step is on, or a page under it; the tour opens it when the element is not on screen. */
  route: z.string().startsWith('/').optional(),
})
export type ProductTourStep = z.infer<typeof productTourStepSchema>

/** A tour for one feature. */
export const productTourSchema = z.object({
  id: slugSchema,
  title: z.string().min(1).max(60),
  /** One line for the Product tours menu. */
  summary: z.string().min(1).max(120),
  /** Raise it when the steps change enough that people should see the tour again. */
  version: z.number().int().positive(),
  /** Starts by itself the first time, until finished or skipped. */
  autoStart: z.boolean().optional(),
  /** Whether the workspace has the feature; the tour is not offered without it. */
  available: z.function({ input: [platformAccessSchema], output: z.boolean() }).optional(),
  /** The tour offered when this one ends, so the tours make one journey. */
  next: slugSchema.optional(),
  steps: z.array(productTourStepSchema).min(1).readonly(),
})
export type ProductTour = z.infer<typeof productTourSchema>

/** Every tour, in the order the Product tours menu lists them. */
export const PRODUCT_TOURS = [
  {
    id: 'workspace',
    title: 'Find your way around',
    summary: 'New, the main areas, search and settings.',
    version: 1,
    autoStart: true,
    next: 'publish',
    steps: [
      {
        id: 'new',
        anchor: 'new',
        title: 'Start anything from New',
        description: 'Create a post, a campaign, a screenshot or a design from any page.',
      },
      {
        id: 'home',
        anchor: 'nav-home',
        title: 'Home',
        description: 'Your starting point. Pick up recent work and see what needs you.',
      },
      {
        id: 'create',
        anchor: 'nav-create',
        title: 'Create',
        description: 'Start a screenshot, canvas or store image, pick up recent work, or begin from a template.',
      },
      {
        id: 'publish',
        anchor: 'nav-publish',
        title: 'Publish',
        description:
          'Write a draft once, adapt it for each network, then schedule or publish it. The calendar and analytics are here too.',
      },
      {
        id: 'library',
        anchor: 'nav-library',
        title: 'Library',
        description: 'Find your screenshots, canvases, Story Sets, assets and brand assets.',
      },
      {
        id: 'automate',
        anchor: 'nav-automate',
        title: 'Automate',
        description: 'Workflows that turn deployments and other sources into campaigns, with their runs.',
      },
      {
        id: 'search',
        anchor: 'search',
        title: 'Search and commands',
        description: 'Jump to any page, post or action. The shortcut is ⌘K, or Ctrl K on Windows.',
      },
      {
        id: 'settings',
        anchor: 'nav-settings',
        title: 'Settings',
        description:
          'Connect social accounts in Profiles, invite your team and manage your plan.',
      },
    ],
  },
  {
    id: 'publish',
    title: 'Publish your first post',
    summary: 'Profiles, drafts and the posting queue.',
    version: 1,
    // Publish opens drafts only where they are rolled out and in the plan.
    available: (access: PlatformAccess) => access.draftsEnabled && !areaLocked('publish', access),
    steps: [
      {
        id: 'brand',
        anchor: 'write-brand',
        route: '/publish',
        title: 'Choose a profile',
        description:
          'A profile is a set of social accounts. Drafts in it publish to those accounts. Settings opens its accounts and posting schedule.',
      },
      {
        id: 'new-draft',
        anchor: 'write-new-draft',
        route: '/publish',
        title: 'Start a draft',
        description:
          'Write the post once. You can adapt it for each network before you schedule it.',
      },
      {
        id: 'tabs',
        anchor: 'write-tabs',
        route: '/publish',
        title: 'Follow every post',
        description:
          'Drafts holds work in progress. Queue shows what is scheduled. Posted and Archived keep the history.',
      },
      {
        id: 'bulk',
        anchor: 'write-bulk',
        route: '/publish',
        title: 'Schedule many posts at once',
        description: 'Bulk tools plan a batch of separate posts in one pass.',
      },
    ],
  },
] as const satisfies readonly ProductTour[]

/** A registered tour's ID. */
export const productTourIdSchema = z.enum(PRODUCT_TOURS.map((tour) => tour.id))
export type ProductTourId = z.infer<typeof productTourIdSchema>

/** A tour the workspace has, with whether this person saw it. */
export const productTourEntrySchema = z.object({
  id: productTourIdSchema,
  tour: productTourSchema,
  seen: z.boolean(),
})
export type ProductTourEntry = z.infer<typeof productTourEntrySchema>

/** What features use to offer tours: the list for the menu, and a way to start one. */
export const productTourControllerSchema = z.object({
  /** The workspace's tours, in menu order. */
  tours: z.array(productTourEntrySchema),
  /**
   * Starts a tour from its first step, seen or not; it replaces a tour in
   * progress. Focus returns to `returnTo` when it ends, or else to what had focus.
   */
  start: z.function({
    input: [productTourIdSchema, z.custom<HTMLElement | null>().optional()],
    output: z.void(),
  }),
})
export type ProductTourController = z.infer<typeof productTourControllerSchema>

/** A tour in progress, kept for the tab so it survives page changes. */
export const productTourSessionSchema = z.object({
  tourId: productTourIdSchema,
  stepIndex: z.number().int().min(0),
})
export type ProductTourSession = z.infer<typeof productTourSessionSchema>

const TOURS_BY_ID = new Map<string, ProductTour>(PRODUCT_TOURS.map((tour) => [tour.id, tour]))

/** The tour with this ID; every ID comes from the registry, so there is always one. */
export function getProductTour(id: ProductTourId): ProductTour {
  const tour = TOURS_BY_ID.get(id)
  if (!tour) throw new Error(`Unknown product tour: ${id}`)
  return tour
}

/** Whether the workspace has the tour's feature. */
export function isTourAvailable(tour: ProductTour, access: PlatformAccess): boolean {
  return tour.available?.(access) ?? true
}

/** The help tip that records a finished or skipped tour, in the backend's tip format. */
export function tourTipId(tour: Pick<ProductTour, 'id' | 'version'>): string {
  return `tour-${tour.id}-v${tour.version}`
}

/** Whether someone finished or skipped the tour, here or on another device. */
export function isTourSeen(
  tour: ProductTour,
  dismissedTips: readonly string[],
  resolvedThisTab: readonly string[]
): boolean {
  const tip = tourTipId(tour)
  return dismissedTips.includes(tip) || resolvedThisTab.includes(tip)
}

/** Whether a tour starts by itself: it is available and never seen. */
export function shouldAutoStartTour(
  tour: ProductTour,
  access: PlatformAccess,
  dismissedTips: readonly string[],
  resolvedThisTab: readonly string[]
): boolean {
  return (
    Boolean(tour.autoStart) &&
    isTourAvailable(tour, access) &&
    !isTourSeen(tour, dismissedTips, resolvedThisTab)
  )
}

/** Reads a stored session; anything unknown or out of range is no session. */
export function parseTourSession(raw: string | null): ProductTourSession | null {
  if (!raw) return null
  try {
    const session = productTourSessionSchema.parse(JSON.parse(raw))
    return session.stepIndex < getProductTour(session.tourId).steps.length ? session : null
  } catch {
    return null
  }
}

/** The tips still waiting for their save: a saved tip leaves the tab's list. */
export function unsavedTips(
  resolvedThisTab: readonly string[],
  dismissedTips: readonly string[]
): string[] {
  return resolvedThisTab.filter((tip) => !dismissedTips.includes(tip))
}

/**
 * Whether a page path, with or without its locale prefix, is the step's route
 * or a page under it: `/publish` covers an open draft at `/publish/<id>`.
 */
export function isOnTourRoute(pathname: string, route: string | undefined): boolean {
  if (!route) return true
  const path = withoutLocale(pathname)
  return path === route || path.startsWith(`${route}/`)
}
