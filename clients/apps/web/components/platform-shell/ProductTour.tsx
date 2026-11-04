'use client'

import { usePathname, useRouter } from 'next/navigation'
import {
  createContext,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { usePreferences } from '@/components/settings/PreferencesProvider'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { type PlatformAccess, platformHref } from '@/lib/platform/navigation'
import { prepareLinkNavigation } from '@/lib/platform/navigation-guard'
import {
  getProductTour,
  isOnTourRoute,
  isTourAvailable,
  isTourSeen,
  parseTourSession,
  PRODUCT_TOUR_RESOLVED_KEY,
  PRODUCT_TOUR_SESSION_KEY,
  PRODUCT_TOURS,
  type ProductTourController,
  type ProductTourEntry,
  type ProductTourId,
  type ProductTourSession,
  type ProductTourStep,
  shouldAutoStartTour,
  tourTipId,
  unsavedTips,
} from '@/lib/platform/product-tour'
import { CheckIcon, CloseIcon, TourIcon } from './icons'

/** How long a step waits for its element, which can render after the page. */
const ANCHOR_WAIT_MS = 3_000
/** How often an open step checks its element, which can render late or be replaced. */
const ANCHOR_CHECK_MS = 250
/** A first visit settles before the tour starts by itself. */
const AUTO_START_DELAY_MS = 800

const ProductTourContext = createContext<ProductTourController>({ tours: [], start: () => {} })

/** The workspace's tours and a way to start one. */
export function useProductTour(): ProductTourController {
  return useContext(ProductTourContext)
}

function readTab(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key)
  } catch {
    return null
  }
}

function writeTab(key: string, value: string | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(key)
    else window.sessionStorage.setItem(key, value)
  } catch {
    // The provider keeps the same state in memory for the page.
  }
}

function readResolved(): string[] {
  try {
    return z.array(z.string()).parse(JSON.parse(readTab(PRODUCT_TOUR_RESOLVED_KEY) ?? '[]'))
  } catch {
    return []
  }
}

/** The first element on screen that a step points at. */
function findAnchor(id: string): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>(`[data-tour-id="${id}"]`)) {
    if (element.getClientRects().length > 0) return element
  }
  return null
}

/** Where the card sits when the step's element is not on screen. Stable, as Radix re-reads it each render. */
const CORNER = {
  getBoundingClientRect: () => new DOMRect(window.innerWidth - 16, window.innerHeight - 16, 0, 0),
}

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName))
  )
}

/** An arrow key meant for the tour: no modifier, and not already used by a control. */
function tourArrow(event: ReactKeyboardEvent): 'back' | 'next' | null {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
    return null
  if (event.key === 'ArrowRight') return 'next'
  if (event.key === 'ArrowLeft') return 'back'
  return null
}

/**
 * Runs the product tours for the signed-in shell, modeled on the Canvas web
 * tour: one step at a time, a card beside the element it explains, the
 * position kept for the tab so a step on another page survives the move, and
 * each tour offering the next one. The tours live in `lib/platform/product-tour.ts`.
 */
