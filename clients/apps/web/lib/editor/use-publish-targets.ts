'use client'

import * as React from 'react'
import { DraftRequestError, draftsApi } from '@/lib/content-drafts/client'
import { isPublishChannel, type PublishAccount } from '@/lib/editor/publish'
import { type SocialSetListWire, writeApi } from '@/lib/write/client'
import type { DraftChannel } from '@/lib/write/document'

/**
 * Where the editor can publish: the workspace's social sets with their
 * connected accounts, and the times the workspace's own engagement
 * recommends for the chosen set. Both come from the APIs Publish already
 * uses, so the editor and the composer offer the same destinations and the
 * same suggestions.
 *
 * A workspace whose plan or rollout excludes content drafts is refused
 * outright (403 or 404) and the surface that asked is hidden. Any other
 * failure is a failure to load, which says so and can be tried again,
 * rather than quietly looking like a workspace with no accounts.
 */

/** One publishing identity as the editor offers it. */
export type PublishSet = {
  accounts: PublishAccount[]
  /** The platforms a new draft in this set starts with (RFC 024). */
  defaultChannels: DraftChannel[]
  id: string
  name: string
  timeZone: string
}

/** A time the workspace's engagement recommends, with why. */
export type RecommendedTime = { at: string; reason: string }

/** A set and its accounts, keeping only the platforms the editor writes captions for. */
function publishSets(list: SocialSetListWire): PublishSet[] {
  return list.items.map((set) => ({
    accounts: set.accounts.flatMap((account) =>
      isPublishChannel(account.platform)
        ? [
            {
              channel: account.platform,
              id: account.id,
              name: account.handle ?? account.displayName ?? account.platform,
            },
          ]
        : []
    ),
    defaultChannels: set.defaultPlatforms.filter(isPublishChannel),
    id: set.id,
    name: set.name,
    timeZone: set.timeZone,
  }))
}

/** How far the set list has got: publishing is off, loading, loaded, or broken. */
export type PublishSetsStatus = 'unavailable' | 'loading' | 'ready' | 'error'

/** Whether this workspace has no publishing at all, rather than a bad request. */
function refused(error: unknown): boolean {
  return error instanceof DraftRequestError && (error.status === 403 || error.status === 404)
}

/** The sets the signed-in member can publish to, loaded once per opening. */
export function usePublishSets(enabled: boolean): {
  sets: PublishSet[]
  status: PublishSetsStatus
} {
  const [sets, setSets] = React.useState<PublishSet[] | null>(null)
  const [failure, setFailure] = React.useState<'unavailable' | 'error' | null>(null)
  // Settled once the list arrived or the workspace was refused; anything
  // else is tried again the next time the surface opens, without the state
  // itself retriggering the request.
  const settled = React.useRef(false)
  React.useEffect(() => {
    if (!enabled || settled.current) return
    let active = true
    void writeApi.sets().then(
      (list) => {
        settled.current = true
        if (!active) return
        setFailure(null)
        setSets(publishSets(list))
      },
      (error: unknown) => {
        const off = refused(error)
        settled.current = off
        if (active) setFailure(off ? 'unavailable' : 'error')
      }
    )
    return () => {
      active = false
    }
  }, [enabled])
  return { sets: sets ?? [], status: sets ? 'ready' : (failure ?? 'loading') }
}

/**
 * The recommended posting times for a set: the same analysis of past
 * engagement the composer's scheduler offers, so a time chosen in the editor
 * is a time Analytics would have suggested.
 *
 * The answer is absolute instants in the near future, so it is read again
 * each time the surface is shown: an editor left open all afternoon must not
 * offer a slot that has already passed. Times belong to the set they were
 * read for, so switching sets never shows another set's slots.
 */
export function useRecommendedTimes(
  socialSetId: string | undefined,
  visible: boolean
): RecommendedTime[] {
  const [read, setRead] = React.useState<{ id: string; times: RecommendedTime[] } | null>(null)
  React.useEffect(() => {
    if (!socialSetId || !visible) return
    let active = true
    void draftsApi.bestTimes(socialSetId).then(
      ({ items }) => {
        if (active) setRead({ id: socialSetId, times: items })
      },
      () => {
        if (active) setRead({ id: socialSetId, times: [] })
      }
    )
    return () => {
      active = false
    }
  }, [socialSetId, visible])
  return read && read.id === socialSetId ? read.times : []
}
