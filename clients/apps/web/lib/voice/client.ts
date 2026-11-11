import { useQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import {
  type voiceDraftInputSchema,
  type voiceMemberChoicesInputSchema,
  voiceNoteDetailSchema,
  voiceNotePageSchema,
  voiceRunAudioSchema,
  voiceSettingsSchema,
  type voiceTranscriptCreateSchema,
  voiceTranscriptResultSchema,
  type voiceWorkspaceFlagsInputSchema,
} from '@/lib/api/contracts/voice-schemas'
import { createVoiceDraftContract } from '@/lib/api/contracts/voice-actions'
import { call } from '@/lib/content-drafts/client'
import { readWire } from '@/lib/plan/wire'

const base = '/api/v1/voice'
const note = (id: string) => `${base}/notes/${encodeURIComponent(id)}`

/** What a member agrees to before transcript text leaves Shots (plan decision 10, V6). */
export const REMOTE_TEXT_DISCLOSURE =
  'Making a draft sends the chosen transcript’s text to the AI model provider Shots uses to write drafts. Audio is never sent. Nothing is sent until you agree, and you can withdraw this choice in Settings, Voice notes.'

/** The query key the inbox, the settings and the navigation share. */
export const VOICE_SETTINGS_KEY = ['voice-settings'] as const

/** The query key of the inbox's loaded pages. */
export const VOICE_NOTES_KEY = ['voice-notes'] as const

/** The query key of one note's detail. */
export const voiceNoteKey = (id: string) => ['voice-note', id] as const

/** Browser calls to the voice API (`/api/v1/voice`), with the session cookie. */
export const voiceApi = {
  settings: async () => readWire(voiceSettingsSchema, await call(`${base}/settings`)),
  saveWorkspace: async (input: z.input<typeof voiceWorkspaceFlagsInputSchema>) =>
    readWire(
      voiceSettingsSchema,
      await call(`${base}/settings/workspace`, { body: input, method: 'PUT' })
    ),
  saveMember: async (input: z.input<typeof voiceMemberChoicesInputSchema>) =>
    readWire(
      voiceSettingsSchema,
      await call(`${base}/settings/member`, { body: input, method: 'PUT' })
    ),
  list: async (cursor?: string) =>
    readWire(
      voiceNotePageSchema,
      await call(`${base}/notes${cursor ? `?${new URLSearchParams({ cursor })}` : ''}`)
    ),
  note: async (id: string) => readWire(voiceNoteDetailSchema, await call(note(id))),
  addTranscript: async (id: string, input: z.input<typeof voiceTranscriptCreateSchema>) =>
    readWire(
      voiceTranscriptResultSchema,
      await call(`${note(id)}/transcripts`, { body: input, method: 'POST' })
    ),
  redact: (id: string, revisionId: string) =>
    call(`${note(id)}/transcripts/${encodeURIComponent(revisionId)}/redact`, { method: 'POST' }),
  audio: async (id: string, runIndex: number) =>
    readWire(voiceRunAudioSchema, await call(`${note(id)}/runs/${runIndex}/audio`)),
  deleteAudio: (id: string) => call(`${note(id)}/audio`, { method: 'DELETE' }),
  deleteNote: (id: string) => call(note(id), { method: 'DELETE' }),
  draft: async (id: string, input: z.input<typeof voiceDraftInputSchema>) =>
    readWire(
      createVoiceDraftContract.output,
      await call(`${note(id)}/draft`, { body: input, method: 'POST' })
    ),
}

/** The member's voice settings, shared by every screen that reads them. */
export function useVoiceSettings(enabled = true) {
  return useQuery({ enabled, queryFn: voiceApi.settings, queryKey: VOICE_SETTINGS_KEY })
}

/**
 * Numbers and names to check before a draft is accepted (V3): digits, and
 * capitalised words that do not start a sentence. Odd parts are flagged.
 */
const REVIEW = /(\d+(?:[.,:]\d+)*%?|(?<!(?:^|[.!?]["')\]]?)\s*)\p{Lu}[\p{L}\p{N}'’-]+)/u

/** A transcript cut into plain text and the parts flagged for review. */
export function reviewParts(text: string): { flagged: boolean; text: string }[] {
  return text
    .split(REVIEW)
    .map((part, index) => ({ flagged: index % 2 === 1, text: part }))
    .filter((part) => part.text)
}

/** A note's inbox excerpt of its current transcript, cut as the backend cuts it (`voiceExcerpt`). */
export function voiceExcerpt(text: string): string {
  const words = text.split(/\s+/).filter(Boolean).join(' ')
  const characters = [...words]
  return characters.length <= 200 ? words : `${characters.slice(0, 200).join('')}…`
}

/** When a note was recorded, in the zone it was recorded in, and how long it runs. */
export function recordedLabel(note: {
  durationMs: number | null
  recordedAt: string
  recordedTimeZone: string
}): string {
  const at = new Date(note.recordedAt)
  let when: string
  try {
    when = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: note.recordedTimeZone,
    }).format(at)
  } catch {
    // A zone this browser does not know: local time, still naming the phone's zone.
    when = at.toLocaleString()
  }
  const seconds = Math.round((note.durationMs ?? 0) / 1000)
  const length = seconds
    ? ` · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
    : ''
  return `${when} (${note.recordedTimeZone})${length}`
}
