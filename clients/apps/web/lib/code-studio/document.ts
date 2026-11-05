import { z } from 'zod'
import {
  DEFAULT_CODE,
  FONTS,
  FRAME_WIDTH_DEFAULT,
  FRAME_WIDTH_MAX,
  FRAME_WIDTH_MIN,
  PADDING_OPTIONS,
  type CodeImageState,
} from '@/components/code-image/code-themes'
import { CODE_LANGUAGE_IDS, languageFromLegacy } from './languages'

/**
 * A Code Studio project (RFC 053), stored as a creative set of kind `code`.
 * Every phase's fields are here from version 1 and optional, so a later
 * feature never needs a document migration. Never name a key `brand` or
 * `reusable`: the backend validates those as pins wherever they appear.
 */

/** Characters in one file's code or diff base; the backend enforces the same. */
export const CODE_FILE_LIMIT = 100_000
/** Slides in one project; the backend enforces the same. */
export const CODE_SLIDE_LIMIT = 50

/** Output shapes: auto fits the code; the rest are social sizes. */
export const CODE_ASPECTS = ['auto', '16:9', '1.91:1', '1:1', '4:5', '9:16'] as const
/** One of {@link CODE_ASPECTS}. */
export type CodeAspect = (typeof CODE_ASPECTS)[number]

/** Where each aspect is used, for the size picker. */
export const CODE_ASPECT_LABELS: Record<CodeAspect, string> = {
  auto: 'Fit code',
  '16:9': 'X, YouTube · 16:9',
  '1.91:1': 'LinkedIn link · 1.91:1',
  '1:1': 'Square · 1:1',
  '4:5': 'Instagram, LinkedIn · 4:5',
  '9:16': 'TikTok, Shorts, Reels · 9:16',
}

/** Width over height for each fixed aspect. */
export const CODE_ASPECT_RATIOS: Record<Exclude<CodeAspect, 'auto'>, number> = {
  '16:9': 16 / 9,
  '1.91:1': 1.91,
  '1:1': 1,
  '4:5': 4 / 5,
  '9:16': 9 / 16,
}

/** Window chrome: an editor or terminal title bar, a plain window, or code straight on the background. */
export const CODE_FRAMES = ['mac', 'terminal', 'card', 'none'] as const
/** How one slide becomes the next in a video. */
export const CODE_TRANSITIONS = ['morph', 'type', 'highlight', 'cut'] as const
/** One of {@link CODE_TRANSITIONS}. */
export type CodeTransition = (typeof CODE_TRANSITIONS)[number]

const id = z.string().trim().min(1).max(80)
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const line = z.number().int().min(1).max(20_000)

/** A syntax palette, as the ray.so-derived themes define them. */
export const syntaxPaletteSchema = z.object({
  foreground: color,
  constant: color.optional(),
  string: color.optional(),
  comment: color.optional(),
  keyword: color.optional(),
  parameter: color.optional(),
  function: color.optional(),
  stringExpression: color.optional(),
  punctuation: color.optional(),
  link: color.optional(),
  number: color.optional(),
  property: color.optional(),
})
/** One of {@link syntaxPaletteSchema}. */
export type SyntaxPalette = z.infer<typeof syntaxPaletteSchema>

/** A brand kit turned into a theme, kept frozen so archiving the kit never breaks a save. */
export const brandCodeThemeSchema = z.object({
  kitId: z.string().max(200),
  name: z.string().trim().min(1).max(200),
  from: color,
  to: color,
  accent: color,
  light: syntaxPaletteSchema,
  dark: syntaxPaletteSchema,
})
/** One of {@link brandCodeThemeSchema}. */
export type BrandCodeTheme = z.infer<typeof brandCodeThemeSchema>

/** An inclusive range of 1-based lines. */
export const lineRangeSchema = z
  .tuple([line, line])
  .refine(([start, end]) => start <= end, 'A range starts before it ends.')
