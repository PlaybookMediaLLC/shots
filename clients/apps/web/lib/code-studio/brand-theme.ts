import { CODE_THEMES, type CodeTheme } from '@/components/code-image/code-themes'
import type { BrandKit } from '@/lib/brand/kit'
import { contrastRatio } from '@/lib/launch/brand'
import type { BrandCodeTheme, CodeStyle, SyntaxPalette } from './document'

/** The theme id a style uses for its brand snapshot. */
export const BRAND_THEME_ID = 'brand'

/** The default theme, Midnight, as the old /code editor opened with. */
const DEFAULT_THEME = CODE_THEMES.find((theme) => theme.id === 'midnight') ?? CODE_THEMES[0]!

/** Colors the code window sits on, by mode: near-black glass, or white. */
const WINDOW_SURFACE = { dark: '#111111', light: '#ffffff' } as const
/** WCAG's large-text contrast: the least a syntax color may have against the window. */
const MIN_CONTRAST = 3

const hex = (value: string | undefined) =>
  value && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : undefined

/** Brand colors, each once, in the order they should color code. */
function brandColors(kit: BrandKit): string[] {
  const colors = [kit.accent, kit.colors.secondary, ...kit.colors.palette, kit.colors.foreground]
  return [...new Set(colors.map(hex).filter((color): color is string => !!color))]
}

/** A base palette with keywords, functions and strings in brand colors that stay readable. */
function brandPalette(base: SyntaxPalette, colors: string[], surface: string): SyntaxPalette {
  const readable = colors.filter((color) => contrastRatio(color, surface) >= MIN_CONTRAST)
  const [keyword, fn, string] = readable
  return {
    ...base,
    keyword: keyword ?? base.keyword,
    function: fn ?? keyword ?? base.function,
    parameter: fn ?? keyword ?? base.parameter,
    punctuation: keyword ?? base.punctuation,
    string: string ?? base.string,
  }
}

/**
 * A brand kit as a code theme: the kit's background and accent make the
 * gradient, and its colors take over keywords, functions and strings wherever
 * they keep a 3:1 contrast on the window. The result is a frozen copy.
 */
export function brandCodeTheme(kit: BrandKit, base: CodeTheme = DEFAULT_THEME): BrandCodeTheme {
  const colors = brandColors(kit)
  const from = hex(kit.colors.background) ?? base.from.toLowerCase()
  const accent = hex(kit.accent) ?? colors[0] ?? base.to.toLowerCase()
  const to =
    accent === from ? (colors.find((color) => color !== from) ?? base.to.toLowerCase()) : accent
  return {
    kitId: kit.id,
    name: kit.name,
    from,
    to,
    accent,
    dark: brandPalette(base.dark, colors, WINDOW_SURFACE.dark),
    light: brandPalette(base.light, colors, WINDOW_SURFACE.light),
  }
}

/** The theme a style renders with: its brand snapshot, a built-in theme, or Midnight. */
export function resolveCodeTheme(style: Pick<CodeStyle, 'theme' | 'brandTheme'>): CodeTheme {
  const brand = style.brandTheme
  if (style.theme === BRAND_THEME_ID && brand)
    return {
      id: BRAND_THEME_ID,
      label: brand.name,
      swatch: brand.accent,
      from: brand.from,
      to: brand.to,
      light: brand.light,
      dark: brand.dark,
    }
  return CODE_THEMES.find((theme) => theme.id === style.theme) ?? DEFAULT_THEME
}
