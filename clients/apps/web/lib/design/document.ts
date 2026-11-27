import { z } from 'zod'
import { brandBindingSchema } from '@/lib/brand/binding'
import { designCopySchema } from '@/lib/captions/channels'
import { easingSchema, isAudioSource, LOCAL_AUDIO_DATA_REF, timelineMotionShape } from '@/lib/animation/motion-schema'
import { canvasElementSchema } from '@/lib/editor/elements/schema'
import { isGoogleFontId } from '@/lib/typography/google-fonts'
import { textAlignSchema, textFillSchema, textFitSchema, textRoleSchema } from '@/lib/typography/text-style'
import {
  codeContentSchema,
  deviceOrientationSchema,
  frameChromeSchema,
  screenFrameSchema,
} from '@/lib/frames/schema'
import { designCatalog, frameTypes, isKnownBackground } from './catalog'

/**
 * DesignDocument: one editor composition as portable JSON. It is the one
 * document model every consumer shares: projects and their versions, presets,
 * batch and multi-size export, previews, the headless renderer, and AI.
 *
 * A document is a template plus overrides. `template` names one of the
 * editor's own presets or image templates and is applied through the store's
 * `applyVisualPreset`, exactly as clicking it in the editor would; every other
 * section overrides that starting point. Sections left out keep the
 * template's (or the editor's default) value.
 *
 * It covers every capability the editor renders (canvas, background, pattern,
 * grain, main image styling, frames, shadows, 3D, filters, device mockups,
 * text, overlays, annotations, redaction, animation) in units that do not
 * depend on the browser window:
 *
 * - positions and sizes are fractions of the canvas (0-1), except text
 *   positions, which are percentages like the editor's own text layer;
 * - font sizes are fractions of the canvas width.
 *
 * `applyDesignDocument` converts these to the editor's on-screen pixels when
 * a design is loaded, so the same document renders identically in the editor,
 * the headless renderer, and any viewport.
 *
 * Image sources are references (see {@link isDesignSource}): `asset:<uuid>`
 * for a workspace asset, a path for built-in media, or, only while a document
 * lives in this browser, a `blob:` or small `data:` URL. A stored document
 * holds no local references ({@link getLocalDesignSources}).
 *
 * Version 2 keeps every v1 field and adds what made v1 lossy: layer ids and
 * visibility, custom image overlays and their styling, device screen crops,
 * curved-arrow control points, custom canvas sizes, slides, and the full
 * timeline. {@link parseDesignDocument} upgrades a v1 document.
 */

export const DESIGN_DOCUMENT_VERSION = 2

/** The versions {@link parseDesignDocument} reads. */
export const READABLE_DESIGN_DOCUMENT_VERSIONS = [1, 2] as const

const ASSET_REF = /^asset:[0-9a-f-]{36}$/i
const BUILTIN_PATH = /^\/?[\w-]+(?:\/[\w.-]+)+$|^\/[\w.-]+$/
const LOCAL_REF = /^(blob:|data:image\/(?:png|jpeg|webp|gif);base64,)/
/** Public hosts of the editor's own media library (backgrounds, overlays). */
const MEDIA_HOSTS = new Set(['assets.screenshot-studio.com', 'shots-assets.oppulence.io'])

function configuredMediaHost(): string | null {
  const configured = process.env.NEXT_PUBLIC_R2_PUBLIC_URL?.trim()
  if (!configured) return null
  try {
    return configured.includes('://')
      ? new URL(configured).host.toLowerCase()
      : configured.replace(/\/+$/, '').toLowerCase()
  } catch {
    return null
  }
}

/**
 * True for a reference an image field may hold: a workspace asset, built-in
 * media (a path, or the media library host), or a local browser URL.
 */
