import { z } from 'zod'

/**
 * The canonical store screenshot document, version 2.
 *
 * Every surface reads this one shape: the editor canvas, filmstrip, template
 * previews, store previews, image export, and animated frames. Version 1
 * documents (flat slides with fixed heading/subheading/device fields) are
 * converted by `migrate.ts`; nothing else reads version 1.
 *
 * Coordinates are resolution independent: horizontal values are percentages
 * of the slide width, vertical values percentages of the slide height, and
 * type sizes are pixels at the 1320 px reference width. A layout therefore
 * adapts to any export target without rewriting the document.
 */

/** The schema version written by this build. */
export const STORE_DOCUMENT_VERSION = 2

/** Slide width, in pixels, at which type sizes are authored. */
export const REFERENCE_SLIDE_WIDTH = 1320

/** A six-digit hex color such as `#1A2B3C`. */
export const hexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i, 'Use a six-digit hex color.')

/** Stable identifier for a slide, layer, asset, or project. Bundled asset ids embed their URL (`public:<src>`). */
export const idSchema = z.string().min(1).max(512)

/** Background fill kinds. */
export const backgroundKindSchema = z.enum(['solid', 'linear', 'image'])

/** How a background image covers the slide. */
export const backgroundFitSchema = z.enum(['cover', 'contain'])

/** A slide or panorama background. */
export const backgroundSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal(backgroundKindSchema.enum.solid), color: hexColorSchema }),
  z.object({
    kind: z.literal(backgroundKindSchema.enum.linear),
    from: hexColorSchema,
    to: hexColorSchema,
    angle: z.number().min(0).max(360),
  }),
  z.object({
    kind: z.literal(backgroundKindSchema.enum.image),
    assetId: idSchema,
    fit: backgroundFitSchema,
    /** Focal point, 0-100 on each axis. */
    focusX: z.number().min(0).max(100),
    focusY: z.number().min(0).max(100),
    /** Fallback color shown while the image loads and used for contrast when no luminance map exists. */
    color: hexColorSchema,
  }),
])

/** Horizontal text alignment. */
export const textAlignSchema = z.enum(['left', 'center', 'right'])

/** Vertical alignment of text inside a fixed-height box. */
export const verticalAlignSchema = z.enum(['top', 'middle', 'bottom'])

/** The typography role a text layer inherits from the theme. */
export const textRoleSchema = z.enum(['heading', 'subheading', 'body'])

/**
 * Complete typography for one text role.
 *
 * `fontSize` is pixels at the reference width, `lineHeight` a unitless
 * multiplier, and `letterSpacing` a fraction of the font size (-0.02 = -2%).
 * A null `color` means automatic: the renderer picks a readable color for the
 * background behind the text.
 */
export const textStyleSchema = z.object({
  fontFamily: z.string().min(1).max(200),
  fontSize: z.number().min(12).max(400),
  fontWeight: z.number().int().min(100).max(900),
  lineHeight: z.number().min(0.7).max(3),
  letterSpacing: z.number().min(-0.2).max(0.5),
  align: textAlignSchema,
  verticalAlign: verticalAlignSchema,
  color: hexColorSchema.nullable(),
  italic: z.boolean(),
  uppercase: z.boolean(),
  /** Shrink the type until it fits `maxLines` (when set) and the copy region. */
  autoFit: z.boolean(),
  /** Smallest size, in reference pixels, auto-fit may shrink to. */
  minFontSize: z.number().min(8).max(400),
  /** Line limit used by auto-fit and overflow checks; 0 means unlimited. */
  maxLines: z.number().int().min(0).max(20),
  /** Wrap long lines; when false each paragraph stays on one line. */
  wrap: z.boolean(),
})

/** Per-layer typography overrides on top of the theme role. */
export const textStyleOverridesSchema = textStyleSchema.partial()

/** Text decoration a span can carry. */
export const textDecorationSchema = z.enum(['none', 'underline', 'strike'])

/**
 * A run of text with uniform formatting. Paragraph breaks are `\n` inside
 * `text`. Marks override the layer style for the run only.
 */
