'use client'

import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SettingsPageTitle } from './page-title'
import { SettingRow } from './setting-row'
import { useConfigValues, useSetSettingValues } from './settings-context'
import type { SettingValues } from './schema'

const REASONING = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const

/** Select an AI provider and model; Shots stores these preferences per desktop account. */
export function SettingsAIProvider({ kind }: { kind: 'llm' | 'stt' }) {
  const llm = useConfigValues([
    'current_llm_provider',
    'current_llm_model',
    'current_llm_reasoning_effort',
  ] as const)
  const stt = useConfigValues(['current_stt_provider', 'current_stt_model'] as const)
  const save = useSetSettingValues()
  const provider = kind === 'llm' ? llm.current_llm_provider : stt.current_stt_provider
  const model = kind === 'llm' ? llm.current_llm_model : stt.current_stt_model
  const providerKey = kind === 'llm' ? 'current_llm_provider' : 'current_stt_provider'
  const modelKey = kind === 'llm' ? 'current_llm_model' : 'current_stt_model'
  const title = kind === 'llm' ? 'Intelligence' : 'Transcription'
  return (
    <div className="flex flex-col gap-8">
      <SettingsPageTitle title={title} />
      <p className="text-muted-foreground text-sm">
        Choose the provider and model used by Shots Founder Hub. Configure provider credentials in the desktop app; credentials stay in its secure keychain.
      </p>
      <div className="flex flex-col gap-6">
        <SettingRow title="Provider" description="Provider identifier configured in the desktop app.">
          {(labels) => (
            <Input {...labels} value={provider ?? ''} onChange={(event) => void save({ [providerKey]: event.target.value } as SettingValues)} className="bg-card h-9 shadow-none" />
          )}
        </SettingRow>
        <SettingRow title="Model" description="Model identifier from the selected provider.">
          {(labels) => (
            <Input {...labels} value={model ?? ''} onChange={(event) => void save({ [modelKey]: event.target.value } as SettingValues)} className="bg-card h-9 shadow-none" />
          )}
        </SettingRow>
        {kind === 'llm' && (
          <SettingRow title="Reasoning effort" description="Adjust reasoning effort for models that support it.">
            {(labels) => (
              <Select value={llm.current_llm_reasoning_effort ?? 'default'} onValueChange={(value) => void save({ current_llm_reasoning_effort: value } as SettingValues)}>
                <SelectTrigger {...labels} className="bg-card h-9"><SelectValue /></SelectTrigger>
                <SelectContent>{REASONING.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
              </Select>
            )}
          </SettingRow>
        )}
      </div>
    </div>
  )
}