/** One of {@link lineRangeSchema}. */
export type LineRange = z.infer<typeof lineRangeSchema>

const ranges = z.array(lineRangeSchema).max(50).default([])

/** Lines to emphasize: highlighted, in focus (the rest dims) or blurred. */
export const lineMarksSchema = z.object({ highlight: ranges, focus: ranges, blur: ranges })
/** One of {@link lineMarksSchema}. */
export type LineMarks = z.infer<typeof lineMarksSchema>

/** A numbered marker at a line's end, or a callout beside it with an arrow. */
export const annotationSchema = z.object({
  id,
  kind: z.enum(['marker', 'callout']),
  line,
  text: z.string().trim().max(280).default(''),
})
/** One of {@link annotationSchema}. */
export type CodeAnnotation = z.infer<typeof annotationSchema>

/** One file: its code, and optionally the code it changed from and a terminal script. */
export const codeFileSchema = z.object({
  id,
  name: z.string().trim().max(120).default(''),
  lang: z.enum(CODE_LANGUAGE_IDS).catch('text'),
  code: z.string().max(CODE_FILE_LIMIT, 'Keep each file under 100,000 characters.'),
  base: z.string().max(CODE_FILE_LIMIT).optional(),
  diff: z.enum(['unified', 'split']).optional(),
  marks: lineMarksSchema.optional(),
  annotations: z.array(annotationSchema).max(20).optional(),
  tape: z.string().max(20_000).optional(),
})
/** One of {@link codeFileSchema}. */
export type CodeFile = z.infer<typeof codeFileSchema>

/** A pane shows one of its files, as a tab. */
export const codePaneSchema = z.object({
  id,
  activeFile: id,
  files: z.array(codeFileSchema).min(1).max(10),
})
/** One of {@link codePaneSchema}. */
export type CodePane = z.infer<typeof codePaneSchema>

/** One carousel page and one step of a video. */
export const codeSlideSchema = z.object({
  id,
  layout: z.enum(['single', 'split']).default('single'),
  panes: z.array(codePaneSchema).min(1).max(2),
  caption: z.string().trim().max(280).default(''),
  /** How long the slide holds, in milliseconds. */
  duration: z.number().int().min(300).max(20_000).default(2_500),
  transition: z.enum(CODE_TRANSITIONS).default('morph'),
  /** How long the transition into this slide takes, in milliseconds. */
  transitionDuration: z.number().int().min(100).max(5_000).default(800),
})
/** One of {@link codeSlideSchema}. */
export type CodeSlide = z.infer<typeof codeSlideSchema>

/** An attribution footer: who posted it, with the brand logo. */
export const codeFooterSchema = z.object({
  show: z.boolean().default(false),
  name: z.string().trim().max(80).default(''),
  handle: z.string().trim().max(80).default(''),
  /** `asset:<uuid>` of an uploaded workspace image; the backend checks ownership. */
  logo: z
    .string()
    .regex(/^asset:[0-9a-fA-F-]{36}$/)
    .optional(),
})

/** How every slide looks. */
export const codeStyleSchema = z.object({
  theme: z.string().max(80).default('midnight'),
  brandTheme: brandCodeThemeSchema.nullable().default(null),
  dark: z.boolean().default(true),
  showBackground: z.boolean().default(true),
  background: z
    .object({
      kind: z.enum(['theme', 'gradient', 'image', 'pattern']),
      id: z.string().max(400),
    })
    .default({ kind: 'theme', id: '' }),
  padding: z
    .number()
    .refine((value) => (PADDING_OPTIONS as readonly number[]).includes(value))
    .default(64),
  font: z
    .string()
    .refine((value) => FONTS.some((font) => font.id === value))
    .catch('jetbrainsMono'),
  lineNumbers: z.boolean().default(true),
  frame: z.enum(CODE_FRAMES).default('mac'),
  title: z.string().max(60).default(''),
  width: z.number().int().min(FRAME_WIDTH_MIN).max(FRAME_WIDTH_MAX).default(FRAME_WIDTH_DEFAULT),
  aspect: z.enum(CODE_ASPECTS).default('auto'),
  footer: codeFooterSchema.default({ show: false, name: '', handle: '' }),
})
/** One of {@link codeStyleSchema}. */
export type CodeStyle = z.infer<typeof codeStyleSchema>

