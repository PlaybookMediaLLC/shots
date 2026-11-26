'use client'

import { useState } from 'react'
import { ClockCounterClockwiseIcon } from '@phosphor-icons/react/dist/ssr/ClockCounterClockwise'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useTRPCClient } from '@/lib/trpc/react'
import {
  queueChatWrite,
  resumeAssistantThread,
  startAssistantOver,
  useAssistantStore,
} from './assistant-store'

/** The person's saved threads in this workspace; choosing one continues it here. */
export function AssistantThreads({ abilityId, disabled }: { abilityId: string; disabled: boolean }) {
  const client = useTRPCClient()
  const [threads, setThreads] = useState<{ id: string; title: string }[] | null>(null)
  const current = useAssistantStore((state) => state.threadId)
  const load = () =>
    client.assistantThread.list.query().then(setThreads, () => {
      setThreads([])
      toast.error('Saved chats could not load.')
    })
  const resume = (id: string) => {
    const { memory, organizationId } = useAssistantStore.getState()
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
  const remove = () => {
    const { threadId } = useAssistantStore.getState()
    if (!threadId) return
    return queueChatWrite(() => client.assistantThread.remove.mutate({ id: threadId })).then(
      () => {
        const now = useAssistantStore.getState()
        // Another chat is on screen by now: leave it.
        if (now.threadId !== threadId) return
        // A message sent while the delete was in flight would save the chat again.
        now.controller?.abort()
        startAssistantOver(abilityId)
      },
      () => toast.error('That chat could not be deleted.')
    )
  }
  return (
    <DropdownMenu onOpenChange={(open) => open && void load()}>
      <DropdownMenuTrigger asChild>
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
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 w-64 overflow-y-auto">
        {threads?.length ? (
          threads.map((thread) => (
            <DropdownMenuItem key={thread.id} onSelect={() => void resume(thread.id)}>
              <span className="truncate">{thread.title}</span>
            </DropdownMenuItem>
          ))
        ) : (
          <DropdownMenuItem disabled>{threads ? 'No saved chats yet' : 'Loading…'}</DropdownMenuItem>
        )}
        {current ? (
          <DropdownMenuItem className="text-destructive" onSelect={() => void remove()}>
            Delete this chat
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
