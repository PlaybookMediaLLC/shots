'use client'

import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { useHydratedSession } from '@/lib/auth/client'

/**
 * Cache identity follows both the authenticated person and active workspace.
 * `initial`, from the server's render, stands in until the session loads, so
 * the first reads need not wait for it. It also holds the workspace: when another
 * tab switches the browser's active one, this page still shows its own.
 */
export function useNotificationIdentity(initial?: { userId: string; workspaceId: string }) {
  const { data, isPending } = useHydratedSession()
  const fallback = isPending ? initial : undefined
  const userId = data?.user.id ?? fallback?.userId ?? ''
  const workspaceId = initial?.workspaceId ?? data?.session.activeOrganizationId ?? ''
  const queryClient = useQueryClient()
  const key = useMemo(
    () => ['workspace-notifications', userId, workspaceId] as const,
    [userId, workspaceId]
  )
  useEffect(() => {
    const predicate = (query: { queryKey: readonly unknown[] }) =>
      query.queryKey[0] === 'workspace-notifications' &&
      (query.queryKey[1] !== userId || query.queryKey[2] !== workspaceId)
    void queryClient.cancelQueries({ predicate })
    queryClient.removeQueries({ predicate })
  }, [queryClient, userId, workspaceId])

  return useMemo(
    () => ({
      userId,
      workspaceId,
      ready: (!isPending || Boolean(fallback)) && !!userId && !!workspaceId,
      key,
    }),
    [userId, workspaceId, isPending, fallback, key]
  )
}

function subscribeVisibility(notify: () => void) {
  document.addEventListener('visibilitychange', notify)
  return () => document.removeEventListener('visibilitychange', notify)
}

/** Poll only while the page is visible. */
export function useNotificationPageVisible() {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState === 'visible',
    () => false
  )
}

/** Preserve HTTP status so permission failures are distinct from retryable reads. */
export class NotificationRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'NotificationRequestError'
  }
}

/** Fetch a scoped contract without retaining responses in the browser HTTP cache. */
export async function notificationRequest<S extends z.ZodType>(
  identity: { workspaceId: string; userId: string },
  path: string,
  schema: S,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {}
): Promise<z.output<S>> {
  const response = await fetch(`/api/workspace/notifications${path}`, {
    cache: 'no-store',
    credentials: 'same-origin',
    method: options.method,
    signal: options.signal,
    headers: {
      'content-type': 'application/json',
      'x-notification-workspace': identity.workspaceId,
      'x-notification-user': identity.userId,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const failure = z
      .object({ error: z.string().optional(), message: z.string().optional() })
      .safeParse(body)
    throw new NotificationRequestError(
      response.status === 401
        ? 'Your session has expired. Sign in again to view notifications.'
        : response.status === 403
          ? 'You no longer have access to these notifications. Reopen them in your current workspace.'
          : failure.success
            ? (failure.data.error ?? failure.data.message ?? 'The request failed. Try again.')
            : 'The request failed. Try again.',
      response.status
    )
  }
  return schema.parse(body)
}
