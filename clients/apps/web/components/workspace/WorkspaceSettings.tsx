import { ReturnToWork } from '@/components/platform-hub/ReturnToWork'
import { Page } from '@/components/platform-ui'
import { WorkspaceDeletionRecovery } from './WorkspaceDeletionSettings'
import { WorkspaceSettingContent } from './WorkspaceSettingDetail'
import { SETTINGS_SECTIONS, type SettingId, type SocialSetPage } from './settings-sections'
import type { FounderHubPage } from '@/components/settings/founder-hub/pages'

export type WorkspaceSettingsProps = {
  /** What the member's permission group subtracts from `role`. */
  deniedPermissions: readonly string[]
  /** Content drafts are rolled out (PLATFORM_CONTENT_DRAFTS), so Profiles shows the approval switch. */
  draftsEnabled: boolean
  email: string
  /** The public MCP server URL, shown under AI agents. */
  mcpUrl: string
  name: string
  organization: {
    id: string
    logo: string | null
    name: string
    slug: string
    workspaceDeletion?: { requestedByUserId: string; scheduledFor: Date; status: string } | null
    workspaceSettings?: {
      aiAgentEnabled: boolean
      defaultPublishTime: string
      description: string | null
      locale: string
      timeZone: string
    } | null
  }
  role: string
  section: SettingId
  founderHubPage?: FounderHubPage
  /** The social set and page, for a social set's own settings. */
  socialSet?: { id: string; page: SocialSetPage }
  twoFactorEnabled: boolean
  userId: string
}

/**
 * One settings section, after Polar: the sidebar lists the sections, and the
 * page is titled for the open one, so the address always says where you are.
 */
export function WorkspaceSettings(props: WorkspaceSettingsProps) {
  const { organization, section, userId } = props
  if (
    organization.workspaceDeletion?.status === 'PENDING' ||
    organization.workspaceDeletion?.status === 'PROCESSING'
  ) {
    return (
      <main className="text-foreground">
        <WorkspaceDeletionRecovery
          canRestore={organization.workspaceDeletion.requestedByUserId === userId}
          scheduledFor={organization.workspaceDeletion.scheduledFor}
        />
      </main>
    )
  }

  const current = SETTINGS_SECTIONS.find((item) => item.id === section) ?? SETTINGS_SECTIONS[0]!
  if (section === 'founder-hub') return <WorkspaceSettingContent {...props} />
  return (
    <Page description={current.description} title={current.title}>
      <ReturnToWork />
      <WorkspaceSettingContent {...props} />
    </Page>
  )
}
