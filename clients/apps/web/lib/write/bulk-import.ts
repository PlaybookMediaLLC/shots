import { BATCH_ITEM_LIMIT } from '@/lib/api/contracts/content-batches'
import { safeAssetFileName } from '@/lib/workspace/save-export'
import { draftChannelSchema } from '@/lib/write/document'
import { isTimeZone, localDateTimeSchema } from '@/lib/write/zoned-time'

/**
 * Bulk batch input (RFC 042): CSV rows and selected files become batch items.
 * Media is matched by an existing workspace asset ID or an unambiguous
 * selected file name, never by a remote URL or a guess.
 */

/** The batch fields a CSV column can fill. */
const FIELDS = ['caption', 'asset', 'channels', 'time', 'timezone'] as const

/** One of the batch fields a CSV column can fill. */
export type ImportField = (typeof FIELDS)[number]

/** One CSV row: its caption, attachments in order, channels and intended time. */
export type ImportRow = {
  /** The row's line number in the file, for messages. */
  line: number
  caption: string
  /** Workspace asset IDs or selected file names, in attachment order. */
  assets: string[]
  channels: string[]
  /** A local time, YYYY-MM-DDTHH:MM, in `timeZone` or the batch's zone. */
  time?: string
  timeZone?: string
  /** What must be fixed in the row before it can be added. */
  problems: string[]
}

/** How the CSV's columns map to batch fields; unknown columns are ignored and listed. */
export type ImportMapping = { header: string; field: ImportField | null }[]

/**
 * What to fix in a row's channels before it can become a draft in a brand
 * with `connected` channels, or undefined. No channels is a valid unassigned
 * draft; a named channel must be supported and connected in the brand.
 */
export function channelProblem(channels: string[], connected: readonly string[]) {
  const unknown = channels.filter((channel) => !draftChannelSchema.safeParse(channel).success)
  if (unknown.length)
    return `Unknown channel ${unknown.join(', ')}. Use ${draftChannelSchema.options.join(', ')}, separated by semicolons.`
  const missing = channels.filter((channel) => !connected.includes(channel))
  if (missing.length)
    return `No connected ${missing.join(', ')} account in this publishing brand. Connect it, or remove it from this row's channels.`
}

/**
 * Split quoted CSV into rows, including embedded newlines and escaped quotes.
 * Each row keeps the file line it starts on, so a caption with a line break
 * does not shift the lines named after it.
 */
function csvRows(input: string): { line: number; values: string[] }[] {
  if (input.length > 1_000_000) throw new Error('CSV files must be smaller than 1 MB.')
  const rows: { line: number; values: string[] }[] = []
  let row: string[] = [],
    field = '',
    quoted = false,
    closed = false,
    line = 1,
    start = 1
  const fieldEnd = () => {
    row.push(field)
    field = ''
    closed = false
  }
  const rowEnd = () => {
    fieldEnd()
    if (row.some((value) => value.trim())) rows.push({ line: start, values: row })
    row = []
    start = line
  }
  const text = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '\n') line++
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
          closed = true
        }
      } else field += char
      continue
    }
    if (char === ',') fieldEnd()
    else if (char === '\n') rowEnd()
    else if (char === '"' && field === '' && !closed) quoted = true
    else if (closed || char === '"') throw new Error('Malformed CSV quoting.')
    else field += char
  }
  if (quoted) throw new Error('A quoted CSV field is unfinished.')
  rowEnd()
  return rows
}

const list = (value: string | undefined) =>
  (value ?? '')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)

/**
 * Parse a batch CSV. `caption` is required; `asset` (asset IDs or file names,
 * separated by semicolons), `channels`, `time` and `timezone` are optional.
 * Every row keeps its line and the problems found in it.
 */
