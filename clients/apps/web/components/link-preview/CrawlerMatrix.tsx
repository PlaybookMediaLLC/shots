'use client'

import { SpinnerGapIcon as Loader2 } from '@phosphor-icons/react/dist/ssr/SpinnerGap'
import { ShieldWarningIcon as ShieldAlert } from '@phosphor-icons/react/dist/ssr/ShieldWarning'
import { useState } from 'react'
import { Pill, type PillTone } from '@/components/platform-ui'
import { Button } from '@/components/ui/button'
import { type CrawlerFetch, linkPreviewAgentSchema } from '@/lib/api/contracts/link-preview'
import { CRAWLERS } from '@/lib/link-preview/crawlers'
import { cn } from '@/lib/utils'
import { PANEL } from './MetadataPanels'
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table'

const BROWSER = linkPreviewAgentSchema.enum.default

const statusTone = (status?: number): PillTone =>
  !status ? 'red' : status >= 400 ? 'red' : status >= 300 ? 'yellow' : 'green'

/** How one crawler's copy of the page differs from what the browser-like bot got. */
function differences(result: CrawlerFetch, baseline?: CrawlerFetch): string[] {
  if (result.error) return [result.error]
  const notes: string[] = []
  if (result.challenge) notes.push(`${result.challenge} answered instead of the page`)
  if (!baseline || baseline.error) return notes
  if (result.status !== baseline.status)
    notes.push(`HTTP ${result.status}, the browser got ${baseline.status}`)
  if (result.finalUrl !== baseline.finalUrl) notes.push(`Ends at ${result.finalUrl}`)
  if (result.ogTitle !== baseline.ogTitle)
    notes.push(result.ogTitle ? 'Different og:title' : 'No og:title')
  if (result.ogImage !== baseline.ogImage)
    notes.push(result.ogImage ? 'Different og:image' : 'No og:image')
  if (result.title !== baseline.title && !result.challenge) notes.push('Different <title>')
  return notes
}

/**
 * Fetch the page as every platform crawler at once. Bot protection, CDN rules,
 * and server-side detection often answer one crawler differently, which shows
 * up here as a 403, a challenge page, or missing tags for just that platform.
 */
export function CrawlerMatrix({ url }: { url: string }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [results, setResults] = useState<CrawlerFetch[] | null>(null)
  const baseline = results?.find((result) => result.agent === BROWSER)
  const flagged = (results ?? []).filter((result) => differences(result, baseline).length > 0)

  async function run() {
    setLoading(true)
    setError('')
    try {
      const response = await fetch(`/api/link-preview/crawlers?${new URLSearchParams({ url })}`)
      const body = await response.json().catch(() => null)
      if (!response.ok) throw new Error(body?.message ?? 'The crawlers could not be compared.')
      setResults(body.results)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The crawlers could not be compared.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className={cn(PANEL, 'space-y-4 p-6')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-ui-lg font-medium text-foreground">
            <ShieldAlert className="size-4" />
            What each crawler gets
          </h3>
          <p className="text-xs text-muted-foreground">
            Request the page as all eight platform crawlers at once to catch bot protection, blocks,
            and pages served differently to one platform.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={run} disabled={loading}>
          {loading && <Loader2 className="animate-spin" />}
          {results ? 'Fetch again' : 'Fetch as every crawler'}
        </Button>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {results && (
        <>
          <p className={cn('text-sm', flagged.length ? 'text-amber-300' : 'text-emerald-400')}>
            {flagged.length
              ? `${flagged.length} of ${results.length} got a block, a challenge, or a different page.`
              : 'Every crawler got the same page, with the same tags.'}
          </p>
          {results.some((result) => result.challenge) && (
            <p className="text-xs text-muted-foreground">
              These requests come from our servers wearing each crawler&apos;s user agent. Bot
              protection that verifies real crawlers by IP address, as Cloudflare does for verified
              bots, may still let the platforms through. Allow these user agents in your firewall
              rules if their previews come up empty.
            </p>
          )}
          <div className="overflow-x-auto">
            <Table className="w-full text-left text-sm">
              <TableHeader className="text-xs text-muted-foreground">
                <TableRow className="border-b border-white/[0.07]">
                  <TableHead className="whitespace-normal py-2 pr-4 font-medium">Crawler</TableHead>
                  <TableHead className="whitespace-normal py-2 pr-4 font-medium">Status</TableHead>
                  <TableHead className="whitespace-normal py-2 pr-4 font-medium">Time</TableHead>
                  <TableHead className="whitespace-normal py-2 font-medium">What differs</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="divide-y divide-white/[0.07]">
                {results.map((result) => {
                  const notes = differences(result, baseline)
                  return (
                    <TableRow
                      key={result.agent}
                      className={cn('align-top', notes.length && 'bg-amber-500/[0.05]')}
                    >
                      <TableCell className="whitespace-normal py-2.5 pr-4">
                        {result.agent === BROWSER
                          ? 'Browser-like bot'
                          : CRAWLERS[result.agent].name}
                        <span className="block text-xs text-muted-foreground">
                          {result.agent === BROWSER ? 'baseline' : CRAWLERS[result.agent].token}
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-normal py-2.5 pr-4">
                        <Pill tone={statusTone(result.status)}>{result.status ?? 'Failed'}</Pill>
                      </TableCell>
                      <TableCell className="whitespace-normal py-2.5 pr-4 tabular-nums text-muted-foreground">
                        {(result.durationMs / 1000).toFixed(1)} s
                      </TableCell>
                      <TableCell className="whitespace-normal py-2.5">
                        {notes.length ? (
                          <ul className="space-y-0.5 text-amber-200">
                            {notes.map((note) => (
                              <li key={note}>{note}</li>
                            ))}
                          </ul>
                        ) : (
                          <span className="text-muted-foreground">Same as the browser</span>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </section>
  )
}
