import {
  activeFile,
  codeId,
  CODE_SLIDE_LIMIT,
  newCodeFile,
  type CodeAnnotation,
  type CodeDocument,
  type CodeFile,
  type CodeSlide,
  type LineMarks,
  type LineRange,
} from './document'

/**
 * Pure edits to a code document. Each returns a new document and leaves the
 * input untouched, so the session can diff, undo and merge them.
 */

type FileRef = { slide: number; pane: string; file: string }

function clone(document: CodeDocument): CodeDocument {
  return structuredClone(document)
}

/** Change one file. */
export function updateFile(
  document: CodeDocument,
  ref: FileRef,
  patch: Partial<Omit<CodeFile, 'id'>>
): CodeDocument {
  const next = clone(document)
  const file = next.slides[ref.slide]?.panes
    .find((pane) => pane.id === ref.pane)
    ?.files.find((item) => item.id === ref.file)
  if (!file) return document
  Object.assign(file, patch)
  for (const [key, value] of Object.entries(patch))
    if (value === undefined) delete (file as Record<string, unknown>)[key]
  return next
}

/** Show another file of a pane. */
export function selectFile(document: CodeDocument, slide: number, pane: string, file: string) {
  const next = clone(document)
  const target = next.slides[slide]?.panes.find((item) => item.id === pane)
  if (!target?.files.some((item) => item.id === file)) return document
  target.activeFile = file
  return next
}

/** Add a file to a pane as a new tab and show it. */
export function addFile(
  document: CodeDocument,
  slide: number,
  pane: string,
  input: Partial<CodeFile> = {}
): CodeDocument {
  const next = clone(document)
  const target = next.slides[slide]?.panes.find((item) => item.id === pane)
  if (!target || target.files.length >= 10) return document
  const file = newCodeFile({ name: `file${target.files.length + 1}.ts`, ...input })
  target.files.push(file)
  target.activeFile = file.id
  return next
}

/** Remove a tab; a pane keeps at least one file. */
export function removeFile(document: CodeDocument, ref: FileRef): CodeDocument {
  const next = clone(document)
  const pane = next.slides[ref.slide]?.panes.find((item) => item.id === ref.pane)
  if (!pane || pane.files.length <= 1) return document
  pane.files = pane.files.filter((file) => file.id !== ref.file)
  if (pane.activeFile === ref.file) pane.activeFile = pane.files[0]!.id
  return next
}

/** One pane, or two side by side; the second starts as a copy of the first. */
export function setLayout(document: CodeDocument, slide: number, layout: CodeSlide['layout']) {
  const next = clone(document)
  const target = next.slides[slide]
  if (!target) return document
  target.layout = layout
  if (layout === 'single') target.panes = target.panes.slice(0, 1)
  else if (target.panes.length === 1) {
    const copy = structuredClone(activeFile(target.panes[0]!))
    copy.id = codeId()
    target.panes.push({ id: codeId(), activeFile: copy.id, files: [copy] })
  }
  return next
}

/** Copy a slide after itself, as the next step of a carousel or video. */
export function duplicateSlide(document: CodeDocument, slide: number): CodeDocument {
  if (document.slides.length >= CODE_SLIDE_LIMIT) return document
  const next = clone(document)
  const copy = structuredClone(next.slides[slide]!)
  copy.id = codeId()
  for (const pane of copy.panes) {
    pane.id = codeId()
    for (const file of pane.files) {
      const id = codeId()
      if (pane.activeFile === file.id) pane.activeFile = id
      file.id = id
    }
  }
  next.slides.splice(slide + 1, 0, copy)
  return next
}

/** Remove a slide; a project keeps at least one. */
export function removeSlide(document: CodeDocument, slide: number): CodeDocument {
  if (document.slides.length <= 1) return document
  const next = clone(document)
  next.slides.splice(slide, 1)
  return next
}

/** Move a slide one place earlier or later. */
export function moveSlide(document: CodeDocument, slide: number, by: -1 | 1): CodeDocument {
  const to = slide + by
  if (to < 0 || to >= document.slides.length) return document
  const next = clone(document)
  const [moved] = next.slides.splice(slide, 1)
  next.slides.splice(to, 0, moved!)
  return next
}

/** Change one slide's caption, timing or transition. */
export function updateSlide(
  document: CodeDocument,
  slide: number,
  patch: Partial<Pick<CodeSlide, 'caption' | 'duration' | 'transition' | 'transitionDuration'>>
): CodeDocument {
  const next = clone(document)
  if (!next.slides[slide]) return document
  Object.assign(next.slides[slide]!, patch)
  return next
}

/** Merge touching or overlapping ranges, in order. */
export function normalizeRanges(ranges: LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const result: LineRange[] = []
  for (const [start, end] of sorted) {
    const last = result.at(-1)
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end)
    else result.push([start, end])
  }
  return result
}

/** Toggle an emphasis on a range: added when any of it is unmarked, otherwise removed. */
export function toggleMark(
  marks: LineMarks | undefined,
  kind: keyof LineMarks,
  range: LineRange
): LineMarks {
  const current = marks ?? { highlight: [], focus: [], blur: [] }
  const covered = (line: number) =>
    current[kind].some(([start, end]) => line >= start && line <= end)
  const lines = Array.from({ length: range[1] - range[0] + 1 }, (_, index) => range[0] + index)
  let ranges: LineRange[]
  if (lines.every(covered)) {
    // Remove the range, splitting any mark that extends past it.
    ranges = current[kind].flatMap(([start, end]): LineRange[] => {
      if (end < range[0] || start > range[1]) return [[start, end]]
      const parts: LineRange[] = []
      if (start < range[0]) parts.push([start, range[0] - 1])
      if (end > range[1]) parts.push([range[1] + 1, end])
      return parts
    })
  } else ranges = normalizeRanges([...current[kind], range])
  return { ...current, [kind]: ranges }
}

/** Add an annotation at a line. */
export function addAnnotation(
  annotations: CodeAnnotation[] | undefined,
  kind: CodeAnnotation['kind'],
  line: number
): CodeAnnotation[] {
  return [...(annotations ?? []), { id: codeId(), kind, line, text: '' }].slice(0, 20)
}
