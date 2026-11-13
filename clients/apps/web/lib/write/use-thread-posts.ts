'use client'

import * as React from 'react'
import type { DraftChannel } from './document'
import { importedPosts } from './import-text'
import type { SplitRequest, SplitResult } from './import-text.worker'

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
 * disabled. One worker serves the caller while it is mounted; a request made
 * while it is still splitting replaces it, so typing never waits behind a
 * split nobody will read.
 */
export function useThreadPosts(text: string, channel: DraftChannel, limit?: number): ThreadPosts {
  const worker = React.useRef<Worker | null>(null)
  // The request the worker is splitting; null while it is idle.
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
      sent.current = null
    },
    []
  )

  React.useEffect(() => {
    if (limit === undefined) return
    const request: SplitRequest = { channel, id: ++lastId.current, limit, text }
    if (sent.current) {
      worker.current?.terminate()
      worker.current = null
    }
    let current = worker.current
    if (!current) {
      try {
        current = new Worker(new URL('./import-text.worker.ts', import.meta.url), {
          type: 'module',
        })
      } catch {
        sent.current = null
        setSplit({ ...request, error: 'This browser could not split the text.', posts: [] })
        return
      }
      const created = current
      created.onmessage = ({ data }: MessageEvent<SplitResult>) => {
        const answered = sent.current
        if (!answered || data.id !== answered.id) return
        sent.current = null
        setSplit({ ...answered, ...data })
      }
      created.onerror = () => {
        const failed = sent.current
        if (worker.current !== created) return
        created.terminate()
        worker.current = null
        sent.current = null
        if (failed) setSplit({ ...failed, error: 'The text could not be split.', posts: [] })
      }
      worker.current = created
    }
    sent.current = request
    current.postMessage(request)
  }, [channel, limit, text])

  if (imported) return imported
  return {
    error: split?.error ?? '',
    pending: !(split?.text === text && split.channel === channel && split.limit === limit),
    posts: split?.posts ?? [],
  }
}
