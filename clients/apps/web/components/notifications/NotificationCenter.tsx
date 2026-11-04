'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import dynamic from 'next/dynamic'
import { NotificationsIcon } from '@/components/platform-shell/icons'
import { SettingsIcon as SlidersHorizontal } from '@/components/platform-shell/icons'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  notificationRequest,
  useNotificationIdentity,
  useNotificationPageVisible,
} from '@/lib/notifications/client'
import { notificationViewSchema } from '@/lib/notifications/schema'
import { NotificationFeed } from './NotificationFeed'

const WorkspaceNotifications = dynamic(
  () =>
    import('@/components/workspace/WorkspaceNotifications').then(
      (module) => module.WorkspaceNotifications
    ),
  {
    loading: () => <p role="status">Loading notification settings…</p>,
  }
)
const countSchema = z.object({ unseenCount: z.number().int().nonnegative() })
const panelViewSchema = notificationViewSchema.exclude(['all'])
const rememberedTabs = new Map<string, z.infer<typeof panelViewSchema>>()

function subscribeTab(callback: () => void) {
  window.addEventListener('notification-tab', callback)
  return () => window.removeEventListener('notification-tab', callback)
}

/** A floating, keyboard-accessible notification panel that preserves the current page. */
export function NotificationCenter({
  collapsed = true,
  initialIdentity,
}: {
  collapsed?: boolean
  /** The signed-in person and workspace from the server, so the count need not wait for the session. */
  initialIdentity?: { userId: string; workspaceId: string }
}) {
  const identity = useNotificationIdentity(initialIdentity)
  const visible = useNotificationPageVisible()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [settings, setSettings] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const storageKey = `notifications:tab:${identity.userId}:${identity.workspaceId}`
  const view = useSyncExternalStore(
    subscribeTab,
    useCallback(() => {
      try {
        return (
          rememberedTabs.get(storageKey) ??
          panelViewSchema.safeParse(sessionStorage.getItem(storageKey)).data ??
          'inbox'
        )
      } catch {
        return rememberedTabs.get(storageKey) ?? 'inbox'
      }
    }, [storageKey]),
    () => 'inbox'
  )
  function selectTab(value: string) {
    const parsed = panelViewSchema.safeParse(value)
    if (!parsed.success) return
    rememberedTabs.set(storageKey, parsed.data)
    try {
      sessionStorage.setItem(storageKey, parsed.data)
    } catch {
      /* Keep the tab in memory if browser storage is unavailable. */
    }
    window.dispatchEvent(new Event('notification-tab'))
  }
  const count = useQuery({
    queryKey: [...identity.key, 'count'],
    queryFn: ({ signal }) => notificationRequest(identity, '/count', countSchema, { signal }),
    enabled: identity.ready && visible,
    refetchInterval: visible ? 30_000 : false,
    refetchIntervalInBackground: false,
  })
  useEffect(() => {
    if (!('BroadcastChannel' in window)) return
    const channel = new BroadcastChannel('workspace-notifications')
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const parsed = z.object({ userId: z.string(), workspaceId: z.string() }).safeParse(event.data)
      if (
        parsed.success &&
        parsed.data.userId === identity.userId &&
        parsed.data.workspaceId === identity.workspaceId
      )
        void queryClient.invalidateQueries({ queryKey: identity.key })
    }
    return () => channel.close()
  }, [identity.key, identity.userId, identity.workspaceId, queryClient])
  if (!identity.ready) return null
  const n = count.isError ? 0 : (count.data?.unseenCount ?? 0)
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="custom"
            size={null}
            data-platform-action
            ref={trigger}
            type="button"
            aria-label={`Notifications${n ? `, ${n} unread` : ''}`}
            className={`touch-hitbox relative flex h-10 items-center gap-3 rounded-lg px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground ${collapsed ? 'size-8 justify-center px-0' : 'w-full'}`}
          >
            <NotificationsIcon className="size-[18px] shrink-0" aria-hidden="true" />
            {!collapsed ? <span>Notifications</span> : null}
            {n > 0 ? (
              <span
                aria-hidden="true"
                className={
                  collapsed
                    ? 'absolute -right-1 -top-1 min-w-4 rounded-full bg-primary px-1 text-center text-[9px] text-primary-foreground'
                    : 'ml-auto rounded-full bg-primary px-1.5 text-xs text-primary-foreground'
                }
              >
                {n > 99 ? '99+' : n}
              </span>
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          onCloseAutoFocus={(event) => {
            if (settings) event.preventDefault()
          }}
          aria-label="Notifications"
          align="start"
          side="bottom"
          sideOffset={12}
          collisionPadding={12}
          className="platform-overlay flex h-[min(38rem,calc(100dvh-6rem))] w-[min(25rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-xl p-0"
        >
          <Tabs value={view} onValueChange={selectTab} className="min-h-0 flex-1 gap-0">
            <div className="flex items-center justify-between gap-2 border-b p-3">
              <TabsList aria-label="Notification feeds" className="h-9">
                <TabsTrigger value="inbox">Inbox</TabsTrigger>
                <TabsTrigger value="activity">Activity</TabsTrigger>
                <TabsTrigger value="archive">Archive</TabsTrigger>
              </TabsList>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Notification settings"
                onClick={() => {
                  setOpen(false)
                  setSettings(true)
                }}
              >
                <SlidersHorizontal className="size-4" />
              </Button>
            </div>
            {panelViewSchema.options.map((tab) => (
              <TabsContent
                key={tab}
                value={tab}
                className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
              >
                {open && view === tab ? (
                  <NotificationFeed
                    key={`${identity.userId}:${identity.workspaceId}:${tab}`}
                    identity={identity}
                    view={tab}
                    close={() => setOpen(false)}
                  />
                ) : null}
              </TabsContent>
            ))}
          </Tabs>
        </PopoverContent>
      </Popover>
      <Dialog open={settings} onOpenChange={setSettings}>
        <DialogContent
          className="platform-overlay max-h-[90dvh] overflow-y-auto sm:max-w-4xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            trigger.current?.focus()
          }}
        >
          <DialogHeader>
            <DialogTitle>Notification settings</DialogTitle>
            <DialogDescription>Choose the updates you receive in this workspace.</DialogDescription>
          </DialogHeader>
          {settings ? <WorkspaceNotifications /> : null}
        </DialogContent>
      </Dialog>
    </>
  )
}
