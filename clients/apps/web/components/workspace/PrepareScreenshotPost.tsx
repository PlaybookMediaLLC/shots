'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import type { z } from 'zod'
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
import { createWritingDraft } from '@/components/write/pending-draft'
import type { ContentBatch } from '@/lib/api/contracts/content-batches'
import type { socialSetListSchema } from '@/lib/api/contracts/social-sets'
import { call } from '@/lib/content-drafts/client'
import { channelForPlatform, DRAFT_CHANNEL_LIMITS } from '@/lib/content-drafts/serialize'
import { draftAssetNode } from '@/lib/platform/asset-handoff'
import { readEditorReturn } from '@/lib/platform/editor-handoff'
import { useProjectSession } from '@/lib/projects/session'
import { useTRPCClient } from '@/lib/trpc/react'
import { engagementAutomation, followUpLines } from '@/lib/write/automation'
import { CAPABILITIES } from '@/lib/write/capabilities'
import type { DraftChannel } from '@/lib/write/document'
import { THREAD_POST_LIMIT } from '@/lib/write/import-text'
import {
  carriedFollowUps,
  explanationPosts,
  screenshotBatchItem,
  screenshotPostBody,
  screenshotPostVersions,
  screenshotPrompts,
} from '@/lib/write/screenshot-post'
import {
  buildExportFileName,
  saveExportToWorkspace,
  WorkspaceSaveError,
} from '@/lib/workspace/save-export'

/**
 * Prepare a post from the design open in the editor. Everything here hands
 * the export to something Publish already owns: a draft with its thread and
 * its profile's X follow-ups, or a bulk batch that schedules a day of
 * screenshots together. A visual opened from a campaign keeps that
 * campaign's generated copy.
 */

/** The social sets the member can publish from, as the API sends them. */
type SocialSetList = z.output<typeof socialSetListSchema>

/** One profile of that list. */
type SocialSetItem = SocialSetList['items'][number]

/** A campaign's generated draft post, offered as the caption to start from. */
type CampaignCopy = { id: string; channel: string; title: string; copy: string }

/** What a campaign contributes to this post: its name and the copy written for it. */
type CampaignContext = { id: string; name: string; posts: CampaignCopy[] }

/** Where the prepared post goes. */
type Destination = 'draft' | 'batch'

/** Chosen in place of a batch that is already open. */
const NEW_BATCH = 'new'

/** Props of {@link PrepareScreenshotPost}. */
export type PrepareScreenshotPostProps = {
  /** Renders the design. Called on submit only: an export is expensive. */
  createExport: () => Promise<Blob>
  fileName?: string
  onOpenChange: (open: boolean) => void
  open: boolean
}

/** The channel a profile writes for first, which sets the thread's post length. */
function primaryChannel(set: SocialSetItem | undefined): DraftChannel {
  const named = set?.primaryPlatform ?? set?.accounts[0]?.platform ?? ''
  return channelForPlatform(named) ?? 'x'
}