export function isDesignSource(ref: string): boolean {
  if (ref.includes('..')) return false
  if (ASSET_REF.test(ref) || BUILTIN_PATH.test(ref) || LOCAL_REF.test(ref)) return true
  if (!ref.startsWith('https://')) return false
  try {
    const parsed = new URL(ref)
    if (parsed.username || parsed.password || !parsed.pathname || parsed.pathname === '/') {
      return false
    }
    const host = parsed.host.toLowerCase()
    if (MEDIA_HOSTS.has(host)) return true
    const configuredHost = configuredMediaHost()
    return Boolean(configuredHost && host === configuredHost)
  } catch {
    return false
  }
}

const sourceRef = z
  .string()
  .max(4_000_000)
  .refine(isDesignSource, 'Use asset:<id> for workspace images or a path for built-in media.')

/** Optional on every layer: a stable id, and whether it is drawn. */
const layerIdentity = {
  /** Stable layer id; documents from v1 or the AI may omit it. */
  id: z.string().max(80).optional(),
  /** Hidden layers stay in the document; omitted means visible. */
  visible: z.boolean().optional(),
}

const unit = z.number().min(0).max(1)
const percent = z.number().min(0).max(100)
const color = z
  .string()
  .regex(/^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i, 'Use a #hex or rgb() color.')
const enumOf = <T extends string>(values: readonly T[]) => z.enum(values as [T, ...T[]])

const fontIds = designCatalog.fonts.map((font) => font.id)
const overlayPaths: ReadonlySet<string> = new Set([
  ...designCatalog.arrowOverlays,
  ...designCatalog.shadowOverlays,
])
const mockupIds = designCatalog.mockups.map((mockup) => mockup.id)

const shadowSchema = z.object({
  blur: z.number().min(0).max(200).default(24),
  color: color.default('#000000'),
  enabled: z.boolean().default(true),
  offsetX: z.number().min(-200).max(200).default(0),
  offsetY: z.number().min(-200).max(200).default(12),
  opacity: z.number().min(0).max(1).default(0.35),
  spread: z.number().min(-100).max(100).default(0),
})

const keyframeSchema = z.object({
  easing: easingSchema,
  id: z.string().max(80),
  properties: z.record(z.string().max(40), z.number()),
  /** Milliseconds from the start of the timeline. */
  time: z.number().min(0).max(600_000),
})

const timelineSchema = z.object({
  clips: z
    .array(
      z.object({
        color: z.string().max(40),
        duration: z.number().min(50).max(600_000),
        id: z.string().max(80),
        name: z.string().max(100),
        presetId: z.string().max(80),
        startTime: z.number().min(0).max(600_000),
      })
    )
    .max(100)
    .default([]),
  /** Milliseconds. */
  duration: z.number().min(500).max(600_000),
  isLooping: z.boolean().default(true),
  tracks: z
    .array(
      z.object({
        clipId: z.string().max(80).optional(),
        id: z.string().max(80),
        isLocked: z.boolean().default(false),
        isVisible: z.boolean().default(true),
        keyframes: z.array(keyframeSchema).max(500),
        name: z.string().max(100),
        originalDuration: z.number().min(0).max(600_000).optional(),
        type: z.enum(['transform', 'opacity']),
      })
    )
    .max(200)
    .default([]),
  /** Keyframed layer properties, text reveals, scroll-throughs, audio, and captions. */
  ...timelineMotionShape,
})

