import 'server-only'

export class ScheduledPostError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409
  ) {
    super(message)
    this.name = 'ScheduledPostError'
  }
}

/**
 * The caller's key, or empty: the backend then names the request by its
 * content, so a retry without a key replays instead of posting twice.
 */
export function getScheduledPostIdempotencyKey(requestId: string | null): string {
  return requestId?.slice(0, 128) ?? ''
}
