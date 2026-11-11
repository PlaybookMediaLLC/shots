import { z } from 'zod'
import type { DesignDocument } from '@/lib/design/document'
import { contrastRatio } from '@/lib/launch/brand'
import type { BrandBinding } from './binding'
import type { BrandKit, BrandLogo } from './kit'

/**
 * Putting a design on brand. Each brand property is applied by path
 * (`background`, `texts.<id>.color`, …) and the value the kit set is
 * remembered in the document. Applying a kit again (a new version, another
 * kit) leaves any property the user changed since alone: their override
 * wins unless they ask to reset overrides.
 */

/** The parts of a design a brand kit can set. */
export const brandCategorySchema = z.enum(['colors', 'typography', 'background', 'frame', 'logo'])
/** A brand category. */
export type BrandCategory = z.infer<typeof brandCategorySchema>

/** Every brand category, in the order the editor lists them. */
export const BRAND_CATEGORIES = brandCategorySchema.options

/** The categories a kit has values for: a frame, logos and fonts are optional. */
export function availableBrandCategories(kit: BrandKit): BrandCategory[] {
  return BRAND_CATEGORIES.filter((category) => {
    if (category === 'frame') return Boolean(kit.frame)
    if (category === 'logo') return kit.logos.length > 0
    if (category === 'typography') return Boolean(kit.primaryFont)
    return true
  })
}

/** The layer id of the logo a brand kit places. */
export const BRAND_LOGO_ID = 'brand-logo'

type Assignment = {
  get: (document: DesignDocument) => unknown
  path: string
  set: (document: DesignDocument, value: unknown) => void
  value: unknown
}

