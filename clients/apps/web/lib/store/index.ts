'use client'

import { create } from 'zustand'
import { resetPlayback, usePlaybackStore } from './playback'
import { NEUTRAL_IMAGE_FILTERS } from '@/lib/editor/image-adjustments'
import type { TextAlign, TextFill, TextFit, TextRole } from '@/lib/typography/text-style'
import type { BrandBinding } from '@/lib/brand/binding'
import type { DesignCopy } from '@/lib/captions/channels'
import { orderedLayerIds, moveLayer } from '@/lib/editor/layer-order'
import { createElementsSlice, type ElementsSlice } from './elements-slice'
import { createFramesSlice, type FramesSlice } from './frames-slice'
import { arrangeScreens } from '@/lib/frames/arrange'
import { compositionLayoutSchema } from '@/lib/frames/layouts'
import { getAspectRatioPreset } from '@/lib/aspect-ratio-utils'
import { isChromeFrameType } from '@/lib/frames/main-frame'
import { createMotionSlice, type MotionSlice } from './motion-slice'
import { emptyMotion } from '@/lib/animation/motion-schema'
import { motionEnd } from '@/lib/animation/motion-evaluate'
import { shallow } from 'zustand/shallow'
import { temporal } from 'zundo'
import { GradientKey } from '@/lib/constants/gradient-colors'
import { AspectRatioKey } from '@/lib/constants/aspect-ratios'
import { BackgroundConfig, BackgroundType } from '@/lib/constants/backgrounds'
import { gradientColors } from '@/lib/constants/gradient-colors'
import { solidColors } from '@/lib/constants/solid-colors'
import type { DeviceLayoutId, Mockup } from '@/types/mockup'
import { getDeviceLayout, MAX_DEVICE_MOCKUPS } from '@/lib/constants/mockups'
import {
  applyLayoutToMockups,
  cloneMockups,
  createMockup,
  createDeviceScreen,
  restoreMockupsFromLayoutSnapshot,
} from '@/lib/device-mockups/layouts'
import type { TimelineState, AnimationTrack, Keyframe, AnimationClip } from '@/types/animation'
import { DEFAULT_ANIMATABLE_PROPERTIES, DEFAULT_TIMELINE_STATE } from '@/types/animation'
import { clonePresetTracks, getPresetById, ANIMATION_PRESETS } from '@/lib/animation/presets'
import { buildAnimatedTemplateTimeline, getAnimatedTemplateById } from '@/lib/animation/templates'
import { presets as visualPresets, type PresetConfig } from '@/lib/constants/presets'
import { TEMPLATE_DEMO_IMAGE_NAME, TEMPLATE_DEMO_IMAGE_URL } from '@/lib/templates/demo-media'
import { getImageTemplateById, type ImageTemplateScene } from '@/lib/templates/image-templates'
import {
  trackImageUpload,
  trackBackgroundChange,
  trackFrameApply,
  trackOverlayAdd,
  trackAspectRatioChange,
  trackPresetApply,
  trackAnimationClipAdd,
} from '@/lib/analytics'

interface TextShadow {
  enabled: boolean
  color: string
  blur: number
  offsetX: number
  offsetY: number
}

export interface ImageFilters {
  brightness: number // 0-200 (100 = normal)
  contrast: number // 0-200 (100 = normal)
  grayscale: number // 0-100
  blur: number // 0-20px
  hueRotate: number // 0-360 degrees
  invert: number // 0-100
  saturate: number // 0-200 (100 = normal)
  sepia: number // 0-100
}
interface Slide {
  id: string
  src: string
  name: string | null
  duration: number
}
export interface TextOverlay {
  id: string
  text: string
  /** Stacking level relative to screens (20), image overlays (200) and elements (205). */
  zIndex?: number
  position: { x: number; y: number }
  fontSize: number
  fontWeight: string
  /** A font id from the catalog, or `google:<Family>` for Google Fonts. */
  fontFamily: string
  color: string
  opacity: number
  isVisible: boolean
  orientation: 'horizontal' | 'vertical'
  textShadow: TextShadow
  /** Solid uses `color`; a gradient clips to the glyphs. */
  fill?: TextFill
  align?: TextAlign
  /** Text box width as a fraction of the canvas width; with `fit` it shrinks or wraps. */
  maxWidth?: number
  fit?: TextFit
  /** Letter spacing in em. */
  letterSpacing?: number
  lineHeight?: number
  /** The part this layer plays in a typography template. */
  role?: TextRole
}

export interface ImageOverlayTilt {
  perspective: number
  rotateX: number
  rotateY: number
}

export interface ImageOverlay {
  id: string
  src: string
  position: { x: number; y: number } // Position in pixels relative to canvas
  size: number // Size in pixels
  rotation: number // Rotation in degrees
  opacity: number
  blur?: number // Blur amount in pixels (0 = no blur)
  flipX: boolean
  flipY: boolean
  isVisible: boolean
  isCustom?: boolean // Whether it's a custom uploaded overlay
  layer?: 'front' | 'back' // Render in front of or behind the main image
  tilt?: ImageOverlayTilt
  shadow?: ImageShadow
  radius?: number
}

export type BlurRegionStyle = 'blur' | 'mosaic'

export interface BlurRegion {
  id: string
  position: { x: number; y: number }
  size: { width: number; height: number }
  blurAmount: number // Mosaic block size when style is 'mosaic'
  isVisible: boolean
  style?: BlurRegionStyle // Missing on regions saved before mosaic existed; treated as 'blur'
}

export type AnnotationToolType = 'arrow' | 'curved-arrow' | 'rectangle' | 'circle' | 'line' | 'blur'

export interface AnnotationShape {
  id: string
  type: AnnotationToolType
  x1: number
  y1: number
  x2: number
  y2: number
  cx?: number
  cy?: number
  strokeColor: string
  strokeWidth: number
  fillColor: string
  opacity: number
  isVisible: boolean
  /** Rectangle corner radius as a fraction of the shorter side. */
  radius?: number
}

export type ImageStylePreset =
  'default' | 'glass-light' | 'glass-dark' | 'outline' | 'border-light' | 'border-dark'

function getImageStylePreset(imageBorder: ImageBorder): ImageStylePreset {
  switch (imageBorder.type) {
    case 'glass-light':
    case 'glass-dark':
    case 'border-light':
    case 'border-dark':
      return imageBorder.type
    case 'outline-light':
      return 'outline'
    default:
      return 'default'
  }
}
export type ShadowPreset = 'none' | 'hug' | 'soft' | 'strong'

export interface ImageBorder {
  enabled: boolean
  width: number
  color: string
  type:
    | 'none'
    | 'arc-light'
    | 'arc-dark'
    | 'macos-light'
    | 'macos-dark'
    | 'windows-light'
    | 'windows-dark'
    | 'photograph'
    | 'glass-light'
    | 'glass-dark'
    | 'outline-light'
    | 'border-light'
    | 'border-dark'
    | 'browser'
    | 'window'
  padding?: number
  title?: string
  opacity?: number
}

export interface ImageShadow {
  enabled: boolean
  blur: number
  offsetX: number
  offsetY: number
  spread: number
  color: string
  opacity: number
}

// Keeps a store type's data fields and drops its actions.
export type OmitFunctions<T> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [K in keyof T as T[K] extends (...args: any[]) => any ? never : K]: T[K]
}

/** Background pattern drawn over the background (grid, dots, lines). */
export interface BackgroundPattern {
  enabled: boolean
  type: string
  scale: number
  spacing: number
  color: string
  rotation: number
  blur: number
  opacity: number
}

/** Main image offset from the canvas centre, in stage px, and its rotation in degrees. */
export interface ImagePlacement {
  anchor?: 'tl' | 'tc' | 'tr' | 'ml' | 'mc' | 'mr' | 'bl' | 'bc' | 'br'
  offsetX: number
  offsetY: number
  rotation: number
}

export const DEFAULT_IMAGE_PLACEMENT: ImagePlacement = { offsetX: 0, offsetY: 0, rotation: 0 }

export const DEFAULT_CANVAS_PADDING = 40

export const DEFAULT_BACKGROUND_PATTERN: BackgroundPattern = {
  enabled: false,
  type: 'grid',
  scale: 1,
  spacing: 20,
  color: '#000000',
  rotation: 0,
  blur: 0,
  opacity: 0.5,
}

/** A timeline length that still fits the motion (reveals, scrolls, captions, audio). */
function lastingMotion(duration: number, motion: MotionSlice['motion']): number {
  return Math.max(duration, Math.ceil(motionEnd(motion)))
}

/** Most undo steps kept; at the limit each new step drops the oldest. */
export const HISTORY_LIMIT = 100

/**
 * A pointer gesture (a slider pull, a drag on the canvas) is one undo step:
 * only the state before its first change is recorded. Clicks finish their
 * gesture before their handler runs, so each click is still its own step.
 */
const historyGesture = { active: false, recorded: false }

/** Start grouping changes into one undo step, until {@link endHistoryGesture}. */
export function startHistoryGesture() {
  historyGesture.active = true
  historyGesture.recorded = false
}

