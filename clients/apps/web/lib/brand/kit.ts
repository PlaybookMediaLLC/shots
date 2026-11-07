import { z } from 'zod'
import { fontFamilies } from '@/lib/constants/fonts'
import { brandFontId } from '@/lib/launch/brand'
import { brandKitDefinitionSchema } from '@/lib/tenant/schemas'
import { GOOGLE_FONT_PREFIX, googleFontId, isGoogleFontId } from '@/lib/typography/google-fonts'
import {
  type BrandFrame,
  type BrandKitEditor,
  brandKitEditorSchema,
  type BrandLogo,
  editorFontIdSchema,
} from './editor-definition'

export { type BrandFrame, type BrandLogo, type LogoTone } from './editor-definition'

/**
 * Brand kits as the editor uses them: colours, headline and body fonts,
 * logos, and the background and frame designs start from.
 *
 * A stored definition is the canonical schema-version-1 kit (RFC 019:
 * colours, catalog fonts, a primary logo), which every reader understands,
 * plus the editor's `editor` block for the rest. Kits saved before RFC 019
 * (colours.foreground and a free-text typeface) still read.
 */

const color = z
  .string()
  .trim()
  .regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i)
  .transform((value) => value.toLowerCase())

/** What the editor reads from a stored definition; unknown or invalid parts are left out. */
const storedDefinitionSchema = z.object({
  colors: z.object({
    accent: color.optional().catch(undefined),
    background: color,
    foreground: color.optional().catch(undefined),
    text: color.optional().catch(undefined),
  }),
  editor: brandKitEditorSchema.optional().catch(undefined),
  logo: z.object({ primaryAssetId: z.uuid() }).optional().catch(undefined),
  typography: z
    .object({
      bodyFamily: z.string().optional(),
      fontFamily: z.string().optional(),
      headingFamily: z.string().optional(),
    })
    .default({}),
})

/** A brand kit ready to apply: the latest version of one name. */
export type BrandKit = {
  accent: string
  background: BrandKitEditor['background']
  colors: { background: string; foreground: string; palette: string[]; secondary?: string }
  frame: BrandFrame | undefined
  id: string
  logos: BrandLogo[]
  name: string
  /** Font ids for headlines and for everything else. */
  primaryFont: string | null
  secondaryFont: string | null
  version: number
}

/** A stored brand kit, as listed by the workspace. */
export const storedBrandKitSchema = z.object({
  definition: z.record(z.string(), z.unknown()),
  id: z.string(),
  name: z.string(),
  status: z.string(),
  version: z.number().int(),
})
/** A stored brand kit. */
export type StoredBrandKit = z.infer<typeof storedBrandKitSchema>

