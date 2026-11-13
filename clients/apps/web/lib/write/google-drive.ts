import { z } from 'zod'
import { supportedDraftMedia } from '@/lib/platform/asset-handoff'
import { uploadByteLimit } from '@/lib/write/media-limits'

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

export type GoogleDriveConfig = z.infer<typeof googleDriveConfigSchema>

/** The only scope Drive import asks for: the files the person picks. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'

/** As many files as the editor's own upload takes at once (`maxFileCount`). */
export const DRIVE_PICK_LIMIT = 20

/** A file as Picker returns it. */
export const drivePickSchema = z.object({
  id: z.string().min(1),
  mimeType: z.string(),
  name: z.string(),
  sizeBytes: z.coerce.number().int().nonnegative().optional(),
})

export type DrivePick = z.infer<typeof drivePickSchema>

/**
 * Downloads picked files as `File`s for the composer's upload. What no draft
 * takes is refused before any byte is fetched; a file Drive does not send is
 * named in `failed`, and the others still arrive.
 */
export async function downloadDriveFiles(
  picks: DrivePick[],
  token: string,
  { request = fetch, signal }: { request?: typeof fetch; signal?: AbortSignal } = {}
): Promise<{ failed: string[]; files: File[] }> {
  if (picks.length > DRIVE_PICK_LIMIT)
    throw new Error(`Import up to ${DRIVE_PICK_LIMIT} files from Google Drive at a time.`)
  for (const pick of picks) {
    if (!supportedDraftMedia(pick.mimeType))
      throw new Error(`${pick.name} is not an image or video a post takes.`)
    if (pick.sizeBytes !== undefined && pick.sizeBytes > uploadByteLimit(pick.mimeType))
      throw new Error(`${pick.name} is larger than Shots uploads.`)
  }
  const results = await Promise.allSettled(
    picks.map(async (pick) => {
      const response = await request(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(pick.id)}?alt=media`,
        { headers: { Authorization: `Bearer ${token}` }, signal }
      )
      if (!response.ok) throw new Error(pick.name)
      return new File([await response.blob()], pick.name, { type: pick.mimeType })
    })
  )
  return {
    failed: picks
      .filter((_, index) => results[index]!.status === 'rejected')
      .map((pick) => pick.name),
    files: results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : [])),
  }
}
