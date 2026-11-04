'use client'

import { Button } from '@/components/ui/button'
import { useNewPost } from '@/components/write/pending-draft'

/**
 * A gentle prompt on Home when fewer than three posts are queued for the
 * next seven days: one click starts a draft, as New → Post does.
 */
export function QueueNudge({ queued }: { queued: number }) {
  const newPost = useNewPost()
  return (
    <p
      className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground"
      data-testid="queue-nudge"
      role="status"
    >
      {queued === 0
        ? 'Nothing is queued for the next 7 days.'
        : `Only ${queued} post${queued === 1 ? '' : 's'} queued for the next 7 days.`}
      <Button onClick={newPost} size="sm" variant="outline">
        Write one now
      </Button>
    </p>
  )
}
