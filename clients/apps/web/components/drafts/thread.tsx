'use client'

import { normalizeMentions } from '@/lib/write/normalize-mentions'
import {
  AddIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CopyIcon,
  DeleteIcon,
  DragIcon,
  MoreIcon as DotsThreeIcon,
} from '@/components/platform-shell/icons'
import { SparkleIcon } from '@phosphor-icons/react/dist/ssr/Sparkle'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useKeys } from '@/components/write/shortcuts'

import * as React from 'react'
import {
  createPlatePlugin,
  PlateElement,
  type PlateEditor,
  type PlateElementProps,
  useEditorRef,
  useEditorSelector,
  useEditorVersion,
  useReadOnly,
} from '@shots/platejs-editor/platejs/react'
import { KEYS, type Value } from '@shots/platejs-editor/platejs'
import { POST_BREAK } from '@/lib/content-drafts/serialize'
import type { PostSettings } from '@/lib/write/document'
import { newPostId, postBreak } from '@/lib/write/versions'
import { cn } from '@/lib/utils'
import { POST_COLUMN } from './layout'
import { Button } from '@/components/ui/button'

/**
 * Threads (RFC 013, RFC 025): a draft is one or more posts. Every post starts
 * at a post break block, the first one included, so each post has a stable
 * id and its own settings (who can reply, labels, a poll), kept on its break.
 * A break is drawn as its post's header; a line joins the avatars. Moving a
 * post moves its break, blocks, media and comment marks together.
 */

/** The header the host draws for post `number` (1-based) of the thread. */
export const PostHeaderContext = React.createContext<(number: number) => React.ReactNode>(
  () => null
)

/** The draft for a document export: each post break after the first becomes a horizontal rule. */
export function threadAsRules(value: Value): Value {
  return value.flatMap((node, index) =>
    node.type !== POST_BREAK
      ? [node]
      : index === 0
        ? []
        : [{ children: [{ text: '' }], type: KEYS.hr }]
  )
}

/** Each post's [start, end) indexes, the break included at start. */
export function postRanges(children: Value): [number, number][] {
  const ranges: [number, number][] = []
  children.forEach((node, index) => {
    if (node.type === POST_BREAK) ranges.push([index, index])
    else if (ranges.length === 0) ranges.push([index, index])
    ranges[ranges.length - 1][1] = index + 1
  })
  return ranges
}

/** The post the caret is in, 1-based. */
export function caretPost(editor: PlateEditor): number {
  const index = editor.selection?.anchor.path[0] ?? 0
  return Math.max(
    1,
    postRanges(editor.children).findIndex(([start, end]) => index >= start && index < end) + 1
  )
}

/** The index of the break that starts post `number` (1-based), or -1. */
function breakIndex(children: Value, number: number): number {
  const range = postRanges(children)[number - 1]
  return range && children[range[0]]?.type === POST_BREAK ? range[0] : -1
}

/**
 * Move post `from` to position `to` (both 1-based). Its break goes with it,
 * so its id and settings follow its text; a live session and undo see moves.
 */
export function movePost(editor: PlateEditor, from: number, to: number): void {
  const ranges = postRanges(editor.children)
  if (from === to || from < 1 || to < 1 || from > ranges.length || to > ranges.length) return
  const [start, end] = ranges[from - 1]
  const count = end - start
  editor.tf.withoutNormalizing(() => {
    if (to < from) {
      const target = ranges[to - 1][0]
      for (let offset = 0; offset < count; offset += 1) {
        editor.tf.moveNodes({ at: [start + offset], to: [target + offset] })
      }
    } else {
      const target = ranges[to - 1][1] - 1
      for (let offset = 0; offset < count; offset += 1) {
        editor.tf.moveNodes({ at: [start], to: [target] })
      }
    }
  })
}