export const designDocumentSchema = z.object({
  version: z.literal(DESIGN_DOCUMENT_VERSION),
  /** An editor template or preset id from the catalog's templates section. */
  template: z.string().max(80).optional(),
  canvas: z
    .object({
      aspectRatio: enumOf([...designCatalog.aspectRatios, 'custom']),
      /** Breathing room around the main image, in editor px (capped at 8% of the canvas). */
      padding: z.number().min(0).max(200),
      /** Output size in px when `aspectRatio` is `custom`. */
      size: z
        .object({ height: z.number().int().min(16).max(8192), width: z.number().int().min(16).max(8192) })
        .optional(),
    })
    .partial()
    .optional(),
  background: z
    .object({
      blur: z.number().min(0).max(50).default(0),
      noise: z.number().min(0).max(100).default(0),
      opacity: z.number().min(0).max(1).default(1),
      radius: z.number().min(0).max(100).optional(),
      type: z.enum(['gradient', 'solid', 'image']),
      value: z.string().min(1).max(500),
    })
    .refine(
      (background) =>
        isKnownBackground(background.type, background.value) ||
        (background.type === 'image' && isDesignSource(background.value)),
      {
        message: 'Unknown background. Pick a value from the design catalog.',
        path: ['value'],
      }
    )
    .optional(),
  pattern: z
    .object({
      blur: z.number().min(0).max(20).default(0),
      color: color.default('#ffffff'),
      enabled: z.boolean().default(true),
      opacity: z.number().min(0).max(1).default(0.15),
      rotation: z.number().min(-180).max(180).default(0),
      scale: z.number().min(0.1).max(5).default(1),
      spacing: z.number().min(4).max(200).default(24),
      type: enumOf(designCatalog.patterns).default('grid'),
    })
    .optional(),
  mode: z.enum(['screenshot', 'browser', 'device']).optional(),
  image: z.object({
    src: sourceRef.nullable().default(null),
    /** File name of the main image, for exports and the layer list. */
    name: z.string().max(200).optional(),
    scale: z.number().min(10).max(200).optional(),
    opacity: z.number().min(0).max(1).optional(),
    radius: z.number().min(0).max(100).optional(),
    positionAnchor: z.enum(['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br']).optional(),
    offset: z
      .object({ x: z.number().min(-0.5).max(0.5), y: z.number().min(-0.5).max(0.5) })
      .optional(),
    rotation: z.number().min(-180).max(180).optional(),
    shadow: z
      .object({
        custom: shadowSchema.optional(),
        preset: enumOf(designCatalog.shadowPresets).optional(),
      })
      .optional(),
    frame: z
      .object({
        color: color.default('#ffffff'),
        opacity: z.number().min(0).max(1).default(1),
        padding: z.number().min(0).max(100).default(0),
        title: z.string().max(200).optional(),
        type: enumOf(frameTypes),
        width: z.number().min(0).max(40).default(0),
      })
      .optional(),
    browserHeaderSize: z.number().min(50).max(200).optional(),
    /** Browser and window options when `frame.type` is a browser or window. */
    chrome: frameChromeSchema.optional(),
    perspective: z
      .object({
        perspective: z.number().min(200).max(5000).default(2400),
        rotateX: z.number().min(-60).max(60).default(0),
        rotateY: z.number().min(-60).max(60).default(0),
        rotateZ: z.number().min(-180).max(180).default(0),
        scale: z.number().min(0.3).max(2).default(1),
        translateX: z.number().min(-30).max(30).default(0),
        translateY: z.number().min(-30).max(30).default(0),
      })
      .optional(),
    filters: z
      .object({
        blur: z.number().min(0).max(20),
        brightness: z.number().min(0).max(200),
        contrast: z.number().min(0).max(200),
        grayscale: z.number().min(0).max(100),
        hueRotate: z.number().min(0).max(360),
        invert: z.number().min(0).max(100),
        saturate: z.number().min(0).max(200),
        sepia: z.number().min(0).max(100),
      })
      .partial()
      .optional(),
  }),
  devices: z
    .object({
      layoutId: enumOf(designCatalog.deviceLayouts).optional(),
      mockups: z
        .array(
          z.object({
            ...layerIdentity,
            /** A drawn device's color id. */
            color: z.string().max(40).optional(),
            definitionId: enumOf(mockupIds),
            /** What holds the screen; omitted means the device in `definitionId`. */
            frame: screenFrameSchema.optional(),
            opacity: z.number().min(0).max(1).default(1),
            orientation: deviceOrientationSchema.optional(),
            position: z.object({ x: unit, y: unit }),
            rotation: z.number().min(-180).max(180).default(0),
            screen: z
              .object({
                /** The content's width / height, so a browser, window, or bare frame fits it. */
                aspect: z.number().min(0.05).max(20).optional(),
                /** Code drawn as the screen instead of an image. */
                code: codeContentSchema.optional(),
                fit: z.enum(['cover', 'contain']).default('cover'),
                name: z.string().max(200).optional(),
                /** Pan inside the screen, as a fraction of the screen. */
                offset: z.object({ x: z.number().min(-1).max(1), y: z.number().min(-1).max(1) }).optional(),
                /** Zoom inside the screen; 1 fills it. */
                scale: z.number().min(0.2).max(5).optional(),
                /** null reuses the main image. */
                src: sourceRef.nullable().default(null),
              })
              .default({ fit: 'cover', src: null }),
            size: z.number().min(0.05).max(1),
          })
        )
        .max(6)
        .default([]),
    })
    .optional(),
  texts: z
    .array(
      z.object({
        ...layerIdentity,
        color: color.default('#ffffff'),
        zIndex: z.number().int().min(1).max(999).optional(),
        /** A catalog font id, or `google:<Family>` for a Google Fonts family. */
        fontFamily: z
          .string()
          .max(80)
          .refine((id) => fontIds.includes(id) || isGoogleFontId(id), 'Use a font id from the catalog or google:<Family>.')
          .default('inter'),
        align: textAlignSchema.optional(),
        fill: textFillSchema.optional(),
        fit: textFitSchema.optional(),
        letterSpacing: z.number().min(-0.2).max(1).optional(),
        lineHeight: z.number().min(0.6).max(3).optional(),
        /** Text box width as a fraction of the canvas width. */
        maxWidth: z.number().min(0.05).max(1.5).optional(),
        role: textRoleSchema.optional(),
        /** Fraction of the canvas width; 0.05 is a large headline. */
        fontSize: z.number().min(0.005).max(0.3),
        fontWeight: z.string().max(10).default('bold'),
        opacity: z.number().min(0).max(1).default(1),
        orientation: z.enum(['horizontal', 'vertical']).default('horizontal'),
        position: z.object({ x: percent, y: percent }),
        shadow: shadowSchema
          .pick({ blur: true, color: true, enabled: true, offsetX: true, offsetY: true })
          .optional(),
        text: z.string().min(1).max(300),
      })
    )
    .max(20)
    .default([]),
  overlays: z
    .array(
      z.object({
        ...layerIdentity,
        /** Blur in px. */
        blur: z.number().min(0).max(50).optional(),
        flipX: z.boolean().default(false),
        flipY: z.boolean().default(false),
        layer: z.enum(['front', 'back']).default('front'),
        opacity: z.number().min(0).max(1).default(1),
        /** Centre of the overlay. */
        position: z.object({ x: unit, y: unit }),
        /** Corner radius in px at the overlay's own size. */
        radius: z.number().min(0).max(500).optional(),
        /** `template-light` overlays come with a template's look rather than the user. */
        role: z.enum(['user', 'template-light']).optional(),
        rotation: z.number().min(-180).max(180).default(0),
        shadow: shadowSchema.optional(),
        /** Fraction of the canvas width. */
        size: z.number().min(0.01).max(2),
        src: z
          .string()
          .max(4_000_000)
          .refine(
            (src) => overlayPaths.has(src) || isDesignSource(src),
            'Use an overlay path from the design catalog or asset:<id>.'
          ),
        tilt: z
          .object({
            perspective: z.number().min(100).max(5000),
            rotateX: z.number().min(-90).max(90),
            rotateY: z.number().min(-90).max(90),
          })
          .optional(),
      })
    )
    .max(40)
    .default([]),
  annotations: z
    .array(
      z.object({
        ...layerIdentity,
        /** Bend point of a curved arrow. */
        control: z.object({ x: unit, y: unit }).optional(),
        end: z.object({ x: unit, y: unit }),
        fillColor: z.string().max(40).default('transparent'),
        opacity: z.number().min(0).max(1).default(1),
        /** Rounded corners of a rectangle, as a fraction of its shorter side. */
        radius: z.number().min(0).max(0.5).optional(),
        start: z.object({ x: unit, y: unit }),
        strokeColor: color.default('#ef4444'),
        strokeWidth: z.number().min(1).max(40).default(4),
        type: z.enum(['arrow', 'curved-arrow', 'rectangle', 'circle', 'line']),
      })
    )
    .max(30)
    .default([]),
  redactions: z
    .array(
      z.object({
        ...layerIdentity,
        amount: z.number().min(1).max(60).default(16),
        position: z.object({ x: unit, y: unit }),
        size: z.object({ height: unit, width: unit }),
        style: z.enum(['blur', 'mosaic']).default('blur'),
      })
    )
    .max(20)
    .default([]),
  animation: z.object({ presetId: enumOf(designCatalog.animationPresets) }).optional(),
  /** Shared bottom-to-top order for all editable layers. */
  layerOrder: z.array(z.string().max(160)).max(250).optional(),
  /** Step badges, cursors, spotlights, and zoom callouts. */
  elements: z.array(canvasElementSchema).max(60).default([]),
  /** The full timeline: clips from presets and keyframed tracks. Wins over `animation`. */
  timeline: timelineSchema.optional(),
  /** The brand kit the design follows, and what it set. */
  brand: brandBindingSchema.optional(),
  /** Alt text and social captions written for the design. */
  copy: designCopySchema.optional(),
  /** Several screenshots shown one after another. */
  slides: z
    .object({
      activeId: z.string().max(80).nullable().default(null),
      animation: z.enum(['none', 'fade', 'slide']).default('fade'),
      defaultDuration: z.number().min(0.5).max(60).default(2),
      enabled: z.boolean().default(true),
      items: z
        .array(
          z.object({
            duration: z.number().min(0.5).max(60),
            id: z.string().max(80),
            name: z.string().max(200).nullable().default(null),
            src: sourceRef,
          })
        )
        .max(60),
    })
    .optional(),
})

