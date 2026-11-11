'use client'

import {
  type InfiniteData,
  type QueryClient,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { z } from 'zod'
import { Group, Pill, Row, Section } from '@/components/platform-ui'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { ConfirmDialog } from '@/components/settings/ConfirmDialog'
import { draftHref } from '@/lib/write/library'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type {
  VoiceNoteDetail,
  VoiceSettings,
  VoiceTranscriptRevision,
  voiceAudioRunSchema,
  voiceDraftIntentSchema,
  voiceNotePageSchema,
} from '@/lib/api/contracts/voice-schemas'
import {
  REMOTE_TEXT_DISCLOSURE,
  recordedLabel,
  reviewParts,
  VOICE_NOTES_KEY,
  VOICE_SETTINGS_KEY,
  voiceApi,
  voiceExcerpt,
  voiceNoteKey,
} from '@/lib/voice/client'

type Intent = z.output<typeof voiceDraftIntentSchema>

const INTENTS: Record<Intent, string> = {
  launch_post: 'Launch post',
  documentation_outline: 'Documentation outline',
  onboarding_explanation: 'Onboarding explanation',
  saved_idea: 'Saved idea',
}

const ORIGINS: Record<VoiceTranscriptRevision['origin'], string> = {
  on_device: 'On the phone',
  // The phone's chosen cloud provider; Shots itself transcribes nothing.
  remote: 'Transcribed by a cloud provider',
  user_edit: 'Your edit',
}

type InboxPages = InfiniteData<z.output<typeof voiceNotePageSchema>>
type InboxNote = InboxPages['pages'][number]['notes'][number]

/**
 * Changes one note in the inbox's loaded pages, or drops it with `null`, so a
 * change to one note refetches no page. The inbox orders by `receivedAt`,
 * which no change here moves.
 */
function patchInbox(
  client: QueryClient,
  id: string,
  change: (note: InboxNote) => InboxNote | null
) {
  client.setQueryData<InboxPages>(VOICE_NOTES_KEY, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            notes: page.notes.flatMap((note) => (note.id === id ? (change(note) ?? []) : note)),
          })),
        }
      : data
  )
}

/** One run's audio, fetched as a short-lived signed URL only when asked for. */
function RunAudio({ noteId, run }: { noteId: string; run: z.output<typeof voiceAudioRunSchema> }) {
  const [url, setUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (run.status !== 'available') {
    return (
      <p className="text-ui text-muted-foreground">
        Part {run.runIndex + 1}: {run.status === 'pending' ? 'uploading' : run.status}
      </p>
    )
  }
  return url ? (
    // The transcript below is the caption.
    <audio
      aria-label={`Part ${run.runIndex + 1}`}
      className="w-full"
      controls
      // A signed URL expires; failing to load offers the Play button again.
      onError={() => setUrl(null)}
      src={url}
    />
  ) : (
    <Button
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try {
          setUrl((await voiceApi.audio(noteId, run.runIndex)).url)
        } catch (error) {
          toast.error(error instanceof Error ? error.message : 'The audio could not load.')
        } finally {
          setBusy(false)
        }
      }}
      size="sm"
      variant="outline"
    >
      Play part {run.runIndex + 1}
    </Button>
  )
}

/** A transcript with numbers and names marked for review (V3). */
function ReviewedText({ text }: { text: string }) {
  // A transcript runs to 100,000 characters; split it again only when it changes.
  const parts = useMemo(() => reviewParts(text), [text])
  return (
    <p className="text-ui whitespace-pre-wrap text-foreground">
      {parts.map((part, index) =>
        part.flagged ? (
          <mark className="rounded-sm bg-amber-500/20 text-inherit" key={index}>
            {part.text}
          </mark>
        ) : (
          part.text
        )
      )}
    </p>
  )
}

/** Edit a transcript: saving adds a `user_edit` revision, so nothing is overwritten. */
function TranscriptEditor({
  noteId,
  onDone,
  parent,
}: {
  noteId: string
  /** The saved text, or null when the edit was cancelled. */
  onDone: (saved: string | null) => void
  parent: VoiceTranscriptRevision
}) {
  const [text, setText] = useState(parent.text)
  const [busy, setBusy] = useState(false)
  // A retry of the same text keeps its id, so a save that reached the server is not added
  // twice; changed text gets a new id, so the server never answers it with the earlier save.
  const lastSave = useRef<{ clientRevisionId: string; text: string } | null>(null)
  const save = async () => {
    if (lastSave.current?.text !== text) {
      lastSave.current = { clientRevisionId: crypto.randomUUID(), text }
    }
    setBusy(true)
    try {
      await voiceApi.addTranscript(noteId, {
        clientRevisionId: lastSave.current.clientRevisionId,
        origin: 'user_edit',
        parentId: parent.id,
        segments: [],
        text,
      })
      onDone(text)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The transcript could not be saved.')
      setBusy(false)
    }
  }
  return (
    <div className="grid gap-2">
      <Label className="grid gap-1.5">
        Transcript
        <Textarea onChange={(event) => setText(event.target.value)} rows={8} value={text} />
      </Label>
      <div className="flex justify-end gap-2">
        <Button disabled={busy} onClick={() => onDone(null)} size="sm" variant="ghost">
          Cancel
        </Button>
        <Button disabled={busy || text === parent.text} onClick={() => void save()} size="sm">
          Save as a new revision
        </Button>
      </div>
    </div>
  )
}

