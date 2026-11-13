import { trackEvent } from '@/lib/analytics'
import { POST_MANAGEMENT_USED } from '@/lib/analytics-scrub'

// The post-management outcome metric
// (docs/scheduling/post-bridge/post-management/implementation.md): one PostHog
// event per use, carrying the workspace and the feature only.

/** What was used: an account or date filter in the library, or a new calendar note. */
type PostManagementFeature = 'library_filter' | 'calendar_note'

/** Record one use. Browser only, and only after analytics consent; a no-op elsewhere. */
export function trackPostManagementUse(
  workspaceId: string | null | undefined,
  feature: PostManagementFeature
): void {
  if (workspaceId) trackEvent(POST_MANAGEMENT_USED, { feature, workspace_id: workspaceId })
}
