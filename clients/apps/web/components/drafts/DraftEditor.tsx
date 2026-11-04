'use client'

import * as React from 'react'
import dynamic from 'next/dynamic'
const LibraryAssetPicker = dynamic(
  () =>
    import('@/components/platform-hub/LibraryAssetPicker').then(
      (module) => module.LibraryAssetPicker
    ),
  { ssr: false }
)
import { toast } from 'sonner'
import './draft-prose.css'
import {
  BaseEditorKit,
  createEditorKit,
  insertBlock,
  insertInlineElement,
} from '@shots/platejs-editor/components'
import { PlaceholderPlugin, type FileSize } from '@shots/platejs-editor/@platejs/media/react'
import {
  EditorServicesProvider,
  type EditorServices,
  rehostDataImages,
} from '@shots/platejs-editor/lib'
import { createSlateEditor, KEYS, type Value } from '@shots/platejs-editor/platejs'
import {
  Plate,
  type PlateEditor,
  useEditorRef,
  useEditorMounted,
  usePlateEditor,
  usePluginOption,
} from '@shots/platejs-editor/platejs/react'
import {
  createYjsPlugin,
  HocuspocusProviderWrapper,
  loadLocalCopy,
  throttleCursor,
  YjsPlugin,
} from '@shots/platejs-editor/collaboration'
import {
  BlockPlaceholderKit,
  BlockSelectionKit,
  MediaKit,
  commentPlugin,
  discussionPlugin,
  type TDiscussion,
} from '@shots/platejs-editor/plugins'
import {
  Editor,
  EditorContainer,
  EditorStatic,
  MarkToolbarButton,
  Toolbar,
  ToolbarButton,
  ToolbarGroup,
} from '@shots/platejs-editor/ui'
import { DotsThreeIcon as MoreHorizontalIcon } from '@phosphor-icons/react/dist/ssr/DotsThree'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { DraftDiscussions } from '@/lib/content-drafts/discussions'
import { draftPlainText } from '@/lib/content-drafts/serialize'
import { divLinesAsParagraphs } from '@/lib/content-drafts/paste'
import { cn } from '@/lib/utils'
import { POST_COLUMN } from './layout'
import {
  insertPostAfter,
  leaveHeader,
  postRanges,
  PostBreakPlugin,
  PostHeaderContext,
  type PostTools,
  PostToolsContext,
  splitPostAtCaret,
  ThreadLine,
  threadAsRules,
} from './thread'
import { normalizePosts, postBreak } from '@/lib/write/versions'
import { MEDIA_LIMITS } from '@/lib/write/media-limits'
import type { PlateBody } from '@/lib/write/document'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { pendingDraftConnectionError, takePendingDraft } from '@/components/write/pending-draft'
import type { z } from 'zod'
import type { textDirectionSchema } from '@/lib/api/contracts/settings-platform'

// Keep the kit's upload renderer while adding host-specific limits and drop routing.
const UploadPlaceholderPlugin = MediaKit.find(
  (plugin) => plugin.key === PlaceholderPlugin.key
)! as typeof PlaceholderPlugin

/**
 * The document editor for a content draft: the vendored Plate.js editor with
 * the full kit, wired to the platform's uploads and AI. Loaded with
 * next/dynamic on the composer route only, because the kit is heavy.
 */

export type DraftEditorUser = { id: string; name: string }

/** A live session: the collab server's URL and the draft it edits. */
export type DraftCollaboration = {
  draftId: string
  url: string
  generation?: number
  /** A token the page issued with its own render, used for the first connection. */
  issued?: { documentName: string; expiresAt: Date; token: string }
}

function collaborationRoom(session: DraftCollaboration): string {
  return `content-draft:${session.draftId}${session.generation ? `:${session.generation}` : ''}`
}

/** Hashtags the workspace uses, one click from the post. */
function HashtagChips({ hashtags }: { hashtags: string[] }) {
  const editor = useEditorRef()
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5 pb-6', POST_COLUMN)}>
      <span className="text-[11px] text-muted-foreground">Your hashtags</span>
      {hashtags.map((tag) => (
        <Button
          variant="custom"
          size={null}
          className="rounded-full border border-foreground/[0.08] px-2 py-0.5 text-xs text-foreground/65 hover:border-sky-400/40 hover:text-foreground"
          key={tag}
          onClick={() => {
            // At the caret, or at the end of the draft when there is none.
            if (!editor.selection) editor.tf.select(editor.api.end([]))
            editor.tf.insertText(` #${tag}`)
            editor.tf.focus()
          }}
          onMouseDown={(event) => event.preventDefault()}
          type="button"
        >
          #{tag}
        </Button>
      ))}
    </div>
  )
}

