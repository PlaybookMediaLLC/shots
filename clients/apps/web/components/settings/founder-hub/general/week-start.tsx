// Ported from apps/desktop/src/settings/general/week-start.tsx; see dev/import-founder-hub-ui.mjs.
import { useSelectedDevice } from '@/components/settings/founder-hub/device-context'
import { Trans as _Trans } from '@lingui/react'
import { useLingui as _useLingui } from '@lingui/react'
import { useMemo } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useSetSettingValue } from '@/components/settings/founder-hub/settings-context'
import { SETTING_CONTROL_CLASS, SettingRow } from '@/components/settings/founder-hub/setting-row'
import { useConfigValue } from '@/components/settings/founder-hub/settings-context'
function getSystemWeekStart(locale: string): 'sunday' | 'monday' {
  try {
    const options = new Intl.Locale(locale)
    const info =
      (
        options as Intl.Locale & {
          getWeekInfo?: () => {
            firstDay: number
          }
          weekInfo?: {
            firstDay: number
          }
        }
      ).getWeekInfo?.() ??
      (
        options as Intl.Locale & {
          getWeekInfo?: () => {
            firstDay: number
          }
          weekInfo?: {
            firstDay: number
          }
        }
      ).weekInfo
    if (info?.firstDay === 1) return 'monday'
  } catch {
    return 'sunday'
  }
  return 'sunday'
}
export function WeekStartSelector() {
  const { _: _t } = _useLingui()
  const value = useConfigValue('week_start')
  const setWeekStart = useSetSettingValue('week_start')
  const device = useSelectedDevice()
  const systemDefault = useMemo(
    () => getSystemWeekStart(device?.report.locale || 'en-US'),
    [device?.report.locale]
  )
  const options = useMemo(
    () => [
      {
        value: 'sunday',
        label: _t(
          /*i18n*/
          {
            id: 'DBC3t5',
            message: 'Sunday',
          }
        ),
      },
      {
        value: 'monday',
        label: _t(
          /*i18n*/
          {
            id: 'hty0d5',
            message: 'Monday',
          }
        ),
      },
    ],
    [_t]
  )
  const displayValue = value || systemDefault
  const handleChange = (val: string) => {
    setWeekStart(val === systemDefault ? '' : val)
  }
  return (
    <SettingRow
      title={
        <_Trans
          {
            /*i18n*/
            ...{
              id: 'c8f_uU',
              message: 'Week starts on',
            }
          }
        />
      }
      description={
        <_Trans
          {
            /*i18n*/
            ...{
              id: '5IIg5u',
              message: 'Choose which day begins your calendar week.',
            }
          }
        />
      }
    >
      {(labelProps) => (
        <Select value={displayValue} onValueChange={handleChange}>
          <SelectTrigger {...labelProps} className={SETTING_CONTROL_CLASS}>
            <SelectValue
              placeholder={_t(
                /*i18n*/
                {
                  id: 'Fj7Zd1',
                  message: 'Select day',
                }
              )}
            />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </SettingRow>
  )
}
