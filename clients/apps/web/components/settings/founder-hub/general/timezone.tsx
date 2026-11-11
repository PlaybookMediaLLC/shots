// Ported from apps/desktop/src/settings/general/timezone.tsx; see dev/import-founder-hub-ui.mjs.
import { useSelectedDevice } from '@/components/settings/founder-hub/device-context'
import { Trans as _Trans } from '@lingui/react'
import { useLingui as _useLingui } from '@lingui/react'
import { useMemo } from 'react'
import { SearchableSelect, type SearchableSelectOption } from './searchable-select'
import { useSetSettingValue } from '@/components/settings/founder-hub/settings-context'
import { SettingRow } from '@/components/settings/founder-hub/setting-row'
import { useConfigValue } from '@/components/settings/founder-hub/settings-context'
const COMMON_TIMEZONES = [
  {
    value: 'Pacific/Honolulu',
    label: 'Hawaii',
    detail: 'UTC-10',
  },
  {
    value: 'America/Anchorage',
    label: 'Alaska',
    detail: 'UTC-9',
  },
  {
    value: 'America/Los_Angeles',
    label: 'Pacific Time',
    detail: 'UTC-8',
  },
  {
    value: 'America/Denver',
    label: 'Mountain Time',
    detail: 'UTC-7',
  },
  {
    value: 'America/Chicago',
    label: 'Central Time',
    detail: 'UTC-6',
  },
  {
    value: 'America/New_York',
    label: 'Eastern Time',
    detail: 'UTC-5',
  },
  {
    value: 'America/Sao_Paulo',
    label: 'Sao Paulo',
    detail: 'UTC-3',
  },
  {
    value: 'Atlantic/Reykjavik',
    label: 'Reykjavik',
    detail: 'UTC+0',
  },
  {
    value: 'Europe/London',
    label: 'London',
    detail: 'UTC+0/+1',
  },
  {
    value: 'Europe/Paris',
    label: 'Paris',
    detail: 'UTC+1/+2',
  },
  {
    value: 'Europe/Berlin',
    label: 'Berlin',
    detail: 'UTC+1/+2',
  },
  {
    value: 'Africa/Cairo',
    label: 'Cairo',
    detail: 'UTC+2',
  },
  {
    value: 'Europe/Moscow',
    label: 'Moscow',
    detail: 'UTC+3',
  },
  {
    value: 'Asia/Dubai',
    label: 'Dubai',
    detail: 'UTC+4',
  },
  {
    value: 'Asia/Kolkata',
    label: 'India',
    detail: 'UTC+5:30',
  },
  {
    value: 'Asia/Bangkok',
    label: 'Bangkok',
    detail: 'UTC+7',
  },
  {
    value: 'Asia/Singapore',
    label: 'Singapore',
    detail: 'UTC+8',
  },
  {
    value: 'Asia/Shanghai',
    label: 'China',
    detail: 'UTC+8',
  },
  {
    value: 'Asia/Tokyo',
    label: 'Tokyo',
    detail: 'UTC+9',
  },
  {
    value: 'Asia/Seoul',
    label: 'Seoul',
    detail: 'UTC+9',
  },
  {
    value: 'Australia/Sydney',
    label: 'Sydney',
    detail: 'UTC+10/+11',
  },
  {
    value: 'Pacific/Auckland',
    label: 'Auckland',
    detail: 'UTC+12/+13',
  },
]
export function TimezoneSelector() {
  const { _: _t } = _useLingui()
  const value = useConfigValue('timezone')
  const setTimezone = useSetSettingValue('timezone')
  const device = useSelectedDevice()
  const systemTimezone = device?.report.timezone || 'UTC'
  const options: SearchableSelectOption[] = useMemo(() => COMMON_TIMEZONES, [])
  const displayValue = value || systemTimezone
  const handleChange = (val: string) => {
    setTimezone(val === systemTimezone ? '' : val)
  }
  return (
    <SettingRow
      title={
        <_Trans
          {
            /*i18n*/
            ...{
              id: '40Gx0U',
              message: 'Timezone',
            }
          }
        />
      }
      description={
        <_Trans
          {
            /*i18n*/
            ...{
              id: 'jhTeLV',
              message: 'Show the timeline in your preferred timezone.',
            }
          }
        />
      }
    >
      {(labelProps) => (
        <SearchableSelect
          {...labelProps}
          value={displayValue}
          onChange={handleChange}
          options={options}
          placeholder={_t(
            /*i18n*/
            {
              id: 'aT3jZX',
              message: 'Select timezone',
            }
          )}
          searchPlaceholder={_t(
            /*i18n*/
            {
              id: 'bPz5uu',
              message: 'Search timezone...',
            }
          )}
          className="w-full"
          dropdownClassName="w-72"
        />
      )}
    </SettingRow>
  )
}
