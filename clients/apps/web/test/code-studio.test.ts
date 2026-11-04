import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrandKit } from '@/lib/brand/kit'
import { contrastRatio } from '@/lib/launch/brand'
import { BRAND_THEME_ID, brandCodeTheme, resolveCodeTheme } from '@/lib/code-studio/brand-theme'
import {
  CODE_FILE_LIMIT,
  codeDocumentFromLegacy,
  codeDocumentSchema,
  documentLanguages,
  newCodeDocument,
  readCodeDocument,
} from '@/lib/code-studio/document'
import { languageForFileName, languageFromLegacy } from '@/lib/code-studio/languages'
import { ALT_TEXT_LIMIT, codeAltText, codePostBody, replyFitsX } from '@/lib/code-studio/post'

const kit = (overrides: Partial<BrandKit> = {}): BrandKit => ({
  accent: '#7c3aed',
  background: undefined,
  colors: { background: '#0b1020', foreground: '#f8fafc', palette: ['#22d3ee', '#0b1020'] },
  frame: undefined,
  id: 'kit-1',
  logos: [],
  name: 'Acme',
  primaryFont: null,
  secondaryFont: null,
  version: 3,
  ...overrides,
})

test('a new code document is valid and names its kind for the backend', () => {
  const document = newCodeDocument({ code: 'const a = 1', lang: 'typescript' })
  assert.equal(document.kind, 'code')
  assert.equal(document.version, 1)
  assert.equal(document.slides.length, 1)
  assert.deepEqual(codeDocumentSchema.parse(document), document)
  assert.deepEqual(documentLanguages(document), ['typescript'])
})

test('a code document refuses what the backend would refuse', () => {
  const document = newCodeDocument()
  const tooLong = structuredClone(document)
  tooLong.slides[0]!.panes[0]!.files[0]!.code = 'x'.repeat(CODE_FILE_LIMIT + 1)
  assert.equal(readCodeDocument(tooLong), null)
  assert.equal(readCodeDocument({ ...document, kind: 'canvas' }), null)
  assert.equal(readCodeDocument({ ...document, slides: [] }), null)
  const backwards = structuredClone(document)
  backwards.slides[0]!.panes[0]!.files[0]!.marks = { highlight: [[5, 2]], focus: [], blur: [] }
  assert.equal(readCodeDocument(backwards), null)
})

test('an unknown language or font reads as a safe default instead of failing', () => {
  const raw = structuredClone(newCodeDocument()) as unknown as {
    slides: { panes: { files: { lang: string }[] }[] }[]
    style: { font: string }
  }
  raw.slides[0]!.panes[0]!.files[0]!.lang = 'cobol-2099'
  raw.style.font = 'comic-sans'
  const read = readCodeDocument(raw)
  assert.equal(read?.slides[0]!.panes[0]!.files[0]!.lang, 'text')
  assert.equal(read?.style.font, 'jetbrainsMono')
})

test('old /code links open as a project with the same settings', () => {
  const document = codeDocumentFromLegacy({
    code: 'print(1)',
    lang: 'python',
    theme: 'sunset',
    window: 'none',
    padding: 32,
    dark: false,
  })
  assert.equal(document.slides[0]!.panes[0]!.files[0]!.code, 'print(1)')
  assert.equal(document.slides[0]!.panes[0]!.files[0]!.lang, 'python')
  assert.equal(document.style.theme, 'sunset')
  assert.equal(document.style.frame, 'card')
  assert.equal(document.style.padding, 32)
  assert.equal(document.style.dark, false)
  // An invalid padding keeps the defaults rather than failing the link.
  assert.equal(codeDocumentFromLegacy({ padding: 7 }).style.padding, 64)
  assert.equal(languageFromLegacy('auto'), 'typescript')
})

test('file names imply languages', () => {
  assert.equal(languageForFileName('src/app.tsx'), 'tsx')
  assert.equal(languageForFileName('Dockerfile'), 'dockerfile')
  assert.equal(languageForFileName('main.rs'), 'rust')
  assert.equal(languageForFileName('README'), null)
})

test('a brand theme uses brand colors only where they stay readable', () => {
  const theme = brandCodeTheme(kit())
  assert.equal(theme.from, '#0b1020')
  assert.equal(theme.to, '#7c3aed')
  assert.equal(theme.kitId, 'kit-1')
  for (const [palette, surface] of [
    [theme.dark, '#111111'],
    [theme.light, '#ffffff'],
  ] as const) {
    for (const color of [palette.keyword, palette.function, palette.string]) {
      assert.ok(color, 'a syntax color is missing')
      assert.ok(contrastRatio(color, surface) >= 3, `${color} is unreadable on ${surface}`)
    }
  }
  // The dark navy never colors code on the dark window.
  assert.notEqual(theme.dark.keyword, '#0b1020')
})

test('a brand theme with one color still makes a gradient', () => {
  const theme = brandCodeTheme(
    kit({
      accent: '#0b1020',
      colors: { background: '#0b1020', foreground: '#ffffff', palette: [] },
    })
  )
  assert.notEqual(theme.from, theme.to)
})

test('a style resolves its brand snapshot, a built-in theme, or Midnight', () => {
  const brand = brandCodeTheme(kit())
  assert.equal(resolveCodeTheme({ theme: BRAND_THEME_ID, brandTheme: brand }).label, 'Acme')
  assert.equal(resolveCodeTheme({ theme: 'sunset', brandTheme: null }).id, 'sunset')
  assert.equal(resolveCodeTheme({ theme: BRAND_THEME_ID, brandTheme: null }).id, 'midnight')
  assert.equal(resolveCodeTheme({ theme: 'gone', brandTheme: null }).id, 'midnight')
})

test('alt text names the language and fits the asset limit without splitting a character', () => {
  assert.equal(codeAltText('  let a = 1\n', 'rust'), 'Rust code:\nlet a = 1')
  const long = codeAltText('😀'.repeat(2_000), 'text')
  assert.equal([...long].length, ALT_TEXT_LIMIT)
  assert.ok(long.endsWith('…'))
  assert.ok(!/[\uD800-\uDBFF]…$/.test(long), 'a surrogate pair was split')
})

test('the post body attaches the image with alt text and can add the code as a reply', () => {
  const media = {
    id: '1b4e28ba-2fa1-11d2-883f-0016d3cca427',
    mediaType: 'image/png',
    alt: 'Go code',
  }
  const single = codePostBody({ media: [media] })
  assert.equal(single.filter((node) => node.type === 'post_break').length, 1)
  const image = single.find((node) => node.type === 'img')
  assert.equal(image?.alt, 'Go code')
  assert.equal(image?.assetId, media.id)

  const thread = codePostBody({ media: [media], reply: { code: 'a\n  b', lang: 'go' } })
  assert.equal(thread.filter((node) => node.type === 'post_break').length, 2)
  const block = thread.at(-1) as { type: string; children: { children: { text: string }[] }[] }
  assert.equal(block.type, 'code_block')
  assert.deepEqual(
    block.children.map((line) => line.children[0]!.text),
    ['a', '  b']
  )
  assert.equal(replyFitsX('x'.repeat(280)), true)
  assert.equal(replyFitsX('x'.repeat(281)), false)
})
