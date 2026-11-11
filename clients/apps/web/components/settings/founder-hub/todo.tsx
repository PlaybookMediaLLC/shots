'use client'

import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { SettingsPageTitle } from './page-title'
import { SettingRow } from './setting-row'
import { useConfigValue, useSetSettingValue } from './settings-context'
import { useNativeSettingsAction, useSelectedDevice } from './device-context'

/** Ticket providers use the same repository filter and native permission as the desktop. */
export function SettingsTodo() {
  const repository = useConfigValue('todo_github_repository')
  const saveRepository = useSetSettingValue('todo_github_repository')
  const device = useSelectedDevice()
  const action = useNativeSettingsAction()
  const reminders = device?.report.permissions.reminders
  return (
    <div className="flex flex-col gap-8">
      <SettingsPageTitle title="Ticket" />
      <section className="flex flex-col gap-4">
        <h3 className="text-sm font-medium">GitHub</h3>
        <SettingRow title="Repository" description="Limit GitHub issues to owner/repository, or leave blank to search all accessible repositories.">
          {(labels) => (
            <Input {...labels} value={repository ?? ''} placeholder="owner/repository" onChange={(event) => void saveRepository(event.target.value)} className="bg-card h-9 shadow-none" />
          )}
        </SettingRow>
      </section>
      <section className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium">Apple Reminders</h3>
          <p className="text-muted-foreground text-xs">
            {device?.report.platform === 'macos'
              ? `Permission status: ${reminders ?? 'unknown'}.`
              : 'Apple Reminders is available on macOS.'}
          </p>
        </div>
        {device?.report.platform === 'macos' && (
          <Button
            variant="outline"
            size="sm"
            disabled={action.isPending || reminders === 'authorized'}
            onClick={() => action.run({ kind: reminders === 'denied' ? 'open-permission' : 'request-permission', argument: 'reminders' })}
          >
            {reminders === 'denied' ? 'Open settings' : 'Allow Reminders'}
          </Button>
        )}
      </section>
      {action.error && <p role="alert" className="text-destructive text-xs">{action.error}</p>}
    </div>
  )
}
