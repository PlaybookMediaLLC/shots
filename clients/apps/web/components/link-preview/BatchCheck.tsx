'use client'

import { ArrowsDownUpIcon as ArrowDownUp } from '@phosphor-icons/react/dist/ssr/ArrowsDownUp'
import { CopyIcon as CopyIcon } from '@phosphor-icons/react/dist/ssr/Copy'
import { DownloadIcon as Download } from '@phosphor-icons/react/dist/ssr/Download'
import { FileMagnifyingGlassIcon as FileSearch } from '@phosphor-icons/react/dist/ssr/FileMagnifyingGlass'
import { SpinnerGapIcon as Loader2 } from '@phosphor-icons/react/dist/ssr/SpinnerGap'
import { useRef, useState } from 'react'
import { Pill } from '@/components/platform-ui'
import { Button } from '@/components/ui/button'
import type { LinkPreview, LinkPreviewAgent } from '@/lib/api/contracts/link-preview'
import {
  auditLinkPreview,
  issueSeveritySchema,
  type LinkPreviewIssue,
} from '@/lib/link-preview/audit'
import { duplicateGroups } from '@/lib/link-preview/insights'
import { scoreLinkPreview } from '@/lib/link-preview/metadata'
import { cn } from '@/lib/utils'
import { downloadText, normalizeUrl, parseUrlLines, requestPreview } from './client'
import { PANEL } from './MetadataPanels'
import { hostname } from './PlatformPreviews'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table'

/** Most links one batch checks; the API allows 30 previews a minute. */
const MAX_LINKS = 20
/** Previews in flight at once, so a batch stays polite to the sites it reads. */
const CONCURRENCY = 2

const { error, warning } = issueSeveritySchema.enum

type Row = {
  url: string
  /** Absent while pending. */
  result?: { error: string } | { issues: LinkPreviewIssue[]; preview: LinkPreview; score: number }
}