export const textSpanSchema = z.object({
  text: z.string().max(2000),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  color: hexColorSchema.optional(),
  /** Pill highlight behind the run. */
  highlight: hexColorSchema.optional(),
  /** Gradient fill for the run's glyphs. */
  gradient: z.object({ from: hexColorSchema, to: hexColorSchema }).optional(),
  decoration: textDecorationSchema.optional(),
})

/** Rich text: an ordered list of spans. */
export const richTextSchema = z.array(textSpanSchema).max(200)

/** Review state of one translation. */
export const translationStatusSchema = z.enum(['machine', 'draft', 'approved'])

/**
 * A localized variant of a text layer. `sourceHash` records the source copy it
 * was made from, so a later source edit marks the translation outdated
 * instead of overwriting it.
 */
export const translationSchema = z.object({
  content: richTextSchema,
  status: translationStatusSchema,
  sourceHash: z.string().max(64),
  updatedAt: z.number().int().nonnegative(),
})

/** Layout-managed placement: a device slot or a position in the text flow. */
export const autoPlacementSchema = z.object({
  mode: z.literal('auto'),
  /** Device slot index in the layout, or flow order for text. */
  slot: z.number().int().min(0).max(9),
})

/** Free placement: centre point and width, in slide percentages. */
export const freePlacementSchema = z.object({
  mode: z.literal('free'),
  x: z.number().min(-100).max(200),
  y: z.number().min(-100).max(200),
  width: z.number().min(1).max(300),
})

/** Where a layer sits before its transform applies. */
export const placementSchema = z.discriminatedUnion('mode', [
  autoPlacementSchema,
  freePlacementSchema,
])

/**
 * User adjustments applied after layout. Offsets are slide percentages,
 * `scale` multiplies the laid-out width, angles are degrees.
 */
export const transformSchema = z.object({
  offsetX: z.number().min(-200).max(200),
  offsetY: z.number().min(-200).max(200),
  scale: z.number().min(0.1).max(5),
  rotation: z.number().min(-180).max(180),
  tiltX: z.number().min(-45).max(45),
  tiltY: z.number().min(-45).max(45),
})

/** How a screenshot fills a device screen. */
export const imageFitModeSchema = z.enum(['fill', 'fit', 'custom'])

/** Screenshot framing inside the device screen (the crop). */
export const imageFramingSchema = z.object({
  mode: imageFitModeSchema,
  scale: z.number().min(0.25).max(4),
  offsetX: z.number().min(-100).max(100),
  offsetY: z.number().min(-100).max(100),
})

/** Color adjustments applied to a screenshot. */
export const imageFiltersSchema = z.object({
  brightness: z.number().min(50).max(150),
  contrast: z.number().min(50).max(150),
  saturation: z.number().min(0).max(180),
})

/** Device presentation styles. */
export const deviceStyleSchema = z.enum(['realistic', 'clay', 'frameless', 'screen-only'])

/** Device orientation. */
export const orientationSchema = z.enum(['portrait', 'landscape'])

/** Device frame selection. `modelId` refers to the device catalog. */
export const deviceFrameSchema = z.object({
  modelId: z.string().min(1).max(80),
  finishId: z.string().min(1).max(80),
  style: deviceStyleSchema,
  orientation: orientationSchema,
})

/** Status bar text color. */
export const statusBarAppearanceSchema = z.enum(['auto', 'light', 'dark'])

/**
 * Status bar drawn over the device screen. It is presentation only: the
 * screenshot is never modified, and `cover` paints a strip in the
 * screenshot's own top color under the bar so an existing bar is not doubled.
 */
export const statusBarSchema = z.object({
  visible: z.boolean(),
  time: z.string().max(8),
  battery: z.number().int().min(0).max(100),
  signal: z.number().int().min(0).max(4),
  wifi: z.number().int().min(0).max(3),
  carrier: z.string().max(24),
  appearance: statusBarAppearanceSchema,
  cover: z.boolean(),
})

/** Layer types. */
export const layerTypeSchema = z.enum(['text', 'device', 'image', 'annotation', 'callout'])

const layerBaseShape = {
  id: idSchema,
  name: z.string().min(1).max(80),
  hidden: z.boolean(),
  locked: z.boolean(),
  /** Layers sharing a group id select and move together. */
  groupId: idSchema.nullable(),
  opacity: z.number().min(0).max(1),
  transform: transformSchema,
}

