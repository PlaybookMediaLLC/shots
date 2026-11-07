import {
  calculateCanvasDimensions,
  mainImageRect,
} from '@/components/canvas/utils/canvas-dimensions'
import { calculateFitDimensions, getAspectRatioPreset } from '@/lib/aspect-ratio-utils'
import { getMockupDefinition } from '@/lib/constants/mockups'
import { type DesignDocument, designDocumentSchema } from '@/lib/design/document'

/**
 * The editor's default padding around the screenshot, as in lib/store. Kept
 * here because the store is a client module: server code that lays
 * documents out (workflow canvases) must read a number, not a client
 * reference. test/canvas-plan.test.ts keeps the two equal.
 */
export const DEFAULT_CANVAS_PADDING = 40

/**
 * Lay a design out again for another canvas size (or another screenshot),
 * instead of stretching it. The document is set to the target size
 * (`aspectRatio: 'custom'`); the stage then fits the screenshot, frame, and
 * shadow to the new canvas the way the editor always does, and the layers
 * stored in canvas fractions are moved by what they belong to:
 *
 * - Layers on the screenshot or on a device (annotations, blur regions,
 *   badges, cursors, spotlights) follow it: each keeps its place on the
 *   screenshot, measured with the editor's own stage geometry. Blur regions
 *   also grow by a small safety pad, so what they hide stays hidden.
 * - Free layers (stickers, zoom callouts, devices) keep their relative place
 *   and scale by the largest factor that fits ("contain"), so a layer that
 *   fit before still fits, with its proportions unchanged.
 * - Text scales with the shorter side (clamped), so a headline stays
 *   readable on a story and on a banner, shrinks if one line would not fit
 *   the width, and is kept inside the safe margins.
 *
 * Pure: the same document and target always give the same result.
 */

/** A canvas size in output pixels. */
export type CanvasPixelSize = { height: number; width: number }

/** What adapting may know about the screenshots. */
export type AdaptOptions = {
  /** Natural width / height of the screenshot the result shows; without it nothing follows the screenshot. */
  imageAspect?: number
  /**
   * Natural width / height of the screenshot the document was designed on,
   * when a style is applied to another screenshot. Defaults to `imageAspect`.
   */
  sourceImageAspect?: number
}

/** Inner margin free layers and text are kept inside, as a fraction of each side. */
export const SAFE_MARGIN = 0.03
/** Bounds for the text scale factor. */
export const TEXT_SCALE_LIMITS = { max: 1.6, min: 0.6 } as const
/** Average glyph width as a fraction of the font size, for fitting a line. */
const GLYPH_WIDTH = 0.55
/** Headroom for bold and wide glyphs when one word has to fit a box. */
const WIDE_GLYPHS = 1.15
const LINE_HEIGHT = 1.2
/**
 * The box the render frame's stage is fitted into, in CSS px. Canvas padding
 * and browser bars are absolute px, so their share of the canvas depends on
 * the stage size.
 * ponytail: mirrors the render frame's layout (1600×1200 frame less the editor's panel gutters);
 * read the measured stage size if the frame layout changes.
 */
const STAGE_BOX = { height: 1000, width: 1024 }
const STAGE_VIEWPORT = { height: 1200, width: 1600 }

/** A box in canvas fractions: centre and size. */
export type FractionBox = { cx: number; cy: number; height: number; width: number }

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const validAspect = (aspect: number | undefined): aspect is number =>
  aspect !== undefined && Number.isFinite(aspect) && aspect > 0

/**
 * The output size a ratio choice renders at: a custom canvas keeps its own
 * size, every other ratio takes its preset. Callers holding the editor's
 * ratio rather than a document (the editor's publish preflight) use this.
 */
export function canvasSizeOf(
  aspectRatio: string | undefined,
  size?: CanvasPixelSize
): CanvasPixelSize {
  if (aspectRatio === 'custom' && size) return { ...size }
  const preset = getAspectRatioPreset(
    aspectRatio && aspectRatio !== 'custom' ? aspectRatio : '4_3'
  )
  return { height: preset?.height ?? 1440, width: preset?.width ?? 1920 }
}

