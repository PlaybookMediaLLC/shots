'use client'

import { Button } from '@/components/ui/button'
import { FolderSimple } from '@phosphor-icons/react'
import { SettingsPageTitle } from '../page-title'
import { SettingSwitchRow } from '../setting-row'
import {
  useConfigValue,
  useConfigValues,
  useSetSettingValues,
  useSetSettingValue,
} from '../settings-context'
import { useSelectedDevice, useNativeSettingsAction } from '../device-context'
import { MainLanguageView } from './main-language'
import { SpokenLanguagesView } from './spoken-languages'
import { CORE_TRANSCRIPTION_LANGUAGE_CODES, getAdditionalSpokenLanguages } from './language'
import { TimezoneSelector } from './timezone'
import { WeekStartSelector } from './week-start'
import { SYNCED_SETTING_KEYS, type SettingKey, type SettingValue } from '../schema'

/** One original switch row, bound to a typed Shots preference. */
export function BooleanSetting({
  name,
  title,
  description,
  disabled = false,
}: {
  name: { [K in SettingKey]: SettingValue<K> extends boolean ? K : never }[SettingKey]
  title: string
  description?: string
  disabled?: boolean
}) {
  const checked = useConfigValue(name)
  const save = useSetSettingValue(name)
  const device = useSelectedDevice()
  return (
    <SettingSwitchRow
      title={title}
      description={description}
      checked={checked}
      onChange={save}
      disabled={disabled || (!device && !SYNCED_SETTING_KEYS.has(name))}
    />
  )
}

/** General preserves the desktop's section and control order. */
export function SettingsApp() {
  const device = useSelectedDevice()
  const action = useNativeSettingsAction()
  const languages = useConfigValues(['ai_language', 'spoken_languages'] as const)
  const save = useSetSettingValues()
  return (
    <div className="flex flex-col gap-8">
      <SettingsPageTitle title="General" />
      <div className="flex flex-col gap-8">
        <section>
          <div className="flex flex-col gap-4">
            {!device?.report.appStore && (
              <>
                <BooleanSetting
                  name="autostart"
                  title="Start Shots Founder Hub at login"
                  description="Have Shots Founder Hub ready when you sign in."
                  disabled={!device}
                />
                <BooleanSetting
                  name="automatic_updates"
                  title="Automatically install updates"
                  description="Stay current with updates installed the next time Shots Founder Hub opens."
                  disabled={!device}
                />
              </>
            )}
            <Button
              variant="outline"
              className="self-start"
              disabled={!device?.report.version || action.isPending}
              onClick={() => action.run({ kind: 'show-release-notes', argument: '' })}
            >
              Show release notes
            </Button>
            {device?.report.platform === 'macos' && (
              <BooleanSetting
                name="show_app_in_dock"
                title="Show app in Dock"
                description="Show Shots Founder Hub in the Dock and app switcher."
              />
            )}
            <BooleanSetting
              name="show_tray_icon"
              title="Show tray icon"
              description={
                device?.report.platform === 'macos'
                  ? 'Open Shots Founder Hub from the menu bar.'
                  : undefined
              }
              disabled={!device}
            />
            {action.error && (
              <p role="alert" className="text-destructive text-xs">
                {action.error}
              </p>
            )}
          </div>
        </section>
      </div>
      <div>
        <h2 className="mb-4 font-sans text-lg font-semibold">Language &amp; Region</h2>
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-4">
            <MainLanguageView
              value={languages.ai_language}
              onChange={(value) =>
                save({
                  ai_language: value,
                  spoken_languages: JSON.stringify(
                    getAdditionalSpokenLanguages(value, languages.spoken_languages)
                  ),
                })
              }
              supportedLanguages={CORE_TRANSCRIPTION_LANGUAGE_CODES}
            />
            <div className="border-muted ml-3 flex flex-col gap-4 border-l-2 pt-2 pl-4">
              <BooleanSetting
                name="summary_use_main_language"
                title="Use main language for summaries"
                description="When off, summaries follow the detected meeting language."
              />
              <SpokenLanguagesView
                mainLanguage={languages.ai_language}
                value={languages.spoken_languages}
                onChange={(value) =>
                  save({
                    spoken_languages: JSON.stringify(
                      getAdditionalSpokenLanguages(languages.ai_language, value)
                    ),
                  })
                }
                supportedLanguages={CORE_TRANSCRIPTION_LANGUAGE_CODES}
              />
            </div>
          </div>
          <TimezoneSelector />
          <WeekStartSelector />
        </div>
      </div>
      <StorageSettingsView />
    </div>
  )
}

function StorageSettingsView() {
  const directory = useConfigValue('export_directory')
  const save = useSetSettingValue('export_directory')
  const device = useSelectedDevice()
  const action = useNativeSettingsAction()
  const path = directory || device?.report.downloadsDirectory || ''
  const home = device?.report.homeDirectory.replace(/\/$/, '')
  const display =
    home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path
  return (
    <div>
      <h2 className="mb-4 font-sans text-lg font-semibold">Storage</h2>
      <div className="flex flex-col gap-3">
        <div>
          <div className="grid grid-cols-[minmax(0,1fr)_9rem] items-center gap-3">
            <Button
              variant="custom"
              size={null}
              type="button"
              className="hover:bg-muted/40 flex min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors"
              disabled={!path || action.isPending}
              onClick={() => action.run({ kind: 'open-export-directory', argument: '' })}
            >
              <FolderSimple className="text-muted-foreground size-4 shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium">Export location</p>
                <p className="text-muted-foreground truncate text-xs" title={path}>
                  {display}
                </p>
              </div>
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-9 w-full justify-center"
              disabled={!device || action.isPending}
              onClick={() => action.run({ kind: 'choose-export-directory', argument: '' })}
            >
              Choose folder
            </Button>
          </div>
          <p className="text-muted-foreground px-2 text-xs">
            Save PDF, text, Markdown, and Org exports to this folder.
          </p>
          {directory && (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="px-2"
              disabled={action.isPending}
              onClick={() => save('')}
            >
              Reset to Downloads
            </Button>
          )}
          {action.error && (
            <p role="alert" className="text-destructive mt-1 px-2 text-xs">
              {action.error}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
