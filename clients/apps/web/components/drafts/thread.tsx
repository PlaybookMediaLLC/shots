'use client'

import { normalizeMentions } from '@/lib/write/normalize-mentions'
import {
  AddIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CloseIcon,
  DragIcon,
  ImageIcon,
} from '@/components/platform-shell/icons'

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

/** Put the caret at the end of post `number`, to insert into it there. */
export function selectPostEnd(editor: PlateEditor, number: number): void {
  const [start, end] = postRanges(editor.children)[number - 1]
  if (end - 1 > start) editor.tf.select(editor.api.end([end - 1]))
  editor.tf.focus()
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

/** What a post's tools can do beyond the editor itself. */
export type PostTools = {
  addImage?: () => void
  /** Settings tools for this platform's posts, drawn beside the header. */
  settings?: (props: { number: number; settings: PostSettings }) => React.ReactNode
}

/** The post tools the host provides. */
export const PostToolsContext = React.createContext<PostTools>({})

/** A post's header with its tools: add below, settings, media, reorder, delete. */
function PostHead({ number, settings }: { number: number; settings: PostSettings }) {
  const header = React.useContext(PostHeaderContext)
  const tools = React.useContext(PostToolsContext)
  const editor = useEditorRef()
  const readOnly = useReadOnly()
  const count = useEditorSelector((current) => postRanges(current.children).length, [])
  const [over, setOver] = React.useState(false)
  const button =
    'flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-30'
  return (
    <div
      className={cn('group/post flex items-start gap-2 rounded-lg', over && 'bg-sky-400/[0.06]')}
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
      {readOnly ? null : (
        <div className="flex shrink-0 items-center flex-wrap gap-0.5">
          {tools.settings?.({ number, settings })}
          <Button
            variant="custom"
            size={null}
            aria-label={`Add a post below post ${number}`}
            className={button}
            onClick={() => insertPostAfter(editor, number)}
            title="Add post below"
            type="button"
          >
            <AddIcon aria-hidden size={15} />
          </Button>
          {tools.addImage ? (
            <Button
              variant="custom"
              size={null}
              aria-label={`Add media to post ${number}`}
              className={button}
              onClick={() => {
                selectPostEnd(editor, number)
                tools.addImage?.()
              }}
              title="Add media (⌘⇧I)"
              type="button"
            >
              <ImageIcon aria-hidden size={15} />
            </Button>
          ) : null}
          {count < 2 ? null : (
            <>
              <span
                aria-label={`Drag post ${number}`}
                className={cn(button, 'cursor-grab')}
                draggable
                onDragStart={(event) => {
                  // Plate's window drag backend otherwise cancels this local gesture.
                  event.stopPropagation()
                  const index = breakIndex(editor.children, number)
                  event.dataTransfer.setData(POST_DRAG, JSON.stringify({editorId:editor.id,postId:editor.children[index]?.id}))
                  event.dataTransfer.effectAllowed = 'move'
                }}
                onDragEnd={(event) => event.stopPropagation()}
                role="img"
              >
                <DragIcon aria-hidden size={15} />
              </span>
              <Button
                variant="custom"
                size={null}
                aria-label={`Move post ${number} up`}
                className={button}
                disabled={number === 1}
                onClick={() => movePost(editor, number, number - 1)}
                title="Move up (⌥↑)"
                type="button"
              >
                <ArrowUpIcon aria-hidden size={14} />
              </Button>
              <Button
                variant="custom"
                size={null}
                aria-label={`Move post ${number} down`}
                className={button}
                disabled={number === count}
                onClick={() => movePost(editor, number, number + 1)}
                title="Move down (⌥↓)"
                type="button"
              >
                <ArrowDownIcon aria-hidden size={14} />
              </Button>
              <Button
                variant="custom"
                size={null}
                aria-label={`Delete post ${number}`}
                className={cn(button, 'hover:text-red-700 dark:hover:text-red-400')}
                onClick={() => deletePost(editor, number)}
                title="Delete post"
                type="button"
              >
                <CloseIcon aria-hidden size={14} />
              </Button>
            </>
          )}
        </div>
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
  const settings = element as unknown as PostSettings
  return (
    <PlateElement {...props} className={number === 1 ? 'pt-2' : 'pt-8'}>
      <div className="select-none" contentEditable={false} data-post-id={String(element.id ?? '')}>
        <PostHead number={number} settings={settings} />
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
