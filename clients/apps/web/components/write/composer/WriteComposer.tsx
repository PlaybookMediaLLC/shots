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
import { ListPlusIcon as ListPlus } from '@phosphor-icons/react/dist/ssr/ListPlus'
import { InfoIcon } from '@phosphor-icons/react/dist/ssr/Info'
import { ScissorsIcon } from '@phosphor-icons/react/dist/ssr/Scissors'
import { CaretRightIcon } from '@phosphor-icons/react/dist/ssr/CaretRight'
import { DotsThreeIcon } from '@phosphor-icons/react/dist/ssr/DotsThree'
import { XIcon } from '@phosphor-icons/react/dist/ssr/X'
import { toast } from 'sonner'
import type { Value } from '@shots/platejs-editor/platejs'
import type { PlateEditor } from '@shots/platejs-editor/platejs/react'
import { connectHref } from '@/components/settings/social-sets/api'
import { Pill } from '@/components/platform-ui'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
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
import {
  BrandSettingsButton,
  openBrandSettings,
  settingsOpen,
} from '@/components/drafts/DraftSettingsDrawer'
import { usePreferences } from '@/components/settings/PreferencesProvider'
import { ReviewControls } from '@/components/drafts/DraftTools'
import {
  appendPost,
  deletePost,
  movePost,
  postRanges,
  splitPostAtCaret,
} from '@/components/drafts/thread'
import { overflowStart, type PostExcess, setOverLimit } from '@/components/drafts/over-limit'
import { POST_COLUMN } from '@/components/drafts/layout'
import {
  DraftRequestError,
  type DraftPostWire,
  type DraftWire,
  draftsApi,
} from '@/lib/content-drafts/client'
import { currentPosts, draftPostsState, draftStatus } from '@/lib/content-drafts/post-status'
import { renderBlockImages } from '@/lib/content-drafts/render-blocks'
import {
  serializeDraft,
  type BlockImages,
  channelForPlatform,
  draftPlainText,
  platformLabel,
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
import { splitThread } from '@/lib/write/split-thread'
import { convertLegacyBlocks, legacyCount } from '@/lib/write/legacy-blocks'
import {
  adaptBody,
  bodyFor,
  bodyPosts,
  forkVersion,
  otherPlatformNamed,
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
  ActivePlatform,
  allChannels,
  ConnectMenu,
  ResyncDialog,
  ManualVersionNotice,
  OptionsChip,
  PlatformTabs,
  SyncedVersion,
  tabChannels,
  toggledPlatforms,
} from './platforms'
import { PostSettingRequestContext, PostSettingsTools, type PostSettingRequest } from './post-tools'
import { PreviewPanel, type PreviewItem, type PreviewSelection } from './preview'
import { PropertiesPanel } from './properties'
import {
  blockerFixLabel,
  PublishReview,
  type ScheduleBlocker,
  scheduleBlockers,
  ScheduleDialog,
  type ScheduleContext,
} from './schedule'
import { socialSetHref } from '@/components/workspace/settings-sections'
import { BackupsBrowser, ShareDialog } from './share-backups'
import { AssistantPanel } from './assistant'
import { withAssetDescription } from '@/lib/write/media-operations'
import { PreviewImageDescription } from './describe-images'
import { MediaImportDialog } from './media-import-dialog'
import { MediaStrip } from './media-strip'
import { attachmentsIn } from '@/lib/write/media-operations'
import { mediaSwitches } from '@/lib/write/platform-rules'
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
  setMentionLookup,
  SocialMentionPlugin,
  SocialMentionInputPlugins,
  SocialMentionContext,
} from './social-mention'
import { type SaveState, useDraftDocument } from './useDraftDocument'
import { VersionOptionsBar } from './version-options'
import { VideoOptions } from './video-options'

// The editor kit is heavy; only the composer loads it, after the page renders.
const DraftEditor = dynamic(() => import('@/components/drafts/DraftEditor'), {
  loading: () => (
    <div className="min-h-[420px] p-6 text-sm text-muted-foreground">Loading editor…</div>
  ),
  ssr: false,
})

/** What the header's publishing buttons start. */
type PublishAction = 'publish' | 'queue' | 'schedule'

/** The panels beside the draft. */
type Panel = 'properties' | 'preview' | 'comments' | 'assistant' | 'options'

/** The dialogs the composer opens. */
type Dialog =
  | 'schedule'
  | 'queue'
  | 'publish'
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
 * Keeps a sticky side panel within the part of its scrolling area that shows.
 * The Publish tabs above that area come and go with the sidebar, so the panel
 * reads the area's height instead of the frame's.
 */
function fitToScroller(panel: HTMLElement | null) {
  const scroller = panel?.closest('main')
  if (!panel || !scroller) return
  const fit = () => panel.style.setProperty('max-height', `${scroller.clientHeight}px`)
  fit()
  const observer = new ResizeObserver(fit)
  observer.observe(scroller)
  return () => observer.disconnect()
}

