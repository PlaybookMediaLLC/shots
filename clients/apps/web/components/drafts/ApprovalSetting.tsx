'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Group, Row } from '@/components/platform-ui'
import { SaveStatus, useSaveState } from '@/components/settings/controls'
import { Switch } from '@/components/ui/switch'
import { isPlanRefusal } from '@/lib/api/platform-errors'
import { draftsApi, type SettingsWire } from '@/lib/content-drafts/client'

const SETTINGS_KEY = ['content-draft-settings'] as const

/**
 * Whether a draft needs approval before it is scheduled. It applies to the
 * whole workspace; each publishing brand keeps its own posting times.
 */
export function ApprovalSetting({ canManage }: { canManage: boolean }) {
  const client = useQueryClient()
  const settings = useQuery({ queryKey: SETTINGS_KEY, queryFn: () => draftsApi.settings() })
  const [state, run] = useSaveState()
  const save = (requireApproval: boolean) =>
    run(async () => {
      const previous = client.getQueryData<SettingsWire>(SETTINGS_KEY)
      if (previous) client.setQueryData(SETTINGS_KEY, { ...previous, requireApproval })
      try {
        // Only the approval switch is sent, so a plan without queue slots can still change it.
        client.setQueryData(SETTINGS_KEY, await draftsApi.saveSettings({ requireApproval }))
        return { ok: true }
      } catch (error) {
        client.setQueryData(SETTINGS_KEY, previous)
        return {
          error:
            error instanceof Error ? error.message : 'The approval setting could not be saved.',
          ok: false,
        }
      }
    })
  // Without the plan, the Publishing brands page already says what it needs.
  if (isPlanRefusal(settings.error)) return null
  return (
    <Group>
      <Row
        description="A publisher or admin approves each draft before it is scheduled, for every publishing brand."
        label="Approvals"
      >
        {settings.isError ? (
          <p className="text-sm text-red-700 dark:text-red-300" role="alert">
            {settings.error.message}
          </p>
        ) : (
          <div className="flex items-center gap-3">
            <SaveStatus state={state} />
            <Switch
              aria-label="Require approval"
              checked={settings.data?.requireApproval ?? false}
              disabled={!canManage || !settings.data}
              onCheckedChange={(checked) => void save(checked)}
            />
          </div>
        )}
      </Row>
    </Group>
  )
}
