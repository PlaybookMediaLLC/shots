'use client'

import * as React from 'react'
import type { DraftChannel } from './document'
import { importedPosts } from './import-text'
import type { SplitRequest, SplitResult } from './import-text.worker'
import { useWorkerAnswer } from './use-worker-answer'

const startSplit = () =>
  new Worker(new URL('./import-text.worker.ts', import.meta.url), { type: 'module' })

const SPLIT_FAILED: Omit<SplitResult, 'id'> = { error: 'The text could not be split.', posts: [] }

/** Thread posts, why the text cannot become them, and whether they are still for older text. */
type ThreadPosts = { error: string; pending: boolean; posts: string[] }

/**
 * `text` as thread posts, the way every paste-as-thread screen splits it: at
 * the writer's own `---` and blank-line breaks, or, given `limit`, at that
 * many characters as `channel` counts them.
 *
 * The length split runs in a Web Worker (`useWorkerAnswer`), because counting
 * X's links can take seconds. Until the answer for these exact arguments
 * arrives, the last answer is shown with `pending` set, and callers keep
 * their action disabled.
 */
export function useThreadPosts(text: string, channel: DraftChannel, limit?: number): ThreadPosts {
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
  const request = React.useMemo(
    (): Omit<SplitRequest, 'id'> | undefined =>
      limit === undefined ? undefined : { channel, limit, text },
    [channel, limit, text]
  )
  const split = useWorkerAnswer(startSplit, request, SPLIT_FAILED)

  if (imported) return imported
  return {
    error: split.answer?.error ?? '',
    pending: split.pending,
    posts: split.answer?.posts ?? [],
  }
}
