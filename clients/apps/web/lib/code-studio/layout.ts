import { lineDiff, splitRows } from './diff'
import {
  activeFile,
  CODE_ASPECT_RATIOS,
  type CodeDocument,
  type CodeFile,
  type CodeSlide,
  type CodeStyle,
} from './document'
import { screenLines } from './tape'

/**
 * Code Studio's fixed geometry. Code is monospace with a fixed line height and
 * never wraps, so every size is arithmetic: a scene measures the same in the
 * editor, an export and a video frame, with no DOM measurement.
 */
export const CODE_FONT_SIZE = 14
export const CODE_LINE_HEIGHT = 22
export const TITLE_BAR_HEIGHT = 44
export const CODE_PADDING_Y = 20
export const CODE_PADDING_X = 24
export const FOOTER_HEIGHT = 56
export const PANE_GAP = 24
export const CAPTION_HEIGHT = 72

/** The rows a file shows: its diff, its terminal screen, or its lines. */
export function fileRowCount(file: CodeFile): number {
  if (file.tape !== undefined) return Math.max(1, screenLines(file.tape).length)
  if (file.base !== undefined) {
    const rows = lineDiff(file.base, file.code)
    return file.diff === 'split' ? splitRows(rows).length : rows.length
  }
  return file.code.split('\n').length
}

/** Whether a frame draws a title bar. */
export function hasTitleBar(style: Pick<CodeStyle, 'frame'>): boolean {
  return style.frame === 'mac' || style.frame === 'terminal'
}

/** One window's height for a number of rows. */
export function windowHeight(style: Pick<CodeStyle, 'frame'>, rows: number): number {
  return (hasTitleBar(style) ? TITLE_BAR_HEIGHT : 0) + CODE_PADDING_Y * 2 + rows * CODE_LINE_HEIGHT
}

/** The content of one slide without the aspect: windows, footer and padding. */
export function slideContentSize(
  style: CodeStyle,
  slide: CodeSlide,
  options: { caption?: boolean } = {}
): { width: number; height: number } {
  const rows = Math.max(...slide.panes.map((pane) => fileRowCount(activeFile(pane))))
  const footer = style.footer.show ? FOOTER_HEIGHT : 0
  const caption = options.caption && slide.caption ? CAPTION_HEIGHT : 0
  return {
    width: style.width + style.padding * 2,
    height: windowHeight(style, rows) + footer + caption + style.padding * 2,
  }
}

/** Grow a content box to an aspect ratio, never cropping it. */
export function fitAspect(
  content: { width: number; height: number },
  aspect: CodeStyle['aspect']
): { width: number; height: number } {
  if (aspect === 'auto')
    return { width: Math.round(content.width), height: Math.round(content.height) }
  const ratio = CODE_ASPECT_RATIOS[aspect]
  const width = Math.max(content.width, content.height * ratio)
  return { width: Math.round(width), height: Math.round(width / ratio) }
}

/** One slide's output size. */
export function slideSize(document: CodeDocument, index: number) {
  return fitAspect(slideContentSize(document.style, document.slides[index]!), document.style.aspect)
}

/**
 * One size for every slide, so a carousel's pages and a video's frames match:
 * the largest content, grown to the aspect.
 */
export function documentSize(document: CodeDocument, options: { caption?: boolean } = {}) {
  const sizes = document.slides.map((slide) => slideContentSize(document.style, slide, options))
  return fitAspect(
    {
      width: Math.max(...sizes.map((size) => size.width)),
      height: Math.max(...sizes.map((size) => size.height)),
    },
    document.style.aspect
  )
}

/** Each pane's window width in a slide. */
export function paneWidth(
  style: Pick<CodeStyle, 'width'>,
  slide: Pick<CodeSlide, 'panes'>
): number {
  return slide.panes.length > 1 ? (style.width - PANE_GAP) / 2 : style.width
}
