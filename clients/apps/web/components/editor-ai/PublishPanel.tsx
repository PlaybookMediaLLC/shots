'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Combobox } from '@/components/ui/combobox'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { DesignDocument } from '@/lib/design/document'
import { exportDesignDocument } from '@/lib/design/export'
import {
  accountsOn,
  captionFor,
  captionsOverLimit,
  channelLabel,
  designMediaProblems,
  type PublishAccount,
  primaryFor,
} from '@/lib/editor/publish'
import { PUBLISH_MEDIA_TYPE, publishDesigns } from '@/lib/editor/publish-drafts'
import { canvasSizeOf, documentCanvasSize } from '@/lib/export/adapt'
import { useImageStore } from '@/lib/store'
import { useTRPCClient } from '@/lib/trpc/react'
import type { DraftChannel } from '@/lib/write/document'
import {
  type PublishSet,
  type PublishSetsStatus,
  useRecommendedTimes,
} from '@/lib/editor/use-publish-targets'
import { DRAFT_ACCOUNT_LIMIT } from '@/lib/api/contracts/content-drafts'

/**
 * Publishing from the editor: the design (or every AI version of it) becomes
 * a Publish draft per post, with the captions the Captions panel wrote
 * already on the platforms they were written for.
 *
 * Nothing is sent to a network here. Each post is left as a draft for review
 * in Publish, optionally placed on the calendar at a time the workspace's
 * own engagement recommends, so the composer still owns scheduling,
 * approval and provider validation.
 */

/** An AI version of the design, as the Variants panel made it. */
export type PublishVariant = { document: DesignDocument; title: string }

/** No calendar placement: the drafts wait in Publish. */
const NO_TIME = 'none'

/**
 * A recommended time as the panel labels it, in the set's zone. A zone the
 * browser does not know throws, and a label must never take the editor
 * down with it, so the reader's own zone is the fallback.
 */
function timeLabel(at: string, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    weekday: 'short',
  }
  try {
    return new Date(at).toLocaleString(undefined, { ...options, timeZone })
  } catch {
    return new Date(at).toLocaleString(undefined, options)
  }
}