/** Where imported code came from, so the library can filter by repository. */
export const codeSourceSchema = z.object({
  kind: z.enum(['github-file', 'github-pull', 'github-commit', 'gist', 'file']),
  url: z.string().max(2_000).optional(),
  repo: z.string().max(200).optional(),
  ref: z.string().max(200).optional(),
  path: z.string().max(1_000).optional(),
})

/** A Code Studio project's stored document. */
export const codeDocumentSchema = z.object({
  version: z.literal(1),
  kind: z.literal('code'),
  style: codeStyleSchema,
  slides: z.array(codeSlideSchema).min(1).max(CODE_SLIDE_LIMIT),
  source: codeSourceSchema.optional(),
})
/** One of {@link codeDocumentSchema}. */
export type CodeDocument = z.infer<typeof codeDocumentSchema>

/** A new id for a slide, pane, file or annotation. */
export function codeId(): string {
  return crypto.randomUUID().slice(0, 12)
}

/** A file with defaults filled in. */
export function newCodeFile(input: Partial<CodeFile> = {}): CodeFile {
  return codeFileSchema.parse({ id: codeId(), name: '', lang: 'typescript', code: '', ...input })
}

/** A slide holding the given files in one pane. */
export function newCodeSlide(files: CodeFile[], input: Partial<CodeSlide> = {}): CodeSlide {
  const pane = { id: codeId(), activeFile: files[0]!.id, files }
  return codeSlideSchema.parse({ id: codeId(), panes: [pane], ...input })
}

/** A new project: one slide with one file. */
export function newCodeDocument(
  file: Partial<CodeFile> = {},
  style: Partial<CodeStyle> = {}
): CodeDocument {
  return codeDocumentSchema.parse({
    version: 1,
    kind: 'code',
    style: codeStyleSchema.parse(style),
    slides: [newCodeSlide([newCodeFile({ code: DEFAULT_CODE, ...file })])],
  })
}

/** A project from the old /code editor's URL state, so shared links keep working. */
export function codeDocumentFromLegacy(state: Partial<CodeImageState>): CodeDocument {
  const style = codeStyleSchema.safeParse({
    theme: state.theme,
    dark: state.dark,
    showBackground: state.showBackground,
    background: state.background,
    padding: state.padding,
    font: state.font,
    lineNumbers: state.lineNumbers,
    frame: state.window === 'none' ? 'card' : 'mac',
    title: state.title,
    width: state.width,
  })
  return newCodeDocument(
    {
      code: typeof state.code === 'string' ? state.code.slice(0, CODE_FILE_LIMIT) : DEFAULT_CODE,
      lang: languageFromLegacy(state.lang),
    },
    style.success ? style.data : {}
  )
}

/** Parse a stored document; null when it is not one this app can read. */
export function readCodeDocument(raw: unknown): CodeDocument | null {
  const parsed = codeDocumentSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** The file a pane shows. */
export function activeFile(pane: CodePane): CodeFile {
  return pane.files.find((file) => file.id === pane.activeFile) ?? pane.files[0]!
}

/** Every file in the project. */
export function allFiles(document: CodeDocument): CodeFile[] {
  return document.slides.flatMap((slide) => slide.panes.flatMap((pane) => pane.files))
}

/** The languages a project uses, for library filters. */
export function documentLanguages(document: CodeDocument): string[] {
  return [...new Set(allFiles(document).map((file) => file.lang))]
}
