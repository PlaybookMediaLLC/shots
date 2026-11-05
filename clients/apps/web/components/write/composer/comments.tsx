'use client'

import * as React from 'react'
import type { PlateEditor } from '@shots/platejs-editor/platejs/react'
import { discussionPlugin, type TDiscussion } from '@shots/platejs-editor/plugins'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { LocalTime } from '@/components/drafts/local-time'
import type { DraftWire } from '@/lib/content-drafts/client'
import { readDiscussions } from '@/lib/content-drafts/discussions'
import type { PlateBody, PlatformVersions } from '@/lib/write/document'
import { commentAnchorExists } from '@/lib/write/comment-anchors'
import { commentThreads } from '@/lib/write/versions'
import { useKeys } from '../shortcuts'

type Thread = TDiscussion & {scope?: 'draft'|'post'|'text';platform?: string;postId?:string}

/** A comment's text from its rich content. */
function commentText(value: unknown): string {
  const parts: string[] = []
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit)
    if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>
      if (typeof record.text === 'string') parts.push(record.text)
      if (record.type === 'mention' && typeof record.value === 'string')
        parts.push(`@${record.value}`)
      visit(record.children)
    }
  }
  visit(value)
  return parts.join('').trim()
}

/**
 * The comments panel (RFC 025): every thread on the draft, open and
 * resolved, with the ones whose text was removed shown as orphaned rather
 * than moved onto other text; guest comments from the public link; and how
 * to comment. Comments themselves are written beside the text they anchor.
 */
export function CommentsPanel({
  draft,
  editor,
  primary,
  users,
  versions,
}: {
  draft: DraftWire
  editor: PlateEditor | null
  primary: PlateBody
  users: Record<string, string>
  versions: PlatformVersions
}) {
  const { mod } = useKeys()
  const [threads, setThreads] = React.useState<Thread[]>(
    () => readDiscussions(draft.discussions).threads as unknown as Thread[]
  )
  React.useEffect(() => {
    if (!editor) return
    const read = () => setThreads(editor.getOption(discussionPlugin, 'discussions') ?? [])
    read()
    const timer = setInterval(read, 1_000)
    return () => clearInterval(timer)
  }, [editor])
  const anchored = new Set([
    ...commentThreads(primary),
    ...versions.versions.flatMap((version) => commentThreads(version.body)),
  ])
  for (const thread of threads) {
    if (commentAnchorExists(thread, primary, versions, draft.primaryPlatform ?? 'x')) anchored.add(thread.id)
  }
  const names = {...Object.fromEntries(Object.entries(readDiscussions(draft.discussions).users).map(([id, person]) => [id,person.name])),...users}
  const reopen = (id: string) => {
    if (!editor) return
    const current = editor.getOption(discussionPlugin, 'discussions') ?? []
    editor.setOption(
      discussionPlugin,
      'discussions',
      current.map((thread) => (thread.id === id ? { ...thread, isResolved: false } : thread))
    )
  }
  const resolve = (id: string) => {
    if (!editor) return
    const current = editor.getOption(discussionPlugin, 'discussions') ?? []
    editor.setOption(
      discussionPlugin,
      'discussions',
      current.map((thread) => (thread.id === id ? { ...thread, isResolved: true } : thread))
    )
  }
  const open = threads.filter((thread) => !thread.isResolved)
  const resolved = threads.filter((thread) => thread.isResolved)
  return (
    <div className="flex flex-col gap-4 p-4 text-sm" data-testid="comments-panel">
      <p className="text-xs text-muted-foreground">
        Select text and press {mod}⇧M to comment on it. Mention a teammate with @. You can edit and
        delete only your own comments.
      </p>
      <ThreadList
        anchored={anchored}
        onAction={resolve}
        actionLabel="Resolve"
        threads={open}
        title="Open"
        users={names}
      />
      <ThreadList
        anchored={anchored}
        onAction={reopen}
        actionLabel="Reopen"
        threads={resolved}
        title="Resolved"
        users={names}
      />
      {draft.guestComments.length > 0 ? (
        <section>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            From the public link
          </h3>
          <ul className="grid gap-2" data-testid="guest-comments">
            {draft.guestComments.map((comment) => (
              <li
                className="rounded-lg border border-border px-3 py-2"
                key={`${comment.createdAt}-${comment.name}`}
              >
                <p className="text-xs text-muted-foreground">
                  <span className="text-foreground">{comment.name}</span> ·{' '}
                  <LocalTime value={comment.createdAt} />
                </p>
                <p className="mt-0.5 whitespace-pre-wrap text-sm text-foreground">
                  {comment.text}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

function ThreadList({
  actionLabel,
  anchored,
  onAction,
  threads,
  title,
  users,
}: {
  actionLabel: string
  anchored: Set<string>
  onAction: (id: string) => void
  threads: Thread[]
  title: string
  users: Record<string, string>
}) {
  if (threads.length === 0) return null
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title} · {threads.length}
      </h3>
      <ul className="grid gap-2">
        {threads.map((thread) => {
          const orphaned =
            !anchored.has(thread.id) && !('scope' in thread && thread.scope === 'draft')
          const first = thread.comments?.[0]
          return (
            <li
              className="rounded-lg border border-border px-3 py-2"
              data-testid="comment-thread"
              key={thread.id}
            >
              {thread.documentContent ? (
                <p className="mb-1 line-clamp-2 border-l-2 border-amber-400/50 pl-2 text-xs text-muted-foreground">
                  “{thread.documentContent}”
                </p>
              ) : null}
              {orphaned ? (
                <p className="mb-1 text-label text-amber-700 dark:text-amber-300" data-testid="orphaned-thread">
                  The text this comment was on was removed. It stays here; it is not moved to other
                  text.
                </p>
              ) : null}
              <p className="text-sm text-foreground">{commentText(first?.contentRich) || ' '}</p>
              <p className="mt-1 flex items-center justify-between text-label text-muted-foreground">
                <span>
                  {users[first?.userId ?? ''] ?? 'Member'}
                  {thread.comments && thread.comments.length > 1
                    ? ` · ${thread.comments.length - 1} replies`
                    : ''}
                </span>
                <span className="flex items-center gap-2">
                  {thread.comments && thread.comments.length > 1 ? (
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          className="text-muted-foreground hover:text-foreground"
                          size={null}
                          type="button"
                          variant="custom"
                        >
                          Replies
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="grid w-72 gap-2 p-3 text-xs">
                        {thread.comments.slice(1).map((comment) => (
                          <p key={comment.id}>
                            <span className="text-muted-foreground">
                              {users[comment.userId] ?? 'Member'}:
                            </span>{' '}
                            {commentText(comment.contentRich)}
                          </p>
                        ))}
                      </PopoverContent>
                    </Popover>
                  ) : null}
                  <Button
                    className="text-sky-700 dark:text-sky-300 hover:text-sky-800 dark:hover:text-sky-200"
                    onClick={() => onAction(thread.id)}
                    size={null}
                    type="button"
                    variant="custom"
                  >
                    {actionLabel}
                  </Button>
                </span>
              </p>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
