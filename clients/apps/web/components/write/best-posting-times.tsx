'use client'

import { useState } from 'react'
import { LocalTime, useHydrated } from '@/components/drafts/local-time'
import { useRouter } from 'next/navigation'
import type { BackendBestTime } from 'screenshot-studio-backend-sdk'
import { Button } from '@/components/ui/button'
import { call } from '@/lib/content-drafts/client'
import type { SocialSetWire } from '@/lib/write/client'
import { dayOfWeek, zonedDayKey, zonedParts } from '@/lib/settings/zoned-time'

/** Explain observed timing scores and explicitly add a suggestion to future queue slots. */
export function BestPostingTimes({
  items,
  setId,
  timeZone,
  canManage,
}: {
  items: BackendBestTime[]
  setId: string
  timeZone: string
  canManage: boolean
}) {
  const router = useRouter()
  const hydrated = useHydrated()
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const maximum = Math.max(1, ...items.map((item) => item.score ?? 0))
  const add = async (at: string) => {
    setBusy(at)
    setMessage('')
    try {
      const current = await call<SocialSetWire>(`/api/v1/social-sets/${setId}`)
      if (current.timeZone !== timeZone)
        throw new Error('The profile’s time zone changed. Reload these suggestions first.')
      const date = new Date(at)
      const parts = zonedParts(date, timeZone)
      const slot = {
        weekday: dayOfWeek(zonedDayKey(date, timeZone)),
        time: `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`,
      }
      if (
        current.postingSlots.some(
          (item) => item.weekday === slot.weekday && item.time === slot.time
        )
      ) {
        setMessage('This time is already in the posting schedule.')
        return
      }
      await call(`/api/v1/social-sets/${setId}/queue`, {
        method: 'PATCH',
        body: { baseVersion: current.version, postingSlots: [...current.postingSlots, slot] },
      })
      setMessage('Added to the weekly posting schedule.')
      router.refresh()
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'The posting schedule could not be changed.'
      )
    } finally {
      setBusy('')
    }
  }
  return (
    <section aria-label="Best posting times" className="rounded border p-4">
      <h2 className="text-lg font-medium">Best posting times</h2>
      <p className="text-sm text-muted-foreground">
        {timeZone}. Scores average observed engagement per post: replies/comments/quotes ×3,
        reposts/shares ×2, and likes/reactions/bookmarks ×1.
      </p>
      <ul className="mt-4 grid gap-4 sm:grid-cols-3">
        {items.map((item) => (
          <li key={item.at} className="grid content-start gap-2">
            <strong className="text-sm">
              <LocalTime
                options={{ weekday: 'long', hour: 'numeric', minute: '2-digit' }}
                value={item.at}
                zone={timeZone}
              />
            </strong>
            {item.score !== undefined ? (
              <>
                <div
                  role="img"
                  aria-label={`Average engagement score ${item.score.toFixed(1)} from ${item.samplePosts} posts`}
                  className="h-3 rounded bg-muted"
                >
                  <div
                    className="h-full rounded bg-sky-500"
                    style={{ width: `${(item.score / maximum) * 100}%` }}
                  />
                </div>
                <span className="text-xs">
                  {item.score.toFixed(1)} · {item.samplePosts} observed posts
                </span>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">No personalized score yet.</p>
            )}
            <p className="text-xs text-muted-foreground">{item.reason}</p>
            {canManage && (
              <Button
                variant="outline"
                size="sm"
                disabled={!hydrated || Boolean(busy)}
                onClick={() => void add(item.at)}
              >
                {busy === item.at ? 'Adding…' : '+ Add weekly slot'}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {message && (
        <p role="status" className="mt-3 text-sm">
          {message}
        </p>
      )}
    </section>
  )
}
