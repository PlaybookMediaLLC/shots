'use client'

import { useWriteRouter } from '@/components/write/write-context'

import * as React from 'react'
import { lineDiff as diffRows } from '@/lib/line-diff'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { CHANNEL_META, ChannelIcon } from '@/components/drafts/channel-meta'
import { LocalTime, useHydrated } from '@/components/drafts/local-time'
import { type DraftWire, draftsApi, type RevisionWire } from '@/lib/content-drafts/client'
import { serializeDraft } from '@/lib/content-drafts/serialize'
import { writeApi } from '@/lib/write/client'
import type { DraftChannel, PlateBody } from '@/lib/write/document'
import { bodyFor, readVersions } from '@/lib/write/versions'
import { cn } from '@/lib/utils'
import { draftHref, useWrite } from '../write-context'

/**
 * Share & collaborate (RFC 025): the internal link, which only members who
 * can see the set can open, and the public link, an explicit switch that
 * gives anyone with it read and comment access until it is turned off.
 * Copying the internal link never turns the public one on.
 */
export function ShareDialog({
  canEdit,
  onInsertLink,
  draft,
  onClose,
  onDraft,
}: {
  canEdit: boolean
  onInsertLink?: (link: string) => void
  draft: DraftWire
  onClose: () => void
  onDraft: (draft: DraftWire) => void
}) {
  const { data } = useWrite()
  const hydrated = useHydrated()
  const [busy, setBusy] = React.useState(false)
  const set = data.sets.find(
    (item) =>
      item.id ===
      (draft.socialSetId ?? data.sets.find((entry) => entry.visibility === 'WORKSPACE')?.id)
  )
  const internal = hydrated ? `${window.location.origin}${draftHref(draft.id, set?.id)}` : ''
  const publicLink =
    hydrated && draft.shareToken ? `${window.location.origin}/d/${draft.shareToken}` : ''
  const toggle = async (enabled: boolean) => {
    setBusy(true)
    try {
      onDraft(await draftsApi.share(draft.id, enabled))
      toast.success(enabled ? 'Public link on.' : 'Public link off. It stops working now.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Sharing did not change.')
    } finally {
      setBusy(false)
    }
  }
  const copy = (value: string, done: string) => {
    void navigator.clipboard.writeText(value)
    toast.success(done)
  }
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="max-w-md" data-testid="share-dialog">
        <DialogHeader>
          <DialogTitle>Share & collaborate</DialogTitle>
          <DialogDescription>
            {set?.visibility === 'PRIVATE'
              ? `Access: ${set.name} is private to its owner.`
              : 'Access: everyone in this workspace, by their role.'}
          </DialogDescription>
        </DialogHeader>
        <Label className="grid gap-1 text-xs text-muted-foreground">
          Internal link
          <span className="flex gap-2">
            <Input
              aria-label="Internal link"
              className="flex-1 text-xs"
              readOnly
              value={internal}
            />
            <Button
              onClick={() =>
                copy(internal, 'Internal link copied. Members who can see this set can open it.')
              }
              size="sm"
              type="button"
              variant="outline"
            >
              Copy link
            </Button>
          </span>
        </Label>
        <div className="grid gap-2 rounded-lg border border-border p-3">
          <Label className="flex items-center justify-between gap-3 text-sm text-foreground">
            <span>
              Public link
              <span className="block text-label text-muted-foreground">
                Anyone with the link can read and comment. After publication it shows the delivered
                thread, including confirmed replies.
              </span>
            </span>
            <Switch
              aria-label="Public link"
              checked={Boolean(draft.shareToken)}
              disabled={!canEdit || busy}
              onCheckedChange={(checked) => void toggle(checked === true)}
            />
          </Label>
          {publicLink ? (
            <span className="flex gap-2">
              <Input
                aria-label="Public link to share"
                className="flex-1 text-xs"
                readOnly
                value={publicLink}
              />
              <Button
                onClick={() => copy(publicLink, 'Public link copied.')}
                size="sm"
                type="button"
                variant="outline"
              >
                Copy
              </Button>
            </span>
          ) : (
            <p className="text-xs text-muted-foreground">
              Off: nobody outside the workspace can open this draft.
            </p>
          )}
        </div>
        {publicLink && canEdit && onInsertLink && (
          <Button
            variant="outline"
            onClick={() => {
              onInsertLink(publicLink)
              onClose()
            }}
          >
            Add reading link to thread
          </Button>
        )}
        <DialogFooter>
          <Button onClick={onClose} type="button">
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Line diff of two texts: kept, removed and added lines, in order (LCS). */
export function lineDiff(
  before: string,
  after: string
): { kind: 'same' | 'removed' | 'added'; text: string }[] {
  const a = before.split('\n')
  const b = after.split('\n')
  return diffRows(before, after).map((row) =>
    row.kind === 'add'
      ? { kind: 'added', text: b[row.after - 1] }
      : { kind: row.kind === 'del' ? 'removed' : 'same', text: a[row.before - 1] }
  )
}

/** Why a backup was kept, as a person reads it. */
const REASONS: Record<RevisionWire['reason'], string> = {
  edit: 'While editing',
  plan: 'When planned',
  publish: 'When published',
  recovery: 'When recovered',
  schedule: 'When scheduled',
  'calendar.move': 'When moved',
  'calendar.swap': 'When swapped',
  'calendar.unschedule': 'When unscheduled',
  'calendar.remove_date': 'When the date was removed',
}

/**
 * Automatic backups (RFC 025): immutable snapshots, browsed one at a time
 * with previous and next, shown per platform, compared with the draft now,
 * and recovered as a new draft. The draft itself is never changed here.
 */
export function BackupsBrowser({
  channels,
  current,
  draftId,
  onClose,
}: {
  channels: DraftChannel[]
  current: PlateBody
  draftId: string
  onClose: () => void
}) {
  const router = useWriteRouter()
  const { data } = useWrite()
  const [items, setItems] = React.useState<RevisionWire[] | null>(null)
  const [index, setIndex] = React.useState(0)
  const [loaded, setRevision] = React.useState<RevisionWire | null>(null)
  const [loadError, setLoadError] = React.useState<{ id: string; message: string } | null>(null)
  const [retry, setRetry] = React.useState(0)
  const [channel, setChannel] = React.useState<DraftChannel>(channels[0] ?? 'x')
  const [compare, setCompare] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  React.useEffect(() => {
    void draftsApi
      .revisions(draftId)
      .then(({ items: found }) => setItems(found))
      .catch((error: unknown) => {
        setItems([])
        toast.error(error instanceof Error ? error.message : 'Backups could not be read.')
      })
  }, [draftId])
  const id = items?.[index]?.id
  const revision = loaded?.id === id ? loaded : null
  React.useEffect(() => {
    setRevision(null)
    setLoadError(null)
    if (!id) return
    let live = true
    void draftsApi
      .revision(draftId, id)
      .then((found) => {
        if (live) setRevision(found)
      })
      .catch((error: unknown) => {
        if (live)
          setLoadError({
            id,
            message: error instanceof Error ? error.message : 'This backup could not be read.',
          })
      })
    return () => {
      live = false
    }
  }, [draftId, id, retry])
  const body = revision
    ? bodyFor((revision.body ?? []) as PlateBody, readVersions(revision.platformVersions), channel)
    : []
  const then = serializeDraft(body, channel).caption
  const now = serializeDraft(current, channel).caption
  // Group adjacent lines so a large fallback does not mount tens of thousands of spans.
  const comparison = React.useMemo(() => {
    if (!compare || !revision) return []
    const groups: { kind: 'same' | 'removed' | 'added'; lines: string[] }[] = []
    for (const line of lineDiff(then, now)) {
      const text = `${line.kind === 'removed' ? '− ' : line.kind === 'added' ? '+ ' : '  '}${line.text || ' '}`
      const last = groups[groups.length - 1]
      if (last?.kind === line.kind) last.lines.push(text)
      else groups.push({ kind: line.kind, lines: [text] })
    }
    return groups.map(({ kind, lines }) => ({ kind, text: lines.join('\n') }))
  }, [compare, revision, then, now])
  const recover = async () => {
    if (!revision || busy) return
    setBusy(true)
    try {
      const result = await writeApi.recover(draftId, revision.id)
      toast.success('Recovered as a new draft. The original is unchanged.')
      router.push(draftHref(result.draft.id, data.activeSet?.id))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The backup could not be recovered.')
      setBusy(false)
    }
  }
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent
        className="max-h-[90dvh] max-w-2xl overflow-y-auto"
        data-testid="backups-browser"
      >
        <DialogHeader>
          <DialogTitle>Browse versions</DialogTitle>
          <DialogDescription>
            Backups are kept every ten minutes while you edit, and whenever the draft is planned,
            scheduled, published or recovered: every one from the last 30 days, then one a day for a
            year. Recovering makes a new draft; this one stays as it is.
          </DialogDescription>
        </DialogHeader>
        {items === null ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
        {items?.length === 0 ? (
          <p className="text-sm text-muted-foreground">No backups yet: they start with edits.</p>
        ) : null}
        {items && items.length > 0 ? (
          <>
            <div className="flex items-center justify-between gap-2 text-sm">
              <Button
                disabled={busy || index >= items.length - 1}
                onClick={() => setIndex(index + 1)}
                size="sm"
                type="button"
                variant="outline"
              >
                ← Prev
              </Button>
              <span className="text-center text-xs text-muted-foreground" data-testid="backup-time">
                <LocalTime value={items[index].createdAt} /> · version {items[index].version} ·{' '}
                {REASONS[items[index].reason]}
                <span className="block text-label text-muted-foreground">
                  {index + 1} of {items.length}
                </span>
              </span>
              <Button
                disabled={busy || index === 0}
                onClick={() => setIndex(index - 1)}
                size="sm"
                type="button"
                variant="outline"
              >
                Next →
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {channels.map((item) => (
                <Button
                  aria-pressed={item === channel}
                  className={cn(
                    'flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
                    item === channel
                      ? 'border-foreground/40 text-foreground'
                      : 'border-border text-muted-foreground'
                  )}
                  key={item}
                  onClick={() => setChannel(item)}
                  size={null}
                  type="button"
                  variant="custom"
                >
                  <ChannelIcon channel={item} />
                  {CHANNEL_META[item].label}
                </Button>
              ))}
              <Label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                Compare with now
                <Switch
                  aria-label="Compare with now"
                  checked={compare}
                  onCheckedChange={(checked) => setCompare(checked === true)}
                />
              </Label>
            </div>
            {revision ? (
              compare ? (
                <pre
                  className="max-h-80 overflow-y-auto whitespace-pre-wrap rounded-lg bg-foreground/[0.03] p-3 font-sans text-sm"
                  data-testid="backup-diff"
                >
                  {comparison.map((line, at) => (
                    <span
                      className={cn(
                        'block',
                        line.kind === 'removed' &&
                          'bg-red-500/15 text-red-700 dark:text-red-200 line-through',
                        line.kind === 'added' &&
                          'bg-emerald-500/15 text-emerald-700 dark:text-emerald-200'
                      )}
                      key={at}
                    >
                      {line.text}
                    </span>
                  ))}
                </pre>
              ) : (
                <pre
                  className="max-h-80 overflow-y-auto whitespace-pre-wrap rounded-lg bg-foreground/[0.03] p-3 font-sans text-sm text-foreground"
                  data-testid="backup-content"
                >
                  {then || 'Empty'}
                </pre>
              )
            ) : loadError && loadError.id === id ? (
              <div role="alert" className="text-sm">
                <p>{loadError.message}</p>
                <Button onClick={() => setRetry((value) => value + 1)} variant="outline" size="sm">
                  Retry loading version
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Loading this version…</p>
            )}
          </>
        ) : null}
        <DialogFooter>
          <Button onClick={onClose} type="button" variant="ghost">
            Close
          </Button>
          <Button disabled={!revision || busy} onClick={() => void recover()} type="button">
            Create new draft from this version
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
