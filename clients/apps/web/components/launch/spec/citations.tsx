'use client'

import { WarningIcon as Alert02Icon } from '@phosphor-icons/react/dist/ssr/Warning'
import { type ReactNode, useState } from 'react'
import { Group, Pill, type PillTone, Section } from '@/components/platform-ui'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { SpecSource } from '@/lib/launch/spec-schema'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

/** What citation chips resolve against: the brief and the spec version's sources. */
export type SourceIndex = { brief: string; byId: Map<string, SpecSource> }

const KIND: Record<SpecSource['kind'], string> = {
  brief: 'Brief',
  changelog: 'Changelog',
  docs: 'Docs',
  page: 'Page',
  product_page: 'Product page',
  pull_request: 'Pull request',
  release: 'Release',
}

const STATUS: Record<SpecSource['status'], { label: string; tone: PillTone }> = {
  blocked: { label: 'Blocked', tone: 'red' },
  empty: { label: 'Empty', tone: 'yellow' },
  failed: { label: 'Failed', tone: 'red' },
  ok: { label: 'Read', tone: 'green' },
}

const chipClass =
  'inline-flex h-5 shrink-0 items-center rounded-md px-1.5 font-mono text-[11px] leading-none font-medium ring-1 ring-inset'

/** A reference chip ([S1], [G2]) that opens a popover with what it points at. */
export function ChipPopover({
  children,
  className,
  label,
  name,
  tone = 'gray',
}: {
  children: ReactNode
  className?: string
  label: string
  /** The accessible name; it should contain the visible label. */
  name: string
  tone?: 'gray' | 'red'
}) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={name}
        className={cn(
          chipClass,
          'cursor-pointer align-[1px] transition-colors outline-none focus-visible:ring-foreground/50',
          tone === 'red'
            ? 'bg-red-500/10 text-red-700 dark:text-red-300 ring-red-500/25 hover:bg-red-500/20'
            : 'bg-foreground/[0.04] text-foreground/65 ring-foreground/[0.1] hover:bg-foreground/[0.08] hover:text-foreground',
          className
        )}
      >
        {label}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 space-y-2.5 rounded-xl border-foreground/[0.08] bg-secondary p-4 text-sm text-foreground/80"
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}

function Excerpt({ text }: { text: string }) {
  return (
    <p className="max-h-48 overflow-y-auto rounded-lg bg-black/30 px-3 py-2 text-xs leading-5 whitespace-pre-wrap text-foreground/65">
      {text}
    </p>
  )
}

/**
 * Why a fetched source was flagged. Flags read `reason: “snippet”`; only the
 * reason is shown, so injected text never lands on the page unasked.
 */
