'use client'

import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingsPageTitle } from './page-title'
import { SettingRow } from './setting-row'
import { useConfigValues, useSetSettingValues } from './settings-context'
import { useNativeSettingsAction, useSelectedDevice } from './device-context'
import { createAIProviderRequest } from './private-action'
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
  const device = useSelectedDevice()
  const action = useNativeSettingsAction()
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [providerRequest, setProviderRequest] = useState<{
    providerId: string
    request: Awaited<ReturnType<typeof createAIProviderRequest>>
  }>()
  const providerId = kind === 'llm' ? llm.current_llm_provider : stt.current_stt_provider
  const providerAction = useMutation({
    mutationFn: async (operation: 'status' | 'save' | 'clear') => {
      if (!device?.report.autoFormatKey || !device.report.supportsAIProviderSettings || !providerId)
        throw new Error('Select an up-to-date connected desktop and provider first.')
      const input =
        operation === 'save'
          ? {
              operation,
              type: kind,
              providerId,
              baseUrl: baseUrl || providerResult.data?.baseUrl || '',
              apiKey,
            }
          : { operation, type: kind, providerId }
      const request = await createAIProviderRequest(device.report.autoFormatKey, input)
      return { providerId, request }
    },
    onSuccess: ({ providerId, request }) => {
      setProviderRequest({ providerId, request })
      action.run({ kind: 'ai-provider', argument: request.argument })
      setApiKey('')
    },
  })
  const providerResult = useQuery({
    queryKey: ['founder-hub-ai-provider', device?.deviceId, action.commandId],
    enabled:
      action.kind === 'ai-provider' &&
      Boolean(
        providerRequest &&
        providerRequest.providerId === providerId &&
        action.commandId &&
        action.result
      ),
    queryFn: () => providerRequest!.request.readResult(action.result),
    staleTime: Infinity,
    gcTime: 0,
  })
  const storedConfig = providerRequest?.providerId === providerId ? providerResult.data : undefined
  const provider = providerId
  const model = kind === 'llm' ? llm.current_llm_model : stt.current_stt_model
  const providerKey = kind === 'llm' ? 'current_llm_provider' : 'current_stt_provider'
  const modelKey = kind === 'llm' ? 'current_llm_model' : 'current_stt_model'
  const title = kind === 'llm' ? 'Intelligence' : 'Transcription'
  return (
    <div className="flex flex-col gap-8">
      <SettingsPageTitle title={title} />
      <p className="text-muted-foreground text-sm">
        Choose the provider and model used by Shots Founder Hub. Provider credentials are stored in
        the selected desktop’s secure keychain.
      </p>
      <div className="flex flex-col gap-6">
        <SettingRow
          title="Provider"
          description="Provider identifier configured in the desktop app."
        >
          {(labels) => (
            <Input
              {...labels}
              value={provider ?? ''}
              onChange={(event) =>
                void save({ [providerKey]: event.target.value } as SettingValues)
              }
              className="bg-card h-9 shadow-none"
            />
          )}
        </SettingRow>
        <SettingRow title="Model" description="Model identifier from the selected provider.">
          {(labels) => (
            <Input
              {...labels}
              value={model ?? ''}
              onChange={(event) => void save({ [modelKey]: event.target.value } as SettingValues)}
              className="bg-card h-9 shadow-none"
            />
          )}
        </SettingRow>
        {kind === 'llm' && (
          <SettingRow
            title="Reasoning effort"
            description="Adjust reasoning effort for models that support it."
          >
            {(labels) => (
              <Select
                value={llm.current_llm_reasoning_effort ?? 'default'}
                onValueChange={(value) =>
                  void save({ current_llm_reasoning_effort: value } as SettingValues)
                }
              >
                <SelectTrigger {...labels} className="bg-card h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REASONING.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </SettingRow>
        )}
      </div>
      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-medium">Provider credentials</h2>
          <p className="text-xs text-muted-foreground">
            Credentials are encrypted in this browser and saved to the selected desktop’s secure
            keychain.
          </p>
        </div>
        <SettingRow title="Base URL" description="Optional endpoint for this provider.">
          {(labels) => (
            <Input
              {...labels}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.example.com"
              className="bg-card h-9 shadow-none"
            />
          )}
        </SettingRow>
        <SettingRow
          title="API key"
          description={
            storedConfig?.configured
              ? 'A key is stored on the selected desktop. Enter a new key to replace it.'
              : 'Enter the key for the selected provider.'
          }
        >
          {(labels) => (
            <Input
              {...labels}
              type="password"
              autoComplete="new-password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              className="bg-card h-9 shadow-none"
            />
          )}
        </SettingRow>
        {storedConfig?.baseUrl && (
          <p className="text-xs text-muted-foreground">Saved endpoint: {storedConfig.baseUrl}</p>
        )}
        {(action.error || providerAction.error || providerResult.error) && (
          <p role="alert" className="text-sm text-destructive">
            {action.error ??
              providerAction.error?.message ??
              'Could not read the saved provider configuration.'}
          </p>
        )}
        {storedConfig && (
          <p role="status" className="text-xs text-muted-foreground">
            {storedConfig.configured
              ? 'Credentials are configured on this desktop.'
              : 'No credentials are saved on this desktop.'}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={
              !providerId ||
              !device?.report.supportsAIProviderSettings ||
              !device?.report.autoFormatKey ||
              action.isPending ||
              providerAction.isPending
            }
            onClick={() => providerAction.mutate('status')}
          >
            Check credentials
          </Button>
          <Button
            type="button"
            disabled={
              !providerId ||
              !device?.report.supportsAIProviderSettings ||
              !device?.report.autoFormatKey ||
              !apiKey ||
              !storedConfig ||
              action.isPending ||
              providerAction.isPending
            }
            onClick={() => providerAction.mutate('save')}
          >
            Save key
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={
              !providerId ||
              !device?.report.supportsAIProviderSettings ||
              !device?.report.autoFormatKey ||
              !storedConfig?.configured ||
              action.isPending ||
              providerAction.isPending
            }
            onClick={() => providerAction.mutate('clear')}
          >
            Remove key
          </Button>
        </div>
      </section>
    </div>
  )
}
