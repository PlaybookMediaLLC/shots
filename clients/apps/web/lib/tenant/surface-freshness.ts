import { z } from 'zod'

/** How current a product page's screenshot is: `never` until its first capture. */
export const surfaceFreshnessSchema = z.enum(['fresh', 'stale', 'never'])

/** How current a product page's screenshot is. */
export type SurfaceFreshness = z.infer<typeof surfaceFreshnessSchema>

/** A capture older than this is stale (RFC 018). */
export const SURFACE_FRESH_DAYS = 30

const DAY_MS = 86_400_000

/** Fresh within 30 days of the last capture, stale after, never without one. */
export function surfaceFreshness(
  lastCapturedAt: Date | string | null,
  now: Date = new Date()
): SurfaceFreshness {
  if (!lastCapturedAt) return 'never'
  const age = now.getTime() - new Date(lastCapturedAt).getTime()
  return age < SURFACE_FRESH_DAYS * DAY_MS ? 'fresh' : 'stale'
}

const CAPTURE_FAILURES: Record<string, string> = {
  asset_unavailable: 'The screenshot was taken but could not be stored.',
  capture_failed: 'The page could not be captured.',
  capture_requires_auth: 'The page needs a login. Set up signed-in capture for it in Automate.',
  capture_selector_missing: 'The page changed; the part to capture was not found.',
  capture_timeout: 'The page took too long to load.',
  surface_host_rejected: 'The URL is no longer on a registered product host.',
  surface_unreachable: 'The page could not be reached.',
  // Signed-in capture, from the browser, the job and the connection.
  needs_auth: 'The session ended, or the app asked to sign in. Reconnect to continue.',
  wrong_account: 'The app is signed in as a different account than this connection expects.',
  waiting_for_deployment: 'The app kept reporting another commit, so nothing was captured.',
  deployment_unverified: 'The app did not report its deployed commit, so nothing was captured.',
  marker_missing: 'The element that proves this screen never appeared.',
  forbidden_view: 'The page showed a view this recipe forbids, such as an error or loading state.',
  mask_missing: 'A private element to hide was not found, so nothing was captured.',
  origin_refused: 'The app sent the browser to a host that is not approved.',
  recipe_invalid: 'This recipe or its connection is no longer valid. Save a new version.',
  image_invalid: 'The screenshot came back empty or at the wrong size.',
  page_failed: 'The page failed to load.',
  provider_unavailable: 'The browser provider is unavailable. Try again shortly.',
  navigation_unavailable:
    'AI navigation is unavailable or timed out. Check the AI provider and retry.',
  navigation_invalid: 'The AI returned an invalid navigation choice. No screenshot was accepted.',
  navigation_failed:
    'The AI could not verify the requested feature. Clarify the objective and test again.',
  navigation_limit:
    'Navigation reached its action limit or repeated a step. Clarify the objective and test again.',
  navigation_budget:
    'AI navigation exhausted its credit budget or the workspace allowance. Check the budget and retry.',
  navigation_retry_limit:
    'AI capture stopped after three attempts. Check the earlier failure and retry when it is resolved.',
  connection_missing: 'The connection for this recipe no longer exists.',
  connection_revoked: 'The connection was revoked, so this capture stopped.',
  connect_expired: 'The sign-in window expired before it finished. Start the sign-in again.',
  stale_authorization: 'The connection changed while this was running. Run the capture again.',
  deadline_exceeded: 'The capture ran out of time.',
  cancelled: 'The capture was cancelled.',
  source_inactive: 'The repository is no longer connected.',
  recipe_archived: 'This recipe version was archived.',
  recipe_missing: 'This recipe version no longer exists.',
  surface_missing: 'The product page for this recipe was deleted.',
  deployment_missing: 'The deployment for this capture was not found.',
  workspace_unavailable: 'The workspace is not available right now.',
}

/** A last-capture failure code as a sentence; unknown codes still read. */
export function captureFailureMessage(code: string): string {
  return Object.hasOwn(CAPTURE_FAILURES, code)
    ? CAPTURE_FAILURES[code]!
    : `The last capture failed (${code.replaceAll('_', ' ')}).`
}
