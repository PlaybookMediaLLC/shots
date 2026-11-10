'use client'

import { Button } from '@/components/ui/button'
import { SettingsPageTitle } from './page-title'
import { useNativeSettingsAction, useSelectedDevice } from './device-context'

/** Opens the existing native import flow, which owns local files and provider imports. */
export function SettingsImports() {
  const device = useSelectedDevice()
  const action = useNativeSettingsAction()

  return (
    <div className="flex flex-col gap-6">
      <SettingsPageTitle title="Imports" />
      <p className="text-muted-foreground text-sm">
        Import local meeting files or connect a supported provider on your desktop.
      </p>
      <Button
        className="w-fit"
        disabled={!device?.report.supportsSettingsNavigation || action.isPending}
        onClick={() => action.run({ kind: 'open-settings-page', argument: 'imports' })}
      >
        {action.isPending ? 'Opening imports…' : 'Open imports on desktop'}
      </Button>
      {action.error && (
        <p role="alert" className="text-sm text-destructive">
          {action.error}
        </p>
      )}
    </div>
  )
}