/** The editor font for a typeface name: a catalog font, else the Google Fonts family. */
export function fontIdForName(name: string | undefined): string | null {
  const family = name
    ?.split(',')[0]
    ?.trim()
    .replace(/^["']|["']$/g, '')
  if (!family) return null
  if (fontFamilies.some((font) => font.id === family) || isGoogleFontId(family)) return family
  return brandFontId(family) ?? googleFontId(family)
}

/** The display name of an editor font id. */
export function fontName(id: string): string {
  if (id.startsWith(GOOGLE_FONT_PREFIX)) return id.slice(GOOGLE_FONT_PREFIX.length)
  return fontFamilies.find((font) => font.id === id)?.name ?? id
}

/** The catalog font a font id stands for in the canonical definition. */
export function catalogFont(id: string): string {
  if (fontFamilies.some((font) => font.id === id)) return id
  return brandFontId(fontName(id)) ?? 'inter'
}

/** Read one stored kit; null when its definition has no usable colours. */
export function readBrandKit(stored: StoredBrandKit): BrandKit | null {
  const parsed = storedDefinitionSchema.safeParse(stored.definition)
  if (!parsed.success) return null
  const { colors, editor, logo, typography } = parsed.data
  const foreground = colors.text ?? colors.foreground
  if (!foreground) return null
  const primaryFont =
    editor?.fonts.heading ?? fontIdForName(typography.headingFamily ?? typography.fontFamily)
  const logos =
    editor?.logos.length || !logo
      ? (editor?.logos ?? [])
      : [{ id: 'primary', name: 'Logo', src: `asset:${logo.primaryAssetId}`, tone: 'any' as const }]
  return {
    accent: colors.accent ?? colors.background,
    background: editor?.background,
    colors: {
      background: colors.background,
      foreground,
      palette: editor?.palette ?? [],
      secondary: editor?.secondary,
    },
    frame: editor?.frame,
    id: stored.id,
    logos,
    name: stored.name,
    primaryFont,
    secondaryFont: editor?.fonts.body ?? fontIdForName(typography.bodyFamily) ?? primaryFont,
    version: stored.version,
  }
}

/**
 * One stored kit by id, whichever version it is. A design records the id of
 * the exact version it applied, so reading it back must not go through the
 * library, which keeps only the latest version of each name.
 */
export function brandKitById(stored: readonly StoredBrandKit[], id: string): BrandKit | null {
  const found = stored.find((kit) => kit.id === id)
  return found ? readBrandKit(found) : null
}

/** The library: the latest active version of each kit, by name. */
export function brandKitLibrary(stored: readonly StoredBrandKit[]): BrandKit[] {
  const latest = new Map<string, StoredBrandKit>()
  for (const kit of stored) {
    const current = latest.get(kit.name)
    if (!current || kit.version > current.version) latest.set(kit.name, kit)
  }
  return [...latest.values()]
    .filter((kit) => kit.status !== 'ARCHIVED')
    .map(readBrandKit)
    .filter((kit): kit is BrandKit => kit !== null)
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** A kit as edited in the editor. */
export const brandKitDraftSchema = z.object({
  background: brandKitEditorSchema.shape.background,
  colors: z.object({
    accent: z.string(),
    background: z.string(),
    foreground: z.string(),
    palette: z.array(z.string()).default([]),
    secondary: z.string().optional(),
  }),
  fonts: z.object({ primary: editorFontIdSchema, secondary: editorFontIdSchema.optional() }),
  frame: brandKitEditorSchema.shape.frame,
  logos: brandKitEditorSchema.shape.logos,
})
/** A kit as edited in the editor. */
export type BrandKitDraft = z.input<typeof brandKitDraftSchema>

/**
 * A colour as full #rrggbb, as the canonical definition takes it: shorthand
 * hex is expanded, and the alpha of #rrggbbaa or rgba() a picker produced is
 * dropped (brand colours are opaque).
 */
export function fullHex(value: string): string {
  const color = value.trim().toLowerCase()
  if (/^#[0-9a-f]{3}$/.test(color))
    return `#${[...color.slice(1)].map((char) => char + char).join('')}`
  if (/^#[0-9a-f]{8}$/.test(color)) return color.slice(0, 7)
  const rgb = color.match(/^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/)
  if (rgb) {
    return `#${rgb
      .slice(1, 4)
      .map((channel) => Math.min(255, Number(channel)).toString(16).padStart(2, '0'))
      .join('')}`
  }
  return color
}

/**
 * The definition to store for a kit edited in the editor: the canonical
 * colours, catalog fonts (the nearest catalog font for a Google font), and
 * primary logo, plus the editor block with everything else.
 */
export function brandKitDefinition(
  draft: BrandKitDraft
): z.output<typeof brandKitDefinitionSchema> {
  const kit = brandKitDraftSchema.parse(draft)
  const primaryLogo = kit.logos.find((logo) => logo.tone === 'any') ?? kit.logos[0]
  const editor = brandKitEditorSchema.parse({
    background: kit.background,
    fonts: { body: kit.fonts.secondary, heading: kit.fonts.primary },
    frame: kit.frame,
    logos: kit.logos,
    palette: kit.colors.palette.map(fullHex),
    secondary: kit.colors.secondary ? fullHex(kit.colors.secondary) : undefined,
  })
  return brandKitDefinitionSchema.parse({
    colors: {
      accent: fullHex(kit.colors.accent),
      background: fullHex(kit.colors.background),
      text: fullHex(kit.colors.foreground),
    },
    editor,
    ...(primaryLogo ? { logo: { primaryAssetId: primaryLogo.src.slice('asset:'.length) } } : {}),
    schemaVersion: 1,
    typography: {
      headingFamily: catalogFont(kit.fonts.primary),
      ...(kit.fonts.secondary ? { bodyFamily: catalogFont(kit.fonts.secondary) } : {}),
    },
  })
}
