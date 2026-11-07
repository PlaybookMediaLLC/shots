'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { DRAFT_ACCOUNT_LIMIT } from '@/lib/api/contracts/content-drafts'
import type { ContentBatch } from '@/lib/api/contracts/content-batches'
import { call, draftsApi } from '@/lib/content-drafts/client'
import { DRAFT_CHANNEL_LIMITS, draftPlainText } from '@/lib/content-drafts/serialize'
import {
  exportFileName,
  type HandoffDesign,
  postHandoff,
  RENDERED_MEDIA_TYPE,
  renderDesign,
  renderLiveDesign,
  usePostHandoff,
} from '@/lib/editor/post-handoff'
import { usePublishSets, useRecommendedTimes } from '@/lib/editor/use-publish-targets'
import type { DesignDocument } from '@/lib/design/document'
import { exportDesignDocument } from '@/lib/design/export'
import { adaptDocumentToSize, canvasSizeOf, documentCanvasSize } from '@/lib/export/adapt'
import { imageAspectOf } from '@/lib/export/export-design'
import type { ExportTarget } from '@/lib/export/sizes'
import { draftAssetNode } from '@/lib/platform/asset-handoff'
import { readEditorReturn } from '@/lib/platform/editor-handoff'
import { useProjectSession } from '@/lib/projects/session'
import { useImageStore } from '@/lib/store'
import { useTRPCClient } from '@/lib/trpc/react'
import { engagementAutomation, followUpLines } from '@/lib/write/automation'
import { CAPABILITIES } from '@/lib/write/capabilities'
import type { DraftChannel } from '@/lib/write/document'
import { THREAD_POST_LIMIT } from '@/lib/write/import-text'
import type { MediaFacts } from '@/lib/write/media-rules'
import {
  accountsOn,
  captionChannelText,
  captionFor,
  captionsOverLimit,
  carriedFollowUps,
  explanationPosts,
  platformAcceptsSize,
  type PostMedia,
  postRenders,
  primaryFor,
  screenshotBatchItem,
  screenshotMediaProblems,
  screenshotPostBody,
  screenshotPostVersions,
  screenshotPrompts,
} from '@/lib/write/screenshot-post'
import { buildExportFileName, WorkspaceSaveError } from '@/lib/workspace/save-export'

/**
 * Prepare posts from the editor: the one place a design becomes something
 * Publish owns. It opens from the export controls ("Use in post"), the AI
 * Captions and Variants panels, and batch export, and hands each design to
 * a draft (with its thread, its profile's X follow-ups and a recommended
 * time) or to a bulk batch that schedules a day of screenshots together.
 *
 * - The accounts chosen here are the draft's; each one posts the caption
 *   the Captions panel wrote for its platform, or the body when it has none.
 * - Every AI version can become its own draft, for review side by side.
 * - A visual opened from a campaign keeps that campaign's generated copy.
 * - Shapes and captions a chosen platform would refuse are reported before
 *   anything renders, and the rendered bytes are checked again before a
 *   draft is made.
 */

/** A campaign's generated draft post, offered as the caption to start from. */
type CampaignCopy = { id: string; channel: string; title: string; copy: string }

/** What a campaign contributes to this post: its name and the copy written for it. */
type CampaignContext = { id: string; name: string; posts: CampaignCopy[] }

/** Where the prepared post goes. */
type Destination = 'draft' | 'batch'

/** Chosen in place of a batch that is already open. */
const NEW_BATCH = 'new'

/** No calendar placement: the drafts wait in Publish. */
const NO_TIME = 'none'

/** A screenshot already rendered elsewhere, such as a batch export's. */
export type ReadyExport = { blob: Blob; name: string }

/** Props of {@link PrepareScreenshotPost}. */
export type PrepareScreenshotPostProps = {
  /**
   * Renders the open design. Called on submit only: an export is expensive.
   * Without one, the design is rendered as the editor's default still.
   */
  createExport?: () => Promise<Blob>
  /** The type `createExport` produces, so each platform's rules can be checked first. */
  mediaType?: string
  /**
   * Screenshots already rendered (batch export), posted one each instead of
   * the open design. The editor's captions describe the open design, so
   * they are not attached to these.
   */
  exports?: readonly ReadyExport[]
  fileName?: string
  /** Where the post goes first. */
  initialDestination?: Destination
  onOpenChange: (open: boolean) => void
  open: boolean
  /** Start with one draft per AI version, when the Variants panel has some. */
  startWithVersions?: boolean
}

/**
 * A recommended time in the profile's zone. A zone the browser does not
 * know throws, and a label must never take the dialog down with it.
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

/** "1 draft", "4 drafts". */
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

