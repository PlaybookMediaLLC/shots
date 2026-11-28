import { getWeeklyGoalProgressContract } from '@/lib/api/contracts/settings-platform'
import { route } from '@/lib/api/route'
import { organizationAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** Current-week publishing progress against the workspace weekly posting goal. */
export const GET = route(getWeeklyGoalProgressContract, {
  auth: organizationAccess('artifact:read'),
  handler: ({ access, query }) => backendSDK(access).getWeeklyGoalProgress(query.weekStart),
})