export function PublishPanel({
  disabled,
  hidden,
  onOpenCaptions,
  onSocialSetChange,
  sets,
  socialSetId,
  status,
  variants,
}: {
  /** Nothing on the canvas to post yet. */
  disabled: boolean
  /** Hidden rather than unmounted, so chosen accounts and times survive a tab switch. */
  hidden: boolean
  onOpenCaptions: () => void
  onSocialSetChange: (id: string) => void
  sets: PublishSet[]
  socialSetId: string | undefined
  /** How far the profile list got; `sets` is empty until it is ready. */
  status: PublishSetsStatus
  /** The versions the Variants panel is showing, if any. */
  variants: readonly PublishVariant[]
}) {
  const trpcClient = useTRPCClient()
  const copy = useImageStore((state) => state.copy)
  const set = sets.find((candidate) => candidate.id === socialSetId) ?? null
  const times = useRecommendedTimes(set?.id, !hidden)
  const [selected, setSelected] = React.useState<string[]>([])
  const [everything, setEverything] = React.useState(false)
  const [plannedFor, setPlannedFor] = React.useState(NO_TIME)
  const [busy, setBusy] = React.useState<string | null>(null)
  /**
   * How many designs of the last run were already drafted. Designs are
   * drafted in order and the run stops at the first failure, so a retry of
   * the same run skips that many and never duplicates a draft. Any change
   * to what would be created starts a new run.
   */
  const resume = React.useRef({ done: 0, run: '' })

  // A set's own accounts are the choices; switching sets starts from its
  // default platforms (RFC 024) rather than carrying the last set's picks.
  const accountKey = set ? `${set.id}:${set.accounts.map((account) => account.id).join(',')}` : ''
  const applied = React.useRef('')
  React.useEffect(() => {
    if (applied.current === accountKey) return
    applied.current = accountKey
    setSelected(
      set ? accountsOn(set.accounts, set.defaultChannels).map((account) => account.id) : []
    )
  }, [accountKey, set])
  React.useEffect(() => setPlannedFor(NO_TIME), [set?.id])

  const accounts: PublishAccount[] = set?.accounts ?? []
  const chosen = accounts.filter((account) => selected.includes(account.id))
  const channels: DraftChannel[] = [...new Set(chosen.map((account) => account.channel))]
  const primary = primaryFor(channels, copy)
  const overLimit = captionsOverLimit(copy, channels, primary)
  const withoutCaption = channels.filter(
    (channel) => channel !== primary && !captionFor(copy, channel)
  )
  const versions = everything && variants.length > 0
  const count = versions ? variants.length : 1
  // A slot the panel no longer offers (a newer reading of the recommended
  // times dropped it) is no choice at all, so the control and the drafts
  // both fall back to no placement.
  const when = times.some((time) => time.at === plannedFor) ? plannedFor : NO_TIME
  // Preflight on the shape of what will be posted, so an aspect ratio no
  // chosen platform takes is visible before anything renders. A version can
  // change the canvas, so versions are measured one by one; the export is a
  // multiple of the canvas, so its proportions are the canvas's.
  // `publishDesigns` checks the rendered bytes again before it creates
  // anything.
  const aspectRatio = useImageStore((state) => state.selectedAspectRatio)
  const custom = useImageStore((state) => state.customDimensions)
  const sizes = versions
    ? variants.map((variant) => documentCanvasSize(variant.document))
    : [canvasSizeOf(aspectRatio, custom ?? undefined)]
  const mediaProblems =
    disabled || channels.length === 0
      ? []
      : [
          ...new Set(
            sizes.flatMap((size) =>
              designMediaProblems(channels, { mimeType: PUBLISH_MEDIA_TYPE, ...size })
            )
          ),
        ]

  // The draft's name in the library: the caption's first line, as bulk
  // posts are named, or the version's own title.
  const title = captionFor(copy, primary).split('\n')[0]?.slice(0, 60).trim() || 'Screenshot post'

  async function create() {
    const designs = versions
      ? variants.map((variant) => ({ document: variant.document, name: variant.title }))
      : [{ document: exportDesignDocument({ keepLocalSources: true }), name: title }]
    const run = JSON.stringify([
      designs.map((design) => design.name),
      chosen.map((account) => account.id),
      when,
    ])
    const already = resume.current.run === run ? resume.current.done : 0
    const remaining = designs.slice(already)
    setBusy(`Preparing 1 of ${remaining.length}…`)
    const { drafts, error } = await publishDesigns({
      channelConnectionIds: chosen.map((account) => account.id),
      channels,
      copy,
      designs: remaining,
      onProgress: (done, total) =>
        setBusy(done >= total ? 'Finishing…' : `Preparing ${done + 1} of ${total}…`),
      plannedFor: when === NO_TIME ? undefined : when,
      socialSetId: set?.id,
      trpcClient,
    })
    setBusy(null)
    const made = already + drafts.length
    resume.current = error ? { done: made, run } : { done: 0, run: '' }
    if (error) {
      toast.error(
        made > 0
          ? `${made} of ${designs.length} drafts were created`
          : 'Could not create the draft',
        { description: `${error} Publishing again continues where this stopped.` }
      )
    }
    if (drafts.length === 0) return
    const first = drafts[0]!
    toast.success(made === 1 ? 'Draft created' : `${made} drafts created`, {
      action: {
        label: made === 1 ? 'Open draft' : 'Open Publish',
        onClick: () =>
          window.open(
            made === 1 ? `/publish/${encodeURIComponent(first.id)}` : '/publish',
            '_blank',
            'noopener,noreferrer'
          ),
      },
      description: 'Review and schedule it in Publish; nothing has been posted.',
    })
  }

  if (status !== 'ready') {
    return (
      <div className="flex-1 space-y-3 overflow-y-auto p-3 text-sm" hidden={hidden} role="status">
        <p className="text-muted-foreground">
          {status === 'error'
            ? 'The publishing profiles could not load. Close and reopen this panel to try again.'
            : 'Loading your publishing profiles…'}
        </p>
      </div>
    )
  }

  if (sets.length === 0) {
    return (
      <div className="flex-1 space-y-3 overflow-y-auto p-3 text-sm" hidden={hidden}>
        <p className="text-muted-foreground">
          Connect a social account to post this design from the editor.
        </p>
        <Button asChild variant="outline">
          <a href="/settings/channels" rel="noopener noreferrer" target="_blank">
            Connect an account
          </a>
        </Button>
      </div>
    )
  }

  return (
    <div className="flex-1 space-y-3 overflow-y-auto p-3 text-sm" hidden={hidden}>
      <p className="text-muted-foreground">
        Post this design to every platform at once. Each one takes the caption written for it; the
        drafts wait in Publish for your review.
      </p>

      {sets.length > 1 ? (
        <Label className="grid gap-1 text-xs font-medium">
          Profile
          <Combobox
            aria-label="Profile"
            onValueChange={onSocialSetChange}
            options={sets.map((candidate) => ({ label: candidate.name, value: candidate.id }))}
            searchPlaceholder="Search profiles"
            value={set?.id ?? ''}
          />
        </Label>
      ) : null}

      <fieldset className="space-y-1.5">
        <legend className="text-xs font-medium">Post to</legend>
        {accounts.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {set?.name ?? 'This profile'} has no connected account the editor writes captions for.
          </p>
        ) : null}
        {accounts.map((account) => (
          <Label className="flex items-center gap-2 font-normal" key={account.id}>
            <Checkbox
              checked={selected.includes(account.id)}
              // A draft names at most DRAFT_ACCOUNT_LIMIT accounts; the API
              // refuses more, so the eleventh cannot be ticked here.
              disabled={!selected.includes(account.id) && selected.length >= DRAFT_ACCOUNT_LIMIT}
              onCheckedChange={(value) =>
                setSelected((current) =>
                  value === true
                    ? [...current, account.id]
                    : current.filter((id) => id !== account.id)
                )
              }
            />
            <span className="min-w-0 flex-1 truncate">
              {channelLabel(account.channel)} · {account.name}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {captionFor(copy, account.channel) ? 'Caption ready' : 'No caption'}
            </span>
          </Label>
        ))}
        {selected.length >= DRAFT_ACCOUNT_LIMIT ? (
          <p className="text-xs text-muted-foreground">
            One post goes to at most {DRAFT_ACCOUNT_LIMIT} accounts.
          </p>
        ) : null}
      </fieldset>

      {channels.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {!captionFor(copy, primary)
            ? 'No caption written yet: the drafts open empty.'
            : withoutCaption.length > 0
              ? `${channelLabel(primary)} writes the post; ${withoutCaption.map(channelLabel).join(', ')} reuse it until you write their captions.`
              : `${channelLabel(primary)} writes the post; every other platform keeps its own caption.`}{' '}
          <Button className="underline" onClick={onOpenCaptions} size={null} variant="custom">
            Write captions
          </Button>
        </p>
      ) : null}

      {mediaProblems.map((problem) => (
        <p className="text-xs text-destructive" key={problem} role="status">
          {problem}
        </p>
      ))}

      {overLimit.map((problem) => (
        <p className="text-xs text-destructive" key={problem.channel} role="status">
          {problem.reused
            ? `The ${channelLabel(primary)} caption ${channelLabel(problem.channel)} would reuse is ${problem.length} characters there; its limit is ${problem.limit}. Write a ${channelLabel(problem.channel)} caption in Captions.`
            : `The ${channelLabel(problem.channel)} caption is ${problem.length} characters; the limit is ${problem.limit}. Shorten it in Captions before publishing.`}
        </p>
      ))}

      {variants.length > 0 ? (
        <fieldset className="space-y-1.5">
          <legend className="text-xs font-medium">What to post</legend>
          <Label className="flex items-center gap-2 font-normal">
            <Checkbox
              checked={everything}
              onCheckedChange={(value) => setEverything(value === true)}
            />
            <span>
              One draft for each of the {variants.length} versions, instead of this design
            </span>
          </Label>
        </fieldset>
      ) : null}

      <Label className="grid gap-1 text-xs font-medium">
        When
        <Select onValueChange={setPlannedFor} value={when}>
          <SelectTrigger aria-label="When to post">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_TIME}>No time yet</SelectItem>
            {times.map((time) => (
              <SelectItem key={time.at} value={time.at}>
                {timeLabel(time.at, set?.timeZone ?? 'UTC')} · {time.reason}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Label>
      <p className="text-[11px] text-muted-foreground">
        {times.length > 0
          ? `Recommended from this workspace's measured engagement, in ${set?.timeZone ?? 'UTC'}. A time places the drafts on the calendar; scheduling still happens in Publish.`
          : 'No recommended times yet: they appear once published posts have measured engagement.'}
      </p>

      <Button
        className="w-full"
        disabled={disabled || busy !== null || chosen.length === 0 || mediaProblems.length > 0}
        onClick={() => void create()}
        type="button"
      >
        {busy ?? (count === 1 ? 'Create draft' : `Create ${count} drafts`)}
      </Button>
      {disabled ? (
        <p className="text-xs text-muted-foreground">Add a screenshot to the canvas first.</p>
      ) : null}
    </div>
  )
}