/** Remove post `number`: its break and its blocks. One post always remains. */
export function deletePost(editor: PlateEditor, number: number): void {
  const ranges = postRanges(editor.children)
  if (ranges.length < 2) return
  const range = ranges[number - 1]
  if (!range) return
  const [start, end] = range
  editor.tf.withoutNormalizing(() => {
    for (let index = end - 1; index >= start; index -= 1) editor.tf.removeNodes({ at: [index] })
  })
}

/** Copy post `number` below itself as a new post (new id, no settings or comments), in one step. */
export function duplicatePost(editor: PlateEditor, number: number): void {
  const range = postRanges(editor.children)[number - 1]
  if (!range) return
  const [start, end] = range
  const first = editor.children[start]?.type === POST_BREAK ? start + 1 : start
  const withoutComments = (node: unknown): unknown => {
    if (!node || typeof node !== 'object') return node
    const entries = Object.entries(node).filter(([key]) => !key.startsWith('comment'))
    return Object.fromEntries(
      entries.map(([key, value]) => [key, key === 'children' && Array.isArray(value) ? value.map(withoutComments) : value])
    )
  }
  const copied = editor.children.slice(first, end).map(withoutComments) as Value
  const blocks = copied.length ? structuredClone(copied) : [{ children: [{ text: '' }], type: 'p' }]
  editor.tf.insertNodes([postBreak(), ...blocks], { at: [end] })
  editor.tf.select(editor.api.end([end + blocks.length]))
}

/** A post's settings, set on the break that starts it. */
export function setPostSettings(editor: PlateEditor, number: number, settings: Partial<PostSettings>): void {
  const index = breakIndex(editor.children, number)
  if (index < 0) return
  const unset = Object.entries(settings)
    .filter(([, value]) => value === undefined)
    .map(([key]) => key)
  const set = Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined))
  editor.tf.withoutNormalizing(() => {
    if (Object.keys(set).length > 0) editor.tf.setNodes(set, { at: [index] })
    if (unset.length > 0) editor.tf.unsetNodes(unset, { at: [index] })
  })
}

/** Split the post at the caret: what follows the caret starts the next post, with no settings. */
export function splitPostAtCaret(editor: PlateEditor): void {
  if (!editor.selection) return
  editor.tf.splitNodes({ always: true, mode: 'highest' })
  const entry = editor.api.block({ highest: true })
  if (!entry) return
  editor.tf.insertNodes(postBreak(), { at: [entry[1][0]] })
  const path = [entry[1][0] + 1]
  const start = editor.api.start(path)
  const leading = editor.api.string(path).match(/^\s+/)?.[0].length ?? 0
  const end = start && leading ? editor.api.after(start, { distance: leading, unit: 'offset' }) : null
  if (start && end) editor.tf.delete({ at: { anchor: start, focus: end } })
  editor.tf.select(editor.api.start(path))
}

/** Start a new post after the post holding the caret's block, and move into it. */
export function insertPostBreak(editor: PlateEditor): void {
  const entry = editor.api.block({ highest: true })
  const ranges = postRanges(editor.children)
  const current = entry ? ranges.findIndex(([start, end]) => entry[1][0] >= start && entry[1][0] < end) : -1
  insertPostAfter(editor, current < 0 ? ranges.length : current + 1)
}

/** Add an empty post right after post `number`. */
export function insertPostAfter(editor: PlateEditor, number: number): void {
  const range = postRanges(editor.children)[number - 1]
  const at = range ? range[1] : editor.children.length
  editor.tf.insertNodes([postBreak(), { children: [{ text: '' }], type: 'p' }], { at: [at] })
  editor.tf.select([at + 1], { edge: 'start' })
  editor.tf.focus()
}

/** Append a post with text, such as a thread finisher, as one undoable step. */
export function appendPost(editor: PlateEditor, text: string, settings: PostSettings = {}): void {
  const paragraphs = text.split(/\n{2,}/).map((paragraph) => ({ children: [{ text: paragraph }], type: 'p' }))
  editor.tf.insertNodes([postBreak(settings), ...paragraphs], { at: [editor.children.length] })
}

