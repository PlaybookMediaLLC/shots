'use client'

import { useEffect, useRef } from 'react'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { z } from 'zod'
import { ArchiveIcon as Archive } from '@phosphor-icons/react/dist/ssr/Archive'
import { TrayArrowUpIcon as ArchiveRestore } from '@phosphor-icons/react/dist/ssr/TrayArrowUp'
import { ChecksIcon as CheckCheck } from '@phosphor-icons/react/dist/ssr/Checks'
import { EnvelopeIcon as Mail } from '@phosphor-icons/react/dist/ssr/Envelope'
import { EnvelopeOpenIcon as MailOpen } from '@phosphor-icons/react/dist/ssr/EnvelopeOpen'
import { Button } from '@/components/ui/button'
import {
  NotificationRequestError,
  notificationRequest,
  useNotificationIdentity,
} from '@/lib/notifications/client'
import {
  notificationPageSchema,
  notificationStateResultSchema,
  type NotificationStateInput,
  type NotificationView,
} from '@/lib/notifications/schema'

/** Paged receipt controls; every visible state comes from the authoritative backend. */
export function NotificationFeed({
  identity,
  view,
  close,
}: {
  identity: ReturnType<typeof useNotificationIdentity>
  view: NotificationView
  close: () => void
}) {
  const queryClient = useQueryClient()
  const router = useRouter()
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const listKey = [...identity.key, 'feed', view]
  const retry = useRef<NotificationStateInput | null>(null)
  const feed = useInfiniteQuery({
    queryKey: listKey,
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) =>
      notificationRequest(
        identity,
        `/inbox?view=${view}&cursor=${encodeURIComponent(pageParam)}`,
        notificationPageSchema,
        { signal }
      ),
    getNextPageParam: (page) => page.nextCursor || undefined,
    staleTime: 0,
    refetchInterval: 30_000,
    retry: (failures, error) =>
      !(error instanceof NotificationRequestError && [401, 403, 404].includes(error.status)) &&
      failures < 2,
  })
  const change = useMutation({
    mutationFn: (input: NotificationStateInput) =>
      notificationRequest(identity, '/state', notificationStateResultSchema, {
        method: 'POST',
        body: input,
      }),
    onSuccess: async (result) => {
      retry.current = null
      queryClient.setQueryData([...identity.key, 'count'], { unseenCount: result.unseenCount })
      await queryClient.invalidateQueries({ queryKey: identity.key })
      if ('BroadcastChannel' in window) {
        const channel = new BroadcastChannel('workspace-notifications')
        channel.postMessage({ userId: identity.userId, workspaceId: identity.workspaceId })
        channel.close()
      }
    },
  })
  const navigate = useMutation({
    mutationFn: (id: string) =>
      notificationRequest(
        identity,
        `/resolve/${encodeURIComponent(id)}`,
        z.object({ href: z.string() })
      ),
    onSuccess: (result) => {
      if (live.current && result.href) {
        close()
        router.push(result.href)
      }
    },
  })
  const items = feed.isError ? [] : (feed.data?.pages.flatMap((page) => page.items) ?? [])
  const uniqueItems = [...new Map(items.map((item) => [item.id, item])).values()]
  const busy = change.isPending
  function mutate(action: NotificationStateInput['action'], ids: string[] = []) {
    const input = { action, ids, all: ids.length === 0, view, key: crypto.randomUUID() }
    retry.current = input
    change.mutate(input)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {uniqueItems.length ? (
        <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
          <span className="text-xs text-muted-foreground">
            {view === 'archive' ? 'Saved for later' : 'Your updates'}
          </span>
          <div className="flex gap-1">
            {view === 'archive' ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => mutate('restore')}>
                <ArchiveRestore className="size-3.5" />
                Restore all
              </Button>
            ) : (
              <>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => mutate('read')}>
                  <CheckCheck className="size-3.5" />
                  Read all
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => mutate('archive')}>
                  <Archive className="size-3.5" />
                  Archive all
                </Button>
              </>
            )}
          </div>
        </div>
      ) : null}
      {change.isError ? (
        <div role="alert" className="border-b px-4 py-3 text-sm text-destructive">
          {change.error.message}
          <Button
            size="sm"
            variant="outline"
            className="ml-2"
            onClick={() => {
              if (retry.current) change.mutate(retry.current)
            }}
          >
            Retry change
          </Button>
        </div>
      ) : null}
      {navigate.isError || (navigate.isSuccess && !navigate.data.href) ? (
        <p role="alert" className="px-4 py-3 text-sm text-muted-foreground">
          This activity is no longer available. It may have moved or your access may have changed.
        </p>
      ) : null}
      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        aria-busy={feed.isFetching}
      >
        {feed.isPending ? (
          <p role="status" className="px-5 py-12 text-center text-sm text-muted-foreground">
            Loading notifications…
          </p>
        ) : null}
        {feed.isError ? (
          <div role="alert" className="space-y-3 px-5 py-8 text-sm">
            <p>{feed.error.message}</p>
            <Button size="sm" variant="outline" onClick={() => void feed.refetch()}>
              Retry loading
            </Button>
          </div>
        ) : null}
        {!feed.isPending && !feed.isError && uniqueItems.length === 0 ? (
          <div
            data-notification-empty
            className="flex flex-col items-center gap-3 px-6 py-16 text-center"
          >
            {view === 'archive' ? (
              <Archive className="size-7 text-muted-foreground/50" />
            ) : (
              <MailOpen className="size-7 text-muted-foreground/50" />
            )}
            <p className="text-ui-lg font-medium">No notifications</p>
            <p className="max-w-60 text-xs leading-relaxed text-muted-foreground">
              {view === 'archive'
                ? 'Restore archived updates to their original feed.'
                : view === 'inbox'
                  ? 'Comments, mentions, and reviews will appear here.'
                  : 'Publishing and account updates will appear here.'}
            </p>
          </div>
        ) : null}
        <ul className="divide-y divide-border/60">
          {uniqueItems.map((item) => (
            <li
              key={item.id}
              data-notification-id={item.id}
              className={`group px-4 py-4 ${!item.readAt ? 'bg-primary/[0.035]' : ''}`}
            >
              <div className="flex items-start gap-2.5">
                <span
                  aria-label={item.readAt ? 'Read' : 'Unread'}
                  className={`mt-1.5 size-1.5 shrink-0 rounded-full ${item.readAt ? 'bg-transparent' : 'bg-primary'}`}
                />
                <div className="min-w-0 flex-1">
                  <p
                    className={`text-sm leading-relaxed ${item.readAt ? 'text-muted-foreground' : 'font-medium text-foreground'}`}
                  >
                    {item.description}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {item.sourceSocialSet ? (
                      <>
                        <span data-social-set-id={item.sourceSocialSet.id}>
                          {item.sourceSocialSet.name}
                        </span>
                        {' · '}
                      </>
                    ) : null}
                    {item.workspaceName} ·{' '}
                    <time
                      dateTime={item.createdAt}
                      title={new Date(item.createdAt).toLocaleString()}
                    >
                      {new Date(item.createdAt).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </time>
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-1">
                    {item.href ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={navigate.isPending}
                        onClick={() => navigate.mutate(item.id)}
                      >
                        Open activity
                      </Button>
                    ) : null}
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8"
                      aria-label={item.readAt ? 'Mark unread' : 'Mark read'}
                      disabled={busy}
                      onClick={() => mutate(item.readAt ? 'unread' : 'read', [item.id])}
                    >
                      {item.readAt ? <Mail className="size-4" /> : <MailOpen className="size-4" />}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8"
                      aria-label={item.archivedAt ? 'Restore notification' : 'Archive notification'}
                      disabled={busy}
                      onClick={() => mutate(item.archivedAt ? 'restore' : 'archive', [item.id])}
                    >
                      {item.archivedAt ? (
                        <ArchiveRestore className="size-4" />
                      ) : (
                        <Archive className="size-4" />
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
        {feed.hasNextPage ? (
          <div className="p-4">
            <Button
              className="w-full"
              size="sm"
              variant="outline"
              disabled={feed.isFetchingNextPage}
              onClick={() => void feed.fetchNextPage()}
            >
              {feed.isFetchingNextPage ? 'Loading…' : 'Load older activity'}
            </Button>
          </div>
        ) : null}
      </div>
      <span role="status" className="sr-only">
        {change.isSuccess ? 'Notification updated.' : ''}
      </span>
    </div>
  )
}
