import type { DiffRow } from '@/lib/line-diff'
export { lineDiff, type DiffRow } from '@/lib/line-diff'

/** Lines added and removed, for a summary such as "+3 −1". */
export function diffStats(rows: DiffRow[]): { added: number; removed: number } {
  return {
    added: rows.filter((row) => row.kind === 'add').length,
    removed: rows.filter((row) => row.kind === 'del').length,
  }
}

/**
 * Rows for a side-by-side view: each removal pairs with the next addition in
 * the same change, and unpaired lines face a blank.
 */
export function splitRows(
  rows: DiffRow[]
): { before?: number; after?: number; kind: 'same' | 'change' }[] {
  const result: { before?: number; after?: number; kind: 'same' | 'change' }[] = []
  let index = 0
  while (index < rows.length) {
    const row = rows[index]!
    if (row.kind === 'same') {
      result.push({ before: row.before, after: row.after, kind: 'same' })
      index++
      continue
    }
    const removed: number[] = []
    const added: number[] = []
    while (index < rows.length && rows[index]!.kind !== 'same') {
      const change = rows[index]!
      if (change.kind === 'del') removed.push(change.before)
      else if (change.kind === 'add') added.push(change.after)
      index++
    }
    for (let k = 0; k < Math.max(removed.length, added.length); k++)
      result.push({ before: removed[k], after: added[k], kind: 'change' })
  }
  return result
}