/**
 * The Write composer (RFC 025). The draft is its primary body plus a version
 * per platform; the tab being edited is UI state only. Destinations,
 * versions, options and the body save together against the draft's version.
 * Previews, the review and the schedule all use the publication the backend
 * receives.
 */

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
  const { alt, mod } = useKeys()
  const narrow = useIsMobile()
  const trpcClient = useTRPCClient()
  const {
    beforeLeaveRef,
    draftCommandsRef,
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
        channelConnectionIds: saved.channelConnectionIds,
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
          : null
  )
  const [focus, setFocus] = React.useState(false)
  // Where two blockers are fixed: the edit conflict and the review.
  const conflictBanner = React.useRef<HTMLDivElement>(null)
  const reviewControls = React.useRef<HTMLSpanElement>(null)
  // The preview starts on a phone, where most posts are read.
  const [previewSelection, setPreviewSelection] = React.useState<PreviewSelection>({
    channel: null,
    device: 'iPhone 16',
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
  const [resync, setResync] = React.useState<DraftChannel | null>(null)
  const primary = document.primaryPlatform
  const accounts = set?.accounts ?? []
  const enabled = document.channelConnectionIds
  const channels = tabChannels(accounts, enabled, primary)
  // A switched-off platform keeps its tab, so it can be read and switched back on.
  const active = allChannels(accounts, primary).includes(tab) ? tab : primary
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
  // Opening or closing a side panel changes the composer's width, so the sticky
  // header can rewrap, and the browser then resets the draft's scroll to the
  // top. The draft stays where it was scrolled.
  const draftScroll = React.useRef(0)
  React.useEffect(() => {
    const main = bodyArea.current?.closest('main')
    if (!main) return
    const remember = () => {
      draftScroll.current = main.scrollTop
    }
    remember()
    main.addEventListener('scroll', remember, { passive: true })
    return () => main.removeEventListener('scroll', remember)
  }, [])
  // Preview takes the draft's place, so coming back returns to where it was left, caret included.
  const scrollBeforePreview = React.useRef<number | null>(null)
  React.useLayoutEffect(() => {
    const main = bodyArea.current?.closest('main')
    if (!main) return
    if (panel === 'preview') {
      // Hiding the editor drops its focus without a blur event, and Slate won't refocus an
      // editor it believes is focused, so it has to be told before coming back.
      if (scrollBeforePreview.current === null) editor.current?.tf.blur()
      scrollBeforePreview.current ??= draftScroll.current
      return
    }
    if (scrollBeforePreview.current !== null) {
      main.scrollTop = draftScroll.current = scrollBeforePreview.current
      scrollBeforePreview.current = null
      editor.current?.tf.focus()
    } else if (main.scrollTop !== draftScroll.current) main.scrollTop = draftScroll.current
  }, [panel])
  const [pasteNotice, setPasteNotice] = React.useState(false)

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
  const publishing = items.some((item) => item.account.channel === active)
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
  // Platforms switched off for lacking media, and those the person chose to keep on regardless.
  const switchedOff = React.useRef(new Set<string>())
  const keptOn = React.useRef(new Set<string>())
  const applySwitch = (accountId: string, on: boolean) => {
    const account = accounts.find((item) => item.id === accountId)
    if (!account) return
    update((current) =>
      toggledPlatforms(accounts, account, on, {
        enabled: current.channelConnectionIds,
        primary: current.primaryPlatform,
        versions: current.versions,
      })
    )
  }
  const toggle = (accountId: string, on: boolean) => {
    switchedOff.current.delete(accountId)
    if (on) keptOn.current.add(accountId)
    else keptOn.current.delete(accountId)
    applySwitch(accountId, on)
  }
  const mediaAccounts = accounts.map((account) => {
    const version = versionFor(document.versions, account.channel)
    const body =
      account.channel !== primary && version.mode === 'manual'
        ? ((version.body ?? []) as Value)
        : document.value
    return {
      channel: account.channel,
      hasMedia: body.some((node) => attachmentsIn(node).length > 0),
      hasText: Boolean(serializeDraft(body, account.channel).caption.trim()),
      id: account.id,
    }
  })
  const mediaState = JSON.stringify([mediaAccounts, enabled])
  const openedAs = React.useRef(mediaState)
  React.useEffect(() => {
    // Opening a draft changes nothing, and editing can't change what is already scheduled.
    if (mediaState === openedAs.current || !canEdit || posts.length > 0) return
    openedAs.current = ''
    const { off, on } = mediaSwitches(mediaAccounts, enabled, switchedOff.current, keptOn.current)
    for (const id of on) {
      switchedOff.current.delete(id)
      applySwitch(id, true)
    }
    if (off.length === 0) return
    for (const id of off) {
      switchedOff.current.add(id)
      applySwitch(id, false)
    }
    const names = off.map((id) => {
      const channel = accounts.find((item) => item.id === id)?.channel
      return channel ? CHANNEL_META[channel].label : 'A platform'
    })
    toast(`${names.join(' and ')} switched off: this post has no media yet.`, {
      action: { label: 'Undo', onClick: () => off.forEach((id) => toggle(id, true)) },
    })
    // Only a change in the post or its destinations can change the answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaState])
  const setOptions = (channel: DraftChannel, options: VersionOptions) =>
    update((current) => ({ versions: withOptions(current.versions, channel, options) }))
  // A destination that is live is done: scheduling again would post it twice.
  const live = new Set(
    posts.filter((post) => post.status === 'PUBLISHED').map((post) => post.channelConnectionId)
  )
  const pending = items.filter((item) => !live.has(item.account.id))
  const locked = items.length > 0 && pending.length === 0
  const context: ScheduleContext = {
    kind: server.kind,
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
    items: pending,
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
    // The Calendar's unschedule cancels every queued post in one step and, unlike
    // a cancel, needs no fresh sign-in. It refuses a draft with published
    // results, so such a draft offers no Undo. It keeps the posts' time as a
    // plan, so Undo puts back the plan the draft had before.
    undoSchedule: posts.some((post) => post.status === 'PUBLISHED' || post.url)
      ? undefined
      : async (before, postId) => {
          try {
            const current = await draftsApi.get(before.id)
            const [unscheduled] = (
              await writeApi.unschedule({
                at: null,
                calendarVersion: current.calendarVersion,
                draftId: current.id,
                postId,
                timeZone: 'UTC',
                version: current.version,
              })
            ).drafts
            setServer(unscheduled)
            let message = 'Undone. Nothing from that schedule will publish.'
            const plan =
              before.plannedFor && new Date(before.plannedFor) > new Date()
                ? before.plannedFor
                : null
            // Planning is an edit: a publisher who cannot edit keeps the time as a plan.
            if (!canEdit && unscheduled.plannedFor !== plan)
              message += ' The draft keeps that time as its plan.'
            else if (unscheduled.plannedFor !== plan)
              await writeApi
                .plan(unscheduled.id, {
                  baseCalendarVersion: unscheduled.calendarVersion,
                  plannedFor: plan,
                  timeZone: before.planTimeZone ?? undefined,
                })
                .then(setServer, (error: unknown) => {
                  message += ` The draft keeps that time as its plan: ${error instanceof Error ? error.message : 'it could not be changed.'}`
                })
            toast.success(message)
          } catch (error) {
            toast.error(
              `Not undone. ${error instanceof Error ? error.message : 'Check the draft for posts that are still queued.'}`
            )
          }
          await refreshPosts().catch(() => router.refresh())
        },
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
  // Copy written for another of this draft's platforms is easy to miss on a synced tab.
  const namedElsewhere = otherPlatformNamed(
    activePublication.serialized.posts.map((post) => post.caption).join('\n'),
    active,
    channels
  )
  // The platforms with a post over their limit: their tabs and counters say so.
  const over = items
    .filter((item) =>
      item.publication.serialized.posts.some((post) => post.length > item.publication.serialized.limit)
    )
    .map((item) => item.account.channel)
  // Blockers show beside Schedule once there is something to post, not on an empty draft.
  const blockers =
    !locked && items.some((item) => item.publication.serialized.posts.length > 0)
      ? scheduleBlockers({
          approved,
          canPublish: canPublish && server.status !== 'archived',
          conflict: conflict !== null,
          draft: server,
          items: pending,
          requireApproval,
          saveState,
        })
      : []
  const [blockersOpen, setBlockersOpen] = React.useState(false)
  const [blockedAction, setBlockedAction] = React.useState<PublishAction | null>(null)
  const [postAgain, setPostAgain] = React.useState(false)
  // Every way to schedule or publish comes through here: what is missing is fixed first.
  const startPublishing = (action: PublishAction) => {
    if (locked) return setPostAgain(true)
    // An archived draft has no checklist in its header: the review says to restore it.
    if (blockers.length === 0 || server.status === 'archived') return setDialog(action)
    setBlockedAction(action)
    setBlockersOpen(true)
  }
  // The checklist closes with its last item, so the next blocker cannot reopen it unasked.
  const anyBlockers = blockers.length > 0
  React.useEffect(() => {
    if (anyBlockers) return
    setBlockersOpen(false)
    setBlockedAction(null)
  }, [anyBlockers])
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
      run: () => canPublish && startPublishing('publish'),
      inEditor: true,
    },
    {
      alt: true,
      key: 'enter',
      label: 'Next free slot',
      mod: true,
      run: () => canPublish && startPublishing('queue'),
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
  // Each blocker opens the place where it is fixed.
  const jumpTo = (blocker: ScheduleBlocker) => {
    if (blocker.channel && channels.includes(blocker.channel)) setTab(blocker.channel)
    if (blocker.fix === 'save') context.retrySave()
    else if (blocker.fix === 'account')
      focusRoot.current
        ?.querySelector<HTMLElement>('[data-testid="platform-tabs"] [role="switch"]')
        ?.focus()
    else if (blocker.fix === 'restore') {
      if (canEdit) void archive('draft')
    } else if (blocker.fix === 'conflict') conflictBanner.current?.querySelector('button')?.focus()
    else if (blocker.fix === 'review') reviewControls.current?.querySelector('button')?.focus()
    else if (blocker.options) {
      setFocus(false)
      // The required settings sit above the post; the first one missing takes focus,
      // after the tab has changed and the popover has handed focus back.
      setTimeout(() => {
        const missing = focusRoot.current?.querySelector<HTMLElement>('[data-option-missing]')
        // Anything else that is wrong is in the rest of the settings, beside the draft.
        if (!missing) return setPanel('options')
        missing.scrollIntoView({ block: 'center' })
        missing.focus()
        // Focus from a click draws no ring, so the row flashes to show where to look.
        ;(missing.closest('[data-option-rows] > *') ?? missing).animate(
          [{ boxShadow: 'inset 0 0 0 2px #f59e0b' }, { boxShadow: 'inset 0 0 0 2px transparent' }],
          { duration: 2000, easing: 'ease-in' }
        )
      }, 50)
    } else if (blocker.channel) editor.current?.tf.focus()
  }
  // The palette lists this draft's actions with their shortcuts, as its menus do.
  React.useEffect(() => {
    const live = canPublish && server.status !== 'archived'
    draftCommandsRef.current = [
      ...(live
        ? [
            { label: 'Schedule…', run: () => startPublishing('schedule') },
            {
              label: 'Add to the next free slot',
              run: () => startPublishing('queue'),
              shortcut: `${mod}${alt}↵`,
            },
            { label: 'Publish now…', run: () => startPublishing('publish'), shortcut: `${mod}⇧↵` },
          ]
        : []),
      { label: 'Post options', run: () => setPanel('options') },
      { label: 'Draft details', run: () => setPanel('properties'), shortcut: `${mod}\\` },
      { label: 'Share…', run: () => setDialog('share'), shortcut: `${mod}${alt}S` },
      { label: 'View automatic backups', run: () => setDialog('backups') },
      ...(canEdit
        ? [
            {
              label: server.pinnedAt ? 'Unpin draft' : 'Pin draft',
              run: () => void pin(),
              shortcut: `${mod}⇧P`,
            },
          ]
        : []),
      {
        label: focus ? 'Leave focus mode' : 'Focus mode',
        run: () => setFocus((current) => !current),
        shortcut: `${mod}⇧F`,
      },
      {
        label: compact ? 'Comfortable display' : 'Compact display',
        run: () => setCompact((current) => !current),
        shortcut: `${mod}⇧H`,
      },
      ...(canEdit
        ? [
            {
              label: server.status === 'archived' ? 'Restore from archive' : 'Archive draft',
              run: () => void archive(server.status === 'archived' ? 'draft' : 'archived'),
            },
          ]
        : []),
    ]
    return () => {
      draftCommandsRef.current = []
    }
  })
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
  React.useEffect(() => {
    if (editorInstance) setMentionLookup(editorInstance, active)
  }, [active, editorInstance])
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
    // An empty post in a thread is dropped when published: say so, and offer to remove it.
    if (!post)
      return canEdit && CAPABILITIES[active].thread && postCount > 1 ? (
        <span
          className="flex items-center gap-1 text-caption text-amber-700 dark:text-amber-300"
          data-testid={`empty-post-${number}`}
        >
          Empty, not sent
          <Button
            className="h-6 px-1.5 text-xs"
            onClick={() => editor.current && deletePost(editor.current, number)}
            size={null}
            variant="ghost"
          >
            Remove empty post
          </Button>
        </span>
      ) : null
    return (
      <>
        <PostCount
          active={inUse}
          length={post.length}
          limit={activePublication.serialized.limit}
          number={number}
          thread={Boolean(CAPABILITIES[active].thread)}
        />
        {excess[number] && CAPABILITIES[active].thread ? (
          <Button
            className="h-6 px-1.5 text-xs"
            onClick={() => splitAtLimit(number)}
            size={null}
            variant="ghost"
          >
            Split into thread
          </Button>
        ) : null}
      </>
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
  // A post that is live everywhere does not change with this text, so it is not editable.
  const canEditText = canEdit && !locked
  // A tab that follows the main platform has no editor of its own: its media lives on that tab.
  const ownEditor = active === primary || versionOfTab.mode === 'manual'
  const liveOn = [
    ...new Set(
      posts.filter((post) => post.status === 'PUBLISHED').map((post) => platformLabel(post.platform))
    ),
  ].join(', ')
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
      settings: canEditText
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
    readOnly: !canEditText,
    services,
    // Text runs in the direction the person chose in Appearance (RFC 024).
    textDirection,
    title: document.title,
    user,
  }
  // The destinations' state that needs attention first; a plan only when nothing is queued.
  const status = draftStatus(server, draftPostsState(currentPosts(posts)))
  // Thread splitting for the edited platform; only the instance told about a paste splits it.
  const threadTools =
    canEditText &&
    server.kind !== 'article' &&
    CAPABILITIES[active].thread &&
    (active === primary || versionOfTab.mode === 'manual')
      ? (pasted: boolean) => (
          <ThreadTools
            pasted={pasted}
            onSplit={() => setPasteNotice(false)}
            editor={editor}
            channel={active}
            limit={activePublication.serialized.limit}
            options={versionOfTab.options ?? {}}
            onChange={(options) => setOptions(active, options)}
          />
        )
      : null
  // Shown options take a paste's split; otherwise its tools show above the text.
  const optionsShown = panel === 'options' && !focus && !settingsOpen(params)
  const previewPanel = (
      <PreviewPanel
        initialChannel={active}
        onDescribe={canEdit ? (media) => setDescription(media) : undefined}
        onSelect={(next) => {
          // The platform shown is the tab being edited, whichever side changes it.
          if (next.channel) setTab(next.channel)
          setPreviewSelection({ ...next, channel: null })
        }}
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
  )
  const connectAccount =
    canManageSets && set
      ? async (provider: string) => {
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
  // Preview takes the draft's place; every other panel sits beside it.
  const sidePanel = panel === 'preview' ? null : panel
  const previewing = panel === 'preview' && !focus
  const panelContent =
    panel === 'options' ? (
      <div data-testid="post-options">
        <VersionOptionsBar
          channel={active}
          captionLimit={activePublication.serialized.limit}
          onApplyFinisher={
            canEditText && (active === primary || versionOfTab.mode === 'manual')
              ? (text, quoteFirstPost) => {
                  if (editor.current)
                    appendPost(editor.current, text, quoteFirstPost ? { quoteFirstPost: true } : {})
                }
              : undefined
          }
          onChange={(options) => setOptions(active, options)}
          options={versionOfTab.options ?? {}}
          postCount={activePublication.serialized.posts.length}
          readOnly={!canEditText}
          setId={server.socialSetId ?? set?.id ?? null}
          uploadFile={
            services.uploadFile
              ? async (file) => ({ assetId: (await services.uploadFile!(file)).assetId ?? '' })
              : undefined
          }
        />
        {threadTools?.(pasteNotice)}
      </div>
    ) : panel === 'properties' ? (
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
        status={status?.label ?? 'Draft'}
        title={document.title}
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
          canEditText && (active === primary || versionOfTab.mode === 'manual')
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
              // The brand's dot shows only beside its name: alone, it read as a save indicator.
              <span
                className={cn(
                  'hidden items-center gap-1.5 text-xs text-muted-foreground',
                  !sidePanel && 'xl:flex'
                )}
                data-testid="composer-identity"
                title={`Writing as ${set.name}`}
              >
                <SetDot color={set.color} />
                <span className="max-w-32 truncate">{set.name}</span>
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
              placeholder="Add a title"
              value={document.title}
            />
            {/* Wide enough for the everyday labels, so the header never shifts. */}
            <span
              className={cn(
                'min-w-[8ch] shrink-0 text-xs',
                saveState === 'error' || saveState === 'offline'
                  ? 'text-amber-700 dark:text-amber-300'
                  : 'text-muted-foreground'
              )}
              data-testid="save-state"
              role="status"
            >
              {SAVE_LABELS[saveState]}
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
            {requireApproval || canEdit || server.reviewStatus !== 'none' ? (
              <span className="contents" ref={reviewControls}>
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
              </span>
            ) : null}
            {/* The actions wrap inside the column, so a panel beside it is never drawn over. */}
            <div
              className="ml-auto flex max-w-full min-w-0 flex-wrap items-center justify-end gap-1"
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
                className={cn('hidden', !focus && 'lg:inline-flex', sidePanel && 'size-8 px-0')}
                onClick={() => setDialog('share')}
                size="sm"
                title={`Share (${mod}${alt}S)`}
                variant="ghost"
              >
                {sidePanel ? <Share2 aria-hidden className="size-4" /> : 'Share'}
              </Button>
              {canPublish && server.status !== 'archived' && locked ? (
                <Button
                  data-testid="post-again-button"
                  onClick={() => setPostAgain(true)}
                  size="sm"
                  variant="outline"
                >
                  Post again as new…
                </Button>
              ) : null}
              {canPublish && server.status !== 'archived' && !locked ? (
                <>
                  {blockers.length > 0 ? (
                    <Blockers
                      action={blockedAction}
                      blockers={blockers}
                      onJump={jumpTo}
                      onOpenChange={(open) => {
                        setBlockersOpen(open)
                        if (!open) setBlockedAction(null)
                      }}
                      onProceed={(action) => setDialog(action)}
                      onRemove={
                        canEdit && items.length > 1
                          ? (channel) => {
                              const off = items.find((item) => item.account.channel === channel)
                              if (off) toggle(off.account.id, false)
                            }
                          : undefined
                      }
                      open={blockersOpen}
                    />
                  ) : null}
                  <Button
                    className={cn('hidden', !focus && 'sm:inline-flex')}
                    data-testid="publish-button"
                    onClick={() => startPublishing('publish')}
                    size="sm"
                    title={
                      blockers.length > 0
                        ? 'Shows what to fix before publishing'
                        : `Review and publish now (${mod}⇧↵)`
                    }
                    variant="outline"
                  >
                    Publish now…
                  </Button>
                  {/* Schedule picks a time; its arrow takes the next free queue slot. */}
                  <span className="flex items-center" role="group" aria-label="Schedule">
                    <Button
                      className="rounded-r-none"
                      data-testid="schedule-button"
                      onClick={() => startPublishing('schedule')}
                      size="sm"
                      title={
                        blockers.length > 0 ? 'Shows what to fix before scheduling' : 'Choose a time'
                      }
                    >
                      {posts.some((post) => post.status === 'SCHEDULED')
                        ? 'Reschedule'
                        : live.size > 0
                          ? 'Schedule the rest'
                          : 'Schedule'}
                    </Button>
                    <Button
                      aria-label="Add to the next free slot"
                      className="rounded-l-none border-l border-background/25 px-2"
                      data-testid="queue-button"
                      onClick={() => startPublishing('queue')}
                      size="sm"
                      title={
                        blockers.length > 0
                          ? 'Shows what to fix before scheduling'
                          : `Add to the next free slot (${mod}${alt}↵)`
                      }
                    >
                      <ListPlus aria-hidden className="size-4" />
                    </Button>
                  </span>
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
                  {canPublish && server.status !== 'archived' && !locked ? (
                    <>
                      <DropdownMenuItem onSelect={() => startPublishing('queue')}>
                        Add to queue
                        <DropdownMenuShortcut>
                          {mod}
                          {alt}↵
                        </DropdownMenuShortcut>
                      </DropdownMenuItem>
                      <DropdownMenuItem className="sm:hidden" onSelect={() => startPublishing('publish')}>
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
                          Profile settings…
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
              ref={conflictBanner}
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
              {connectAccount ? (
                <ConnectMenu accounts={accounts} onConnect={connectAccount} />
              ) : null}
            </div>
          ) : null}
          {/* Focus mode (⌘⇧F) keeps the posts and Schedule; everything else steps away. */}
          {focus ? null : (
            <>
          <PlatformTabs
            accounts={accounts}
            active={active}
            canEdit={canEdit}
            enabled={enabled}
            kind={server.kind}
            onSelect={setTab}
            onToggle={toggle}
            over={over}
            blocked={blockers.flatMap((blocker) => (blocker.channel ? [blocker.channel] : []))}
            options={
              // TikTok's options all sit in its section below; an off platform has none to set.
              publishing && active !== 'tiktok' ? (
                <OptionsChip
                  blocked={activePublication.optionProblems.length > 0}
                  channel={active}
                  onClick={() => togglePanel('options')}
                  open={panel === 'options'}
                  options={versionOfTab.options ?? {}}
                />
              ) : null
            }
            primary={primary}
            value={document.value as PlateBody}
            versions={document.versions}
          />
          <ActivePlatform
            accounts={accounts}
            active={active}
            canEdit={canEdit}
            defaultsHref={set ? socialSetHref(set.id, 'new-draft') : undefined}
            draftVersion={version.current}
            enabled={enabled}
            kind={server.kind}
            onChange={(change) =>
              update({
                ...(change.primaryPlatform ? { primaryPlatform: change.primaryPlatform } : {}),
                ...(change.versions ? { versions: change.versions } : {}),
              })
            }
            onConnect={connectAccount}
            onResync={setResync}
            onToggle={toggle}
            primary={primary}
            value={document.value as PlateBody}
            versions={document.versions}
          />
          {/* What this platform must have is on the page, not behind the options chip. */}
          {(active === 'tiktok' || active === 'youtube') && publishing ? (
            <section
              aria-label={`${CHANNEL_META[active].label} settings`}
              className={cn(
                'mx-4 mb-3 rounded-xl border',
                activePublication.optionProblems.length > 0
                  ? 'border-amber-400/50'
                  : 'border-border'
              )}
              data-testid="required-options"
            >
              <VideoOptions
                channel={active}
                creator={accounts.find((item) => item.channel === active)?.tiktokCreator}
                disabled={!canEdit}
                onChange={(options) => setOptions(active, options)}
                options={versionOfTab.options ?? {}}
              />
            </section>
          ) : null}
          {namedElsewhere ? (
            <p
              className="mx-4 mb-3 rounded-lg border border-amber-400/30 bg-amber-400/[0.05] px-3 py-2 text-xs text-amber-700 dark:text-amber-200"
              data-testid="names-other-platform"
              role="status"
            >
              This {CHANNEL_META[active].label} post mentions {namedElsewhere}. Check that is what
              you mean to say here.
            </p>
          ) : null}
          {liveOn ? (
            <p
              className="mx-4 mb-3 rounded-lg border border-border bg-foreground/[0.02] px-3 py-2 text-xs text-muted-foreground"
              data-testid="live-notice"
              role="status"
            >
              {locked
                ? `This post is live on ${liveOn}. Changes here would not reach it, so its text is locked. To send a changed version, post it again as new.`
                : `Already live on ${liveOn}. Changes here only reach the platforms not sent yet.`}
            </p>
          ) : null}
          <TargetBanner draft={server} />
          {canEditText && server.kind === 'article' ? (
            <ArticleTools
              article={document.article}
              onChange={(article) => update(() => ({ article }))}
              editor={editor}
              upload={services.uploadFile}
            />
          ) : null}
          {/* A paste can become a thread: its tools show here until it is split or dismissed. */}
          {pasteNotice && threadTools && !optionsShown ? (
            <div className="relative mx-4 mb-3 rounded-xl border border-border bg-card">
              {threadTools(true)}
              <Button
                aria-label="Dismiss the paste notice"
                className="absolute top-2 right-2"
                onClick={() => setPasteNotice(false)}
                size="sm"
                variant="ghost"
              >
                <XIcon aria-hidden className="size-4" />
              </Button>
            </div>
          ) : null}
            </>
          )}
          {/* The width of the phone and feed previews it draws; wider would only stretch them. */}
          {previewing ? (
            <div className="mx-auto w-full max-w-[419px] flex-1">{previewPanel}</div>
          ) : null}
          {/* Hidden, not removed: unmounting would drop the live room, undo history and caret. */}
          <div
            className={cn('relative flex-1', previewing && 'hidden')}
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
                    draftId={initial.id}
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
                  onResync={canEdit ? () => setResync(active) : undefined}
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
                      draftId={initial.id}
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
                header={postHeader()}
                limit={activePublication.serialized.limit}
                onSplit={
                  canEditText && CAPABILITIES[active].thread
                    ? () => {
                        try {
                          const forked = forkVersion(
                            document.versions,
                            active,
                            document.value as PlateBody,
                            version.current,
                            true
                          )
                          const own = versionFor(forked, active)
                          const body = splitThread(
                            own.body ?? [],
                            active,
                            activePublication.serialized.limit,
                            own.options?.numbering
                          )
                          update({ versions: withVersion(forked, { ...own, body }) })
                        } catch (error) {
                          toast.error(
                            error instanceof Error ? error.message : 'The text could not be split.'
                          )
                        }
                      }
                    : undefined
                }
                onFork={
                  canEditText
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
          {server.kind === 'article' ? null : (
            <MediaStrip
              canEdit={canEditText}
              channel={active}
              editor={ownEditor ? editorInstance : null}
              onBrowse={() => setTool('library')}
              onEditMain={() => setTab(primary)}
              onManage={() => setTool('media')}
              value={active !== primary && ownEditor ? ((versionOfTab.body ?? []) as Value) : document.value}
            />
          )}
          {canEditText && server.kind !== 'article' ? (
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
            <div
              className={cn('mb-6 flex flex-wrap justify-end gap-3', POST_COLUMN)}
              data-testid="platform-counters"
            >
              {/* One limit per tab: the edited platform's, when its posts show none in their headers. */}
              {items
                .filter(
                  (item) =>
                    item.account.channel === active &&
                    ((active !== primary && versionOfTab.mode !== 'manual') ||
                      item.publication.serialized.posts.length === 0)
                )
                .map((item) => {
                  return (
                    <span
                      className={cn(
                        'flex items-center gap-1 text-xs',
                        over.includes(item.account.channel)
                          ? 'text-red-700 dark:text-red-400'
                          : 'text-muted-foreground'
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
              fixFor={(platform) => {
                const channel = channelForPlatform(platform)
                const found = blockers.filter((blocker) => blocker.channel === channel)
                if (!channel || found.length === 0) return null
                return {
                  // A retry waits while the platform's account or required options are unfinished.
                  blocksRetry: found.some((blocker) => blocker.fix === 'account' || blocker.options),
                  label: blockerFixLabel(found[0]),
                  open: () => jumpTo(found[0]),
                  problems: found.map((blocker) =>
                    blocker.text.replace(`${CHANNEL_META[channel].label}: `, '')
                  ),
                }
              }}
              notAttempted={items
                .filter((item) => !posts.some((post) => post.channelConnectionId === item.account.id))
                .map(({ account: destination }) => ({
                  channel: destination.channel,
                  id: destination.id,
                  label: CHANNEL_META[destination.channel].label,
                }))}
              zone={set?.timeZone}
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
              onEdit={(platform) => {
                const channel = channelForPlatform(platform)
                if (channel && channels.includes(channel)) setTab(channel)
                focusRoot.current?.closest('main')?.scrollTo({ top: 0 })
              }}
              posts={posts}
            />
              </>
            )}
            <div className="h-32" />
          </div>
        </div>
        {sidePanel && !focus && !narrow && !settingsOpen(params) ? (
          <aside
            aria-label={PANEL_TITLES[sidePanel]}
            // Sticky at the frame's height, so the panel stays in view as the draft scrolls.
            className="sticky top-0 max-h-[calc(100vh-1rem-2px)] min-w-64 max-w-[48vw] self-start overflow-y-auto border-l border-border animate-in fade-in duration-150"
            ref={fitToScroller}
            data-composer-panel
            style={{ width: panelWidth }}
          >
            <div
              role="separator"
              aria-label="Resize sidebar"
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
            <PanelHeader onClose={() => setPanel(null)} title={PANEL_TITLES[sidePanel]} />
            {panelContent}
          </aside>
        ) : null}
        {sidePanel && !focus && narrow && !settingsOpen(params) ? (
          <>
            <Sheet onOpenChange={(open) => !open && setPanel(null)} open>
              <SheetContent className="w-full overflow-y-auto p-0 sm:max-w-md" side="right">
                <SheetHeader>
                  <SheetTitle>{PANEL_TITLES[sidePanel]}</SheetTitle>
                  <SheetDescription className="sr-only">
                    {PANEL_TITLES[sidePanel]} for this draft
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
        <AlertDialog onOpenChange={setPostAgain} open={postAgain}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Post this again as a new draft?</AlertDialogTitle>
              <AlertDialogDescription>
                This post is already live, so it stays as it is. The copy starts with no schedule:
                nothing goes out until you schedule it. Platforms can treat the same text posted
                twice as spam, so change it if you can.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep this one</AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  void (async () => {
                    await flush()
                    const copy = await writeApi.duplicate(initial.id)
                    router.push(`/publish/${copy.draft.id}`)
                  })().catch((error: unknown) =>
                    toast.error(
                      error instanceof Error ? error.message : 'The copy could not be made.'
                    )
                  )
                }
              >
                Make a new draft
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
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
        <ResyncDialog
          channel={resync}
          onClose={() => setResync(null)}
          onResynced={(versions) => update({ versions })}
          primary={primary}
          versions={document.versions}
        />
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
        {dialog === 'media' && editorInstance ? (
          <MediaImportDialog
            editor={editorInstance}
            returnedAsset={params.get('attach') ?? ''}
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

/**
 * The checklist of what blocks publishing, beside Schedule: the publishing
 * buttons open it instead of their dialogs, and each item goes where it is fixed.
 */
function Blockers({
  action,
  blockers,
  onJump,
  onOpenChange,
  onProceed,
  onRemove,
  open,
}: {
  /** The publishing button that opened this, if one did. */
  action: PublishAction | null
  blockers: ScheduleBlocker[]
  onJump: (blocker: ScheduleBlocker) => void
  onOpenChange: (open: boolean) => void
  onProceed: (action: PublishAction) => void
  /** Stop publishing to a platform; missing when it is the only one. */
  onRemove?: (channel: DraftChannel) => void
  open: boolean
}) {
  return (
    <Popover onOpenChange={onOpenChange} open={open}>
      <PopoverTrigger asChild>
        <Button
          className="text-amber-700 dark:text-amber-300"
          data-testid="blockers-button"
          size="sm"
          variant="ghost"
        >
          <span aria-hidden className="size-1.5 rounded-full bg-amber-500" />
          {blockers.length} to fix
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 p-2"
        data-testid="blockers"
        // A menu or the palette hands focus back as it closes; only a click dismisses this.
        onFocusOutside={(event) => event.preventDefault()}
      >
        <p className="px-2 py-1 text-xs text-muted-foreground">
          Fix {blockers.length === 1 ? 'this' : 'these'} before you{' '}
          {action === 'publish' ? 'publish' : 'schedule'}:
        </p>
        <ul className="grid gap-0.5">
          {blockers.map((blocker, index) => (
            <li key={blocker.text}>
              <Button
                className="h-auto w-full items-start justify-between gap-2 px-2 py-1.5 text-left text-xs font-normal whitespace-normal"
                onClick={() => {
                  onOpenChange(false)
                  onJump(blocker)
                }}
                size={null}
                variant="ghost"
              >
                <span className="min-w-0">
                  {blocker.text}
                  {blockerFixLabel(blocker) ? (
                    <span className="mt-0.5 block font-medium text-foreground">
                      {blockerFixLabel(blocker)}
                    </span>
                  ) : null}
                </span>
                <CaretRightIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              </Button>
              {/* Once per platform, under the first thing it needs. */}
              {onRemove &&
              blocker.channel &&
              blockers.findIndex((item) => item.channel === blocker.channel) === index ? (
                <Button
                  className="mx-2 mb-1 h-6 px-1.5 text-xs font-normal text-muted-foreground"
                  onClick={() => onRemove(blocker.channel!)}
                  size={null}
                  variant="ghost"
                >
                  Remove {CHANNEL_META[blocker.channel].label} from this post
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {action ? (
          <Button
            className="mt-1 w-full justify-start px-2 text-xs font-normal text-muted-foreground"
            onClick={() => {
              onOpenChange(false)
              onProceed(action)
            }}
            size="sm"
            variant="ghost"
          >
            {action === 'schedule' ? 'Save as planned instead…' : 'See the review anyway'}
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

/** Panel titles. */
const PANEL_TITLES: Record<Panel, string> = {
  assistant: 'Writing assistant',
  comments: 'Comments',
  options: 'Post options',
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
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          aria-pressed={active}
          className={cn('size-8 px-0', active && 'bg-foreground/[0.08] text-foreground', className)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onClick}
          size="sm"
          variant="ghost"
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{shortcut ? `${label} (${shortcut})` : label}</TooltipContent>
    </Tooltip>
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