export function endHistoryGesture() {
  historyGesture.active = false
}

// Re-export existing ImageState interface and store
export interface ImageState extends ElementsSlice, FramesSlice, MotionSlice {
  layerOrder: string[]
  uploadedImageUrl: string | null
  imageName: string | null
  selectedGradient: GradientKey
  borderRadius: number
  backgroundBorderRadius: number
  selectedAspectRatio: AspectRatioKey
  customDimensions: { width: number; height: number } | null
  backgroundConfig: BackgroundConfig
  backgroundBlur: number
  backgroundNoise: number
  textOverlays: TextOverlay[]
  imageOverlays: ImageOverlay[]
  mockups: Mockup[]
  activeDeviceLayoutId: DeviceLayoutId | null
  deviceLayoutSnapshot: Mockup[] | null
  imageOpacity: number
  imageScale: number
  imageBorder: ImageBorder
  imageShadow: ImageShadow
  imageStylePreset: ImageStylePreset
  shadowPreset: ShadowPreset
  perspective3D: {
    perspective: number
    rotateX: number
    rotateY: number
    rotateZ: number
    translateX: number
    translateY: number
    scale: number
  }
  imageFilters: ImageFilters
  imagePlacement: ImagePlacement
  canvasPadding: number
  pattern: BackgroundPattern
  /** The brand kit the design follows, and what it set (see lib/brand/apply.ts). */
  brand: BrandBinding | null
  /** Alt text and captions written for the design (see lib/captions). */
  copy: DesignCopy | null
  exportSettings: {
    quality: '1x' | '2x' | '3x'
    format: 'png' | 'jpeg' | 'webp'
    fileName: string
  }
  setUploadedImageUrl: (url: string | null, name: string | null) => void
  replaceTemplateMedia: (url: string, name: string, mockupId?: string) => void
  setImage: (file: File) => void
  clearImage: () => void
  /** Remove the screenshot (and its slides) but keep the design around it. */
  removeMainImage: () => void
  setGradient: (gradient: GradientKey) => void
  setBorderRadius: (radius: number) => void
  setBackgroundBorderRadius: (radius: number) => void
  setAspectRatio: (aspectRatio: AspectRatioKey) => void
  setCustomDimensions: (width: number, height: number) => void
  setBackgroundConfig: (config: BackgroundConfig) => void
  setBackgroundType: (type: BackgroundType) => void
  setBackgroundValue: (value: string) => void
  setBackgroundOpacity: (opacity: number) => void
  setBackgroundBlur: (blur: number) => void
  setBackgroundNoise: (noise: number) => void
  addTextOverlay: (overlay?: Omit<TextOverlay, 'id'>) => string
  updateTextOverlay: (id: string, updates: Partial<TextOverlay>) => void
  removeTextOverlay: (id: string) => void
  clearTextOverlays: () => void
  addImageOverlay: (overlay: Omit<ImageOverlay, 'id'>) => void
  updateImageOverlay: (id: string, updates: Partial<ImageOverlay>) => void
  removeImageOverlay: (id: string) => void
  clearImageOverlays: () => void
  addMockup: (mockup: Omit<Mockup, 'id'>) => string | null
  updateMockup: (id: string, updates: Partial<Mockup>) => void
  removeMockup: (id: string) => void
  clearMockups: () => void
  duplicateMockup: (id: string) => string | null
  reorderMockup: (id: string, direction: 'up' | 'down' | 'top' | 'bottom') => void
  clearDeviceLayout: () => void
  applyDeviceLayout: (layoutId: DeviceLayoutId) => void
  setImageOpacity: (opacity: number) => void
  setImageScale: (scale: number) => void
  setImageBorder: (border: ImageBorder | Partial<ImageBorder>) => void
  setImageShadow: (shadow: ImageShadow | Partial<ImageShadow>) => void
  setImageStylePreset: (preset: ImageStylePreset) => void
  setShadowPreset: (preset: ShadowPreset) => void
  applyVisualPreset: (
    preset: PresetConfig,
    options?: {
      clearAnimation?: boolean
      closeTemplates?: boolean
      scene?: ImageTemplateScene
    }
  ) => void
  applyAnimatedTemplate: (templateId: string) => void
  setPerspective3D: (perspective: Partial<ImageState['perspective3D']>) => void
  setImageFilter: (key: keyof ImageFilters, value: number) => void
  resetImageFilters: () => void
  setImagePlacement: (placement: Partial<ImagePlacement>) => void
  setCanvasPadding: (padding: number) => void
  setPattern: (pattern: Partial<BackgroundPattern>) => void
  setBrand: (brand: BrandBinding | null) => void
  setCopy: (copy: DesignCopy | null) => void
  resetCanvasSettings: () => void
  setExportSettings: (settings: Partial<ImageState['exportSettings']>) => void
  // Slideshow
  slides: Slide[]
  activeSlideId: string | null

  slideshow: {
    enabled: boolean
    defaultDuration: number
    animation: 'none' | 'fade' | 'slide'
  }
  // Preview
  isPreviewing: boolean
  previewIndex: number
  previewStartedAt: number | null
  setSlideshow: (updates: Partial<ImageState['slideshow']>) => void
  // Slideshow actions
  addImages: (files: File[]) => void
  setActiveSlide: (id: string) => void
  removeSlide: (id: string) => void
  startPreview: () => void
  resetSlideshow: () => void
  stopPreview: () => void

  // Timeline / Animation
  timeline: TimelineState
  showTimeline: boolean
  animationClips: AnimationClip[]
  setTimeline: (updates: Partial<TimelineState>) => void
  setShowTimeline: (show: boolean) => void
  toggleTimeline: () => void
  addKeyframe: (trackId: string, keyframe: Omit<Keyframe, 'id'>) => void
  updateKeyframe: (trackId: string, keyframeId: string, updates: Partial<Keyframe>) => void
  removeKeyframe: (trackId: string, keyframeId: string) => void
  addTrack: (track: Omit<AnimationTrack, 'id'>) => void
  updateTrack: (trackId: string, updates: Partial<AnimationTrack>) => void
  removeTrack: (trackId: string) => void
  applyAnimationPreset: (presetId: string) => void
  clearTimeline: () => void
  setTimelineDuration: (duration: number) => void
  // Animation clips
  addAnimationClip: (presetId: string, startTime: number) => void
  updateAnimationClip: (clipId: string, updates: Partial<AnimationClip>) => void
  removeAnimationClip: (clipId: string) => void
  clearAnimationClips: () => void

  // Annotations (custom SVG)
  annotations: AnnotationShape[]
  activeAnnotationTool: AnnotationToolType | null
  selectedAnnotationId: string | null
  annotationDefaults: { strokeColor: string; strokeWidth: number; fillColor: string }
  addAnnotation: (annotation: Omit<AnnotationShape, 'id'>) => void
  updateAnnotation: (id: string, updates: Partial<AnnotationShape>) => void
  removeAnnotation: (id: string) => void
  clearAnnotations: () => void
  setActiveAnnotationTool: (tool: AnnotationToolType | null) => void
  setSelectedAnnotationId: (id: string | null) => void
  setAnnotationDefaults: (
    defaults: Partial<{ strokeColor: string; strokeWidth: number; fillColor: string }>
  ) => void

  // Blur regions
  blurRegions: BlurRegion[]
  addBlurRegion: (region: Omit<BlurRegion, 'id'>) => void
  updateBlurRegion: (id: string, updates: Partial<BlurRegion>) => void
  removeBlurRegion: (id: string) => void
  clearBlurRegions: () => void

  // UI State (panel tabs live in useEditorPanels)
  reorderImageOverlay: (id: string, direction: 'up' | 'down' | 'top' | 'bottom') => void
  showTemplates: boolean
  setShowTemplates: (show: boolean) => void
  editorMode: 'screenshot' | 'browser' | 'device'
  setEditorMode: (mode: 'screenshot' | 'browser' | 'device') => void
  browserUrl: string
  setBrowserUrl: (url: string) => void
  browserHeaderSize: number
  setBrowserHeaderSize: (size: number) => void
  canvasDimensions: { canvasW: number; canvasH: number; framedW: number; framedH: number } | null
  setCanvasDimensions: (dims: {
    canvasW: number
    canvasH: number
    framedW: number
    framedH: number
  }) => void

  // Canvas visual guides
  showRulers: boolean
  showGrid: boolean
  rulerInterval: number
  toggleRulers: () => void
  toggleGrid: () => void
  setRulerInterval: (interval: number) => void

  // Layer Selection State: session-only, never in undo history
  selectedOverlayId: string | null
  isMainImageSelected: boolean
  selectedTextId: string | null
  selectedBlurId: string | null
  setSelectedOverlayId: (id: string | null) => void
  setIsMainImageSelected: (selected: boolean) => void
  /** Select a text layer; selecting one clears the image and sticker selection. */
  setSelectedTextId: (id: string | null) => void
  /** Select a redaction region. */
  setSelectedBlurId: (id: string | null) => void
}

