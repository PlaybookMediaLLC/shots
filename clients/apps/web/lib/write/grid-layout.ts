/**
 * Where a grid video's parts go. Pure, so the layout can be checked without a
 * canvas: a headline above four labelled images on a light panel, between
 * black bands, in a 9:16 frame.
 */

/** A grid video's frame: every destination's vertical format. */
export const GRID_VIDEO = { fps: 30, height: 1920, seconds: 6, width: 1080 } as const

/** A rectangle in frame pixels. */
export type GridRect = { height: number; width: number; x: number; y: number }

const PANEL_HEIGHT = 1350
const MARGIN = 48
const GAP = 32
const HEADLINE_HEIGHT = 190
const LABEL_HEIGHT = 84

/** The frame's panel, headline and four cells, left to right and top to bottom. */
export function gridLayout({ height, width } = GRID_VIDEO) {
  const panel = { height: PANEL_HEIGHT, width, x: 0, y: Math.round((height - PANEL_HEIGHT) / 2) }
  const headline = {
    height: HEADLINE_HEIGHT,
    width: width - 2 * MARGIN,
    x: MARGIN,
    y: panel.y + MARGIN / 2,
  }
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

/** Text broken into at most `maxLines`, the last ending in … when it does not fit. */
export function wrapLines(
  text: string,
  maxWidth: number,
  maxLines: number,
  measure: (line: string) => number
): string[] {
  const lines: string[] = []
  let line = ''
  const words = text.trim().split(/\s+/).filter(Boolean)
  for (const [index, word] of words.entries()) {
    const next = line ? `${line} ${word}` : word
    if (measure(next) <= maxWidth || !line) {
      line = next
      continue
    }
    if (lines.length === maxLines - 1) {
      lines.push(fitted(`${line} ${words.slice(index).join(' ')}`, maxWidth, measure))
      return lines
    }
    lines.push(measure(line) <= maxWidth ? line : fitted(line, maxWidth, measure))
    line = word
  }
  if (line) lines.push(measure(line) <= maxWidth ? line : fitted(line, maxWidth, measure))
  return lines
}

function fitted(text: string, maxWidth: number, measure: (line: string) => number) {
  let end = text.length
  while (end > 1 && measure(`${text.slice(0, end).trimEnd()}…`) > maxWidth) end--
  return `${text.slice(0, end).trimEnd()}…`
}

/** How visible a frame is: a short fade in and out, never fully black on the first frame. */
export function frameAlpha(frame: number, total: number) {
  const fade = 12
  return Math.min(1, (frame + 3) / fade, (total - frame) / fade)
}