export type DesignDocument = z.output<typeof designDocumentSchema>

/**
 * Read a stored or received document of any readable version. Version 2 only
 * added fields, so a v1 document is valid once relabelled.
 */
export function parseDesignDocument(raw: unknown): DesignDocument {
  if (
    isPlainObject(raw) &&
    raw.version !== DESIGN_DOCUMENT_VERSION &&
    READABLE_DESIGN_DOCUMENT_VERSIONS.includes(raw.version as 1)
  ) {
    return designDocumentSchema.parse({ ...raw, version: DESIGN_DOCUMENT_VERSION })
  }
  return designDocumentSchema.parse(raw)
}

/** Every local (`blob:`/`data:`) reference: they must be uploaded before a document is stored. */
export function getLocalDesignSources(document: DesignDocument): string[] {
  const found = new Set<string>()
  const visit = (value: unknown) => {
    if (typeof value === 'string') {
      if (LOCAL_REF.test(value) || LOCAL_AUDIO_DATA_REF.test(value)) found.add(value)
    } else if (Array.isArray(value)) {
      value.forEach(visit)
    } else if (isPlainObject(value)) {
      Object.values(value).forEach(visit)
    }
  }
  visit(document)
  return [...found]
}

/** Replace source references throughout a document, for example local URLs by uploaded assets. */
export function mapDesignSources(
  document: DesignDocument,
  map: (ref: string) => string
): DesignDocument {
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') return isDesignSource(value) || isAudioSource(value) ? map(value) : value
    if (Array.isArray(value)) return value.map(visit)
    if (isPlainObject(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]))
    }
    return value
  }
  return designDocumentSchema.parse(visit(document))
}
export type DesignDocumentInput = z.input<typeof designDocumentSchema>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Deep-merge a patch into a document. Objects merge key by key; arrays and
 * scalars replace. `null` clears an optional section. The result is
 * re-validated, so a patch can never produce a document the editor can't load.
 */
