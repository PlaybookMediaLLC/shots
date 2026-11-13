'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * What a Web Worker answers for `request`, for counting too slow for the page:
 * X's link scan (twitter-text) is quadratic in a run without spaces, about a
 * second for 10,000 CJK characters. The worker gets each request as one
 * message and answers it with one.
 *
 * Starting a worker takes a few hundred milliseconds, so an idle one is reused
 * and only a worker still busy with an older request is replaced. No request
 * starts nothing. `answer` is the latest answer, kept while a newer one runs,
 * or `failed` when the worker could not load or crashed; `pending` is true
 * until it answers this exact `request`, so callers memoize `request`.
 * `start` and `failed` must keep their identity (module-level values), or every
 * render restarts the request.
 */
export function useWorkerAnswer<Request, Answer>(
  start: () => Worker,
  request: Request | undefined,
  failed: Answer
): { answer: Answer | undefined; pending: boolean } {
  const [result, setResult] = useState<{ answer: Answer; request: Request }>()
  const worker = useRef<{ worker: Worker; busy: boolean } | null>(null)
  useEffect(() => {
    if (worker.current?.busy) {
      worker.current.worker.terminate()
      worker.current = null
    }
    if (request === undefined) return
    const fail = () => setResult({ answer: failed, request })
    try {
      worker.current ??= { worker: start(), busy: false }
    } catch {
      fail()
      return
    }
    const current = worker.current
    current.busy = true
    current.worker.onmessage = ({ data }: MessageEvent<Answer>) => {
      current.busy = false
      setResult({ answer: data, request })
    }
    current.worker.onerror = () => {
      current.worker.terminate()
      if (worker.current === current) worker.current = null
      fail()
    }
    current.worker.postMessage(request)
  }, [failed, request, start])
  useEffect(
    () => () => {
      worker.current?.worker.terminate()
      worker.current = null
    },
    []
  )
  return {
    answer: result?.answer,
    pending: request !== undefined && result?.request !== request,
  }
}
