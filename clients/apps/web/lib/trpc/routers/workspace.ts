import 'server-only'

import { z } from 'zod'
import {
  cancelWorkspaceDeletion,
  createWorkspace,
  getWeeklyGoalProgress,
  getWorkspace,
  getWorkspaceReadiness,
  inviteWorkspaceMember,
  leaveWorkspace,
  listWorkspaceInvitations,
  listWorkspaceMembers,
  listWorkspaces,
  removeWorkspaceMember,
  requestWorkspaceDeletion,
  resendWorkspaceInvitation,
  revokeWorkspaceInvitation,
  setActiveWorkspace,
  transferWorkspaceOwnership,
  updateWorkspace,
  updateWorkspaceAiSettings,
  updateWorkspaceMemberRole,
  updateWorkspacePublishingSettings,
} from '@/lib/workspace/service'
import {
  workspaceAiSettingsUpdateSchema,
  workspaceCreateSchema,
  workspaceDeleteSchema,
  workspaceInvitationIdSchema,
  workspaceInviteSchema,
  workspaceMemberIdSchema,
  workspacePublishingSettingsUpdateSchema,
  workspaceRoleChangeSchema,
  workspaceTransferOwnershipSchema,
  workspaceUpdateSchema,
} from '@/lib/workspace/schemas'
import { weekStartSchema } from '@/lib/api/contracts/settings-platform'
import { router } from '../init'
import {
  organizationProcedure,
  sensitiveOrganizationProcedure,
  sessionProcedure,
} from '../procedures'

const organizationIdSchema = z.object({ organizationId: z.string().min(1).max(128) })

export const workspaceRouter = router({
  cancelDeletion: sessionProcedure.mutation(async ({ ctx }) =>
    cancelWorkspaceDeletion(ctx.sessionAccess)
  ),
  create: sessionProcedure
    .input(workspaceCreateSchema)
    .mutation(async ({ ctx, input }) => createWorkspace(ctx.sessionAccess, input)),
  get: organizationProcedure('workspace:read').query(async ({ ctx }) => ({
    workspace: await getWorkspace(ctx.access),
  })),
  invite: organizationProcedure('member:invite')
    .input(workspaceInviteSchema)
    .mutation(async ({ ctx, input }) => inviteWorkspaceMember(ctx.access, input)),
  leave: organizationProcedure('member:read').mutation(async ({ ctx }) =>
    leaveWorkspace(ctx.access)
  ),
  listInvitations: organizationProcedure('invitation:read').query(async ({ ctx }) => ({
    invitations: await listWorkspaceInvitations(ctx.access),
  })),
  listMembers: organizationProcedure('member:read').query(async ({ ctx }) => ({
    members: await listWorkspaceMembers(ctx.access),
  })),
  listMine: sessionProcedure.query(async ({ ctx }) => ({
    workspaces: await listWorkspaces(ctx.sessionAccess),
  })),
  removeMember: organizationProcedure('member:remove')
    .input(workspaceMemberIdSchema)
    .mutation(async ({ ctx, input }) => removeWorkspaceMember(ctx.access, input.memberId)),
  requestDeletion: sensitiveOrganizationProcedure('workspace:delete')
    .input(workspaceDeleteSchema)
    .mutation(async ({ ctx, input }) => requestWorkspaceDeletion(ctx.access, input.confirmation)),
  resendInvitation: organizationProcedure('member:invite')
    .input(workspaceInvitationIdSchema)
    .mutation(async ({ ctx, input }) => resendWorkspaceInvitation(ctx.access, input.invitationId)),
  revokeInvitation: organizationProcedure('invitation:revoke')
    .input(workspaceInvitationIdSchema)
    .mutation(async ({ ctx, input }) => revokeWorkspaceInvitation(ctx.access, input.invitationId)),
  setActive: sessionProcedure.input(organizationIdSchema).mutation(async ({ ctx, input }) => {
    await setActiveWorkspace(ctx.sessionAccess, input.organizationId)
  }),
  transferOwnership: sensitiveOrganizationProcedure('workspace:transfer_ownership')
    .input(workspaceTransferOwnershipSchema)
    .mutation(async ({ ctx, input }) => transferWorkspaceOwnership(ctx.access, input.memberId)),
  readiness: organizationProcedure('workspace:read').query(async ({ ctx }) =>
    getWorkspaceReadiness(ctx.access)
  ),
  update: organizationProcedure('workspace:update')
    .input(workspaceUpdateSchema)
    .mutation(async ({ ctx, input }) => updateWorkspace(ctx.access, input)),
  updateAiSettings: organizationProcedure('workspace:update')
    .input(workspaceAiSettingsUpdateSchema)
    .mutation(async ({ ctx, input }) => updateWorkspaceAiSettings(ctx.access, input)),
  updatePublishingSettings: organizationProcedure('workspace:update')
    .input(workspacePublishingSettingsUpdateSchema)
    .mutation(async ({ ctx, input }) => updateWorkspacePublishingSettings(ctx.access, input)),
  weeklyGoalProgress: organizationProcedure('artifact:read')
    .input(z.object({ weekStart: weekStartSchema.optional() }).optional())
    .query(async ({ ctx, input }) => getWeeklyGoalProgress(ctx.access, input?.weekStart)),
  updateMemberRole: organizationProcedure('member:update_role')
    .input(workspaceRoleChangeSchema)
    .mutation(async ({ ctx, input }) =>
      updateWorkspaceMemberRole(ctx.access, input.memberId, input.role)
    ),
})