export function patchDesignDocument(document: DesignDocument, patch: unknown): DesignDocument {
  const merge = (base: unknown, change: unknown): unknown => {
    if (change === undefined) return base
    if (isPlainObject(base) && isPlainObject(change)) {
      const result: Record<string, unknown> = { ...base }
      for (const [key, value] of Object.entries(change)) {
        result[key] = value === null && !(key === 'src') ? undefined : merge(base[key], value)
      }
      return result
    }
    return change
  }
  return designDocumentSchema.parse(merge(document, patch))
}

/** Every `asset:<id>` the document references, anywhere, for ownership checks and resolution. */
export function getDesignAssetIds(document: DesignDocument): string[] {
  const ids = new Set<string>()
  const visit = (value: unknown) => {
    if (typeof value === 'string') {
      if (ASSET_REF.test(value)) ids.add(value.slice('asset:'.length))
    } else if (Array.isArray(value)) {
      value.forEach(visit)
    } else if (isPlainObject(value)) {
      Object.values(value).forEach(visit)
    }
  }
  visit(document)
  return [...ids]
}

/**
 * The same schema with every default removed, at every depth. Defaults belong
 * to new documents: in a change set an omitted field must stay omitted, or
 * `image.perspective: { rotateY: 12 }` would reset the other perspective
 * fields, and a background change would reset the headline. Objects become
 * partial; list items stay complete because a list replaces the whole list.
 */