export function ProductTourProvider({
  access,
  autoStart,
  children,
}: {
  /** What the plan and flags open, so only the workspace's features get tours. */
  access: PlatformAccess
  /** Start an unseen tour by itself; off in the editor, where it would cover the work. */
  autoStart: boolean
  children: ReactNode
}) {
  const { preferences, save, status } = usePreferences()
  const pathname = usePathname()
  const router = useRouter()
  // Each page renders its own shell, so the tour resumes from the tab after a page change.
  const [session, setSessionState] = useState<ProductTourSession | null>(() =>
    typeof window === 'undefined' ? null : parseTourSession(readTab(PRODUCT_TOUR_SESSION_KEY))
  )
  // In state as well as the tab, so a finished tour stays seen while its save is in flight,
  // or when storage is blocked.
  const [resolved, setResolvedState] = useState<string[]>(() =>
    typeof window === 'undefined' ? [] : readResolved()
  )
  const [target, setTarget] = useState<{ key: string; element: HTMLElement | null } | null>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const nextButton = useRef<HTMLButtonElement | null>(null)
  // True while the tour itself opens a step's page.
  const leaving = useRef(false)
  // True when Finish or Skip closes the card, which then returns focus.
  const finishing = useRef(false)

  const setSession = useCallback((next: ProductTourSession | null) => {
    writeTab(PRODUCT_TOUR_SESSION_KEY, next ? JSON.stringify(next) : null)
    setSessionState(next)
  }, [])

  const setResolved = useCallback((tips: string[]) => {
    writeTab(PRODUCT_TOUR_RESOLVED_KEY, JSON.stringify(tips))
    setResolvedState(tips)
  }, [])

  const tour = session ? getProductTour(session.tourId) : null
  const step: ProductTourStep | undefined =
    session && tour ? tour.steps[session.stepIndex] : undefined
  const stepKey = session && step ? `${session.tourId}:${step.id}` : null
  const onRoute = step ? isOnTourRoute(pathname, step.route) : false
  const dismissedTips = preferences?.dismissedTips

  const tours = useMemo<ProductTourEntry[]>(
    () =>
      PRODUCT_TOURS.filter((candidate) => isTourAvailable(candidate, access)).map((candidate) => ({
        id: candidate.id,
        tour: candidate,
        seen: isTourSeen(candidate, dismissedTips ?? [], resolved),
      })),
    [access, dismissedTips, resolved]
  )
  // The tour that follows, when the workspace has it.
  const nextTour = tour?.next ? tours.find((entry) => entry.id === tour.next)?.id : undefined

  /**
   * Moves to a step. A step on another page opens that page, after the page's
   * own guards (such as saving a canvas); if a guard refuses, the tour stays put.
   */
  const go = useCallback(
    (next: ProductTourSession) => {
      const route = getProductTour(next.tourId).steps[next.stepIndex]?.route
      if (!route || isOnTourRoute(pathname, route)) {
        setSession(next)
        return
      }
      void prepareLinkNavigation()
        .then(() => {
          leaving.current = true
          setSession(next)
          router.push(platformHref(pathname, route))
        })
        .catch((error: unknown) => {
          toast.error(error instanceof Error ? error.message : 'Save your work before leaving.')
        })
    },
    [pathname, router, setSession]
  )

  // Leaving the step's page some other way ends the tour without marking it seen;
  // its button starts it again. The tour never pulls someone back.
  useEffect(() => {
    if (!step) return
    if (onRoute) leaving.current = false
    else if (!leaving.current) setSession(null)
  }, [onRoute, setSession, step])

  // Find the step's element, and find it again when the page replaces or hides
  // it (a collapsed sidebar, another brand). After the wait, the card explains
  // the step without it.
  useEffect(() => {
    if (!step || !stepKey || !onRoute) return
    const startedAt = Date.now()
    let reported: HTMLElement | null | undefined
    const check = () => {
      if (reported?.isConnected && reported.getClientRects().length > 0) return
      const found = findAnchor(step.anchor)
      if (found === reported) return
      if (found || Date.now() - startedAt >= ANCHOR_WAIT_MS) {
        reported = found
        setTarget({ key: stepKey, element: found })
      }
    }
    check()
    const timer = window.setInterval(check, ANCHOR_CHECK_MS)
    return () => window.clearInterval(timer)
  }, [onRoute, step, stepKey])

  // While the next step's element is found, the card stays beside the last one
  // instead of closing and opening again.
  const element =
    target && (target.key === stepKey || target.element?.isConnected) ? target.element : null
  const missing = target?.key === stepKey && !target.element

  // Outline the element and bring it into view.
  useEffect(() => {
    if (!element) return
    element.setAttribute('data-product-tour-active', 'true')
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    element.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'nearest' })
    return () => element.removeAttribute('data-product-tour-active')
  }, [element])

  // An unseen tour starts by itself once, where its first element shows: not
  // on a phone, whose navigation is closed, and not over an open dialog.
  useEffect(() => {
    if (!autoStart || session || status !== 'ready' || !preferences) return
    // A tip leaves the tab's list once saved, so "Reset help tips" brings the tour back here too.
    const waiting = unsavedTips(resolved, preferences.dismissedTips)
    if (waiting.length !== resolved.length) setResolved(waiting)
    const unseen = PRODUCT_TOURS.find((candidate) =>
      shouldAutoStartTour(candidate, access, preferences.dismissedTips, waiting)
    )
    const first: ProductTourStep | undefined = unseen?.steps[0]
    if (!unseen || !first || !isOnTourRoute(pathname, first.route)) return
    const timer = window.setTimeout(() => {
      if (
        findAnchor(first.anchor) &&
        !document.querySelector('[role="dialog"], [role="alertdialog"]')
      ) {
        setSession({ tourId: unseen.id, stepIndex: 0 })
      }
    }, AUTO_START_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [access, autoStart, pathname, preferences, resolved, session, setResolved, setSession, status])

  /** Ends the tour as seen; with `then`, starts the tour that follows. */
  const finish = useCallback(
    (then?: ProductTourId) => {
      if (!tour) return
      const tip = tourTipId(tour)
      setResolved([...new Set([...resolved, tip])])
      void save({ dismissTip: tip }).then((result) => {
        if (!result.ok) toast.error(`${result.error} The tour can start again on your next visit.`)
      })
      if (then) {
        go({ tourId: then, stepIndex: 0 })
        return
      }
      finishing.current = true
      setTarget(null)
      setSession(null)
    },
    [go, resolved, save, setResolved, setSession, tour]
  )

  const next = useCallback(() => {
    if (!session || !tour) return
    if (session.stepIndex >= tour.steps.length - 1) finish()
    else go({ ...session, stepIndex: session.stepIndex + 1 })
  }, [finish, go, session, tour])

  const back = useCallback(() => {
    if (session && session.stepIndex > 0) go({ ...session, stepIndex: session.stepIndex - 1 })
  }, [go, session])

  const start = useCallback(
    (tourId: ProductTourId, returnTo?: HTMLElement | null) => {
      returnFocus.current =
        returnTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
      go({ tourId, stepIndex: 0 })
    },
    [go]
  )

  const controller = useMemo(() => ({ tours, start }), [start, tours])
  const shown = session && tour && step && target ? { session, step, tour } : null
  const last = shown ? shown.session.stepIndex === shown.tour.steps.length - 1 : false
  return (
    <ProductTourContext value={controller}>
      {children}
      {shown ? (
        <Popover open modal={false}>
          <PopoverAnchor virtualRef={{ current: element ?? CORNER }} />
          <PopoverContent
            align={element ? 'start' : 'end'}
            aria-describedby="product-tour-description"
            aria-labelledby="product-tour-title"
            className="relative w-[min(22rem,calc(100vw-2rem))] rounded-xl p-4"
            collisionPadding={16}
            data-testid="product-tour-step"
            onCloseAutoFocus={(event) => {
              // Radix would refocus whatever had focus when the card opened. After
              // Finish or Skip, focus goes back to what started the tour, or to the
              // page; a tour that ends because someone left the page leaves focus alone.
              event.preventDefault()
              if (!finishing.current) return
              finishing.current = false
              const focus = returnFocus.current?.isConnected
                ? returnFocus.current
                : document.getElementById('platform-content')
              focus?.focus()
            }}
            // Escape typed in a field belongs to the field, not to the tour.
            onEscapeKeyDown={(event) => {
              if (!isEditable(event.target)) finish()
            }}
            // The page stays usable around the card; only Skip or Finish ends the tour.
            onInteractOutside={(event) => event.preventDefault()}
            // The arrow keys move the tour only while focus is in the card.
            onKeyDown={(event) => {
              const arrow = tourArrow(event)
              if (!arrow) return
              event.preventDefault()
              if (arrow === 'next') next()
              else back()
            }}
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              nextButton.current?.focus()
            }}
            side={element ? 'right' : 'top'}
            sideOffset={12}
          >
            <Button
              aria-label="Skip the tour"
              className="absolute end-2 top-2 size-8 text-muted-foreground hover:text-foreground"
              onClick={() => finish()}
              size="icon"
              type="button"
              variant="ghost"
            >
              <CloseIcon aria-hidden="true" className="size-4" />
            </Button>
            <p className="platform-eyebrow pe-8">Product tour · {shown.tour.title}</p>
            <div aria-live="polite">
              <h2 className="mt-1.5 text-base font-medium text-foreground" id="product-tour-title">
                {shown.step.title}
              </h2>
              <p className="mt-1.5 text-sm text-muted-foreground" id="product-tour-description">
                {shown.step.description}
              </p>
            </div>
            {missing ? (
              <p className="mt-3 rounded-lg border border-border bg-muted/50 p-2.5 text-xs text-muted-foreground">
                This part is not on screen here. It can need a wider window, a plan that includes
                it, or a role that can use it.
              </p>
            ) : null}
            {last && nextTour ? (
              <div className="mt-3 flex items-center gap-2 rounded-lg border border-border p-2.5">
                <p className="me-auto text-xs text-muted-foreground">
                  Next tour: {getProductTour(nextTour).title}
                </p>
                <Button onClick={() => finish(nextTour)} size="sm" type="button" variant="outline">
                  Start
                </Button>
              </div>
            ) : null}
            <div
              aria-hidden="true"
              className="mt-4 h-1 overflow-hidden rounded-full bg-foreground/[0.08]"
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] motion-reduce:transition-none"
                style={{
                  width: `${((shown.session.stepIndex + 1) / shown.tour.steps.length) * 100}%`,
                }}
              />
            </div>
            <div className="mt-3 flex items-center gap-2">
              <p className="me-auto text-xs text-muted-foreground tabular-nums">
                Step {shown.session.stepIndex + 1} of {shown.tour.steps.length}
              </p>
              <Button
                disabled={shown.session.stepIndex === 0}
                onClick={back}
                size="sm"
                type="button"
                variant="ghost"
              >
                Back
              </Button>
              <Button onClick={next} ref={nextButton} size="sm" type="button">
                {last ? 'Finish' : 'Next'}
              </Button>
            </div>
            <p className="sr-only">
              Use the Left and Right arrow keys to move between steps, or Escape to skip.
            </p>
          </PopoverContent>
        </Popover>
      ) : null}
    </ProductTourContext>
  )
}

