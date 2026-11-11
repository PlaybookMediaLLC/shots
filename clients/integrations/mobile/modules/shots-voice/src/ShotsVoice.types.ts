/**
 * The contract between the Swift recorder (one module owns the microphone for
 * the whole recording and feeds both the file writer and the speech engine)
 * and the React Native app. JavaScript sends intent; native sends batched
 * events carrying the note ID and a sequence number. See
 * docs/plans/voice-capture-implementation.md, section 5.
 */

/** Bumped on every breaking change to this contract (R14 handshake). */
export const SHOTS_VOICE_CONTRACT_VERSION = 1

export type SpeechEngine = 'long_form' | 'legacy_on_device' | 'none'
export type PermissionState = 'granted' | 'denied' | 'undetermined' | 'restricted'

export interface Capabilities {
  /** The on-device engine available for the locale; never a network recognizer (R15). */
  speech: SpeechEngine
  microphone: PermissionState
  speechPermission: PermissionState
  freeBytes: number
  /** Must equal SHOTS_VOICE_CONTRACT_VERSION, or recording is disabled with an update prompt. */
  contractVersion: number
}

export interface StartOptions {
  noteId: string
  locale: string
  /** Workspace brand terms, passed as custom vocabulary where the engine accepts it. */
  vocabulary: string[]
  /** Default 30 minutes; native stops and saves at the limit (R10). */
  maxDurationMs: number
  /** Default 25 minutes. */
  warnAtMs: number
  /** Refuse to start below this (default 200 MB). */
  minFreeBytes: number
  /** Stop and save below this while recording (default 50 MB, R6). */
  stopFreeBytes: number
  /** Recordings shorter than this are discarded (default 1000, R11). */
  minDurationMs: number
}

export type StartFailure =
  | 'microphone_busy'
  | 'permission_denied'
  | 'restricted'
  | 'low_storage'
  | 'contract_mismatch'
  | 'unknown'

export type StartResult = { ok: true } | { ok: false; reason: StartFailure }

export type RecordingState =
  'starting' | 'recording' | 'interrupted' | 'finalizing' | 'saved' | 'start_failed' | 'damaged'

export interface RunInfo {
  index: number
  /** Absolute file path in the app's documents area. */
  file: string
  /** Start of this run on the note timeline. */
  startOffsetMs: number
  durationMs: number
  sampleRateHz: number
  bytes: number
  /** Provisional ADTS AAC (`audio/aac`) until the Gate 0 kill test picks the format. */
  contentType: string
  /** True once the run is closed; an open run is still being written. */
  finalized: boolean
}

export interface TranscriptSegment {
  startMs: number
  endMs: number
  text: string
  /** True at a recognizer restart boundary, where words may be missing. */
  approximate?: boolean
}

export interface FinalTranscript {
  locale: string
  engine: string
  text: string
  segments: TranscriptSegment[]
}

interface EventBase {
  noteId: string
  /** Strictly increasing per note; the app drops stale or out-of-order events (R13). */
  seq: number
}

export interface StateEvent extends EventBase {
  state: RecordingState
  reason?: string
}
export interface LevelEvent extends EventBase {
  /** Batched dBFS samples for the meter; never announced to assistive technology. */
  levels: number[]
}
export interface RunEvent extends EventBase {
  run: RunInfo
}
export interface PartialEvent extends EventBase {
  /** Display only; never stored. */
  text: string
}
export interface TranscriptEvent extends EventBase {
  transcript: FinalTranscript
}
export interface WarningEvent extends EventBase {
  kind: 'duration_warning' | 'low_storage' | 'no_speech_detected'
}

export interface ShotsVoiceEvents {
  onState: (event: StateEvent) => void
  onLevel: (event: LevelEvent) => void
  onRun: (event: RunEvent) => void
  onPartial: (event: PartialEvent) => void
  onTranscript: (event: TranscriptEvent) => void
  onWarning: (event: WarningEvent) => void
}

/** A note found unfinished on launch (R1): its runs are playable to within about a second. */
export interface RecoveredNote {
  noteId: string
  runs: RunInfo[]
}

export interface ShotsVoiceModule {
  getCapabilities(locale: string): Promise<Capabilities>
  requestPermissions(): Promise<{ microphone: PermissionState; speech: PermissionState }>
  start(options: StartOptions): Promise<StartResult>
  /** Finalizes the current run and the transcript, then emits `saved`. */
  stop(): Promise<void>
  /** Stops and deletes this recording's files. */
  cancel(): Promise<void>
  /** Scans for runs left open by a kill or crash and closes them. */
  recoverInterrupted(): Promise<RecoveredNote[]>
  /** Deletes a note's local audio files (after the server confirms its runs, or on user delete). */
  deleteNoteAudio(noteId: string): Promise<void>
}
