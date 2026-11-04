import type { ComponentType, ReactNode } from 'react'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { cn } from '@/lib/utils'

/**
 * Page building blocks for the signed-in platform, after Polar's dashboard:
 * a page frame with a title and actions, titled sections, grouped rows with a
 * label on the left and a control on the right, status pills, and a roomy
 * empty state. Fork-owned so upstream editor files stay untouched.
 */

// full: 1120px of content inside the 40px gutters.
const PAGE_WIDTH = { md: 'max-w-3xl', sm: 'max-w-2xl', full: 'md:max-w-[1200px]' } as const

/**
 * A page with Polar's dashboard header: the title in medium 22px type on one
 * line, then any description at reading size. Pages span the full panel width.
 */
export function Page({
  actions,
  children,
  description,
  title,
  width = 'full',
}: {
  actions?: ReactNode
  children: ReactNode
  description?: ReactNode
  title: string
  width?: keyof typeof PAGE_WIDTH
}) {
  return (
    <main
      className={cn(
        'mx-auto flex w-full min-w-0 flex-col gap-6 px-4 pt-8 pb-[max(4rem,env(safe-area-inset-bottom))] md:px-10',
        PAGE_WIDTH[width]
      )}
    >
      <header className="flex min-w-0 flex-wrap items-end justify-between gap-x-8 gap-y-6">
        <div className="min-w-0">
          <h1 className="text-heading text-foreground [overflow-wrap:anywhere]">{title}</h1>
          {description ? (
            <p className="mt-2 max-w-2xl text-ui-lg font-normal text-pretty text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </header>
      {children}
    </main>
  )
}

export function Section({
  actions,
  children,
  description,
  id,
  title,
}: {
  actions?: ReactNode
  children: ReactNode
  description?: ReactNode
  id?: string
  title: string
}) {
  return (
    <section className="flex min-w-0 scroll-mt-8 flex-col gap-4" id={id}>
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center sm:gap-6">
        <div className="min-w-0">
          <h2 className="text-body text-foreground [overflow-wrap:anywhere]">{title}</h2>
          {description ? (
            <p className="mt-1 max-w-2xl text-caption leading-relaxed text-pretty text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex max-w-full flex-wrap items-center gap-2 sm:shrink-0">{actions}</div>
        ) : null}
      </div>
      {children}
    </section>
  )
}

/** Polar's settings group: a rounded card of rows separated by hairlines. */
export function Group({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        '@container/platform-group flex w-full min-w-0 flex-col divide-y divide-[var(--divider,var(--border))] overflow-hidden rounded-[14.4px] border border-border bg-[var(--platform-group,var(--card))]',
        className
      )}
    >
      {children}
    </div>
  )
}

/**
 * One row in a Group. `split` puts the control beside the label in roomy groups,
 * `inline` always does (for switches and buttons), `stacked` puts it below.
 */
export function Row({
  children,
  description,
  label,
  layout = 'split',
}: {
  children?: ReactNode
  description?: ReactNode
  label?: ReactNode
  layout?: 'inline' | 'split' | 'stacked'
}) {
  if (!label) return <div className="flex min-w-0 flex-col gap-3 px-4 py-3">{children}</div>
  return (
    <div
      className={cn(
        'flex min-w-0 gap-x-8 gap-y-3 px-4 py-3',
        layout === 'inline' && 'flex-row items-center justify-between',
        layout === 'split' &&
          'flex-col @min-[36rem]/platform-group:flex-row @min-[36rem]/platform-group:items-start @min-[36rem]/platform-group:justify-between',
        layout === 'stacked' && 'flex-col'
      )}
    >
      <div
        className={cn('min-w-0', layout === 'split' && '@min-[36rem]/platform-group:max-w-[50%]')}
      >
        <h3 className="text-ui-lg text-foreground [overflow-wrap:anywhere]">{label}</h3>
        {description ? (
          <p className="mt-1 text-ui leading-normal text-pretty text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {children ? (
        <div
          className={cn(
            'flex min-w-0 max-w-full flex-wrap items-center gap-2 [&>*]:min-w-0 [&>*]:max-w-full',
            layout === 'split' &&
              '@min-[36rem]/platform-group:w-1/2 @min-[36rem]/platform-group:shrink-0 @min-[36rem]/platform-group:justify-end',
            layout === 'inline' && 'shrink-0'
          )}
        >
          {children}
        </div>
      ) : null}
    </div>
  )
}

// Soft tints with the status colour as text; the shell sets --danger and --success.
const PILL_TONES = {
  blue: 'bg-blue-500/10 text-blue-700 dark:text-blue-300',
  gray: 'bg-foreground/[0.06] text-muted-foreground',
  green: 'bg-[var(--success,#047857)]/10 text-[var(--success,#047857)]',
  purple: 'bg-violet-500/10 text-violet-700 dark:text-violet-300',
  red: 'bg-[var(--danger,#b91c1c)]/10 text-[var(--danger,#b91c1c)]',
  yellow: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
} as const

export type PillTone = keyof typeof PILL_TONES

/** A status badge: 11/12px medium type on a soft tint, after a small dot. */
export function Pill({ children, tone = 'gray' }: { children: ReactNode; tone?: PillTone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-1 text-label whitespace-nowrap',
        PILL_TONES[tone]
      )}
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />
      {children}
    </span>
  )
}

export function EmptyState({
  action,
  description,
  icon: Icon,
  title,
}: {
  action?: ReactNode
  description: ReactNode
  icon: ComponentType<{ className?: string; size?: number }>
  title: string
}) {
  // Polar's empty state (ShadowBoxOnMd): a quiet panel one step below the page.
  return (
    <div className="flex min-h-[22rem] w-full flex-col items-center justify-center gap-6 rounded-xl border border-transparent bg-[var(--platform-group,var(--muted))] px-5 py-12 text-center md:p-8 lg:rounded-4xl dark:border-border">
      <Icon aria-hidden="true" className="text-muted-foreground/50" size={48} />
      <div className="flex max-w-md min-w-0 flex-col items-center gap-2">
        <h3 className="text-body font-medium text-foreground">{title}</h3>
        <p className="text-ui leading-relaxed text-pretty text-muted-foreground">{description}</p>
      </div>
      {action ? (
        <div className="flex max-w-full flex-wrap justify-center gap-2">{action}</div>
      ) : null}
    </div>
  )
}

/**
 * What the workspace's plan does not include, and the way to one that does,
 * in place of a control or list that cannot load. `from` is the page to
 * return to; the plan page names it.
 */
export function PlanRequired({ children, from }: { children: ReactNode; from: string }) {
  return (
    <Alert>
      <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
        <span>{children}</span>
        <ButtonLink href={`/upgrade?from=${encodeURIComponent(from)}`} size="sm">
          See plans
        </ButtonLink>
      </AlertDescription>
    </Alert>
  )
}
