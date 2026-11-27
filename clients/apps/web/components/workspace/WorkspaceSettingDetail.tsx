import dynamic from 'next/dynamic'
import { type ReactNode } from 'react'
import { accessAllows, type Permission } from '@/lib/auth/permissions'
import type { WorkspaceSettingsProps } from './WorkspaceSettings'
import type { SettingId } from './settings-sections'

const ApprovalSetting = dynamic(() =>
  import('@/components/drafts/ApprovalSetting').then((m) => m.ApprovalSetting)
)
const AccountSettings = dynamic(() =>
  import('@/components/settings/AccountSettings').then((m) => m.AccountSettings)
)
const AppearanceSettings = dynamic(() =>
  import('@/components/settings/AppearanceSettings').then((m) => m.AppearanceSettings)
)
const DeveloperTools = dynamic(() =>
  import('@/components/settings/DeveloperTools').then((m) => m.DeveloperTools)
)
const ExperimentalSettings = dynamic(() =>
  import('@/components/settings/ExperimentalSettings').then((m) => m.ExperimentalSettings)
)
const FounderHubSettings = dynamic(() =>
  import('@/components/settings/FounderHubSettings').then((m) => m.FounderHubSettings)
)
const InstallSettings = dynamic(() =>
  import('@/components/settings/InstallSettings').then((m) => m.InstallSettings)
)
const IntegrationCatalog = dynamic(() =>
  import('@/components/settings/IntegrationCatalog').then((m) => m.IntegrationCatalog)
)
const NewTeamSettings = dynamic(() =>
  import('@/components/settings/NewTeamSettings').then((m) => m.NewTeamSettings)
)
const SocialSetList = dynamic(() =>
  import('@/components/settings/social-sets/SocialSetList').then((m) => m.SocialSetList)
)
const SocialSetSettings = dynamic(() =>
  import('@/components/settings/social-sets/SocialSetSettings').then((m) => m.SocialSetSettings)
)
const WebhookSettings = dynamic(() =>
  import('@/components/settings/WebhookSettings').then((m) => m.WebhookSettings)
)
const VoiceSettings = dynamic(() =>
  import('@/components/voice/VoiceSettings').then((m) => m.VoiceSettings)
)
const ChannelConnections = dynamic(() =>
  import('./ChannelConnections').then((m) => m.ChannelConnections)
)
const WorkspaceAgentSettings = dynamic(() =>
  import('./WorkspaceAgentSettings').then((m) => m.WorkspaceAgentSettings)
)
const WorkspaceAuditSettings = dynamic(() =>
  import('./WorkspaceAuditSettings').then((m) => m.WorkspaceAuditSettings)
)
const WorkspaceBilling = dynamic(() =>
  import('./WorkspaceBilling').then((m) => m.WorkspaceBilling)
)
const WorkspaceBrandSettings = dynamic(() =>
  import('./WorkspaceBrandSettings').then((m) => m.WorkspaceBrandSettings)
)
const WorkspaceDeveloperSettings = dynamic(() =>
  import('./WorkspaceDeveloperSettings').then((m) => m.WorkspaceDeveloperSettings)
)
const WorkspaceGeneralSettings = dynamic(() =>
  import('./WorkspaceGeneralSettings').then((m) => m.WorkspaceGeneralSettings)
)
const WorkspaceIdentitySettings = dynamic(() =>
  import('./WorkspaceIdentitySettings').then((m) => m.WorkspaceIdentitySettings)
)
const WorkspaceIntegrations = dynamic(() =>
  import('./WorkspaceIntegrations').then((m) => m.WorkspaceIntegrations)
)
const WorkspaceNotifications = dynamic(() =>
  import('./WorkspaceNotifications').then((m) => m.WorkspaceNotifications)
)
const WorkspaceMembersSettings = dynamic(() =>
  import('./WorkspaceMembersSettings').then((m) => m.WorkspaceMembersSettings)
)
const WorkspaceIdealCustomerProfile = dynamic(() =>
  import('./WorkspaceIdealCustomerProfile').then((m) => m.WorkspaceIdealCustomerProfile)
)
const WorkspacePermissionGroupsSettings = dynamic(() =>
  import('./WorkspacePermissionGroupsSettings').then((m) => m.WorkspacePermissionGroupsSettings)
)
const WorkspaceProductProfile = dynamic(() =>
  import('./WorkspaceProductProfile').then((m) => m.WorkspaceProductProfile)
)
const WorkspaceProductSurfaces = dynamic(() =>
  import('./WorkspaceProductSurfaces').then((m) => m.WorkspaceProductSurfaces)
)
const WorkspaceRolesSettings = dynamic(() =>
  import('./WorkspaceRolesSettings').then((m) => m.WorkspaceRolesSettings)
)
const WorkspaceSecuritySettings = dynamic(() =>
  import('./WorkspaceSecuritySettings').then((m) => m.WorkspaceSecuritySettings)
)
const WorkspaceSharedLinks = dynamic(() =>
  import('./WorkspaceSharedLinks').then((m) => m.WorkspaceSharedLinks)
)
const WorkspaceWhitelabelSettings = dynamic(() =>
  import('./WorkspaceWhitelabelSettings').then((m) => m.WorkspaceWhitelabelSettings)
)

