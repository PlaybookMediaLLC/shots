'use client'

import { type ImageState, useImageStore } from '@/lib/store'
import { useDeviceUIStore } from '@/lib/store/device-ui'
import { isChromeFrameType } from '@/lib/frames/main-frame'
import {
  audioClipSchema,
  captionItemSchema,
  captionStyleSchema,
  DEFAULT_CAPTION_STYLE,
  hasMotionContent,
  keyframeTrackSchema,
  scrollMotionSchema,
  textRevealSchema,
  type TimelineMotion,
  timelineFieldsFromMotion,
} from '@/lib/animation/motion-schema'
import {
  DESIGN_DOCUMENT_VERSION,
  type DesignDocument,
  designDocumentSchema,
  isDesignSource,
} from './document'

/**
 * Read the live editor into a DesignDocument: the inverse of applyDesign*.
 *
 * Pixel layers are converted back to normalized units against the current
 * canvas. Each section is validated on its own and dropped if it is not
 * portable (a CSS-variable color, an off-catalog value), so one exotic
 * setting never blocks exporting the rest.
 *
 * Two views of the same canvas:
 *
 * - by default the document leaves out local images (`blob:` and `data:`
 *   URLs): the main image is null, and local backgrounds, stickers, slides,
 *   and device screens are left out. This is what the AI sees and edits.
 * - `keepLocalSources` keeps them, so the document reproduces the canvas
 *   exactly. Projects, previews, batch, and multi-size export use this view
 *   and swap local URLs for uploaded assets before anything is stored.
 */

export type ExportDesignOptions = {
  /** Keep `blob:`/`data:` image sources, for a document that reproduces the canvas. */
  keepLocalSources?: boolean
}

const shape = designDocumentSchema.shape
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const hex = /^#[0-9a-f]{3,8}$|^rgba?\([\d\s.,%]+\)$/i
const LOCAL = /^(blob:|data:)/
const TEMPLATE_LIGHT_PREFIX = 'template-shadow-'

