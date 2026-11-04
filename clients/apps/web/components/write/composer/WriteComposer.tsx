'use client'

import { useWriteRouter } from '@/components/write/write-context'

import * as React from 'react'
import { LinkCards } from './link-cards'
import dynamic from 'next/dynamic'
import { useSearchParams } from 'next/navigation'
import { EyeIcon as Eye } from '@phosphor-icons/react/dist/ssr/Eye'
import { ChatIcon as MessageSquare } from '@phosphor-icons/react/dist/ssr/Chat'
import { SidebarIcon as PanelRight } from '@phosphor-icons/react/dist/ssr/Sidebar'
import { ShareIcon as Share2 } from '@phosphor-icons/react/dist/ssr/Share'
import { SparkleIcon as Sparkles } from '@phosphor-icons/react/dist/ssr/Sparkle'
import { InfoIcon } from '@phosphor-icons/react/dist/ssr/Info'
import { ScissorsIcon } from '@phosphor-icons/react/dist/ssr/Scissors'
import { DotsThreeIcon } from '@phosphor-icons/react/dist/ssr/DotsThree'
import { XIcon } from '@phosphor-icons/react/dist/ssr/X'
import { toast } from 'sonner'
import type { Value } from '@shots/platejs-editor/platejs'
import type { PlateEditor } from '@shots/platejs-editor/platejs/react'
import { connectHref } from '@/components/settings/social-sets/api'
import { Pill, type PillTone } from '@/components/platform-ui'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { CHANNEL_META, ChannelIcon } from '@/components/drafts/channel-meta'
import { DraftPosts } from '@/components/drafts/DraftPosts'
import type { DraftCollaboration, DraftEditorUser } from '@/components/drafts/DraftEditor'
import { BrandSettingsButton, openBrandSettings } from '@/components/drafts/DraftSettingsDrawer'
import { usePreferences } from '@/components/settings/PreferencesProvider'
import { ReviewControls } from '@/components/drafts/DraftTools'
import { appendPost, movePost, postRanges, splitPostAtCaret } from '@/components/drafts/thread'
import { overflowStart, type PostExcess, setOverLimit } from '@/components/drafts/over-limit'
import { POST_COLUMN } from '@/components/drafts/layout'
import {
  DraftRequestError,
  type DraftPostWire,
  type DraftWire,
  draftsApi,
} from '@/lib/content-drafts/client'
import { draftPostsState, POST_STATE_TONE } from '@/lib/content-drafts/post-status'
import { renderBlockImages } from '@/lib/content-drafts/render-blocks'
import {
  type BlockImages,
  draftPlainText,
  renderableBlockCount,
} from '@/lib/content-drafts/serialize'
import { platformEditorServices } from '@/lib/editor/services'
import { useTRPCClient } from '@/lib/trpc/react'
import { engagementAutomation } from '@/lib/write/automation'
import { CAPABILITIES } from '@/lib/write/capabilities'
import { writeApi } from '@/lib/write/client'
import {
  type DraftChannel,
  type PlateBody,
  primaryChannel,
  type VersionOptions,
} from '@/lib/write/document'
import { buildPublication } from '@/lib/write/publication'
import { convertLegacyBlocks, legacyCount } from '@/lib/write/legacy-blocks'
import {
  adaptBody,
  bodyFor,
  bodyPosts,
  forkVersion,
  versionFor,
  withOptions,
  withVersion,
} from '@/lib/write/versions'
import { cn } from '@/lib/utils'
import { useIsMobile } from '@/hooks/use-mobile'
import { SetDot } from '../sets'
import { useKeys, useShortcuts } from '../shortcuts'
import { DraftsDrawerButton } from '../WriteFrame'
import { useWrite, type WriteSet } from '../write-context'
import { CommentsPanel } from './comments'
import { ThreadTools } from './thread-tools'
import { ArticleTools } from './article-tools'
import { MemberComments } from './member-comments'
import {
  CompareDialog,
  ManagePlatformsDialog,
  ManualVersionNotice,
  PlatformTabs,
  SyncedVersion,
  tabChannels,
} from './platforms'
import { PostSettingRequestContext, PostSettingsTools, type PostSettingRequest } from './post-tools'
import { PreviewPanel, type PreviewItem, type PreviewSelection } from './preview'
import { PropertiesPanel } from './properties'
import { PublishReview, ScheduleDialog, type ScheduleContext } from './schedule'
import { BackupsBrowser, ShareDialog } from './share-backups'
import { AssistantPanel } from './assistant'
import { withAssetDescription } from '@/lib/write/media-operations'
import { PreviewImageDescription } from './describe-images'
import { MediaImportDialog } from './media-import-dialog'
import { CopyPollDialog } from './copy-poll'
import { PasteThreadDialog } from './paste-thread'
import type { PostPoll } from '@/lib/write/document'
import { RefineMenu, RefineProvider } from './refine'
import { ComposerCommandsContext, type ComposerTool, type Snippet } from './commands'
import { ComposerToolbar } from './composer-toolbar'
import { SelectionToolbarPlugin } from './selection-toolbar'
import { SlashMenuPlugin } from './slash-menu'
import { HashtagPlugins, HashtagsContext } from './hashtags'
import { QuietShortcutPlugins } from './quiet-shortcuts'
import { PlainPastePlugin } from './plain-paste'
import {
  SocialMentionPlugin,
  SocialMentionInputPlugins,
  SocialMentionContext,
} from './social-mention'
import { type SaveState, useDraftDocument } from './useDraftDocument'
import { VersionOptionsBar } from './version-options'

// The editor kit is heavy; only the composer loads it, after the page renders.
const DraftEditor = dynamic(() => import('@/components/drafts/DraftEditor'), {
  loading: () => (
    <div className="min-h-[420px] p-6 text-sm text-muted-foreground">Loading editor…</div>
  ),
  ssr: false,
})

/** The panels beside the draft. */
type Panel = 'properties' | 'preview' | 'comments' | 'assistant'

/** The dialogs the composer opens. */
type Dialog =
  | 'schedule'
  | 'queue'
  | 'publish'
  | 'manage'
  | 'share'
  | 'backups'
  | 'compare'
  | 'media'
  | 'copy-poll'
  | 'paste'
  | null

/**
 * Plugins Write adds to the editor; stable, so the editor is built once. Typed
 * loosely on purpose: inferring one union of all their plugin types doubled
 * the type checker's memory (CI's typecheck ran out of heap).
 */
const WRITE_PLUGINS: unknown[] = [
  SocialMentionPlugin,
  ...SocialMentionInputPlugins,
  SlashMenuPlugin,
  SelectionToolbarPlugin,
  ...HashtagPlugins,
  ...QuietShortcutPlugins,
  PlainPastePlugin,
]

/** What the save state reads as. */
const SAVE_LABELS: Record<SaveState, string> = {
  error: 'Not saved',
  offline: 'Offline: will save when back',
  saved: 'Saved',
  saving: 'Saving…',
  unsaved: 'Editing…',
}

/**
 * The Write composer (RFC 025). The draft is its primary body plus a version
 * per platform; the tab being edited is UI state only. Destinations,
 * versions, options and the body save together against the draft's version.
 * Previews, the review and the schedule all use the publication the backend
 * receives.
 */

/** This browser's choice to keep the composer's post options open. */
const POST_OPTIONS_KEY = 'shots-post-options'

