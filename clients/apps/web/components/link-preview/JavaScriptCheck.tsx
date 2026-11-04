'use client'

import { BracketsCurlyIcon as Braces } from '@phosphor-icons/react/dist/ssr/BracketsCurly'
import { CheckIcon as Check } from '@phosphor-icons/react/dist/ssr/Check'
import { SpinnerGapIcon as Loader2 } from '@phosphor-icons/react/dist/ssr/SpinnerGap'
import { useState } from 'react'
import { Pill } from '@/components/platform-ui'
import { Button } from '@/components/ui/button'
import type { LinkPreview, LinkPreviewRendered } from '@/lib/api/contracts/link-preview'
import { scriptChangeSchema, scriptDifferences } from '@/lib/link-preview/javascript'
import { cn } from '@/lib/utils'
import { PANEL } from './MetadataPanels'

const C = scriptChangeSchema.enum
const clip = (value?: string) => (value && value.length > 80 ? `${value.slice(0, 79)}…` : value)

/**
 * Compare the HTML crawlers read with the page after its JavaScript runs.
 * Facebook, X, LinkedIn, Slack, and the chat apps never run scripts, so a
 * tag that only JavaScript adds is invisible to them.
 */
export function JavaScriptCheck({ preview }: { preview: LinkPreview }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [rendered, setRendered] = useState<LinkPreviewRendered | null>(null)
  const likelyScripted = !preview.ogTitle && !preview.ogImage
  const changes = rendered ? scriptDifferences(preview, rendered) : []
  const hidden = changes.filter((change) => change.change === C.added)

  async function run() {
    setLoading(true)
    setError('')
    try {
      const response = await fetch(
        `/api/link-preview/rendered?${new URLSearchParams({ url: preview.url })}`
      )
      const body = await response.json().catch(() => null)
      if (!response.ok) throw new Error(body?.message ?? 'The page could not be rendered.')
      setRendered(body)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The page could not be rendered.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <section
      className={cn(PANEL, 'space-y-4 p-5', likelyScripted && !rendered && 'ring-amber-500/30')}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-ui-lg font-medium text-foreground">
            <Braces className="size-4" />
            JavaScript check
          </h3>
          <p className="text-xs text-muted-foreground">
            {likelyScripted && !rendered
              ? 'This page has no Open Graph tags in its HTML. If your app adds them with JavaScript, crawlers never see them. Check what a browser builds.'
              : 'Social crawlers read the HTML without running JavaScript. See whether any tag only appears after scripts run.'}
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={run} disabled={loading}>
          {loading && <Loader2 className="animate-spin" />}
          {rendered ? 'Run again' : 'Render the page'}
        </Button>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {rendered &&
        (changes.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-emerald-400">
            <Check className="size-4" />
            Every preview tag is already in the HTML crawlers read. JavaScript changes none of them.
          </p>
        ) : (
          <div className="space-y-3">
            {hidden.length > 0 && (
              <p className="text-sm text-red-300">
                {hidden.length} tag{hidden.length === 1 ? ' only appears' : 's only appear'} after
                JavaScript runs, so Facebook, X, LinkedIn, Slack, and chat apps never see{' '}
                {hidden.length === 1 ? 'it' : 'them'}. Render them on the server (SSR, static
                generation, or your framework&apos;s metadata API).
              </p>
            )}
            <ul className="divide-y divide-white/[0.07] text-sm">
              {changes.map((change) => (
                <li key={change.label} className="grid gap-1 py-2.5 sm:grid-cols-[8rem_7rem_1fr]">
                  <span className="text-muted-foreground">{change.label}</span>
                  <span>
                    <Pill
                      tone={
                        change.change === C.added
                          ? 'red'
                          : change.change === C.removed
                            ? 'yellow'
                            : 'blue'
                      }
                    >
                      {change.change === C.added
                        ? 'Only after JS'
                        : change.change === C.removed
                          ? 'Removed by JS'
                          : 'Changed by JS'}
                    </Pill>
                  </span>
                  <span className="min-w-0 break-words">
                    <span className="text-muted-foreground">Crawlers: </span>
                    {clip(change.before) ?? <span className="text-muted-foreground">nothing</span>}
                    <span className="text-muted-foreground"> · Browsers: </span>
                    {clip(change.after) ?? <span className="text-muted-foreground">nothing</span>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
    </section>
  )
}
