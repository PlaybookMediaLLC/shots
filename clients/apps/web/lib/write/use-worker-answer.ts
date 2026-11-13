'use client'

import * as React from 'react'

/** What a worker posts: that it has loaded, then each answer with its request's id. */
type WorkerMessage<Answer> = { ready: true } | (Answer & { id: number })

/**
 * What a Web Worker answers for `request`. The worker posts `{ ready: true }`
 * once loaded, then answers each request, sent as `{ ...request, id }`, with
 * `{ ...answer, id }` (see `import-text.worker.ts`).
 *
 * One worker serves the caller while it is mounted. A request made while it
 * is answering replaces it, so typing never waits behind an answer nobody
 * will read; one made while it is still loading becomes the request it
 * starts with. No request ends the work in progress. A worker that cannot
 * start, or crashes, answers `failed`.
 *
 * Until the answer for this exact `request` arrives, the last answer is
 * returned with `pending` set, so callers memoize `request`. `start` and
 * `failed` must be module-level values: a new one each render re-sends the
 * request after every answer, without end.
 */
export function useWorkerAnswer<Request extends object, Answer extends object>(
  start: () => Worker,
  request: Request | undefined,
  failed: Answer
): { answer: Answer | undefined; pending: boolean } {
  const worker = React.useRef<Worker | null>(null)
  // Whether `worker` has loaded, so a request sent to it starts at once.
  const ready = React.useRef(false)
  // The request the worker is answering, or will answer once loaded; null when idle.
  const sent = React.useRef<{ id: number; request: Request } | null>(null)
  const lastId = React.useRef(0)
  const [result, setResult] = React.useState<{ answer: Answer; request: Request } | null>(null)

  React.useEffect(
    () => () => {
      worker.current?.terminate()
      worker.current = null
    },
    []
  )

  React.useEffect(() => {
    const send = (to: Worker, message: { id: number; request: Request }) =>
      to.postMessage({ ...message.request, id: message.id })
    if (request === undefined) {
      // Nobody reads an answer once its request is gone.
      if (sent.current) {
        worker.current?.terminate()
        worker.current = null
        sent.current = null
      }
      return
    }
    const message = { id: ++lastId.current, request }
    if (sent.current && ready.current) {
      worker.current?.terminate()
      worker.current = null
    }
    // A worker still loading has started nothing: this becomes its first request.
    sent.current = message
    if (worker.current) {
      if (ready.current) send(worker.current, message)
      return
    }
    let created: Worker
    try {
      created = start()
    } catch {
      sent.current = null
      setResult({ answer: failed, request })
      return
    }
    ready.current = false
    created.onmessage = ({ data }: MessageEvent<WorkerMessage<Answer>>) => {
      if (worker.current !== created) return
      if ('ready' in data) {
        ready.current = true
        if (sent.current) send(created, sent.current)
        return
      }
      const answered = sent.current
      if (!answered || data.id !== answered.id) return
      sent.current = null
      setResult({ answer: data, request: answered.request })
    }
    created.onerror = created.onmessageerror = () => {
      if (worker.current !== created) return
      const lost = sent.current
      created.terminate()
      worker.current = null
      sent.current = null
      if (lost) setResult({ answer: failed, request: lost.request })
    }
    worker.current = created
  }, [failed, request, start])

  return { answer: result?.answer, pending: request !== undefined && result?.request !== request }
}