/** A heading, subheading, or body text block. */
export const textLayerSchema = z.object({
  ...layerBaseShape,
  type: z.literal(layerTypeSchema.enum.text),
  role: textRoleSchema,
  placement: placementSchema,
  content: richTextSchema,
  style: textStyleOverridesSchema,
  /** Translations keyed by BCP 47 locale. */
  translations: z.record(z.string(), translationSchema),
  /** Locale-specific typography and position adjustments. */
  localeOverrides: z.record(
    z.string(),
    z.object({ style: textStyleOverridesSchema, offsetX: z.number(), offsetY: z.number() })
  ),
})

/** A device mockup showing one screenshot. */
export const deviceLayerSchema = z.object({
  ...layerBaseShape,
  type: z.literal(layerTypeSchema.enum.device),
  placement: placementSchema,
  /** The screenshot asset, or null for an empty screen. */
  assetId: idSchema.nullable(),
  frame: deviceFrameSchema,
  image: imageFramingSchema,
  filters: imageFiltersSchema,
  statusBar: statusBarSchema,
})

/** A free-floating image such as a logo or sticker. */
export const imageLayerSchema = z.object({
  ...layerBaseShape,
  type: z.literal(layerTypeSchema.enum.image),
  placement: freePlacementSchema,
  assetId: idSchema,
})

/** Annotation kinds. */
export const annotationKindSchema = z.enum([
  'step',
  'label',
  'arrow',
  'highlight',
  'rating',
  'laurel',
  'badge',
])

/** Highlight shapes. */
export const highlightShapeSchema = z.enum(['rectangle', 'ellipse'])

/**
 * Badges, arrows, ratings, and other editable marks. Text such as a rating
 * value or award name is always user supplied; the editor never invents it.
 */
export const annotationLayerSchema = z.object({
  ...layerBaseShape,
  type: z.literal(layerTypeSchema.enum.annotation),
  kind: annotationKindSchema,
  placement: freePlacementSchema,
  /** Height as a percentage of slide height. */
  height: z.number().min(0.5).max(200),
  text: z.string().max(120),
  /** Secondary line, e.g. the source of a rating or award. */
  caption: z.string().max(120),
  color: hexColorSchema,
  fill: hexColorSchema.nullable(),
  textColor: hexColorSchema,
  strokeWidth: z.number().min(0).max(40),
  /** Numbered step value or star rating (0-5, halves allowed). */
  value: z.number().min(0).max(99),
  /** Arrow bend, -1 to 1. */
  curve: z.number().min(-1).max(1),
  shape: highlightShapeSchema,
})

/** Callout shapes. */
export const calloutShapeSchema = z.enum(['circle', 'rounded', 'square'])

/**
 * A magnified view of part of a device's screenshot. `region` is in the
 * screenshot's own 0-1 coordinates, so it stays on the same content when the
 * device moves, scales, rotates, or the crop changes.
 */
export const calloutLayerSchema = z.object({
  ...layerBaseShape,
  type: z.literal(layerTypeSchema.enum.callout),
  deviceLayerId: idSchema,
  region: z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().min(0.01).max(1),
    height: z.number().min(0.01).max(1),
  }),
  placement: freePlacementSchema,
  shape: calloutShapeSchema,
  borderWidth: z.number().min(0).max(40),
  borderColor: hexColorSchema,
  shadow: z.number().min(0).max(100),
  connector: z.boolean(),
})

/** Any composition layer. */
export const layerSchema = z.discriminatedUnion('type', [
  textLayerSchema,
  deviceLayerSchema,
  imageLayerSchema,
  annotationLayerSchema,
  calloutLayerSchema,
])

/** Built-in layout presets. */
export const layoutIdSchema = z.enum([
  'classic',
  'hero',
  'editorial-left',
  'editorial-right',
  'offset',
  'duo',
  'minimal',
  'no-mockup',
  'tablet-phone',
  'trio',
])

/** Per export target layer adjustments, keyed by layer id. */
export const targetOverridesSchema = z.record(
  z.string(),
  z.record(z.string(), transformSchema.partial())
)

