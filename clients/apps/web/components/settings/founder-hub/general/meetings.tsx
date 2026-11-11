'use client'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingsPageTitle } from '../page-title'
import { SettingRow, SETTING_CONTROL_CLASS } from '../setting-row'
import { useConfigValues, useSetSettingValues, useFounderHubAccount } from '../settings-context'
import { useSelectedDevice, useFounderHubDevices } from '../device-context'
import { useBillingAccess } from '../billing-access'
import { BooleanSetting } from './app'
import { AudioSettingsView } from './audio-settings'

/** The original Meetings page, with device discovery and saves supplied by Shots. */
export function SettingsMeetings() {
  const device = useSelectedDevice()
  const devices = useFounderHubDevices()
  const account = useFounderHubAccount()
  const { isPro } = useBillingAccess()
  const value = useConfigValues([
    'default_meeting_share_access',
    'primary_recording_device',
    'auto_start_scheduled_meetings',
    'audio_retention',
    'microphone_device',
    'remember_speakers',
  ] as const)
  const save = useSetSettingValues()
  const workspace = account.workspaces[0]
  return (
    <div className="flex flex-col gap-8">
      <SettingsPageTitle title="Meetings" />
      <div className="flex flex-col gap-4">
        <SettingRow
          title="Default sharing"
          description="Choose who can access notes from new meetings."
        >
          {(labels) => (
            <Select
              value={value.default_meeting_share_access}
              onValueChange={(next) => save({ default_meeting_share_access: next })}
            >
              <SelectTrigger {...labels} className={SETTING_CONTROL_CLASS}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="me">Only me</SelectItem>
                <SelectItem value="participants">People in the meeting</SelectItem>
                <SelectItem value="workspace" disabled={!workspace}>
                  {workspace ? `Everyone in ${workspace.name}` : 'Everyone in the workspace'}
                </SelectItem>
              </SelectContent>
            </Select>
          )}
        </SettingRow>
        <SettingRow
          title="Primary recording device"
          description={
            isPro
              ? 'Prefer this device when multiple devices record the same meeting. Other devices can record when it is not recording.'
              : 'Shots Founder Hub Pro coordinates recording across your devices.'
          }
        >
          {(labels) => (
            <Select
              value={value.primary_recording_device || 'ask'}
              onValueChange={(next) =>
                save({ primary_recording_device: next === 'ask' ? '' : next })
              }
            >
              <SelectTrigger {...labels} className={SETTING_CONTROL_CLASS} disabled={!isPro}>
                <SelectValue placeholder="Choose a device" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ask">Ask each meeting</SelectItem>
                {devices.map((item) => (
                  <SelectItem value={item.deviceId} key={item.deviceId}>
                    {item.name || 'Unnamed device'}
                  </SelectItem>
                ))}
                {value.primary_recording_device &&
                  !devices.some((item) => item.deviceId === value.primary_recording_device) && (
                    <SelectItem value={value.primary_recording_device} disabled>
                      Unavailable device
                    </SelectItem>
                  )}
              </SelectContent>
            </Select>
          )}
        </SettingRow>
        <BooleanSetting
          name="auto_start_scheduled_meetings"
          title="Start when meeting begins"
          description="Start listening when a scheduled meeting begins."
        />
        <BooleanSetting
          name="auto_join_scheduled_meetings"
          title="Join scheduled meetings"
          description="Open the meeting link when a scheduled meeting begins."
          disabled={!value.auto_start_scheduled_meetings}
        />
        {device?.report.platform !== 'windows' && (
          <BooleanSetting
            name="auto_stop_meetings"
            title="Stop when meeting ends"
            description="Stop listening when your call ends."
          />
        )}
        {(device?.report.platform === 'macos' || device?.report.platform === 'linux') && (
          <>
            <BooleanSetting
              name="consent_auto_send_chat"
              title="Post recording disclosure in meeting chat"
              description="Tell participants when listening starts; this does not confirm consent."
            />
            <BooleanSetting
              name="capture_meeting_chat"
              title="Capture meeting chat in Memos"
              description="Save visible chat from supported meetings using Accessibility."
            />
          </>
        )}
        {(device?.report.platform === 'macos' || device?.report.platform === 'windows') && (
          <BooleanSetting
            name="capture_shared_screens"
            title="Capture shared screens in Memos"
            description="Save slides and screens others share in meetings. Requires Screen Recording."
          />
        )}
        <BooleanSetting
          name="floating_bar_enabled"
          title="Show floating bar"
          description="Control listening without reopening Shots Founder Hub."
        />
      </div>
      <div>
        <h2 className="mb-4 font-sans text-lg font-semibold">Audio</h2>
        <AudioSettingsView
          audioRetention={{
            value: value.audio_retention || 'forever',
            onChange: (next) => save({ audio_retention: next, save_recordings: next !== 'none' }),
          }}
          microphoneDevice={{
            value: value.microphone_device,
            devices: device?.report.microphones ?? [],
            onChange: (next) => save({ microphone_device: next }),
          }}
          rememberSpeakers={{
            value: value.remember_speakers,
            onChange: (next) => save({ remember_speakers: next }),
          }}
        />
      </div>
    </div>
  )
}