export function WriteComposer({
  aiEnabled,
  collabToken = null,
  collabUrl,
  draft: initial,
  giphy = false,
  posts: initialPosts,
  requireApproval,
  set,
  user,
  vocabulary,
}: {
  aiEnabled: boolean
  /** The first collaboration token, issued with the page. */
  collabToken?: DraftCollaboration['issued'] | null
  collabUrl: string | null
  draft: DraftWire
  /** Whether GIF search is approved and configured. */
  giphy?: boolean
  posts: DraftPostWire[]
  requireApproval: boolean
  set: WriteSet | null
  user: DraftEditorUser
  vocabulary: { handles: string[]; hashtags: string[] }
}) {
  const router = useWriteRouter()
  const params = useSearchParams()
  const { mod } = useKeys()
  const narrow = useIsMobile()
  const trpcClient = useTRPCClient()
  const {
    beforeLeaveRef,
    openPreviewRef,
    archiveRef,
    canEdit,
    canPublish,
    canReview,
    canManageSets,
    showSaved,
  } = useWrite()
  const services = React.useMemo(
    () => platformEditorServices(trpcClient, aiEnabled),
    [trpcClient, aiEnabled]
  )
  const {
    conflict,
    discardConflict,
    document,
    editorKey,
    flush,
    onDiscussionsChange,
    restoreConflict,
    saveState,
    server,
    setServer,
    update,
    versionRef: version,
  } = useDraftDocument({
    canEdit,
    collaborating: Boolean(collabUrl),
    draft: initial,
    onSaved: (saved) =>
      showSaved({
        excerpt: draftPlainText(saved.body).slice(0, 180),
        id: saved.id,
        title: saved.title,
        updatedAt: saved.updatedAt,
      }),
  })
  // The list follows what is typed, not the save that confirms it seconds later.
  const [opened] = React.useState(document)
  const typed = document === opened ? null : document
  // The opening blocks give the excerpt without serializing a long draft per keystroke.
  const excerpt =
    typed &&
    draftPlainText(Array.isArray(typed.value) ? typed.value.slice(0, 12) : typed.value).slice(
      0,
      180
    )
  const title = typed && (typed.title.trim() || 'Untitled draft')
  React.useEffect(() => {
    if (excerpt === null || title === null) return
    // A transition, so redrawing the list never holds up the next keystroke.
    React.startTransition(() =>
      showSaved({ excerpt, id: initial.id, title, updatedAt: new Date().toISOString() })
    )
  }, [excerpt, initial.id, showSaved, title])
  // Only the first render's token: each refresh issues another, and a new
  // collaboration object would rebuild the editor under the writer's caret.
  const [issued] = React.useState(collabToken)
  const collaboration = React.useMemo(
    () =>
      collabUrl
        ? {
            draftId: initial.id,
            url: collabUrl,
            generation: server.collabGeneration,
            issued: issued ?? undefined,
          }
        : null,
    [collabUrl, initial.id, issued, server.collabGeneration]
  )
  React.useEffect(() => {
    beforeLeaveRef.current = async () => {
      try {
        await flush()
      } catch (error) {
        toast.error('Your changes are not saved. Retry saving before leaving this draft.')
        throw error
      }
    }
    return () => {
      beforeLeaveRef.current = null
    }
  }, [beforeLeaveRef, flush])
  const textDirection = usePreferences().preferences?.textDirection ?? 'ltr'
  const [panelWidth, setPanelWidth] = React.useState(420)
  const resize = React.useRef<{ x: number; width: number } | null>(null)
  const [tab, setTab] = React.useState<DraftChannel>(() => primaryChannel(initial.primaryPlatform))
  const [panel, setPanel] = React.useState<Panel | null>(() => {
    const asked = params.get('panel')
    return asked === 'properties' ||
      asked === 'preview' ||
      asked === 'comments' ||
      asked === 'assistant'
      ? asked
      : null
  })
  const [dialog, setDialog] = React.useState<Dialog>(() =>
    params.has('attach')
      ? 'media'
      : params.get('panel') === 'backups'
        ? 'backups'
        : params.get('panel') === 'schedule'
          ? 'schedule'
          : params.has('connected')
            ? 'manage'
            : null
  )
  const [focus, setFocus] = React.useState(false)
  const [previewSelection, setPreviewSelection] = React.useState<PreviewSelection>({
    channel: null,
    device: 'desktop',
  })
  const focusRoot = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (!focus || !focusRoot.current) return
    // Hide the library and application chrome without remounting the editor.
    // Inert also removes their controls from keyboard and accessibility focus.
    const hidden: { element: HTMLElement; hidden: boolean; inert: boolean }[] = []
    let branch: HTMLElement = focusRoot.current
    while (branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (
          sibling === branch ||
          !(sibling instanceof HTMLElement) ||
          ['SCRIPT', 'STYLE', 'LINK'].includes(sibling.tagName)
        )
          continue
        hidden.push({ element: sibling, hidden: sibling.hidden, inert: sibling.inert })
        sibling.hidden = true
        sibling.inert = true
      }
      if (branch.parentElement === branch.ownerDocument.body) break
      branch = branch.parentElement
    }
    return () => {
      for (const previous of hidden) {
        previous.element.hidden = previous.hidden
        previous.element.inert = previous.inert
      }
    }
  }, [focus])
  const [description, setDescription] = React.useState<{ assetId: string; alt: string } | null>(
    null
  )
  const [compact, setCompact] = React.useState(false)
  const shareButton = React.useRef<HTMLButtonElement>(null)
  const [posts, setPosts] = React.useState(initialPosts)
  const editor = React.useRef<PlateEditor | null>(null)
  const editorChannel = React.useRef<DraftChannel | null>(null)
  const [copiedPoll, setCopiedPoll] = React.useState<{
    channel: DraftChannel
    poll: PostPoll
  } | null>(null)
  const [editorInstance, setEditorInstance] = React.useState<PlateEditor | null>(null)
  const primary = document.primaryPlatform
  const accounts = set?.accounts ?? []
  const enabled = document.channelConnectionIds
  const channels = tabChannels(accounts, enabled, primary)
  const active = channels.includes(tab) ? tab : primary
  const versionOfTab = versionFor(document.versions, active)
  const draftFields = {
    article: document.article,
    body: document.value as PlateBody,
    engagement: server.engagement,
    kind: server.kind,
    platformVersions: document.versions,
    target: document.target,
  }
  // Tables and math post as images, rendered when scheduling (RFC 013);
  // until then each counts as a pending image, as it will publish.
  const pendingBlocks: BlockImages = Array.from(
    { length: renderableBlockCount(document.value) },
    () => ''
  )
  const bodyArea = React.useRef<HTMLDivElement>(null)
  const [pasteNotice, setPasteNotice] = React.useState(false)
  // Thread and automation settings stay one click away so writing leads.
  const [optionsOpen, setOptionsOpen] = React.useState(false)
  React.useEffect(() => {
    try {
      setOptionsOpen(localStorage.getItem(POST_OPTIONS_KEY) === 'open')
    } catch {
      // Without storage the options start closed, as on a first visit.
    }
  }, [])
  const renderBlocks = async (): Promise<BlockImages> => {
    if (pendingBlocks.length === 0 || !services.uploadFile) return []
    if (active !== primary || !bodyArea.current) {
      setTab(primary)
      throw new DraftRequestError(
        `Showing the ${CHANNEL_META[primary].label} version so its tables and math can be posted as images. Try again.`,
        409
      )
    }
    return renderBlockImages(bodyArea.current, services.uploadFile)
  }
  const items: PreviewItem[] = accounts
    .filter((account) => enabled.includes(account.id))
    .map((account) => ({
      account,
      publication: buildPublication(
        draftFields,
        {
          channel: account.channel,
          connectionId: account.id,
          standing: {
            tiktokCreator: account.tiktokCreator,
            maxWeightedCharacters: account.xCaptionLimit,
            articles: account.xArticles,
            xQuotes: account.xQuotes,
            pollLimits: account.pollLimits,
            mastodonQuotes: account.mastodonQuotes,
          },
        },
        pendingBlocks
      ),
    }))
  const activePublication =
    items.find((item) => item.account.channel === active)?.publication ??
    buildPublication(draftFields, { channel: active, connectionId: 'preview' }, pendingBlocks)
  const approved = server.reviewStatus === 'approved' && server.approvedVersion === server.version
  const limitFor = (channel: DraftChannel) =>
    items.find((item) => item.account.channel === channel)?.publication.serialized.limit ??
    CAPABILITIES[channel].captionLimit
  // Write's tools the toolbar, the More menu and the slash menu open.
  const [tool, setTool] = React.useState<ComposerTool | null>(null)
  const [postSetting, setPostSetting] = React.useState<PostSettingRequest | null>(null)
  // The set's thread finishers are the slash menu's snippets.
  const snippetSet = server.socialSetId ?? set?.id ?? null
  const [snippets, setSnippets] = React.useState<Snippet[]>([])
  const [snippetsRead, setSnippetsRead] = React.useState(0)
  React.useEffect(() => {
    if (!snippetSet || !canEdit) return
    let cancelled = false
    void writeApi
      .finishers(snippetSet)
      .then(({ items: found }) => {
        if (!cancelled) setSnippets(found.map(({ id, name, text }) => ({ id, name, text })))
      })
      .catch(() => {
        // Without them the menu offers to manage snippets; the dialog shows the error.
        if (!cancelled) setSnippets([])
      })
    return () => {
      cancelled = true
    }
  }, [canEdit, snippetSet, snippetsRead])
  /** Another platform's own text, written from an accepted Refine review. */
  const writeVersion = (target: DraftChannel, body: PlateBody) => {
    const before = document.versions
    update((current) => {
      const versions =
        versionFor(current.versions, target).mode === 'manual'
          ? current.versions
          : forkVersion(
              current.versions,
              target,
              current.value as PlateBody,
              version.current,
              Boolean(CAPABILITIES[target].thread)
            )
      return { versions: withVersion(versions, { ...versionFor(versions, target), body }) }
    })
    setTab(target)
    toast.success(`Written as ${CHANNEL_META[target].label}’s own text.`, {
      action: { label: 'Undo', onClick: () => update({ versions: before }) },
    })
  }
  const refreshPosts = async () => {
    setPosts((await draftsApi.posts(initial.id)).posts)
    router.refresh()
  }
  const toggle = (accountId: string, on: boolean) => {
    const account = accounts.find((item) => item.id === accountId)
    if (!account) return
    update((current) => ({
      channelConnectionIds: on
        ? [
            ...current.channelConnectionIds.filter(
              (id) => accounts.find((item) => item.id === id)?.channel !== account.channel
            ),
            accountId,
          ]
        : current.channelConnectionIds.filter((id) => id !== accountId),
    }))
  }
  const setOptions = (channel: DraftChannel, options: VersionOptions) =>
    update((current) => ({ versions: withOptions(current.versions, channel, options) }))
  const context: ScheduleContext = {
    approved,
    canPublish: canPublish && server.status !== 'archived',
    conflict: conflict !== null,
    draft: server,
    flush,
    retrySave: () =>
      void flush().catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : 'Could not save.')
      ),
    saveState,
    items,
    onDone: ({ draft, newDraft }) => {
      setServer(draft)
      void refreshPosts()
      if (newDraft)
        void draftsApi
          .create({ socialSetId: draft.socialSetId ?? undefined })
          .then((next) => router.push(`/publish/${next.id}`))
          .catch(() =>
            toast.error(
              'Scheduled successfully, but the next draft could not be opened. Create one from the sidebar.'
            )
          )
    },
    onToggle: toggle,
    requireApproval,
    scheduled: posts.filter((post) => post.status === 'SCHEDULED'),
    setTimeZone: set?.timeZone ?? null,
    versionRef: version,
    renderBlocks,
    community: versionFor(document.versions, 'x').options?.community,
    onCommunity: canEdit
      ? (community) =>
          update((current) => ({
            versions: withOptions(current.versions, 'x', {
              ...versionFor(current.versions, 'x').options,
              community,
            }),
          }))
      : undefined,
    autoDm: versionFor(document.versions, 'x').options?.autoDm,
    onAutoDm: canEdit
      ? (autoDm) =>
          update((current) => ({
            versions: withOptions(current.versions, 'x', {
              ...versionFor(current.versions, 'x').options,
              autoDm,
            }),
          }))
      : undefined,
    automation:
      versionFor(document.versions, 'x').options?.automation ??
      engagementAutomation(server.engagement),
    onAutomation: canEdit
      ? (automation) =>
          update((current) => ({
            versions: withOptions(current.versions, 'x', {
              ...versionFor(current.versions, 'x').options,
              automation,
            }),
          }))
      : undefined,
  }
  const togglePanel = (next: Panel) => setPanel((current) => (current === next ? null : next))
  React.useEffect(() => {
    openPreviewRef.current = () => setPanel('preview')
    return () => {
      openPreviewRef.current = null
    }
  }, [openPreviewRef])
  useShortcuts([
    {
      key: '\\',
      label: 'Draft details',
      mod: true,
      run: () => togglePanel('properties'),
      inEditor: true,
    },
    { key: 'p', label: 'Pin', mod: true, shift: true, inEditor: true, run: () => void pin() },
    {
      alt: true,
      key: 's',
      label: 'Share',
      mod: true,
      run: () => setDialog('share'),
      inEditor: true,
    },
    {
      alt: true,
      key: 'ß',
      label: 'Share',
      mod: true,
      run: () => setDialog('share'),
      inEditor: true,
    },
    {
      key: 'enter',
      label: 'Publish review',
      mod: true,
      shift: true,
      run: () => canPublish && setDialog('publish'),
      inEditor: true,
    },
    {
      alt: true,
      key: 'enter',
      label: 'Next free slot',
      mod: true,
      run: () => canPublish && setDialog('queue'),
      inEditor: true,
    },
    {
      key: 'f',
      label: 'Focus mode',
      mod: true,
      shift: true,
      run: () => setFocus((current) => !current),
      inEditor: true,
    },
    {
      key: 'h',
      label: 'Display mode',
      mod: true,
      shift: true,
      run: () => setCompact((current) => !current),
      inEditor: true,
    },
    {
      key: 'v',
      label: 'Preview',
      mod: true,
      shift: true,
      run: () => togglePanel('preview'),
      inEditor: true,
    },
    {
      // The editor's own image picker, so the upload takes the usual path.
      key: 'i',
      label: 'Add media',
      mod: true,
      shift: true,
      run: () => addMedia(),
      inEditor: true,
    },
    {
      alt: true,
      key: 'arrowup',
      label: 'Move post up',
      inEditor: true,
      run: () => movePostAtCaret(-1),
    },
    {
      alt: true,
      key: 'arrowdown',
      label: 'Move post down',
      inEditor: true,
      run: () => movePostAtCaret(1),
    },
  ])
  function addMedia() {
    bodyArea.current
      ?.querySelector<HTMLInputElement>('input[type="file"][aria-label="Insert media"]')
      ?.click()
  }
  function movePostAtCaret(delta: number) {
    const current = editor.current
    const block = current?.api.block({ highest: true })
    if (!current || !block) return
    const index = block[1][0]
    const number =
      postRanges(current.children).findIndex(([start, end]) => index >= start && index < end) + 1
    if (number > 0) movePost(current, number, number + delta)
  }
  async function pin() {
    // The list shows the pin at once; a refusal puts it back.
    showSaved({ id: initial.id, pinned: !server.pinnedAt })
    try {
      const saved = await writeApi.properties(initial.id, { pinned: !server.pinnedAt })
      setServer(saved)
      toast.success(saved.pinnedAt ? 'Pinned.' : 'Unpinned.')
      router.refresh()
    } catch (error) {
      showSaved({ id: initial.id, pinned: Boolean(server.pinnedAt) })
      toast.error(error instanceof Error ? error.message : 'The pin did not change.')
    }
  }
  const archive = async (status: 'draft' | 'archived') => {
    try {
      await flush()
      setServer(await draftsApi.save(initial.id, { baseVersion: version.current, status }))
      toast.success(status === 'archived' ? 'Archived.' : 'Restored from archive.')
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The draft did not change.')
    }
  }
  React.useEffect(() => {
    archiveRef.current = archive
    return () => {
      archiveRef.current = null
    }
  })
  // The publishing account for the tab: the enabled one, else any on that platform.
  const account =
    accounts.find((item) => item.channel === active && enabled.includes(item.id)) ??
    accounts.find((item) => item.channel === active)
  const author = account?.displayName ?? set?.name ?? user.name
  const postHeader = () => (
    <div className="flex items-center gap-2 sm:gap-3" data-testid="post-header">
      <Avatar
        // Covers the thread line where it meets the avatar.
        className="relative z-[1] -ms-10 size-8 ring-4 ring-card sm:-ms-12 sm:size-9"
        data-post-avatar
      >
        {account?.avatarUrl ? <AvatarImage alt="" src={account.avatarUrl} /> : null}
        {/* Also shown when a provider's avatar link has expired. */}
        <AvatarFallback className="bg-accent text-ui font-medium text-accent-foreground">
          {initials(author)}
        </AvatarFallback>
      </Avatar>
      <p className="min-w-0 flex-1 truncate text-ui">
        <span className="font-medium text-foreground">{author}</span>
        <span className="ml-1.5 text-muted-foreground">
          {account?.handle ? `@${account.handle}` : CHANNEL_META[active].label}
        </span>
      </p>
    </div>
  )
  // Each post's characters over the limit; a platform without threads publishes the
  // posts as one caption, whose overflow is the last post's tail.
  // shortcut: that tail can start in an earlier post; mark across posts if writers ask.
  const captionLimit = activePublication.serialized.limit
  const postCount = postRanges((editorInstance?.children ?? []) as Value).length
  const excess: PostExcess = Object.fromEntries(
    activePublication.serialized.posts
      .filter((post) => post.length > captionLimit)
      .map((post) => [CAPABILITIES[active].thread ? post.group : postCount, post.length - captionLimit])
  )
  const excessKey = JSON.stringify(excess)
  React.useEffect(() => {
    if (editorInstance) setOverLimit(editorInstance, active, JSON.parse(excessKey) as PostExcess)
  }, [active, editorInstance, excessKey])
  const splitAtLimit = (number: number) => {
    const current = editor.current
    const point = current && overflowStart(current.children, number, excess, active)
    if (!current || !point) return
    current.tf.select(point)
    splitPostAtCaret(current)
    current.tf.focus()
  }
  const postCounter = (number: number, inUse: boolean) => {
    const post = activePublication.serialized.posts.find((item) => item.group === number)
    if (!post) return null
    return (
      <PostCount
        active={inUse}
        length={post.length}
        limit={activePublication.serialized.limit}
        number={number}
        thread={Boolean(CAPABILITIES[active].thread)}
      />
    )
  }
  const onDescriptionSaved = (assetId: string, alt: string) => {
    const current = editor.current
    if (current)
      for (const [, path] of current.api.nodes({
        at: [],
        match: (node) => node.type === 'img' && node.assetId === assetId,
      }))
        current.tf.setNodes({ alt }, { at: path })
    update((draft) => ({
      value: withAssetDescription(draft.value, assetId, alt),
      versions: withAssetDescription(draft.versions, assetId, alt),
    }))
  }
  const editorProps = {
    draftId: initial.id,
    extraPlugins: WRITE_PLUGINS,
    handles: vocabulary.handles,
    hashtags: vocabulary.hashtags,
    postHeader,
    placeholder: PLACEHOLDERS[active] ?? `Write your ${CHANNEL_META[active].label} post…`,
    postTools: {
      counter: postCounter,
      menu: (number: number) =>
        excess[number] && CAPABILITIES[active].thread ? (
          <DropdownMenuItem onSelect={() => splitAtLimit(number)}>
            <ScissorsIcon aria-hidden />
            Split at the limit
          </DropdownMenuItem>
        ) : null,
      refine: aiEnabled
        ? (number: number, button: React.ReactElement) => (
            <RefineMenu align="end" at={`post-${number}`} side="bottom">
              {button}
            </RefineMenu>
          )
        : undefined,
      settings: canEdit
      ? ({
          number,
          settings,
        }: {
          number: number
          settings: Parameters<typeof PostSettingsTools>[0]['settings']
        }) => (
          <PostSettingsTools
            channel={active}
            number={number}
            pollSources={channels
              .filter((channel) => channel !== active)
              .flatMap((channel) =>
                bodyPosts(bodyFor(document.value as PlateBody, document.versions, channel)).flatMap(
                  (post, index) =>
                    post.settings.poll
                      ? [
                          {
                            key: `${channel}-${index}`,
                            label: `${CHANNEL_META[channel].label} · post ${index + 1}`,
                            poll: post.settings.poll,
                          },
                        ]
                      : []
                )
              )}
            settings={settings}
            standing={{
              pollLimits: accounts.find((account) => account.channel === active)?.pollLimits,
            }}
          />
        )
      : undefined,
    },
    readOnly: !canEdit,
    services,
    // Text runs in the direction the person chose in Appearance (RFC 024).
    textDirection,
    title: document.title,
    user,
  }
  const panelContent =
    panel === 'properties' ? (
      <PropertiesPanel
        aiEnabled={aiEnabled}
        canEdit={canEdit}
        draft={server}
        onTitle={(title) => update({ title })}
        plainText={draftPlainText(document.value)}
        publications={items.map((item) => ({
          channel: item.account.channel,
          publication: item.publication,
        }))}
        title={document.title}
      />
    ) : panel === 'preview' ? (
      <PreviewPanel
        initialChannel={active}
        onDescribe={canEdit ? (media) => setDescription(media) : undefined}
        onSelect={setPreviewSelection}
        selection={previewSelection}
        items={
          items.length
            ? items
            : [
                {
                  account: {
                    id: 'preview',
                    channel: active,
                    platform: active,
                    displayName: set?.name ?? user.name,
                    avatarUrl: null,
                    handle: null,
                    premium: false,
                    socialSetId: set?.id ?? null,
                    health: 'connected',
                    createdAt: initial.createdAt,
                  },
                  publication: activePublication,
                },
              ]
        }
        target={document.target}
      />
    ) : panel === 'comments' && !canEdit ? (
      <MemberComments draft={server} currentUserId={user.id} onDraft={setServer} />
    ) : panel === 'comments' ? (
      <CommentsPanel
        draft={server}
        editor={editorInstance}
        primary={document.value as PlateBody}
        users={{ [user.id]: user.name }}
        versions={document.versions}
      />
    ) : panel === 'assistant' ? (
      <AssistantPanel
        channel={active}
        onInsert={
          canEdit && (active === primary || versionOfTab.mode === 'manual')
            ? (text) => {
                if (editor.current) appendPost(editor.current, text)
              }
            : undefined
        }
        draftId={initial.id}
        posts={activePublication.serialized.posts.map((post) => post.caption)}
        set={set}
      />
    ) : null
  // The destinations' state that needs attention first; a plan only when nothing is queued.
  const destinations = draftPostsState(posts)
  const status: { label: string; tone: PillTone } | null =
    server.status === 'archived'
      ? { label: 'Archived', tone: 'gray' }
      : destinations
        ? {
            label:
              destinations.count < destinations.total
                ? `${destinations.state} · ${destinations.count} of ${destinations.total}`
                : destinations.state,
            tone: POST_STATE_TONE[destinations.state],
          }
        : server.plannedFor
          ? { label: 'Planned', tone: 'purple' }
          : null
  // shortcut: compares each queued post's first text and thread length with the current
  // version, not reply text or media; store a content hash on the post to catch those too.
  const edited = new Set(
    posts
      .filter((post) => post.status === 'SCHEDULED')
      .filter((post) => {
        const current = items.find((item) => item.account.id === post.channelConnectionId)
          ?.publication.serialized.posts
        return (
          !current || current[0]?.caption !== post.caption || current.length - 1 !== post.replies
        )
      })
      .map((post) => post.id)
  )
  const composer = (
      <div
        // Opening a side panel changes text wrapping. Native scroll anchoring
        // would otherwise jump the editor to a different scroll position.
        ref={focusRoot}
        className={cn(
          'flex min-h-full [overflow-anchor:none]',
          compact && 'write-compact',
          focus && 'fixed inset-0 z-40 overflow-y-auto bg-card'
        )}
        data-testid="write-composer"
      >
        {/* The panel gives way before the editor drops below a readable column. */}
        <div className="flex min-w-[min(26rem,100%)] flex-1 flex-col">
          <header className="sticky top-0 z-20 flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card/90 px-3 py-2 backdrop-blur">
            <DraftsDrawerButton />
            {set ? (
              <span
                className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex"
                data-testid="composer-identity"
                title={`Writing as ${set.name}`}
              >
                <SetDot color={set.color} />
                <span className={cn('max-w-32 truncate', panel ? 'hidden' : 'hidden 2xl:inline')}>
                  {set.name}
                </span>
              </span>
            ) : null}
            <span className="flex items-center gap-1 text-muted-foreground md:hidden">
              {items.map((item) => (
                <ChannelIcon channel={item.account.channel} key={item.account.id} />
              ))}
            </span>
            <Input
              aria-label="Draft title"
              hidden={focus}
              className="h-8 min-w-20 max-w-64 flex-1 truncate border-transparent bg-transparent text-ui-lg font-medium text-foreground focus:text-foreground"
              disabled={!canEdit}
              maxLength={200}
              onChange={(event) => update({ title: event.target.value })}
              placeholder="Untitled draft"
              value={document.title}
            />
            {/* The everyday labels share one cell sized to the widest, so the header never shifts. */}
            <span className="grid shrink-0 text-xs [&>*]:col-start-1 [&>*]:row-start-1">
              {(['saving', 'saved', 'unsaved'] as const).map((state) => (
                <span aria-hidden className="invisible" key={state}>
                  {SAVE_LABELS[state]}
                </span>
              ))}
              <span
                className={cn(
                  saveState === 'error' || saveState === 'offline'
                    ? 'text-amber-700 dark:text-amber-300'
                    : 'text-muted-foreground'
                )}
                data-testid="save-state"
                role="status"
              >
                {SAVE_LABELS[saveState]}
              </span>
            </span>
            {saveState === 'error' || saveState === 'offline' ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void flush().catch((error: unknown) =>
                    toast.error(error instanceof Error ? error.message : 'Could not save.')
                  )
                }
              >
                Retry save
              </Button>
            ) : null}
            {status ? (
              <span className="shrink-0" data-testid="draft-status">
                <Pill tone={status.tone}>{status.label}</Pill>
              </span>
            ) : null}
            {requireApproval || server.reviewStatus !== 'none' ? (
              <ReviewControls
                canEdit={canEdit}
                canReview={canReview}
                draftId={initial.id}
                onDraft={(next) => {
                  setServer(next)
                  router.refresh()
                }}
                review={{ ...server, version: version.current }}
              />
            ) : null}
            {/* One row of actions that wraps as a whole; narrow screens keep the rest in More. */}
            <div
              className="ml-auto flex shrink-0 items-center gap-1"
              data-testid="composer-actions"
            >
              {focus ? null : (
                <>
                  <PanelButton
                    active={panel === 'preview'}
                    icon={<Eye aria-hidden className="size-4" />}
                    label="Preview"
                    onClick={() => togglePanel('preview')}
                    shortcut={`${mod}⇧V`}
                  />
                  <PanelButton
                    active={panel === 'comments'}
                    className="hidden md:inline-flex"
                    icon={<MessageSquare aria-hidden className="size-4" />}
                    label="Comments"
                    onClick={() => togglePanel('comments')}
                    shortcut={`${mod}⇧M`}
                  />
                  <PanelButton
                    active={panel === 'properties'}
                    className="hidden md:inline-flex"
                    icon={<PanelRight aria-hidden className="size-4" />}
                    label="Draft details"
                    onClick={() => togglePanel('properties')}
                    shortcut={`${mod}\\`}
                  />
                  {aiEnabled ? (
                    <PanelButton
                      active={panel === 'assistant'}
                      className="hidden md:inline-flex"
                      icon={<Sparkles aria-hidden className="size-4" />}
                      label="Assistant"
                      onClick={() => togglePanel('assistant')}
                    />
                  ) : null}
                  {/* The set's settings open beside the draft without unmounting it (RFC 024). */}
                  {set ? (
                    <span className="hidden md:contents">
                      <BrandSettingsButton id={set.id} name={set.name} />
                    </span>
                  ) : null}
                </>
              )}
              {/* With a panel open, Share shows as an icon so the header stays in its column. */}
              <Button
                ref={shareButton}
                aria-label="Share"
                className={cn('hidden', !focus && 'lg:inline-flex', panel && 'size-8 px-0')}
                onClick={() => setDialog('share')}
                size="sm"
                title={`Share (${mod}⌥S)`}
                variant="ghost"
              >
                {panel ? <Share2 aria-hidden className="size-4" /> : 'Share'}
              </Button>
              {canPublish && server.status !== 'archived' ? (
                <>
                  <Button
                    className={cn('hidden', !focus && 'sm:inline-flex')}
                    data-testid="publish-button"
                    onClick={() => setDialog('publish')}
                    size="sm"
                    title={`Review and publish now (${mod}⇧↵)`}
                    variant="outline"
                  >
                    Publish now…
                  </Button>
                  <Button
                    data-testid="schedule-button"
                    onClick={() => setDialog('schedule')}
                    size="sm"
                  >
                    {posts.some((post) => post.status === 'SCHEDULED') ? 'Reschedule' : 'Schedule'}
                  </Button>
                </>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    aria-label="More draft actions"
                    className="size-8 px-0"
                    size="sm"
                    variant="ghost"
                  >
                    <DotsThreeIcon aria-hidden className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-60">
                  {canPublish && server.status !== 'archived' ? (
                    <>
                      <DropdownMenuItem onSelect={() => setDialog('queue')}>
                        Add to queue
                        <DropdownMenuShortcut>{mod}⌥↵</DropdownMenuShortcut>
                      </DropdownMenuItem>
                      <DropdownMenuItem className="sm:hidden" onSelect={() => setDialog('publish')}>
                        Publish now…
                      </DropdownMenuItem>
                    </>
                  ) : null}
                  <DropdownMenuItem className="lg:hidden" onSelect={() => setDialog('share')}>
                    Share…
                  </DropdownMenuItem>
                  {focus ? null : (
                    <>
                      <DropdownMenuItem
                        className="md:hidden"
                        onSelect={() => togglePanel('comments')}
                      >
                        Comments
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="md:hidden"
                        onSelect={() => togglePanel('properties')}
                      >
                        Draft details
                      </DropdownMenuItem>
                      {aiEnabled ? (
                        <DropdownMenuItem
                          className="md:hidden"
                          onSelect={() => togglePanel('assistant')}
                        >
                          Assistant
                        </DropdownMenuItem>
                      ) : null}
                      {set ? (
                        <DropdownMenuItem
                          className="md:hidden"
                          onSelect={() => openBrandSettings('scheduling', set.id)}
                        >
                          Brand settings…
                        </DropdownMenuItem>
                      ) : null}
                    </>
                  )}
                  {canEdit && activePublication.settings[0]?.poll ? (
                    <DropdownMenuItem
                      onSelect={() => {
                        setCopiedPoll({
                          channel: active,
                          poll: structuredClone(activePublication.settings[0].poll!),
                        })
                        setDialog('copy-poll')
                      }}
                    >
                      Copy poll to channel…
                    </DropdownMenuItem>
                  ) : null}
                  {canEdit && editorInstance ? (
                    <DropdownMenuItem onSelect={() => setDialog('media')}>
                      Manage media…
                    </DropdownMenuItem>
                  ) : null}
                  {canEdit && CAPABILITIES[active].thread ? (
                    <DropdownMenuItem onSelect={() => setDialog('paste')}>
                      Paste as thread…
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem onSelect={() => setDialog('backups')}>
                    View automatic backups
                  </DropdownMenuItem>
                  {canEdit ? (
                    <DropdownMenuItem onSelect={() => void pin()}>
                      {server.pinnedAt ? 'Unpin draft' : 'Pin draft'}
                      <DropdownMenuShortcut>{mod}⇧P</DropdownMenuShortcut>
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem onSelect={() => setFocus((current) => !current)}>
                    {focus ? 'Leave focus mode' : 'Focus mode'}
                    <DropdownMenuShortcut>{mod}⇧F</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setCompact((current) => !current)}>
                    {compact ? 'Comfortable display' : 'Compact display'}
                    <DropdownMenuShortcut>{mod}⇧H</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  {canEdit ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={() =>
                          void archive(server.status === 'archived' ? 'draft' : 'archived')
                        }
                      >
                        {server.status === 'archived' ? 'Restore from archive' : 'Archive draft'}
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>
          {server.status === 'archived' ? (
            <div
              role="status"
              className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-foreground/[0.04] px-4 py-3 text-sm text-foreground"
            >
              <span>Archived draft. Restore it before scheduling or publishing.</span>
              {canEdit ? (
                <Button size="sm" variant="outline" onClick={() => void archive('draft')}>
                  Restore draft
                </Button>
              ) : null}
            </div>
          ) : null}
          {conflict ? (
            <div
              className="flex flex-wrap items-center gap-2 border-b border-amber-400/40 bg-amber-400/[0.08] px-4 py-3 text-sm text-foreground"
              data-testid="save-conflict"
              role="alert"
            >
              <span className="min-w-0 flex-1 basis-64">
                This draft changed elsewhere. You are seeing the latest version; your unsaved edit
                is kept here until you choose.
              </span>
              {canEdit && !collabUrl ? (
                <Button
                  onClick={restoreConflict}
                  size="sm"
                  title="Replaces the newer version with your edit"
                  variant="outline"
                >
                  Use my version
                </Button>
              ) : null}
              <Button
                onClick={() =>
                  void navigator.clipboard
                    .writeText(
                      [conflict.title, draftPlainText(conflict.value)].filter(Boolean).join('\n\n')
                    )
                    .then(() => toast.success('Your edit is copied.'))
                    .catch(() => toast.error('Copying was blocked by the browser.'))
                }
                size="sm"
                variant="outline"
              >
                Copy my text
              </Button>
              <Button onClick={discardConflict} size="sm" variant="ghost">
                Discard my edit
              </Button>
            </div>
          ) : null}
          {accounts.length === 0 && !focus ? (
            <div className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm text-foreground">
              <span>
                {canManageSets
                  ? 'Connect an account to publish. You can write your draft now.'
                  : canEdit
                    ? 'An owner or admin can connect an account. You can write your draft now.'
                    : 'An owner or admin can connect an account to publish this draft.'}
              </span>
              {canManageSets ? (
                <Button size="sm" variant="outline" onClick={() => setDialog('manage')}>
                  Connect account
                </Button>
              ) : null}
            </div>
          ) : null}
          {/* Focus mode (⌘⇧F) keeps the posts and Schedule; everything else steps away. */}
          {focus ? null : (
            <>
          <PlatformTabs
            accounts={accounts}
            active={active}
            enabled={enabled}
            onManage={canEdit ? () => setDialog('manage') : undefined}
            onSelect={setTab}
            primary={primary}
            versions={document.versions}
          />
          <TargetBanner draft={server} />
          {canEdit && server.kind === 'article' ? (
            <ArticleTools
              article={document.article}
              onChange={(article) => update(() => ({ article }))}
              editor={editor}
              upload={services.uploadFile}
            />
          ) : null}
          {canEdit && server.kind !== 'article' ? (
            <LinkCards
              text={activePublication.serialized.posts.map((post) => post.caption).join('\n')}
              channel={active}
              cards={versionOfTab.options?.linkPreviews ?? []}
              onChange={(card) =>
                update((current) => {
                  const options = versionFor(current.versions, active).options ?? {}
                  return {
                    versions: withOptions(current.versions, active, {
                      ...options,
                      linkPreviews: [
                        ...(options.linkPreviews ?? []).filter((item) => item.url !== card.url),
                        card,
                      ].slice(-25),
                    }),
                  }
                })
              }
              onQuote={(url) => {
                void (async () => {
                  await flush()
                  const next = await draftsApi.create({
                    kind: 'quote',
                    socialSetId: server.socialSetId ?? undefined,
                    target: { url },
                    body: bodyFor(document.value as PlateBody, document.versions, active),
                  })
                  router.push(`/publish/${next.id}`)
                })().catch((error) =>
                  toast.error(
                    error instanceof Error ? error.message : 'The quote draft could not be created.'
                  )
                )
              }}
            />
          ) : null}
          <Disclosure
            className="mx-4 mt-1 mb-3 overflow-hidden rounded-xl border border-border bg-card"
            onOpenChange={(open) => {
              setOptionsOpen(open)
              try {
                localStorage.setItem(POST_OPTIONS_KEY, open ? 'open' : 'closed')
              } catch {
                // The choice then lasts only as long as this composer.
              }
            }}
            open={optionsOpen}
          >
            <DisclosureTrigger className="select-none bg-background px-4 py-2.5 text-caption font-medium text-[var(--fg-tertiary)] hover:text-foreground">
              Post options
            </DisclosureTrigger>
            <DisclosureContent>
            <VersionOptionsBar
              tiktokCreator={accounts.find((account) => account.channel === active)?.tiktokCreator}
              channel={active}
              captionLimit={activePublication.serialized.limit}
              onApplyFinisher={
                canEdit && (active === primary || versionOfTab.mode === 'manual')
                  ? (text, quoteFirstPost) => {
                      if (editor.current)
                        appendPost(
                          editor.current,
                          text,
                          quoteFirstPost ? { quoteFirstPost: true } : {}
                        )
                    }
                  : undefined
              }
              onChange={(options) => setOptions(active, options)}
              options={versionOfTab.options ?? {}}
              postCount={activePublication.serialized.posts.length}
              readOnly={!canEdit}
              setId={server.socialSetId ?? set?.id ?? null}
              uploadFile={
                services.uploadFile
                  ? async (file) => ({ assetId: (await services.uploadFile!(file)).assetId ?? '' })
                  : undefined
              }
            />
            {canEdit &&
            server.kind !== 'article' &&
            CAPABILITIES[active].thread &&
            (active === primary || versionOfTab.mode === 'manual') ? (
              <ThreadTools
                pasted={pasteNotice}
                onSplit={() => setPasteNotice(false)}
                editor={editor}
                channel={active}
                limit={activePublication.serialized.limit}
                options={versionOfTab.options ?? {}}
                onChange={(options) => setOptions(active, options)}
              />
            ) : null}
            </DisclosureContent>
          </Disclosure>
            </>
          )}
          <div
            className="relative flex-1"
            data-testid="composer-body"
            ref={bodyArea}
            onPasteCapture={() => setPasteNotice(true)}
          >
            {canEdit &&
            legacyCount(active === primary ? document.value : versionOfTab.body) > 0 ? (
              <div
                className={cn(
                  'mb-2 flex flex-wrap items-center gap-2 text-caption text-muted-foreground',
                  POST_COLUMN
                )}
                data-testid="legacy-formatting"
                role="status"
              >
                <InfoIcon aria-hidden className="size-4 shrink-0" />
                <span>Headings, callouts and colored text in this draft post as plain text.</span>
                <Button
                  onClick={() => editor.current && convertLegacyBlocks(editor.current)}
                  size="sm"
                  variant="outline"
                >
                  Convert to text
                </Button>
              </div>
            ) : null}
            {active === primary ? (
              <DraftEditor
                {...editorProps}
                collaboration={collaboration}
                initialDiscussions={readDiscussionsOnce(initial)}
                initialValue={document.value}
                // A new generation is a new live room. Without one, every body save
                // bumps it, and keying on it remounted the editor (and lost focus) per save.
                key={`primary-${editorKey}${collaboration ? `-${server.collabGeneration}` : ''}`}
                onChange={(next) => update({ value: next })}
                onDiscussionsChange={onDiscussionsChange}
                onEditor={(next) => {
                  editor.current = next
                  editorChannel.current = active
                  setEditorInstance(next)
                }}
                toolbarExtras={(documentActions) => (
                  <ComposerToolbar
                    aiEnabled={aiEnabled}
                    channel={active}
                    document={documentActions}
                    onDescriptionSaved={onDescriptionSaved}
                    onSnippetsChange={() => setSnippetsRead((count) => count + 1)}
                    onTool={setTool}
                    setId={snippetSet}
                    tool={tool}
                  />
                )}
              />
            ) : versionOfTab.mode === 'manual' ? (
              <>
                <ManualVersionNotice
                  channel={active}
                  onCompare={() => setDialog('compare')}
                  onResync={canEdit ? () => setDialog('manage') : undefined}
                  primary={primary}
                  value={document.value as PlateBody}
                  versions={document.versions}
                />
                <DraftEditor
                  {...editorProps}
                  collaboration={null}
                  initialDiscussions={{ threads: [], users: {} }}
                  initialValue={(versionOfTab.body ?? []) as Value}
                  key={`version-${active}-${editorKey}`}
                  onChange={(next) =>
                    update((current) => ({
                      versions: withVersion(current.versions, {
                        ...versionFor(current.versions, active),
                        body: next as PlateBody,
                      }),
                    }))
                  }
                  onDiscussionsChange={() => undefined}
                  onEditor={(next) => {
                    editor.current = next
                    editorChannel.current = active
                    setEditorInstance(next)
                  }}
                  toolbarExtras={(documentActions) => (
                    <ComposerToolbar
                      aiEnabled={aiEnabled}
                      channel={active}
                      document={documentActions}
                      onDescriptionSaved={onDescriptionSaved}
                      onSnippetsChange={() => setSnippetsRead((count) => count + 1)}
                      onTool={setTool}
                      setId={snippetSet}
                      tool={tool}
                    />
                  )}
                />
              </>
            ) : (
              <SyncedVersion
                channel={active}
                onFork={
                  canEdit
                    ? () =>
                        update((current) => ({
                          versions: forkVersion(
                            current.versions,
                            active,
                            current.value as PlateBody,
                            version.current,
                            Boolean(CAPABILITIES[active].thread)
                          ),
                        }))
                    : undefined
                }
                primary={primary}
                value={document.value as PlateBody}
              />
            )}
            {focus ? null : (
              <>
            <div
              className={cn('mb-6 flex flex-wrap justify-end gap-3', POST_COLUMN)}
              data-testid="platform-counters"
            >
              {/* An editor shows the edited platform's count in each post's header. */}
              {items
                .filter(
                  (item) =>
                    item.account.channel !== active ||
                    (active !== primary && versionOfTab.mode !== 'manual') ||
                    item.publication.serialized.posts.length === 0
                )
                .map((item) => {
                  const over = item.publication.serialized.posts.some(
                    (post) => post.length > item.publication.serialized.limit
                  )
                  return (
                    <span
                      className={cn(
                        'flex items-center gap-1 text-xs',
                        over ? 'text-red-700 dark:text-red-400' : 'text-muted-foreground'
                      )}
                      data-testid={`counter-${item.account.channel}`}
                      key={item.account.id}
                    >
                      <ChannelIcon channel={item.account.channel} />
                      {item.publication.serialized.length} / {item.publication.serialized.limit}
                    </span>
                  )
                })}
            </div>
            <DraftPosts
              canSchedule={canPublish}
              edited={edited}
              onReschedule={canPublish && edited.size > 0 ? () => setDialog('schedule') : undefined}
              onCancel={async (postId) => {
                try {
                  await trpcClient.scheduledPost.cancel.mutate({ scheduledPostId: postId })
                  await refreshPosts()
                  toast.success('Post cancelled.')
                } catch (error) {
                  toast.error(
                    error instanceof Error ? error.message : 'The post could not be cancelled.'
                  )
                }
              }}
              onChange={(changed) =>
                setPosts((current) =>
                  current.some((post) => post.id === changed.id)
                    ? current.map((post) => (post.id === changed.id ? changed : post))
                    : [changed, ...current]
                )
              }
              posts={posts}
            />
              </>
            )}
            <div className="h-32" />
          </div>
        </div>
        {panel && !focus && !narrow && !params.has('settings') ? (
          <aside
            aria-label={PANEL_TITLES[panel]}
            className="relative min-w-64 max-w-[48vw] overflow-y-auto border-l border-border animate-in fade-in duration-150"
            data-composer-panel
            style={{ width: panelWidth }}
          >
            <div
              role="separator"
              aria-label="Resize preview sidebar"
              aria-orientation="vertical"
              aria-valuemin={256}
              aria-valuemax={640}
              aria-valuenow={panelWidth}
              tabIndex={0}
              className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize touch-none hover:bg-sky-400 focus:bg-sky-400"
              onPointerDown={(event) => {
                resize.current = { x: event.clientX, width: panelWidth }
                event.currentTarget.setPointerCapture(event.pointerId)
              }}
              onPointerMove={(event) => {
                if (resize.current)
                  setPanelWidth(
                    Math.min(
                      640,
                      Math.max(256, resize.current.width + resize.current.x - event.clientX)
                    )
                  )
              }}
              onPointerUp={() => {
                resize.current = null
              }}
              onPointerCancel={() => {
                resize.current = null
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                  event.preventDefault()
                  setPanelWidth((width) =>
                    Math.min(640, Math.max(256, width + (event.key === 'ArrowLeft' ? 32 : -32)))
                  )
                }
              }}
            />
            <PanelHeader onClose={() => setPanel(null)} title={PANEL_TITLES[panel]} />
            {panelContent}
          </aside>
        ) : null}
        {panel && !focus && narrow && !params.has('settings') ? (
          <>
            <Sheet onOpenChange={(open) => !open && setPanel(null)} open>
              <SheetContent className="w-full overflow-y-auto p-0 sm:max-w-md" side="right">
                <SheetHeader>
                  <SheetTitle>{PANEL_TITLES[panel]}</SheetTitle>
                  <SheetDescription className="sr-only">
                    {PANEL_TITLES[panel]} for this draft
                  </SheetDescription>
                </SheetHeader>
                {panelContent}
              </SheetContent>
            </Sheet>
          </>
        ) : null}
        {description ? (
          <PreviewImageDescription
            assetId={description.assetId}
            initialAlt={description.alt}
            onClose={() => setDescription(null)}
            onSaved={(alt) => onDescriptionSaved(description.assetId, alt)}
          />
        ) : null}
        {dialog === 'schedule' || dialog === 'queue' ? (
          <ScheduleDialog
            context={context}
            initialDay={params.get('day') ?? undefined}
            initialTime={params.get('time') ?? undefined}
            initialQueue={dialog === 'queue'}
            onPreview={() => {
              setDialog(null)
              setPanel('preview')
            }}
            onClose={() => setDialog(null)}
          />
        ) : null}
        {dialog === 'publish' ? (
          <PublishReview
            context={context}
            onClose={() => setDialog(null)}
            onPreview={() => {
              setDialog(null)
              setPanel('preview')
            }}
          />
        ) : null}
        {dialog === 'manage' ? (
          <ManagePlatformsDialog
            accounts={accounts}
            onConnect={
              canManageSets && set
                ? async (provider) => {
                    try {
                      await flush()
                      window.location.assign(
                        `${connectHref(provider, set.id)}&${new URLSearchParams({ returnTo: `/publish/${initial.id}` })}`
                      )
                    } catch (error) {
                      toast.error(
                        error instanceof Error
                          ? error.message
                          : 'Save the draft before connecting an account.'
                      )
                    }
                  }
                : undefined
            }
            draftVersion={version.current}
            enabled={enabled}
            kind={server.kind}
            onChange={(change) =>
              update({
                ...(change.channelConnectionIds
                  ? { channelConnectionIds: change.channelConnectionIds }
                  : {}),
                ...(change.primaryPlatform ? { primaryPlatform: change.primaryPlatform } : {}),
                ...(change.versions ? { versions: change.versions } : {}),
              })
            }
            onClose={() => setDialog(null)}
            primary={primary}
            value={document.value as PlateBody}
            versions={document.versions}
          />
        ) : null}
        {dialog === 'share' ? (
          <ShareDialog
            onInsertLink={
              CAPABILITIES[active].thread
                ? (link) => {
                    if (editor.current) appendPost(editor.current, `Read the thread: ${link}`)
                  }
                : undefined
            }
            canEdit={canEdit}
            draft={server}
            onClose={() => {
              setDialog(null)
              requestAnimationFrame(() => shareButton.current?.focus())
            }}
            onDraft={setServer}
          />
        ) : null}
        {dialog === 'copy-poll' && copiedPoll ? (
          <CopyPollDialog
            source={copiedPoll.channel}
            poll={copiedPoll.poll}
            destinations={accounts.map((account) => ({
              channel: account.channel,
              limits: account.pollLimits,
            }))}
            onClose={() => setDialog(null)}
            onPrepare={(target) => {
              if (target !== primary && versionFor(document.versions, target).mode !== 'manual')
                update((current) => ({
                  versions: forkVersion(
                    current.versions,
                    target,
                    current.value as PlateBody,
                    server.version,
                    Boolean(CAPABILITIES[target].thread)
                  ),
                }))
              setTab(target)
            }}
            onCopy={(target, poll) => {
              const current = editor.current
              const index = current?.children.findIndex((node) => node.type === 'post_break') ?? -1
              if (!current || editorChannel.current !== target || index < 0) {
                toast.info('Wait for the destination editor to load, then copy the poll.')
                return false
              }
              current.tf.setNodes({ poll: structuredClone(poll) }, { at: [index] })
              toast.success('Poll copied. Review the destination before scheduling.')
              return true
            }}
          />
        ) : null}
        {dialog === 'media' && editorInstance && services.uploadFile ? (
          <MediaImportDialog
            editor={editorInstance}
            uploadFile={services.uploadFile}
            draftId={initial.id}
            returnedAsset={params.get('attach') ?? undefined}
            onClose={() => {
              setDialog(null)
              const url = new URL(window.location.href)
              url.searchParams.delete('attach')
              window.history.replaceState(null, '', url)
            }}
          />
        ) : null}
        {dialog === 'paste' ? (
          <PasteThreadDialog
            channel={active}
            editor={editor}
            limit={activePublication.serialized.limit}
            onClose={() => setDialog(null)}
          />
        ) : null}
        {dialog === 'backups' ? (
          <BackupsBrowser
            channels={channels}
            current={document.value as PlateBody}
            draftId={initial.id}
            onClose={() => setDialog(null)}
          />
        ) : null}
        {dialog === 'compare' ? (
          <CompareDialog
            channel={active}
            onClose={() => setDialog(null)}
            primary={primary}
            value={document.value as PlateBody}
            versions={document.versions}
          />
        ) : null}
      </div>
  )
  return (
    <SocialMentionContext.Provider
      value={{ channel: active, setId: server.socialSetId ?? set?.id ?? null }}
    >
      <HashtagsContext.Provider value={vocabulary.hashtags}>
      <ComposerCommandsContext.Provider
        value={{
          addMedia,
          channel: active,
          channels,
          giphy,
          openTool: setTool,
          postSetting: (number, setting) => setPostSetting({ at: Date.now(), number, setting }),
          snippets,
        }}
      >
        <PostSettingRequestContext.Provider value={postSetting}>
          {aiEnabled ? (
            <RefineProvider
              channel={active}
              draftId={initial.id}
              editor={editor}
              limit={activePublication.serialized.limit}
              limitFor={limitFor}
              onVersion={writeVersion}
              versionBase={(target) =>
                adaptBody(
                  (editor.current?.children ?? document.value) as PlateBody,
                  Boolean(CAPABILITIES[target].thread)
                )
              }
            >
              {composer}
            </RefineProvider>
          ) : (
            composer
          )}
        </PostSettingRequestContext.Provider>
      </ComposerCommandsContext.Provider>
      </HashtagsContext.Provider>
    </SocialMentionContext.Provider>
  )
}

/** The empty post's prompt per platform, as each platform asks it. */
const PLACEHOLDERS: Partial<Record<DraftChannel, string>> = {
  tiktok: 'Write your TikTok caption…',
  x: 'What’s happening?',
}

/** Up to two initials for an avatar without an image. */
function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0]?.toUpperCase())
      .join('') || 'S'
  )
}

