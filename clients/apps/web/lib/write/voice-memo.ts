import { z } from 'zod'
import { draftChannelSchema } from './document'

/** An ephemeral audio attachment; only its reviewed text can enter the draft. */
export const voiceMemoSchema = z.strictObject({
  draftId: z.string().min(1).max(128),
  channel: draftChannelSchema,
  mediaType: z.enum(['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/ogg']),
  audio: z
    .string()
    .min(16)
    .max(14_000_000)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
})

/** Reject a mislabeled or oversized attachment before starting a metered model call. */
export function validateVoiceMemo(bytes: Uint8Array, mediaType: string): void {
  if (!bytes.length || bytes.length > 10 * 1024 * 1024)
    throw new Error('Choose an audio file of at most 10 MB.')
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end))
  const valid =
    mediaType === 'audio/wav'
      ? ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE'
      : mediaType === 'audio/mpeg'
        ? ascii(0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
        : mediaType === 'audio/mp4'
          ? ascii(4, 8) === 'ftyp'
          : mediaType === 'audio/ogg'
            ? ascii(0, 4) === 'OggS'
            : false
  if (!valid)
    throw new Error('The file does not match its audio format. Choose MP3, WAV, M4A, or Ogg audio.')
}