export type DraftEditorProps = {
  /** The direction text runs in, from Appearance settings. */
  textDirection?: z.infer<typeof textDirectionSchema>
  collaboration: DraftCollaboration | null
  draftId?: string
  /** The editor, once made: the host restores revisions through it. */
  onEditor?: (editor: PlateEditor) => void
  /** @handles the workspace already writes, offered in the @ picker. */
  handles: string[]
  /** Hashtags the workspace already writes, offered as chips. */
  hashtags: string[]
  /** Each post's header, by its 1-based number in the thread: who it is from. */
  postHeader: (number: number) => React.ReactNode
  /** Per-post settings tools for the platform being edited. */
  postSettings?: PostTools['settings']
  /** Open Rewrite for one post, beside its sparkle. */
  onRefinePost?: PostTools['refine']
  /** Extra buttons for the bottom toolbar: numbering, finishers, platform tools. */
  toolbarExtras?: React.ReactNode
  /** Menu items the host adds to the toolbar's Media menu. */
  toolbarMediaItems?: React.ReactNode
  /** Menu items the host adds to the toolbar's More menu. */
  toolbarMoreItems?: React.ReactNode
  /** Plugins the host adds, such as social mentions. */
  extraPlugins?: unknown[]
  /** Collaboration is off for a platform's own version: it saves with the draft. */
  documentName?: string
  /** Comment threads stored with the draft. */
  initialDiscussions: DraftDiscussions
  initialValue: Value
  onChange: (value: Value) => void
  /** Called when someone adds, edits, resolves or deletes a comment. */
  onDiscussionsChange: (discussions: DraftDiscussions) => void
  readOnly: boolean
  services: EditorServices
  title: string
  user: DraftEditorUser
}

/** A new body: one post, empty. */
function emptyValue(): Value {
  return [postBreak(), { children: [{ text: '' }], type: 'p' }] as Value
}

function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

/** The package reads its mention list from a global (ComposerEditor sets it the same way). */
function setMentionUsers(users: DraftEditorUser[]): void {
  ;(
    globalThis as { __canvasComposerMentionUsers?: DraftEditorUser[] }
  ).__canvasComposerMentionUsers = users
}

/** A stable, readable colour per member for their cursor and presence chip. */
function colorFor(userId: string): string {
  let hash = 0
  for (const character of userId) hash = (hash * 31 + character.charCodeAt(0)) % 360
  return `hsl(${hash} 70% 45%)`
}

async function collabToken(draftId: string, documentName: string): Promise<string> {
  const response = await fetch(
    `/api/v1/content-drafts/${encodeURIComponent(draftId)}/collab-token`,
    {
      method: 'POST',
    }
  )
  if (!response.ok) throw new Error(`Collaboration token refused (${response.status}).`)
  const issued = (await response.json()) as { token: string; documentName: string }
  if (issued.documentName !== documentName)
    throw new Error('The draft was replaced. Reload it to continue editing.')
  return issued.token
}

/**
 * The editor's frame. While comments are open it keeps a column on the right
 * for them, so a thread sits beside the post rather than over the text.
 */
function CommentColumn({ children }: { children: React.ReactNode }) {
  const activeId = usePluginOption(commentPlugin, 'activeId')
  const discussions = usePluginOption(discussionPlugin, 'discussions')
  const open = Boolean(activeId) || discussions.some((discussion) => !discussion.isResolved)
  const wrapper = React.useRef<HTMLDivElement>(null)
  const editor = useEditorRef()
  const [wide, setWide] = React.useState(false)
  React.useEffect(() => {
    if (!wrapper.current) return
    const observer = new ResizeObserver(([entry]) => setWide(entry.contentRect.width >= 900))
    observer.observe(wrapper.current)
    return () => observer.disconnect()
  }, [])
  return (
    <div
      ref={wrapper}
      // A new draft's caret starts on the post's void header, which drops a paste
      // (Slate ignores non-editable targets). Put the paste in the post's text.
      // A plugin in Plate's key pipeline claims the redo shortcut without redoing, so
      // Slate never reaches its own redo. The history (Yjs's undo manager) is intact.
      onKeyDownCapture={(event) => {
        const key = event.key.toLowerCase()
        const redo =
          ((event.metaKey || event.ctrlKey) && event.shiftKey && key === 'z') ||
          (event.ctrlKey && !event.shiftKey && !event.metaKey && key === 'y')
        if (!redo || event.altKey) return
        event.preventDefault()
        event.stopPropagation()
        editor.redo()
      }}
      onPasteCapture={(event) => {
        const clipboard = event.clipboardData
        const html = clipboard.files.length ? '' : clipboard.getData('text/html')
        const lines = html ? divLinesAsParagraphs(html) : null
        // A paste over a selection replaces it through Plate's own handling.
        const header = editor.api.isCollapsed() && leaveHeader(editor)
        if (!lines && !header) return
        // Handled here, so Slate's own paste handler below does not insert it again.
        event.preventDefault()
        event.stopPropagation()
        if (!lines) return editor.tf.insertData(clipboard)
        const data = new DataTransfer()
        for (const type of clipboard.types)
          if (type !== 'Files')
            data.setData(type, type === 'text/html' ? lines : clipboard.getData(type))
        editor.tf.insertData(data)
      }}
    >
      <EditorContainer
        className={cn('h-auto min-h-[160px]', open && wide && 'pr-80')}
        data-testid="draft-editor"
        data-local-dropzone
      >
        {children}
      </EditorContainer>
    </div>
  )
}