/** One screenshot in the set. */
export const slideSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(80),
  /** Null follows the template's layout sequence. */
  layout: layoutIdSchema.nullable(),
  /** Null uses the theme background. */
  background: backgroundSchema.nullable(),
  /**
   * Paint the background as one slice of a wider strip, so slides detached
   * from a panorama keep their continuous look.
   */
  backgroundSpan: z
    .object({ count: z.number().int().min(2).max(3), index: z.number().int().min(0).max(2) })
    .nullable(),
  /** Bottom to top. */
  layers: z.array(layerSchema).max(60),
  /** Adjustments that only apply when exporting a specific target id. */
  targetOverrides: targetOverridesSchema,
})

/**
 * Two or three adjacent slides that share one continuous background and a
 * set of layers positioned in panorama space (width = slide count x 100%).
 */
export const panoramaSchema = z.object({
  id: idSchema,
  slideIds: z.array(idSchema).min(2).max(3),
  background: backgroundSchema,
  layers: z.array(layerSchema).max(30),
})

/** Template ids, including user-saved templates (`user:<id>`). */
export const templateIdSchema = z.string().min(1).max(80)

/** Project-wide defaults that slides inherit. */
export const themeSchema = z.object({
  background: backgroundSchema,
  textStyles: z.object({
    heading: textStyleSchema,
    subheading: textStyleSchema,
    body: textStyleSchema,
  }),
  deviceFrame: deviceFrameSchema,
  /** Device drop shadow strength, 0-100. */
  shadow: z.number().min(0).max(100),
  /** Brand palette offered by color pickers. */
  palette: z.array(hexColorSchema).max(12),
})

/** Metadata for a binary asset. The bytes live in the asset store. */
export const assetSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(200),
  mime: z.string().max(80),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.number().int().nonnegative(),
  /** Public URL for bundled starter assets; uploaded assets resolve through the asset store. */
  src: z.string().max(400).nullable(),
  /** 4x8 grid of average colors, row major, for contrast checks. */
  colorGrid: z.array(hexColorSchema).max(64),
  /** Average color of the top 4% of the image, used under a status bar. */
  topColor: hexColorSchema,
})

/** Animated preview transitions. */
export const transitionSchema = z.enum(['none', 'fade', 'slide', 'zoom'])

/** Text entrance effects. */
export const textRevealSchema = z.enum(['none', 'fade', 'rise'])

/** Device motion effects. */
export const deviceMotionSchema = z.enum(['none', 'float', 'rise'])

/** Animated preview settings. Durations are seconds. */
export const animationSettingsSchema = z.object({
  slideDuration: z.number().min(0.5).max(15),
  slideDurations: z.record(z.string(), z.number().min(0.5).max(15)),
  transition: transitionSchema,
  transitionDuration: z.number().min(0).max(3),
  /** Slow zoom applied across each slide, 0 = off, 0.15 = 15% growth. */
  kenBurns: z.number().min(0).max(0.4),
  textReveal: textRevealSchema,
  deviceMotion: deviceMotionSchema,
  fps: z.number().int().min(5).max(60),
})

/** Localization state of the project. */
export const localizationSchema = z.object({
  sourceLocale: z.string().min(2).max(16),
  locales: z.array(z.string().min(2).max(16)).max(40),
})

/** A remembered AI copy suggestion and whether it was applied. */
export const copySuggestionSchema = z.object({
  id: idSchema,
  slideId: idSchema,
  locale: z.string().max(16),
  headline: z.string().max(200),
  subheadline: z.string().max(300),
  tone: z.string().max(40),
  createdAt: z.number().int().nonnegative(),
  appliedAt: z.number().int().nonnegative().nullable(),
})

/** Where a non-bundled font comes from. */
export const fontSourceKindSchema = z.enum(['google', 'custom'])

/**
 * A font the project loads in addition to the bundled ones. Custom fonts are
 * uploaded files stored as assets; Google fonts load from Google Fonts.
 */
export const fontSourceSchema = z.object({
  family: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z0-9][A-Za-z0-9 -]*$/, 'Use letters, numbers, spaces, and hyphens.'),
  kind: fontSourceKindSchema,
  assetId: idSchema.nullable(),
})

