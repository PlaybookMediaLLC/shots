'use client'

import * as React from 'react'
import type { DraftChannel } from './document'
import { importedPosts, type splitThread } from './import-text'
import type { SplitMessage, SplitResult } from './import-text.worker'

type SplitRequest = Parameters<typeof splitThread>

/** Thread posts, why the text cannot become them, and whether they are still for older text. */
type ThreadPosts = { error: string; pending: boolean; posts: string[] }

/**
 * `text` as thread posts, the way every paste-as-thread screen splits it: at
 * the writer's own `---` and blank-line breaks, or, given `limit`, at that
 * many characters as `channel` counts them.
 *
 * The length split runs in import-text.worker.ts, because counting X's links
 * can take seconds. Until the answer for these exact arguments arrives, the
 * last answer is shown with `pending` set, and callers keep their action
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
  const [split, setSplit] = React.useState<SplitResult & { request: SplitRequest }>()
  // The `---` split is a regular expression, so it stays on the page.
  const imported = React.useMemo(() => {
    if (limit !== undefined) return null
    try {
      return { error: '', pending: false, posts: importedPosts(text) }
    } catch (error) {
      return { error: (error as Error).message, pending: false, posts: [] }
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
    const request: SplitRequest = [text, channel, limit]
    if (sent.current && ready.current) {
      worker.current?.terminate()
      worker.current = null
    }
    sent.current = request
    if (worker.current) {
      if (ready.current) worker.current.postMessage(request)
      return
    }
    const fail = (failed: SplitRequest, reason = '') =>
      setSplit({ request: failed, posts: [], error: `The split preview could not load.${reason}` })
    let created: Worker
    try {
      created = new Worker(new URL('./import-text.worker.ts', import.meta.url), { type: 'module' })
    } catch (error) {
      sent.current = null
      fail(request, ` ${(error as Error).message}`)
      return
    }
    ready.current = false
    // One request is in flight at a time, so an answer is for `sent`; a replaced
    // worker's late messages are dropped by the identity check.
    created.onmessage = ({ data }: MessageEvent<SplitMessage>) => {
      if (worker.current !== created) return
      if ('ready' in data) {
        ready.current = true
        if (sent.current) created.postMessage(sent.current)
        return
      }
      const answered = sent.current
      if (!answered) return
      sent.current = null
      setSplit({ ...data, request: answered })
    }
    created.onerror = created.onmessageerror = () => {
      if (worker.current !== created) return
      const failed = sent.current
      created.terminate()
      worker.current = null
      sent.current = null
      if (failed) fail(failed)
    }
    worker.current = created
  }, [channel, limit, text])

  if (imported) return imported
  const [doneText, doneChannel, doneLimit] = split?.request ?? []
  return {
    error: split?.error ?? '',
    pending: !(doneText === text && doneChannel === channel && Object.is(doneLimit, limit)),
    posts: split?.posts ?? [],
  }
}