/** Make a draft from the current revision, asking for consent the first time (5.3, V6). */
function MakeDraft({
  canDraft,
  note,
  settings,
}: {
  canDraft: boolean
  note: VoiceNoteDetail
  settings: VoiceSettings
}) {
  const client = useQueryClient()
  const [intent, setIntent] = useState<Intent>('launch_post')
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [draftId, setDraftId] = useState<string | null>(null)
  const current = note.transcripts.find((item) => item.id === note.currentTranscriptRevisionId)
  const unavailable = !canDraft
    ? 'Drafts are not available to you in this workspace.'
    : !settings.workspace.draftGeneration || !settings.switches.drafts
      ? 'Drafts from voice notes are off for this workspace.'
      : !current || current.redacted || !current.text.trim()
        ? 'This note has no transcript to draft from.'
        : note.transcriptConflict
          ? 'Choose a transcript revision first.'
          : null
  const make = async (consent: boolean) => {
    if (!current) return
    setBusy(true)
    try {
      if (consent) {
        client.setQueryData(
          VOICE_SETTINGS_KEY,
          await voiceApi.saveMember({ remoteTextConsent: true })
        )
      }
      const { contentDraftId } = await voiceApi.draft(note.id, {
        intent,
        transcriptRevisionId: current.id,
      })
      setDraftId(contentDraftId)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The draft could not be made.')
    } finally {
      setBusy(false)
      setAsking(false)
    }
  }
  return (
    <Row
      description={
        unavailable ??
        'Writes a draft from the current transcript. Statements no capture backs are marked as yours to check.'
      }
      label="Make a draft"
    >
      {draftId ? (
        <ButtonLink href={draftHref(draftId)} size="sm" variant="outline">
          Open the draft
        </ButtonLink>
      ) : (
        <>
          <Select
            disabled={Boolean(unavailable) || busy}
            onValueChange={(value) => setIntent(value as Intent)}
            value={intent}
          >
            <SelectTrigger aria-label="What the draft is for" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(INTENTS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            disabled={Boolean(unavailable) || busy}
            onClick={() =>
              settings.member.remoteTextConsentAt ? void make(false) : setAsking(true)
            }
            size="sm"
          >
            {busy ? 'Making the draft…' : 'Make a draft'}
          </Button>
        </>
      )}
      <Dialog onOpenChange={(open) => !busy && setAsking(open)} open={asking}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send this transcript to the model provider?</DialogTitle>
            <DialogDescription>{REMOTE_TEXT_DISCLOSURE}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button disabled={busy} onClick={() => setAsking(false)} variant="ghost">
              Not now
            </Button>
            <Button disabled={busy} onClick={() => void make(true)}>
              Agree and make the draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Row>
  )
}

/**
 * One of the member's notes: its audio, its transcript revisions with the
 * current one marked, and what can be done with them.
 */
export function VoiceNote({
  canDraft,
  id,
  onDeleted,
  settings,
}: {
  canDraft: boolean
  id: string
  onDeleted: () => void
  settings: VoiceSettings
}) {
  const client = useQueryClient()
  const note = useQuery({ queryFn: () => voiceApi.note(id), queryKey: voiceNoteKey(id) })
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const refreshNote = () => client.invalidateQueries({ queryKey: voiceNoteKey(id) })
  // A new current transcript changes the note's inbox excerpt, and nothing else there.
  const showCurrent = (text: string) => {
    patchInbox(client, id, (item) => ({ ...item, excerpt: voiceExcerpt(text) }))
    return refreshNote()
  }
  /** Runs a request; resolves to its failure message, or null once the view caught up. */
  const attempt = async (
    request: () => Promise<unknown>,
    failure: string,
    then: () => unknown = refreshNote
  ) => {
    try {
      await request()
    } catch (error) {
      return error instanceof Error ? error.message : failure
    }
    await then()
    return null
  }
  if (note.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{note.error.message}</AlertDescription>
      </Alert>
    )
  }
  if (!note.data) return <p className="text-ui text-muted-foreground">Loading the note…</p>
  const detail = note.data
  const current = detail.transcripts.find((item) => item.id === detail.currentTranscriptRevisionId)
  const revisions = [...detail.transcripts].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
  )
  const audio = detail.runs.filter((item) => item.status !== 'deleted')
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div>
        <h2 className="text-body text-foreground">{detail.title || 'Untitled note'}</h2>
        <p className="mt-1 text-caption text-muted-foreground">{recordedLabel(detail)}</p>
      </div>
      {detail.command ? (
        <Alert>
          <AlertDescription>
            Scheduling proposal ({detail.command.status.replaceAll('_', ' ')})
            {detail.command.text ? `: “${detail.command.text}”` : ''}. Proposals are confirmed in
            the Shots app on your phone.
          </AlertDescription>
        </Alert>
      ) : null}
      <Section
        actions={
          audio.length ? (
            <ConfirmDialog
              confirmLabel="Delete audio"
              description="Every recording of this note is deleted. The transcripts stay."
              destructive
              disabled={busy}
              onConfirm={() =>
                attempt(() => voiceApi.deleteAudio(id), 'The audio could not be deleted.')
              }
              title="Delete this note’s audio?"
              triggerLabel="Delete audio"
            />
          ) : null
        }
        title="Audio"
      >
        {audio.length ? (
          <div className="grid gap-2">
            {audio.map((item) => (
              <RunAudio key={item.runIndex} noteId={id} run={item} />
            ))}
          </div>
        ) : (
          <p className="text-ui text-muted-foreground">Only the transcript was synced.</p>
        )}
      </Section>
      <Section
        description="Marked numbers and names are often misheard. Check them before you make a draft."
        title="Transcript"
      >
        {detail.transcriptConflict ? (
          <Alert>
            <AlertDescription>
              Two devices changed this transcript. Choose the revision to keep.
            </AlertDescription>
          </Alert>
        ) : null}
        {editing && current ? (
          <TranscriptEditor
            noteId={id}
            onDone={(saved) => {
              setEditing(false)
              if (saved !== null) void showCurrent(saved)
            }}
            parent={current}
          />
        ) : null}
        <Group>
          {revisions.length === 0 ? (
            <Row>
              <p className="text-ui text-muted-foreground">No transcript yet.</p>
            </Row>
          ) : (
            revisions.map((revision) => (
              <Row key={revision.id}>
                <div className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
                  {revision.id === detail.currentTranscriptRevisionId ? (
                    <Pill tone="green">Current</Pill>
                  ) : null}
                  {revision.redacted ? <Pill>Redacted</Pill> : null}
                  <span>{ORIGINS[revision.origin]}</span>
                  <span>· {new Date(revision.createdAt).toLocaleString()}</span>
                </div>
                {revision.redacted ? null : <ReviewedText text={revision.text} />}
                {revision.redacted ? null : (
                  <div className="flex flex-wrap gap-2">
                    {detail.transcriptConflict ? (
                      <Button
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true)
                          const failure = await attempt(
                            () =>
                              voiceApi.addTranscript(id, {
                                // The same choice at the same note revision is one request, however often it is retried.
                                clientRevisionId: `choose:${revision.id}:${detail.revision}`,
                                origin: 'user_edit',
                                parentId: revision.id,
                                segments: revision.segments,
                                text: revision.text,
                              }),
                            'The revision could not be chosen.',
                            () => showCurrent(revision.text)
                          )
                          setBusy(false)
                          if (failure) toast.error(failure)
                        }}
                        size="sm"
                        variant="outline"
                      >
                        Choose this
                      </Button>
                    ) : null}
                    {revision.id === detail.currentTranscriptRevisionId && !editing ? (
                      <Button
                        disabled={busy}
                        onClick={() => setEditing(true)}
                        size="sm"
                        variant="outline"
                      >
                        Edit
                      </Button>
                    ) : null}
                    <ConfirmDialog
                      confirmLabel="Redact"
                      description="The text of this revision is cleared for good. Drafts made from it keep their text."
                      destructive
                      disabled={busy}
                      onConfirm={() =>
                        attempt(
                          () => voiceApi.redact(id, revision.id),
                          'The revision could not be redacted.',
                          // Only the current revision gives the inbox its excerpt.
                          revision.id === detail.currentTranscriptRevisionId
                            ? () => showCurrent('')
                            : refreshNote
                        )
                      }
                      title="Redact this revision?"
                      triggerLabel="Redact"
                    />
                  </div>
                )}
              </Row>
            ))
          )}
        </Group>
      </Section>
      <Group>
        <MakeDraft canDraft={canDraft} note={detail} settings={settings} />
        <Row
          description="The audio is deleted and the transcripts are cleared."
          label="Delete note"
        >
          <ConfirmDialog
            confirmLabel="Delete note"
            description="The note is deleted on every device. This cannot be undone."
            destructive
            disabled={busy}
            onConfirm={() =>
              attempt(
                () => voiceApi.deleteNote(id),
                'The note could not be deleted.',
                () => {
                  patchInbox(client, id, () => null)
                  onDeleted()
                }
              )
            }
            title="Delete this note?"
            triggerLabel="Delete note"
          />
        </Row>
      </Group>
    </div>
  )
}
