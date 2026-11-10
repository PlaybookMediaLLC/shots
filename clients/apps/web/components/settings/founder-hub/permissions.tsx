'use client'

import { ArrowRight, Check, WarningCircle } from '@phosphor-icons/react'
import type { z } from 'zod'
import type { founderHubDeviceReportSchema } from 'screenshot-studio-backend-sdk'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { SettingsPageTitle } from './page-title'
import { useSelectedDevice, useNativeSettingsAction } from './device-context'

/** Permission state and actions refer to the selected desktop, never the browser. */
export function SettingsPermissions() {
  const device = useSelectedDevice()
  return (
    <div className="flex flex-col gap-8">
      <SettingsPageTitle title="Permissions" />
      <section className="flex flex-col gap-4">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Audio
        </h3>
        <PermissionRow
          permission="microphone"
          title="Microphone"
          description="Record your voice in meetings and calls."
        />
        <PermissionRow
          permission="systemAudio"
          title="System audio"
          description="Record other participants in meetings."
        />
      </section>
      {device?.report.platform === 'macos' && (
        <>
          <PermissionRow
            permission="accessibility"
            title="Accessibility"
            description="Read meeting controls and visible chat."
          />
          <section className="flex flex-col gap-4">
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Others
            </h3>
            <PermissionRow
              permission="calendar"
              title="Calendar"
              description="Show Apple Calendar events in Shots Founder Hub."
            />
          </section>
        </>
      )}
    </div>
  )
}

function PermissionRow({
  permission,
  title,
  description,
}: {
  permission: keyof z.infer<typeof founderHubDeviceReportSchema>['permissions']
  title: string
  description: string
}) {
  const device = useSelectedDevice()
  const action = useNativeSettingsAction()
  const status = device?.report.permissions[permission]
  const authorized = status === 'authorized'
  const runtime = device?.report.platform !== 'macos'
  const openSettings =
    !runtime && (authorized || status === 'denied' || permission === 'accessibility')
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex-1">
        <div
          className={cn(
            'mb-1 flex items-center gap-2',
            device && !authorized && 'text-destructive'
          )}
        >
          {device && !authorized && <WarningCircle className="size-4" />}
          <h3 className="text-sm font-medium">{title}</h3>
        </div>
        <p className="text-xs text-muted-foreground">{description}</p>
        {action.error && (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {action.error}
          </p>
        )}
      </div>
      <Button
        variant={authorized ? 'ghost' : 'default'}
        size="icon"
        className={cn('size-8', authorized && 'text-emerald-600')}
        disabled={!device || action.isPending || (runtime && authorized)}
        aria-label={
          openSettings
            ? `Open ${title.toLowerCase()} settings`
            : `Request ${title.toLowerCase()} permission`
        }
        onClick={() =>
          action.run({
            kind: openSettings ? 'open-permission' : 'request-permission',
            argument: permission,
          })
        }
      >
        {authorized ? <Check className="size-4" /> : <ArrowRight className="size-5" />}
      </Button>
    </div>
  )
}
