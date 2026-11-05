'use client'

import * as React from 'react'
import { Group, Pill, Row, Section } from '@/components/platform-ui'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import type { BatchItem } from '@/lib/api/contracts/content-batches'
import { DRAFT_CHANNEL_LIMITS, platformCaptionLength } from '@/lib/content-drafts/serialize'
import { type BatchAccount, captionProblem } from '@/lib/write/batch'
import { type CaptionMatch, matchCaptions, parseCaptionCSV } from '@/lib/write/bulk-import'
import { analyzeSpintax, expandSpintax, SpintaxError } from '@/lib/write/spintax'
import { FilePicker } from './FilePicker'

/** A caption source may hold alternatives that shrink once expanded. */
const SOURCE_LIMIT = 8800

const SAMPLE_CSV = `filename,caption
launch-teaser.mp4,"Your caption here #launch"
launch-demo.mp4,"Commas are fine, in quotes #launch"
`

/** What a caption source can produce, or why it cannot. */
function readSource(source: string, accounts: readonly BatchAccount[]) {
  try {
    const tightest = accounts.reduce<BatchAccount | null>(
      (best, account) => (!best || limitOf(account) < limitOf(best) ? account : best),
      null
    )
    const measure = (text: string) =>
      tightest ? platformCaptionLength(tightest.channel, text) : text.length
    const { longest, sample, variations } = analyzeSpintax(source, measure)
    return {
      limit: tightest ? limitOf(tightest) : null,
      longest: measure(longest),
      problem: captionProblem(source, accounts),
      sample,
      variations,
    }
  } catch (error) {
    if (error instanceof SpintaxError) return { problem: error.message, variations: undefined }
    throw error
  }
}

const limitOf = (account: BatchAccount) =>
  account.captionLimit ?? DRAFT_CHANNEL_LIMITS[account.channel]

/**
 * Captions for many posts at once, from one source with variations or from a
 * CSV. Both are previewed and checked against each post's accounts, and apply
 * as one change: a refusal leaves every caption as it was.
 */
