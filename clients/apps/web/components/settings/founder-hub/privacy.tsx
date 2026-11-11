'use client'

import { SettingsPageTitle } from './page-title'
import { SettingSwitchRow } from './setting-row'
import { useConfigValue } from './settings-context'
import { useSelectedDevice, useNativeSettingsAction } from './device-context'
import { BooleanSetting } from './general/app'

/** OS authentication is performed on the selected desktop before its lock preference changes. */
export function SettingsPrivacy() {
  const device = useSelectedDevice()
  const enabled = useConfigValue('lock_app')
  const action = useNativeSettingsAction()
  const available = Boolean(device?.report.lockAvailable)
  return (
    <div className="flex flex-col gap-8">
      <SettingsPageTitle title="Privacy" />
      <section className="flex flex-col gap-4">
        <SettingSwitchRow
          title="Lock app"
          description={
            !available
              ? 'Device authentication is not available on this computer.'
              : device?.report.platform === 'windows'
                ? 'Require Windows Hello face, PIN, or password when opening Shots Founder Hub.'
                : 'Require Touch ID or your password when opening Shots Founder Hub.'
          }
          checked={enabled && available}
          disabled={!available || action.isPending}
          onChange={(next) => action.run({ kind: 'set-lock', argument: next ? 'true' : 'false' })}
        />
        <BooleanSetting
          name="telemetry_consent"
          title="Share usage data"
          description="Help improve Shots Founder Hub with anonymous usage data."
        />
        <BooleanSetting
          name="crash_reporting_consent"
          title="Error"
          description="Send sanitized crash and error reports to help improve Shots Founder Hub."
        />
        {action.error && (
          <p role="alert" className="text-destructive text-xs">
            {action.error}
          </p>
        )}
      </section>
    </div>
  )
}
