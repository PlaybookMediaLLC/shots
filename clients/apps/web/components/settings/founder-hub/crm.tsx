'use client'

import { IntegrationCatalog } from '@/components/settings/IntegrationCatalog'
import { WorkspaceIntegrations } from '@/components/workspace/WorkspaceIntegrations'
import { SettingsPageTitle } from './page-title'

/** CRM and other external connections are managed by the Shots integration services. */
export function SettingsCRM({ canManage }: { canManage: boolean }) {
  return (
    <div className="flex flex-col gap-8">
      <SettingsPageTitle title="CRM & integrations" />
      <p className="text-muted-foreground text-sm">
        Connect and manage the services available to your Shots workspace. Founder Hub uses these same Shots-owned connections.
      </p>
      <IntegrationCatalog canManage={canManage} />
      <WorkspaceIntegrations canManage={canManage} />
    </div>
  )
}
