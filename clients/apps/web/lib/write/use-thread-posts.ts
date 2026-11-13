'use client'

import * as React from 'react'
import type { DraftChannel } from './document'
import { importedPosts } from './import-text'
import type { SplitMessage, SplitRequest, SplitResult } from './import-text.worker'

/** Thread posts, why the text cannot become them, and whether they are still for older text. */
type ThreadPosts = { error: string; pending: boolean; posts: string[] }

/**
 * `text` as thread posts, the way every paste-as-thread screen splits it: at
 * the writer's own `---` and blank-line breaks, or, given `limit`, at that
 * many characters as `channel` counts them.
 *
 * The length split runs in a Web Worker, because counting X's links can take
 * seconds. Until the answer for these exact arguments arrives, the last
 * answer is shown with `pending` set, and callers keep their action
 * disabled. One worker serves the caller while it is mounted. A request made
 * while it is splitting replaces it, so typing never waits behind a split
 * nobody will read; one made while it is still loading becomes the request
 * it starts with.
 */
export function useThreadPosts(text: string, channel: DraftChannel, limit?: number): ThreadPosts {
  const worker = React.useRef<Worker | null>(null)
  // Whether `worker` has loaded, so a request sent to it starts at once.
  const ready = React.useRef(false)
  // The request the worker is splitting, or will split once loaded; null when idle.
  const sent = React.useRef<SplitRequest | null>(null)
  const lastId = React.useRef(0)
  const [split, setSplit] = React.useState<(SplitRequest & SplitResult) | null>(null)
  // The `---` split is a regular expression, so it stays on the page.
  const imported = React.useMemo(() => {
    if (limit !== undefined) return null
    try {
      return { error: '', pending: false, posts: importedPosts(text) }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'This text cannot be split.'
      return { error: message, pending: false, posts: [] }
    }
  }, [limit, text])

  React.useEffect(
    () => () => {
      worker.current?.terminate()
      worker.current = null
    },
    []
  )

  React.useEffect(() => {
    if (limit === undefined) {
      // Nobody reads a split once the length split is off.
      if (sent.current) {
        worker.current?.terminate()
        worker.current = null
        sent.current = null
      }
      return
    }
    const request: SplitRequest = { channel, id: ++lastId.current, limit, text }
    if (sent.current && ready.current) {
      worker.current?.terminate()
      worker.current = null
    }
    // A worker still loading has started nothing: this becomes its first request.
    sent.current = request
    if (worker.current) {
      if (ready.current) worker.current.postMessage(request)
      return
    }
    let created: Worker
    try {
      created = new Worker(new URL('./import-text.worker.ts', import.meta.url), { type: 'module' })
    } catch (error) {
      sent.current = null
      const reason = error instanceof Error ? ` ${error.message}` : ''
      setSplit({ ...request, error: `This browser could not split the text.${reason}`, posts: [] })
      return
    }
    ready.current = false
    created.onmessage = ({ data }: MessageEvent<SplitMessage>) => {
      if (worker.current !== created) return
      if ('ready' in data) {
        ready.current = true
        if (sent.current) created.postMessage(sent.current)
        return
      }
      const answered = sent.current
      if (!answered || data.id !== answered.id) return
      sent.current = null
      setSplit({ ...answered, ...data })
    }
    created.onerror = created.onmessageerror = () => {
      if (worker.current !== created) return
      const failed = sent.current
      created.terminate()
      worker.current = null
      sent.current = null
      if (failed) setSplit({ ...failed, error: 'The text could not be split.', posts: [] })
    }
    worker.current = created
  }, [channel, limit, text])

  if (imported) return imported
  return {
    error: split?.error ?? '',
    pending: !(split?.text === text && split.channel === channel && Object.is(split.limit, limit)),
    posts: split?.posts ?? [],
  }
}