export function PrepareScreenshotPost({
  createExport,
  fileName,
  onOpenChange,
  open,
}: PrepareScreenshotPostProps) {
  const router = useRouter()
  const trpcClient = useTRPCClient()
  const id = React.useId()
  const [caption, setCaption] = React.useState('')
  const [explanation, setExplanation] = React.useState('')
  const [bySize, setBySize] = React.useState(false)
  const [postLength, setPostLength] = React.useState(0)
  const [promptId, setPromptId] = React.useState('')
  const [setId, setSetId] = React.useState('')
  const [keepFollowUps, setKeepFollowUps] = React.useState(false)
  const [destination, setDestination] = React.useState<Destination>('draft')
  const [batchId, setBatchId] = React.useState(NEW_BATCH)
  const [batchTitle, setBatchTitle] = React.useState(
    () => `Screenshots ${new Date().toLocaleDateString()}`
  )
  const [sets, setSets] = React.useState<SocialSetList | null>(null)
  const [batches, setBatches] = React.useState<ContentBatch[]>([])
  // A batch this dialog started: a retry after a failed staging reuses it
  // rather than leaving a trail of empty batches.
  const startedBatch = React.useRef('')
  const [campaign, setCampaign] = React.useState<CampaignContext | null>(null)
  const [campaignNotice, setCampaignNotice] = React.useState('')
  // The generated post the caption came from, recorded with the draft.
  const [campaignPostId, setCampaignPostId] = React.useState('')
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  // One key for every attempt, so a retry after a lost response finds the
  // batch item or draft this dialog already made instead of adding a second.
  const handoffKey = React.useRef(crypto.randomUUID())
  const campaignId = React.useMemo(
    () => (open ? readEditorReturn(window.location.search).campaignId : undefined),
    [open]
  )

  // The profiles and open batches this can go to. A failure here leaves the
  // draft path working: the backend resolves the default profile on its own.
  React.useEffect(() => {
    if (!open) return
    let live = true
    void call<SocialSetList>('/api/v1/social-sets')
      .then((list) => {
        if (!live) return
        setSets(list)
        // The profile a new draft would land in anyway: the workspace's,
        // as the composer resolves it, rather than whichever is listed first.
        const fallback =
          list.items.find((item) => item.visibility === 'WORKSPACE') ?? list.items[0]
        setSetId((current) => current || (fallback?.id ?? ''))
      })
      .catch(() => {
        if (live) setSets({ items: [], orphaned: [], unassigned: [] })
      })
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

  const set = sets?.items.find((item) => item.id === setId)
  const channel = primaryChannel(set)
  const limit = DRAFT_CHANNEL_LIMITS[channel]
  // A length typed for one profile must not block another: it applies only
  // while splitting by length, and the profile's own limit is the default.
  const length = bySize ? postLength || limit : limit
  // Only the follow-ups a new draft can actually carry; the rest stay in Publish.
  const followUps = carriedFollowUps(engagementAutomation(set?.engagementDefaults))
  // A batch publishes as its own profile's accounts, so only that profile's are offered.
  const openBatches = batches.filter((batch) => !setId || batch.socialSetId === setId)
  const chosenBatch = openBatches.some((batch) => batch.id === batchId) ? batchId : NEW_BATCH
  const hasX = Boolean(
    set?.accounts.some((account) => channelForPlatform(account.platform) === 'x')
  )
  const autoDm = CAPABILITIES.x.automation.directMessage
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
        : ''

  async function submit() {
    setError(null)
    try {
      setBusy('Rendering the export…')
      const blob = await createExport()
      setBusy('Saving it to your workspace…')
      const { assetId } = await saveExportToWorkspace({
        blob,
        classification: 'export',
        fileName: fileName ?? buildExportFileName(blob.type),
        projectId: useProjectSession.getState().projectId ?? undefined,
        trpcClient,
      })
      if (destination === 'batch') {
        setBusy('Adding it to the batch…')
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
          body: {
            items: [
              screenshotBatchItem({
                assetId,
                caption: caption.trim(),
                importKey: handoffKey.current,
                ...(fileName ? { sourceKey: fileName } : {}),
              }),
            ],
          },
          method: 'POST',
        })
        onOpenChange(false)
        router.push(`/publish/batches/${encodeURIComponent(batch.id)}`)
        return
      }
      setBusy(campaignId ? 'Attaching it to the campaign…' : 'Opening the draft…')
      const prompt = screenshotPrompts().find((item) => item.id === promptId)
      const draft = {
        assetIds: [assetId],
        body: screenshotPostBody({
          caption,
          media: [draftAssetNode({ id: assetId, mediaType: blob.type })],
          ...(threading ? { thread: thread.posts } : {}),
        }),
        ...(campaign ? { title: campaign.name.slice(0, 200) } : {}),
        ...(setId ? { socialSetId: setId } : {}),
        ...(keepFollowUps && followUps
          ? { platformVersions: screenshotPostVersions(followUps) }
          : {}),
      }
      const open = (draftId: string) => {
        const query = new URLSearchParams()
        if (prompt) {
          query.set('panel', 'assistant')
          query.set('prompt', prompt.id)
        }
        router.push(`/publish/${encodeURIComponent(draftId)}${query.size ? `?${query}` : ''}`)
      }
      if (campaignId) {
        // One call: the backend links the export to the campaign and creates
        // the draft together, so the campaign never gains an orphan image.
        // The campaign's own copy may have failed to load; the link is still
        // made, and a campaign the member cannot write to fails here loudly
        // rather than quietly becoming an unlinked draft.
        const created = await trpcClient.campaign.publishDraft.mutate({
          assetId,
          campaignId,
          draft: { ...draft, requestKey: handoffKey.current },
          ...(campaignPostId ? { campaignPostId } : {}),
          ...(caption.trim() ? { caption: caption.trim().slice(0, 4_000) } : {}),
        })
        onOpenChange(false)
        open(created.draft.id)
        return
      }
      onOpenChange(false)
      await createWritingDraft(draft, open)
    } catch (failure) {
      const message =
        failure instanceof WorkspaceSaveError || failure instanceof Error
          ? failure.message
          : 'The post could not be prepared. Your design is unchanged.'
      setError(message)
      toast.error('Could not prepare the post', { description: message })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Prepare post</DialogTitle>
          <DialogDescription>
            The export is saved to your workspace, then goes to Publish as a draft you can review,
            or into a batch you schedule with the rest of the day&rsquo;s screenshots.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
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
          <Label className="grid gap-1.5 text-sm" htmlFor={`${id}-caption`}>
            Caption
            <Textarea
              id={`${id}-caption`}
              maxLength={100_000}
              onChange={(event) => setCaption(event.target.value)}
              placeholder="Optional. You can also write it in Publish."
              rows={3}
              value={caption}
            />
          </Label>
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
          {sets && sets.items.length > 0 ? (
            <Label className="grid gap-1.5 text-sm">
              Profile
              <Select onValueChange={setSetId} value={setId}>
                <SelectTrigger aria-label="Profile">
                  <SelectValue placeholder="Choose a profile…" />
                </SelectTrigger>
                <SelectContent>
                  {sets.items.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Label>
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
          ) : null}
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
            {busy ?? (destination === 'batch' ? 'Add to batch' : 'Create draft')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
