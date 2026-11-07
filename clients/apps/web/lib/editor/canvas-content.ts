import type { ImageState } from '@/lib/store'
import { hasMotionContent } from '@/lib/animation/motion-schema'
import { hasVisibleMockups, shouldRenderSourceImage } from '@/lib/device-mockups/layouts'

/**
 * Whether the design plays over time and so exports as video or GIF: slides,
 * a timeline, animation clips or motion. Export Video and Publish offer the
 * animated formats on the same rule.
 */
export function canExportMotion(
  state: Pick<ImageState, 'animationClips' | 'motion' | 'slides' | 'timeline'>
): boolean {
  return (
    state.slides.length > 0 ||
    state.timeline.tracks.length > 0 ||
    state.animationClips.length > 0 ||
    hasMotionContent(state.motion)
  )
}

/** Keep the stage and export controls available for every supported composition. */
export function hasCanvasContent(state: ImageState): boolean {
  return Boolean(
    (state.uploadedImageUrl && shouldRenderSourceImage(state.editorMode, state.mockups)) ||
    (state.editorMode === 'device' && hasVisibleMockups(state.mockups)) ||
    state.textOverlays.length ||
    state.imageOverlays.length ||
    state.elements.length ||
    state.annotations.length ||
    state.blurRegions.length
  )
}
