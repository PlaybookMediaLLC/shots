'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import type { z } from 'zod'
import { Group, Pill, Row, Section } from '@/components/platform-ui'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { draftHref } from '@/components/write/write-context'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
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
} from '@/lib/api/contracts/voice-schemas'
import {
  REMOTE_TEXT_DISCLOSURE,
  recordedLabel,
  reviewParts,
  VOICE_SETTINGS_KEY,
  voiceApi,
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
  remote: 'Transcribed by Shots',
  user_edit: 'Your edit',
}

/** The key one note's detail is cached under. */
export const voiceNoteKey = (id: string) => ['voice-note', id] as const

/** A button that asks before it does something that cannot be undone. */
function ConfirmButton({
  action,
  busy,
  description,
  label,
  onConfirm,
  title,
}: {
  action: string
  busy: boolean
  description: string
  label: string
  onConfirm: () => void
  title: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button disabled={busy} onClick={() => setOpen(true)} size="sm" variant="outline">
        {label}
      </Button>
      <AlertDialog onOpenChange={setOpen} open={open}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onConfirm}>{action}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
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
  return (
    <p className="text-ui whitespace-pre-wrap text-foreground">
      {reviewParts(text).map((part, index) =>
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
  onDone: (saved: boolean) => void
  parent: VoiceTranscriptRevision
}) {
  const [text, setText] = useState(parent.text)
  const [busy, setBusy] = useState(false)
  // One id per edit, so retrying a save that may have reached the server cannot add it twice.
  const [clientRevisionId] = useState(() => crypto.randomUUID())
  const save = async () => {
    setBusy(true)
    try {
      await voiceApi.addTranscript(noteId, {
        clientRevisionId,
        origin: 'user_edit',
        parentId: parent.id,
        segments: [],
        text,
      })
      onDone(true)
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
        <Button disabled={busy} onClick={() => onDone(false)} size="sm" variant="ghost">
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
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: voiceNoteKey(id) }),
      client.invalidateQueries({ queryKey: ['voice-notes'] }),
    ])
  const run = async (request: () => Promise<unknown>, failure: string) => {
    setBusy(true)
    try {
      await request()
      await refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : failure)
    } finally {
      setBusy(false)
    }
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
            <ConfirmButton
              action="Delete audio"
              busy={busy}
              description="Every recording of this note is deleted. The transcripts stay."
              label="Delete audio"
              onConfirm={() =>
                void run(() => voiceApi.deleteAudio(id), 'The audio could not be deleted.')
              }
              title="Delete this note’s audio?"
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
              if (saved) void refresh()
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
                        onClick={() =>
                          void run(
                            () =>
                              voiceApi.addTranscript(id, {
                                // The same choice at the same note revision is one request, however often it is retried.
                                clientRevisionId: `choose:${revision.id}:${detail.revision}`,
                                origin: 'user_edit',
                                parentId: revision.id,
                                segments: revision.segments,
                                text: revision.text,
                              }),
                            'The revision could not be chosen.'
                          )
                        }
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
                    <ConfirmButton
                      action="Redact"
                      busy={busy}
                      description="The text of this revision is cleared for good. Drafts made from it keep their text."
                      label="Redact"
                      onConfirm={() =>
                        void run(
                          () => voiceApi.redact(id, revision.id),
                          'The revision could not be redacted.'
                        )
                      }
                      title="Redact this revision?"
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
          <ConfirmButton
            action="Delete note"
            busy={busy}
            description="The note is deleted on every device. This cannot be undone."
            label="Delete note"
            onConfirm={() =>
              void (async () => {
                setBusy(true)
                try {
                  await voiceApi.deleteNote(id)
                  await client.invalidateQueries({ queryKey: ['voice-notes'] })
                  onDeleted()
                } catch (error) {
                  toast.error(
                    error instanceof Error ? error.message : 'The note could not be deleted.'
                  )
                  setBusy(false)
                }
              })()
            }
            title="Delete this note?"
          />
        </Row>
      </Group>
    </div>
  )
}