/** The output size a document renders at. */
export function documentCanvasSize(document: DesignDocument): CanvasPixelSize {
  return canvasSizeOf(document.canvas?.aspectRatio, document.canvas?.size)
}

/**
 * Where the main screenshot is drawn on a canvas of this size, in canvas
 * fractions, computed by the stage's own geometry (padding, scale, frame).
 * Null when the aspect is unknown.
 */
export function screenshotBox(
  document: DesignDocument,
  size: CanvasPixelSize,
  imageAspect: number | undefined
): FractionBox | null {
  if (!validAspect(imageAspect)) return null
  const stage = calculateFitDimensions(size.width, size.height, STAGE_BOX.width, STAGE_BOX.height)
  const frameType = document.image.frame?.type ?? 'none'
  const frame = {
    enabled: frameType !== 'none',
    padding: document.image.frame?.padding,
    type: frameType,
    width: document.image.frame?.width ?? 0,
  }
  const screenshot = {
    offsetX: (document.image.offset?.x ?? 0) * stage.width,
    offsetY: (document.image.offset?.y ?? 0) * stage.height,
    radius: 0,
    scale: (document.image.scale ?? 100) / 100,
  }
  // The geometry reads only the image's natural size; an element is not needed for that.
  const image = { naturalHeight: 1000, naturalWidth: 1000 * imageAspect } as HTMLImageElement
  const dimensions = calculateCanvasDimensions(
    image,
    stage.width,
    stage.height,
    STAGE_VIEWPORT,
    { padding: document.canvas?.padding ?? DEFAULT_CANVAS_PADDING },
    screenshot,
    frame,
    document.image.browserHeaderSize
  )
  const rect = mainImageRect(dimensions, screenshot, frame.enabled ? frame.type : 'none')
  return {
    cx: (rect.x + rect.width / 2) / stage.width,
    cy: (rect.y + rect.height / 2) / stage.height,
    height: rect.height / stage.height,
    width: rect.width / stage.width,
  }
}

/** Where each visible device is drawn, in canvas fractions; its height follows the device's own shape. */
function deviceBoxes(devices: DesignDocument['devices'], size: CanvasPixelSize): FractionBox[] {
  return (devices?.mockups ?? []).map((device) => {
    const aspect = getMockupDefinition(device.definitionId)?.aspectRatio ?? 1
    const widthPx = device.size * size.width
    return {
      cx: device.position.x,
      cy: device.position.y,
      height: widthPx / aspect / size.height,
      width: device.size,
    }
  })
}

/** The boxes layers can belong to: the screenshot, then every device. */
function anchorBoxes(
  document: DesignDocument,
  devices: DesignDocument['devices'],
  size: CanvasPixelSize,
  imageAspect: number | undefined
): (FractionBox | null)[] {
  const main = document.mode === 'device' ? null : screenshotBox(document, size, imageAspect)
  return [main, ...deviceBoxes(devices, size)]
}

const contains = (box: FractionBox, x: number, y: number) =>
  Math.abs(x - box.cx) <= box.width / 2 && Math.abs(y - box.cy) <= box.height / 2

