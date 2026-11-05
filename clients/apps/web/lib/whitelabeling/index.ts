import { z } from 'zod'

const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a #rrggbb color.')
const imageUrlSchema = z.url({ protocol: /^https$/ }).max(2_000)
const blank = z.literal('')

/**
 * An organization's app branding. An empty field keeps the Shots default. The
 * backend applies the same rules (server/internal/whitelabel), since colors and
 * URLs reach the page's CSS and markup.
 */
export const whitelabelSettingsSchema = z.object({
  accentColor: colorSchema.or(blank).optional(),
  brandName: z.string().trim().max(64).optional(),
  faviconUrl: imageUrlSchema.or(blank).optional(),
  logoUrl: imageUrlSchema.or(blank).optional(),
  primaryColor: colorSchema.or(blank).optional(),
})
export type WhitelabelSettings = z.infer<typeof whitelabelSettingsSchema>

/** The name and logo the app chrome shows. Without a logo it keeps the Shots mark. */
export function brandIdentity(settings?: WhitelabelSettings | null): {
  logoUrl?: string
  name: string
} {
  return { logoUrl: settings?.logoUrl || undefined, name: settings?.brandName || 'Shots' }
}

/** Black or white, whichever reads on `color` (WCAG relative luminance). */
function readableForeground(color: string): string {
  const [red, green, blue] = [1, 3, 5].map((start) => {
    const channel = parseInt(color.slice(start, start + 2), 16) / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
  return luminance > 0.179 ? '#000000' : '#ffffff'
}

/**
 * The CSS that recolors the signed-in app, or null when nothing changes.
 * Anything but a #rrggbb color is left out, so stored values cannot add CSS.
 */
export function brandThemeCss(settings?: WhitelabelSettings | null): string | null {
  const declarations: string[] = []
  let primaryButton = ''
  const primary = colorSchema.safeParse(settings?.primaryColor)
  if (primary.success) {
    const foreground = readableForeground(primary.data)
    declarations.push(
      `--primary:${primary.data}`,
      `--primary-foreground:${foreground}`,
      `--ring:${primary.data}`
    )
    // The shell fills primary buttons with --foreground (platform-shell.css).
    primaryButton = `:is([data-platform-shell],.platform-overlay) [data-slot='button'][data-variant='default']{background:${primary.data};color:${foreground}}`
  }
  const accent = colorSchema.safeParse(settings?.accentColor)
  if (accent.success) {
    declarations.push(
      `--accent:${accent.data}`,
      `--accent-foreground:${readableForeground(accent.data)}`
    )
  }
  return declarations.length ? `:root,.dark{${declarations.join(';')}}${primaryButton}` : null
}