/** The result of applying a kit. */
export type BrandResult = {
  binding: BrandBinding
  document: DesignDocument
  /** Paths kept because the user changed them after the kit set them. */
  keptOverrides: string[]
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** White or near-black, whichever reads better on `background`. */
export function readableOn(background: string): string {
  return contrastRatio(background, '#ffffff') >= 3 ? '#ffffff' : '#111111'
}

/** True when white text reads better than dark text on the colour. */
function isDark(color: string): boolean {
  return contrastRatio(color, '#ffffff') > contrastRatio(color, '#111111')
}

/** The logo for a background: a light logo on dark, a dark logo on light, else any. */
export function pickLogo(
  logos: readonly BrandLogo[],
  darkBackground: boolean
): BrandLogo | undefined {
  const wanted = darkBackground ? 'light' : 'dark'
  return (
    logos.find((logo) => logo.tone === wanted) ??
    logos.find((logo) => logo.tone === 'any') ??
    logos[0]
  )
}

function headlineIndex(texts: DesignDocument['texts']): number {
  const byRole = texts.findIndex((text) => text.role === 'headline')
  if (byRole >= 0 || texts.some((text) => text.role)) return byRole
  let largest = -1
  texts.forEach((text, index) => {
    if (largest < 0 || text.fontSize > texts[largest]!.fontSize) largest = index
  })
  return largest
}

function assignments(
  document: DesignDocument,
  kit: BrandKit,
  categories: ReadonlySet<BrandCategory>
): Assignment[] {
  const list: Assignment[] = []
  const field = <T extends { id?: string }>(
    section: 'texts' | 'annotations',
    items: readonly T[],
    key: string,
    value: (item: T) => unknown
  ) =>
    items.forEach((item, index) => {
      const id = item.id ?? `#${index}`
      list.push({
        get: (doc) => (doc[section][index] as Record<string, unknown> | undefined)?.[key],
        path: `${section}.${id}.${key}`,
        set: (doc, next) => {
          const target = doc[section][index] as Record<string, unknown> | undefined
          if (target) target[key] = next
        },
        value: value(item),
      })
    })

  if (categories.has('colors')) {
    const { foreground, secondary } = kit.colors
    field('texts', document.texts, 'color', () => foreground)
    document.texts.forEach((text, index) => {
      if (text.fill?.kind !== 'gradient') return
      list.push({
        get: (doc) => doc.texts[index]?.fill,
        path: `texts.${text.id ?? `#${index}`}.fill`,
        set: (doc, next) => {
          if (doc.texts[index]) doc.texts[index].fill = next as typeof text.fill
        },
        value: {
          angle: text.fill.angle,
          from: kit.accent,
          kind: 'gradient',
          to: secondary ?? foreground,
        },
      })
    })
    field('annotations', document.annotations, 'strokeColor', () => kit.accent)
    document.elements.forEach((element, index) => {
      const props: Record<string, unknown> =
        element.type === 'badge'
          ? { background: kit.accent, color: readableOn(kit.accent) }
          : element.type === 'cursor'
            ? { click: { ...element.props.click, color: kit.accent } }
            : element.type === 'callout'
              ? { borderColor: kit.accent }
              : {}
      for (const [key, value] of Object.entries(props)) {
        list.push({
          get: (doc) => (doc.elements[index]?.props as Record<string, unknown> | undefined)?.[key],
          path: `elements.${element.id}.${key}`,
          set: (doc, next) => {
            const target = doc.elements[index]?.props as Record<string, unknown> | undefined
            if (target) target[key] = next
          },
          value,
        })
      }
    })
  }

  if (categories.has('typography') && kit.primaryFont) {
    const headline = headlineIndex(document.texts)
    document.texts.forEach((text, index) => {
      const font = index === headline ? kit.primaryFont : (kit.secondaryFont ?? kit.primaryFont)
      list.push({
        get: (doc) => doc.texts[index]?.fontFamily,
        path: `texts.${text.id ?? `#${index}`}.fontFamily`,
        set: (doc, next) => {
          if (doc.texts[index]) doc.texts[index].fontFamily = next as string
        },
        value: font,
      })
    })
  }

  if (categories.has('background')) {
    // The canvas corner radius is not the kit's: it is neither set nor compared.
    const withoutRadius = (background: DesignDocument['background']) => {
      if (!background) return background
      const { radius: _radius, ...rest } = background
      return rest
    }
    list.push({
      get: (doc) => withoutRadius(doc.background),
      path: 'background',
      set: (doc, next) => {
        const radius = doc.background?.radius
        doc.background = {
          ...(next as NonNullable<DesignDocument['background']>),
          ...(radius !== undefined ? { radius } : {}),
        }
      },
      value: withoutRadius(kit.background) ?? {
        blur: 0,
        noise: 0,
        opacity: 1,
        type: 'gradient',
        value: `linear-gradient(135deg, ${kit.colors.background} 0%, ${kit.accent} 100%)`,
      },
    })
  }

  if (categories.has('frame') && kit.frame) {
    const frame = kit.frame
    list.push({
      get: (doc) => ({
        browserHeaderSize: doc.image.browserHeaderSize,
        chrome: doc.image.chrome,
        frame: doc.image.frame,
        mode: doc.mode,
        radius: doc.image.radius,
        shadow: doc.image.shadow,
      }),
      path: 'frame',
      set: (doc, next) => {
        const value = next as typeof frame
        doc.mode = value.mode
        doc.image = {
          ...doc.image,
          browserHeaderSize: value.browserHeaderSize,
          chrome: value.chrome,
          frame: value.frame,
          radius: value.radius,
          shadow: value.shadow,
        }
      },
      value: frame,
    })
  }

  return list
}

/**
 * The design with a brand kit applied to the chosen categories. `binding` is
 * the design's current binding: properties it set that the user has since
 * changed are kept unless `resetOverrides`.
 */
export function applyBrandKit(
  document: DesignDocument,
  kit: BrandKit,
  categories: readonly BrandCategory[],
  {
    binding,
    resetOverrides = false,
  }: { binding?: BrandBinding | null; resetOverrides?: boolean } = {}
): BrandResult {
  const chosen = new Set(categories)
  const draft = structuredClone(document)
  const previous = binding?.applied ?? {}
  const applied: BrandBinding['applied'] = { ...previous }
  const keptOverrides: string[] = []

  for (const assignment of assignments(document, kit, chosen)) {
    const before = previous[assignment.path]
    if (!resetOverrides && before !== undefined && !same(assignment.get(draft), before)) {
      keptOverrides.push(assignment.path)
      continue
    }
    assignment.set(draft, structuredClone(assignment.value))
    applied[assignment.path] = JSON.parse(JSON.stringify(assignment.value ?? null))
  }

  if (chosen.has('logo') && kit.logos.length > 0) {
    const background = draft.background
    const dark =
      background?.type === 'solid'
        ? isDark(background.value)
        : background?.type === 'gradient'
          ? isDark(kit.colors.background)
          : true
    const logo = pickLogo(kit.logos, dark)!
    const existing = draft.overlays.findIndex((overlay) => overlay.id === BRAND_LOGO_ID)
    const before = previous.logo
    if (
      existing >= 0 &&
      !resetOverrides &&
      before !== undefined &&
      !same(draft.overlays[existing]!.src, before)
    ) {
      keptOverrides.push('logo')
    } else if (existing >= 0) {
      draft.overlays[existing] = { ...draft.overlays[existing]!, src: logo.src }
      applied.logo = logo.src
    } else {
      draft.overlays.push({
        flipX: false,
        flipY: false,
        id: BRAND_LOGO_ID,
        layer: 'front',
        opacity: 1,
        position: { x: 0.9, y: 0.9 },
        role: 'user',
        rotation: 0,
        size: 0.12,
        src: logo.src,
      })
      applied.logo = logo.src
    }
  }

  return {
    binding: { applied, kitId: kit.id, name: kit.name, version: kit.version },
    document: draft,
    keptOverrides,
  }
}
