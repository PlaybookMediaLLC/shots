'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useShallow } from 'zustand/react/shallow'
import { ArrowSquareOutIcon } from '@phosphor-icons/react/dist/ssr/ArrowSquareOut'
import { CHANNEL_META, ChannelIcon } from '@/components/drafts/channel-meta'
import { connectHref, HEALTH_GUIDANCE, useSocialSets } from '@/components/settings/social-sets/api'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DatePicker } from '@/components/ui/date-picker'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Textarea } from '@/components/ui/textarea'
import { TimePicker } from '@/components/ui/time-picker'
import { getAspectRatioPreset } from '@/lib/aspect-ratio-utils'
import { call, draftsApi, DraftRequestError, type DraftWire } from '@/lib/content-drafts/client'
import { channelForPlatform, type DraftChannel } from '@/lib/content-drafts/serialize'
import { useEditorDocument } from '@/lib/design/use-editor-document'
import { safeBaseName } from '@/lib/export/naming'
import { useExportSettings } from '@/lib/export/use-export-settings'
import { attachToDraftHref, draftPostBody, returnDraftId } from '@/lib/platform/asset-handoff'
import { useCanPublish } from '@/lib/platform/can-start-post'
import {
  compositionRevision,
  publishExportConfig,
  publishFormatChanged,
  type PublicationAsset,
  type PublicationRender,
  rememberPublication,
  rememberedPublication,
  renderPublication,
  uploadPublication,
} from '@/lib/platform/publish-handoff'
import { useProjectSession } from '@/lib/projects/session'
import { useHydratedSession } from '@/lib/auth/client'
import { useImageStore } from '@/lib/store'
import { browserTimeZone } from '@/lib/time-zones'
import { useTRPCClient } from '@/lib/trpc/react'
import type { AccountStanding } from '@/lib/write/capabilities'
import { EMPTY_PLATFORM_VERSIONS } from '@/lib/write/document'
import { mediaChanges, mediaProblems } from '@/lib/write/media-rules'
import { buildPublication } from '@/lib/write/publication'
import { resolveLocalTime, wallTime } from '@/lib/write/zoned-time'
import { WorkspaceSaveError } from '@/lib/workspace/save-export'

/**
 * Publish the design being edited to connected social accounts.
 *
 * The editor renders and uploads the composition through its own export
 * pipeline, then the post is an ordinary content draft: this dialog calls
 * `draftsApi.create` and `draftsApi.schedule`, the same two calls the
 * composer makes, so the resulting post is scheduled, queued, published and
 * reconciled by the one publishing system. Anything this dialog deliberately
 * leaves out — threads, per-platform text, polls, follow-ups, approval — is
 * one click away in the composer, on the same draft.
 */

/** The dialog's own step, so only the control that is working says so. */
type Action = 'draft' | 'publish' | 'queue' | 'schedule'

/** What was committed, so the dialog can confirm it and link to the draft. */
type Outcome = {
  draftId: string
  headline: string
  detail: string
}

function message(error: unknown, fallback: string): string {
  if (error instanceof WorkspaceSaveError || error instanceof DraftRequestError) return error.message
  return error instanceof Error ? error.message : fallback
}

/** A date's YYYY-MM-DD in a zone, as the schedule dialog reads it. */
function dayIn(at: Date, zone: string): string {
  return wallTime(at, zone).slice(0, 10)
}

