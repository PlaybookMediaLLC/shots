'use client'

import { SettingsPageTitle } from './page-title'
import { WorkspaceDeveloperSettings } from '@/components/workspace/WorkspaceDeveloperSettings'
import { WebhookSettings } from '@/components/settings/WebhookSettings'
import { DeveloperTools } from '@/components/settings/DeveloperTools'

/** Reuse Shots' workspace API key, webhook, and local developer settings. */
export function SettingsDevelopers({ canManage }: { canManage: boolean }) {
  return (
    <div className="flex flex-col gap-8">
      <SettingsPageTitle title="Developer API" />
      <p className="text-muted-foreground text-sm">
        API keys and webhooks are managed by Shots for your workspace.
      </p>
      <WorkspaceDeveloperSettings canManage={canManage} />
      <WebhookSettings canManage={canManage} />
      <DeveloperTools />
    </div>
  )
}