function FlagNote({ flags }: { flags: string[] }) {
  const reasons = [
    ...new Set(
      flags.map((flag) => {
        const reason = flag.split(/:\s*“/)[0]!.trim()
        return reason.charAt(0).toUpperCase() + reason.slice(1)
      })
    ),
  ]
  return (
    <div className="rounded-lg bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-700 dark:text-red-200 ring-1 ring-red-500/20 ring-inset">
      <p className="flex items-center gap-1.5 font-medium text-red-700 dark:text-red-300">
        <Alert02Icon aria-hidden size={14} />
        Possible prompt injection
      </p>
      <p className="mt-1 text-red-700/80 dark:text-red-200/80">
        This text reads like instructions to an AI. The draft was told to treat it as evidence only.
      </p>
      {reasons.length > 0 ? (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function SourceCard({ id, index }: { id: string; index: SourceIndex }) {
  if (id === 'brief') {
    // Listed with the sources only when an integration, not the team, wrote it.
    const integration = index.byId.get('brief')
    return (
      <>
        <p className="font-medium text-foreground">Release brief</p>
        <p className="text-xs text-muted-foreground">
          {integration
            ? 'Sent by an integration (a webhook or an API key), and answered open questions.'
            : 'What the team entered, and answered open questions.'}
        </p>
        {integration?.flagged ? <FlagNote flags={integration.flags} /> : null}
        {index.brief ? <Excerpt text={index.brief} /> : null}
      </>
    )
  }
  const source = index.byId.get(id)
  if (!source) return <p>{id} is not one of this version’s sources.</p>
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 font-medium break-words text-foreground">
          {source.title || source.url}
        </p>
        <Pill tone={STATUS[source.status].tone}>{STATUS[source.status].label}</Pill>
      </div>
      {source.url ? (
        <a
          className="block truncate text-xs text-foreground/65 hover:text-foreground hover:underline"
          href={source.url}
          rel="noopener noreferrer"
          target="_blank"
        >
          {source.url}
        </a>
      ) : null}
      {source.flagged ? <FlagNote flags={source.flags} /> : null}
      {source.excerpt ? <Excerpt text={source.excerpt} /> : null}
    </>
  )
}

/** The fetched text, rendered only when asked for (it may hold injected instructions). */
function ExcerptToggle({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="text-xs">
      <Button
        variant="custom"
        size={null}
        aria-expanded={open}
        className="inline-flex h-5 items-center text-muted-foreground hover:text-foreground/80"
        onClick={() => setOpen(!open)}
        type="button"
      >
        {open ? 'Hide excerpt' : 'Show excerpt'}
      </Button>
      {open ? (
        <div className="mt-1.5">
          <Excerpt text={text} />
        </div>
      ) : null}
    </div>
  )
}

/** Citation chips after a claim: [S1] [brief]. */
export function Citations({ index, refs }: { index: SourceIndex; refs: string[] }) {
  return (
    <span className="ml-1.5 inline-flex flex-wrap gap-1 align-middle">
      {refs.map((ref) => {
        const source = index.byId.get(ref)
        const suspect = ref !== 'brief' && (!source || source.flagged)
        return (
          <ChipPopover key={ref} label={ref} name={`Source ${ref}`} tone={suspect ? 'red' : 'gray'}>
            <SourceCard id={ref} index={index} />
          </ChipPopover>
        )
      })}
    </span>
  )
}

/** The sources a spec version was drafted from, with read status and injection flags. */
export function SourceList({
  cited,
  sources,
}: {
  cited: ReadonlySet<string>
  sources: SpecSource[]
}) {
  return (
    <Section
      description="What the claims cite. Fetched pages are evidence, never instructions."
      title="Sources"
    >
      <Group>
        <ul className="divide-y divide-foreground/[0.07]">
          <li className="flex gap-2.5 px-4 py-3.5">
            <span
              className={cn(
                chipClass,
                'bg-foreground/[0.04] text-foreground/65 ring-foreground/[0.1]'
              )}
            >
              brief
            </span>
            <div className="min-w-0">
              <p className="text-ui-lg font-medium text-foreground">Release brief</p>
              <p className="mt-0.5 text-xs text-muted-foreground">What the team entered</p>
            </div>
          </li>
          {sources.map((source) => (
            <li
              className={cn('flex gap-2.5 px-4 py-3.5', source.flagged && 'bg-red-500/[0.04]')}
              key={source.id}
            >
              <span
                className={cn(
                  chipClass,
                  source.flagged
                    ? 'bg-red-500/10 text-red-700 dark:text-red-300 ring-red-500/25'
                    : 'bg-foreground/[0.04] text-foreground/65 ring-foreground/[0.1]'
                )}
              >
                {source.id}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="min-w-0">
                  <p className="text-ui-lg font-medium break-words text-foreground">
                    {source.title || 'Untitled'}
                  </p>
                  {source.url ? (
                    <a
                      className="mt-0.5 block truncate text-xs text-muted-foreground hover:text-foreground hover:underline"
                      href={source.url}
                      rel="noopener noreferrer"
                      target="_blank"
                      title={source.url}
                    >
                      {source.url.replace(/^https?:\/\//, '')}
                    </a>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Pill tone={STATUS[source.status].tone}>{STATUS[source.status].label}</Pill>
                  {source.flagged ? <Pill tone="red">Flagged</Pill> : null}
                  <span className="text-xs text-muted-foreground">{KIND[source.kind]}</span>
                  {source.status === 'ok' && !cited.has(source.id) ? (
                    <span className="text-xs text-muted-foreground/75">· Not cited</span>
                  ) : null}
                </div>
                {source.status !== 'ok' && source.statusReason ? (
                  <p className="text-xs leading-5 text-muted-foreground">{source.statusReason}</p>
                ) : null}
                {source.flagged ? <FlagNote flags={source.flags} /> : null}
                {source.excerpt ? <ExcerptToggle text={source.excerpt} /> : null}
              </div>
            </li>
          ))}
        </ul>
      </Group>
    </Section>
  )
}
