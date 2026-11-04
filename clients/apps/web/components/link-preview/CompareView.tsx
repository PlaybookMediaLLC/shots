'use client'

import { ArrowsLeftRightIcon as ArrowLeftRight } from '@phosphor-icons/react/dist/ssr/ArrowsLeftRight'
import { SpinnerGapIcon as Loader2 } from '@phosphor-icons/react/dist/ssr/SpinnerGap'
import { useState } from 'react'
import { Pill } from '@/components/platform-ui'
import { Button } from '@/components/ui/button'
import type { LinkPreview, LinkPreviewAgent } from '@/lib/api/contracts/link-preview'
import { auditLinkPreview, issueSeveritySchema } from '@/lib/link-preview/audit'
import { scoreLinkPreview } from '@/lib/link-preview/metadata'
import { cn } from '@/lib/utils'
import { normalizeUrl, requestPreview } from './client'
import { PANEL } from './MetadataPanels'
import { hostname, PLATFORMS, PlatformPreview } from './PlatformPreviews'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table'

const { error: ERROR, warning: WARNING } = issueSeveritySchema.enum

type Side = { error: string } | { preview: LinkPreview } | null

const imageSize = (preview: LinkPreview) => {
  const image = preview.images?.find((entry) => entry.url === preview.ogImage)
  return image?.width && image.height ? `${image.width} × ${image.height}` : undefined
}

/** The fields compared, in the order a reviewer reads them. */
const ROWS: Array<{ label: string; read: (preview: LinkPreview) => string | undefined }> = [
  { label: 'Title', read: (preview) => preview.title },
  { label: 'Description', read: (preview) => preview.description },
  { label: 'Canonical', read: (preview) => preview.canonical },
  { label: 'og:title', read: (preview) => preview.ogTitle },
  { label: 'og:description', read: (preview) => preview.ogDescription },
  { label: 'og:image', read: (preview) => preview.ogImage },
  { label: 'og:image size', read: imageSize },
  { label: 'og:type', read: (preview) => preview.ogType },
  { label: 'og:url', read: (preview) => preview.ogUrl },
  { label: 'og:site_name', read: (preview) => preview.ogSiteName },
  { label: 'twitter:card', read: (preview) => preview.twitterCard },
  { label: 'twitter:image', read: (preview) => preview.twitterImage },
  { label: 'Robots', read: (preview) => preview.robots },
  { label: 'X-Robots-Tag', read: (preview) => preview.response?.xRobotsTag },
  { label: 'Theme color', read: (preview) => preview.themeColor },
  { label: 'Structured data', read: (preview) => preview.jsonLd.join(', ') || undefined },
  {
    label: 'Blocked crawlers',
    read: (preview) =>
      preview.crawlers
        ?.filter((access) => !access.allowed)
        .map((access) => access.crawler)
        .join(', ') || undefined,
  },
  {
    label: 'Response time',
    read: (preview) =>
      preview.response ? `${(preview.response.durationMs / 1000).toFixed(2)} s` : undefined,
  },
  {
    label: 'Redirects',
    read: (preview) => (preview.response ? String(preview.response.hops.length - 1) : undefined),
  },
]

function Summary({ side, url }: { side: Side; url: string }) {
  if (!side) return null
  if ('error' in side) return <p className="text-sm text-red-400">{side.error}</p>
  const issues = auditLinkPreview(side.preview)
  const { score } = scoreLinkPreview(side.preview)
  return (
    <div className="flex items-center gap-3">
      <span
        className={cn(
          'text-2xl font-semibold tabular-nums',
          score >= 80 ? 'text-emerald-400' : score >= 50 ? 'text-amber-400' : 'text-red-400'
        )}
      >
        {score}
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm text-foreground">{hostname(url)}</p>
        <div className="mt-1 flex gap-1.5">
          <Pill tone="red">{issues.filter((issue) => issue.severity === ERROR).length} error{issues.filter((issue) => issue.severity === ERROR).length === 1 ? '' : 's'}</Pill>
          <Pill tone="yellow">
            {issues.filter((issue) => issue.severity === WARNING).length} warning{issues.filter((issue) => issue.severity === WARNING).length === 1 ? '' : 's'}
          </Pill>
        </div>
      </div>
    </div>
  )
}

