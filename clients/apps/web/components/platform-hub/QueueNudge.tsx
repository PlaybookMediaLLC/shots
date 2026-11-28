'use client'

import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { useNewPost } from '@/components/write/pending-draft'

type WeeklyGoalSummary = {
  goal: number
  publishedCount: number
  scheduledCount: number
  totalCount: number
}

/**
 * A gentle prompt on Home showing weekly posting goal progress (when configured)
 * and nudging when fewer than three posts are queued for the next seven days.
 */
export function QueueNudge({
  queued,
  weeklyGoal,
}: {
  queued: number
  weeklyGoal?: WeeklyGoalSummary | null
}) {
  const newPost = useNewPost()
  const showLowQueue = queued < 3
  if (!showLowQueue && !weeklyGoal) return null
  const pct = weeklyGoal ? Math.min(100, Math.round((weeklyGoal.totalCount / weeklyGoal.goal) * 100)) : 0

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
      {weeklyGoal ? (
        <Link
          className="flex items-center gap-3 rounded-lg border border-border px-3 py-1.5 text-xs transition-colors hover:bg-muted/50"
          data-testid="home-weekly-goal"
          href="/settings/publishing-preferences"
        >
          <span>
            Weekly goal:{' '}
            <strong className="text-foreground">
              {weeklyGoal.totalCount} / {weeklyGoal.goal}
            </strong>{' '}
            ({weeklyGoal.publishedCount} published · {weeklyGoal.scheduledCount} scheduled)
          </span>
          <span
            aria-hidden="true"
            className="h-1.5 w-16 overflow-hidden rounded-full bg-muted"
          >
            <span className="block h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
          </span>
        </Link>
      ) : null}
      {showLowQueue ? (
        <p className="flex flex-wrap items-center gap-3" data-testid="queue-nudge" role="status">
          {queued === 0
            ? 'Nothing is queued for the next 7 days.'
            : `Only ${queued} post${queued === 1 ? '' : 's'} queued for the next 7 days.`}
          <Button onClick={newPost} size="sm" variant="outline">
            Write one now
          </Button>
        </p>
      ) : null}
    </div>
  )
}
