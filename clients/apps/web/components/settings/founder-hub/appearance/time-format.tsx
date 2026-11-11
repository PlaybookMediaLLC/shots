// Ported from apps/desktop/src/settings/appearance/time-format.tsx; see dev/import-founder-hub-ui.mjs.
import { Trans as _Trans } from '@lingui/react'
import { useSetSettingValue } from '@/components/settings/founder-hub/settings-context'
import { SettingSwitchRow } from '@/components/settings/founder-hub/setting-row'
import { useConfigValue } from '@/components/settings/founder-hub/settings-context'
export function TimeFormatSettings() {
  const enabled = useConfigValue('use_24_hour_time')
  const setEnabled = useSetSettingValue('use_24_hour_time')
  return (
    <SettingSwitchRow
      title={
        <_Trans
          {
            /*i18n*/
            ...{
              id: 'FpI-bb',
              message: 'Use 24-hour time',
            }
          }
        />
      }
      description={
        <_Trans
          {
            /*i18n*/
            ...{
              id: 'Vi44Ou',
              message: 'Show meeting times as 14:00 instead of 2:00 PM.',
            }
          }
        />
      }
      checked={enabled}
      onChange={setEnabled}
    />
  )
}