function valid<T>(
  schema: { safeParse: (value: unknown) => { data?: T; success: boolean } },
  value: unknown
) {
  const parsed = schema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function validItems<T>(
  schema: { element: { safeParse: (value: unknown) => { data?: T; success: boolean } } },
  items: unknown[]
) {
  return items
    .map((item) => valid(schema.element, item))
    .filter((item): item is T => item !== undefined)
}

/**
 * Motion as document fields. Each item is checked on its own, so one bad
 * caption never drops the timeline; local audio stays only in the lossless view.
 */
function portableMotion(motion: TimelineMotion, keepLocalSources: boolean) {
  return timelineFieldsFromMotion({
    audio: validItems({ element: audioClipSchema }, motion.audio).filter(
      (clip) => keepLocalSources || !LOCAL.test(clip.src)
    ),
    captions: {
      items: validItems({ element: captionItemSchema }, motion.captions.items),
      style: captionStyleSchema.safeParse(motion.captions.style).data ?? DEFAULT_CAPTION_STYLE,
    },
    layerTracks: validItems({ element: keyframeTrackSchema }, motion.layerTracks),
    reveals: validItems({ element: textRevealSchema }, motion.reveals),
    scrolls: validItems({ element: scrollMotionSchema }, motion.scrolls),
  })
}

/** The live editor as a document. See {@link ExportDesignOptions} for local images. */
export function exportDesignDocument(options: ExportDesignOptions = {}): DesignDocument {
  return documentFromState(useImageStore.getState(), options)
}

/** The same conversion for any editor state, such as a state about to be restored. */
export function documentFromState(
  image: ImageState,
  { keepLocalSources = false }: ExportDesignOptions = {}
): DesignDocument {
  const canvasW = image.canvasDimensions?.canvasW ?? 1920
  const canvasH = image.canvasDimensions?.canvasH ?? 1080
  const source = (ref: string | null | undefined): string | null =>
    !ref || !isDesignSource(ref) || (!keepLocalSources && LOCAL.test(ref)) ? null : ref
  const mainSrc = keepLocalSources ? source(image.uploadedImageUrl) : null

  const raw = {
    annotations: validItems(
      shape.annotations.unwrap(),
      image.annotations
        .filter((annotation) => annotation.type !== 'blur')
        .map((annotation) => ({
          control:
            annotation.cx !== undefined && annotation.cy !== undefined
              ? { x: clamp(annotation.cx / canvasW, 0, 1), y: clamp(annotation.cy / canvasH, 0, 1) }
              : undefined,
          end: { x: clamp(annotation.x2 / canvasW, 0, 1), y: clamp(annotation.y2 / canvasH, 0, 1) },
          fillColor: annotation.fillColor,
          id: annotation.id,
          opacity: annotation.opacity,
          radius:
            annotation.type === 'rectangle' && annotation.radius
              ? clamp(annotation.radius, 0, 0.5)
              : undefined,
          start: { x: clamp(annotation.x1 / canvasW, 0, 1), y: clamp(annotation.y1 / canvasH, 0, 1) },
          strokeColor: annotation.strokeColor,
          strokeWidth: clamp(annotation.strokeWidth, 1, 40),
          type: annotation.type,
          visible: annotation.isVisible,
        }))
    ),
    background: valid(shape.background, {
      blur: image.backgroundBlur,
      noise: image.backgroundNoise,
      opacity: image.backgroundConfig.opacity ?? 1,
      radius: clamp(image.backgroundBorderRadius, 0, 100),
      type: image.backgroundConfig.type,
      value:
        image.backgroundConfig.type === 'image'
          ? source(image.backgroundConfig.value)
          : image.backgroundConfig.value,
    }),
    canvas: valid(shape.canvas, {
      aspectRatio: image.selectedAspectRatio,
      padding: clamp(image.canvasPadding, 0, 200),
      size:
        image.selectedAspectRatio === 'custom' && image.customDimensions
          ? {
              height: Math.round(image.customDimensions.height),
              width: Math.round(image.customDimensions.width),
            }
          : undefined,
    }),
    devices:
      image.mockups.length > 0
        ? valid(shape.devices, {
            layoutId: image.activeDeviceLayoutId ?? undefined,
            mockups: image.mockups
              .filter((mockup) => keepLocalSources || mockup.isVisible)
              .map((mockup) => ({
                color: mockup.color,
                definitionId: mockup.definitionId,
                frame: mockup.frame,
                id: mockup.id,
                opacity: mockup.opacity,
                position: { x: clamp(mockup.position.x, 0, 1), y: clamp(mockup.position.y, 0, 1) },
                orientation: mockup.orientation,
                rotation: mockup.rotation,
                screen: {
                  aspect: mockup.screen.aspect,
                  code: mockup.screen.code,
                  fit: mockup.screen.fit,
                  name: mockup.screen.name ?? undefined,
                  offset: {
                    x: clamp(mockup.screen.offset.x, -1, 1),
                    y: clamp(mockup.screen.offset.y, -1, 1),
                  },
                  scale: clamp(mockup.screen.scale, 0.2, 5),
                  // A screen showing the main image follows it.
                  src:
                    !mockup.screen.isCustom && mockup.screen.src === image.uploadedImageUrl
                      ? null
                      : source(mockup.screen.src),
                },
                size: clamp(mockup.size, 0.05, 1),
                visible: mockup.isVisible,
              })),
          })
        : undefined,
    layerOrder: image.layerOrder,
    elements: image.elements.filter((element) => keepLocalSources || element.visible),
    image: {
      browserHeaderSize: image.browserHeaderSize,
      chrome:
        image.imageBorder.enabled && isChromeFrameType(image.imageBorder.type)
          ? valid(shape.image.shape.chrome, { ...image.frameChrome, address: image.browserUrl })
          : undefined,
      frame: valid(shape.image.shape.frame, {
        color: hex.test(image.imageBorder.color) ? image.imageBorder.color : '#ffffff',
        opacity: image.imageBorder.opacity ?? 1,
        padding: clamp(image.imageBorder.padding ?? 0, 0, 100),
        title: image.browserUrl || image.imageBorder.title || undefined,
        type: image.imageBorder.enabled ? image.imageBorder.type : 'none',
        width: clamp(image.imageBorder.width, 0, 40),
      }),
      filters: image.imageFilters,
      name: mainSrc && image.imageName ? image.imageName : undefined,
      positionAnchor: image.imagePlacement.anchor,
      offset: {
        x: clamp(image.imagePlacement.offsetX / canvasW, -0.5, 0.5),
        y: clamp(image.imagePlacement.offsetY / canvasH, -0.5, 0.5),
      },
      opacity: image.imageOpacity,
      perspective: {
        perspective: clamp(image.perspective3D.perspective, 200, 5000),
        rotateX: clamp(image.perspective3D.rotateX, -60, 60),
        rotateY: clamp(image.perspective3D.rotateY, -60, 60),
        rotateZ: clamp(image.perspective3D.rotateZ, -180, 180),
        scale: clamp(image.perspective3D.scale, 0.3, 2),
        translateX: clamp(image.perspective3D.translateX, -30, 30),
        translateY: clamp(image.perspective3D.translateY, -30, 30),
      },
      radius: clamp(image.borderRadius, 0, 100),
      rotation: clamp(image.imagePlacement.rotation, -180, 180),
      scale: clamp(image.imageScale, 10, 200),
      shadow: {
        custom: valid(shape.image.shape.shadow.unwrap().shape.custom, image.imageShadow),
        preset: image.shadowPreset,
      },
      src: mainSrc,
    },
    mode: image.editorMode,
    overlays: validItems(
      shape.overlays.unwrap(),
      image.imageOverlays
        .filter((overlay) => keepLocalSources || overlay.isVisible)
        .filter((overlay) => keepLocalSources || !overlay.id.startsWith(TEMPLATE_LIGHT_PREFIX))
        .map((overlay) => ({
          blur: overlay.blur,
          flipX: overlay.flipX,
          flipY: overlay.flipY,
          id: overlay.id,
          layer: overlay.layer ?? 'front',
          opacity: overlay.opacity,
          position: {
            x: clamp(overlay.position.x / canvasW, 0, 1),
            y: clamp(overlay.position.y / canvasH, 0, 1),
          },
          radius: overlay.radius,
          role: overlay.id.startsWith(TEMPLATE_LIGHT_PREFIX) ? 'template-light' : undefined,
          rotation: overlay.rotation,
          shadow: overlay.shadow,
          size: clamp(overlay.size / canvasW, 0.01, 2),
          src: source(overlay.src),
          tilt: overlay.tilt,
          visible: overlay.isVisible,
        }))
    ),
    pattern: image.pattern.enabled ? valid(shape.pattern, image.pattern) : undefined,
    brand: valid(shape.brand, image.brand ?? undefined),
    copy: valid(shape.copy, image.copy ?? undefined),
    redactions: validItems(
      shape.redactions.unwrap(),
      image.blurRegions
        .filter((region) => keepLocalSources || region.isVisible)
        .map((region) => ({
          amount: clamp(region.blurAmount, 1, 60),
          id: region.id,
          position: {
            x: clamp(region.position.x / canvasW, 0, 1),
            y: clamp(region.position.y / canvasH, 0, 1),
          },
          size: {
            height: clamp(region.size.height / canvasH, 0, 1),
            width: clamp(region.size.width / canvasW, 0, 1),
          },
          style: region.style ?? 'blur',
          visible: region.isVisible,
        }))
    ),
    slides:
      keepLocalSources && image.slides.length > 0
        ? valid(shape.slides, {
            activeId: image.activeSlideId,
            animation: image.slideshow.animation,
            defaultDuration: image.slideshow.defaultDuration,
            enabled: image.slideshow.enabled,
            items: image.slides
              .filter((slide) => source(slide.src))
              .map((slide) => ({
                duration: slide.duration,
                id: slide.id,
                name: slide.name,
                src: slide.src,
              })),
          })
        : undefined,
    texts: validItems(
      shape.texts.unwrap(),
      image.textOverlays
        .filter((text) => keepLocalSources || text.isVisible)
        .map((text) => ({
          color: text.color,
          zIndex: text.zIndex,
          fontFamily: text.fontFamily,
          fontSize: clamp(text.fontSize / canvasW, 0.005, 0.3),
          fontWeight: text.fontWeight,
          align: text.align,
          fill: text.fill,
          fit: text.fit,
          letterSpacing: text.letterSpacing,
          lineHeight: text.lineHeight,
          maxWidth: text.maxWidth,
          role: text.role,
          id: text.id,
          opacity: text.opacity,
          orientation: text.orientation,
          position: { x: clamp(text.position.x, 0, 100), y: clamp(text.position.y, 0, 100) },
          shadow: text.textShadow,
          text: text.text,
          visible: text.isVisible,
        }))
    ),
    timeline:
      image.timeline.tracks.length > 0 ||
      image.animationClips.length > 0 ||
      hasMotionContent(image.motion) ||
      // A slideshow's length lives on the timeline too.
      image.slides.length > 1
        ? valid(shape.timeline, {
            clips: image.animationClips,
            duration: image.timeline.duration,
            isLooping: image.timeline.isLooping,
            tracks: image.timeline.tracks,
            ...portableMotion(image.motion, keepLocalSources),
          })
        : undefined,
    version: DESIGN_DOCUMENT_VERSION,
  }
  const parsed = designDocumentSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  // Last resort: anything still invalid in the image section is dropped field by field.
  const imageFields = Object.fromEntries(
    Object.entries(raw.image).filter(([key, value]) => {
      const field = shape.image.shape[key as keyof typeof shape.image.shape]
      return field?.safeParse(value).success
    })
  )
  return designDocumentSchema.parse({ ...raw, image: imageFields })
}

/** Which layer the user has selected, for scoping AI edits to it. */
export function describeSelection(): { kind: string; label: string } | null {
  const image = useImageStore.getState()
  // Text selection lives in the canvas component; the selected text layer
  // marks itself in the DOM, which is enough to scope an edit to it.
  // The server renders the editor too, and has no selection to find.
  const selectedText =
    typeof document === 'undefined'
      ? undefined
      : document.querySelector<HTMLElement>(
          '[data-text-overlay-id][data-export-clean-outline="true"]'
        )?.dataset.textOverlayId
  if (selectedText) {
    const index = image.textOverlays.findIndex((text) => text.id === selectedText)
    if (index >= 0) {
      return {
        kind: 'text',
        label: `texts[${index}] ("${image.textOverlays[index]!.text.slice(0, 60)}")`,
      }
    }
  }
  const selectedDevice = useDeviceUIStore.getState().selectedDeviceId
  if (selectedDevice) {
    const index = image.mockups.findIndex((mockup) => mockup.id === selectedDevice)
    if (index >= 0) {
      return {
        kind: 'device',
        label: `devices.mockups[${index}] (${image.mockups[index]!.definitionId})`,
      }
    }
  }
  if (image.selectedElementId) {
    const index = image.elements.findIndex((element) => element.id === image.selectedElementId)
    if (index >= 0) {
      return {
        kind: 'element',
        label: `elements[${index}] (${image.elements[index]!.type})`,
      }
    }
  }
  if (image.selectedBlurId) {
    const index = image.blurRegions.findIndex((region) => region.id === image.selectedBlurId)
    if (index >= 0) {
      return {
        kind: 'redaction',
        label: `redactions[${index}] (${image.blurRegions[index]!.style ?? 'blur'})`,
      }
    }
  }
  if (image.selectedAnnotationId) {
    const index = image.annotations.findIndex((shape) => shape.id === image.selectedAnnotationId)
    if (index >= 0)
      return {
        kind: 'annotation',
        label: `annotations[${index}] (${image.annotations[index]!.type})`,
      }
  }
  if (image.selectedOverlayId) {
    const textIndex = image.textOverlays.findIndex((text) => text.id === image.selectedOverlayId)
    if (textIndex >= 0) {
      return {
        kind: 'text',
        label: `texts[${textIndex}] ("${image.textOverlays[textIndex]!.text.slice(0, 60)}")`,
      }
    }
    const overlayIndex = image.imageOverlays
      .filter((overlay) => !overlay.id.startsWith('template-shadow-'))
      .findIndex((overlay) => overlay.id === image.selectedOverlayId)
    if (overlayIndex >= 0) return { kind: 'overlay', label: `overlays[${overlayIndex}]` }
  }
  if (image.isMainImageSelected) return { kind: 'image', label: 'the main image (image section)' }
  return null
}
