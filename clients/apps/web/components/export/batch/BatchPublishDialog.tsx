'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { usePublishSets } from '@/lib/editor/use-publish-targets'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Combobox } from '@/components/ui/combobox'
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
import { DRAFT_ACCOUNT_LIMIT } from '@/lib/api/contracts/content-drafts'
import { accountsOn, channelLabel } from '@/lib/editor/publish'
import { type BatchExport, stageExportsAsBatch } from '@/lib/editor/publish-batch'
import { useTRPCClient } from '@/lib/trpc/react'

/**
 * "Create posts" from a batch export: every rendered screenshot becomes a
 * post of a new bulk batch in Publish, where captions, times and accounts
 * are filled in for the whole batch at once.
 */

/** "1 post", "4 posts". */
function posts(count: number): string {
  return `${count} post${count === 1 ? '' : 's'}`
}
export function BatchPublishDialog({
  exports,
  onOpenChange,
  open,
  sizes,
}: {
  /** The rendered screenshots to stage, in the order the batch shows them. */
  exports: readonly BatchExport[]
  onOpenChange: (open: boolean) => void
  open: boolean
  /** How many sizes the export renders; a post carries only the first. */
  sizes: number
}) {
  const trpcClient = useTRPCClient()
  const { sets, status } = usePublishSets(open)
  const [setId, setSetId] = React.useState('')
  const [title, setTitle] = React.useState(() => `Screenshots ${new Date().toLocaleDateString()}`)
  const [accountIds, setAccountIds] = React.useState<string[]>([])
  const [busy, setBusy] = React.useState<string | null>(null)
  const set = sets.find((candidate) => candidate.id === setId) ?? sets[0] ?? null

  // A set's default platforms are where its posts normally go; the batch
  // page changes accounts per post from there.
  const applied = React.useRef('')
  React.useEffect(() => {
    if (!set || applied.current === set.id) return
    applied.current = set.id
    setSetId(set.id)
    setAccountIds(accountsOn(set.accounts, set.defaultChannels).map((item) => item.id))
  }, [set])

  async function create() {
    if (!set) return
    setBusy(`Uploading 1 of ${exports.length}…`)
    try {
      const batch = await stageExportsAsBatch({
        channelConnectionIds: accountIds,
        exports,
        onProgress: (done, total) =>
          setBusy(done >= total ? 'Staging the posts…' : `Uploading ${done + 1} of ${total}…`),
        socialSetId: set.id,
        title: title.trim() || 'Screenshots',
        trpcClient,
      })
      onOpenChange(false)
      // Opened from the toast rather than here: a window opened after an
      // upload is no longer part of the click, and browsers block it.
      toast.success(`${posts(exports.length)} staged in ${set.name}`, {
        action: {
          label: 'Open the batch',
          onClick: () =>
            window.open(
              `/publish/batches/${encodeURIComponent(batch.id)}`,
              '_blank',
              'noopener,noreferrer'
            ),
        },
        description: 'Write the captions and schedule them in Publish.',
      })
    } catch (error) {
      toast.error('Could not create the posts', {
        description:
          error instanceof Error ? error.message : 'Your exported screenshots are unchanged.',
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog onOpenChange={(next) => !busy && onOpenChange(next)} open={open}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create posts</DialogTitle>
          <DialogDescription>
            {exports.length} rendered screenshot{exports.length === 1 ? '' : 's'} become a bulk
            batch in Publish, one post each
            {sizes > 1 ? `, carrying the first of your ${sizes} sizes` : ''}. Write the captions,
            pick the times and schedule them there; each post keeps its file name, so a caption CSV
            can match it.
          </DialogDescription>
        </DialogHeader>
        {status !== 'ready' ? (
          <p className="text-sm text-muted-foreground" role="status">
            {status === 'loading'
              ? 'Loading your publishing profiles…'
              : status === 'error'
                ? 'The publishing profiles could not load. Close this and try again.'
                : 'Publishing is not available on this workspace’s plan.'}
          </p>
        ) : null}
        {status === 'ready' && sets.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Connect a social account first.{' '}
            <a
              className="underline"
              href="/settings/channels"
              rel="noopener noreferrer"
              target="_blank"
            >
              Open channel settings
            </a>
          </p>
        ) : null}
        {set ? (
          <div className="space-y-4">
            <Label className="grid gap-1.5">
              Name
              <Input
                maxLength={200}
                onChange={(event) => setTitle(event.target.value)}
                value={title}
              />
            </Label>
            {sets.length > 1 ? (
              <Label className="grid gap-1.5">
                Profile
                <Combobox
                  aria-label="Profile"
                  onValueChange={setSetId}
                  options={sets.map((candidate) => ({
                    label: candidate.name,
                    value: candidate.id,
                  }))}
                  searchPlaceholder="Search profiles"
                  value={set.id}
                />
              </Label>
            ) : null}
            <fieldset className="space-y-1.5">
              <legend className="text-sm font-medium">Post to</legend>
              {set.accounts.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {set.name} has no connected account yet.
                </p>
              ) : null}
              {set.accounts.map((account) => (
                <Label className="flex items-center gap-2 font-normal" key={account.id}>
                  <Checkbox
                    checked={accountIds.includes(account.id)}
                    disabled={
                      !accountIds.includes(account.id) && accountIds.length >= DRAFT_ACCOUNT_LIMIT
                    }
                    onCheckedChange={(value) =>
                      setAccountIds((current) =>
                        value === true
                          ? [...current, account.id]
                          : current.filter((id) => id !== account.id)
                      )
                    }
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {channelLabel(account.channel)} · {account.name}
                  </span>
                </Label>
              ))}
              {accountIds.length >= DRAFT_ACCOUNT_LIMIT ? (
                <p className="text-xs text-muted-foreground">
                  One post goes to at most {DRAFT_ACCOUNT_LIMIT} accounts.
                </p>
              ) : null}
            </fieldset>
          </div>
        ) : null}
        <DialogFooter>
          <Button disabled={Boolean(busy)} onClick={() => onOpenChange(false)} variant="outline">
            Cancel
          </Button>
          <Button
            aria-busy={Boolean(busy)}
            disabled={Boolean(busy) || !set || exports.length === 0}
            onClick={() => void create()}
          >
            {busy ?? `Create ${posts(exports.length)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