function isEmptyParagraph(node: unknown): boolean {
  const block = node as { children?: { text?: string }[]; type?: string } | undefined
  return (
    block?.type === 'p' &&
    (block.children ?? []).every((child) => typeof child.text === 'string' && !child.text)
  )
}

/**
 * The post break block. ⌘↵ (Ctrl+↵) starts a new post anywhere, and so does
 * Enter on the second empty line in a row, as in Typefully. Backspace at the
 * start of a post merges it into the one before; the merged post keeps the
 * earlier post's settings. The body always starts with exactly one break,
 * and every break has a unique id.
 */
/** Move a caret that sits on a post header into that post's text, adding a line if it has none. */
export function leaveHeader(editor: PlateEditor): boolean {
  const index = editor.selection?.anchor.path[0]
  if (index === undefined || editor.children[index]?.type !== POST_BREAK) return false
  if (!editor.children[index + 1] || editor.children[index + 1].type === POST_BREAK) {
    editor.tf.insertNodes({ type: 'p', children: [{ text: '' }] }, { at: [index + 1] })
  }
  editor.tf.select(editor.api.start([index + 1]))
  return true
}

export const PostBreakPlugin = createPlatePlugin({
  handlers: {
    onKeyDown: ({ editor, event }) => {
      // A character typed on a header goes into the post's text before any
      // trigger ("/", "@", ":") reads where the caret is.
      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && editor.api.isCollapsed())
        leaveHeader(editor)
      if (event.key !== 'Enter' || event.shiftKey || event.altKey) return
      if (event.metaKey || event.ctrlKey) return
      const entry = editor.api.block({ highest: true })
      const index = entry?.[1][0] ?? 0
      if (!entry || index === 0 || !isEmptyParagraph(entry[0])) return
      if (!isEmptyParagraph(editor.children[index - 1])) return
      event.preventDefault()
      editor.tf.withoutNormalizing(() => {
        editor.tf.removeNodes({ at: [index] })
        editor.tf.removeNodes({ at: [index - 1] })
        editor.tf.select(index - 2 >= 0 ? editor.api.end([index - 2]) : [0])
      })
      insertPostBreak(editor)
      return true
    },
  },
  key: POST_BREAK,
  node: { component: PostBreakElement, isElement: true, isVoid: true },
  priority: 1000,
  shortcuts: {
    // Ahead of the kit's exit break, which also takes ⌘↵.
    newPost: {
      handler: ({ editor }) => insertPostBreak(editor),
      keys: 'mod+enter',
      priority: 1000,
    },
  },
}).overrideEditor(({ editor, tf: { deleteBackward, insertText, normalizeNode } }) => ({
  transforms: {
    insertText(text, options) {
      if (options?.at) return insertText(text, options)
      const selection = editor.selection
      if (selection && !editor.api.isCollapsed() &&
        [selection.anchor, selection.focus].some((point) => editor.children[point.path[0]]?.type === POST_BREAK)) {
        editor.tf.deleteFragment()
      }
      // Replacing a selection that starts at a header must land in editable text.
      leaveHeader(editor)
      insertText(text, options)
    },
    deleteBackward(unit) {
      const selection = editor.selection
      const entry = editor.api.block({ highest: true })
      if (selection && entry && editor.api.isCollapsed() && editor.api.isStart(selection.anchor, entry[1])) {
        const index = entry[1][0]
        if (editor.children[index - 1]?.type === POST_BREAK) {
          // At the start of a post: merge it into the one before. The first
          // post has nothing before it to merge into.
          if (index - 1 > 0) {
            editor.tf.removeNodes({ at: [index - 1] })
            editor.tf.select(editor.api.end([index - 2]))
          }
          return
        }
      }
      deleteBackward(unit)
    },
    normalizeNode(entry, options) {
      const [node, path] = entry
      if (node.type === 'mention_input' && !editor.plugins.mention_input) {
        editor.tf.withoutNormalizing(() => {
          editor.tf.removeNodes({ at: path })
          editor.tf.insertNodes(normalizeMentions(node) as { text: string }, { at: path })
        })
        return
      }
      if (path.length === 0) {
        const children = editor.children
        if (children[0]?.type !== POST_BREAK) {
          editor.tf.insertNodes(postBreak(), { at: [0] })
          return
        }
        if (children[1]?.type === POST_BREAK) {
          // Two editors added a first break at once: keep one.
          editor.tf.removeNodes({ at: [1] })
          return
        }
        const seen = new Set<string>()
        for (let index = 0; index < children.length; index += 1) {
          const node = children[index]
          if (node.type !== POST_BREAK) continue
          const id = typeof node.id === 'string' ? node.id : ''
          if (!id || seen.has(id)) {
            editor.tf.setNodes({ id: newPostId() }, { at: [index] })
            return
          }
          seen.add(id)
        }
      }
      normalizeNode(entry, options)
    },
  },
}))

