'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { z } from 'zod'
import { Group, Pill, Row } from '@/components/platform-ui'
import { SaveStatus, useSaveState } from '@/components/settings/controls'
import { usePreferences } from '@/components/settings/PreferencesProvider'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  experimentListSchema,
  type experimentStateSchema,
} from '@/lib/api/contracts/settings-platform'
import { settingsErrorMessage, settingsRequest } from '@/lib/settings/client'

type Experiment = z.output<typeof experimentStateSchema>

const EXPERIMENTS_KEY = ['experiments'] as const

const STATUS_LABELS: Record<Experiment['status'], string> = {
  available: 'Available',
  experimental: 'Experimental',
  promoted: 'Promoted',
  unavailable: 'Unavailable',
}

function ExperimentRow({ canManage, experiment }: { canManage: boolean; experiment: Experiment }) {
  const { save } = usePreferences()
  const queryClient = useQueryClient()
  const [state, run] = useSaveState()
  const [adminState, runAdmin] = useSaveState()
  const editable = experiment.userEditable && experiment.status === 'experimental'
  const status = experiment.disabledByAdmin
    ? 'Disabled by an admin'
    : STATUS_LABELS[experiment.status]
  const reason = !experiment.entitled
    ? 'Your plan does not include what this needs.'
    : experiment.disabledByAdmin
      ? 'An owner or admin turned this off for the workspace.'
      : experiment.enforcement

  const toggle = (on: boolean) =>
    run(async () => {
      const result = await save({ experiments: { [experiment.id]: on } })
      if (result.ok) await queryClient.invalidateQueries({ queryKey: EXPERIMENTS_KEY })
      return result
    })
  const setWorkspace = (disabled: boolean) =>
    runAdmin(async () => {
      try {
        const next = await settingsRequest(
          `/api/v1/experiments/${encodeURIComponent(experiment.id)}/workspace`,
          experimentListSchema,
          { body: { disabled }, method: 'PUT' }
        )
        queryClient.setQueryData(EXPERIMENTS_KEY, next)
        return { ok: true }
      } catch (error) {
        return { error: settingsErrorMessage(error), ok: false }
      }
    })

  return (
    <Row
      description={
        <>
          {experiment.description}
          <span className="mt-1 block text-muted-foreground/75">{reason}</span>
        </>
      }
      label={
        <span className="flex flex-wrap items-center gap-2">
          {experiment.name}
          <Pill
            tone={
              experiment.status === 'promoted'
                ? 'green'
                : experiment.status === 'unavailable'
                  ? 'gray'
                  : 'purple'
            }
          >
            {status}
          </Pill>
        </span>
      }
    >
      <div className="flex flex-wrap items-center justify-end gap-3">
        {canManage && experiment.userEditable ? (
          <span className="flex items-center gap-2" aria-label="Workspace preference">
            <SaveStatus state={adminState} />
            <Button
              disabled={adminState === 'saving'}
              onClick={() => void setWorkspace(!experiment.disabledByAdmin)}
              size="sm"
              type="button"
              variant="outline"
            >
              {experiment.disabledByAdmin ? 'Allow in workspace' : 'Turn off for workspace'}
            </Button>
          </span>
        ) : null}
        <span className="flex items-center gap-2" aria-label="Personal preference">
          <SaveStatus state={state} />
          <Switch
            aria-label={`${experiment.name}: ${experiment.enabled ? 'on' : 'off'}`}
            checked={experiment.enabled}
            disabled={
              state === 'saving' || !editable || !experiment.entitled || experiment.disabledByAdmin
            }
            onCheckedChange={(on) => void toggle(on)}
          />
        </span>
      </div>
    </Row>
  )
}

/**
 * Experimental (RFC 024): features you can try before everyone gets them.
 * The list comes from the backend registry, which also enforces each one, so
 * a switch here never overrides a plan, a permission or a provider rule.
 */
export function ExperimentalSettings({ canManage }: { canManage: boolean }) {
  const query = useQuery({
    queryFn: () => settingsRequest('/api/v1/experiments', experimentListSchema),
    queryKey: EXPERIMENTS_KEY,
  })
  if (query.isPending) return <p className="text-sm text-muted-foreground">Loading experiments…</p>
  if (query.isError) {
    return (
      <p className="text-sm text-red-700 dark:text-red-300" role="alert">
        {settingsErrorMessage(query.error)}
      </p>
    )
  }
  return (
    <Group>
      {query.data.items.map((experiment) => (
        <ExperimentRow canManage={canManage} experiment={experiment} key={experiment.id} />
      ))}
    </Group>
  )
}