const csvCell = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`

function toCsv(rows: Row[]): string {
  const lines = [['URL', 'Score', 'Errors', 'Warnings', 'Title', 'Image', 'Top issue']]
  for (const { result, url } of rows) {
    if (!result) continue
    if ('error' in result) {
      lines.push([url, '', '', '', '', '', result.error])
      continue
    }
    const count = (severity: LinkPreviewIssue['severity']) =>
      result.issues.filter((issue) => issue.severity === severity).length
    lines.push([
      url,
      String(result.score),
      String(count(error)),
      String(count(warning)),
      result.preview.ogTitle || result.preview.title || '',
      result.preview.ogImage ? 'yes' : 'no',
      result.issues[0]?.title ?? '',
    ])
  }
  return lines.map((line) => line.map(csvCell).join(',')).join('\n')
}

/** Check many links at once: a score and the top issue for each, exportable as CSV. */
export function BatchCheck({
  agent,
  onOpen,
}: {
  agent: LinkPreviewAgent
  /** Open one link in the full single-link view. */
  onOpen: (url: string, preview?: LinkPreview) => void
}) {
  const [text, setText] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [running, setRunning] = useState(false)
  const [site, setSite] = useState('')
  const [importing, setImporting] = useState(false)
  const [imported, setImported] = useState('')
  const [sortByScore, setSortByScore] = useState(false)
  const [onlyProblems, setOnlyProblems] = useState(false)
  const run = useRef(0)

  /** Fill the list from the site's sitemap. */
  async function importSitemap() {
    const target = normalizeUrl(site)
    if (!target) {
      setImported('Enter the site, like example.com, or a sitemap URL.')
      return
    }
    setImporting(true)
    setImported('')
    try {
      const response = await fetch(
        `/api/link-preview/sitemap?${new URLSearchParams({ url: target })}`
      )
      const body = await response.json().catch(() => null)
      if (!response.ok) throw new Error(body?.message ?? 'The sitemap could not be read.')
      setText(body.urls.slice(0, MAX_LINKS).join('\n'))
      setImported(
        `Found ${body.total} page${body.total === 1 ? '' : 's'} in ${body.sitemap}` +
          (body.total > MAX_LINKS ? `; added the first ${MAX_LINKS}.` : '.')
      )
    } catch (caught) {
      setImported(caught instanceof Error ? caught.message : 'The sitemap could not be read.')
    } finally {
      setImporting(false)
    }
  }

  const { urls, invalid } = parseUrlLines(text)
  const [checkedAgent, setCheckedAgent] = useState(agent)

  async function start() {
    if (invalid.length) return
    setCheckedAgent(agent)
    const id = ++run.current
    const queue = urls.slice(0, MAX_LINKS)
    setRows(queue.map((url) => ({ url })))
    setRunning(true)
    let next = 0
    const worker = async () => {
      while (next < queue.length && run.current === id) {
        const url = queue[next++]!
        let result: Row['result']
        try {
          const preview = await requestPreview(url, agent)
          result = {
            issues: auditLinkPreview(preview),
            preview,
            score: scoreLinkPreview(preview).score,
          }
        } catch (caught) {
          result = { error: caught instanceof Error ? caught.message : 'Could not be read.' }
        }
        if (run.current !== id) return
        setRows((previous) => previous.map((row) => (row.url === url ? { ...row, result } : row)))
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
    if (run.current === id) setRunning(false)
  }

  const done = rows.filter((row) => row.result).length
  const checked = rows.flatMap(({ result, url }) =>
    result && 'preview' in result ? [{ ...result, url }] : []
  )
  const duplicates = running ? [] : duplicateGroups(checked)
  const shown = rows
    .filter(
      ({ result }) =>
        !onlyProblems ||
        !result ||
        'error' in result ||
        result.issues.some((issue) => issue.severity !== issueSeveritySchema.enum.info)
    )
    .sort((a, b) => {
      if (!sortByScore) return 0
      const score = (row: Row) => (row.result && 'score' in row.result ? row.result.score : -1)
      return score(a) - score(b)
    })

  return (
    <div className="space-y-6">
      {rows.length > 0 && checkedAgent !== agent && <p role="status">These results are for {checkedAgent}. Choose Check all to use {agent}.</p>}
      <section className={cn(PANEL, 'space-y-3 p-5')}>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            importSitemap()
          }}
          className="flex flex-wrap items-center gap-2 border-b border-white/[0.07] pb-4"
        >
          <Input
            value={site}
            onChange={(event) => setSite(event.target.value)}
            placeholder="Import from a sitemap: example.com or example.com/sitemap.xml"
            aria-label="Site or sitemap to import"
            className="h-9 min-w-0 flex-1 rounded-lg bg-white/[0.03] px-3 text-sm text-foreground ring-1 ring-white/[0.08] outline-none placeholder:text-muted-foreground focus:ring-white/25"
          />
          <Button type="submit" variant="outline" size="sm" disabled={importing || !site.trim()}>
            {importing ? <Loader2 className="animate-spin" /> : <FileSearch />}
            Import pages
          </Button>
          {imported && <p className="w-full text-xs text-muted-foreground">{imported}</p>}
        </form>
        <Label className="block space-y-1.5">
          <span className="text-ui-lg font-medium text-foreground">Links to check</span>
          <span className="block text-xs text-muted-foreground">
            One per line, up to {MAX_LINKS}. Paste your campaign links, launch pages, or blog posts.
          </span>
          <Textarea
            value={text}
            aria-invalid={invalid.length > 0}
            aria-describedby="batch-url-errors"
            onChange={(event) => setText(event.target.value)}
            rows={6}
            placeholder={'example.com\nexample.com/pricing\nexample.com/blog/launch'}
            className="w-full resize-y rounded-lg bg-white/[0.03] px-3 py-2 font-mono text-sm text-foreground ring-1 ring-white/[0.08] outline-none placeholder:text-muted-foreground focus:ring-white/25"
          />
        </Label>
        <p id="batch-url-errors" role={invalid.length ? 'alert' : undefined} className="min-h-5 text-xs text-red-400">
          {invalid.length ? `Invalid URL lines: ${invalid.join(', ')}. Enter one web URL per line.` : '\u00a0'}
        </p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {urls.length} link{urls.length === 1 ? '' : 's'}
            {urls.length > MAX_LINKS ? `; the first ${MAX_LINKS} are checked` : ''}
          </p>
          <Button onClick={start} disabled={running || urls.length === 0 || invalid.length > 0}>
            {running && <Loader2 className="animate-spin" />}
            {running ? `Checking ${done} of ${rows.length}` : 'Check all'}
          </Button>
        </div>
      </section>

      {rows.length > 0 && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-ui-lg font-medium text-foreground">
              Results · {checked.length} checked, {done - checked.length} failed · {done} of {rows.length}
              {checked.length > 0 &&
                ` · average score ${Math.round(checked.reduce((sum, row) => sum + row.score, 0) / checked.length)}`}
            </h3>
            <div className="flex flex-wrap items-center gap-3">
              <Label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Checkbox
                  checked={onlyProblems}
                  onCheckedChange={(checked) => setOnlyProblems((checked === true))}
                />
                Only pages with errors or warnings
              </Label>
              <Button
                variant="outline"
                size="sm"
                disabled={done === 0}
                onClick={() => downloadText('link-previews.csv', toCsv(rows), 'text/csv')}
              >
                <Download />
                Export CSV
              </Button>
            </div>
          </div>
          {duplicates.length > 0 && (
            <div className="space-y-2 rounded-2xl bg-amber-500/[0.06] p-4 ring-1 ring-amber-500/20">
              <p className="flex items-center gap-2 text-ui-lg font-medium text-amber-200">
                <CopyIcon className="size-4" />
                {duplicates.length} shared {duplicates.length === 1 ? 'value' : 'values'} across
                pages
              </p>
              <ul className="space-y-1.5 text-sm">
                {duplicates.map((group) => (
                  <li key={`${group.field}-${group.value}`} className="text-muted-foreground">
                    <span className="text-foreground">{group.urls.length} pages</span> share the{' '}
                    {group.field} “
                    {group.value.length > 80 ? `${group.value.slice(0, 79)}…` : group.value}
                    ”:{' '}
                    {group.urls
                      .map(
                        (url) => `${hostname(url)}${new URL(url).pathname}${new URL(url).search}`
                      )
                      .join(', ')}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                Give each page its own title, description, and image so shares and search results
                tell them apart.
              </p>
            </div>
          )}
          <div className={cn(PANEL, 'overflow-x-auto')}>
            <Table className="w-full text-left text-sm">
              <TableHeader className="text-xs text-muted-foreground">
                <TableRow className="border-b border-white/[0.07]">
                  <TableHead className="whitespace-normal px-4 py-3 font-medium">Link</TableHead>
                  <TableHead className="whitespace-normal px-4 py-3 font-medium">
                    <Button variant="custom" size={null}
                      type="button"
                      onClick={() => setSortByScore((value) => !value)}
                      aria-pressed={sortByScore}
                      className={cn(
                        'inline-flex items-center gap-1 hover:text-foreground',
                        sortByScore && 'text-foreground'
                      )}
                    >
                      Score
                      <ArrowDownUp className="size-3" />
                    </Button>
                  </TableHead>
                  <TableHead className="whitespace-normal px-4 py-3 font-medium">Errors · Warnings</TableHead>
                  <TableHead className="whitespace-normal px-4 py-3 font-medium">Top issue</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="divide-y divide-white/[0.07]">
                {shown.map(({ result, url }) => (
                  <TableRow key={url} className="align-top">
                    <TableCell className="whitespace-normal max-w-64 px-4 py-3">
                      <Button variant="custom" size={null}
                        type="button"
                        onClick={() => onOpen(url, result && 'preview' in result ? result.preview : undefined)}
                        className="block truncate text-left text-foreground hover:underline"
                        title={url}
                      >
                        {hostname(url)}
                        {new URL(url).pathname === '/' ? '' : new URL(url).pathname}
                      </Button>
                    </TableCell>
                    {!result ? (
                      <TableCell colSpan={3} className="whitespace-normal px-4 py-3 text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" aria-label="Checking" />
                      </TableCell>
                    ) : 'error' in result ? (
                      <TableCell colSpan={3} className="whitespace-normal px-4 py-3 text-red-400">
                        {result.error}
                      </TableCell>
                    ) : (
                      <>
                        <TableCell className="whitespace-normal px-4 py-3 font-semibold tabular-nums">
                          <span
                            className={
                              result.score >= 80
                                ? 'text-emerald-400'
                                : result.score >= 50
                                  ? 'text-amber-400'
                                  : 'text-red-400'
                            }
                          >
                            {result.score}
                          </span>
                        </TableCell>
                        <TableCell className="whitespace-normal px-4 py-3">
                          <span className="flex gap-1.5">
                            <Pill tone="red">
                              {result.issues.filter((issue) => issue.severity === error).length}
                            </Pill>
                            <Pill tone="yellow">
                              {result.issues.filter((issue) => issue.severity === warning).length}
                            </Pill>
                          </span>
                        </TableCell>
                        <TableCell className="whitespace-normal px-4 py-3 text-muted-foreground">
                          {result.issues[0]?.title ?? 'Nothing to fix'}
                        </TableCell>
                      </>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}
    </div>
  )
}