function withoutDefaults(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodDefault) return withoutDefaults(schema.removeDefault() as z.ZodType)
  if (schema instanceof z.ZodOptional)
    return withoutDefaults(schema.unwrap() as z.ZodType).optional()
  if (schema instanceof z.ZodNullable)
    return withoutDefaults(schema.unwrap() as z.ZodType).nullable()
  if (schema instanceof z.ZodObject) {
    return z.object(
      Object.fromEntries(
        Object.entries(schema.shape as Record<string, z.ZodType>).map(([key, field]) => [
          key,
          withoutDefaults(field).optional(),
        ])
      )
    )
  }
  return schema
}

type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T

/** A change set as sent by a model or a user: any fields of any sections. */
export type DesignChanges = DeepPartial<Omit<DesignDocument, 'version'>>

/** Complete values for some sections, ready to write into the editor. */
export type DesignSections = Partial<Omit<DesignDocument, 'image' | 'version'>> & {
  image?: Partial<DesignDocument['image']>
}

const CHANGES_DESCRIPTION =
  'Sections to change. Objects merge field by field; arrays (texts, overlays, annotations, ' +
  'redactions, devices.mockups) replace the whole list, so resend items you want to keep.'

/** Any section of a DesignDocument; omitted sections and fields are left as they are. */
export const designChangesSchema = (
  withoutDefaults(designDocumentSchema.omit({ version: true })) as z.ZodType<DesignChanges>
).describe(CHANGES_DESCRIPTION)

/**
 * {@link designChangesSchema} without the sections that only move (animation,
 * timeline, slides), for agents that render stills. They are a third of the
 * schema, and a tool schema is re-sent on every agent step (docs/rfcs/035).
 */
export const stillDesignChangesSchema = (
  withoutDefaults(
    designDocumentSchema.omit({ animation: true, slides: true, timeline: true, version: true })
  ) as z.ZodType<DesignChanges>
).describe(CHANGES_DESCRIPTION)

/** Drop keys a validator filled with undefined so they cannot clear the base document. */
export function definedChanges(changes: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(changes)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [
        key,
        value && typeof value === 'object' && !Array.isArray(value)
          ? definedChanges(value as Record<string, unknown>)
          : value,
      ])
  )
}

/**
 * Narrow a full document to the sections (and image fields) a change named,
 * with complete, validated values taken from the merged document.
 */
export function pickChangedSections(
  merged: DesignDocument,
  changes: DesignChanges
): DesignSections {
  const picked: Record<string, unknown> = {}
  for (const key of Object.keys(changes) as Array<keyof DesignChanges>) {
    if (key === 'image') {
      picked.image = Object.fromEntries(
        Object.keys(changes.image ?? {}).map((field) => [
          field,
          merged.image[field as keyof DesignDocument['image']],
        ])
      )
    } else {
      picked[key] = merged[key as keyof DesignDocument]
    }
  }
  return picked as DesignSections
}

/** One copilot edit: a change set plus a summary for the user. */
export const designEditSchema = z.object({
  changes: designChangesSchema,
  summary: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('What this change does, for the undo history.'),
})