/** Keep every slide and animation on the timeline without retaining deleted slide time. */
function slideTimelineDuration(state: ImageState, slides: ImageState['slides']): number {
  return lastingMotion(Math.max(
    slides.length ? slides.reduce((sum, slide) => sum + slide.duration * 1000, 0) : DEFAULT_TIMELINE_STATE.duration,
    ...state.animationClips.map((clip) => clip.startTime + clip.duration),
    ...state.timeline.tracks.flatMap((track) => track.keyframes.map((keyframe) => keyframe.time)),
  ), state.motion)
}

/** Resize normalized layers uniformly and reflow an active composition in the same edit. */
function resizeCanvas(state: ImageState, aspectRatio: AspectRatioKey, custom = state.customDimensions) {
  const aspect = (key: AspectRatioKey, size: ImageState['customDimensions']) => {
    const dimensions = key === 'custom' ? size : getAspectRatioPreset(key)
    return dimensions ? dimensions.width / dimensions.height : 4 / 3
  }
  const before = aspect(state.selectedAspectRatio, state.customDimensions)
  const after = aspect(aspectRatio, custom)
  const layout = compositionLayoutSchema.safeParse(state.activeDeviceLayoutId)
  return {
    selectedAspectRatio: aspectRatio,
    elements: before === after ? state.elements : state.elements.map((element) => ({
      ...element, height: element.height * after / before,
    })),
    mockups: layout.success ? arrangeScreens(state.mockups, layout.data, after) : state.mockups,
  }
}

/** Bind the primary composition screen to the selected slide, keeping custom screens. */
function slideScreens(state: ImageState, src: string | null, name: string | null) {
  const linked = state.mockups.some((mockup) => !mockup.screen.code &&
    (!mockup.screen.isCustom || mockup.screen.src === state.uploadedImageUrl))
  const firstImage = state.mockups.findIndex((mockup) => !mockup.screen.code)
  return state.mockups.map((mockup, index) => !mockup.screen.code &&
    (linked ? !mockup.screen.isCustom || mockup.screen.src === state.uploadedImageUrl : index === firstImage)
    ? { ...mockup, screen: { ...mockup.screen, src, name, isCustom: false } } : mockup)
}

const ownedBlobUrls = new Set<string>()

function trackOwnedBlobUrl(url: string): string {
  if (url.startsWith('blob:')) ownedBlobUrls.add(url)
  return url
}

function collectStateBlobUrls(
  state:
    | Partial<
        Pick<
          ImageState,
          | 'uploadedImageUrl'
          | 'backgroundConfig'
          | 'slides'
          | 'imageOverlays'
          | 'mockups'
          | 'deviceLayoutSnapshot'
          | 'motion'
        >
      >
    | undefined,
  into: Set<string>
): void {
  if (!state) return
  if (state.uploadedImageUrl?.startsWith('blob:')) into.add(state.uploadedImageUrl)
  if (state.backgroundConfig?.type === 'image' && state.backgroundConfig.value.startsWith('blob:')) {
    into.add(state.backgroundConfig.value)
  }
  for (const slide of state.slides ?? []) {
    if (slide.src.startsWith('blob:')) into.add(slide.src)
  }
  for (const overlay of state.imageOverlays ?? []) {
    if (overlay.src.startsWith('blob:')) into.add(overlay.src)
  }
  for (const mockup of state.mockups ?? []) {
    if (mockup.screen.src?.startsWith('blob:')) into.add(mockup.screen.src)
  }
  for (const mockup of state.deviceLayoutSnapshot ?? []) {
    if (mockup.screen.src?.startsWith('blob:')) into.add(mockup.screen.src)
  }
  for (const clip of state.motion?.audio ?? []) {
    if (clip.src.startsWith('blob:')) into.add(clip.src)
  }
}

/** All blob URLs currently reachable from the live editor state or undo/redo history. */
export function collectReachableBlobUrls(): Set<string> {
  const reachable = new Set<string>()
  collectStateBlobUrls(useImageStore.getState(), reachable)
  const history = useImageStore.temporal.getState()
  for (const entry of history.pastStates) collectStateBlobUrls(entry, reachable)
  for (const entry of history.futureStates) collectStateBlobUrls(entry, reachable)
  return reachable
}

/** Revoke store-created blob URLs no longer referenced by current state or undo/redo history. */
function sweepUnreferencedBlobUrls(): void {
  if (ownedBlobUrls.size === 0 || typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') {
    return
  }
  const reachable = collectReachableBlobUrls()
  for (const url of ownedBlobUrls) {
    if (!reachable.has(url)) {
      ownedBlobUrls.delete(url)
      URL.revokeObjectURL(url)
    }
  }
}