/** Every user the plugin shows needs an avatar URL; stored users carry none. */
function withAvatars(users: DraftDiscussions['users']) {
  return Object.fromEntries(
    Object.entries(users).map(([id, person]) => [id, { avatarUrl: '', id, name: person.name }])
  )
}

/** Reports comment changes, so the composer saves them with the draft. */
function DiscussionsWatcher({ onChange }: { onChange: (discussions: DraftDiscussions) => void }) {
  const threads = usePluginOption(discussionPlugin, 'discussions')
  const users = usePluginOption(discussionPlugin, 'users')
  const first = React.useRef(threads)
  // Only a change to the threads or people is news: the host's callback is
  // often a new function each render, and reacting to that saved forever.
  const report = React.useEffectEvent(() =>
    onChange({
      threads: threads as DraftDiscussions['threads'],
      users: Object.fromEntries(
        Object.entries(users).map(([id, person]) => [id, { id, name: person.name }])
      ),
    })
  )
  React.useEffect(() => {
    if (threads === first.current) return
    report()
  }, [threads, users])
  return null
}

/** Who else is in the draft right now, from the session's awareness. */
function Presence() {
  const editor = useEditorRef()
  const awareness = editor.getOptions(YjsPlugin).awareness
  const [people, setPeople] = React.useState<{ color: string; key: string; name: string }[]>([])
  React.useEffect(() => {
    // One chip per person: each tab or reconnect is its own awareness client.
    const update = () => {
      const byPerson = new Map<string, { color: string; key: string; name: string }>()
      for (const state of awareness.getStates().values()) {
        const data = (state as { data?: { color?: string; name?: string; userId?: string } }).data
        const key = data?.userId ?? data?.name
        if (data?.name && key && !byPerson.has(key))
          byPerson.set(key, { color: data.color ?? 'gray', key, name: data.name })
      }
      setPeople([...byPerson.values()])
    }
    update()
    awareness.on('change', update)
    return () => awareness.off('change', update)
  }, [awareness])
  return (
    // Who else is here sits above the post, at the column's right edge.
    <div className="flex flex-wrap justify-end gap-1.5 px-6 py-2" data-testid="presence">
      {people.map((person) => (
        <span
          className="flex max-w-48 items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-1 text-label text-foreground"
          key={person.key}
          style={{ background: `color-mix(in srgb, ${person.color} 14%, transparent)` }}
        >
          <span
            aria-hidden="true"
            className="size-1.5 shrink-0 rounded-full"
            style={{ background: person.color }}
          />
          <span className="truncate">{person.name}</span>
        </span>
      ))}
    </div>
  )
}

