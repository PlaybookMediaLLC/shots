import type { OverlayPosition } from '@/lib/api/contracts/content-batches'

/**
 * Where a template video's parts go. Pure, so preview and export share one
 * layout and it can be checked without a canvas: the grid's headline above four
 * labelled images, or the fade-in's headline above one image, on a light panel
 * between black bands; or a UGC video's text over its clip. All in a 9:16 frame.
 */

/** A template video's frame: every destination's vertical format. */
export const GRID_VIDEO = { fps: 30, height: 1920, seconds: 6, width: 1080 } as const

/** A rectangle in frame pixels. */
export type GridRect = { height: number; width: number; x: number; y: number }

const PANEL_HEIGHT = 1350
const MARGIN = 48
const GAP = 32
const HEADLINE_HEIGHT = 190
const LABEL_HEIGHT = 84

/** The frame's panel, headline and four cells, left to right and top to bottom. */
/** The light panel between the bands, and the headline at its top. */
function panelAndHeadline({ height, width }: { height: number; width: number }) {
  const panel = { height: PANEL_HEIGHT, width, x: 0, y: Math.round((height - PANEL_HEIGHT) / 2) }
  const headline = {
    height: HEADLINE_HEIGHT,
    width: width - 2 * MARGIN,
    x: MARGIN,
    y: panel.y + MARGIN / 2,
  }
  return { headline, panel }
}

export function gridLayout({ height, width } = GRID_VIDEO) {
  const { headline, panel } = panelAndHeadline({ height, width })
  const top = headline.y + headline.height
  const cellWidth = Math.floor((width - 2 * MARGIN - GAP) / 2)
  const cellHeight = Math.floor((panel.y + panel.height - MARGIN - top - GAP) / 2)
  const cells = [0, 1, 2, 3].map((index) => {
    const x = MARGIN + (index % 2) * (cellWidth + GAP)
    const y = top + Math.floor(index / 2) * (cellHeight + GAP)
    return {
      image: {
        height: cellHeight - LABEL_HEIGHT,
        width: cellWidth,
        x,
        y: y + LABEL_HEIGHT,
      },
      label: { height: LABEL_HEIGHT, width: cellWidth, x, y },
    }
  })
  return { cells, headline, panel }
}

/** The part of a source that covers a target, centred: what an image cell shows. */
export function coverCrop(
  source: { height: number; width: number },
  target: { height: number; width: number }
): GridRect {
  const scale = Math.max(target.width / source.width, target.height / source.height)
  const width = target.width / scale
  const height = target.height / scale
  return { height, width, x: (source.width - width) / 2, y: (source.height - height) / 2 }
}

/** A fade-in video's frame: its headline, unless image only, above the image on the panel. */
export function singleLayout(hideHeadline: boolean, { height, width } = GRID_VIDEO) {
  const { headline, panel } = panelAndHeadline({ height, width })
  const top = hideHeadline ? panel.y + MARGIN : headline.y + headline.height
  return {
    headline: hideHeadline ? null : headline,
    image: { height: panel.y + panel.height - MARGIN - top, width: width - 2 * MARGIN, x: MARGIN, y: top },
    panel,
  }
}

/** Where a source sits inside a target, whole and centred: what a fade-in shows. */
export function containFit(source: { height: number; width: number }, target: GridRect): GridRect {
  const scale = Math.min(target.width / source.width, target.height / source.height)
  const width = source.width * scale
  const height = source.height * scale
  return { height, width, x: target.x + (target.width - width) / 2, y: target.y + (target.height - height) / 2 }
}

/** A UGC video's text: bold, white with a dark outline, up to `maxLines` lines. */
export const OVERLAY = { inset: 288, lineHeight: 80, maxLines: 8, side: 72, size: 64 } as const

/** The block `lines` of overlay text take at a position: top and bottom keep clear of app chrome. */
export function overlayBlock(lines: number, position: OverlayPosition, { height, width } = GRID_VIDEO): GridRect {
  const block = lines * OVERLAY.lineHeight
  const y =
    position === 'top'
      ? OVERLAY.inset
      : position === 'bottom'
        ? height - OVERLAY.inset - block
        : Math.round((height - block) / 2)
  return { height: block, width: width - 2 * OVERLAY.side, x: OVERLAY.side, y }
}

/** A UGC video's frames: its clip, then its closing clip, at the frame rate. */
export function ugcTimeline(clipMs: number, closingMs = 0, fps: number = GRID_VIDEO.fps) {
  const clipFrames = Math.round((clipMs / 1000) * fps)
  const frames = clipFrames + Math.round((closingMs / 1000) * fps)
  return { clipFrames, durationMs: Math.round((frames / fps) * 1000), frames }
}

/** Which clip a frame of a UGC video shows, and at what second of it. */
export function frameSource(frame: number, clipFrames: number, fps: number = GRID_VIDEO.fps) {
  return frame < clipFrames
    ? { closing: false, seconds: frame / fps }
    : { closing: true, seconds: (frame - clipFrames) / fps }
}

/** Whether a line reads right to left: its first letter is Arabic, Hebrew or another RTL script. */
export const isRtl = (line: string) =>
  /^\P{L}*[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u.test(line)

/** User-perceived characters, so an emoji or an accented letter is never cut in two. */
const graphemes = (text: string) =>
  Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (part) => part.segment)

/**
 * Text broken into at most `maxLines`, the last ending in … when it does not
 * fit. Line breaks in the text are kept. A word wider than a line, such as a
 * URL or CJK text without spaces, breaks between characters.
 */
export function wrapLines(
  text: string,
  maxWidth: number,
  maxLines: number,
  measure: (line: string) => number
): string[] {
  const lines: string[] = []
  for (const paragraph of text.trim().split(/\r?\n/)) {
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word
      if (measure(next) <= maxWidth) {
        line = next
        continue
      }
      if (line) lines.push(line)
      line = ''
      for (const part of measure(word) <= maxWidth ? [word] : graphemes(word)) {
        if (line && measure(line + part) > maxWidth) {
          lines.push(line)
          line = part
        } else line += part
      }
    }
    if (line) lines.push(line)
  }
  if (lines.length <= maxLines) return lines
  const kept = lines.slice(0, maxLines)
  kept[maxLines - 1] = fitted(kept[maxLines - 1]!, maxWidth, measure)
  return kept
}

/** Text cut, between characters, until it fits with an ellipsis. */
function fitted(text: string, maxWidth: number, measure: (line: string) => number) {
  const parts = graphemes(text)
  let end = parts.length
  while (end > 1 && measure(`${parts.slice(0, end).join('').trimEnd()}…`) > maxWidth) end--
  return `${parts.slice(0, end).join('').trimEnd()}…`
}

/**
 * How visible a frame is: a fade in over `fadeIn` frames and a short fade out,
 * never fully black on the first frame, which some feeds show as the cover.
 */
export function frameAlpha(frame: number, total: number, fadeIn = 12) {
  return Math.min(1, (frame + 3) / fadeIn, (total - frame) / 12)
}

/** The fade-in template's fade: a second, from nearly black. */
export const SINGLE_FADE_IN_FRAMES = 30