/** What a post's tools can do beyond the editor itself; the host fills them in. */
export type PostTools = {
  /** The post's count for the platform being edited; `active` while the post is in use. */
  counter?: (number: number, active: boolean) => React.ReactNode
  /** Extra items for the post's More menu, such as splitting at the limit. */
  menu?: (number: number) => React.ReactNode
  /** Wraps the post's Ask AI button so it opens Refine at the post. */
  refine?: (number: number, button: React.ReactElement) => React.ReactNode
  /** Settings tools for this platform's posts (audience, poll), drawn in the post's bar. */
  settings?: (props: { number: number; settings: PostSettings }) => React.ReactNode
}

/** The post tools the host provides. */
export const PostToolsContext = React.createContext<PostTools>({})

/** The post under the pointer, 0 for none; the caret's post is read from the editor. */
const HoveredPostContext = React.createContext(0)

/**
 * Tracks which post the pointer is over, so that post's bar shows. Posts are
 * runs of top-level blocks, not elements, so the block under the pointer
 * names the post.
 */
export function PostHover({ children }: { children: React.ReactNode }) {
  const editor = useEditorRef()
  const [hovered, setHovered] = React.useState(0)
  const track = (target: EventTarget | null) => {
    const element = target instanceof Element ? target : null
    const bar = element?.closest<HTMLElement>('[data-post-bar]')
    let number = bar ? Number(bar.dataset.postBar) : 0
    if (!bar) {
      let block = element?.closest('[data-slate-node="element"]') ?? null
      while (block?.parentElement && !block.parentElement.hasAttribute('data-slate-editor'))
        block = block.parentElement.closest('[data-slate-node="element"]')
      try {
        const index = block ? editor.api.findPath(editor.api.toSlateNode(block)!)?.[0] : undefined
        if (index !== undefined)
          number = postRanges(editor.children).findIndex(([start, end]) => index >= start && index < end) + 1
      } catch {
        // A node Slate no longer knows (mid-render): keep the last post.
        return
      }
    }
    if (number !== hovered) setHovered(number)
  }
  return (
    <HoveredPostContext.Provider value={hovered}>
      <div
        className="relative"
        onMouseLeave={() => setHovered(0)}
        onMouseMove={(event) => track(event.target)}
      >
        {children}
      </div>
    </HoveredPostContext.Provider>
  )
}

/**
 * The bar under a post: its count, then Image, Ask AI, the platform's post
 * settings and More (duplicate, move, delete). It shows for the post with the
 * caret, the post under the pointer, and while it has keyboard focus; it
 * keeps its height either way, so the text never shifts.
 */
