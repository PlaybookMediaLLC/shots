'use client'

import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { SettingsPageTitle } from './page-title'
import { SettingRow } from './setting-row'
import { BooleanSetting } from './general/app'
import { useConfigValue, useSetSettingValue } from './settings-context'
import { useNativeSettingsAction, useSelectedDevice } from './device-context'

const AUTOMATIONS = [
  ['automation_markdown_export_enabled', 'Markdown export', 'Save meeting notes as Markdown.'],
  ['automation_slack_recap_enabled', 'Slack recap', 'Send meeting recaps to a Slack channel.'],
  ['automation_linear_issues_enabled', 'Linear action items', 'Create Linear issues from meeting action items.'],
  ['automation_notion_update_enabled', 'Notion update', 'Add meeting notes to a Notion page.'],
] as const

/** Configure the original starter automations using the selected device's Shots settings. */
export function SettingsAutomations() {
  const directory = useConfigValue('automation_markdown_export_directory')
  const slackTarget = useConfigValue('automation_slack_recap_channel')
  const linearTarget = useConfigValue('automation_linear_issues_team')
  const notionTarget = useConfigValue('automation_notion_update_page')
  const saveDirectory = useSetSettingValue('automation_markdown_export_directory')
  const saveSlack = useSetSettingValue('automation_slack_recap_channel')
  const saveLinear = useSetSettingValue('automation_linear_issues_team')
  const saveNotion = useSetSettingValue('automation_notion_update_page')
  const device = useSelectedDevice()
  const action = useNativeSettingsAction()
  const targets = [
    ['Slack channel (JSON target)', slackTarget, saveSlack],
    ['Linear team (JSON target)', linearTarget, saveLinear],
    ['Notion page (JSON target)', notionTarget, saveNotion],
  ] as const
  return (
    <div className="flex flex-col gap-8">
      <SettingsPageTitle title="Automations" />
      <p className="text-muted-foreground text-sm">
        Choose which meeting workflows the connected desktop runs. These settings are saved by Shots and applied by Founder Hub.
      </p>
      <div className="flex flex-col gap-6">
        {AUTOMATIONS.map(([name, title, description]) => (
          <BooleanSetting key={name} name={name} title={title} description={description} />
        ))}
        <SettingRow title="Markdown export folder" description={directory || device?.report.downloadsDirectory || 'Use the default Downloads folder.'}>
          {(labels) => (
            <div {...labels} className="flex gap-2">
              <Button variant="outline" size="sm" disabled={!device || action.isPending} onClick={() => action.run({ kind: 'choose-export-directory', argument: '' })}>Choose folder</Button>
              {directory && <Button variant="ghost" size="sm" disabled={action.isPending} onClick={() => void saveDirectory('')}>Reset</Button>}
            </div>
          )}
        </SettingRow>
        {action.error && <p role="alert" className="text-destructive text-xs">{action.error}</p>}
        {targets.map(([title, value, save]) => (
          <SettingRow key={title} title={title}>
            {(labels) => (
              <Input {...labels} value={value ?? ''} onChange={(event) => void save(event.target.value)} className="bg-card h-9 shadow-none" />
            )}
          </SettingRow>
        ))}
      </div>
      <p className="text-muted-foreground text-xs">
        Slack, Linear, and Notion targets use the stored target JSON from Founder Hub. Connect integrations in the desktop app before enabling them.
      </p>
    </div>
  )
}
