import { z } from 'zod'
import { DESTINATION_MEDIA } from '@/lib/write/media-rules'

/**
 * Google Drive import (composer slice 3b): the browser picks files with Google
 * Picker under Shots' own Google Cloud project, downloads them with the
 * person's `drive.file` token, and uploads them as any other file. The token
 * never leaves the browser.
 */

/** Picker's public keys; Drive import is unavailable until all three exist. */
export const googleDriveConfigSchema = z.object({
  apiKey: z.string().min(1),
  /** The Cloud project number, which Picker calls the app id. */
  appId: z.string().regex(/^\d+$/),
  clientId: z.string().min(1),
})

/** One of {@link googleDriveConfigSchema}. */
export type GoogleDriveConfig = z.infer<typeof googleDriveConfigSchema>

/** The only scope Drive import asks for: the files the person picks. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'

/** The files a draft takes from Drive: the images and videos the composer uploads. */
export const DRIVE_MIME_TYPES = [
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/quicktime',
  'video/webm',
] as const

/** At most this many files in one import. */
export const DRIVE_PICK_LIMIT = 20

/** Nothing larger is downloaded: no destination takes a bigger video, nor image. */
export const DRIVE_MAX_BYTES = Math.max(
  ...Object.values(DESTINATION_MEDIA).map((rules) => rules.video?.maxBytes ?? 0)
)

/** A file as Picker returns it. */
export const drivePickSchema = z.object({
  id: z.string().min(1),
  mimeType: z.string(),
  name: z.string(),
  sizeBytes: z.coerce.number().int().nonnegative().optional(),
})

/** One of {@link drivePickSchema}. */
export type DrivePick = z.infer<typeof drivePickSchema>

/**
 * Downloads picked files as `File`s for the composer's upload, refusing what
 * no draft takes before any byte is fetched.
 */
export async function downloadDriveFiles(
  picks: DrivePick[],
  token: string,
  request: typeof fetch = fetch
): Promise<File[]> {
  if (picks.length > DRIVE_PICK_LIMIT)
    throw new Error(`Import up to ${DRIVE_PICK_LIMIT} files from Google Drive at a time.`)
  for (const pick of picks) {
    if (!DRIVE_MIME_TYPES.some((type) => type === pick.mimeType))
      throw new Error(`${pick.name} is not an image or video a post takes.`)
    if (pick.sizeBytes !== undefined && pick.sizeBytes > DRIVE_MAX_BYTES)
      throw new Error(`${pick.name} is larger than any platform takes.`)
  }
  return Promise.all(
    picks.map(async (pick) => {
      const response = await request(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(pick.id)}?alt=media`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      if (!response.ok) throw new Error(`Google Drive did not send ${pick.name}. Try again.`)
      return new File([await response.blob()], pick.name, { type: pick.mimeType })
    })
  )
}
