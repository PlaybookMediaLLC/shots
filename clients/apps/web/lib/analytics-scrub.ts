/**
 * Removes capability tokens from URLs before analytics leave the browser.
 * Share links (/s/<token>), review links (/review/<token>), invitations and
 * reset links carry secrets in their path or query.
 */

/**
 * The post-management use event (`lib/plan/feature-use.ts`). It loses its URL
 * queries and fragments, where the library keeps filter values.
 */
export const POST_MANAGEMENT_USED = 'post_management_used'

const TOKEN_PATH = /\/(s|review)\/[^/?#]+/g
const SECRET_PARAMS = ['token', 'invitationId', 'callbackURL']

/** Returns the string with share/review tokens and secret query values redacted. */
export function scrubUrl(value: string): string {
  let scrubbed = value.replace(TOKEN_PATH, '/$1/[redacted]')
  for (const param of SECRET_PARAMS) {
    scrubbed = scrubbed.replace(new RegExp(`([?&]${param}=)[^&#]*`, 'g'), '$1[redacted]')
  }
  return scrubbed
}

/** Scrubs every string property of an analytics event in place and returns it. */
export function scrubEvent<
  T extends {
    event?: string
    properties?: Record<string, unknown>
    $set?: Record<string, unknown>
  } | null,
>(event: T): T {
  const bare = event?.event === POST_MANAGEMENT_USED
  for (const bag of [event?.properties, event?.$set]) {
    if (!bag) continue
    for (const [key, value] of Object.entries(bag)) {
      if (typeof value === 'string') bag[key] = scrubUrl(bare ? value.split(/[?#]/)[0]! : value)
    }
  }
  return event
}