function fileSlug(title: string): string {
  return (
    title
      .trim()
      .replace(/[^\w-]+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'draft'
  )
}

/**
 * The rarer tools behind one button, out of the writing toolbar's way:
 * inserts, the host's tools, then import and export.
 */
function MoreMenu({
  children,
  exports,
  files,
}: {
  children: React.ReactNode
  exports: { label: string; run: () => void | Promise<void> }[]
  files: { accept: string; label: string; onFile: (file: File) => void }[]
}) {
  const inputs = React.useRef<Record<string, HTMLInputElement | null>>({})
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <ToolbarButton aria-label="More tools" tooltip="More tools">
            <MoreHorizontalIcon aria-hidden className="size-4" />
          </ToolbarButton>
        </DropdownMenuTrigger>
        {/* Focus stays where the chosen tool puts it: the editor after an insert, a picker it opens. */}
        <DropdownMenuContent
          align="end"
          side="top"
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          {children}
          <DropdownMenuSeparator />
          {files.map((file) => (
            <DropdownMenuItem key={file.label} onSelect={() => inputs.current[file.label]?.click()}>
              {file.label}
            </DropdownMenuItem>
          ))}
          {exports.map((item) => (
            <DropdownMenuItem key={item.label} onSelect={() => void item.run()}>
              {item.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {files.map((file) => (
        <Input
          accept={file.accept}
          aria-label={file.label}
          className="hidden"
          key={file.label}
          onChange={(event) => {
            const picked = event.target.files?.[0]
            event.target.value = ''
            if (picked) file.onFile(picked)
          }}
          ref={(element) => {
            inputs.current[file.label] = element
          }}
          type="file"
        />
      ))}
    </>
  )
}

function DraftToolbar({
  editor,
  imageInput,
  mediaItems,
  moreItems,
  services,
  title,
  extras,
}: {
  editor: PlateEditor
  imageInput: React.RefObject<HTMLInputElement | null>
  mediaItems?: React.ReactNode
  moreItems?: React.ReactNode
  services: EditorServices
  title: string
  extras?: React.ReactNode
}) {
  const importDocument = async (file: File) => {
    try {
      // DOCX support (mammoth, the Word writer) loads on first use.
      const { importDocx } = await import('@shots/platejs-editor/@platejs/docx-io')
      const { nodes } = await importDocx(editor, await file.arrayBuffer())
      if (!services.uploadFile) throw new Error('Uploads are not available.')
      // Imported images arrive inline; store them as workspace assets.
      const stored = await rehostDataImages(nodes as Value, services.uploadFile)
      editor.tf.insertNodes(stored, { at: [editor.children.length] })
      toast.success(`Imported ${file.name}.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The document could not be imported.')
    }
  }
  const importMarkdown = async (file: File) => {
    const nodes = editor.getApi({ key: KEYS.markdown }).markdown.deserialize(await file.text())
    editor.tf.insertNodes(nodes, { at: [editor.children.length] })
  }
  const [libraryOpen, setLibraryOpen] = React.useState(false)
  const exportDocument = async () => {
    const { exportToDocx } = await import('@shots/platejs-editor/@platejs/docx-io')
    const blob = await exportToDocx(threadAsRules(editor.children), {
      editorPlugins: BaseEditorKit,
      editorStaticComponent: EditorStatic,
      title,
    })
    download(blob, `${fileSlug(title)}.docx`)
  }
  const exportMarkdown = () => {
    const markdown = editor
      .getApi({ key: KEYS.markdown })
      .markdown.serialize({ value: threadAsRules(editor.children) })
    download(new Blob([markdown], { type: 'text/markdown' }), `${fileSlug(title)}.md`)
  }

  return (
    // One row: formatting, media, the host's writing tools, and the rest behind More.
    <Toolbar
      aria-label="Draft formatting"
      className="flex max-w-full items-center justify-start gap-0.5 rounded-md border border-border bg-card/95 p-px backdrop-blur [&_button]:!h-7 [&_button]:!px-2 [&_button]:!text-[13px] [&_button]:!font-medium"
    >
      <ToolbarGroup>
        <MarkToolbarButton aria-label="Bold" nodeType={KEYS.bold} tooltip="Bold">
          <span className="font-bold">B</span>
        </MarkToolbarButton>
        <MarkToolbarButton aria-label="Italic" nodeType={KEYS.italic} tooltip="Italic">
          <span className="italic">I</span>
        </MarkToolbarButton>
      </ToolbarGroup>
      <ToolbarGroup>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <ToolbarButton aria-label="Media" tooltip="Add media">
              Media ▾
            </ToolbarButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            <DropdownMenuItem onSelect={() => imageInput.current?.click()}>
              Upload a file
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setLibraryOpen(true)}>
              Attach from Library
            </DropdownMenuItem>
            {mediaItems}
          </DropdownMenuContent>
        </DropdownMenu>
        <Input
          accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/quicktime,video/webm"
          aria-label="Insert media"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (!file) return
            // The media plugin takes a FileList, as from a drop or a picker.
            if (!editor.selection) editor.tf.select(editor.api.end([]))
            const files = new DataTransfer()
            files.items.add(file)
            editor.getTransforms(PlaceholderPlugin).insert.media(files.files)
          }}
          ref={imageInput}
          type="file"
        />
      </ToolbarGroup>
      {libraryOpen ? (
        <LibraryAssetPicker
          onClose={() => {
            setLibraryOpen(false)
            editor.tf.focus()
          }}
          onInsert={(node) => {
            if (!editor.selection) editor.tf.select(editor.api.end([]))
            editor.tf.insertNodes(node)
            editor.tf.focus()
          }}
        />
      ) : null}
      {extras ? <ToolbarGroup className="min-w-0 shrink">{extras}</ToolbarGroup> : null}
      <ToolbarGroup>
        <MoreMenu
          files={[
            {
              accept:
                '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              label: 'Import DOCX',
              onFile: importDocument,
            },
            { accept: '.md,text/markdown', label: 'Import Markdown', onFile: importMarkdown },
          ]}
          exports={[
            { label: 'Export DOCX', run: exportDocument },
            { label: 'Export Markdown', run: exportMarkdown },
          ]}
        >
          {[
            { label: 'Table', insert: () => insertBlock(editor, KEYS.table) },
            { label: 'Math', insert: () => insertBlock(editor, KEYS.equation) },
            {
              label: 'Footnote',
              insert: () => insertInlineElement(editor, KEYS.footnoteReference),
            },
            { label: 'Split post at caret', insert: () => splitPostAtCaret(editor) },
          ].map((item) => (
            <DropdownMenuItem
              key={item.label}
              onSelect={() => {
                item.insert()
                editor.tf.focus()
              }}
            >
              {item.label}
            </DropdownMenuItem>
          ))}
          <p className="max-w-64 px-2 py-1 text-xs text-muted-foreground">
            Tables and math publish as images. Footnotes publish as text.
          </p>
          {moreItems ? (
            <>
              <DropdownMenuSeparator />
              {moreItems}
            </>
          ) : null}
        </MoreMenu>
      </ToolbarGroup>
    </Toolbar>
  )
}

function SavedDraft({
  value,
  textDirection,
}: Pick<DraftEditorProps, 'textDirection'> & { value: Value }) {
  const editor = React.useMemo(
    () =>
      createSlateEditor({ plugins: BaseEditorKit, value: structuredClone(threadAsRules(value)) }),
    [value]
  )
  return (
    <section aria-label="Saved draft">
      <EditorStatic
        editor={editor}
        className={cn(POST_COLUMN, 'draft-prose min-h-0 pt-1 pb-4 text-[15px] leading-relaxed')}
        dir={textDirection}
      />
    </section>
  )
}

export default function DraftEditor(props: DraftEditorProps) {
  const [attempt, setAttempt] = React.useState(0)
  const retry = React.useCallback(() => setAttempt((value) => value + 1), [])
  const initialSession = React.useRef({
    issued: props.collaboration?.issued,
    readOnly: props.readOnly,
  })
  const takeIssued = React.useCallback(() => {
    const issued = initialSession.current.issued
    initialSession.current.issued = undefined
    return initialSession.current.readOnly === props.readOnly ? issued : undefined
  }, [props.readOnly])
  return (
    <DraftEditorSession
      key={`${attempt}-${props.readOnly}`}
      {...props}
      onRetry={retry}
      takeIssued={takeIssued}
    />
  )
}

function DraftEditorSession({
  collaboration,
  draftId,
  textDirection = 'ltr',
  onEditor,
  handles,
  hashtags,
  postHeader,
  postSettings,
  onRefinePost,
  toolbarExtras,
  toolbarMediaItems,
  toolbarMoreItems,
  extraPlugins,
  documentName,
  initialDiscussions: storedDiscussions,
  initialValue,
  onChange,
  onDiscussionsChange,
  onRetry,
  takeIssued,
  readOnly,
  services,
  title,
  user,
}: DraftEditorProps & { onRetry: () => void; takeIssued: () => DraftCollaboration['issued'] }) {
  // Read once: later saves must not re-seed the plugin and reset its state.
  const [initialDiscussions] = React.useState(storedDiscussions)
  const plugins = React.useMemo(() => {
    const live = collaboration
      ? createYjsPlugin(
          {
            access: readOnly ? 'read' : 'write',
            documentName: documentName ?? collaborationRoom(collaboration),
            getToken: () => {
              const room = documentName ?? collaborationRoom(collaboration)
              const first = takeIssued()
              // Only the first session can use the page token and its original access.
              return first &&
                first.documentName === room &&
                first.expiresAt.getTime() - Date.now() > 15_000
                ? Promise.resolve(first.token)
                : collabToken(collaboration.draftId, room)
            },
            hocuspocusUrl: collaboration.url,
            // WebRTC stays off: it would need our own signaling and TURN servers.
            webrtc: null,
          },
          { color: colorFor(user.id), name: user.name, userId: user.id }
        )
      : null
    const hosted = (extraPlugins ?? []) as (typeof PostBreakPlugin)[]
    return createEditorKit({
      recipe: 'collaborative',
      // Only an explicitly supplied host lookup may replace literal social handles.
      excludePluginKeys: ['mention', 'mention_input', 'autoformatShortcuts'].filter(
        (key) => !hosted.some((plugin) => plugin.key === key)
      ),
      additionalPlugins: live ? [PostBreakPlugin, ...hosted, live] : [PostBreakPlugin, ...hosted],
      // Comments and suggestions are authored by the signed-in member, not
      // the upstream demo users.
      overridePlugins: [
        ...hosted,
        // Extend the configured kit: configure() replaces its deferred renderer.
        UploadPlaceholderPlugin.extend(() => ({
          options: {
            maxFileCount: 20,
            uploadConfig: {
              // Plate's type lists powers of two, but its runtime accepts exact
              // byte strings. The upload service enforces the current plan again.
              image: {
                mediaType: KEYS.img,
                maxFileCount: 20,
                maxFileSize: `${MEDIA_LIMITS.paidImageBytes}B` as FileSize,
              },
              video: {
                mediaType: KEYS.video,
                maxFileCount: 20,
                maxFileSize: `${MEDIA_LIMITS.videoBytes}B` as FileSize,
              },
              pdf: {
                mediaType: KEYS.file,
                maxFileCount: 1,
                maxFileSize: `${MEDIA_LIMITS.pdfBytes}B` as FileSize,
              },
            },
          },
          handlers: {
            onDrop: ({ editor, event, tf }) => {
              const { files } = event.dataTransfer
              if (!files.length) return false
              event.preventDefault()
              event.stopPropagation()
              if (readOnly) return true
              // Use the dropped position and the existing upload/placeholder
              // pipeline. The global screenshot dropzone must not navigate away.
              const at = editor.api.findEventRange(event)
              if (at) editor.tf.select(at)
              tf.insert.media(files)
              return true
            },
          },
        })),
        BlockSelectionKit[0].configure({ options: { disableSelectAll: true } }),
        BlockPlaceholderKit[0].configure({
          options: { placeholders: { [KEYS.p]: 'What would you like to share?' } },
        }),
        // Comments sit in a column beside the post once the text reaches its
        // full measure (POST_COLUMN's 42rem); a narrower editor opens them as a
        // popover over the text instead.
        commentPlugin.configure({ options: { overlapWidth: 672 } }),
        discussionPlugin.configure({
          options: {
            currentUserId: user.id,
            discussions: initialDiscussions.threads as TDiscussion[],
            users: {
              ...withAvatars(initialDiscussions.users),
              [user.id]: { avatarUrl: '', id: user.id, name: user.name },
            },
          },
        }),
      ],
    })
  }, [
    collaboration,
    documentName,
    extraPlugins,
    initialDiscussions,
    readOnly,
    takeIssued,
    user.id,
    user.name,
  ])
  // Mentions offer the signed-in member and the handles the workspace already
  // writes, instead of the upstream demo list.
  const handleList = handles.join(' ')
  React.useEffect(() => {
    setMentionUsers([
      { id: user.id, name: user.name },
      ...handleList
        .split(' ')
        .filter(Boolean)
        .map((handle) => ({ id: `handle:${handle}`, name: handle })),
    ])
  }, [handleList, user.id, user.name])
  const editor = usePlateEditor({
    plugins,
    readOnly,
    // A live session takes its value from the shared document instead.
    skipInitialization: Boolean(collaboration),
    value: collaboration
      ? undefined
      : initialValue.length > 0
        ? (normalizePosts(initialValue as PlateBody) as Value)
        : emptyValue(),
  })
  const [live, setLive] = React.useState(false)
  const [connectionFailed, setConnectionFailed] = React.useState(false)
  const waitingForConnection = Boolean(collaboration) && !live
  const disposal = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const reportEditor = React.useEffectEvent(() => onEditor?.(editor))
  React.useEffect(() => {
    // External tools read editor.children immediately. Report the collaborative
    // editor only after its initial snapshot is ready, never the empty shell.
    if (collaboration && !live) return
    reportEditor()
  }, [collaboration, editor, live])
  const firstValue = React.useRef(initialValue)
  const [initiallyEmpty] = React.useState(() => draftPlainText(initialValue).length === 0)
  React.useEffect(() => {
    if (!collaboration && !readOnly && draftPlainText(firstValue.current).length === 0) {
      editor.tf.select(editor.api.end([])!)
    }
  }, [collaboration, editor, readOnly])
  // Plate renders the editable only once the editor has content; a live
  // session gets it asynchronously, so the editable remounts when it arrives.
  React.useEffect(() => {
    if (!collaboration) return
    if (disposal.current) clearTimeout(disposal.current)
    const yjs = editor.getApi(YjsPlugin).yjs
    const { awareness, ydoc } = editor.getOptions(YjsPlugin)
    let started = false
    let initialized = false
    let initializing = false
    let cancelled = false
    let connected = false
    let provider: HocuspocusProviderWrapper | null = null
    const failed = () => {
      if (cancelled || connected) return
      setConnectionFailed(true)
      if (draftId) pendingDraftConnectionError(draftId, onRetry)
    }
    const timeout = setTimeout(failed, 10_000)
    const ready = () => {
      if (
        !cancelled &&
        initialized &&
        editor
          .getOptions(YjsPlugin)
          ._providers.some((provider) => provider.type === 'hocuspocus' && provider.isSynced)
      ) {
        connected = true
        clearTimeout(timeout)
        setLive(true)
      }
    }
    editor.setOption(YjsPlugin, 'onError', failed)
    // Deferred a tick: React may mount, unmount and remount at once (Strict
    // Mode), and a session cannot connect twice. The discarded mount never starts.
    const room = documentName ?? collaborationRoom(collaboration)
    // Each cursor move is a message the collaboration server authorizes.
    const restoreCursor = throttleCursor(editor.getOptions(YjsPlugin).awareness)
    let local: ReturnType<typeof loadLocalCopy> | null = null
    const start = setTimeout(() => {
      started = true
      // A writer's browser copy loads first: Plate seeds only while no local
      // copy is loading, and a copy that finished after the server sync left a
      // newly opened draft (a recovered backup) empty.
      local = readOnly ? null : loadLocalCopy(room, editor.getOptions(YjsPlugin).ydoc)
      void (local?.ready ?? Promise.resolve())
        .then(() => {
          if (cancelled) return
          const { awareness, providers, ydoc } = editor.getOptions(YjsPlugin)
          const config = providers.find((candidate) => candidate.type === 'hocuspocus')
          if (!config || !('options' in config) || config.type !== 'hocuspocus')
            throw new Error('The draft collaboration provider is unavailable.')
          // Plate's init seeds after five seconds even without a sync. Connect first
          // so a cached snapshot can never be seeded over an existing server document.
          provider = new HocuspocusProviderWrapper({
            awareness,
            doc: ydoc,
            options: config.options,
            onConnect: () => editor.setOption(YjsPlugin, '_isConnected', true),
            onDisconnect: () => editor.setOption(YjsPlugin, '_isConnected', false),
            onError: failed,
            onSyncChange: (synced) => {
              editor.setOption(YjsPlugin, '_isSynced', synced)
              if (cancelled || !synced || !provider) return
              if (initializing) return ready()
              initializing = true
              editor.setOption(YjsPlugin, 'providers', [provider])
              void yjs
                .init({
                  autoConnect: false,
                  autoSelect: 'end',
                  id: room,
                  value:
                    firstValue.current.length > 0
                      ? (normalizePosts(firstValue.current as PlateBody) as Value)
                      : emptyValue(),
                })
                .then(() => {
                  initialized = true
                  ready()
                })
                .catch((error: unknown) => {
                  console.error('[drafts] live session failed', error)
                  failed()
                })
            },
          })
        })
        .catch((error: unknown) => {
          console.error('[drafts] live session failed', error)
          failed()
        })
    }, 0)
    return () => {
      cancelled = true
      clearTimeout(start)
      clearTimeout(timeout)
      // Plate's wrapper skips disconnected/connecting sockets during destruction.
      provider?.provider.destroy()
      if (started) yjs.destroy()
      local?.destroy()
      restoreCursor()
      // Strict Mode immediately reuses the editor; only a discarded session is disposed.
      disposal.current = setTimeout(() => {
        awareness.destroy()
        ydoc.destroy()
      }, 0)
    }
  }, [collaboration, documentName, draftId, editor, onRetry, readOnly])

  const [keyboardInset, setKeyboardInset] = React.useState(0)
  React.useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const resize = () =>
      setKeyboardInset(
        window.matchMedia('(max-width: 639px)').matches
          ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
          : 0
      )
    resize()
    viewport.addEventListener('resize', resize)
    viewport.addEventListener('scroll', resize)
    return () => {
      viewport.removeEventListener('resize', resize)
      viewport.removeEventListener('scroll', resize)
    }
  }, [])
  const imageInput = React.useRef<HTMLInputElement>(null)
  const postTools = React.useMemo<PostTools>(
    () =>
      readOnly || waitingForConnection
        ? {}
        : {
            addImage: () => imageInput.current?.click(),
            refine: onRefinePost,
            settings: postSettings,
          },
    [onRefinePost, postSettings, readOnly, waitingForConnection]
  )
  return (
    <EditorServicesProvider services={services}>
      <PostHeaderContext.Provider value={postHeader}>
        <PostToolsContext.Provider value={postTools}>
          <Plate
            editor={editor}
            onValueChange={({ value }) => {
              if (!collaboration || live) onChange(value)
            }}
            readOnly={readOnly || waitingForConnection}
          >
            {collaboration ? <Presence /> : null}
            <DiscussionsWatcher onChange={onDiscussionsChange} />
            {!collaboration || live ? (
              <CommentColumn>
                <ThreadLine />
                <Editor
                  autoFocus={false}
                  onDragOverCapture={(event) => {
                    if (!readOnly && event.dataTransfer.types.includes('Files')) {
                      event.preventDefault()
                      event.dataTransfer.dropEffect = 'copy'
                    }
                  }}
                  onDropCapture={(event) => {
                    if (readOnly || !event.dataTransfer.files.length) return
                    // Native files can land in empty space, outside a draggable block.
                    // Handle them once here; block-to-block dragging stays with Plate.
                    event.preventDefault()
                    event.stopPropagation()
                    const range = editor.api.findEventRange(event)
                    if (range) editor.tf.select(range)
                    editor.getTransforms(PlaceholderPlugin).insert.media(event.dataTransfer.files)
                  }}
                  aria-label="Draft body"
                  className={cn(
                    POST_COLUMN,
                    'draft-prose min-h-0 pt-1 pb-4 text-[15px] leading-relaxed [&_[placeholder]]:before:pointer-events-none [&_[placeholder]]:before:absolute [&_[placeholder]]:before:text-muted-foreground [&_[placeholder]]:before:content-[attr(placeholder)]'
                  )}
                  dir={textDirection}
                  placeholder="What would you like to share?"
                  variant="default"
                />
                <ReadyEditor draftId={draftId} focus={!readOnly && initiallyEmpty} />
              </CommentColumn>
            ) : (
              <>
                <div
                  className={cn(
                    'flex items-center gap-3 py-3 text-sm text-muted-foreground',
                    POST_COLUMN
                  )}
                >
                  <p role="status">
                    {connectionFailed
                      ? 'Could not connect. Showing the last saved version.'
                      : 'Connecting… Showing the last saved version.'}
                  </p>
                  {connectionFailed ? (
                    <Button variant="outline" size="sm" onClick={onRetry}>
                      Retry connection
                    </Button>
                  ) : null}
                </div>
                <SavedDraft value={firstValue.current} textDirection={textDirection} />
              </>
            )}
            {readOnly || waitingForConnection ? null : (
              <div className={cn('pb-6', POST_COLUMN)}>
                <Button
                  variant="outline"
                  size="sm"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => insertPostAfter(editor, postRanges(editor.children).length)}
                >
                  Add another post
                </Button>
              </div>
            )}
            {readOnly || waitingForConnection || hashtags.length === 0 ? null : (
              <HashtagChips hashtags={hashtags} />
            )}
            {readOnly || (collaboration && !live) ? null : (
              // Mount subscriptions after the shared document has loaded. Otherwise
              // media tools can retain the empty pre-connection value until an edit.
              // The formatting bar floats at the bottom of the page, out of the text's way.
              <div
                // Above the home indicator, so the controls above it stay reachable.
                // inline-size containment keeps that row's width from widening the editor
                // (which would switch comments to the wide side-column layout).
                style={{
                  bottom: `calc(${Math.max(20, keyboardInset)}px + env(safe-area-inset-bottom))`,
                }}
                className="pointer-events-none sticky z-10 flex justify-start px-2 [contain:inline-size] sm:ps-4"
              >
                <div className="pointer-events-auto min-w-0 max-w-full">
                  <DraftToolbar
                    editor={editor}
                    extras={toolbarExtras}
                    imageInput={imageInput}
                    mediaItems={toolbarMediaItems}
                    moreItems={toolbarMoreItems}
                    services={services}
                    title={title}
                  />
                </div>
              </div>
            )}
          </Plate>
        </PostToolsContext.Provider>
      </PostHeaderContext.Provider>
    </EditorServicesProvider>
  )
}

/** Focus once after Plate has mounted, never while a keystroke is being applied. */
function ReadyEditor({ draftId, focus }: { draftId?: string; focus: boolean }) {
  const editor = useEditorRef()
  const mounted = useEditorMounted()
  const done = React.useRef(false)
  React.useEffect(() => {
    if (!mounted || done.current) return
    done.current = true
    const pending = draftId ? takePendingDraft(draftId) : null
    if (
      pending !== null ||
      (focus && !document.activeElement?.matches('input,textarea,[contenteditable="true"]'))
    ) {
      editor.tf.select(editor.api.end([]))
      if (pending) editor.tf.insertText(pending)
      editor.tf.focus()
    }
  }, [draftId, editor, focus, mounted])
  return null
}