export function BulkCaptionPanel({
  accounts,
  disabled,
  items,
  onApply,
}: {
  accounts: BatchAccount[]
  disabled: boolean
  items: BatchItem[]
  onApply: (changes: { caption: string; itemId: string }[]) => Promise<void>
}) {
  const [source, setSource] = React.useState('')
  const [replace, setReplace] = React.useState(false)
  const [error, setError] = React.useState('')
  const [rows, setRows] = React.useState<{
    matches: CaptionMatch[]
    unchanged: number
  } | null>(null)
  const unsaved = items.filter((item) => !item.draftId)
  const accountsOf = (item: BatchItem) =>
    accounts.filter((account) => item.channelConnectionIds.includes(account.id))
  const chosen = accounts.filter((account) =>
    unsaved.some((item) => item.channelConnectionIds.includes(account.id))
  )
  const read = source ? readSource(source, chosen) : null

  const applySource = async () => {
    setError('')
    const targets = unsaved.filter((item) => replace || !item.caption.trim())
    if (!targets.length) {
      setError('Every post already has a caption. Choose to replace them to apply this one.')
      return
    }
    if (read?.problem) {
      setError(read.problem)
      return
    }
    await onApply(targets.map((item) => ({ caption: expandSpintax(source), itemId: item.id })))
  }

  const loadCSV = async (file: File | undefined) => {
    if (!file) return
    setError('')
    setRows(null)
    try {
      if (file.size > 1_000_000) throw new Error('CSV files must be smaller than 1 MB.')
      const targets = unsaved.map((item) => ({
        id: item.id,
        names: [item.sourceKey ?? [], item.media.flatMap((entry) => entry.fileName ?? [])].flat(),
      }))
      const { matches, unchanged } = matchCaptions(parseCaptionCSV(await file.text()), targets)
      setRows({
        unchanged: unchanged.length,
        matches: matches.map((match) => {
          const item = unsaved.find((candidate) => candidate.id === match.itemId)
          if (!item) return match
          let problem: string | undefined
          try {
            problem = captionProblem(match.caption, accountsOf(item))
          } catch (cause) {
            if (!(cause instanceof SpintaxError)) throw cause
            problem = cause.message
          }
          return problem
            ? { ...match, itemId: undefined, problems: [`Line ${match.line}: ${problem}`] }
            : match
        }),
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not read this CSV.')
    }
  }

  const ready = rows?.matches.filter((match) => match.itemId) ?? []
  const refused = rows ? rows.matches.length - ready.length : 0

  if (!unsaved.length) return null
  return (
    <Section
      title="Captions"
      description="Give every post a caption at once. Posts already saved as drafts keep theirs; edit those in Write."
    >
      <Group>
        <Row
          label="Bulk caption"
          layout="stacked"
          description="Write alternatives in braces, such as {Hello|Hi} there. Each post gets a random variation, which may repeat."
        >
          <Textarea
            aria-label="Bulk caption"
            maxLength={SOURCE_LIMIT}
            rows={3}
            value={source}
            onChange={(event) => setSource(event.target.value)}
          />
          {read?.variations !== undefined ? (
            <p className="text-xs text-muted-foreground" data-testid="bulk-caption-summary">
              {read.variations === 1
                ? 'One caption'
                : `${read.variations.toLocaleString()} variations`}{' '}
              · longest {read.longest}
              {read.limit ? ` of ${read.limit}` : ''} characters
              {read.variations > 1 ? ` · for example “${read.sample}”` : ''}
            </p>
          ) : null}
          <Label className="font-normal">
            <Checkbox
              checked={replace}
              onCheckedChange={(checked) => setReplace(checked === true)}
            />
            Replace captions posts already have
          </Label>
          <div>
            <Button
              variant="outline"
              disabled={disabled || !source.trim()}
              onClick={() => void applySource()}
            >
              Apply to posts
            </Button>
          </div>
        </Row>
        <Row
          label="Captions from a CSV"
          layout="stacked"
          description="Two columns, filename and caption: names match the file or folder, without case and with the extension optional. One column gives captions to posts in order. The header row is optional, and commas need quotes."
        >
          <div className="flex flex-wrap items-center gap-2">
            <FilePicker
              accept=".csv,text/csv"
              label="Caption CSV file"
              onFiles={([file]) => void loadCSV(file)}
            >
              Load captions
            </FilePicker>
            <Button asChild size="sm" variant="ghost">
              <a
                download="caption-sample.csv"
                href={`data:text/csv;charset=utf-8,${encodeURIComponent(SAMPLE_CSV)}`}
              >
                Download sample CSV
              </a>
            </Button>
          </div>
        </Row>
      </Group>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {rows ? (
        <div className="grid gap-3" data-testid="caption-preview">
          <Group>
            <Table className="text-xs">
              <TableHeader>
                <TableRow>
                  <TableHead>Line</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Caption</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.matches.map((match) => (
                  <TableRow key={match.line} className="align-top">
                    <TableCell>{match.line}</TableCell>
                    <TableCell className="max-w-48 truncate">{match.key ?? 'In order'}</TableCell>
                    <TableCell className="max-w-64 truncate">{match.caption}</TableCell>
                    <TableCell className="whitespace-normal">
                      {match.itemId ? (
                        <Pill tone="green">Matched</Pill>
                      ) : (
                        <div className="grid justify-items-start gap-1">
                          <Pill tone="red">Needs fixing</Pill>
                          {match.problems.map((problem) => (
                            <p key={problem} role="alert" className="text-destructive">
                              {problem}
                            </p>
                          ))}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Group>
          <p className="text-xs text-muted-foreground">
            {ready.length} matched · {refused} need fixing · {rows.unchanged} posts keep their
            caption.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={disabled || !ready.length}
              onClick={() =>
                void onApply(
                  ready.map((match) => ({
                    caption: expandSpintax(match.caption),
                    itemId: match.itemId!,
                  }))
                ).then(() => setRows(null))
              }
            >
              Apply {ready.length} caption{ready.length === 1 ? '' : 's'}
            </Button>
            <Button variant="ghost" onClick={() => setRows(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </Section>
  )
}
