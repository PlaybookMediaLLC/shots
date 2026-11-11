'use client'

import { Input } from '@/components/ui/input'
import { SettingsPageTitle } from './page-title'
import { SettingRow } from './setting-row'
import { BooleanSetting } from './general/app'
import { useConfigValue, useSetSettingValue } from './settings-context'
import { useSelectedDevice } from './device-context'

/** Dictation preferences synced to the selected desktop and stored by Shots. */
export function SettingsDictation() {
  const device = useSelectedDevice()
  const shortcut = useConfigValue('dictation_shortcut')
  const saveShortcut = useSetSettingValue('dictation_shortcut')
  return (
    <div className="flex flex-col gap-8">
      <SettingsPageTitle title="Dictation" />
      <p className="text-muted-foreground text-sm">
        Speak into the focused text field in your apps. Shots Founder Hub inserts the transcript when you finish.
      </p>
      <div className="flex flex-col gap-6">
        <BooleanSetting
          name="dictation_enabled"
          title="Enable dictation"
          description="Keep Shots Founder Hub running to use your shortcut in other apps."
          disabled={!device}
        />
        <SettingRow title="Dictation shortcut" description="The keyboard shortcut that starts dictation.">
          {(labels) => (
            <Input
              {...labels}
              value={shortcut}
              disabled={!device}
              onChange={(event) => void saveShortcut(event.target.value)}
              className="bg-card h-9 w-full shadow-none"
            />
          )}
        </SettingRow>
        <BooleanSetting
          name="dictation_live_preview"
          title="Live transcript preview"
          description="Show words in the floating panel as you speak."
          disabled={!device}
        />
        <BooleanSetting
          name="dictation_hands_free"
          title="Hands-free dictation"
          description="Press your shortcut to start, then press it again to finish."
          disabled={!device}
        />
      </div>
      {!device && (
        <p className="text-muted-foreground text-xs">
          Sign in to Shots Founder Hub on a desktop to configure dictation.
        </p>
      )}
    </div>
  )
}