/** Two links side by side: staging against production, before against after, or you against a competitor. */
export function CompareView({ agent, initialUrl = '' }: { agent: LinkPreviewAgent; initialUrl?: string }) {
  const [inputs, setInputs] = useState([initialUrl, ''])
  const [urls, setUrls] = useState(['', ''])
  const [sides, setSides] = useState<Side[]>([null, null])
  const [checkedAgent, setCheckedAgent] = useState(agent)
  const [loading, setLoading] = useState(false)
  const [platform, setPlatform] = useState(PLATFORMS[3]!)
  const [onlyDifferences, setOnlyDifferences] = useState(false)

  async function compare() {
    const targets = inputs.map(normalizeUrl)
    if (targets.some((target) => !target)) {
      setSides(targets.map((target) => (target ? null : { error: 'Enter a valid URL.' })))
      return
    }
    setCheckedAgent(agent)
    setLoading(true)
    setUrls(targets as string[])
    const results = await Promise.allSettled(
      targets.map((target) => requestPreview(target!, agent))
    )
    setSides(
      results.map((result) =>
        result.status === 'fulfilled'
          ? { preview: result.value }
          : { error: result.reason instanceof Error ? result.reason.message : 'Could not be read.' }
      )
    )
    setLoading(false)
  }

  const previews = sides.map((side) => (side && 'preview' in side ? side.preview : null))
  const both = previews[0] && previews[1] ? (previews as [LinkPreview, LinkPreview]) : null
  const rows = both
    ? ROWS.map((row) => ({ ...row, values: both.map(row.read) })).filter(
        (row) => !onlyDifferences || row.values[0] !== row.values[1]
      )
    : []
  const differences = both
    ? ROWS.filter((row) => row.read(both[0]) !== row.read(both[1])).length
    : 0

  return (
    <div className="space-y-6">
      {sides.some(Boolean) && checkedAgent !== agent && <p role="status">These results are for {checkedAgent}. Choose Compare to use {agent}.</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          compare()
        }}
        className={cn(PANEL, 'grid items-center gap-2 p-2 md:grid-cols-[1fr_auto_1fr_auto]')}
      >
        {[0, 1].map((index) => (
          <Input
            key={index}
            value={inputs[index]}
            onChange={(event) =>
              setInputs((previous) =>
                previous.map((value, position) => (position === index ? event.target.value : value))
              )
            }
            placeholder={
              index === 0 ? 'First URL, like staging.example.com' : 'Second URL, like example.com'
            }
            aria-label={index === 0 ? 'First URL' : 'Second URL'}
            autoComplete="off"
            spellCheck={false}
            className={cn(
              'h-11 min-w-0 bg-transparent px-3 text-base outline-none placeholder:text-muted-foreground',
              index === 1 && 'md:order-3'
            )}
          />
        ))}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Swap"
          className="justify-self-center md:order-2"
          disabled={loading}
          onClick={() => {
            setInputs(([first, second]) => [second!, first!])
            setUrls(([first, second]) => [second!, first!])
            setSides(([first, second]) => [second!, first!])
          }}
        >
          <ArrowLeftRight />
        </Button>
        <Button
          type="submit"
          disabled={loading || inputs.some((value) => !value.trim())}
          className="h-11 px-5 md:order-4"
        >
          {loading && <Loader2 className="animate-spin" />}
          Compare
        </Button>
      </form>

      {sides.some(Boolean) && !loading && (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            {sides.map((side, index) => (
              <div key={index} className={cn(PANEL, 'p-4')}>
                <Summary side={side} url={urls[index]!} />
              </div>
            ))}
          </div>

          {both && (
            <>
              <section className="space-y-3">
                <div className="flex flex-wrap gap-1.5">
                  {PLATFORMS.map((item) => (
                    <Button variant="custom" size={null}
                      key={item.id}
                      type="button"
                      onClick={() => setPlatform(item)}
                      className={cn(
                        'rounded-full px-2.5 py-1 text-xs transition-colors',
                        item.id === platform.id
                          ? 'bg-white text-black'
                          : 'bg-white/[0.05] text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {item.name}
                    </Button>
                  ))}
                </div>
                <div className="grid gap-6 md:grid-cols-2">
                  {both.map((preview, index) => (
                    <PlatformPreview
                      key={`${platform.id}-${index}`}
                      platform={platform}
                      preview={preview}
                      url={urls[index]!}
                    />
                  ))}
                </div>
              </section>

              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-ui-lg font-medium text-foreground">
                    Tags · {differences} difference{differences === 1 ? '' : 's'}
                  </h3>
                  <Label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Checkbox
                      checked={onlyDifferences}
                      onCheckedChange={(checked) => setOnlyDifferences((checked === true))}
                    />
                    Only differences
                  </Label>
                </div>
                <div className={cn(PANEL, 'overflow-x-auto')}>
                  <Table className="w-full table-fixed text-left text-sm">
                    <colgroup>
                      <col className="w-40" />
                      <col />
                      <col />
                    </colgroup>
                    <TableHeader className="text-xs text-muted-foreground">
                      <TableRow className="border-b border-white/[0.07]">
                        <TableHead className="whitespace-normal px-4 py-3 font-medium">Tag</TableHead>
                        <TableHead className="whitespace-normal px-4 py-3 font-medium">{hostname(urls[0]!)}</TableHead>
                        <TableHead className="whitespace-normal px-4 py-3 font-medium">{hostname(urls[1]!)}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody className="divide-y divide-white/[0.07]">
                      {rows.map(({ label, values }) => {
                        const differs = values[0] !== values[1]
                        return (
                          <TableRow
                            key={label}
                            className={cn('align-top', differs && 'bg-amber-500/[0.06]')}
                          >
                            <TableCell className="whitespace-normal px-4 py-2.5 text-muted-foreground">
                              {label}
                              {differs && <span className="ml-1.5 text-amber-400">●</span>}
                            </TableCell>
                            {values.map((value, index) => (
                              <TableCell key={index} className="whitespace-normal break-words px-4 py-2.5 text-foreground">
                                {value ?? <span className="text-muted-foreground">Not set</span>}
                              </TableCell>
                            ))}
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </div>
              </section>
            </>
          )}
        </>
      )}
    </div>
  )
}
