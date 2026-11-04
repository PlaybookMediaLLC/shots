import type { CSSProperties } from 'react'
import type { HighlighterCore, ThemedToken } from 'shiki/core'
import type { SyntaxPalette } from './document'

/**
 * Shiki highlighting for Code Studio (RFC 053). One CSS-variables theme
 * colors every token, so the ray.so palettes and brand themes are just
 * variables on the scene, and grammars load on first use. The JavaScript
 * regex engine avoids shipping Oniguruma's WebAssembly.
 */

const THEME = 'shots-code'
const PREFIX = '--code-'

let highlighter: Promise<HighlighterCore> | null = null

async function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore, createCssVariablesTheme }, { createJavaScriptRegexEngine }] =
      await Promise.all([import('shiki/core'), import('shiki/engine/javascript')])
    return createHighlighterCore({
      themes: [createCssVariablesTheme({ name: THEME, variablePrefix: PREFIX })],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    })
  })()
  return highlighter
}

const cache = new Map<string, ThemedToken[][]>()
const CACHE_LIMIT = 300
const listeners = new Set<() => void>()

/** Hear about newly highlighted code, for `useSyncExternalStore`. */
export function subscribeHighlights(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function cacheKey(code: string, lang: string) {
  return `${lang}\u0000${code}`
}

/** Highlighted lines already in memory, or null; never starts work. */
export function cachedLines(code: string, lang: string): ThemedToken[][] | null {
  return cache.get(cacheKey(code, lang)) ?? null
}

/** Plain lines in the foreground color, while a grammar loads. */
export function plainLines(code: string): ThemedToken[][] {
  return code
    .split('\n')
    .map((content, offset) =>
      content ? [{ content, offset, color: `var(${PREFIX}foreground)` }] : []
    )
}

/** Highlight code into lines of tokens; unknown or plain-text languages stay plain. */
export async function highlightLines(code: string, lang: string): Promise<ThemedToken[][]> {
  const key = cacheKey(code, lang)
  const hit = cache.get(key)
  if (hit) return hit
  let lines: ThemedToken[][]
  if (lang === 'text') {
    lines = plainLines(code)
  } else {
    const shiki = await getHighlighter()
    if (!shiki.getLoadedLanguages().includes(lang)) {
      const { bundledLanguages } = await import('shiki/langs')
      const load = bundledLanguages[lang as keyof typeof bundledLanguages]
      if (load) await shiki.loadLanguage(load)
    }
    lines = shiki.getLoadedLanguages().includes(lang)
      ? shiki.codeToTokens(code, { lang, theme: THEME }).tokens
      : plainLines(code)
  }
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  cache.set(key, lines)
  for (const listener of listeners) listener()
  return lines
}

/** The CSS variables that color tokens with a palette. */
export function paletteVariables(palette: SyntaxPalette): CSSProperties {
  const fg = palette.foreground
  const vars: Record<string, string> = {
    foreground: fg,
    background: 'transparent',
    'token-constant': palette.constant ?? palette.number ?? fg,
    'token-string': palette.string ?? fg,
    'token-comment': palette.comment ?? fg,
    'token-keyword': palette.keyword ?? fg,
    'token-parameter': palette.parameter ?? fg,
    'token-function': palette.function ?? fg,
    'token-string-expression': palette.stringExpression ?? palette.string ?? fg,
    'token-punctuation': palette.punctuation ?? fg,
    'token-link': palette.link ?? palette.constant ?? fg,
    'token-inserted': '#3fb950',
    'token-deleted': '#f85149',
    'token-changed': palette.keyword ?? fg,
  }
  return Object.fromEntries(
    Object.entries(vars).map(([name, value]) => [`${PREFIX}${name}`, value])
  ) as CSSProperties
}
