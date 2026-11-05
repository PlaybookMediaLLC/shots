/** One row of a line diff: unchanged, added or removed, with its line numbers. */
export type DiffRow =
  | { kind: 'same'; before: number; after: number }
  | { kind: 'add'; after: number }
  | { kind: 'del'; before: number }

/** Lines compared by the longest common subsequence; both sides above this compare as replaced. */
const LCS_LIMIT = 4_000

/**
 * A line diff of `before` against `after`, in reading order, with 1-based
 * line numbers into each side. Removals come before additions in a change.
 */
export function lineDiff(before: string, after: string): DiffRow[] {
  const a = before.split('\n')
  const b = after.split('\n')
  // Trim the common head and tail so the table only covers the changed middle.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const rows: DiffRow[] = []
  for (let i = 0; i < start; i++) rows.push({ kind: 'same', before: i + 1, after: i + 1 })
  const n = endA - start
  const m = endB - start
  if (n > 0 && m > 0 && n * m <= LCS_LIMIT * LCS_LIMIT) {
    // shortcut: O(n·m) table; switch to Myers if diffs of very large files are common.
    const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        table[i]![j] =
          a[start + i] === b[start + j]
            ? table[i + 1]![j + 1]! + 1
            : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && a[start + i] === b[start + j]) {
        rows.push({ kind: 'same', before: start + i + 1, after: start + j + 1 })
        i++
        j++
      } else if (j >= m || (i < n && table[i + 1]![j]! >= table[i]![j + 1]!)) {
        rows.push({ kind: 'del', before: start + i + 1 })
        i++
      } else {
        rows.push({ kind: 'add', after: start + j + 1 })
        j++
      }
    }
  } else {
    for (let i = start; i < endA; i++) rows.push({ kind: 'del', before: i + 1 })
    for (let j = start; j < endB; j++) rows.push({ kind: 'add', after: j + 1 })
  }
  for (let k = 0; k < a.length - endA; k++)
    rows.push({ kind: 'same', before: endA + k + 1, after: endB + k + 1 })
  return rows
}

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
