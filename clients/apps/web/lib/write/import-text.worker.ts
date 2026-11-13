import { splitThread } from './import-text'

/** The worker's answer to one split request. */
export type SplitResult = { posts: string[]; error: string }

// The paste dialog splits here, off the main thread: X's and Mastodon's link
// scan (twitter-text) is quadratic in a run without spaces, seconds on a long one.
addEventListener('message', ({ data }: MessageEvent<Parameters<typeof splitThread>>) => {
  try {
    postMessage({ posts: splitThread(...data), error: '' } satisfies SplitResult)
  } catch (error) {
    postMessage({ posts: [], error: (error as Error).message } satisfies SplitResult)
  }
})
