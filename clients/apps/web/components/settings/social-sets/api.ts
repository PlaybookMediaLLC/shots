'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useRef } from 'react'
import { toast } from 'sonner'
import type { z } from 'zod'
import type { SaveResult } from '@/components/settings/PreferencesProvider'
import {
  socialSetListSchema,
  socialSetSchema,
  type socialSetUpdateSchema,
} from '@/lib/api/contracts/social-sets'
import { SettingsRequestError, settingsErrorMessage } from '@/lib/settings/client'
import { socialSetKey, useSocialSetScope } from './scope'

export { socialSetKey, useSocialSetScope } from './scope'

/** A social set as the API returns it. */
export type SocialSetRecord = z.output<typeof socialSetSchema>

/** A set settings save, without the version the hook adds. */
export type SocialSetChange = Omit<z.input<typeof socialSetUpdateSchema>, 'baseVersion'>

/** The sets you can see, accounts in no set, and orphaned private sets. */
export function useSocialSets() {
  const scope = useSocialSetScope()
  const query = useQuery({
    enabled: scope.ready,
    queryFn: ({ signal }) => scope.request('/api/v1/social-sets', socialSetListSchema, { signal }),
    queryKey: scope.key,
  })
  return query.isError ? { ...query, data: undefined } : query
}

/** One set. */
export function useSocialSet(id: string) {
  const scope = useSocialSetScope()
  const query = useQuery({
    enabled: scope.ready && !!id,
    queryFn: ({ signal }) =>
      scope.request(`/api/v1/social-sets/${encodeURIComponent(id)}`, socialSetSchema, { signal }),
    queryKey: socialSetKey(scope, id),
    retry: (count, error) =>
      !(error instanceof SettingsRequestError && error.status === 404) && count < 2,
  })
  return query.isError ? { ...query, data: undefined } : query
}

/**
 * Saves a set's settings one change at a time, each based on the version the
 * last save returned, so quick edits never overwrite each other. A save made
 * against a version someone else moved past reloads the set and says so.
 */
export function useSaveSocialSet(id: string): (change: SocialSetChange) => Promise<SaveResult> {
  const queryClient = useQueryClient()
  const scope = useSocialSetScope()
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  return useCallback(
    (change: SocialSetChange) => {
      const run = queue.current.then(async (): Promise<SaveResult> => {
        if (!scope.ready) return { error: 'Your workspace is still loading.', ok: false }
        const current = queryClient.getQueryData<SocialSetRecord>(socialSetKey(scope, id))
        if (!current) return { error: 'This profile is still loading.', ok: false }
        try {
          const saved = await scope.request(
            `/api/v1/social-sets/${encodeURIComponent(id)}`,
            socialSetSchema,
            {
              body: { ...change, baseVersion: current.version },
              method: 'PATCH',
            }
          )
          queryClient.setQueryData(socialSetKey(scope, id), saved)
          await queryClient.invalidateQueries({ exact: true, queryKey: scope.key })
          scope.assertCurrent()
          return { ok: true }
        } catch (error) {
          if (
            error instanceof SettingsRequestError &&
            error.status === 409 &&
            error.code !== 'workspace_changed'
          ) {
            await queryClient.invalidateQueries({ queryKey: socialSetKey(scope, id) })
            toast.info('Someone else changed this profile. Showing the latest version.')
          }
          return { error: settingsErrorMessage(error), ok: false }
        }
      })
      queue.current = run.catch(() => undefined)
      return run
    },
    [id, queryClient, scope]
  )
}

/** Puts a fresh set into the cache after an action that returns one. */
export function useStoreSocialSet() {
  const queryClient = useQueryClient()
  const scope = useSocialSetScope()
  return useCallback(
    async (set: SocialSetRecord) => {
      scope.assertCurrent()
      queryClient.setQueryData(socialSetKey(scope, set.id), set)
      await queryClient.invalidateQueries({ exact: true, queryKey: scope.key })
      scope.assertCurrent()
    },
    [queryClient, scope]
  )
}

/** Where to send someone to connect an account on a platform to a set. */
export function connectHref(
  provider: string,
  socialSetId: string,
  expectedConnectionId?: string
): string {
  const query = new URLSearchParams({ socialSet: socialSetId })
  if (expectedConnectionId) query.set('reconnect', expectedConnectionId)
  return `/integrations/social/${encodeURIComponent(provider)}/start?${query}`
}

/** The OAuth providers a set can connect from settings, by label. */
export const CONNECT_PROVIDERS = [
  { label: 'X', platform: 'x', provider: 'x' },
  { label: 'LinkedIn', platform: 'linkedin', provider: 'linkedin' },
  { label: 'LinkedIn Page', platform: 'linkedin-page', provider: 'linkedin-page' },
  { label: 'TikTok', platform: 'tiktok', provider: 'tiktok' },
  { label: 'YouTube', platform: 'youtube', provider: 'youtube' },
  { label: 'Instagram', platform: 'instagram-standalone', provider: 'instagram-standalone' },
  { label: 'Threads', platform: 'threads', provider: 'threads' },
  { label: 'Mastodon', platform: 'mastodon', provider: 'mastodon' },
] as const

/**
 * Whether a profile still has the name the backend gave it with its first
 * account (publishing/oauth_creation.go), or the name it used to give.
 */
export function hasDefaultProfileName(name: string): boolean {
  return name === 'New profile' || name === 'New brand'
}

/** What to tell someone about an account that is not connected. */
export const HEALTH_GUIDANCE: Record<SocialSetRecord['accounts'][number]['health'], string> = {
  connected: 'Connected and ready to publish.',
  unverified: 'The account’s credentials could not be verified. Reconnect it before publishing.',
  expired: "The account's access expired. Reconnect it to publish again.",
  permission_required:
    'The platform needs one more step, such as choosing a page. Reconnect to finish it.',
  reconnect_required:
    'The platform asked for this account to be connected again. Reconnect it to keep publishing.',
  removed: 'This account was removed from the set and cannot publish.',
  revoked: 'Access was revoked on the platform. Reconnect it, or remove it from this set.',
}

/** The provider a connected platform reconnects through. */
export function providerFor(platform: string): string | null {
  if (platform === 'bluesky') return 'bluesky'
  return (
    CONNECT_PROVIDERS.find((provider) => provider.platform === platform)?.provider ??
    (platform === 'instagram' ? 'instagram' : null)
  )
}
