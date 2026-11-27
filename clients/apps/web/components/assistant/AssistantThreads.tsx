'use client'

import { useRef, useState } from 'react'
import { ClockCounterClockwiseIcon } from '@phosphor-icons/react/dist/ssr/ClockCounterClockwise'
import { MagnifyingGlassIcon } from '@phosphor-icons/react/dist/ssr/MagnifyingGlass'
import { TrashIcon } from '@phosphor-icons/react/dist/ssr/Trash'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTRPCClient } from '@/lib/trpc/react'
import { cn } from '@/lib/utils'
import {
  queueChatWrite,
  resumeAssistantThread,
  startAssistantOver,
  useAssistantStore,
} from './assistant-store'

type ThreadItem = { id: string; title: string; updatedAt?: string }

function relativeTime(iso?: string): string {
  if (!iso) return ''
  const diffMs = Date.now() - Date.parse(iso)
  if (!Number.isFinite(diffMs) || diffMs < 60_000) return 'now'
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** Searchable list of the person's saved assistant threads in this workspace. */
export function AssistantThreads({ abilityId, disabled }: { abilityId: string; disabled: boolean }) {
  const client = useTRPCClient()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [threads, setThreads] = useState<ThreadItem[] | null>(null)
  const current = useAssistantStore((state) => state.threadId)
  const loadSeqRef = useRef(0)

  const load = () => {
    const seq = ++loadSeqRef.current
    const orgId = useAssistantStore.getState().organizationId
    return queueChatWrite(() => client.assistantThread.list.query()).then(
      (items) => {
        if (seq !== loadSeqRef.current || useAssistantStore.getState().organizationId !== orgId)
          return
        setThreads(items)
      },
      () => {
        if (seq !== loadSeqRef.current) return
        setThreads([])
        toast.error('Saved chats could not load.')
      }
    )
  }

  const resume = (id: string) => {
    const { memory, organizationId } = useAssistantStore.getState()
    setOpen(false)
    return client.assistantThread.get.query({ id }).then(
      (thread) => {
        const now = useAssistantStore.getState()
        // Sent, switched workspace, or started over while it loaded: leave what is shown.
        if (now.controller || now.memory !== memory || now.organizationId !== organizationId) return
        resumeAssistantThread(abilityId, thread.id, thread.entries)
      },
      () => toast.error('That chat could not open.')
    )
  }

  const remove = (id: string) => {
    loadSeqRef.current += 1
    setThreads((list) => list?.filter((item) => item.id !== id) ?? null)
    return queueChatWrite(() => client.assistantThread.remove.mutate({ id })).then(
      () => {
        const now = useAssistantStore.getState()
        if (now.threadId !== id) return
        now.controller?.abort()
        startAssistantOver(abilityId)
      },
      () => {
        toast.error('That chat could not be deleted.')
        void queueChatWrite(load)
      }
    )
  }

  const needle = query.trim().toLowerCase()
  const visible = (threads ?? []).filter(
    (item) => !needle || item.title.toLowerCase().includes(needle)
  )

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setQuery('')
          void load()
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Saved chats"
          title="Saved chats"
          disabled={disabled}
          className="size-7 rounded-full p-0 text-muted-foreground hover:text-foreground"
        >
          <ClockCounterClockwiseIcon className="size-3.5" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1.5">
        <div className="relative mb-1.5">
          <MagnifyingGlassIcon
            className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            aria-label="Filter saved chats"
            placeholder="Search threads…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-7 ps-8 text-xs"
          />
        </div>
        <div className="max-h-64 space-y-0.5 overflow-y-auto" role="menu">
          {threads === null ? (
            <p
              aria-disabled="true"
              className="px-2 py-3 text-center text-xs text-muted-foreground"
              role="menuitem"
            >
              Loading…
            </p>
          ) : visible.length === 0 ? (
            <p
              aria-disabled="true"
              className="px-2 py-3 text-center text-xs text-muted-foreground"
              role="menuitem"
            >
              {needle ? 'No matching chats' : 'No saved chats yet'}
            </p>
          ) : (
            visible.map((thread) => {
              const active = thread.id === current
              return (
                <div
                  key={thread.id}
                  className={cn(
                    'group flex items-center gap-1 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-foreground/[0.05]',
                    active && 'bg-foreground/[0.06] font-medium'
                  )}
                >
                  <Button
                    aria-label={thread.title}
                    type="button"
                    variant="custom"
                    size={null}
                    role="menuitem"
                    className="flex min-w-0 flex-1 items-center justify-between gap-2 text-start"
                    onClick={() => void resume(thread.id)}
                  >
                    <span className="truncate">{thread.title}</span>
                    {thread.updatedAt ? (
                      <span className="shrink-0 tabular-nums text-[0.6875rem] text-muted-foreground">
                        {relativeTime(thread.updatedAt)}
                      </span>
                    ) : null}
                  </Button>
                  <Button
                    type="button"
                    variant="custom"
                    size={null}
                    aria-label={`Delete ${thread.title}`}
                    title="Delete chat"
                    className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={() => void remove(thread.id)}
                  >
                    <TrashIcon className="size-3" aria-hidden="true" />
                  </Button>
                </div>
              )
            })
          )}
          {current ? (
            <div className="mt-1 border-t border-border pt-1">
              <Button
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-xs text-destructive transition-colors hover:bg-destructive/10"
                onClick={() => {
                  setOpen(false)
                  void remove(current)
                }}
                role="menuitem"
                size={null}
                type="button"
                variant="custom"
              >
                <TrashIcon aria-hidden="true" className="size-3" />
                Delete this chat
              </Button>
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