/** The complete project document. */
export const storeDocumentSchema = z.object({
  version: z.literal(STORE_DOCUMENT_VERSION),
  id: idSchema,
  name: z.string().min(1).max(120),
  templateId: templateIdSchema,
  theme: themeSchema,
  assets: z.record(z.string(), assetSchema),
  slides: z.array(slideSchema).min(1).max(30),
  panoramas: z.array(panoramaSchema).max(10),
  localization: localizationSchema,
  animation: animationSettingsSchema,
  fonts: z.array(fontSourceSchema).max(20),
  brandKitId: idSchema.nullable(),
  copySuggestions: z.array(copySuggestionSchema).max(200),
  /** Product facts the AI copy assistant may rely on. */
  productBrief: z.string().max(4000),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  /** Incremented on every successful save; used to detect conflicting writes. */
  revision: z.number().int().nonnegative(),
})

/** A store screenshot project. */
export type StoreDocument = z.infer<typeof storeDocumentSchema>
/** One slide. */
export type StoreSlideV2 = z.infer<typeof slideSchema>
/** Any layer. */
export type StoreLayer = z.infer<typeof layerSchema>
/** A text layer. */
export type TextLayer = z.infer<typeof textLayerSchema>
/** A device layer. */
export type DeviceLayer = z.infer<typeof deviceLayerSchema>
/** An image layer. */
export type ImageLayer = z.infer<typeof imageLayerSchema>
/** An annotation layer. */
export type AnnotationLayer = z.infer<typeof annotationLayerSchema>
/** A callout layer. */
export type CalloutLayer = z.infer<typeof calloutLayerSchema>
/** Layer type discriminator. */
export type LayerType = z.infer<typeof layerTypeSchema>
/** Background fill. */
export type Background = z.infer<typeof backgroundSchema>
/** Complete typography. */
export type TextStyle = z.infer<typeof textStyleSchema>
/** Partial typography overrides. */
export type TextStyleOverrides = z.infer<typeof textStyleOverridesSchema>
/** Rich text span. */
export type TextSpan = z.infer<typeof textSpanSchema>
/** Rich text. */
export type RichText = z.infer<typeof richTextSchema>
/** Typography role. */
export type TextRole = z.infer<typeof textRoleSchema>
/** Translation of a text layer. */
export type Translation = z.infer<typeof translationSchema>
/** Translation review status. */
export type TranslationStatus = z.infer<typeof translationStatusSchema>
/** Layer placement. */
export type Placement = z.infer<typeof placementSchema>
/** Free placement. */
export type FreePlacement = z.infer<typeof freePlacementSchema>
/** Layer transform. */
export type LayerTransform = z.infer<typeof transformSchema>
/** Screenshot framing inside a device. */
export type ImageFraming = z.infer<typeof imageFramingSchema>
/** Screenshot color adjustments. */
export type ImageFilters = z.infer<typeof imageFiltersSchema>
/** Device frame selection. */
export type DeviceFrame = z.infer<typeof deviceFrameSchema>
/** Device presentation style. */
export type DeviceStyle = z.infer<typeof deviceStyleSchema>
/** Device status bar. */
export type StatusBar = z.infer<typeof statusBarSchema>
/** Layout preset id. */
export type LayoutId = z.infer<typeof layoutIdSchema>
/** Panorama group. */
export type Panorama = z.infer<typeof panoramaSchema>
/** Project theme. */
export type Theme = z.infer<typeof themeSchema>
/** Asset metadata. */
export type StoreAsset = z.infer<typeof assetSchema>
/** Animated preview settings. */
export type AnimationSettings = z.infer<typeof animationSettingsSchema>
/** Annotation kind. */
export type AnnotationKind = z.infer<typeof annotationKindSchema>
/** Localization settings. */
export type LocalizationSettings = z.infer<typeof localizationSchema>
/** AI copy suggestion. */
export type CopySuggestion = z.infer<typeof copySuggestionSchema>
/** Animated transition. */
export type Transition = z.infer<typeof transitionSchema>
/** Extra font source. */
export type FontSource = z.infer<typeof fontSourceSchema>
