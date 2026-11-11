'use client'

import { useInfiniteQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { EmptyState, PlanRequired } from '@/components/platform-ui'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { MicrophoneIcon } from '@/components/platform-shell/icons'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { isPlanRefusal } from '@/lib/api/platform-errors'
import { recordedLabel, useVoiceSettings, voiceApi } from '@/lib/voice/client'
import { cn } from '@/lib/utils'
import { VoiceNote } from './VoiceNote'

/**
 * The signed-in member's own voice notes (plan 5.2): the list, newest first,
 * beside the open note. Nobody else in the workspace can see them.
 */
export function VoiceInbox({ canDraft }: { canDraft: boolean }) {
  const settings = useVoiceSettings()
  const enabled = settings.data?.workspace.voiceNotes ?? false
  // queryFn comes first so TypeScript infers the page type before getNextPageParam reads it.
  const notes = useInfiniteQuery({
    queryFn: ({ pageParam }: { pageParam: string | undefined }) => voiceApi.list(pageParam),
    queryKey: ['voice-notes'],
    enabled,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    initialPageParam: undefined as string | undefined,
  })
  const [open, setOpen] = useState<string | null>(null)
  const problem = settings.error ?? notes.error
  if (isPlanRefusal(problem)) {
    return <PlanRequired from="/create/voice">Voice notes need a paid plan.</PlanRequired>
  }
  if (problem) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{problem.message}</AlertDescription>
      </Alert>
    )
  }
  if (!settings.data) return <p className="text-ui text-muted-foreground">Loading…</p>
  if (!enabled) {
    return (
      <EmptyState
        action={
          settings.data.canManage ? (
            <ButtonLink href="/settings/voice-notes" variant="outline">
              Voice settings
            </ButtonLink>
          ) : null
        }
        description={
          settings.data.canManage
            ? 'Turn on voice notes so members can record in the Shots app and read their notes here.'
            : 'An owner or admin can turn on voice notes for this workspace.'
        }
        icon={MicrophoneIcon}
        title="Voice notes are off"
      />
    )
  }
  const items = notes.data?.pages.flatMap((page) => page.notes) ?? []
  if (notes.isPending) return <p className="text-ui text-muted-foreground">Loading notes…</p>
  if (items.length === 0) {
    return (
      <EmptyState
        description="Record a note in the Shots app on your phone. It appears here once it syncs, and only you can see it."
        icon={MicrophoneIcon}
        title="No voice notes yet"
      />
    )
  }
  return (
    <div className="grid min-w-0 gap-6 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
      <nav aria-label="Voice notes" className="grid content-start gap-1">
        {items.map((note) => (
          <Button
            aria-current={note.id === open ? 'true' : undefined}
            className={cn(
              'grid w-full gap-0.5 rounded-lg px-3 py-2 text-start hover:bg-foreground/[0.05]',
              note.id === open && 'bg-foreground/[0.06]'
            )}
            key={note.id}
            onClick={() => setOpen(note.id)}
            size={null}
            variant="custom"
          >
            <span className="truncate text-ui-lg text-foreground">
              {note.title || 'Untitled note'}
            </span>
            <span className="text-caption text-muted-foreground">{recordedLabel(note)}</span>
            {note.excerpt ? (
              <span className="line-clamp-2 text-caption text-muted-foreground">
                {note.excerpt}
              </span>
            ) : null}
          </Button>
        ))}
        {notes.hasNextPage ? (
          <Button
            disabled={notes.isFetchingNextPage}
            onClick={() => void notes.fetchNextPage()}
            size="sm"
            variant="ghost"
          >
            Show more
          </Button>
        ) : null}
      </nav>
      {open ? (
        <VoiceNote
          canDraft={canDraft}
          id={open}
          key={open}
          onDeleted={() => setOpen(null)}
          settings={settings.data}
        />
      ) : (
        <p className="text-ui text-muted-foreground">Choose a note to read it.</p>
      )}
    </div>
  )
}
