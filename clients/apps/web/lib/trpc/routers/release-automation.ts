import 'server-only'

import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { BackendSDKError } from 'screenshot-studio-backend-sdk'
import {
  automationDefinitionSchema,
  automationHistoryItemSchema,
  automationIdentitySchema,
  automationOverviewSchema,
  automationPreviewInputSchema,
  automationPreviewSchema,
  automationRevisionSchema,
  automationRunDetailSchema,
  automationSaveSchema,
} from '@/lib/api/contracts/release-automation'
import {
  automationArchiveSchema,
  automationHistoryFilterSchema,
  automationRunSummarySchema,
  automationSourceModeSchema,
  automationVersionSchema,
} from '@/lib/api/contracts/workflow-runs'
import { backendSDK } from '@/lib/backend/sdk'
import { isDesignRendererAvailable } from '@/lib/design/renderer'
import { designTemplates } from '@/lib/design/templates'
import type { AutomationOverview } from 'screenshot-studio-backend-sdk'
import { router } from '../init'
import { organizationProcedure } from '../procedures'

/**
 * Adds what only the web knows: the design templates a render node can fill,
 * and whether this deployment's renderer is enabled. A worker that can reach
 * the web is not enough when the web has rendering turned off.
 */
function withWebCapabilities(overview: AutomationOverview) {
  const templates = designTemplates
    .filter((template) => template.kind === 'layout' && template.usesCopy)
    .map(({ aspectRatio, id, name }) => ({ aspectRatio, id, name }))
  const actions = isDesignRendererAvailable()
    ? overview.actions
    : overview.actions?.map((action) =>
        action.type === 'render_creatives'
          ? {
              ...action,
              available: false,
              reason: 'The design renderer is off on this deployment (PLATFORM_DESIGN_RENDERER).',
            }
          : action
      )
  return { ...overview, actions, templates }
}

/** Governance is session-admin only; members can read their workspace's history. */
export const releaseAutomationRouter = router({
  overview: organizationProcedure('workspace:read')
    .output(automationOverviewSchema)
    .query(async ({ ctx }) =>
      withWebCapabilities(await backendSDK(ctx.access).releaseAutomationOverview())
    ),
  save: organizationProcedure('workspace:update')
    .input(automationSaveSchema)
    .output(automationDefinitionSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await backendSDK(ctx.access).saveReleaseAutomation(input)
      } catch (error) {
        if (error instanceof BackendSDKError && error.status === 409) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'This workflow was changed elsewhere. Reload to see the latest version.',
          })
        }
        throw error
      }
    }),
  activate: organizationProcedure('workspace:update')
    .input(automationRevisionSchema)
    .output(automationDefinitionSchema)
    .mutation(({ ctx, input }) =>
      backendSDK(ctx.access).activateReleaseAutomation(input.id, input.revision)
    ),
  archive: organizationProcedure('workspace:update')
    .input(automationArchiveSchema)
    .mutation(({ ctx, input }) =>
      backendSDK(ctx.access).archiveReleaseAutomation(input.id, input.revision, input.archived)
    ),
  disable: organizationProcedure('workspace:update')
    .input(automationRevisionSchema)
    .mutation(({ ctx, input }) =>
      backendSDK(ctx.access).disableReleaseAutomation(input.id, input.revision)
    ),
  sourceMode: organizationProcedure('workspace:update')
    .input(automationSourceModeSchema)
    .mutation(({ ctx, input }) =>
      backendSDK(ctx.access).setReleaseAutomationMode(
        input.id,
        input.enabled,
        input.collectUnmatched,
        input.branch
      )
    ),
  preview: organizationProcedure('workspace:update')
    .input(automationPreviewInputSchema)
    .output(automationPreviewSchema)
    .mutation(({ ctx, input }) => backendSDK(ctx.access).previewReleaseAutomation(input)),
  disconnectSource: organizationProcedure('workspace:update')
    .input(automationIdentitySchema)
    .mutation(({ ctx, input }) =>
      backendSDK(ctx.access).disconnectReleaseAutomationSource(input.id)
    ),
  history: organizationProcedure('workspace:read')
    .input(automationHistoryFilterSchema.optional())
    .output(z.object({ items: z.array(automationHistoryItemSchema) }))
    .query(({ ctx, input }) => backendSDK(ctx.access).listReleaseAutomationHistory(input)),
  recentRuns: organizationProcedure('workspace:read')
    .output(z.object({ items: z.array(automationRunSummarySchema).max(6) }))
    .query(({ ctx }) =>
      backendSDK(ctx.access).listReleaseAutomationRunSummaries({ mode: 'automation' }, 6)
    ),
  runSummaries: organizationProcedure('workspace:read')
    .input(automationHistoryFilterSchema.optional())
    .output(z.object({ items: z.array(automationRunSummarySchema) }))
    .query(({ ctx, input }) => backendSDK(ctx.access).listReleaseAutomationRunSummaries(input)),
  versions: organizationProcedure('workspace:read')
    .input(automationIdentitySchema)
    .output(z.object({ items: z.array(automationVersionSchema) }))
    .query(({ ctx, input }) => backendSDK(ctx.access).listReleaseAutomationVersions(input.id)),
  run: organizationProcedure('workspace:read')
    .input(automationIdentitySchema)
    .output(automationRunDetailSchema)
    .query(({ ctx, input }) => backendSDK(ctx.access).getReleaseAutomationRun(input.id)),
  version: organizationProcedure('workspace:read')
    .input(automationIdentitySchema)
    .output(automationVersionSchema)
    .query(({ ctx, input }) => backendSDK(ctx.access).getReleaseAutomationVersion(input.id)),
  cancel: organizationProcedure('workspace:update')
    .input(automationIdentitySchema)
    .mutation(({ ctx, input }) => backendSDK(ctx.access).cancelReleaseAutomationRun(input.id)),
  retry: organizationProcedure('workspace:update')
    .input(automationIdentitySchema)
    .mutation(({ ctx, input }) => backendSDK(ctx.access).retryReleaseAutomationRun(input.id)),
})