export const useImageStore = create<ImageState>()(
  temporal(
    (set, get) => ({
      ...createElementsSlice(set, get),
      ...createFramesSlice(set),
      ...createMotionSlice(set),
      slides: [],
      activeSlideId: null,

      slideshow: {
        enabled: true,
        defaultDuration: 2,
        animation: 'fade', // 'none' | 'fade' | 'slide'
      },
      setSlideshow: (updates) => {
        if (updates.defaultDuration !== undefined &&
            (!Number.isFinite(updates.defaultDuration) || updates.defaultDuration < 0.5 || updates.defaultDuration > 30)) return
        set((state) => {
          const slides = updates.defaultDuration === undefined ||
            state.slides.every((slide) => slide.duration === updates.defaultDuration) ? state.slides :
            state.slides.map((slide) => ({ ...slide, duration: updates.defaultDuration! }))
          if (slides === state.slides && Object.entries(updates).every(([key, value]) =>
            state.slideshow[key as keyof ImageState['slideshow']] === value)) return state
          return {
            slideshow: { ...state.slideshow, ...updates },
            slides,
            timeline: updates.defaultDuration === undefined ? state.timeline :
              { ...state.timeline, duration: slideTimelineDuration(state, slides) },
          }
        })
      },
      isPreviewing: false,
      previewIndex: 0,
      previewStartedAt: null,

      uploadedImageUrl: null,
      imageName: null,
      selectedGradient: 'vibrant_orange_pink',
      borderRadius: 10,
      backgroundBorderRadius: 10,
      selectedAspectRatio: '4_3',
      customDimensions: null,
      backgroundConfig: {
        type: 'image',
        value: 'backgrounds/raycast/red_distortion_4.webp',
        opacity: 1,
      },
      backgroundBlur: 0,
      backgroundNoise: 0,
      layerOrder: [],
      textOverlays: [],
      imageOverlays: [],
      mockups: [],
      activeDeviceLayoutId: null,
      deviceLayoutSnapshot: null,
      imageOpacity: 1,
      imageScale: 100,
      imageBorder: {
        enabled: false,
        width: 8,
        color: '#000000',
        type: 'none',
        padding: 20,
        title: '',
      },
      imageShadow: {
        enabled: true,
        blur: 15,
        offsetX: 5,
        offsetY: 8,
        spread: 3,
        color: 'rgba(0, 0, 0, 0.6)',
        opacity: 0.5,
      },
      imageStylePreset: 'default' as ImageStylePreset,
      shadowPreset: 'soft' as ShadowPreset,
      perspective3D: {
        perspective: 200, // em units, converted to px
        rotateX: 0,
        rotateY: 0,
        rotateZ: 0,
        translateX: 0,
        translateY: 0,
        scale: 1,
      },
      imageFilters: { ...NEUTRAL_IMAGE_FILTERS },
      imagePlacement: { ...DEFAULT_IMAGE_PLACEMENT },
      canvasPadding: DEFAULT_CANVAS_PADDING,
      pattern: { ...DEFAULT_BACKGROUND_PATTERN },
      brand: null,
      copy: null,
      exportSettings: {
        quality: '2x',
        format: 'png',
        fileName: '',
      },

      setUploadedImageUrl: (url: string | null, name: string | null = null) => {
        set({
          uploadedImageUrl: url,
          imageName: name,
        })
      },

      replaceTemplateMedia: (url, name, mockupId) => {
        set((state) => ({
          uploadedImageUrl: url,
          imageName: name,
          ...(mockupId
            ? {
                mockups: state.mockups.map((mockup) =>
                  mockup.id === mockupId
                    ? {
                        ...mockup,
                        screen: {
                          ...mockup.screen,
                          src: url,
                          name,
                          isCustom: true,
                          scale: 1,
                          offset: { x: 0, y: 0 },
                        },
                      }
                    : mockup
                ),
              }
            : {}),
        }))
      },

      setImage: (file: File) => {
        // Track image upload
        trackImageUpload('file', file.size)

        const imageUrl = trackOwnedBlobUrl(URL.createObjectURL(file))
        // Reset ALL effects to defaults when uploading a new image
        set({
          uploadedImageUrl: imageUrl,
          imageName: file.name,
          // Reset image settings
          imageScale: 100,
          imageOpacity: 1,
          borderRadius: 10,
          backgroundBorderRadius: 10,
          // Reset background
          backgroundConfig: {
            type: 'image',
            value: 'backgrounds/raycast/red_distortion_4.webp',
            opacity: 1,
          },
          backgroundBlur: 0,
          backgroundNoise: 0,
          selectedGradient: 'vibrant_orange_pink',
          // Reset shadow
          imageShadow: {
            enabled: true,
            blur: 15,
            offsetX: 5,
            offsetY: 8,
            spread: 3,
            color: 'rgba(0, 0, 0, 0.6)',
            opacity: 0.5,
          },
          // Reset border/frame
          imageBorder: {
            enabled: false,
            width: 8,
            color: '#000000',
            type: 'none',
            padding: 20,
            title: '',
          },
          imageStylePreset: 'default' as ImageStylePreset,
          shadowPreset: 'soft' as ShadowPreset,
          // Reset 3D perspective
          perspective3D: {
            perspective: 200,
            rotateX: 0,
            rotateY: 0,
            rotateZ: 0,
            translateX: 0,
            translateY: 0,
            scale: 1,
          },
          // Reset filters
          imageFilters: { ...NEUTRAL_IMAGE_FILTERS },
          imagePlacement: { ...DEFAULT_IMAGE_PLACEMENT },
          pattern: { ...DEFAULT_BACKGROUND_PATTERN },
          // Clear overlays
          textOverlays: [],
          imageOverlays: [],
          mockups: [],
          activeDeviceLayoutId: null,
          deviceLayoutSnapshot: null,
          // Reset annotations & blur
          annotations: [],
          activeAnnotationTool: null,
          blurRegions: [],
          elements: [],
          motion: emptyMotion(),
          selectedElementId: null,
          brand: null,
          copy: null,
          // Reset timeline/animation
          timeline: { ...DEFAULT_TIMELINE_STATE },
          animationClips: [],
          showTimeline: false,
        })
        sweepUnreferencedBlobUrls()
      },

      clearImage: () => {
        // A new document must not inherit the previous project's URL, fonts,
        // frame chrome, slide timing, or selection state.
        resetPlayback()
        set({ ...useImageStore.getInitialState(), canvasDimensions: get().canvasDimensions })
        sweepUnreferencedBlobUrls()
      },

      removeMainImage: () => {
        set({
          activeSlideId: null,
          imageName: null,
          isMainImageSelected: false,
          isPreviewing: false,
          previewIndex: 0,
          previewStartedAt: null,
          slides: [],
          uploadedImageUrl: null,
        })
        sweepUnreferencedBlobUrls()
      },

      setGradient: (gradient: GradientKey) => {
        set({ selectedGradient: gradient })
      },

      setBorderRadius: (radius: number) => {
        set({ borderRadius: radius })
      },
      resetSlideshow: () => {
        set({
          slides: [],
          activeSlideId: null,
          isPreviewing: false,
          previewIndex: 0,
          previewStartedAt: null,
        })
        sweepUnreferencedBlobUrls()
      },
      setBackgroundBorderRadius: (radius: number) => {
        set({ backgroundBorderRadius: radius })
      },

      setAspectRatio: (aspectRatio: AspectRatioKey) => {
        trackAspectRatioChange(aspectRatio)
        set((state) => resizeCanvas(state, aspectRatio))
      },

      setCustomDimensions: (width: number, height: number) => {
        trackAspectRatioChange('custom')
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
        set((state) => ({ ...resizeCanvas(state, 'custom', { width, height }), customDimensions: { width, height } }))
      },

      setBackgroundConfig: (config: BackgroundConfig) => {
        trackBackgroundChange(config.type, config.value as string)
        set({ backgroundConfig: config })
      },

      setBackgroundType: (type: BackgroundType) => {
        const { backgroundConfig } = get()

        // If switching to 'image' type and current value is not a valid image, set default to radiant9
        if (type === 'image') {
          const currentValue = backgroundConfig.value
          const isGradientKey = currentValue in gradientColors
          const isSolidColorKey = currentValue in solidColors
          const isValidImage =
            typeof currentValue === 'string' &&
            (currentValue.startsWith('blob:') ||
              currentValue.startsWith('http') ||
              currentValue.startsWith('data:') ||
              // Check if it's a Cloudinary public ID (contains '/' but not a gradient/solid key)
              (currentValue.includes('/') && !isGradientKey && !isSolidColorKey))

          // If current value is a gradient or solid color key, or not a valid image, set default to asset-26
          const newValue =
            isGradientKey || isSolidColorKey || !isValidImage
              ? 'backgrounds/raycast/red_distortion_4.webp'
              : currentValue

          set({
            backgroundConfig: {
              ...backgroundConfig,
              type,
              value: newValue,
            },
          })
        } else {
          set({
            backgroundConfig: {
              ...backgroundConfig,
              type,
            },
          })
        }
      },

      setBackgroundValue: (value: string) => {
        const { backgroundConfig } = get()
        set({
          backgroundConfig: {
            ...backgroundConfig,
            value,
          },
        })
      },

      setBackgroundOpacity: (opacity: number) => {
        const { backgroundConfig } = get()
        set({
          backgroundConfig: {
            ...backgroundConfig,
            opacity,
          },
        })
      },

      setBackgroundBlur: (blur: number) => {
        set({ backgroundBlur: blur })
      },

      setBackgroundNoise: (noise: number) => {
        set({ backgroundNoise: noise })
      },

      addTextOverlay: (
        overlay = {
          text: 'Text',
          position: { x: 50, y: 50 },
          fontSize: 32,
          fontWeight: 'normal',
          fontFamily: 'inter',
          color: '#171717',
          opacity: 1,
          isVisible: true,
          orientation: 'horizontal',
          textShadow: {
            enabled: true,
            color: 'rgba(255, 255, 255, 0.8)',
            blur: 4,
            offsetX: 2,
            offsetY: 2,
          },
        }
      ) => {
        trackOverlayAdd('text')
        const id = `text-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
        set((state) => ({
          textOverlays: [...state.textOverlays, { ...overlay, id }],
          layerOrder: [...orderedLayerIds(state), id],
        }))
        return id
      },

      updateTextOverlay: (id, updates) => {
        set((state) => ({
          textOverlays: state.textOverlays.map((overlay) =>
            overlay.id === id ? { ...overlay, ...updates } : overlay
          ),
        }))
      },

      removeTextOverlay: (id) => {
        set((state) => ({
          textOverlays: state.textOverlays.filter((overlay) => overlay.id !== id),
        }))
      },

      clearTextOverlays: () => {
        set({ textOverlays: [] })
      },

      addImageOverlay: (overlay) => {
        trackOverlayAdd('sticker')
        const id = `overlay-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
        set((state) => ({
          imageOverlays: [...state.imageOverlays, { blur: 0, ...overlay, id }],
          layerOrder: [...orderedLayerIds(state), id],
          selectedOverlayId: id,
          selectedTextId: null,
          selectedElementId: null,
          isMainImageSelected: false,
        }))
      },

      updateImageOverlay: (id, updates) => {
        set((state) => ({
          ...(updates.layer ? { layerOrder: moveLayer(orderedLayerIds(state), id, updates.layer === 'back' ? 'bottom' : 'top') } : {}),
          imageOverlays: state.imageOverlays.map((overlay) =>
            overlay.id === id ? { ...overlay, ...updates } : overlay
          ),
        }))
      },

      removeImageOverlay: (id) => {
        set((state) => ({
          imageOverlays: state.imageOverlays.filter((overlay) => overlay.id !== id),
        }))
      },

      clearImageOverlays: () => {
        set({ imageOverlays: [] })
      },

      reorderImageOverlay: (id, direction) => {
        set((state) => {
          const overlays = [...state.imageOverlays]
          const index = overlays.findIndex((o) => o.id === id)
          if (index === -1) return state

          let newIndex: number
          switch (direction) {
            case 'up':
              newIndex = Math.min(overlays.length - 1, index + 1)
              break
            case 'down':
              newIndex = Math.max(0, index - 1)
              break
            case 'top':
              newIndex = overlays.length - 1
              break
            case 'bottom':
              newIndex = 0
              break
          }

          const [item] = overlays.splice(index, 1)
          overlays.splice(newIndex, 0, item)
          return { imageOverlays: overlays, layerOrder: moveLayer(orderedLayerIds(state), id, direction) }
        })
      },

      addMockup: (mockup) => {
        if (get().mockups.length >= MAX_DEVICE_MOCKUPS) return null
        const id = `mockup-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
        set((state) => ({
          mockups: [...state.mockups, { ...mockup, id }],
          layerOrder: [...orderedLayerIds(state), id],
          activeDeviceLayoutId: null,
          deviceLayoutSnapshot: null,
        }))
        return id
      },

      updateMockup: (id, updates) => {
        set((state) => ({
          mockups: state.mockups.map((mockup) =>
            mockup.id === id ? { ...mockup, ...updates } : mockup
          ),
        }))
      },

      removeMockup: (id) => {
        set((state) => {
          const remaining = state.mockups.filter((mockup) => mockup.id !== id)
          const layout = compositionLayoutSchema.safeParse(state.activeDeviceLayoutId)
          const size = state.selectedAspectRatio === 'custom' ? state.customDimensions : getAspectRatioPreset(state.selectedAspectRatio)
          return {
            mockups: layout.success ? arrangeScreens(remaining, layout.data, size ? size.width / size.height : 4 / 3) : remaining,
            deviceLayoutSnapshot: null,
          }
        })
      },

      clearMockups: () => {
        set({ mockups: [], activeDeviceLayoutId: null, deviceLayoutSnapshot: null })
      },

      duplicateMockup: (id) => {
        const state = get()
        if (state.mockups.length >= MAX_DEVICE_MOCKUPS) return null
        const source = state.mockups.find((mockup) => mockup.id === id)
        if (!source) return null
        const duplicateId = `mockup-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
        set({
          mockups: [
            ...state.mockups,
            {
              ...source,
              id: duplicateId,
              position: {
                x: Math.min(0.92, source.position.x + 0.04),
                y: Math.min(0.92, source.position.y + 0.04),
              },
              screen: { ...source.screen, offset: { ...source.screen.offset } },
            },
          ],
          activeDeviceLayoutId: null,
          deviceLayoutSnapshot: null,
        })
        return duplicateId
      },

      reorderMockup: (id, direction) => {
        set((state) => {
          const mockups = [...state.mockups]
          const index = mockups.findIndex((mockup) => mockup.id === id)
          if (index === -1) return state
          const target =
            direction === 'top'
              ? mockups.length - 1
              : direction === 'bottom'
                ? 0
                : direction === 'up'
                  ? Math.min(mockups.length - 1, index + 1)
                  : Math.max(0, index - 1)
          if (target === index) return state
          const [mockup] = mockups.splice(index, 1)
          mockups.splice(target, 0, mockup)
          return { mockups }
        })
      },

      applyDeviceLayout: (layoutId) => {
        const layout = getDeviceLayout(layoutId)
        if (!layout) return
        const state = get()
        if (state.mockups.length > layout.slots.length) return
        const fallbackScreen =
          state.mockups[0]?.screen ?? createDeviceScreen(state.uploadedImageUrl, state.imageName)
        set({
          mockups: applyLayoutToMockups(state.mockups, layout, fallbackScreen),
          activeDeviceLayoutId: layoutId,
          deviceLayoutSnapshot: state.activeDeviceLayoutId
            ? state.deviceLayoutSnapshot
            : cloneMockups(state.mockups),
        })
      },

      clearDeviceLayout: () => {
        set((state) => {
          const snapshot = state.deviceLayoutSnapshot
          if (!snapshot) {
            return { activeDeviceLayoutId: null, deviceLayoutSnapshot: null }
          }

          return {
            mockups: restoreMockupsFromLayoutSnapshot(snapshot, state.mockups),
            activeDeviceLayoutId: null,
            deviceLayoutSnapshot: null,
          }
        })
      },

      setImageOpacity: (opacity: number) => {
        set({ imageOpacity: opacity })
      },

      setImageScale: (scale: number) => {
        set({ imageScale: scale })
      },

      setImageBorder: (border: ImageBorder | Partial<ImageBorder>) => {
        const currentBorder = get().imageBorder
        // Track frame changes
        if ('type' in border && border.type && border.type !== currentBorder.type) {
          trackFrameApply(border.type)
        }
        set({
          imageBorder: {
            ...currentBorder,
            ...border,
          },
        })
      },

      setImageShadow: (shadow: ImageShadow | Partial<ImageShadow>) => {
        const currentShadow = get().imageShadow
        set({
          imageShadow: {
            ...currentShadow,
            ...shadow,
          },
        })
      },

      setImageStylePreset: (preset: ImageStylePreset) => {
        const borderMap: Record<ImageStylePreset, Partial<ImageBorder>> = {
          default: { enabled: false, type: 'none' },
          'glass-light': { enabled: true, type: 'glass-light', opacity: 0.25, padding: 1 },
          'glass-dark': { enabled: true, type: 'glass-dark', opacity: 0.7, padding: 1 },
          outline: { enabled: true, type: 'outline-light', opacity: 0.35, padding: 0.5 },
          'border-light': { enabled: true, type: 'border-light', padding: 1 },
          'border-dark': { enabled: true, type: 'border-dark', padding: 1 },
        }
        const currentBorder = get().imageBorder
        set({
          imageStylePreset: preset,
          imageBorder: { ...currentBorder, ...borderMap[preset] },
        })
      },

      setShadowPreset: (preset: ShadowPreset) => {
        const shadowMap: Record<ShadowPreset, ImageShadow> = {
          none: {
            enabled: false,
            blur: 0,
            offsetX: 0,
            offsetY: 0,
            spread: 0,
            color: 'rgba(0,0,0,0.6)',
            opacity: 0,
          },
          hug: {
            enabled: true,
            blur: 10,
            offsetX: 0,
            offsetY: 2,
            spread: 0,
            color: 'rgba(0,0,0,0.6)',
            opacity: 0.25,
          },
          soft: {
            enabled: true,
            blur: 30,
            offsetX: 0,
            offsetY: 12,
            spread: 5,
            color: 'rgba(0,0,0,0.6)',
            opacity: 0.5,
          },
          strong: {
            enabled: true,
            blur: 60,
            offsetX: 0,
            offsetY: 24,
            spread: 10,
            color: 'rgba(0,0,0,0.6)',
            opacity: 0.8,
          },
        }
        set({
          shadowPreset: preset,
          imageShadow: shadowMap[preset],
        })
      },

      applyVisualPreset: (preset, options = {}) => {
        trackPresetApply(preset.id, preset.name)
        const shouldUseDemoMedia = !get().uploadedImageUrl

        set((state) => {
          const mediaUrl = state.uploadedImageUrl ?? TEMPLATE_DEMO_IMAGE_URL
          const mediaName = state.imageName ?? TEMPLATE_DEMO_IMAGE_NAME
          const retainedOverlays = state.imageOverlays.filter(
            (overlay) =>
              !(typeof overlay.src === 'string' && overlay.src.includes('overlay-shadow'))
          )
          const templateShadow: ImageOverlay[] = preset.shadowOverlay
            ? [
                {
                  id: `template-shadow-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                  src: preset.shadowOverlay.src,
                  position: { x: 0, y: 0 },
                  size: 100,
                  rotation: 0,
                  opacity: preset.shadowOverlay.opacity,
                  flipX: false,
                  flipY: false,
                  isVisible: true,
                },
              ]
            : []
          const templateMockups =
            options.scene?.kind === 'device'
              ? options.scene.devices.map((device, index) => ({
                  ...createMockup(
                    device.definitionId,
                    createDeviceScreen(mediaUrl, mediaName),
                    index
                  ),
                  position: { ...device.position },
                  size: device.size,
                  rotation: device.rotation,
                }))
              : []

          return {
            ...(shouldUseDemoMedia
              ? {
                  uploadedImageUrl: TEMPLATE_DEMO_IMAGE_URL,
                  imageName: TEMPLATE_DEMO_IMAGE_NAME,
                }
              : {}),
            ...resizeCanvas(state, preset.aspectRatio),
            backgroundConfig: preset.backgroundConfig,
            borderRadius: preset.borderRadius,
            backgroundBorderRadius: preset.backgroundBorderRadius,
            backgroundBlur: preset.backgroundBlur ?? 0,
            backgroundNoise: preset.backgroundNoise ?? 0,
            imageOpacity: preset.imageOpacity,
            imageScale: preset.imageScale,
            imageStylePreset: getImageStylePreset(preset.imageBorder),
            imageBorder: preset.imageBorder,
            imageShadow: preset.imageShadow,
            imageOverlays: [...retainedOverlays, ...templateShadow],
            perspective3D: preset.perspective3D ?? {
              perspective: DEFAULT_ANIMATABLE_PROPERTIES.perspective,
              rotateX: DEFAULT_ANIMATABLE_PROPERTIES.rotateX,
              rotateY: DEFAULT_ANIMATABLE_PROPERTIES.rotateY,
              rotateZ: DEFAULT_ANIMATABLE_PROPERTIES.rotateZ,
              translateX: DEFAULT_ANIMATABLE_PROPERTIES.translateX,
              translateY: DEFAULT_ANIMATABLE_PROPERTIES.translateY,
              scale: DEFAULT_ANIMATABLE_PROPERTIES.scale,
            },
            ...(options.scene && state.mockups.length === 0
              ? {
                  editorMode:
                    options.scene.kind === 'device' ? ('device' as const) : ('screenshot' as const),
                  mockups: templateMockups,
                  activeDeviceLayoutId: null,
                  deviceLayoutSnapshot: null,
                }
              : {}),
            ...(options.clearAnimation
              ? {
                  animationClips: [],
                  timeline: { ...DEFAULT_TIMELINE_STATE, duration: lastingMotion(DEFAULT_TIMELINE_STATE.duration, state.motion) },
                  showTimeline: false,
                }
              : {}),
            ...(options.closeTemplates ? { showTemplates: false } : {}),
            // In the same write, so a template is one undo step.
            ...(options.scene?.kind === 'screenshot'
              ? { imagePlacement: { ...(options.scene.placement ?? DEFAULT_IMAGE_PLACEMENT) } }
              : {}),
          }
        })
      },

      applyAnimatedTemplate: (templateId) => {
        const template = getAnimatedTemplateById(templateId)
        if (!template) return

        const imageTemplate = getImageTemplateById(template.visualPresetId)
        const visualPreset =
          imageTemplate?.preset ??
          visualPresets.find((preset) => preset.id === template.visualPresetId)
        const animation = buildAnimatedTemplateTimeline(template)
        if (!visualPreset || !animation) return
        const templateImageBorder =
          template.imageStylePreset === 'default'
            ? { ...visualPreset.imageBorder, enabled: false, type: 'none' as const }
            : visualPreset.imageBorder

        trackPresetApply(`animated:${template.id}`, template.name)
        const shouldUseDemoMedia = !get().uploadedImageUrl

        set((state) => {
          const retainedOverlays = state.imageOverlays.filter(
            (overlay) =>
              !(typeof overlay.src === 'string' && overlay.src.includes('overlay-shadow'))
          )
          const templateShadow: ImageOverlay[] = visualPreset.shadowOverlay
            ? [
                {
                  id: `template-shadow-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                  src: visualPreset.shadowOverlay.src,
                  position: { x: 0, y: 0 },
                  size: 100,
                  rotation: 0,
                  opacity: visualPreset.shadowOverlay.opacity,
                  flipX: false,
                  flipY: false,
                  isVisible: true,
                },
              ]
            : []

          return {
            ...(shouldUseDemoMedia
              ? {
                  uploadedImageUrl: TEMPLATE_DEMO_IMAGE_URL,
                  imageName: TEMPLATE_DEMO_IMAGE_NAME,
                }
              : {}),
            ...resizeCanvas(state, visualPreset.aspectRatio),
            backgroundConfig: visualPreset.backgroundConfig,
            borderRadius: visualPreset.borderRadius,
            backgroundBorderRadius: visualPreset.backgroundBorderRadius,
            backgroundBlur: visualPreset.backgroundBlur ?? 0,
            backgroundNoise: visualPreset.backgroundNoise ?? 0,
            imageOpacity: visualPreset.imageOpacity,
            imageScale: visualPreset.imageScale,
            imageStylePreset: getImageStylePreset(templateImageBorder),
            imageBorder: templateImageBorder,
            imageShadow: visualPreset.imageShadow,
            imageOverlays: [...retainedOverlays, ...templateShadow],
            perspective3D: visualPreset.perspective3D ?? {
              perspective: DEFAULT_ANIMATABLE_PROPERTIES.perspective,
              rotateX: DEFAULT_ANIMATABLE_PROPERTIES.rotateX,
              rotateY: DEFAULT_ANIMATABLE_PROPERTIES.rotateY,
              rotateZ: DEFAULT_ANIMATABLE_PROPERTIES.rotateZ,
              translateX: DEFAULT_ANIMATABLE_PROPERTIES.translateX,
              translateY: DEFAULT_ANIMATABLE_PROPERTIES.translateY,
              scale: DEFAULT_ANIMATABLE_PROPERTIES.scale,
            },
            editorMode: state.mockups.length ? state.editorMode : 'screenshot' as const,
            activeDeviceLayoutId: state.activeDeviceLayoutId,
            deviceLayoutSnapshot: null,
            animationClips: [animation.clip],
            timeline: {
              ...DEFAULT_TIMELINE_STATE,
              duration: lastingMotion(animation.duration, state.motion),
              tracks: animation.tracks,
            },
            showTimeline: true,
            showTemplates: false,
            // In the same write, so a template is one undo step.
            imagePlacement: {
              ...((imageTemplate?.scene.kind === 'screenshot' ? imageTemplate.scene.placement : undefined) ??
                DEFAULT_IMAGE_PLACEMENT),
            },
          }
        })
        resetPlayback({ play: true })
      },

      setPerspective3D: (perspective: Partial<ImageState['perspective3D']>) => {
        const currentPerspective = get().perspective3D
        set({
          perspective3D: {
            ...currentPerspective,
            ...perspective,
          },
        })
      },

      setImageFilter: (key: keyof ImageFilters, value: number) => {
        const currentFilters = get().imageFilters
        set({
          imageFilters: {
            ...currentFilters,
            [key]: value,
          },
        })
      },

      resetImageFilters: () => {
        set({
          imageFilters: { ...NEUTRAL_IMAGE_FILTERS },
        })
      },

      setImagePlacement: (placement) => {
        set((state) => ({ imagePlacement: {
          ...state.imagePlacement,
          ...((placement.offsetX !== undefined || placement.offsetY !== undefined) ? { anchor: undefined } : {}),
          ...placement,
        } }))
      },

      setCanvasPadding: (padding) => {
        set({ canvasPadding: Math.max(0, padding) })
      },

      setPattern: (pattern) => {
        set((state) => ({ pattern: { ...state.pattern, ...pattern } }))
      },

      setBrand: (brand) => set({ brand }),

      setCopy: (copy) => set({ copy }),

      resetCanvasSettings: () => {
        set({
          imageScale: 100,
          imageOpacity: 1,
          borderRadius: 10,
          backgroundBorderRadius: 10,
          backgroundConfig: {
            type: 'image',
            value: 'backgrounds/raycast/red_distortion_4.webp',
            opacity: 1,
          },
          backgroundBlur: 0,
          backgroundNoise: 0,
          selectedGradient: 'vibrant_orange_pink',
          imageShadow: {
            enabled: true,
            blur: 15,
            offsetX: 5,
            offsetY: 8,
            spread: 3,
            color: 'rgba(0, 0, 0, 0.6)',
            opacity: 0.5,
          },
          imageBorder: {
            enabled: false,
            width: 8,
            color: '#000000',
            type: 'none',
            padding: 20,
            title: '',
          },
          imageStylePreset: 'default' as ImageStylePreset,
          shadowPreset: 'soft' as ShadowPreset,
          perspective3D: {
            perspective: 200,
            rotateX: 0,
            rotateY: 0,
            rotateZ: 0,
            translateX: 0,
            translateY: 0,
            scale: 1,
          },
          imageFilters: { ...NEUTRAL_IMAGE_FILTERS },
          imagePlacement: { ...DEFAULT_IMAGE_PLACEMENT },
          canvasPadding: DEFAULT_CANVAS_PADDING,
          pattern: { ...DEFAULT_BACKGROUND_PATTERN },
          textOverlays: [],
          imageOverlays: [],
          mockups: [],
          activeDeviceLayoutId: null,
          deviceLayoutSnapshot: null,
          annotations: [],
          activeAnnotationTool: null,
          blurRegions: [],
          elements: [],
          motion: emptyMotion(),
          selectedElementId: null,
          brand: null,
          copy: null,
          timeline: { ...DEFAULT_TIMELINE_STATE },
          animationClips: [],
          showTimeline: false,
        })
      },

      setExportSettings: (settings: Partial<ImageState['exportSettings']>) => {
        const currentSettings = get().exportSettings
        set({
          exportSettings: {
            ...currentSettings,
            ...settings,
          },
        })
      },

      addImages: (files: File[]) => {
        const { slides, slideshow, timeline, uploadedImageUrl, imageName } = get()

        const newSlides = files.map((file) => ({
          id: `slide-${crypto.randomUUID()}`,
          src: trackOwnedBlobUrl(URL.createObjectURL(file)),
          name: file.name,
          duration: Number.isFinite(slideshow.defaultDuration) && slideshow.defaultDuration >= 0.5 && slideshow.defaultDuration <= 30 ? slideshow.defaultDuration : 3,
        }))

        const existing = slides.length || !uploadedImageUrl ? slides : [{
          id: `slide-${crypto.randomUUID()}`, src: uploadedImageUrl,
          name: imageName ?? 'Screenshot', duration: Number.isFinite(slideshow.defaultDuration) && slideshow.defaultDuration >= 0.5 && slideshow.defaultDuration <= 30 ? slideshow.defaultDuration : 3,
        }]
        const allSlides = [...existing, ...newSlides]
        const activeSlide = allSlides.find((slide) => slide.id === get().activeSlideId) ?? allSlides[0]

        // Calculate total slideshow duration based on slides and their durations
        const newTimelineDuration = Math.max(timeline.duration, slideTimelineDuration(get(), allSlides))

        set({
          slides: allSlides,
          activeSlideId: activeSlide?.id ?? null,
          uploadedImageUrl: activeSlide?.src ?? null,
          imageName: activeSlide?.name ?? null,
          // Extend timeline to fit all slides
          timeline: {
            ...timeline,
            duration: newTimelineDuration,
          },
        })
      },

      setActiveSlide: (id: string) => {
        const slide = get().slides.find((s) => s.id === id)
        if (!slide) return

        const history = useImageStore.temporal.getState()
        const tracking = history.isTracking
        if (tracking) history.pause()
        try {
          set({ activeSlideId: id, uploadedImageUrl: slide.src, imageName: slide.name, mockups: slideScreens(get(), slide.src, slide.name) })
        } finally {
          if (tracking) history.resume()
        }
      },

      removeSlide: (id) => {
        const { slides, activeSlideId } = get()
        const remaining = slides.filter((s) => s.id !== id)
        if (remaining.length === slides.length) return
        const nextActive = activeSlideId === id ? (remaining[0]?.id ?? null) : activeSlideId
        const nextSlide = remaining.find((s) => s.id === nextActive)

        set({
          slides: remaining,
          mockups: slideScreens(get(), nextSlide?.src ?? null, nextSlide?.name ?? null),
          activeSlideId: nextActive,
          uploadedImageUrl: nextSlide?.src ?? null,
          imageName: nextSlide?.name ?? null,
          timeline: { ...get().timeline, duration: slideTimelineDuration(get(), remaining) },
        })
        usePlaybackStore.getState().pause()
        usePlaybackStore.getState().seek(usePlaybackStore.getState().playhead)
        sweepUnreferencedBlobUrls()
      },

      startPreview: () => {
        if (!get().slides.length) return
        set({
          isPreviewing: true,
          previewIndex: 0,
          previewStartedAt: Date.now(),
        })
      },

      stopPreview: () => {
        set({
          isPreviewing: false,
          previewIndex: 0,
          previewStartedAt: null,
        })
      },

      // Timeline / Animation state
      timeline: { ...DEFAULT_TIMELINE_STATE },
      showTimeline: false,
      animationClips: [],

      setTimeline: (updates) => {
        set((state) => ({
          timeline: { ...state.timeline, ...updates },
        }))
      },

      setShowTimeline: (show) => {
        set({ showTimeline: show })
      },

      toggleTimeline: () => {
        set((state) => ({ showTimeline: !state.showTimeline }))
      },

      addKeyframe: (trackId, keyframe) => {
        const id = `kf-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
        set((state) => ({
          timeline: {
            ...state.timeline,
            tracks: state.timeline.tracks.map((track) =>
              track.id === trackId
                ? { ...track, keyframes: [...track.keyframes, { ...keyframe, id }] }
                : track
            ),
          },
        }))
      },

      updateKeyframe: (trackId, keyframeId, updates) => {
        set((state) => ({
          timeline: {
            ...state.timeline,
            tracks: state.timeline.tracks.map((track) =>
              track.id === trackId
                ? {
                    ...track,
                    keyframes: track.keyframes.map((kf) =>
                      kf.id === keyframeId ? { ...kf, ...updates } : kf
                    ),
                  }
                : track
            ),
          },
        }))
      },

      removeKeyframe: (trackId, keyframeId) => {
        set((state) => ({
          timeline: {
            ...state.timeline,
            tracks: state.timeline.tracks.map((track) =>
              track.id === trackId
                ? { ...track, keyframes: track.keyframes.filter((kf) => kf.id !== keyframeId) }
                : track
            ),
          },
        }))
      },

      addTrack: (track) => {
        const id = `track-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
        set((state) => ({
          timeline: {
            ...state.timeline,
            tracks: [...state.timeline.tracks, { ...track, id }],
          },
        }))
      },

      updateTrack: (trackId, updates) => {
        set((state) => ({
          timeline: {
            ...state.timeline,
            tracks: state.timeline.tracks.map((track) =>
              track.id === trackId ? { ...track, ...updates } : track
            ),
          },
        }))
      },

      removeTrack: (trackId) => {
        set((state) => ({
          timeline: {
            ...state.timeline,
            tracks: state.timeline.tracks.filter((track) => track.id !== trackId),
          },
        }))
      },

      applyAnimationPreset: (presetId) => {
        const preset = getPresetById(presetId)
        if (!preset) return

        const tracks = clonePresetTracks(preset)
        set((state) => ({
          timeline: {
            ...state.timeline,
            duration: lastingMotion(preset.duration, state.motion),
            tracks,
          },
        }))
        resetPlayback()
      },

      clearTimeline: () => {
        set((state) => ({
          timeline: { ...DEFAULT_TIMELINE_STATE, duration: lastingMotion(DEFAULT_TIMELINE_STATE.duration, state.motion) },
        }))
      },

      setTimelineDuration: (duration) => {
        set((state) => {
          const newDuration = Math.max(500, duration)
          // Clamp animation clips to fit within the new duration
          const clampedClips = state.animationClips.map((clip) => {
            // Ensure clip doesn't extend beyond new duration
            const maxStartTime = Math.max(0, newDuration - 200) // Minimum clip duration of 200ms
            const clampedStart = Math.min(clip.startTime, maxStartTime)
            const maxDuration = newDuration - clampedStart
            const clampedDuration = Math.min(clip.duration, maxDuration)
            return {
              ...clip,
              startTime: clampedStart,
              duration: Math.max(200, clampedDuration),
            }
          })
          return {
            animationClips: clampedClips,
            timeline: {
              ...state.timeline,
              duration: newDuration,
            },
          }
        })
        usePlaybackStore.getState().seek(usePlaybackStore.getState().playhead)
      },

      // Animation clips
      addAnimationClip: (presetId, startTime) => {
        const preset = ANIMATION_PRESETS.find((p) => p.id === presetId)
        if (!preset) return

        trackAnimationClipAdd(presetId, preset.name, preset.duration)

        const id = `clip-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
        // Brand-matching green color palette
        const colors = ['#c9ff2e', '#10B981', '#22c55e', '#84cc16', '#34d399']
        const color = colors[Math.floor(Math.random() * colors.length)]

        const newClip: AnimationClip = {
          id,
          presetId,
          name: preset.name,
          startTime,
          duration: preset.duration,
          color,
        }

        // Clone preset tracks with startTime offset and link to clip
        const tracks = clonePresetTracks(preset, { startTime, clipId: id })

        set((state) => ({
          animationClips: [...state.animationClips, newClip],
          timeline: {
            ...state.timeline,
            tracks: [...state.timeline.tracks, ...tracks],
          },
          showTimeline: true,
        }))
      },

      updateAnimationClip: (clipId, updates) => {
        set((state) => {
          const existingClip = state.animationClips.find((c) => c.id === clipId)
          if (!existingClip) return state

          const newClip = { ...existingClip, ...updates }

          // If startTime or duration changed, update the corresponding track keyframes
          const startTimeChanged =
            updates.startTime !== undefined && updates.startTime !== existingClip.startTime
          const durationChanged =
            updates.duration !== undefined && updates.duration !== existingClip.duration

          let updatedTracks = state.timeline.tracks

          if (startTimeChanged || durationChanged) {
            updatedTracks = state.timeline.tracks.map((track) => {
              if (track.clipId !== clipId) return track

              const newStartTime = updates.startTime ?? existingClip.startTime
              const newDuration = updates.duration ?? existingClip.duration
              const oldStartTime = existingClip.startTime

              // Calculate time scaling factor if duration changed
              const scaleFactor = durationChanged ? newDuration / existingClip.duration : 1

              return {
                ...track,
                keyframes: track.keyframes.map((kf) => {
                  // First, get the relative time within the clip (remove old startTime offset)
                  const relativeTime = kf.time - oldStartTime
                  // Scale the relative time if duration changed
                  const scaledRelativeTime = relativeTime * scaleFactor
                  // Add the new start time offset
                  const newTime = scaledRelativeTime + newStartTime

                  return {
                    ...kf,
                    time: Math.max(0, newTime),
                  }
                }),
              }
            })
          }

          return {
            animationClips: state.animationClips.map((clip) =>
              clip.id === clipId ? newClip : clip
            ),
            timeline: {
              ...state.timeline,
              tracks: updatedTracks,
            },
          }
        })
      },

      removeAnimationClip: (clipId) => {
        set((state) => ({
          animationClips: state.animationClips.filter((clip) => clip.id !== clipId),
          timeline: {
            ...state.timeline,
            // Remove tracks associated with this clip
            tracks: state.timeline.tracks.filter((track) => track.clipId !== clipId),
          },
        }))
      },

      clearAnimationClips: () => {
        set((state) => ({
          animationClips: [],
          // Keyframes, reveals, scrolls, and captions stay, so the timeline still holds them.
          timeline: {
            ...DEFAULT_TIMELINE_STATE,
            duration: lastingMotion(DEFAULT_TIMELINE_STATE.duration, state.motion),
          },
        }))
      },

      // Annotations (custom SVG)
      annotations: [],
      activeAnnotationTool: null,
      selectedAnnotationId: null,
      annotationDefaults: { strokeColor: '#ef4444', strokeWidth: 6, fillColor: 'transparent' },
      addAnnotation: (annotation) => {
        const id = `ann-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
        set((state) => ({
          annotations: [...state.annotations, { ...annotation, id }],
          layerOrder: [...orderedLayerIds(state), id],
          selectedAnnotationId: id,
        }))
      },
      updateAnnotation: (id, updates) => {
        set((state) => ({
          annotations: state.annotations.map((a) => (a.id === id ? { ...a, ...updates } : a)),
        }))
      },
      removeAnnotation: (id) => {
        set((state) => ({
          annotations: state.annotations.filter((a) => a.id !== id),
          selectedAnnotationId:
            state.selectedAnnotationId === id ? null : state.selectedAnnotationId,
        }))
      },
      clearAnnotations: () => set({ annotations: [], selectedAnnotationId: null }),
      setActiveAnnotationTool: (tool) => set({ activeAnnotationTool: tool }),
      setSelectedAnnotationId: (id) => set({ selectedAnnotationId: id }),
      setAnnotationDefaults: (defaults) => {
        set((state) => ({
          annotationDefaults: { ...state.annotationDefaults, ...defaults },
        }))
      },

      // Blur regions
      blurRegions: [],
      addBlurRegion: (region) => {
        const id = `blur-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
        set((state) => ({
          blurRegions: [...state.blurRegions, { ...region, id }],
          layerOrder: [...orderedLayerIds(state), id],
        }))
      },
      updateBlurRegion: (id, updates) => {
        set((state) => ({
          blurRegions: state.blurRegions.map((r) => (r.id === id ? { ...r, ...updates } : r)),
        }))
      },
      removeBlurRegion: (id) => {
        set((state) => ({
          blurRegions: state.blurRegions.filter((r) => r.id !== id),
        }))
      },
      clearBlurRegions: () => set({ blurRegions: [] }),

      // UI State
      showTemplates: false,
      setShowTemplates: (show) => {
        set({ showTemplates: show })
      },
      editorMode: 'screenshot',
      setEditorMode: (mode) => {
        const currentBorder = get().imageBorder
        const currentUrl = get().browserUrl || 'shots.playbookmedia.io'
        if (mode === 'browser') {
          // Apply the default browser frame if no browser or window frame is active
          const isBrowserFrame = isChromeFrameType(currentBorder.type)
          set({
            editorMode: mode,
            imageBorder: {
              ...currentBorder,
              enabled: true,
              type: isBrowserFrame ? currentBorder.type : 'browser',
              title: currentUrl,
            },
          })
        } else {
          // Switching back to screenshot: disable browser frame
          const isBrowserFrame = isChromeFrameType(currentBorder.type)
          if (isBrowserFrame) {
            set({
              editorMode: mode,
              imageBorder: {
                ...currentBorder,
                enabled: false,
                type: 'none',
              },
            })
            return
          }
          set({ editorMode: mode })
        }
      },
      browserUrl: 'shots.playbookmedia.io',
      setBrowserUrl: (url) => {
        const currentBorder = get().imageBorder
        set({
          browserUrl: url,
          imageBorder: { ...currentBorder, title: url },
        })
      },
      browserHeaderSize: 100,
      setBrowserHeaderSize: (size) => {
        set({ browserHeaderSize: size })
      },
      canvasDimensions: null,
      setCanvasDimensions: (dims) => {
        set({ canvasDimensions: dims })
      },

      showRulers: false,
      showGrid: false,
      rulerInterval: 100,
      toggleRulers: () => set((state) => ({ showRulers: !state.showRulers })),
      toggleGrid: () => set((state) => ({ showGrid: !state.showGrid })),
      setRulerInterval: (interval) =>
        set({ rulerInterval: Math.max(1, Math.round(Number.isFinite(interval) ? interval : 100)) }),

      selectedOverlayId: null,
      isMainImageSelected: false,
      selectedTextId: null,
      selectedBlurId: null,
      setSelectedTextId: (id) =>
        set(() => ({
          selectedTextId: id,
          ...(id
            ? {
                isMainImageSelected: false,
                selectedAnnotationId: null,
                selectedElementId: null,
                selectedOverlayId: null,
              }
            : {}),
        })),
      setSelectedBlurId: (id) => set({ selectedBlurId: id }),
      setSelectedOverlayId: (id: string | null) =>
        set((state) => ({
          selectedOverlayId: id,
          isMainImageSelected: id ? false : state.isMainImageSelected,
          selectedElementId: id ? null : state.selectedElementId,
        })),
      setIsMainImageSelected: (selected: boolean) =>
        set((state) => ({
          isMainImageSelected: selected,
          selectedOverlayId: selected ? null : state.selectedOverlayId,
          selectedElementId: selected ? null : state.selectedElementId,
        })),
    }),
    {
      // Layout measurements change on mount/resize and must not erase redo history.
      partialize: ({
        selectedOverlayId: _overlay,
        isMainImageSelected: _main,
        selectedTextId: _text,
        selectedBlurId: _blur,
        selectedAnnotationId: _annotation,
        selectedElementId: _element,
        activeAnnotationTool: _tool,
        canvasDimensions: _dimensions,
        showTemplates: _templates,
        showTimeline: _timeline,
        showRulers: _rulers,
        showGrid: _grid,
        rulerInterval: _rulerInterval,
        isPreviewing: _previewing,
        previewIndex: _previewIndex,
        previewStartedAt: _previewStartedAt,
        ...state
      }) => state,
      equality: shallow,
      limit: HISTORY_LIMIT,
      handleSet: (handleSet) => (pastState, replace) => {
        if (historyGesture.active) {
          if (historyGesture.recorded) return
          historyGesture.recorded = true
        }
        handleSet(pastState, replace)
      },
    }
  )
)

// Selection is transient: deleting, resetting, restoring, or undoing layers must
// never leave controls or keyboard shortcuts targeting a removed image.
useImageStore.subscribe((state, previous) => {
  if (state.activeSlideId !== previous.activeSlideId || state.slides !== previous.slides) {
    const index = state.slides.findIndex((slide) => slide.id === state.activeSlideId)
    if (index >= 0) {
      const start = state.slides.slice(0, index).reduce((sum, slide) => sum + slide.duration * 1000, 0)
      const time = usePlaybackStore.getState().playhead
      if (time < start || time >= start + state.slides[index].duration * 1000) {
        usePlaybackStore.getState().seek(start)
      }
    }
  }
  if (
    state.selectedOverlayId &&
    !state.imageOverlays.some((overlay) => overlay.id === state.selectedOverlayId)
  ) {
    state.setSelectedOverlayId(null)
  }
  if (state.isMainImageSelected && !state.uploadedImageUrl) {
    state.setIsMainImageSelected(false)
  }
  if (state.selectedTextId && !state.textOverlays.some((text) => text.id === state.selectedTextId)) {
    state.setSelectedTextId(null)
  }
  if (state.selectedBlurId && !state.blurRegions.some((region) => region.id === state.selectedBlurId)) {
    state.setSelectedBlurId(null)
  }
  if (state.selectedElementId && !state.elements.some((element) => element.id === state.selectedElementId)) {
    state.setSelectedElementId(null)
  }
})

// Sweep store-owned blob URLs whenever undo/redo history trims or clears evicted snapshots.
useImageStore.temporal.subscribe(() => {
  sweepUnreferencedBlobUrls()
})

/** The main image as the stage draws it. Every field derives from the image state. */
export function selectScreenshot(state: ImageState) {
  return {
    src: state.uploadedImageUrl,
    scale: state.imageScale / 100,
    offsetX: state.imagePlacement.offsetX,
    offsetY: state.imagePlacement.offsetY,
    rotation: state.imagePlacement.rotation,
    radius: state.borderRadius,
  }
}

export type ScreenshotView = ReturnType<typeof selectScreenshot>

type HistoryEntry = ReturnType<typeof useImageStore.temporal.getState>['pastStates'][number]

let typingHistory: { key: string; time: number; state: ImageState; past: HistoryEntry[] } | null = null

/** Consecutive keystrokes in one field undo together, until a pause or another edit. */
export function withTypingHistory(key: string, change: () => void): void {
  const history = useImageStore.temporal.getState()
  const time = Date.now()
  const group = history.isTracking && typingHistory?.key === key &&
    time - typingHistory.time < 750 && typingHistory.state === useImageStore.getState() &&
    typingHistory.past === history.pastStates && history.futureStates.length === 0
  if (group) history.pause()
  try {
    change()
  } finally {
    if (group) history.resume()
  }
  typingHistory = { key, time, state: useImageStore.getState(), past: useImageStore.temporal.getState().pastStates }
}

/** An open undo step: the newest history entry before it began, or null when history was empty. */
export type HistoryStep = { anchor: HistoryEntry | null }

/**
 * Collapse every history entry recorded since the step began into one, so a
 * whole AI edit (or a chosen variation) undoes with a single ⌘Z. Call
 * `beginHistoryStep` before the writes and `endHistoryStep` after; this works
 * across awaits as long as the user does not edit in between. The step is
 * anchored on an entry rather than a count, because at the history limit
 * every new entry evicts the oldest and the count stops growing.
 */
export function beginHistoryStep(): HistoryStep {
  return { anchor: useImageStore.temporal.getState().pastStates.at(-1) ?? null }
}

/** Close a step opened by {@link beginHistoryStep}. */
export function endHistoryStep(step: HistoryStep) {
  useImageStore.temporal.setState((history) => {
    const index = step.anchor ? history.pastStates.lastIndexOf(step.anchor) : -1
    // Keep the anchor and the step's first entry. An evicted (or absent)
    // anchor means every remaining entry belongs to the step: keep the first.
    const keep = index >= 0 ? index + 2 : 1
    return history.pastStates.length > keep
      ? { pastStates: history.pastStates.slice(0, keep) }
      : history
  })
}

/** Run synchronous writes as one undo step. */
export function withHistoryStep<T>(write: () => T): T {
  const start = beginHistoryStep()
  try {
    return write()
  } finally {
    endHistoryStep(start)
  }
}
