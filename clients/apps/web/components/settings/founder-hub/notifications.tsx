'use client'

import { X } from '@phosphor-icons/react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Combobox } from '@/components/ui/combobox'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import { SettingsPageTitle } from './page-title'
import { SettingRow } from './setting-row'
import { BooleanSetting } from './general/app'
import { useConfigValues, useSetSettingValues } from './settings-context'
import { useSelectedDevice, useNativeSettingsAction } from './device-context'
import {
  getIgnoredBundleIds,
  getIgnorableApps,
  toggleIgnoredApp,
} from './general/notification-app-options'

const SOUNDS = ['ready', 'success', 'chime', 'sparkle', 'bloom'] as const

/** The desktop's notification controls, with preferences and native previews owned by Shots. */
export function SettingsNotifications() {
  const device = useSelectedDevice()
  const action = useNativeSettingsAction()
  const save = useSetSettingValues()
  const values = useConfigValues([
    'notification_disabled',
    'notification_event',
    'notification_detect',
    'notification_completion_sound',
    'notification_completion_sound_name',
    'show_app_in_dock',
    'ignored_platforms',
    'included_platforms',
    'mic_active_threshold',
  ] as const)
  const disabled = !device || values.notification_disabled
  const sound = SOUNDS.find((name) => name === values.notification_completion_sound_name) ?? 'ready'
  const appOptions = {
    installedApps: device?.report.installedApps ?? [],
    defaultIgnoredBundleIds: device?.report.defaultIgnoredApps ?? [],
    ignoredPlatforms: values.ignored_platforms,
    includedPlatforms: values.included_platforms,
  }
  const ignored = getIgnoredBundleIds(appOptions)
  const toggleApp = (bundleId: string) => {
    const next = toggleIgnoredApp({ ...appOptions, bundleId })
    save({
      ignored_platforms: JSON.stringify(next.ignoredPlatforms),
      included_platforms: JSON.stringify(next.includedPlatforms),
    })
  }
  return (
    <div className="flex flex-col gap-8">
      <SettingsPageTitle title="Notifications" />
      <div className="flex flex-col gap-6">
        <BooleanSetting
          name="notification_disabled"
          title="Disable all notifications"
          description="Hide all notification panels, Dock alerts, and completion sounds."
        />
        <BooleanSetting
          name="notification_summary_complete"
          title="Summary complete"
          description="Show when a summary is ready."
          disabled={disabled}
        />
        <BooleanSetting
          name="notification_cloudsync_complete"
          title="Cloud sync complete"
          description="Show when initial cloud sync finishes."
          disabled={disabled}
        />
        <BooleanSetting
          name="notification_event"
          title="Event notifications"
          description="Prepare for events with a 5-minute reminder."
          disabled={disabled}
        />
        <BooleanSetting
          name="notification_recording"
          title="Recording status prompts"
          description="Ask before stopping when a meeting may have ended. When alerts are off, Shots Founder Hub keeps listening."
          disabled={disabled}
        />
        <div className="flex flex-col gap-4">
          <BooleanSetting
            name="notification_completion_sound"
            title="Completion sound"
            description="Play a sound when transcription, summaries, or cloud sync finish."
            disabled={disabled}
          />
          {values.notification_completion_sound && (
            <div className="ml-3 border-l-2 border-muted pl-4">
              <SettingRow title="Sound" description="Choose from five completion sounds.">
                {(labels) => (
                  <div className="flex w-full items-center gap-2">
                    <Select
                      value={sound}
                      disabled={disabled}
                      onValueChange={(value) => {
                        const selected = SOUNDS.find((name) => name === value)
                        if (!selected) return
                        save({ notification_completion_sound_name: selected })
                        action.run({ kind: 'preview-sound', argument: selected })
                      }}
                    >
                      <SelectTrigger {...labels} className="min-w-0 flex-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SOUNDS.map((name) => (
                          <SelectItem key={name} value={name}>
                            {name[0].toUpperCase() + name.slice(1)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={disabled || action.isPending}
                      onClick={() => action.run({ kind: 'preview-sound', argument: sound })}
                    >
                      Preview
                    </Button>
                  </div>
                )}
              </SettingRow>
            </div>
          )}
        </div>
        {(device?.report.platform !== 'macos' || values.show_app_in_dock) && (
          <BooleanSetting
            name="notification_bounce"
            title="Bounce app icon"
            description="Get your attention when a summary is ready in the background."
            disabled={disabled}
          />
        )}
        {device?.report.platform !== 'windows' && (
          <div className="flex flex-col gap-4">
            <BooleanSetting
              name="notification_detect"
              title="Microphone detection"
              description="Detect meetings from microphone activity."
              disabled={disabled}
            />
            {values.notification_detect && !values.notification_disabled && (
              <div className="ml-3 flex flex-col gap-4 border-l-2 border-muted pt-2 pl-4">
                <SettingRow
                  title="Detection delay"
                  description="Wait before treating microphone activity as a meeting."
                >
                  {(labels) => (
                    <Select
                      value={String(values.mic_active_threshold)}
                      disabled={!device}
                      onValueChange={(value) => save({ mic_active_threshold: Number(value) })}
                    >
                      <SelectTrigger {...labels} className="w-28">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[5, 10, 15, 30, 60, 120].map((seconds) => (
                          <SelectItem key={seconds} value={String(seconds)}>
                            {seconds < 60 ? `${seconds} sec` : `${seconds / 60} min`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </SettingRow>
                <div>
                  <h3 className="text-sm font-medium">Exclude apps from detection</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Prevent selected apps from triggering meeting detection.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {ignored.map((id) => {
                    const name = appOptions.installedApps.find((app) => app.id === id)?.name ?? id
                    return (
                      <Badge key={id} variant="secondary" className="gap-1">
                        {name}
                        {appOptions.defaultIgnoredBundleIds.includes(id) && (
                          <span className="text-muted-foreground"> (default)</span>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-5"
                          aria-label={`Allow detection in ${name}`}
                          disabled={!device}
                          onClick={() => toggleApp(id)}
                        >
                          <X className="size-3" />
                        </Button>
                      </Badge>
                    )
                  })}
                </div>
                <Combobox
                  value={null}
                  aria-label="Exclude apps from detection"
                  placeholder="Search installed apps..."
                  searchPlaceholder="Search installed apps..."
                  emptyText="No apps found."
                  disabled={!device}
                  options={getIgnorableApps({ ...appOptions, inputValue: '' }).map((app) => ({
                    value: app.id,
                    label: app.name,
                    keywords: [app.id],
                  }))}
                  onValueChange={toggleApp}
                />
              </div>
            )}
          </div>
        )}
        {device?.report.platform === 'macos' && (
          <div className="flex flex-col gap-6">
            <div className="flex items-center gap-4 pt-4 pb-2">
              <div className="min-w-0 flex-1 border-t" />
              <span className="text-xs font-medium text-muted-foreground">
                For enabled notifications
              </span>
              <div className="min-w-0 flex-1 border-t" />
            </div>
            <BooleanSetting
              name="respect_dnd"
              title="Respect Do-Not-Disturb mode"
              description="Pause alerts while Do Not Disturb is on."
              disabled={disabled || !(values.notification_event || values.notification_detect)}
            />
          </div>
        )}
        {action.error && (
          <p role="alert" className="text-sm text-destructive">
            {action.error}
          </p>
        )}
      </div>
    </div>
  )
}
