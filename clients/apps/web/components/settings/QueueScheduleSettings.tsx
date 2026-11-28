'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { Group, PlanRequired, Row } from '@/components/platform-ui'
import { useSocialSets } from '@/components/settings/social-sets/api'
import { SchedulingPage } from '@/components/settings/social-sets/SchedulingPage'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { socialSetHref } from '@/components/workspace/settings-sections'
import { isPlanRefusal } from '@/lib/api/platform-errors'
import { SettingsRequestError, settingsErrorMessage } from '@/lib/settings/client'

/**
 * Top-level Queue Schedule settings (`/settings/queue-schedule`): lets a user
 * pick a publishing profile and manage its weekly queue slots, time zone, and
 * randomized posting time window directly without drilling into a profile first.
 */
export function QueueScheduleSettings({
  canManage,
  weeklyPostingGoal,
}: {
  canManage: boolean
  weeklyPostingGoal: number | null
}) {
  const sets = useSocialSets()
  const [selectedId, setSelectedId] = useState<string>('')

  const items = useMemo(() => sets.data?.items ?? [], [sets.data?.items])
  const activeSet = useMemo(() => {
    if (items.length === 0) return null
    return items.find((item) => item.id === selectedId) ?? items[0]!
  }, [items, selectedId])

  if (sets.isPending) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Loading queue schedules…
      </p>
    )
  }

  if (isPlanRefusal(sets.error)) {
    return (
      <PlanRequired from="/settings/queue-schedule">
        Queue schedules and weekly posting slots require Pro.
      </PlanRequired>
    )
  }

  if (sets.error instanceof SettingsRequestError && sets.error.status === 404) {
    return (
      <Group>
        <Row
          description="Content drafts and queue schedules are not enabled for this workspace."
          label="Queue schedule"
          layout="stacked"
        >
          <p className="text-sm text-muted-foreground">
            Contact your administrator if you expect queue scheduling to be available.
          </p>
        </Row>
      </Group>
    )
  }

  if (sets.isError) {
    return (
      <div className="grid gap-2">
        <p className="text-sm text-red-700 dark:text-red-300" role="alert">
          {settingsErrorMessage(sets.error)}
        </p>
        <div>
          <Button onClick={() => void sets.refetch()} type="button" variant="outline">
            Retry
          </Button>
        </div>
      </div>
    )
  }

  if (!activeSet) {
    return (
      <Group>
        <Row
          description="Create a publishing profile first to configure its weekly posting queue slots."
          label="No profiles yet"
          layout="stacked"
        >
          <div>
            <Button asChild variant="outline">
              <Link href="/settings/publishing-brands">Create a profile</Link>
            </Button>
          </div>
        </Row>
      </Group>
    )
  }

  const slotGap =
    weeklyPostingGoal !== null && activeSet.weeklySlotCount < weeklyPostingGoal
      ? weeklyPostingGoal - activeSet.weeklySlotCount
      : 0

  return (
    <div className="grid gap-6">
      <Group>
        <Row
          description={
            items.length > 1
              ? 'Each publishing profile has its own weekly posting slots, time zone, and randomize posting window.'
              : 'Your active publishing profile. Manage its accounts, defaults, and voice from Profiles.'
          }
          label="Publishing profile"
        >
          <div className="flex flex-wrap items-center gap-2">
            {items.length > 1 ? (
              <Select onValueChange={setSelectedId} value={activeSet.id}>
                <SelectTrigger aria-label="Select publishing profile" className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {items.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name} ({item.weeklySlotCount} slot{item.weeklySlotCount === 1 ? '' : 's'})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                <span
                  aria-hidden
                  className="size-2.5 rounded-full"
                  style={{ backgroundColor: activeSet.color }}
                />
                {activeSet.name}
              </span>
            )}
            <Button asChild size="sm" variant="outline">
              <Link href={socialSetHref(activeSet.id, 'scheduling')}>Profile settings</Link>
            </Button>
          </div>
        </Row>
        {weeklyPostingGoal !== null ? (
          <Row
            description={
              slotGap > 0
                ? `Your workspace weekly goal is ${weeklyPostingGoal} post${weeklyPostingGoal === 1 ? '' : 's'}/week, and ${activeSet.name} currently has ${activeSet.weeklySlotCount} slot${activeSet.weeklySlotCount === 1 ? '' : 's'}. Add ${slotGap} more slot${slotGap === 1 ? '' : 's'} to fill your goal automatically.`
                : `Your workspace weekly goal is ${weeklyPostingGoal} post${weeklyPostingGoal === 1 ? '' : 's'}/week, covered by ${activeSet.weeklySlotCount} weekly slot${activeSet.weeklySlotCount === 1 ? '' : 's'}.`
            }
            label="Weekly goal alignment"
          >
            <Button asChild size="sm" variant="ghost">
              <Link href="/settings/publishing-preferences">Edit goal</Link>
            </Button>
          </Row>
        ) : null}
      </Group>

      <SchedulingPage canManage={canManage} key={activeSet.id} set={activeSet} />
    </div>
  )
}