/** Starts one tour from its feature, such as the Publish pane. */
export function ProductTourButton({ label, tourId }: { label: string; tourId: ProductTourId }) {
  const { start, tours } = useProductTour()
  if (!tours.some((entry) => entry.id === tourId)) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          className="touch-hitbox size-8 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => start(tourId)}
          size="icon"
          type="button"
          variant="ghost"
        >
          <TourIcon aria-hidden="true" className="size-[17px]" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

/** Every tour the workspace has, in one place: what each covers, which are seen, and Start. */
export function ProductTourMenu() {
  const { start, tours } = useProductTour()
  const [open, setOpen] = useState(false)
  // The menu closes when a tour starts; focus comes back to its button when the tour ends.
  const trigger = useRef<HTMLButtonElement | null>(null)
  // True when the menu closes because a tour started, whose card then has focus.
  const starting = useRef(false)
  if (tours.length === 0) return null
  const seen = tours.filter((entry) => entry.seen).length
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              aria-label="Product tours"
              className="touch-hitbox size-8 shrink-0 text-muted-foreground hover:text-foreground"
              ref={trigger}
              size="icon"
              type="button"
              variant="ghost"
            >
              <TourIcon aria-hidden="true" className="size-[17px]" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="right">Product tours</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        className="w-80 rounded-xl p-0"
        // After Start, focus stays in the tour card. Back on the menu button, it would open
        // the button's tooltip, which then takes Escape from the card.
        onCloseAutoFocus={(event) => {
          if (!starting.current) return
          starting.current = false
          event.preventDefault()
        }}
        side="right"
        sideOffset={12}
      >
        <div className="border-b border-border px-4 py-3">
          <p className="text-sm font-medium text-foreground">Product tours</p>
          <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
            {seen} of {tours.length} seen
          </p>
        </div>
        <ul className="grid gap-1 p-2">
          {tours.map(({ id, seen: done, tour }) => (
            <li className="flex items-center gap-3 rounded-lg p-2" key={id}>
              <span
                aria-hidden="true"
                className="grid size-6 shrink-0 place-items-center rounded-full border border-border text-muted-foreground"
              >
                {done ? <CheckIcon className="size-3.5" /> : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground">{tour.title}</span>
                <span className="block text-xs text-muted-foreground">
                  {tour.summary} {tour.steps.length} steps.
                </span>
              </span>
              <Button
                aria-label={`${done ? 'Replay' : 'Start'} ${tour.title}`}
                onClick={() => {
                  starting.current = true
                  setOpen(false)
                  start(id, trigger.current)
                }}
                size="sm"
                type="button"
                variant={done ? 'ghost' : 'outline'}
              >
                {done ? 'Replay' : 'Start'}
              </Button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
