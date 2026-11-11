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
 * whole workspace; each profile keeps its own posting times. Only an owner or
 * admin may change it (`canManage`); others see it read-only.
 */
export function ApprovalSetting({ canManage }: { canManage: boolean }) {
  const client = useQueryClient()
  const settings = useQuery({ queryKey: SETTINGS_KEY, queryFn: () => draftsApi.settings() })
  const [state, run] = useSaveState()
  const save = (change: Pick<Partial<SettingsWire>, 'allowSelfApproval' | 'requireApproval'>) =>
    run(async () => {
      const previous = client.getQueryData<SettingsWire>(SETTINGS_KEY)
      if (previous) client.setQueryData(SETTINGS_KEY, { ...previous, ...change })
      try {
        // Only the approval switches are sent, so a plan without queue slots can still change them.
        client.setQueryData(SETTINGS_KEY, await draftsApi.saveSettings(change))
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
  // Without the plan, the Profiles page already says what it needs.
  if (isPlanRefusal(settings.error)) return null
  return (
    <Group>
      <Row
        description={`A publisher or admin approves each draft before it is scheduled, for every profile.${canManage ? '' : ' Only an owner or admin can change approvals.'}`}
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
              onCheckedChange={(checked) => void save({ requireApproval: checked })}
            />
          </div>
        )}
      </Row>
      {settings.data ? (
        <Row
          description="When off, the person who last edited a draft cannot approve it."
          label="Self-approval"
          layout="inline"
        >
          <Switch
            aria-label="Allow self-approval"
            checked={settings.data.allowSelfApproval}
            disabled={!canManage}
            onCheckedChange={(checked) => void save({ allowSelfApproval: checked })}
          />
        </Row>
      ) : null}
    </Group>
  )
}