function fileSize(bytes: number): string {
  return bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1000))} KB`
}

/** A connected account's health, as the social set API reports it. */
type AccountHealth = keyof typeof HEALTH_GUIDANCE

/** One connected account a post can go to. */
type Destination = {
  channel: DraftChannel
  handle: string | null
  health: AccountHealth
  id: string
  name: string
  platform: string
  standing: AccountStanding
}

export function PublishDialog({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void
  open: boolean
}) {
  const router = useRouter()
  const trpcClient = useTRPCClient()
  const [exportSettings] = useExportSettings()
  const projectId = useProjectSession((state) => state.projectId)
  const workspaceId = useHydratedSession().data?.session.activeOrganizationId ?? ''
  const sets = useSocialSets()
  const canPublish = useCanPublish()
  const captionId = React.useId()

  const design = useImageStore(
    useShallow((state) => ({
      customDimensions: state.customDimensions,
      imageName: state.imageName,
      selectedAspectRatio: state.selectedAspectRatio,
    }))
  )
  const preset = React.useMemo(
    () => getAspectRatioPreset(design.selectedAspectRatio),
    // customDimensions resizes the 'custom' preset, as the export panel reads it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [design.selectedAspectRatio, design.customDimensions]
  )
  const canvas = preset
    ? { height: preset.height, width: preset.width }
    : { height: 1440, width: 1920 }
  const config = React.useMemo(
    () =>
      publishExportConfig({
        format: exportSettings.format,
        quality: exportSettings.quality,
        scale: exportSettings.scale,
        transparent: exportSettings.transparent,
      }),
    [exportSettings.format, exportSettings.quality, exportSettings.scale, exportSettings.transparent]
  )

  const [render, setRender] = React.useState<PublicationRender | null>(null)
  const [preview, setPreview] = React.useState<string | null>(null)
  const [asset, setAsset] = React.useState<PublicationAsset | null>(null)
  const [progress, setProgress] = React.useState(0)
  const [preparing, setPreparing] = React.useState(false)
  const [renderError, setRenderError] = React.useState<string | null>(null)
  const [caption, setCaption] = React.useState('')
  const [altText, setAltText] = React.useState('')
  const [setId, setSetId] = React.useState<string | null>(null)
  const [chosen, setChosen] = React.useState<ReadonlySet<string> | null>(null)
  const [action, setAction] = React.useState<Action | null>(null)
  const [failure, setFailure] = React.useState<string | null>(null)
  const [outcome, setOutcome] = React.useState<Outcome | null>(null)
  const [timing, setTiming] = React.useState<'now' | 'queue' | 'schedule'>('schedule')
  const [queueSlot, setQueueSlot] = React.useState<string | null>(null)
  const [queueNote, setQueueNote] = React.useState<string | null>(null)
  const [approvalRequired, setApprovalRequired] = React.useState(false)
  // The draft this editor was opened from, when someone came to re-edit its
  // image: the finished render goes back there for review instead of starting
  // a second post about the same thing.
  const [returnDraft] = React.useState(() => returnDraftId(window.location.search))

  // The draft this dialog already created, so a retry after a failed schedule
  // schedules that draft instead of leaving a second one behind.
  const draftRef = React.useRef<DraftWire | null>(null)
  // One key for every create attempt: a retry after a lost response returns the
  // same draft, as the quick-compose box does.
  const requestKeyRef = React.useRef(crypto.randomUUID())
  const assetRef = React.useRef<PublicationAsset | null>(null)
  const previewRef = React.useRef<string | null>(null)
  // The render and upload under way. A second request while one runs — a
  // double-mounted effect, an impatient Retry — joins it instead of storing
  // the same pixels twice under two asset ids.
  const running = React.useRef<Promise<void> | null>(null)

  const liveDocument = useEditorDocument()
  const liveRevision = React.useMemo(
    () => (liveDocument ? compositionRevision(liveDocument, config) : null),
    [liveDocument, config]
  )
  const stale = Boolean(render && liveRevision && render.revision !== liveRevision)

  const showPreview = React.useCallback((blob: Blob | null) => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    previewRef.current = blob ? URL.createObjectURL(blob) : null
    setPreview(previewRef.current)
  }, [])

  // A large blob and its object URL are released with the dialog, never held
  // in state between openings.
  React.useEffect(
    () => () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current)
      previewRef.current = null
    },
    []
  )

  const prepare = React.useCallback((): Promise<void> => {
    if (running.current) return running.current
    const work = (async () => {
      setPreparing(true)
      setRenderError(null)
      setProgress(0)
      try {
        const rendered = await renderPublication({
          canvas,
          config,
          name: safeBaseName(design.imageName ?? ''),
        })
        setRender(rendered)
        showPreview(rendered.blob)
        const saved = await uploadPublication({
          onProgress: setProgress,
          projectId: projectId ?? undefined,
          render: rendered,
          // This dialog's own upload first, then the one the last opening
          // made: reopening Publish on an unchanged design attaches what
          // already exists instead of storing the same pixels again.
          reuse: assetRef.current ?? rememberedPublication(workspaceId, rendered.revision),
          trpcClient,
        })
        assetRef.current = saved
        rememberPublication(workspaceId, saved)
        setAsset(saved)
        setProgress(100)
      } catch (error) {
        setRenderError(message(error, 'The design could not be prepared for publishing.'))
      } finally {
        setPreparing(false)
      }
    })()
    running.current = work
    return work.finally(() => {
      if (running.current === work) running.current = null
    })
    // canvas is derived from the memoized preset; config and the name cover the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, design.imageName, preset, projectId, showPreview, trpcClient, workspaceId])

  // Rendering starts with the dialog, so the preview is there by the time the
  // caption is written. A committed post keeps the image it was committed with.
  React.useEffect(() => {
    if (!open || outcome) return
    void prepare()
    // One render per opening; Re-render handles a design that changed after it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  React.useEffect(() => {
    if (!open) return
    void draftsApi
      .settings()
      .then((settings) => setApprovalRequired(settings.requireApproval))
      .catch(() => setApprovalRequired(false))
  }, [open])

  const available = React.useMemo(
    () =>
      (sets.data?.items ?? []).map((set) => ({
        id: set.id,
        name: set.name,
        defaultPlatforms: set.defaultPlatforms,
        timeZone: set.timeZone,
        accounts: set.accounts.flatMap<Destination>((account) => {
          const channel = channelForPlatform(account.platform)
          return channel
            ? [
                {
                  channel,
                  handle: account.handle,
                  health: account.health,
                  id: account.id,
                  name: account.displayName ?? account.handle ?? CHANNEL_META[channel].label,
                  platform: account.platform,
                  standing: {
                    articles: account.xArticles,
                    mastodonQuotes: account.mastodonQuotes,
                    maxWeightedCharacters: account.xCaptionLimit,
                    pollLimits: account.pollLimits,
                    tiktokCreator: account.tiktokCreator,
                    xQuotes: account.xQuotes,
                  },
                },
              ]
            : []
        }),
      })),
    [sets.data]
  )
  const set = available.find((item) => item.id === setId) ?? available[0] ?? null
  const zone = set?.timeZone ?? browserTimeZone()

  // The profile's default platforms, as a new draft would take them.
  const selected = React.useMemo(() => {
    if (chosen) return chosen
    return new Set(
      (set?.accounts ?? [])
        .filter(
          (account) =>
            account.health === 'connected' && set?.defaultPlatforms.includes(account.channel)
        )
        .map((account) => account.id)
    )
  }, [chosen, set])

  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected)
    if (on) next.add(id)
    else next.delete(id)
    setChosen(next)
  }

  const body = React.useMemo(
    () =>
      draftPostBody({
        caption,
        media: asset
          ? [{ alt: altText, id: asset.assetId, mediaType: render?.mimeType ?? 'image/png' }]
          : [],
      }),
    [altText, asset, caption, render?.mimeType]
  )

  /**
   * Each chosen destination with what blocks it. The caption, attachment count
   * and format come from the composer's own builder, so the editor refuses
   * exactly what the composer and the backend refuse; the rendered size and
   * byte count are added here because only the editor can still change them.
   */
  const destinations = React.useMemo(
    () =>
      (set?.accounts ?? [])
        .filter((account) => selected.has(account.id))
        .map((account) => {
          const publication = buildPublication(
            {
              article: null,
              body,
              kind: 'standard',
              platformVersions: EMPTY_PLATFORM_VERSIONS,
              target: null,
            },
            { channel: account.channel, connectionId: account.id, standing: account.standing }
          )
          const facts = render
            ? [
                {
                  bytes: render.blob.size,
                  height: render.height,
                  mimeType: render.mimeType,
                  width: render.width,
                },
              ]
            : []
          const problems = [
            ...new Set([
              ...publication.problems,
              ...(render ? mediaProblems(account.channel, facts) : []),
            ]),
          ]
          if (account.health !== 'connected')
            problems.unshift(
              `${CHANNEL_META[account.channel].label}: ${HEALTH_GUIDANCE[account.health]}`
            )
          return {
            account,
            changes: render ? mediaChanges(account.channel, facts) : [],
            length: publication.serialized.length,
            limit: publication.serialized.limit,
            problems,
          }
        }),
    [body, render, selected, set]
  )

  const [day, setDay] = React.useState(() => dayIn(new Date(Date.now() + 86_400_000), 'UTC'))
  const [time, setTime] = React.useState('09:00')
  React.useEffect(() => setDay(dayIn(new Date(Date.now() + 86_400_000), zone)), [zone])
  const resolution = resolveLocalTime(`${day}T${time}`, zone)
  const instant = resolution.kind === 'exact' ? resolution.at : null

  React.useEffect(() => {
    if (!open || timing !== 'queue' || !set) return
    let active = true
    setQueueNote(null)
    void call<{ times: string[] }>('/api/v1/content-draft-batch/times', {
      body: { count: 1, mode: 'queue', seed: crypto.randomUUID(), socialSetId: set.id },
      method: 'POST',
    })
      .then(({ times }) => {
        if (active) setQueueSlot(times[0] ?? null)
      })
      .catch((error: unknown) => {
        if (!active) return
        setQueueSlot(null)
        setQueueNote(message(error, 'The queue could not be read.'))
      })
    return () => {
      active = false
    }
  }, [open, set, timing])

  const blockers: string[] = []
  if (!canPublish)
    blockers.push(
      'Your role cannot schedule or publish. Save this as a draft for someone who can.'
    )
  if (!render) blockers.push('Wait for the design to finish rendering.')
  else if (!asset) blockers.push('The rendered image is not saved to your workspace yet.')
  if (stale) blockers.push('The design changed after this render. Re-render before publishing.')
  if (destinations.length === 0) blockers.push('Choose at least one account to publish to.')
  for (const destination of destinations) blockers.push(...destination.problems)
  const canCommit = blockers.length === 0 && action === null && !preparing

  /** The draft this post lives in, created once and reused by a retry. */
  async function ensureDraft(): Promise<DraftWire> {
    if (draftRef.current) return draftRef.current
    const created = await draftsApi.create({
      assetIds: asset ? [asset.assetId] : [],
      body,
      channelConnectionIds: [...selected],
      plainText: caption,
      requestKey: requestKeyRef.current,
      socialSetId: set?.id,
      title: caption.slice(0, 80) || (design.imageName ?? 'Design'),
    })
    draftRef.current = created
    return created
  }

  async function commit(next: Action) {
    setAction(next)
    setFailure(null)
    try {
      const draft = await ensureDraft()
      if (next === 'draft') {
        setOutcome({
          detail:
            'It is in Publish with the rendered image attached, ready to schedule whenever you are.',
          draftId: draft.id,
          headline: 'Saved as a draft',
        })
        return
      }
      const result = await draftsApi.schedule(draft.id, {
        channelConnectionIds: [...selected],
        version: draft.version,
        ...(next === 'publish'
          ? { publishNow: true }
          : next === 'queue'
            ? { queue: true, ...(queueSlot ? { expectedQueueSlot: queueSlot } : {}) }
            : { localTime: `${day}T${time}`, timeZone: zone }),
      })
      draftRef.current = result.draft
      setOutcome({
        detail: !result.created
          ? 'This version was already sent to these accounts; nothing was sent twice.'
          : next === 'publish'
            ? 'Submitted. Each destination reports its own result on the draft; nothing is published until its provider confirms.'
            : `Queued for ${result.posts.length} ${result.posts.length === 1 ? 'account' : 'accounts'}. The draft keeps the exact image it was scheduled with.`,
        draftId: draft.id,
        headline:
          next === 'publish' ? 'Publishing now' : next === 'queue' ? 'Added to the queue' : 'Scheduled',
      })
    } catch (error) {
      const nextSlot = error instanceof DraftRequestError ? error.details.nextQueueSlot : undefined
      if (next === 'queue' && typeof nextSlot === 'string') {
        setQueueSlot(nextSlot)
        setQueueNote('That slot was just taken. Review the next free slot and confirm again.')
      } else {
        setFailure(message(error, 'The post could not be committed. Your design is unchanged.'))
      }
    } finally {
      setAction(null)
    }
  }

  const busy = preparing || action !== null
  const openDraft = (id: string) => {
    onOpenChange(false)
    router.push(`/publish/${encodeURIComponent(id)}`)
  }

  return (
    <Dialog onOpenChange={(next) => !busy && onOpenChange(next)} open={open}>
      <DialogContent
        className="max-h-[92dvh] max-w-[calc(100%-1rem)] gap-5 overflow-y-auto p-5 sm:max-w-xl sm:p-6"
        data-testid="editor-publish"
      >
        <DialogHeader className="gap-1.5 text-left">
          <DialogTitle>{outcome ? outcome.headline : 'Publish this design'}</DialogTitle>
          <DialogDescription className="text-xs">
            {outcome
              ? outcome.detail
              : 'The design is exported and saved to your workspace, then posted from there. Your project stays as it is.'}
          </DialogDescription>
        </DialogHeader>

        {outcome ? (
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
              Back to the design
            </Button>
            <Button onClick={() => openDraft(outcome.draftId)} type="button">
              Open the draft
            </Button>
          </div>
        ) : (
          <>
            <PublishPreview
              onRetry={() => void prepare()}
              preparing={preparing}
              preview={preview}
              progress={progress}
              render={render}
              renderError={renderError}
              stale={stale}
              uploaded={Boolean(asset)}
            />

            {returnDraft && asset && render ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2.5">
                <p className="text-xs text-muted-foreground">
                  You opened this image from a draft. Send this render back to it instead of
                  starting a new post.
                </p>
                <Button
                  disabled={busy || stale}
                  onClick={() => {
                    onOpenChange(false)
                    router.push(
                      attachToDraftHref(returnDraft, {
                        id: asset.assetId,
                        mediaType: render.mimeType,
                      })
                    )
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Review it in that draft
                </Button>
              </div>
            ) : null}

            {publishFormatChanged(exportSettings.format) && render ? (
              <p className="text-xs text-muted-foreground">
                {exportSettings.format.toUpperCase()} is not a still image a post can carry, so this
                publishes as PNG. Your export settings are unchanged.
              </p>
            ) : null}

            <section aria-label="Destinations" className="grid gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-ui-lg font-medium">Post to</span>
                {available.length > 1 ? (
                  <Select onValueChange={(value) => { setSetId(value); setChosen(null) }} value={set?.id ?? ''}>
                    <SelectTrigger aria-label="Publishing profile" className="h-8 w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {available.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
              </div>
              {sets.isPending ? (
                <p className="text-xs text-muted-foreground">Loading your accounts…</p>
              ) : (set?.accounts.length ?? 0) === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No social account is connected to this profile yet.{' '}
                  <a
                    className="underline"
                    href={set ? connectHref('x', set.id) : '/settings/social-sets'}
                  >
                    Connect an account
                  </a>{' '}
                  to publish from the editor.
                </p>
              ) : (
                <ul className="grid gap-1.5">
                  {(set?.accounts ?? []).map((account) => {
                    const destination = destinations.find((item) => item.account.id === account.id)
                    return (
                      <li key={account.id}>
                        <Label className="flex items-start gap-2.5 rounded-lg border border-border px-3 py-2.5 text-sm font-normal">
                          <Checkbox
                            aria-label={`Publish to ${account.name}`}
                            checked={selected.has(account.id)}
                            className="mt-0.5"
                            onCheckedChange={(value) => toggle(account.id, value === true)}
                          />
                          <span className="grid min-w-0 gap-1">
                            <span className="flex items-center gap-2">
                              <ChannelIcon channel={account.channel} className="size-4 shrink-0" />
                              <span className="truncate text-foreground">{account.name}</span>
                              {account.handle ? (
                                <span className="truncate text-xs text-muted-foreground">
                                  @{account.handle}
                                </span>
                              ) : null}
                            </span>
                            {account.health !== 'connected' ? (
                              <span className="text-xs text-amber-700 dark:text-amber-300">
                                {HEALTH_GUIDANCE[account.health]}{' '}
                                <a className="underline" href={set ? connectHref(account.platform, set.id, account.id) : '#'}>
                                  Reconnect
                                </a>
                              </span>
                            ) : null}
                            {destination?.problems.map((problem) => (
                              <span className="text-xs text-red-700 dark:text-red-300" key={problem}>
                                {problem}
                              </span>
                            ))}
                            {destination?.changes.map((change) => (
                              <span className="text-xs text-muted-foreground" key={change}>
                                {change}
                              </span>
                            ))}
                          </span>
                        </Label>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>

            <section className="grid gap-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor={captionId}>Caption</Label>
                <span className="text-xs text-muted-foreground">
                  {destinations
                    .map(
                      (destination) =>
                        `${CHANNEL_META[destination.account.channel].label} ${destination.length}/${destination.limit}`
                    )
                    .join(' · ')}
                </span>
              </div>
              <Textarea
                id={captionId}
                maxLength={5_000}
                onChange={(event) => setCaption(event.target.value)}
                placeholder="What should this post say? Per-platform wording and threads are in the composer."
                rows={3}
                value={caption}
              />
              <Textarea
                aria-label="Alt text"
                maxLength={1_000}
                onChange={(event) => setAltText(event.target.value)}
                placeholder="Alt text: describe the image for people using screen readers."
                rows={2}
                value={altText}
              />
            </section>

            <section aria-label="When to publish" className="grid gap-2">
              <SegmentedControl
                ariaLabel="When to publish"
                onChange={(value) => setTiming(value as typeof timing)}
                options={[
                  { id: 'schedule', label: 'At a time' },
                  { id: 'queue', label: 'Next queue slot' },
                  { id: 'now', label: 'Now' },
                ]}
                size="sm"
                value={timing}
              />
              {timing === 'schedule' ? (
                <div className="flex flex-wrap items-end gap-2">
                  <Label className="grid gap-1 text-xs text-muted-foreground">
                    Day
                    <DatePicker
                      aria-label="Publish day"
                      min={dayIn(new Date(), zone)}
                      onChange={setDay}
                      value={day}
                    />
                  </Label>
                  <Label className="grid gap-1 text-xs text-muted-foreground">
                    Time
                    <TimePicker aria-label="Publish time" onChange={setTime} value={time} />
                  </Label>
                  <span className="pb-2 text-xs text-muted-foreground">{zone}</span>
                </div>
              ) : timing === 'queue' ? (
                <p className="text-xs text-muted-foreground">
                  {queueNote ??
                    (queueSlot
                      ? `Next free slot: ${new Date(queueSlot).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: zone })} · ${zone}`
                      : 'Finding the next free slot in this profile’s queue…')}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Sends to every chosen account at once. Each destination reports its own result;
                  nothing shows as published before its provider confirms.
                </p>
              )}
            </section>

            {approvalRequired ? (
              <p className="rounded-lg border border-amber-400/40 bg-amber-500/[0.04] px-3 py-2 text-xs">
                This workspace approves drafts before they publish. Save the draft here, then ask
                for review in the composer.
              </p>
            ) : null}

            {blockers.length > 0 ? (
              <ul className="grid gap-1 rounded-lg border border-red-500/30 bg-red-500/[0.04] px-3 py-2" data-testid="publish-blockers">
                {[...new Set(blockers)].map((blocker) => (
                  <li className="text-xs text-red-700 dark:text-red-300" key={blocker}>
                    {blocker}
                  </li>
                ))}
              </ul>
            ) : null}

            {failure ? (
              <p className="rounded-lg border border-red-500/30 bg-red-500/[0.04] px-3 py-2 text-xs text-red-700 dark:text-red-300" role="alert">
                {failure} Your design and this post are kept; try again.
              </p>
            ) : null}

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
              <Button
                className="mr-auto"
                disabled={busy || !asset || stale}
                onClick={() => void commit('draft')}
                type="button"
                variant="outline"
              >
                {action === 'draft' ? 'Saving…' : 'Save as draft'}
              </Button>
              <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
                Cancel
              </Button>
              <Button
                disabled={
                  !canCommit ||
                  approvalRequired ||
                  (timing === 'schedule' && (!instant || instant.getTime() <= Date.now())) ||
                  (timing === 'queue' && !queueSlot)
                }
                onClick={() => void commit(timing === 'now' ? 'publish' : timing === 'queue' ? 'queue' : 'schedule')}
                type="button"
              >
                {action === 'publish'
                  ? 'Publishing…'
                  : action === 'queue' || action === 'schedule'
                    ? 'Scheduling…'
                    : timing === 'now'
                      ? 'Publish now'
                      : timing === 'queue'
                        ? 'Add to queue'
                        : 'Schedule'}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** The exact bytes that will be posted: what they are, and how to replace them. */
function PublishPreview({
  onRetry,
  preparing,
  preview,
  progress,
  render,
  renderError,
  stale,
  uploaded,
}: {
  onRetry: () => void
  preparing: boolean
  preview: string | null
  progress: number
  render: PublicationRender | null
  renderError: string | null
  stale: boolean
  uploaded: boolean
}) {
  return (
    <section aria-label="Image to publish" className="grid gap-2">
      <div className="flex gap-3 rounded-lg border border-border p-3">
        <div className="grid size-24 shrink-0 place-items-center overflow-hidden rounded-md bg-foreground/[0.04]">
          {preview ? (
            // The rendered bytes themselves through an object URL, not a
            // canvas screenshot and not a remote asset: what is shown here is
            // exactly what uploads, so next/image has nothing to optimize.
            <img alt="Image to publish" className="size-full object-contain" src={preview} />
          ) : (
            <span className="text-xs text-muted-foreground">…</span>
          )}
        </div>
        <div className="grid min-w-0 content-start gap-1">
          {render ? (
            <p className="text-xs text-muted-foreground" data-testid="publish-image-facts">
              {render.width} × {render.height} · {render.config.format.toUpperCase()} ·{' '}
              {fileSize(render.blob.size)}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground" role="status">
            {renderError
              ? renderError
              : preparing
                ? render
                  ? `Saving to your workspace… ${progress}%`
                  : 'Rendering the design…'
                : uploaded
                  ? 'Saved to your workspace.'
                  : 'Not saved yet.'}
          </p>
          <div className="flex flex-wrap gap-2">
            {preview ? (
              <Button asChild size="sm" variant="outline">
                <a href={preview} rel="noopener noreferrer" target="_blank">
                  <ArrowSquareOutIcon /> View full size
                </a>
              </Button>
            ) : null}
            {renderError || stale ? (
              <Button disabled={preparing} onClick={onRetry} size="sm" type="button">
                {renderError ? 'Try again' : 'Re-render'}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
      {stale ? (
        <p className="text-xs text-amber-700 dark:text-amber-300" role="status">
          The design changed after this render. Re-render so the post carries what you see now.
        </p>
      ) : null}
    </section>
  )
}