/** Adapt a document to a target size. See the module comment for the rules. */
export function adaptDocumentToSize(
  document: DesignDocument,
  target: CanvasPixelSize,
  options: AdaptOptions = {}
): DesignDocument {
  const from = documentCanvasSize(document)
  const to = { height: Math.round(target.height), width: Math.round(target.width) }
  const canvas = { ...document.canvas, aspectRatio: 'custom' as const, size: to }
  const imageAspect = options.imageAspect
  const sourceAspect = options.sourceImageAspect ?? imageAspect
  const resized = from.width !== to.width || from.height !== to.height
  const reshot =
    validAspect(imageAspect) &&
    validAspect(sourceAspect) &&
    Math.abs(imageAspect - sourceAspect) > 1e-6
  if (!resized && !reshot) return designDocumentSchema.parse({ ...document, canvas })

  const contain = Math.min(to.width / from.width, to.height / from.height)
  const textScale = clamp(
    Math.min(to.width, to.height) / Math.min(from.width, from.height),
    TEXT_SCALE_LIMITS.min,
    TEXT_SCALE_LIMITS.max
  )

  // Devices are free layers: same centre, scaled by contain.
  const devices = document.devices
    ? {
        ...document.devices,
        mockups: document.devices.mockups.map((device) => ({
          ...device,
          size: clamp((device.size * from.width * contain) / to.width, 0.05, 1),
        })),
      }
    : undefined

  const before = anchorBoxes(document, document.devices, from, sourceAspect)
  const after = anchorBoxes(document, devices, to, imageAspect)
  const anchors = before.flatMap((box, index) => {
    const moved = after[index]
    return box && moved
      ? [{ after: moved, before: box, scale: (moved.width * to.width) / (box.width * from.width) }]
      : []
  })
  const anchorAt = (x: number, y: number) => anchors.find((anchor) => contains(anchor.before, x, y))

  /** A point in canvas fractions, following the screenshot or device it lies on. */
  const mapPoint = (x: number, y: number): { x: number; y: number } => {
    const anchor = anchorAt(x, y)
    if (!anchor) return { x, y }
    const u = (x - anchor.before.cx) / anchor.before.width
    const v = (y - anchor.before.cy) / anchor.before.height
    return {
      x: anchor.after.cx + u * anchor.after.width,
      y: anchor.after.cy + v * anchor.after.height,
    }
  }

  /** Keep a centred span of half-size `half` inside the margins, when it fits there. */
  const inside = (center: number, half: number) =>
    half >= 0.5 - SAFE_MARGIN ? 0.5 : clamp(center, SAFE_MARGIN + half, 1 - SAFE_MARGIN - half)

  /**
   * A centred box in fractions. Boxes on an anchor follow it and are never
   * pulled in, since that would move them off what they mark; free boxes
   * scale by contain and, when the canvas was resized and they were inside
   * it, are kept inside the margins.
   */
  const mapBox = (
    box: { height: number; width: number; x: number; y: number },
    { anchorable, keepInside }: { anchorable: boolean; keepInside: boolean }
  ) => {
    const anchor = anchorable ? anchorAt(box.x, box.y) : undefined
    const scale = anchor ? anchor.scale : contain
    const width = clamp((box.width * from.width * scale) / to.width, 0.005, 2)
    const height = clamp((box.height * from.height * scale) / to.height, 0.005, 2)
    if (anchor) {
      const center = mapPoint(box.x, box.y)
      return { height, width, x: clamp(center.x, -0.5, 1.5), y: clamp(center.y, -0.5, 1.5) }
    }
    const wasInside =
      resized &&
      keepInside &&
      box.x - box.width / 2 >= 0 &&
      box.x + box.width / 2 <= 1 &&
      box.y - box.height / 2 >= 0 &&
      box.y + box.height / 2 <= 1
    return {
      height,
      width,
      x: wasInside ? inside(box.x, width / 2) : box.x,
      y: wasInside ? inside(box.y, height / 2) : box.y,
    }
  }

  const texts = !resized
    ? document.texts
    : document.texts.map((text) => {
        const lines = text.text.split('\n')
        const longest = Math.max(1, ...lines.map((line) => line.length))
        const vertical = text.orientation === 'vertical'
        let fontPx = text.fontSize * from.width * textScale
        // A wrapping box wraps instead; an unwrapped line shrinks to fit the width.
        if (!text.maxWidth) {
          const across = vertical ? lines.length * LINE_HEIGHT : longest * GLYPH_WIDTH
          fontPx = Math.min(fontPx, ((1 - SAFE_MARGIN * 2) * to.width) / across)
        } else if (!vertical) {
          // Wrapping cannot split a word, so the longest word must fit the box (bold runs wide).
          const word = Math.max(1, ...text.text.split(/\s+/).map((part) => part.length))
          fontPx = Math.min(fontPx, (text.maxWidth * to.width) / (word * GLYPH_WIDTH * WIDE_GLYPHS))
        }
        const fontSize = clamp(fontPx / to.width, 0.005, 0.3)
        const px = fontSize * to.width
        const lineSpan = (vertical ? lines.length * LINE_HEIGHT : longest * GLYPH_WIDTH) * px
        const halfW = Math.min(lineSpan, (text.maxWidth ?? 2) * to.width) / 2 / to.width
        const halfH = ((vertical ? longest : lines.length * LINE_HEIGHT) * px) / 2 / to.height
        return {
          ...text,
          fontSize,
          position: {
            x: inside(text.position.x / 100, halfW) * 100,
            y: inside(text.position.y / 100, halfH) * 100,
          },
        }
      })

  const elements = document.elements.map((element) => ({
    ...element,
    // A zoom callout already follows the screenshot through its source; its box is free.
    ...mapBox(element, { anchorable: element.type !== 'callout', keepInside: true }),
  }))

  const overlays = document.overlays.map((overlay) => {
    // Overlays are square boxes `size` canvas widths wide.
    const box = mapBox(
      {
        height: (overlay.size * from.width) / from.height,
        width: overlay.size,
        x: overlay.position.x,
        y: overlay.position.y,
      },
      { anchorable: false, keepInside: true }
    )
    return {
      ...overlay,
      position: { x: clamp(box.x, 0, 1), y: clamp(box.y, 0, 1) },
      size: clamp(box.width, 0.01, 2),
    }
  })

  const clampPoint = (point: { x: number; y: number }) => ({
    x: clamp(point.x, 0, 1),
    y: clamp(point.y, 0, 1),
  })
  const annotations = document.annotations.map((shape) => ({
    ...shape,
    ...(shape.control ? { control: clampPoint(mapPoint(shape.control.x, shape.control.y)) } : {}),
    end: clampPoint(mapPoint(shape.end.x, shape.end.y)),
    start: clampPoint(mapPoint(shape.start.x, shape.start.y)),
  }))

  // Blur regions are stored by their top-left corner and grow by a safety pad.
  const pad = Math.max(4, 0.015 * Math.min(to.width, to.height))
  const redactions = document.redactions.map((region) => {
    const box = mapBox(
      {
        height: region.size.height,
        width: region.size.width,
        x: region.position.x + region.size.width / 2,
        y: region.position.y + region.size.height / 2,
      },
      // Never pulled in: a blur region stays over what it hides.
      { anchorable: true, keepInside: false }
    )
    const width = Math.min(1, box.width + (pad * 2) / to.width)
    const height = Math.min(1, box.height + (pad * 2) / to.height)
    // A region that touched an edge keeps touching it: it hid content running off the canvas.
    const edge = (start: number, span: number, center: number, size: number) =>
      start <= 1e-6
        ? 0
        : start + span >= 1 - 1e-6
          ? 1 - size
          : clamp(center - size / 2, 0, 1 - size)
    return {
      ...region,
      position: {
        x: edge(region.position.x, region.size.width, box.x, width),
        y: edge(region.position.y, region.size.height, box.y, height),
      },
      size: { height, width },
    }
  })

  return designDocumentSchema.parse({
    ...document,
    annotations,
    canvas,
    devices,
    elements,
    overlays,
    redactions,
    texts,
  })
}

/** The document with no background: transparent, without pattern or grain. */
export function withoutBackground(document: DesignDocument): DesignDocument {
  return {
    ...document,
    background: {
      blur: 0,
      noise: 0,
      opacity: 1,
      radius: document.background?.radius,
      type: 'solid',
      value: 'transparent',
    },
    pattern: undefined,
  }
}
