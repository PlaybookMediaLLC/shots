import { z } from 'zod'

/**
 * Target sizes for multi-size export. Each target renders the design again
 * at its own size (see `adaptDocumentToSize`), so a story and a banner are
 * laid out for their own shape rather than stretched.
 */

/** Where a size is used, for grouping in the picker. `canvas` is the design's own size. */
export const sizeGroupSchema = z.enum([
  'canvas',
  'social',
  'marketing',
  'presentation',
  'app-store',
  'custom',
])
/** A size group. */
export type SizeGroup = z.infer<typeof sizeGroupSchema>

/** Labels for the size groups. */
export const SIZE_GROUP_LABELS: Record<SizeGroup, string> = {
  'app-store': 'App Store',
  canvas: 'Canvas',
  custom: 'Custom',
  marketing: 'Marketing',
  presentation: 'Presentation',
  social: 'Social',
}

/** The smallest and largest side a target may have, in px. */
export const TARGET_SIDE_LIMITS = { max: 8192, min: 16 } as const

const side = z.number().int().min(TARGET_SIDE_LIMITS.min).max(TARGET_SIDE_LIMITS.max)

/** The id of the target that is the design's own canvas, drawn by the live stage. */
export const CANVAS_TARGET_ID = 'canvas'

/** One target size. `id` is a short slug used in file and folder names. */
export const exportTargetSchema = z.object({
  group: sizeGroupSchema,
  height: side,
  id: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9-]+$/),
  label: z.string().min(1).max(80),
  width: side,
})
/** A target size. */
export type ExportTarget = z.infer<typeof exportTargetSchema>

/** The built-in target sizes, by platform. */
export const EXPORT_SIZE_PRESETS: readonly ExportTarget[] = [
  { group: 'social', height: 900, id: 'x-post', label: 'X post', width: 1600 },
  { group: 'social', height: 627, id: 'linkedin-post', label: 'LinkedIn post', width: 1200 },
  { group: 'social', height: 1080, id: 'instagram-square', label: 'Instagram square', width: 1080 },
  {
    group: 'social',
    height: 1350,
    id: 'instagram-portrait',
    label: 'Instagram portrait',
    width: 1080,
  },
  { group: 'social', height: 1920, id: 'instagram-story', label: 'Instagram story', width: 1080 },
  { group: 'social', height: 630, id: 'facebook-post', label: 'Facebook post', width: 1200 },
  { group: 'social', height: 1500, id: 'pinterest-pin', label: 'Pinterest pin', width: 1000 },
  {
    group: 'social',
    height: 720,
    id: 'youtube-thumbnail',
    label: 'YouTube thumbnail',
    width: 1280,
  },
  { group: 'marketing', height: 630, id: 'open-graph', label: 'Open Graph', width: 1200 },
  { group: 'marketing', height: 900, id: 'blog-hero', label: 'Blog hero', width: 1600 },
  {
    group: 'marketing',
    height: 760,
    id: 'product-hunt',
    label: 'Product Hunt gallery',
    width: 1270,
  },
  { group: 'marketing', height: 600, id: 'email-header', label: 'Email header', width: 1200 },
  { group: 'presentation', height: 1080, id: 'slide-16x9', label: 'Slide 16:9', width: 1920 },
  { group: 'presentation', height: 1200, id: 'slide-4x3', label: 'Slide 4:3', width: 1600 },
  { group: 'app-store', height: 2796, id: 'iphone-6-9', label: 'iPhone 6.9"', width: 1290 },
  { group: 'app-store', height: 2778, id: 'iphone-6-5', label: 'iPhone 6.5"', width: 1284 },
  { group: 'app-store', height: 2208, id: 'iphone-5-5', label: 'iPhone 5.5"', width: 1242 },
  { group: 'app-store', height: 2732, id: 'ipad-13', label: 'iPad 13"', width: 2048 },
  {
    group: 'app-store',
    height: 800,
    id: 'chrome-web-store',
    label: 'Chrome Web Store',
    width: 1280,
  },
  {
    group: 'app-store',
    height: 400,
    id: 'chrome-web-store-small',
    label: 'Chrome Web Store small',
    width: 640,
  },
]

/** A preset by id. */
export function getSizePreset(id: string): ExportTarget | undefined {
  return EXPORT_SIZE_PRESETS.find((preset) => preset.id === id)
}

/** The design's own canvas as a target. */
export function canvasTarget(width: number, height: number): ExportTarget {
  return {
    group: 'canvas',
    height: Math.round(height),
    id: CANVAS_TARGET_ID,
    label: 'Canvas',
    width: Math.round(width),
  }
}

/** A custom size, validated; throws a readable error for an out-of-range size. */
export function customTarget(width: number, height: number): ExportTarget {
  const parsed = z.object({ height: side, width: side }).safeParse({ height, width })
  if (!parsed.success) {
    throw new Error(
      `Sizes must be whole pixels between ${TARGET_SIDE_LIMITS.min} and ${TARGET_SIDE_LIMITS.max}.`
    )
  }
  return {
    group: 'custom',
    height: parsed.data.height,
    id: `custom-${parsed.data.width}x${parsed.data.height}`,
    label: `${parsed.data.width}×${parsed.data.height}`,
    width: parsed.data.width,
  }
}

/** Add or remove a target by id, keeping the order targets were picked in. */
export function toggleTarget(
  targets: readonly ExportTarget[],
  target: ExportTarget
): ExportTarget[] {
  return targets.some((item) => item.id === target.id)
    ? targets.filter((item) => item.id !== target.id)
    : [...targets, target]
}
