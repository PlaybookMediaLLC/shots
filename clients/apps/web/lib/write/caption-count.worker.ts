import { captionsOverLimit } from './screenshot-post'

/** One count: the screenshot sheet's caption, its platforms and the editor's copy. */
export type CaptionCountRequest = Parameters<typeof captionsOverLimit>[0]

// The screenshot sheet counts here, off the page that is typing: X's link scan
// (twitter-text) is quadratic in a run without spaces, about a second for
// 10,000 CJK characters with a '.' in them.
addEventListener('message', ({ data }: MessageEvent<CaptionCountRequest>) => {
  postMessage(captionsOverLimit(data))
})
