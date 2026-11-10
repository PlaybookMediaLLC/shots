'use client'

import { SettingsPageTitle } from './page-title'
import { BooleanSetting } from './general/app'
import { useSelectedDevice, useFounderHubDevices } from './device-context'

/** Account-owned sync preference and registered desktop state from Shots. */
export function SettingsSync() {
  const device = useSelectedDevice()
  const devices = useFounderHubDevices()
  return (
    <div className="flex flex-col gap-8">
      <SettingsPageTitle title="Sync" />
      <p className="text-muted-foreground text-sm">
        Shots owns your account settings and connected Founder Hub devices. Local database sync status remains visible in the desktop app.
      </p>
      <BooleanSetting
        name="cloud_sync_enabled"
        title="Enable cloud sync"
        description="Keep supported Founder Hub preferences synchronized through your Shots account."
      />
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">Connected computers</h3>
        {devices.map((item) => (
          <div key={item.deviceId} className="flex items-center justify-between gap-4 rounded-lg border px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{item.name || 'Unnamed computer'}{item.deviceId === device?.deviceId ? ' · This computer' : ''}</p>
              <p className="text-muted-foreground text-xs">{item.report.platform} · Founder Hub {item.report.version}</p>
            </div>
          </div>
        ))}
        {!devices.length && <p className="text-muted-foreground text-sm">Sign in to Founder Hub on a desktop to connect it to Shots.</p>}
      </section>
    </div>
  )
}