/**
 * A post's length for the platform being edited: a ring that fills toward
 * the limit, amber from 90%, red past it. Quiet posts hide it until it nears
 * the limit; the post in use always shows it.
 */
function PostCount({
  active,
  length,
  limit,
  number,
  thread,
}: {
  active: boolean
  length: number
  limit: number
  number: number
  thread: boolean
}) {
  const ratio = length / limit
  const tone =
    ratio > 1
      ? 'text-destructive'
      : ratio >= 0.9
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-muted-foreground'
  return (
    <span
      className={cn(
        'flex items-center gap-1.5 text-caption tabular-nums transition-opacity duration-150 motion-reduce:transition-none',
        tone,
        !active && ratio < 0.9 && 'opacity-0'
      )}
    >
      <span
        aria-hidden
        className="size-4 rounded-full"
        style={{
          background: `conic-gradient(currentColor ${Math.min(ratio, 1) * 360}deg, color-mix(in srgb, currentColor 20%, transparent) 0)`,
          mask: 'radial-gradient(farthest-side, transparent calc(100% - 2.5px), black calc(100% - 2px))',
        }}
      />
      <span data-testid={`post-length-${number}`}>
        {length} / {limit}
      </span>
      {thread ? <span className="text-muted-foreground">#{number}</span> : null}
    </span>
  )
}

/** Panel titles. */
const PANEL_TITLES: Record<Panel, string> = {
  assistant: 'Writing assistant',
  comments: 'Comments',
  preview: 'Preview',
  properties: 'Draft details',
}

/** The stored discussions, read once for the editor's first render. */
function readDiscussionsOnce(draft: DraftWire) {
  const discussions = draft.discussions as {
    threads?: unknown[]
    users?: Record<string, { id: string; name: string }>
  }
  return {
    threads: (discussions.threads ?? []) as never[],
    users: discussions.users ?? {},
  }
}

function PanelButton({
  active,
  className,
  icon,
  label,
  onClick,
  shortcut,
}: {
  active: boolean
  className?: string
  icon: React.ReactNode
  label: string
  onClick: () => void
  shortcut?: string
}) {
  return (
    <Button
      aria-label={label}
      aria-pressed={active}
      className={cn('size-8 px-0', active && 'bg-foreground/[0.08] text-foreground', className)}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      size="sm"
      title={shortcut ? `${label} (${shortcut})` : label}
      variant="ghost"
    >
      {icon}
    </Button>
  )
}

function PanelHeader({ onClose, title }: { onClose: () => void; title: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border px-4 py-2">
      <h2 className="text-ui-lg font-medium text-foreground">{title}</h2>
      <Button
        aria-label={`Close ${title}`}
        className="size-8 px-0"
        onClick={onClose}
        size="sm"
        title={`Close ${title}`}
        variant="ghost"
      >
        <XIcon aria-hidden className="size-4" />
      </Button>
    </div>
  )
}

/** The post a reply answers or a quote embeds, above the text. */
function TargetBanner({ draft }: { draft: DraftWire }) {
  if (!draft.target || draft.kind === 'standard') return null
  const label = {
    article: 'Article',
    quote: 'Quoting',
    reply: 'Replying to',
    repurpose: 'Repurposed from',
    standard: '',
  }[draft.kind]
  return (
    <div
      className={cn('mb-2 flex items-center gap-2 text-xs text-muted-foreground', POST_COLUMN)}
      data-testid="draft-target"
    >
      <span className="rounded-full bg-foreground/[0.06] px-2 py-0.5">{label}</span>
      {draft.target.url ? (
        <a
          className="truncate text-sky-700 dark:text-sky-300 hover:underline"
          href={draft.target.url}
          rel="noreferrer"
          target="_blank"
        >
          {draft.target.url}
        </a>
      ) : (
        <span>a published draft</span>
      )}
    </div>
  )
}
