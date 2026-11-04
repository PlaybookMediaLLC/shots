'use client'

import { CaretRightIcon } from '@phosphor-icons/react/dist/ssr/CaretRight'
import { Collapsible } from 'radix-ui'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * A section that opens and closes on its own, as `<details>` did: a
 * full-width trigger row, then content that animates its height. For
 * several items that share state, use Accordion.
 */
function Disclosure({ ...props }: ComponentProps<typeof Collapsible.Root>) {
  return <Collapsible.Root data-slot="disclosure" {...props} />
}

/** The row that opens a Disclosure: a caret that turns, the title, and an optional summary on the right. */
function DisclosureTrigger({
  children,
  className,
  summary,
  ...props
}: ComponentProps<typeof Collapsible.Trigger> & {
  /** A short state at the row's end, such as "3 of 8 on". */
  summary?: ReactNode
}) {
  return (
    <Collapsible.Trigger
      className={cn(
        'group/disclosure flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        className
      )}
      data-slot="disclosure-trigger"
      {...props}
    >
      <CaretRightIcon
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]/disclosure:rotate-90 motion-reduce:transition-none"
      />
      <span className="min-w-0 flex-1">{children}</span>
      {summary ? (
        <span className="shrink-0 text-xs font-normal normal-case text-muted-foreground">{summary}</span>
      ) : null}
    </Collapsible.Trigger>
  )
}

/**
 * What a Disclosure shows when open. It stays mounted, as `<details>` content
 * did, so its state survives closing; closed, it is collapsed and invisible to
 * pointer, keyboard and screen reader alike. `className` styles the inner box,
 * so padding does not jump while the height animates.
 */
function DisclosureContent({
  children,
  className,
  ...props
}: ComponentProps<typeof Collapsible.Content>) {
  return (
    <Collapsible.Content
      className="grid transition-[grid-template-rows,visibility] duration-200 ease-out data-[state=closed]:invisible data-[state=closed]:grid-rows-[0fr] data-[state=open]:grid-rows-[1fr] motion-reduce:transition-none"
      data-slot="disclosure-content"
      forceMount
      {...props}
    >
      <div className="min-h-0 overflow-hidden">
        <div className={className}>{children}</div>
      </div>
    </Collapsible.Content>
  )
}

export { Disclosure, DisclosureContent, DisclosureTrigger }
