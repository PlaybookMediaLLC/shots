import { BATCH_MEDIA_LIMIT } from '@/lib/api/contracts/content-batches'
import { uploadByteLimit } from '@/lib/write/media-limits'
import { safeAssetFileName } from '@/lib/workspace/save-export'

/**
 * Selected folders become batch posts. A folder that directly holds images is
 * one post, so a parent folder of subfolders makes several, or each image can
 * be its own post. Grouping and order are decided here, in one place, and
 * shown before anything is added.
 */

/** A selected file; folder selection and folder drops each record a path differently. */
export type IntakeFile = {
  name: string
  path?: string
  size: number
  type: string
  webkitRelativePath?: string
}

/** How selected files group into posts. */
export type IntakeMode = 'folder' | 'per-image'

/** One post a selection makes. */
export type IntakePost<File extends IntakeFile> = {
  /** The folder or file name as the person knows it; caption CSVs match on it. */
  sourceKey: string
  files: File[]
  /** The name each file is stored under, parallel to `files`. */
  storedNames: string[]
  /** What must be fixed before the post can be added. */
  problems: string[]
}

const IMAGE_TYPES: Record<string, string> = {
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

/** A file's folders and name, whichever way the browser recorded them. */
function segments(file: IntakeFile): string[] {
  const path = file.webkitRelativePath || file.path || file.name
  return path.split('/').filter((part) => part && part !== '.')
}

/** Whether a file was selected inside a folder rather than on its own. */
export function isInFolder(file: IntakeFile): boolean {
  return segments(file).length > 1
}

/**
 * The name a file is stored under. A file in a folder keeps its folders in the
 * name, so `a/1.png` and `b/1.png` stay apart and selecting the folder again
 * finds each one. Long paths lose their start, never the extension.
 */
export function storedFileName(file: IntakeFile): string {
  return safeAssetFileName(segments(file).join('-').slice(-128))
}

const natural = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })

/** The image type of a file, from the browser or its extension. */
function imageType(file: IntakeFile): string | undefined {
  if (Object.values(IMAGE_TYPES).includes(file.type)) return file.type
  if (file.type) return undefined
  return IMAGE_TYPES[file.name.split('.').pop()?.toLowerCase() ?? '']
}

/**
 * Group selected files into posts, in natural path order. What cannot be part
 * of a post (hidden files, other types, empty files) is listed, not dropped.
 */
export function groupFiles<File extends IntakeFile>(files: readonly File[], mode: IntakeMode) {
  const skipped: { name: string; reason: string }[] = []
  const groups = new Map<string, File[]>()
  for (const file of files) {
    const parts = segments(file)
    const shown = parts.join('/')
    if (parts.some((part) => part.startsWith('.') || part === '__MACOSX')) {
      skipped.push({ name: shown, reason: 'Hidden file' })
    } else if (!imageType(file)) {
      skipped.push({ name: shown, reason: 'Not a JPEG, PNG, WebP or GIF image' })
    } else if (!file.size) {
      skipped.push({ name: shown, reason: 'Empty file' })
    } else {
      const key = mode === 'per-image' ? shown : parts.slice(0, -1).join('/')
      groups.set(key, [...(groups.get(key) ?? []), file])
    }
  }
  const posts = [...groups.keys()].sort(natural).map((key): IntakePost<File> => {
    const sorted = groups.get(key)!.sort((a, b) => natural(a.name, b.name))
    const problems: string[] = []
    if (sorted.length > BATCH_MEDIA_LIMIT)
      problems.push(
        `${key || 'This post'} has ${sorted.length} images, and a post takes ${BATCH_MEDIA_LIMIT}. Split the folder.`
      )
    for (const file of sorted) {
      const limit = uploadByteLimit(imageType(file)!)
      if (file.size > limit)
        problems.push(`${file.name} is over the ${Math.round(limit / 1_000_000)} MB image limit.`)
    }
    return {
      sourceKey: key.split('/').pop() || sorted[0]!.name,
      files: sorted,
      storedNames: sorted.map(storedFileName),
      problems,
    }
  })
  // Names must stay apart across the whole selection: a reload matches files by them.
  const seen = new Map<string, string>()
  for (const post of posts) {
    post.files.forEach((file, index) => {
      const name = post.storedNames[index]!
      const shown = segments(file).join('/')
      const other = seen.get(name)
      if (!name) post.problems.push(`Rename ${shown}: its name has no letters or digits to keep.`)
      else if (other)
        post.problems.push(`${shown} and ${other} would be saved under one name. Rename one.`)
      else seen.set(name, shown)
    })
  }
  return { posts, skipped }
}