export function PrepareScreenshotPost({
  createExport,
  exports,
  fileName,
  initialDestination = 'draft',
  mediaType,
  onOpenChange,
  open,
  startWithVersions = false,
}: PrepareScreenshotPostProps) {
  const router = useRouter()
  const trpcClient = useTRPCClient()
  const id = React.useId()
  // Null until typed: the caption follows the one the editor wrote for the
  // platform that opens the post, and becomes the writer's once edited.
  const [caption, setCaption] = React.useState<string | null>(null)
  const [explanation, setExplanation] = React.useState('')
  const [bySize, setBySize] = React.useState(false)
  const [postLength, setPostLength] = React.useState(0)
  const [promptId, setPromptId] = React.useState('')
  const [keepFollowUps, setKeepFollowUps] = React.useState(false)
  const [destination, setDestination] = React.useState<Destination>(initialDestination)
  const [batchId, setBatchId] = React.useState(NEW_BATCH)
  const [batchTitle, setBatchTitle] = React.useState(
    () => `Screenshots ${new Date().toLocaleDateString()}`
  )
  const [batches, setBatches] = React.useState<ContentBatch[]>([])
  // A batch this dialog started: a retry after a failed staging reuses it
  // rather than leaving a trail of empty batches.
  const startedBatch = React.useRef('')
  const [campaign, setCampaign] = React.useState<CampaignContext | null>(null)
  const [campaignNotice, setCampaignNotice] = React.useState('')
  // The generated post the caption came from, recorded with the draft.
  const [campaignPostId, setCampaignPostId] = React.useState('')
  const [everyVersion, setEveryVersion] = React.useState(startWithVersions)
  const [selected, setSelected] = React.useState<string[]>([])
  const [plannedFor, setPlannedFor] = React.useState(NO_TIME)
  const [fitToPlatforms, setFitToPlatforms] = React.useState(true)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  // One upload per design and one key per distinct request for as long as
  // the dialog is open, so retrying replays what was already made.
  const [session] = React.useState(() =>
    postHandoff(
      trpcClient,
      exports ? undefined : (useProjectSession.getState().projectId ?? undefined)
    )
  )
  // Only the visual opened from a campaign belongs to it; a batch export's
  // other screenshots do not.
  const campaignId = React.useMemo(
    () => (open && !exports ? readEditorReturn(window.location.search).campaignId : undefined),
    [exports, open]
  )

  // Profiles and their accounts. A failure here leaves the draft path
  // working: the backend resolves the default profile and platforms itself.
  const { defaultSetId, sets, status } = usePublishSets(open)
  const chosenSetId = usePostHandoff((state) => state.socialSetId)
  const chooseSet = usePostHandoff((state) => state.setSocialSetId)
  const setId =
    (chosenSetId && sets.some((item) => item.id === chosenSetId) ? chosenSetId : defaultSetId) ?? ''
  const set = sets.find((item) => item.id === setId)
  const versions = usePostHandoff((state) => state.versions)
  // The editor's alt text and captions describe the open design and its
  // versions; a batch export's screenshots are other images.
  const editorCopy = useImageStore((state) => state.copy)
  const copy = exports ? null : editorCopy
  const aspectRatio = useImageStore((state) => state.selectedAspectRatio)
  const custom = useImageStore((state) => state.customDimensions)
  const times = useRecommendedTimes(set?.id, open && destination === 'draft')

  // A profile's own accounts are the choices; switching profiles starts
  // from its default platforms (RFC 024) rather than the last one's picks.
  const accountKey = set ? `${set.id}:${set.accounts.map((account) => account.id).join(',')}` : ''
  const applied = React.useRef('')
  React.useEffect(() => {
    if (applied.current === accountKey) return
    applied.current = accountKey
    setSelected(
      set
        ? accountsOn(set.accounts, set.defaultChannels)
            .slice(0, DRAFT_ACCOUNT_LIMIT)
            .map((account) => account.id)
        : []
    )
    setPlannedFor(NO_TIME)
  }, [accountKey, set])

  // The open batches this can go to.
  React.useEffect(() => {
    if (!open) return
    let live = true
    void call<{ batches: ContentBatch[] }>('/api/v1/content-batches')
      .then((list) => {
        if (live) setBatches(list.batches)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [open])

  // A visual opened from a campaign brings that campaign's generated copy, so
  // an edited creative publishes with the words it was written for.
  React.useEffect(() => {
    if (!open || !campaignId) return
    let live = true
    void trpcClient.campaign.get
      .query({ campaignId })
      .then((result) => {
        if (!live) return
        setCampaign({
          id: result.campaign.id,
          name: result.campaign.name,
          posts: result.campaign.posts
            .filter((post) => post.copy.trim())
            .map((post) => ({
              channel: post.channel,
              copy: post.copy,
              id: post.id,
              title: post.title ?? post.channel,
            })),
        })
      })
      .catch((failure: unknown) => {
        // The handoff still names the campaign; only its generated copy is missing.
        if (live)
          setCampaignNotice(
            failure instanceof Error
              ? `This campaign's copy could not load: ${failure.message}`
              : "This campaign's copy could not load."
          )
      })
    return () => {
      live = false
    }
  }, [campaignId, open, trpcClient])

  const accounts = set?.accounts ?? []
  const chosen = accounts.filter((account) => selected.includes(account.id))
  const channels: DraftChannel[] = [...new Set(chosen.map((account) => account.channel))]
  // The platform that opens the post: its caption is the body, and its
  // length is the thread's.
  const channel = primaryFor(channels, copy, set?.primaryChannel)
  const body = caption ?? captionFor(copy, channel)
  // Every other chosen platform the editor wrote a caption for posts that.
  const channelText = captionChannelText(copy, channels, channel)
  const ownCaptions = Object.keys(channelText) as DraftChannel[]
  const overLimit = captionsOverLimit({ body, channels, copy, primary: channel })
  const limit = DRAFT_CHANNEL_LIMITS[channel]
  // A length typed for one profile must not block another: it applies only
  // while splitting by length, and the profile's own limit is the default.
  const length = bySize ? postLength || limit : limit
  // Only the follow-ups a new draft can actually carry; the rest stay in Publish.
  const followUps = carriedFollowUps(engagementAutomation(set?.engagementDefaults))
  // A batch publishes as its own profile's accounts, so only that profile's are offered.
  const openBatches = batches.filter((batch) => !setId || batch.socialSetId === setId)
  const chosenBatch = openBatches.some((batch) => batch.id === batchId) ? batchId : NEW_BATCH
  const hasX = channels.includes('x')
  const autoDm = CAPABILITIES.x.automation.directMessage
  // A slot the latest reading no longer offers is no choice at all.
  const when = times.some((time) => time.at === plannedFor) ? plannedFor : NO_TIME

  // What is being posted: the batch export's screenshots, every AI version,
  // or the open design.
  const posting = exports ? 'exports' : everyVersion && versions.length > 0 ? 'versions' : 'live'
  const count = exports ? exports.length : posting === 'versions' ? versions.length : 1
  // One render per distinct platform size. Offered only when it changes
  // something and there is a design to lay out again: a batch export's
  // screenshots are already rendered, so they keep the shape they have.
  const renders = postRenders(channels)
  const canFit = renders.length > 1 && posting !== 'exports'
  const fitting = fitToPlatforms && canFit
  // The render the body's platform posts; every other render is a version.
  const primaryRender = renders.find((render) => render.channels.includes(channel))
  // The shapes the platforms will see, measured before anything renders. A
  // version can change the canvas, so each is measured on its own; the
  // export is a multiple of the canvas, so the proportions are the canvas's.
  const shapes: MediaFacts[] = exports
    ? exports.map((item) => ({ mimeType: item.blob.type }))
    : posting === 'versions'
      ? versions.map((version) => ({
          mimeType: RENDERED_MEDIA_TYPE,
          ...documentCanvasSize(version.document),
        }))
      : [
          {
            mimeType: mediaType ?? RENDERED_MEDIA_TYPE,
            ...canvasSizeOf(aspectRatio, custom ?? undefined),
          },
        ]
  const mediaWarnings = fitting
    ? [
        ...new Set(
          renders.flatMap((render) =>
            screenshotMediaProblems(render.channels, {
              height: render.target.height,
              mimeType: RENDERED_MEDIA_TYPE,
              width: render.target.width,
            })
          )
        ),
      ]
    : [...new Set(shapes.flatMap((shape) => screenshotMediaProblems(channels, shape)))]
  // Platforms that would refuse the canvas as it stands, named when the
  // offer to draw their own size is turned down.
  const refusedCanvas = canFit
    ? channels.filter((platform) =>
        shapes.some(({ height, width }) =>
          height && width ? !platformAcceptsSize(platform, { height, width }) : false
        )
      )
    : []
  const thread = React.useMemo(() => {
    if (!explanation.trim()) return { error: '', posts: [] as string[] }
    try {
      return {
        error: '',
        posts: explanationPosts(explanation, channel, bySize ? length : undefined),
      }
    } catch (failure) {
      return {
        error: failure instanceof Error ? failure.message : 'This text cannot be split.',
        posts: [] as string[],
      }
    }
  }, [bySize, channel, explanation, length])
  // A batch item is one caption and its media; a thread belongs to a draft.
  const threading = destination === 'draft' && thread.posts.length > 0
  // The caption is the opening post, so the explanation fills the rest.
  const tooLong = threading && 1 + thread.posts.length > THREAD_POST_LIMIT
  const blocked = thread.error
    ? thread.error
    : tooLong
      ? `A thread holds ${THREAD_POST_LIMIT} posts, and this would be ${1 + thread.posts.length}. Shorten the explanation.`
      : length > limit
        ? `${set?.name ?? 'This profile'} posts up to ${limit} characters, so the post length must be ${limit} or less.`
        : // A batch shows what each account refuses and lets it be removed
          // there; a draft has no such step before it exists.
          destination === 'draft' && mediaWarnings.length > 0
          ? 'Choose other accounts, or change the design, before making the draft.'
          : ''

  /** The designs to post, as the handoff stores them. */
  function designs(): HandoffDesign[] {
    if (exports)
      return exports.map((item, index) => ({
        fileName: (type) => exportFileName(item.name, type),
        key: `export:${index}:${item.name}`,
        name: item.name,
        render: async () => item.blob,
      }))
    const altText = editorCopy?.altText
    if (posting === 'versions')
      return versions.map((version, index) => ({
        altText,
        fileName: (type) => exportFileName(version.title, type),
        key: `version:${index}:${version.title}`,
        name: version.title,
        render: () => renderDesign(version.document),
      }))
    return [
      {
        altText,
        fileName: (type) => fileName ?? buildExportFileName(type),
        key: 'design',
        name: 'Screenshot post',
        render: createExport ?? renderLiveDesign,
      },
    ]
  }

  /**
   * The design laid out again at `target`, as its own upload. Keyed by the
   * size so each is stored once and a retry reuses it.
   */
  function renderAt(
    design: HandoffDesign,
    document: DesignDocument,
    target: ExportTarget
  ): HandoffDesign {
    return {
      ...design,
      fileName: (type) => exportFileName(`${design.name}-${target.id}`, type),
      key: `${design.key}:${target.id}`,
      render: async () =>
        renderDesign(
          adaptDocumentToSize(document, target, {
            imageAspect: await imageAspectOf(document.image.src),
          })
        ),
    }
  }

  /** The design behind one post, when there is one to lay out again. */
  function documentFor(index: number): DesignDocument | null {
    if (exports) return null
    if (posting === 'versions') return versions[index]?.document ?? null
    return exportDesignDocument({ keepLocalSources: true })
  }

  /** One design's draft, everything but its request key. */
  function draftFor(
    asset: { assetId: string; mediaType: string },
    design: HandoffDesign,
    /** The picture drawn for a platform, where it is not the body's. */
    platformMedia: Partial<Record<DraftChannel, PostMedia>> = {}
  ) {
    const postBody = screenshotPostBody({
      altText: design.altText,
      caption: body,
      media: [draftAssetNode({ id: asset.assetId, mediaType: asset.mediaType })],
      ...(threading ? { thread: thread.posts } : {}),
    })
    const platformVersions = screenshotPostVersions({
      automation: keepFollowUps && hasX ? followUps : undefined,
      body: postBody,
      channelText,
      media: platformMedia,
    })
    // In the library: the campaign it belongs to, the version it is, or
    // the caption's first line, as bulk posts are named.
    const title = campaign
      ? campaign.name
      : count > 1
        ? design.name
        : body.trim().split('\n')[0]?.slice(0, 80)
    return {
      assetIds: [
        ...new Set([
          asset.assetId,
          ...Object.values(platformMedia).map((media) => media.assetId),
        ]),
      ],
      body: postBody,
      plainText: draftPlainText(postBody),
      ...(chosen.length > 0
        ? { channelConnectionIds: chosen.map((account) => account.id), primaryPlatform: channel }
        : {}),
      ...(platformVersions ? { platformVersions } : {}),
      ...(setId ? { socialSetId: setId } : {}),
      ...(title ? { title: title.slice(0, 200) } : {}),
    }
  }

  async function submit() {
    setError(null)
    const list = designs()
    const step = (index: number, what: string) =>
      setBusy(list.length > 1 ? `${what} ${index + 1} of ${list.length}…` : `${what}…`)
    let made = 0
    try {
      if (destination === 'batch') {
        const items = []
        for (const [index, design] of list.entries()) {
          step(index, 'Saving')
          const { assetId } = await session.store(design)
          const content = {
            assetId,
            caption: body.trim(),
            channelConnectionIds: chosen.map((account) => account.id),
            // Kept so a caption CSV on the batch page can name the post.
            sourceKey: exports ? design.name.slice(0, 255) : fileName,
          }
          items.push(
            session.request(['batch', content], (importKey) =>
              screenshotBatchItem({ ...content, importKey })
            ).input
          )
        }
        setBusy('Adding to the batch…')
        const batch =
          chosenBatch === NEW_BATCH
            ? startedBatch.current
              ? { id: startedBatch.current }
              : await call<ContentBatch>('/api/v1/content-batches', {
                  body: { socialSetId: setId || undefined, title: batchTitle.trim() },
                  method: 'POST',
                })
            : { id: chosenBatch }
        startedBatch.current = batch.id
        await call<ContentBatch>(`/api/v1/content-batches/${encodeURIComponent(batch.id)}/items`, {
          body: { items },
          method: 'POST',
        })
        onOpenChange(false)
        router.push(`/publish/batches/${encodeURIComponent(batch.id)}`)
        return
      }
      const drafts: { id: string }[] = []
      for (const [index, design] of list.entries()) {
        step(index, campaignId ? 'Attaching to the campaign' : 'Preparing draft')
        const document = fitting ? documentFor(index) : null
        // Fitting draws the body at the primary platform's size too, so the
        // post it opens is the picture that platform will publish.
        const main =
          document && primaryRender ? renderAt(design, document, primaryRender.target) : design
        const asset = await session.store(main)
        // The rendered bytes, which can differ from the shape checked above
        // (an export's own format, a screenshot of any size). Only the
        // platforms that share this picture are measured against it.
        const sharing = document && primaryRender ? primaryRender.channels : channels
        const refused = screenshotMediaProblems(sharing, asset.facts)
        if (refused.length > 0) throw new Error(refused.join(' '))
        // Every other distinct size, each stored once and checked on its own bytes.
        const platformMedia: Partial<Record<DraftChannel, PostMedia>> = {}
        for (const render of document ? renders : []) {
          if (!document || render.target.id === primaryRender?.target.id) continue
          const sized = await session.store(renderAt(design, document, render.target))
          const sizedRefused = screenshotMediaProblems(render.channels, sized.facts)
          if (sizedRefused.length > 0) throw new Error(sizedRefused.join(' '))
          const node = draftAssetNode({ id: sized.assetId, mediaType: sized.mediaType })
          for (const platform of render.channels) platformMedia[platform] = node
        }
        const caption = body.trim().slice(0, 4_000)
        // Everything the draft depends on, and nothing generated: the same
        // choices on a retry reuse the same built draft and key, so the
        // backend returns the draft it already made rather than a second.
        const { input, key: requestKey } = session.request(
          [
            'draft',
            design.key,
            asset.assetId,
            body,
            threading ? thread.posts : null,
            chosen.map((account) => account.id),
            channel,
            channelText,
            keepFollowUps && hasX ? followUps : null,
            setId,
            campaignId,
            campaign?.name,
            campaignPostId,
            count,
            Object.entries(platformMedia).map(([platform, media]) => [platform, media.assetId]),
          ],
          () => draftFor(asset, design, platformMedia)
        )
        let draft = campaignId
          ? // One call: the backend links the export to the campaign and
            // creates the draft together, so the campaign never gains an
            // orphan image. The campaign's own copy may have failed to load;
            // the link is still made, and a campaign the member cannot write
            // to fails here loudly rather than becoming an unlinked draft.
            (
              await trpcClient.campaign.publishDraft.mutate({
                assetId: asset.assetId,
                campaignId,
                draft: { ...input, requestKey },
                ...(campaignPostId ? { campaignPostId } : {}),
                ...(caption ? { caption } : {}),
              })
            ).draft
          : await draftsApi.create({ ...input, requestKey })
        if (when !== NO_TIME)
          draft = await draftsApi.save(draft.id, { baseVersion: draft.version, plannedFor: when })
        drafts.push(draft)
        made += 1
      }
      onOpenChange(false)
      const first = drafts[0]!
      if (drafts.length === 1) {
        const prompt = screenshotPrompts().find((item) => item.id === promptId)
        const query = new URLSearchParams()
        if (prompt) {
          query.set('panel', 'assistant')
          query.set('prompt', prompt.id)
        }
        router.push(`/publish/${encodeURIComponent(first.id)}${query.size ? `?${query}` : ''}`)
        return
      }
      toast.success(`${plural(drafts.length, 'draft')} created`, {
        action: { label: 'Open Publish', onClick: () => router.push('/publish') },
        description: 'Each one waits in Publish for review; nothing has been posted.',
      })
    } catch (failure) {
      const message =
        failure instanceof WorkspaceSaveError || failure instanceof Error
          ? failure.message
          : 'The post could not be prepared. Your design is unchanged.'
      const partial =
        made > 0
          ? ` ${made} of ${list.length} drafts were made; trying again finishes the rest without making those twice.`
          : ''
      setError(message + partial)
      toast.error('Could not prepare the post', { description: message + partial })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{count > 1 ? `Prepare ${count} posts` : 'Prepare post'}</DialogTitle>
          <DialogDescription>
            {exports
              ? `${plural(exports.length, 'rendered screenshot')} are saved to your workspace, then go to Publish one post each: as drafts to review, or into a batch you schedule together.`
              : 'The export is saved to your workspace, then goes to Publish as a draft you can review, or into a batch you schedule with the rest of the day’s screenshots.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {!exports && versions.length > 0 ? (
            <Label className="flex items-start gap-2 text-sm font-normal">
              <Checkbox
                checked={everyVersion}
                onCheckedChange={(checked) => setEveryVersion(checked === true)}
              />
              <span className="grid gap-0.5">
                <span>One post for each of the {versions.length} AI versions</span>
                <span className="text-xs text-muted-foreground">
                  Each version is rendered as previewed in Variants and becomes its own post, so
                  they can be compared in Publish. Off posts the design as it is now.
                </span>
              </span>
            </Label>
          ) : null}
          {campaignNotice ? (
            <p className="text-xs text-muted-foreground" role="status">
              {campaignNotice} The post is still attached to the campaign.
            </p>
          ) : null}
          {campaign && campaign.posts.length > 0 ? (
            <Label className="grid gap-1.5 text-sm">
              Start from {campaign.name}&rsquo;s copy
              <Select
                onValueChange={(value) => {
                  setCampaignPostId(value)
                  setCaption(campaign.posts.find((post) => post.id === value)?.copy ?? '')
                }}
                value={campaignPostId}
              >
                <SelectTrigger aria-label="Campaign copy">
                  <SelectValue placeholder="Choose a generated post…" />
                </SelectTrigger>
                <SelectContent>
                  {campaign.posts.map((post) => (
                    <SelectItem key={post.id} value={post.id}>
                      {post.title} · {post.channel}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Label>
          ) : null}
          {sets.length > 0 ? (
            <Label className="grid gap-1.5 text-sm">
              Profile
              <Select onValueChange={chooseSet} value={setId}>
                <SelectTrigger aria-label="Profile">
                  <SelectValue placeholder="Choose a profile…" />
                </SelectTrigger>
                <SelectContent>
                  {sets.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Label>
          ) : status === 'loading' ? (
            <p className="text-xs text-muted-foreground" role="status">
              Loading your profiles…
            </p>
          ) : null}
          {accounts.length > 0 ? (
            <fieldset className="grid gap-1.5">
              <legend className="mb-1 text-sm font-medium">Post to</legend>
              {accounts.map((account) => {
                const on = selected.includes(account.id)
                return (
                  <Label className="flex items-center gap-2 text-sm font-normal" key={account.id}>
                    <Checkbox
                      checked={on}
                      // A draft names at most this many accounts; the API refuses more.
                      disabled={!on && selected.length >= DRAFT_ACCOUNT_LIMIT}
                      onCheckedChange={(checked) =>
                        setSelected((current) =>
                          checked === true
                            ? [...current, account.id]
                            : current.filter((value) => value !== account.id)
                        )
                      }
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {CAPABILITIES[account.channel].label} · {account.name}
                    </span>
                    {copy && captionFor(copy, account.channel) ? (
                      <span className="text-xs text-muted-foreground">Has its own caption</span>
                    ) : null}
                  </Label>
                )
              })}
              {selected.length >= DRAFT_ACCOUNT_LIMIT ? (
                <p className="text-xs text-muted-foreground">
                  One post goes to at most {DRAFT_ACCOUNT_LIMIT} accounts.
                </p>
              ) : null}
            </fieldset>
          ) : null}
          <Label className="grid gap-1.5 text-sm" htmlFor={`${id}-caption`}>
            {channels.length > 0 ? `Caption · ${CAPABILITIES[channel].label}` : 'Caption'}
            <Textarea
              id={`${id}-caption`}
              maxLength={100_000}
              onChange={(event) => setCaption(event.target.value)}
              placeholder="Optional. You can also write it in Publish."
              rows={3}
              value={body}
            />
          </Label>
          {destination === 'draft' && ownCaptions.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {ownCaptions.map((item) => CAPABILITIES[item].label).join(', ')}{' '}
              {ownCaptions.length === 1 ? 'posts the caption' : 'post the captions'} written for{' '}
              {ownCaptions.length === 1 ? 'it' : 'them'} in the editor&rsquo;s Captions panel; the
              others post this one.
            </p>
          ) : null}
          {overLimit.map((problem) => (
            <p className="text-xs text-destructive" key={problem.channel} role="status">
              {problem.reused
                ? `${CAPABILITIES[problem.channel].label} would post this caption, which is ${problem.length} characters there; its limit is ${problem.limit}. Shorten it, or write a ${CAPABILITIES[problem.channel].label} caption in the editor’s Captions panel.`
                : `The ${CAPABILITIES[problem.channel].label} caption is ${problem.length} characters; the limit is ${problem.limit}. Shorten it before scheduling.`}
            </p>
          ))}
          <Disclosure className="rounded-lg border border-border p-3">
            <DisclosureTrigger>Turn a longer explanation into a thread</DisclosureTrigger>
            <DisclosureContent>
              <p className="my-2 text-xs text-muted-foreground">
                The screenshot stays on the opening post. Separate posts with a line containing ---
                or four line breaks, or split by length.
              </p>
              <Textarea
                aria-label="Longer explanation"
                maxLength={100_000}
                onChange={(event) => setExplanation(event.target.value)}
                rows={6}
                value={explanation}
              />
              <Label className="mt-2 flex gap-2 text-sm">
                <Checkbox
                  checked={bySize}
                  onCheckedChange={(checked) => setBySize(checked === true)}
                />
                Split by post length
              </Label>
              {bySize ? (
                <Label className="mt-2 block text-sm">
                  Maximum post length
                  <Input
                    max={limit}
                    min={23}
                    onChange={(event) => setPostLength(Number(event.target.value))}
                    type="number"
                    value={length}
                  />
                </Label>
              ) : null}
              {thread.posts.length > 0 ? (
                <>
                  <p className="mt-2 text-xs text-muted-foreground">
                    The caption is post 1, with the screenshot. These follow it.
                  </p>
                  <ol className="mt-1 grid max-h-48 gap-2 overflow-auto text-xs">
                    {thread.posts.map((post, index) => (
                      <li className="whitespace-pre-wrap rounded border p-2" key={index}>
                        <strong>{index + 2}.</strong> {post}
                      </li>
                    ))}
                  </ol>
                </>
              ) : null}
              {destination === 'batch' && thread.posts.length > 0 ? (
                <p className="mt-2 text-xs text-muted-foreground" role="status">
                  A batch item is one post. Send this to a draft to keep the thread.
                </p>
              ) : null}
            </DisclosureContent>
          </Disclosure>
          {/* The draft opens with the instruction waiting, so it applies to one draft. */}
          {count === 1 ? (
            <Disclosure className="rounded-lg border border-border p-3">
              <DisclosureTrigger>Ask the writing assistant to draft it</DisclosureTrigger>
              <DisclosureContent>
                <p className="my-2 text-xs text-muted-foreground">
                  The draft opens with this instruction waiting in the assistant, which answers in
                  your profile&rsquo;s voice and treats the caption above as your notes. Examples
                  show a structure; the facts stay yours.
                </p>
                <ul className="grid gap-2">
                  {screenshotPrompts().map((prompt) => (
                    <li key={prompt.id}>
                      <Button
                        aria-pressed={promptId === prompt.id}
                        onClick={() => setPromptId(promptId === prompt.id ? '' : prompt.id)}
                        size="sm"
                        type="button"
                        variant={promptId === prompt.id ? 'default' : 'outline'}
                      >
                        {prompt.title}
                      </Button>
                      <p className="mt-1 text-xs text-muted-foreground">{prompt.example}</p>
                    </li>
                  ))}
                </ul>
              </DisclosureContent>
            </Disclosure>
          ) : null}
          {destination === 'draft' && hasX ? (
            <div className="grid gap-2 rounded-lg border border-border p-3">
              <div className="flex items-start justify-between gap-3">
                <span className="min-w-0 text-sm">
                  X follow-ups
                  <span className="block text-xs text-muted-foreground">
                    {followUps
                      ? `${set?.name}’s saved Auto-RT and Auto-Plug settings, carried onto this draft. Change them in Publish before scheduling.`
                      : `${set?.name} has no saved follow-ups. Set Auto-RT or Auto-Plug on the profile, or on the draft in Publish.`}
                  </span>
                </span>
                <Switch
                  aria-label="X follow-ups"
                  checked={keepFollowUps && Boolean(followUps)}
                  disabled={!followUps}
                  onCheckedChange={(checked) => setKeepFollowUps(checked === true)}
                />
              </div>
              {keepFollowUps && followUps ? (
                <ul className="grid gap-1 text-xs text-muted-foreground">
                  {followUpLines(followUps, undefined, 'X').map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : null}
              {autoDm.available ? null : (
                <p className="text-xs text-muted-foreground">Auto-DM: {autoDm.reason}</p>
              )}
            </div>
          ) : null}
          <div className="grid gap-2">
            <p className="text-sm font-medium">Where it goes</p>
            <RadioGroup
              aria-label="Where it goes"
              className="grid gap-2"
              onValueChange={(value) => setDestination(value === 'batch' ? 'batch' : 'draft')}
              value={destination}
            >
              <Label className="items-start gap-2 font-normal">
                <RadioGroupItem value="draft" />
                <span className="grid gap-0.5">
                  <span>A new draft in Publish</span>
                  <span className="text-xs text-muted-foreground">
                    Review it, write the thread, and schedule it on its own.
                  </span>
                </span>
              </Label>
              <Label className="items-start gap-2 font-normal">
                <RadioGroupItem value="batch" />
                <span className="grid gap-0.5">
                  <span>A bulk batch</span>
                  <span className="text-xs text-muted-foreground">
                    Prepare a day of screenshots, then set destinations, times and intervals once
                    and schedule them together.
                    {campaign ? ' A batch item is not linked back to the campaign.' : ''}
                  </span>
                </span>
              </Label>
            </RadioGroup>
          </div>
          {destination === 'batch' ? (
            <div className="grid gap-2">
              <Label className="grid gap-1.5 text-sm">
                Batch
                <Select onValueChange={setBatchId} value={chosenBatch}>
                  <SelectTrigger aria-label="Batch">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NEW_BATCH}>Start a new batch</SelectItem>
                    {openBatches.map((batch) => (
                      <SelectItem key={batch.id} value={batch.id}>
                        {batch.title} · {batch.itemCount} posts
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Label>
              {chosenBatch === NEW_BATCH ? (
                <Label className="grid gap-1.5 text-sm">
                  Name
                  <Input
                    maxLength={200}
                    onChange={(event) => setBatchTitle(event.target.value)}
                    value={batchTitle}
                  />
                </Label>
              ) : null}
            </div>
          ) : (
            <div className="grid gap-1.5">
              <Label className="grid gap-1.5 text-sm">
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
              <p className="text-xs text-muted-foreground">
                {times.length > 0
                  ? `Recommended from this workspace’s measured engagement, in ${set?.timeZone ?? 'UTC'}. A time places the draft on the calendar; it is scheduled in Publish.`
                  : 'Recommended times appear once published posts have measured engagement.'}
              </p>
            </div>
          )}
          {canFit ? (
            <fieldset className="grid gap-1.5">
              <legend className="text-xs font-medium">Picture size</legend>
              <Label className="flex items-start gap-2 font-normal">
                <Checkbox
                  checked={fitToPlatforms}
                  onCheckedChange={(value) => setFitToPlatforms(value === true)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block">Draw each platform at its own size</span>
                  <span className="block text-xs text-muted-foreground">
                    {renders
                      .map(
                        (render) =>
                          `${render.channels.map((platform) => CAPABILITIES[platform].label).join(', ')} ${render.target.width}\u00d7${render.target.height}`
                      )
                      .join(' \u00b7 ')}
                  </span>
                </span>
              </Label>
              {!fitting && refusedCanvas.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {refusedCanvas.map((platform) => CAPABILITIES[platform].label).join(', ')} would
                  refuse the canvas as it is.
                </p>
              ) : null}
            </fieldset>
          ) : null}
          {mediaWarnings.map((warning) => (
            <p className="text-xs text-destructive" key={warning} role="status">
              {warning}
            </p>
          ))}
          {blocked ? (
            <p className="text-sm text-destructive" role="alert">
              {blocked}
            </p>
          ) : null}
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button disabled={Boolean(busy)} onClick={() => onOpenChange(false)} variant="outline">
            Cancel
          </Button>
          <Button
            aria-busy={Boolean(busy)}
            disabled={
              Boolean(busy) ||
              Boolean(blocked) ||
              (destination === 'batch' && chosenBatch === NEW_BATCH && !batchTitle.trim())
            }
            onClick={() => void submit()}
          >
            {busy ??
              (destination === 'batch'
                ? count > 1
                  ? `Add ${count} to the batch`
                  : 'Add to batch'
                : count > 1
                  ? `Create ${count} drafts`
                  : 'Create draft')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