export function parseBatchCSV(input: string): { mapping: ImportMapping; rows: ImportRow[] } {
  const rows = csvRows(input)
  const headers = rows.shift()?.values.map((value) => value.trim()) ?? []
  const mapping: ImportMapping = headers.map((header) => {
    const name = header.toLowerCase().replace(/[\s_-]+/g, '')
    const field = name === 'timezone' ? 'timezone' : FIELDS.find((item) => item === name)
    return { header, field: field ?? null }
  })
  const fields = mapping.flatMap((column) => (column.field ? [column.field] : []))
  if (!fields.includes('caption'))
    throw new Error('Add a caption column. Asset, channels, time and timezone are optional.')
  if (new Set(fields).size !== fields.length) throw new Error('Each CSV field may appear once.')
  if (!rows.length || rows.length > BATCH_ITEM_LIMIT)
    throw new Error(`Import between 1 and ${BATCH_ITEM_LIMIT} rows.`)
  return {
    mapping,
    rows: rows.map(({ line, values }) => {
      const problems: string[] = []
      if (values.length !== headers.length)
        problems.push(`Line ${line} has the wrong number of fields.`)
      const value = (field: ImportField) => {
        const at = mapping.findIndex((column) => column.field === field)
        return at < 0 ? undefined : values[at]
      }
      const caption = value('caption') ?? ''
      if (caption.length > 100_000) problems.push(`Line ${line}'s caption is too long.`)
      const time = (value('time') ?? '').trim().replace(' ', 'T')
      if (time && !isLocalTime(time))
        problems.push(`Line ${line}'s time must look like 2026-11-03 09:30.`)
      const timeZone = (value('timezone') ?? '').trim()
      if (timeZone && !isTimeZone(timeZone))
        problems.push(`Line ${line}'s time zone must be an IANA zone, such as Europe/Paris.`)
      const assets = list(value('asset'))
      if (assets.length > 20) problems.push(`Line ${line} has more than 20 attachments.`)
      return {
        line,
        caption,
        assets,
        channels: list(value('channels')).map((channel) => channel.toLowerCase()),
        ...(time ? { time } : {}),
        ...(timeZone ? { timeZone } : {}),
        problems,
      }
    }),
  }
}

/** A real day and clock time, as the server parses it: not 2027-02-30 or 24:00. */
function isLocalTime(time: string): boolean {
  const at = new Date(`${time}:00Z`)
  return (
    localDateTimeSchema.safeParse(time).success &&
    !Number.isNaN(at.getTime()) &&
    at.toISOString().startsWith(time)
  )
}

/** A workspace resource id: a cuid or a UUID. */
const ASSET_ID =
  /^(?:[a-z0-9]{10,32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

/** Whether a CSV media token names a workspace asset rather than a file. */
export const isAssetId = (token: string) => ASSET_ID.test(token)

/** An attachment of a row: a workspace asset, or a selected file to upload under `fileName`. */
export type MatchedMedia = { assetId: string } | { fileName: string; bytes: number }

/**
 * Match each row's attachments to selected files by exact name, or to
 * workspace assets by ID. A name shared by two selected files, an asset the
 * workspace does not have and a name nothing matches are problems; nothing
 * is guessed. `assets` holds the IDs the workspace confirmed.
 */
export function matchRowMedia(
  row: Pick<ImportRow, 'assets' | 'line'>,
  files: readonly { name: string; size: number }[],
  assets: ReadonlySet<string>
): { media: MatchedMedia[]; problems: string[] } {
  const media: MatchedMedia[] = []
  const problems: string[] = []
  for (const token of row.assets) {
    const named = files.filter((file) => file.name === token)
    if (named.length > 1) {
      problems.push(`Two selected files are named ${token}. Rename one and select the files again.`)
    } else if (named.length === 1) {
      // Stored under a name object keys accept; the person still matches by the original.
      const fileName = safeAssetFileName(token)
      if (!fileName) problems.push(`Rename ${token}: its name has no letters or digits to keep.`)
      else if (files.some((file) => file !== named[0] && safeAssetFileName(file.name) === fileName))
        problems.push(
          `${token} and another selected file would both be saved as ${fileName}. Rename one and select the files again.`
        )
      else media.push({ fileName, bytes: named[0].size })
    } else if (isAssetId(token)) {
      if (assets.has(token)) media.push({ assetId: token })
      else problems.push(`Line ${row.line}: asset ${token} is not in this workspace's library.`)
    } else {
      problems.push(
        `Line ${row.line}: no selected file is named ${token}. Select it, or use a workspace asset ID.`
      )
    }
  }
  return { media, problems }
}

/** File names used by no row, so the person sees what will not be added. */
export function unusedFiles(rows: Pick<ImportRow, 'assets'>[], files: readonly { name: string }[]) {
  const used = new Set(rows.flatMap((row) => row.assets))
  return files.filter((file) => !used.has(file.name)).map((file) => file.name)
}