/** What each section's content reads: the person, the workspace, and what their role may do. */
type SettingsContext = Omit<WorkspaceSettingsProps, 'section'> & {
  can: (permission: Permission) => boolean
}

/**
 * The body of every section, in registry order. `satisfies` makes TypeScript
 * ask for content when a section is added, and only the open section renders.
 */
const SETTINGS_CONTENT = {
  'founder-hub': ({ userId, founderHubPage, can }) => (
    <FounderHubSettings
      userId={userId}
      page={founderHubPage}
      canManageDeveloper={can('workspace:update')}
      canManageBilling={can('billing:manage')}
      key={userId}
    />
  ),
  profile: ({ email, name }) => <AccountSettings email={email} name={name} />,
  notifications: () => <WorkspaceNotifications />,
  appearance: () => <AppearanceSettings />,
  security: ({ twoFactorEnabled }) => (
    <WorkspaceSecuritySettings twoFactorEnabled={twoFactorEnabled} />
  ),
  install: () => <InstallSettings />,
  general: ({ can, organization, userId }) => (
    <WorkspaceGeneralSettings
      canDelete={can('workspace:delete')}
      canManage={can('workspace:update')}
      organization={organization}
      userId={userId}
      key={`${userId}:${organization.id}`}
    />
  ),
  billing: ({ can }) => <WorkspaceBilling canManage={can('billing:manage')} />,
  members: ({ can, userId }) => (
    <WorkspaceMembersSettings
      canInvite={can('member:invite')}
      canManageMembers={can('member:update_role')}
      canRead={can('member:read')}
      canTransferOwnership={can('workspace:transfer_ownership')}
      currentUserId={userId}
    />
  ),
  roles: () => <WorkspaceRolesSettings />,
  voice: () => <VoiceSettings />,
  'new-team': ({ email, userId }) => <NewTeamSettings email={email} userId={userId} />,
  brand: ({ can }) => <WorkspaceBrandSettings canManage={can('workspace:update')} />,
  product: ({ can }) => (
    <>
      <WorkspaceProductProfile canManage={can('brand:manage')} />
      <WorkspaceIdealCustomerProfile canManage={can('brand:manage')} />
    </>
  ),
  surfaces: ({ can }) => <WorkspaceProductSurfaces canManage={can('brand:manage')} />,
  sharing: ({ can }) => <WorkspaceSharedLinks canEdit={can('artifact:edit')} />,
  'social-sets': ({ can, draftsEnabled, role, socialSet }) =>
    socialSet ? (
      <SocialSetSettings
        id={socialSet.id}
        key={`${socialSet.id}:${socialSet.page}`}
        page={socialSet.page}
        permissions={{
          canManage: can('workspace:update'),
          canWrite: can('artifact:edit'),
          isAdmin: can('workspace:update'),
        }}
      />
    ) : (
      <>
        <SocialSetList canManage={can('workspace:update')} />
        {draftsEnabled ? (
          // The backend lets only an owner or admin change approvals.
          <ApprovalSetting
            canManage={can('publish:manage') && (role === 'owner' || role === 'admin')}
          />
        ) : null}
      </>
    ),
  channels: ({ can }) => <ChannelConnections canManage={can('connection:manage')} />,
  integrations: ({ can }) => (
    <>
      <IntegrationCatalog canManage={can('workspace:update')} />
      <WorkspaceIntegrations canManage={can('workspace:update')} />
    </>
  ),
  agents: ({ can, mcpUrl }) => (
    <WorkspaceAgentSettings canManage={can('brand:manage')} mcpUrl={mcpUrl} />
  ),
  sso: ({ can, organization, role }) => (
    <WorkspaceIdentitySettings
      canManage={can('workspace:update')}
      isOwner={role === 'owner'}
      organizationId={organization.id}
    />
  ),
  'permission-groups': ({ can, organization }) => (
    <WorkspacePermissionGroupsSettings
      canManage={can('member:update_role')}
      organizationId={organization.id}
    />
  ),
  whitelabel: ({ can, organization }) => (
    <WorkspaceWhitelabelSettings canManage={can('brand:manage')} organizationId={organization.id} />
  ),
  audit: ({ can, organization }) => (
    <WorkspaceAuditSettings
      canManage={can('workspace:update')}
      canRead={can('workspace:update')}
      organizationId={organization.id}
    />
  ),
  api: ({ can }) => (
    <>
      <WorkspaceDeveloperSettings canManage={can('workspace:update')} />
      <WebhookSettings canManage={can('workspace:update')} />
      <DeveloperTools />
    </>
  ),
  experimental: ({ can }) => <ExperimentalSettings canManage={can('workspace:update')} />,
} satisfies Record<SettingId, (context: SettingsContext) => ReactNode>

/** The body of one settings section. */
export function WorkspaceSettingContent({ section, ...props }: WorkspaceSettingsProps) {
  return SETTINGS_CONTENT[section]({
    ...props,
    can: (permission) => accessAllows(props, permission),
  })
}
