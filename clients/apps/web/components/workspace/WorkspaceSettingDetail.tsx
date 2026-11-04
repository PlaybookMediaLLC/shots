import { type ReactNode } from 'react'
import { ApprovalSetting } from '@/components/drafts/ApprovalSetting'
import { AccountSettings } from '@/components/settings/AccountSettings'
import { AppearanceSettings } from '@/components/settings/AppearanceSettings'
import { DeveloperTools } from '@/components/settings/DeveloperTools'
import { ExperimentalSettings } from '@/components/settings/ExperimentalSettings'
import { InstallSettings } from '@/components/settings/InstallSettings'
import { IntegrationCatalog } from '@/components/settings/IntegrationCatalog'
import { NewTeamSettings } from '@/components/settings/NewTeamSettings'
import { SocialSetList } from '@/components/settings/social-sets/SocialSetList'
import { SocialSetSettings } from '@/components/settings/social-sets/SocialSetSettings'
import { WebhookSettings } from '@/components/settings/WebhookSettings'
import { ChannelConnections } from './ChannelConnections'
import { WorkspaceAgentSettings } from './WorkspaceAgentSettings'
import { WorkspaceAuditSettings } from './WorkspaceAuditSettings'
import { WorkspaceBilling } from './WorkspaceBilling'
import { WorkspaceBrandSettings } from './WorkspaceBrandSettings'
import { WorkspaceDeveloperSettings } from './WorkspaceDeveloperSettings'
import { WorkspaceGeneralSettings } from './WorkspaceGeneralSettings'
import { WorkspaceIdentitySettings } from './WorkspaceIdentitySettings'
import { WorkspaceIntegrations } from './WorkspaceIntegrations'
import { WorkspaceNotifications } from './WorkspaceNotifications'
import { WorkspaceMembersSettings } from './WorkspaceMembersSettings'
import { WorkspaceIdealCustomerProfile } from './WorkspaceIdealCustomerProfile'
import { WorkspaceProductProfile } from './WorkspaceProductProfile'
import { WorkspaceProductSurfaces } from './WorkspaceProductSurfaces'
import { WorkspaceRolesSettings } from './WorkspaceRolesSettings'
import { WorkspaceSecuritySettings } from './WorkspaceSecuritySettings'
import { WorkspaceSharedLinks } from './WorkspaceSharedLinks'
import { WorkspaceWhitelabelSettings } from './WorkspaceWhitelabelSettings'
import { hasPermission, type Permission } from '@/lib/auth/permissions'
import type { WorkspaceSettingsProps } from './WorkspaceSettings'
import type { SettingId } from './settings-sections'

/** What each section's content reads: the person, the workspace, and what their role may do. */
type SettingsContext = Omit<WorkspaceSettingsProps, 'section'> & {
  can: (permission: Permission) => boolean
}

/**
 * The body of every section, in registry order. `satisfies` makes TypeScript
 * ask for content when a section is added, and only the open section renders.
 */
const SETTINGS_CONTENT = {
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
  'social-sets': ({ can, draftsEnabled, socialSet }) =>
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
        {draftsEnabled ? <ApprovalSetting canManage={can('publish:manage')} /> : null}
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
  whitelabel: ({ can, organization }) => (
    <WorkspaceWhitelabelSettings
      canManage={can('brand:manage')}
      organizationId={organization.id}
    />
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
    can: (permission) => hasPermission(props.role, permission),
  })
}
