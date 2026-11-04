'use client'

import { ArrowSquareOutIcon as ExternalLink } from '@phosphor-icons/react/dist/ssr/ArrowSquareOut'
import { LinkIcon as Link2 } from '@phosphor-icons/react/dist/ssr/Link'
import { SpinnerGapIcon as Loader2 } from '@phosphor-icons/react/dist/ssr/SpinnerGap'
import { useState } from 'react'
import { Pill } from '@/components/platform-ui'
import { Button } from '@/components/ui/button'
import {
  issueSeveritySchema,
  type LinkPreviewIssue,
  linkPreviewAgentSchema,
} from '@/lib/api/contracts/link-preview'
import { auditLinkPreview } from '@/lib/link-preview/audit'
import { MAX_GATED_LINKS } from '@/lib/link-preview/gate'
import { scoreLinkPreview } from '@/lib/link-preview/metadata'
import { linksInText } from '@/lib/link-preview/share'
import { requestPreview } from './client'
import { hostname } from './PlatformPreviews'

const { error: ERROR, warning: WARNING } = issueSeveritySchema.enum

type Result = { error: string } | { issues: LinkPreviewIssue[]; score: number }

/**
 * The links in a campaign post, checked the way the publishing gate checks
 * them, so a broken preview shows up during review instead of at scheduling.
 */
export function PostLinkCheck({ text }: { text: string }) {
  const links = linksInText(text).slice(0, MAX_GATED_LINKS)
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<Record<string, Result>>({})
  if (!links.length) return null

  async function check() {
    setLoading(true)
    const entries = await Promise.all(
      links.map(async (url): Promise<[string, Result]> => {
        try {
          const preview = await requestPreview(url, linkPreviewAgentSchema.enum.default)
          return [
            url,
            { issues: auditLinkPreview(preview), score: scoreLinkPreview(preview).score },
          ]
        } catch (caught) {
          return [url, { error: caught instanceof Error ? caught.message : 'Could not be read.' }]
        }
      })
    )
    setResults(Object.fromEntries(entries))
    setLoading(false)
  }

  const checked = Object.keys(results).length > 0
  const blocking = links.filter((url) => {
    const result = results[url]
    return result && ('error' in result || result.issues.some((issue) => issue.severity === ERROR))
  })

  return (
    <div className="flex flex-col gap-2 rounded-xl bg-white/[0.02] px-4 py-3 ring-1 ring-white/[0.06]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-medium text-neutral-500">
          <Link2 className="size-3.5" />
          {links.length === 1 ? 'Link preview' : `${links.length} link previews`}
          {checked && (
            <span className={blocking.length ? 'text-red-300' : 'text-emerald-400'}>
              · {blocking.length ? 'scheduling will be blocked' : 'ready to publish'}
            </span>
          )}
        </p>
        <Button type="button" variant="ghost" size="sm" onClick={check} disabled={loading}>
          {loading && <Loader2 className="animate-spin" />}
          {checked ? 'Check again' : 'Check links'}
        </Button>
      </div>
      {checked && (
        <ul className="flex flex-col gap-1.5 text-sm">
          {links.map((url) => {
            const result = results[url]
            if (!result) return null
            const errors =
              'issues' in result ? result.issues.filter((issue) => issue.severity === ERROR) : []
            const warnings =
              'issues' in result
                ? result.issues.filter((issue) => issue.severity === WARNING).length
                : 0
            return (
              <li key={url} className="flex flex-wrap items-center gap-2">
                <a
                  href={`/publish/link-checks?${new URLSearchParams({ url })}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-w-0 items-center gap-1 text-neutral-200 hover:underline"
                >
                  <span className="truncate">
                    {hostname(url)}
                    {new URL(url).pathname === '/' ? '' : new URL(url).pathname}
                  </span>
                  <ExternalLink className="size-3 shrink-0 text-neutral-500" />
                </a>
                {'error' in result ? (
                  <span className="text-red-300">{result.error}</span>
                ) : (
                  <>
                    <Pill
                      tone={result.score >= 80 ? 'green' : result.score >= 50 ? 'yellow' : 'red'}
                    >
                      {result.score}
                    </Pill>
                    {errors.length > 0 ? (
                      <span className="text-red-300">
                        {errors.map((issue) => issue.title).join('; ')}
                      </span>
                    ) : (
                      <span className="text-neutral-500">
                        No errors
                        {warnings ? ` · ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}
                      </span>
                    )}
                  </>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
