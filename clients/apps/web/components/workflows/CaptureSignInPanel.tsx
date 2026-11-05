'use client'

import { Button } from '@/components/ui/button'
import type { CaptureConnectStart } from '@/lib/api/contracts/capture'

/**
 * The one-time sign-in link, held in the row's state only and dropped once
 * finished. `ph-no-capture` keeps PostHog autocapture from recording its href.
 */
export function SignInPanel({
  busy,
  onFinish,
  start,
}: {
  busy: boolean
  onFinish: () => void
  start: CaptureConnectStart
}) {
  return (
    <div className="space-y-3 rounded-lg border p-3 text-sm">
      <p className="text-muted-foreground">
        Sign in as the demo account in the new window, then come back here. The window expires at{' '}
        {new Date(start.expiresAt).toLocaleTimeString()}.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm" variant="outline">
          <a
            className="ph-no-capture"
            href={start.liveViewUrl}
            referrerPolicy="no-referrer"
            rel="noopener noreferrer"
            target="_blank"
          >
            Open sign-in window
          </a>
        </Button>
        <Button disabled={busy} onClick={onFinish} size="sm" type="button">
          I&apos;ve signed in
        </Button>
      </div>
    </div>
  )
}