export function PostBar({ className, number }: { className?: string; number: number }) {
  const tools = React.useContext(PostToolsContext)
  const hovered = React.useContext(HoveredPostContext)
  const editor = useEditorRef()
  const readOnly = useReadOnly()
  const count = useEditorSelector((current) => postRanges(current.children).length, [])
  const settings = useEditorSelector(
    (current) => {
      const index = breakIndex(current.children, number)
      return (index < 0 ? {} : current.children[index]) as PostSettings
    },
    [number]
  )
  const caret = useEditorSelector((current) => (current.selection ? caretPost(current) : 0), [])
  const active = hovered === number || caret === number
  const keys = useKeys()
  const icon =
    'size-8 justify-center rounded-md p-0 text-muted-foreground hover:bg-accent hover:text-foreground'
  if (readOnly) return null
  const ask = (
    <Button aria-label={`Ask AI about post ${number}`} className={icon} size={null} title={`Ask AI (${keys.label({ key: 'j', mod: true })})`} type="button" variant="custom">
      <SparkleIcon aria-hidden className="size-4 text-primary" />
    </Button>
  )
  return (
    <div
      aria-label={`Post ${number} tools`}
      className={cn('flex h-8 items-center gap-1', className)}
      contentEditable={false}
      data-post-bar={number}
      role="toolbar"
    >
      {tools.counter?.(number, active)}
      <div
        className={cn(
          'ms-auto flex items-center gap-0.5 transition-opacity duration-150 focus-within:opacity-100 hover:opacity-100 motion-reduce:transition-none',
          active ? 'opacity-100' : 'opacity-0'
        )}
      >
        {/* The toolbar's Ask AI covers a single post; a thread asks post by post. */}
        {tools.refine && count > 1 ? tools.refine(number, ask) : null}
        {tools.settings?.({ number, settings })}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={`More for post ${number}`}
              className={icon}
              size={null}
              title="More"
              type="button"
              variant="custom"
            >
              <DotsThreeIcon aria-hidden className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-56"
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            {tools.menu?.(number)}
            <DropdownMenuItem onSelect={() => duplicatePost(editor, number)}>
              <CopyIcon aria-hidden />
              Duplicate post
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => insertPostAfter(editor, number)}>
              <AddIcon aria-hidden />
              Add a post below
            </DropdownMenuItem>
            {count > 1 ? (
              <>
                <DropdownMenuItem
                  disabled={number === 1}
                  onSelect={() => movePost(editor, number, number - 1)}
                >
                  <ArrowUpIcon aria-hidden />
                  Move post up
                  <DropdownMenuShortcut aria-hidden>{keys.label({ alt: true, key: 'arrowup' })}</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={number === count}
                  onSelect={() => movePost(editor, number, number + 1)}
                >
                  <ArrowDownIcon aria-hidden />
                  Move post down
                  <DropdownMenuShortcut aria-hidden>{keys.label({ alt: true, key: 'arrowdown' })}</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => deletePost(editor, number)} variant="destructive">
                  <DeleteIcon aria-hidden />
                  Delete post
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

/** A post's header: the host's avatar, name and handle, and a drag grip on hover. */
function PostHead({ number }: { number: number }) {
  const header = React.useContext(PostHeaderContext)
  const editor = useEditorRef()
  const readOnly = useReadOnly()
  const count = useEditorSelector((current) => postRanges(current.children).length, [])
  const [over, setOver] = React.useState(false)
  return (
    <div
      className={cn('group/post flex items-center gap-2 rounded-lg', over && 'bg-accent')}
      data-post-number={number}
      data-local-dropzone="true"
      onDragLeave={() => setOver(false)}
      onDragOver={(event) => {
        if (readOnly || !event.dataTransfer.types.includes(POST_DRAG)) return
        event.preventDefault()
        event.stopPropagation()
        setOver(true)
      }}
      onDrop={(event) => {
        setOver(false)
        if (readOnly || !event.dataTransfer.types.includes(POST_DRAG)) return
        event.preventDefault()
        event.stopPropagation()
        try {
          const source = JSON.parse(event.dataTransfer.getData(POST_DRAG)) as {editorId?:string;postId?:string}
          if (source.editorId !== editor.id || !source.postId) return
          // Resolve the stable post identity after any collaborative edits during the drag.
          const from = postRanges(editor.children).findIndex(([start]) => editor.children[start].id === source.postId) + 1
          if (from) movePost(editor, from, number)
        } catch { /* Ignore a malformed or foreign drag. */ }
      }}
    >
      <div className="min-w-0 flex-1">{header(number)}</div>
      {readOnly || count < 2 ? null : (
        // Inside the post's own row, at its end: never over the avatar.
        <span
          aria-label={`Drag post ${number}`}
          className="flex size-8 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover/post:opacity-100 hover:bg-accent hover:text-foreground motion-reduce:transition-none"
          draggable
          onDragStart={(event) => {
            const index = breakIndex(editor.children, number)
            event.dataTransfer.setData(POST_DRAG, JSON.stringify({editorId:editor.id,postId:editor.children[index]?.id}))
            event.dataTransfer.effectAllowed = 'move'
          }}
          role="img"
          title="Drag to reorder"
        >
          <DragIcon aria-hidden className="size-4" />
        </span>
      )}
    </div>
  )
}

/** The drag type a post header carries, so other drops are left alone. */
const POST_DRAG = 'application/x-shots-post'

function PostBreakElement(props: PlateElementProps) {
  const { element } = props
  // Slate's DOM path cache can still describe the previous render after a move.
  const number = useEditorSelector(
    (editor) => {
      return editor.children.filter((node) => node.type === POST_BREAK)
        .findIndex((node) => node.id === element.id) + 1
    },
    [element.id]
  )
  return (
    <PlateElement {...props} className={cn('relative', number === 1 ? 'pt-2' : 'pt-10')}>
      {/* The previous post's bar sits in the gap above this header, under that post. */}
      {number > 1 ? <PostBar className="absolute inset-x-0 top-0" number={number - 1} /> : null}
      <div className="select-none" contentEditable={false} data-post-id={String(element.id ?? '')}>
        <PostHead number={number} />
      </div>
      {props.children}
    </PlateElement>
  )
}

/**
 * The line that joins a thread's avatars, drawn in the gutter from the first
 * post's avatar to the last one's. Hidden for a single post.
 */
export function ThreadLine() {
  const version = useEditorVersion()
  const ref = React.useRef<HTMLDivElement>(null)
  const [box, setBox] = React.useState<{ height: number; left: number; top: number } | null>(null)
  const [size, setSize] = React.useState(0)
  React.useEffect(() => {
    const container = ref.current?.parentElement
    if (!container) return
    const observer = new ResizeObserver(() => setSize((current) => current + 1))
    observer.observe(container)
    return () => observer.disconnect()
  }, [])
  React.useLayoutEffect(() => {
    const container = ref.current?.parentElement
    const avatars = container?.querySelectorAll<HTMLElement>('[data-post-avatar]') ?? []
    if (!container || avatars.length < 2) return setBox(null)
    const origin = container.getBoundingClientRect()
    const first = avatars[0].getBoundingClientRect()
    const last = avatars[avatars.length - 1].getBoundingClientRect()
    setBox({
      height: last.top - first.bottom,
      left: first.left - origin.left + first.width / 2,
      top: first.bottom - origin.top + container.scrollTop,
    })
  }, [version, size])
  return (
    <div
      aria-hidden
      className={cn('pointer-events-none absolute w-px bg-foreground/10', !box && 'hidden')}
      ref={ref}
      style={box ?? undefined}
    />
  )
}

/** Kept for hosts that drew the first header outside the editor: the first break draws it now. */
export function FirstPostHeader() {
  return <div className={cn('pt-8', POST_COLUMN)} />
}
