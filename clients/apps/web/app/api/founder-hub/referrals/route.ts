import { getFounderHubReferralsContract } from '@/lib/api/contracts/founder-hub'
import { route } from '@/lib/api/route'
import { requireFounderHubSettingsAccess } from '@/lib/auth/founder-hub'
import { backendSDK } from '@/lib/backend/sdk'

/** Read referral status for the authenticated account. */
export const GET = route(getFounderHubReferralsContract, {
  auth: async ({ request }) => requireFounderHubSettingsAccess(request.headers),
  handler: async ({ access }) =>
    backendSDK({ ...access, organizationId: '' }).getFounderHubReferralSummary(),
})
