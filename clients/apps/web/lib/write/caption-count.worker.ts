import { type CaptionOverLimit, captionsOverLimit } from './screenshot-post'

/** One count of the screenshot sheet's captions, numbered so its answer can be matched to it. */
export type CaptionCountRequest = Parameters<typeof captionsOverLimit>[0] & { id: number }

/** The captions over their limit, for request `id`. */
export type CaptionCountResult = { id: number; overLimit: CaptionOverLimit[] }

/** What the worker posts: that it has loaded, then one result per request. */
export type CaptionCountMessage = CaptionCountResult | { ready: true }

// X's link scan (twitter-text) is quadratic in a run without spaces, about a
// second for 10,000 CJK characters with a '.', so the sheet counts here.
self.onmessage = ({ data }: MessageEvent<CaptionCountRequest>) => {
  self.postMessage({ id: data.id, overLimit: captionsOverLimit(data) } satisfies CaptionCountResult)
}
self.postMessage({ ready: true } satisfies CaptionCountMessage)
