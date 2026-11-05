import {
  CODE_FILE_LIMIT,
  CODE_SLIDE_LIMIT,
  codeSourceSchema,
  newCodeFile,
  newCodeSlide,
  type CodeDocument,
  type CodeFile,
  type CodeSlide,
} from './document'
import { languageForFileName } from './languages'
import { DEFAULT_CODE } from '@/components/code-image/code-themes'

/** One file a link returned: whole code, or a unified patch. */
export type ImportedFile = { name: string; code?: string; patch?: string; status?: string }

/** What a code import returned, as the backend sends it. */
export type ImportedCode = {
  kind: 'github-file' | 'github-pull' | 'github-commit' | 'gist'
  url: string
  repo?: string
  ref?: string
  path?: string
  title?: string
  files: ImportedFile[]
}

/** The line shown between two hunks of one file. */
export const HUNK_GAP = '⋯'

/**
 * The before and after code of a unified patch's hunks. Hunks are joined by
 * a gap line, so a diff of the result shows only what changed.
 */
export function patchSides(patch: string): { before: string; after: string } {
  const before: string[] = []
  const after: string[] = []
  let hunks = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      if (hunks++ > 0) {
        before.push(HUNK_GAP)
        after.push(HUNK_GAP)
      }
      continue
    }
    if (line.startsWith('\\')) continue
    const body = line.slice(1)
    if (line.startsWith('-')) before.push(body)
    else if (line.startsWith('+')) after.push(body)
    else {
      before.push(body)
      after.push(body)
    }
  }
  return { before: before.join('\n'), after: after.join('\n') }
}

const fileName = (path: string) => path.split('/').pop() ?? path

function importedFile(name: string, code: string, extra: Partial<CodeFile> = {}): CodeFile {
  return newCodeFile({
    name: fileName(name).slice(0, 120),
    lang: languageForFileName(name) ?? 'text',
    code: code.slice(0, CODE_FILE_LIMIT),
    ...extra,
  })
}

/** How a change becomes slides: one diff per file, or before and after to animate. */
export type ImportMode = 'diff' | 'animate'

/** Slides for an import: files as tabs, or each changed file as a diff or a before/after pair. */
export function importedSlides(result: ImportedCode, mode: ImportMode = 'diff'): CodeSlide[] {
  if (result.kind === 'github-file' || result.kind === 'gist') {
    const files = result.files.slice(0, 10).map((file) => importedFile(file.name, file.code ?? ''))
    return files.length ? [newCodeSlide(files)] : []
  }
  return result.files
    .filter((file) => file.patch)
    .flatMap((file): CodeSlide[] => {
      const { before, after } = patchSides(file.patch!)
      if (mode === 'animate')
        return [
          newCodeSlide([importedFile(file.name, before)], { transition: 'cut' }),
          newCodeSlide([importedFile(file.name, after)], { transition: 'morph' }),
        ]
      return [
        newCodeSlide([
          importedFile(file.name, after, {
            base: before.slice(0, CODE_FILE_LIMIT),
            diff: 'unified',
          }),
        ]),
      ]
    })
}

/** Whether a project still holds only the starter snippet, which an import replaces. */
export function isStarter(document: CodeDocument): boolean {
  const [slide] = document.slides
  return (
    document.slides.length === 1 &&
    slide!.panes.length === 1 &&
    slide!.panes[0]!.files.length === 1 &&
    slide!.panes[0]!.files[0]!.code === DEFAULT_CODE
  )
}

/**
 * Add imported slides after `at`, or in place of the starter snippet, and
 * record where the code came from. Returns the document and the first new slide.
 */
export function withImport(
  document: CodeDocument,
  slides: CodeSlide[],
  at: number,
  source?: ImportedCode
): { document: CodeDocument; slide: number } {
  if (!slides.length) return { document, slide: at }
  const replace = isStarter(document)
  const next = structuredClone(document)
  const room = CODE_SLIDE_LIMIT - (replace ? 0 : next.slides.length)
  const added = slides.slice(0, Math.max(0, room))
  if (!added.length) return { document, slide: at }
  if (replace) next.slides = added
  else next.slides.splice(at + 1, 0, ...added)
  if (source) {
    const parsed = codeSourceSchema.safeParse({
      kind: source.kind,
      url: source.url,
      repo: source.repo,
      ref: source.ref,
      path: source.path,
    })
    if (parsed.success) next.source = parsed.data
  }
  return { document: next, slide: replace ? 0 : at + 1 }
}

/** A local file as a slide; it never leaves the browser until the project is saved. */
export function fileSlide(name: string, text: string): CodeSlide {
  return newCodeSlide([importedFile(name, text)])
}
