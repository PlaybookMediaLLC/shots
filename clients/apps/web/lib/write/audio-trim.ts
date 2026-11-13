import { normalizeAudioType } from '@/lib/animation/audio-type'
import { type AudioMimeType, MAX_AUDIO_BYTES } from '@/lib/animation/motion-schema'

/**
 * A template's music: the person's own file, played for the video's length
 * from a start they choose. Kept apart from the page so the rules can be tested.
 */

/** The slider's step: a tenth of a second. */
export const TRIM_STEP_MS = 100

/** The latest start that still fills the video, on the step; 0 when the track is shorter. */
export function latestStart(trackMs: number, videoMs: number) {
  return Math.max(0, Math.floor((trackMs - videoMs) / TRIM_STEP_MS) * TRIM_STEP_MS)
}

/** A start within the track, on the step. */
export function clampStart(startMs: number, trackMs: number, videoMs: number) {
  const stepped = Math.round(startMs / TRIM_STEP_MS) * TRIM_STEP_MS
  return Math.min(latestStart(trackMs, videoMs), Math.max(0, stepped))
}

/** 24100 as 0:24.1. */
export function clock(ms: number) {
  const tenths = Math.round(ms / 100)
  const seconds = Math.floor(tenths / 10)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}.${tenths % 10}`
}

/** What the video plays of the track, in words: the chosen interval, not a fixed one. */
export function excerptText(startMs: number, trackMs: number, videoMs: number) {
  if (trackMs <= videoMs)
    return `The track is ${clock(trackMs)}, no longer than the ${clock(videoMs)} video: it plays once from its start${trackMs < videoMs ? ', then the video is silent' : ''}.`
  const start = clampStart(startMs, trackMs, videoMs)
  return `Plays ${clock(start)} to ${clock(start + videoMs)} of the ${clock(trackMs)} track.`
}

/**
 * The trim dialog. Closed, it holds nothing; open, it holds a draft start that
 * the slider moves. Saving sends the draft as the new start; Cancel and closing
 * drop it, so the saved start is what the next opening shows.
 */
export type TrimDialog = { draftMs: number | null }

/** What happens in the trim dialog. */
export type TrimAction =
  | { committedMs: number; type: 'open' }
  | { ms: number; trackMs: number; type: 'move'; videoMs: number }
  | { type: 'close' }

/** The dialog's next state. */
export function trimDialog(state: TrimDialog, action: TrimAction): TrimDialog {
  switch (action.type) {
    case 'open':
      return { draftMs: action.committedMs }
    case 'move':
      return state.draftMs === null
        ? state
        : { draftMs: clampStart(action.ms, action.trackMs, action.videoMs) }
    case 'close':
      return { draftMs: null }
  }
}

/** Why an audio file cannot be music, before it is read; null when it may be. */
export function audioFileProblem(file: { name: string; size: number; type: string }) {
  if (!normalizeAudioType(file.type, file.name))
    return 'Choose an MP3, M4A/AAC, WAV, Ogg, or WebM audio file.'
  if (file.size > MAX_AUDIO_BYTES)
    return `Choose an audio file under ${MAX_AUDIO_BYTES / 1024 / 1024} MB.`
  if (file.size === 0) return 'This audio file is empty.'
  return null
}

/**
 * An audio file checked as the renderer will read it: its type, its size, and
 * that this browser decodes it to some sound. Returns its type and length.
 */
export async function readAudioFile(file: File): Promise<{ durationMs: number; type: AudioMimeType }> {
  const problem = audioFileProblem(file)
  if (problem) throw new Error(problem)
  const context = new OfflineAudioContext(2, 1, 48_000)
  const decoded = await context.decodeAudioData(await file.arrayBuffer()).catch(() => {
    throw new Error('This browser cannot decode the audio file. Use MP3, AAC, WAV, or Ogg.')
  })
  if (decoded.duration < 0.1) throw new Error('This audio file has no sound to play.')
  return { durationMs: Math.round(decoded.duration * 1000), type: normalizeAudioType(file.type, file.name)! }
}
