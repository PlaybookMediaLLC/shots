// Ported from apps/desktop/src/settings/general/audio-settings.tsx; see dev/import-founder-hub-ui.mjs.
import { useLingui as _useLingui } from '@lingui/react'
import { Trans as _Trans } from '@lingui/react'
import type { ReactNode } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  SETTING_CONTROL_CLASS,
  SettingRow,
  SettingSwitchRow,
} from '@/components/settings/founder-hub/setting-row'
export function AudioSettingsView({
  audioRetention,
  microphoneDevice,
  rememberSpeakers,
}: {
  audioRetention: {
    value: string
    onChange: (value: string) => void
  }
  microphoneDevice: {
    value: string
    devices: string[]
    onChange: (value: string) => void
  }
  rememberSpeakers: {
    value: boolean
    onChange: (value: boolean) => void
  }
}) {
  return (
    <div className="flex flex-col gap-4">
      <AudioDeviceRow
        title={
          <_Trans
            {
              /*i18n*/
              ...{
                id: '1iY5xv',
                message: 'Microphone',
              }
            }
          />
        }
        description={
          <_Trans
            {
              /*i18n*/
              ...{
                id: '2IiZEV',
                message: 'Choose the microphone that captures your voice.',
              }
            }
          />
        }
        value={microphoneDevice.value}
        devices={microphoneDevice.devices}
        onChange={microphoneDevice.onChange}
      />
      <AudioRetentionRow value={audioRetention.value} onChange={audioRetention.onChange} />
      <SettingSwitchRow
        title={
          <_Trans
            {
              /*i18n*/
              ...{
                id: 'FYzp8q',
                message: 'Remember speakers',
              }
            }
          />
        }
        description={
          <_Trans
            {
              /*i18n*/
              ...{
                id: 'NFBUSj',
                message:
                  'Build voiceprints from meeting audio so speakers you name in a transcript are recognized in later meetings. Voiceprints never leave this device, and unnamed ones are deleted after 45 days.',
              }
            }
          />
        }
        checked={rememberSpeakers.value}
        onChange={rememberSpeakers.onChange}
      />
    </div>
  )
}
const SYSTEM_DEFAULT_DEVICE = '__system_default_device__'
export function AudioDeviceRow({
  title,
  description,
  value,
  devices,
  onChange,
}: {
  title: ReactNode
  description: ReactNode
  value: string
  devices: string[]
  onChange: (value: string) => void
}) {
  const availableDevices = [...new Set(devices)].sort((a, b) => a.localeCompare(b))
  const selectedDeviceUnavailable = Boolean(value) && !availableDevices.includes(value)
  if (selectedDeviceUnavailable) {
    availableDevices.unshift(value)
  }
  return (
    <SettingRow title={title} description={description}>
      {(labelProps) => (
        <Select
          value={value || SYSTEM_DEFAULT_DEVICE}
          onValueChange={(device) => onChange(device === SYSTEM_DEFAULT_DEVICE ? '' : device)}
        >
          <SelectTrigger {...labelProps} className={SETTING_CONTROL_CLASS}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-64">
            <SelectItem value={SYSTEM_DEFAULT_DEVICE}>
              <_Trans
                {
                  /*i18n*/
                  ...{
                    id: 'Fi5cYq',
                    message: 'Current default',
                  }
                }
              />
            </SelectItem>
            {availableDevices.map((device) => (
              <SelectItem key={device} value={device}>
                {device}
                {selectedDeviceUnavailable && device === value ? (
                  <>
                    {' '}
                    <_Trans
                      {
                        /*i18n*/
                        ...{
                          id: 'K9J76M',
                          message: '(Unavailable \u2014 using current default)',
                        }
                      }
                    />
                  </>
                ) : null}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </SettingRow>
  )
}
const AUDIO_RETENTION_OPTIONS = [
  'none',
  'oneDay',
  'threeDays',
  'oneWeek',
  'oneMonth',
  'forever',
] as const
function AudioRetentionRow({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  const { _: _t } = _useLingui()
  const copyByValue = {
    none: _t(
      /*i18n*/
      {
        id: 'zJDAbh',
        message: "Don't save",
      }
    ),
    oneDay: _t(
      /*i18n*/
      {
        id: 'gphxoA',
        message: '1 day',
      }
    ),
    threeDays: _t(
      /*i18n*/
      {
        id: '7ZrpGs',
        message: '3 days',
      }
    ),
    oneWeek: _t(
      /*i18n*/
      {
        id: '3vtzIH',
        message: '1 week',
      }
    ),
    oneMonth: _t(
      /*i18n*/
      {
        id: 'voMgY-',
        message: '1 month',
      }
    ),
    forever: _t(
      /*i18n*/
      {
        id: '9ZP9cc',
        message: 'Forever',
      }
    ),
  } as const
  return (
    <SettingRow
      title={
        <_Trans
          {
            /*i18n*/
            ...{
              id: 'A44ty5',
              message: 'Audio file retention',
            }
          }
        />
      }
      description={
        <_Trans
          {
            /*i18n*/
            ...{
              id: 'OOiclf',
              message: 'Choose how long recordings stay on this device.',
            }
          }
        />
      }
    >
      {(labelProps) => (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger {...labelProps} className={SETTING_CONTROL_CLASS}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AUDIO_RETENTION_OPTIONS.map((option) => (
              <SelectItem key={option} value={option}>
                {copyByValue[option]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </SettingRow>
  )
}
