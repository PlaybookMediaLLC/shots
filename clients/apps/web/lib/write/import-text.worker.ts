import { splitThread } from './import-text'

/** The worker's answer to one split request. */
export type SplitResult = { posts: string[]; error: string }

/** What the worker posts: that it has loaded, then one answer per request. */
export type SplitMessage = SplitResult | { ready: true }

// Thread screens split here, off the main thread: X's and Mastodon's link
// scan (twitter-text) is quadratic in a run without spaces, seconds on a long one.
addEventListener('message', ({ data }: MessageEvent<Parameters<typeof splitThread>>) => {
  try {
    postMessage({ posts: splitThread(...data), error: '' } satisfies SplitResult)
  } catch (error) {
    postMessage({ posts: [], error: (error as Error).message } satisfies SplitResult)
  }
})
// Loading this module takes a moment; a worker that has not said so yet has
// started nothing, so the page gives it the latest request instead of replacing it.
postMessage({ ready: true } satisfies SplitMessage)
