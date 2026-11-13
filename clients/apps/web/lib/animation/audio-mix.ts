import type { AudioClip } from './motion-schema'

/**
 * Audio on the timeline as a mix: which part of which file plays when, at
 * what gain. Playback in the editor and the mixdown for video export read
 * the same plan, so what plays while editing is what the video contains.
 */

/** One clip's contribution to the mix, in seconds. */
export type MixSegment = {
  clipId: string
  /** Seconds into the source where playback starts (the trim in). */
  offset: number
  /** Seconds of the source that play. */
  duration: number
  gain: number
  src: string
  /** Seconds on the timeline where the segment starts. */
  when: number
}

/**
 * The mix for a timeline of `durationMs`: each audible clip from its trim in,
 * placed at its start, cut where it is trimmed or where the timeline ends.
 */
export function planAudioMix(clips: readonly AudioClip[], durationMs: number): MixSegment[] {
  return clips.flatMap((clip) => {
    if (clip.muted || clip.gain <= 0) return []
    const end = Math.min(clip.start + (clip.trimEnd - clip.trimStart), durationMs)
    if (end <= clip.start) return []
    return [
      {
        clipId: clip.id,
        duration: (end - clip.start) / 1000,
        gain: clip.gain,
        offset: clip.trimStart / 1000,
        src: clip.src,
        when: clip.start / 1000,
      },
    ]
  })
}

/** A segment to start `delay` seconds from now, `offset` seconds into its source, for `duration` seconds. */
export type ScheduledSegment = MixSegment & { delay: number }

/**
 * What to start for playback from the playhead at `fromSeconds`: segments
 * still ahead start after a delay, a segment under the playhead starts now
 * part way in, and segments already over are left out.
 */
export function scheduleFrom(plan: readonly MixSegment[], fromSeconds: number): ScheduledSegment[] {
  return plan.flatMap((segment) => {
    const into = fromSeconds - segment.when
    if (into >= segment.duration) return []
    if (into <= 0) return [{ ...segment, delay: -into }]
    return [
      { ...segment, delay: 0, duration: segment.duration - into, offset: segment.offset + into },
    ]
  })
}

/** Decoded audio by source URL, so playback and export decode each file once. */
const decoded = new Map<string, Promise<AudioBuffer>>()

/**
 * Decode an audio source (a blob, data, or signed URL). A file the browser
 * cannot decode rejects with a message the user can act on.
 */
export function decodeAudioSource(src: string, context: BaseAudioContext): Promise<AudioBuffer> {
  let buffer = decoded.get(src)
  if (!buffer) {
    buffer = (async () => {
      const response = await fetch(src)
      if (!response.ok)
        throw new Error(`The audio could not be loaded (status ${response.status}).`)
      try {
        return await context.decodeAudioData(await response.arrayBuffer())
      } catch {
        throw new Error('This browser cannot decode the audio file. Use MP3, AAC, WAV, or Ogg.')
      }
    })()
    buffer.catch(() => decoded.delete(src))
    decoded.set(src, buffer)
  }
  return buffer
}

/** Drop a decoded source, such as a blob URL about to be revoked, so its samples can be freed. */
export function forgetAudioSource(src: string) {
  decoded.delete(src)
}

/** Sample rate of mixed audio: what AAC encoders and MP4 players expect. */
export const MIX_SAMPLE_RATE = 48_000

/**
 * Mix the timeline's audio into one stereo buffer exactly `durationMs` long,
 * with each clip trimmed, placed, and gained. Rendering runs offline, faster
 * than real time, and gives the same samples every time.
 */
export async function renderAudioMix(
  clips: readonly AudioClip[],
  durationMs: number
): Promise<AudioBuffer | null> {
  const plan = planAudioMix(clips, durationMs)
  if (plan.length === 0) return null
  const length = Math.max(1, Math.ceil((durationMs / 1000) * MIX_SAMPLE_RATE))
  const context = new OfflineAudioContext(2, length, MIX_SAMPLE_RATE)
  const buffers = await Promise.all(plan.map((segment) => decodeAudioSource(segment.src, context)))
  plan.forEach((segment, index) => {
    const source = context.createBufferSource()
    source.buffer = buffers[index]!
    const gain = context.createGain()
    gain.gain.value = segment.gain
    source.connect(gain).connect(context.destination)
    source.start(segment.when, segment.offset, segment.duration)
  })
  return context.startRendering()
}
