'use client'

import { domToForeignObjectSvg } from 'modern-screenshot'
import { useImageStore } from '@/lib/store'
import { cleanExportClone, shouldIncludeInExport } from './export-filter'

/**
 * SVG export from the editor's stage.
 *
 * A "real" SVG (every layer redrawn as <rect>, <text>, <path>) would be a
 * second renderer with its own idea of CSS shadows, filters, 3D, and text
 * layout. modern-screenshot's `domToSvg` is no help either: it rasterizes
 * and wraps one PNG. So the export is the stage itself as HTML inside SVG
 * (`<foreignObject>`), the same tree the PNG export rasterizes: text stays
 * text, gradients, borders, and shapes stay vector, fonts and images are
 * embedded as data URLs, and it scales to any size.
 *
 * The limit: only web browsers draw `<foreignObject>` HTML. Design tools
 * (Figma, Illustrator, Inkscape) and most image converters show nothing.
 *
 * Blur regions are composited onto pixels after capture (CSS backdrop
 * filters do not survive a clone), so a vector SVG would carry the
 * unblurred screenshot. A design with visible blur regions is therefore
 * exported as its rendered PNG inside an SVG, which keeps the blur.
 */

/** Characters XML 1.0 does not allow, which a cloned DOM can still carry. */
// eslint-disable-next-line no-control-regex
const XML_INVALID = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g

/** Base64 of bytes, in chunks the call stack can take. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}

/** An SVG document that shows one PNG at the given size. */
export function rasterSvg(png: Uint8Array, size: { height: number; width: number }): string {
  const width = Math.round(size.width)
  const height = Math.round(size.height)
  const href = `data:image/png;base64,${bytesToBase64(png)}`
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<image width="${width}" height="${height}" href="${href}" xlink:href="${href}"/></svg>`
  )
}

/** Serialize an SVG element as a standalone document, without scripts or event handlers. */
function serializeSvg(svg: SVGElement): string {
  svg.querySelectorAll('script').forEach((script) => script.remove())
  for (const element of [svg, ...Array.from(svg.querySelectorAll('*'))]) {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name.toLowerCase().startsWith('on')) element.removeAttribute(attribute.name)
    }
  }
  const markup = new XMLSerializer().serializeToString(svg).replace(XML_INVALID, '')
  return `<?xml version="1.0" encoding="UTF-8"?>\n${markup}`
}

/**
 * The stage as an SVG of `size` output px. `renderPng` produces the same
 * stage as a PNG at that size, for designs that must be flattened.
 */
export async function captureStageSvg(
  elementId: string,
  size: { height: number; width: number },
  renderPng: () => Promise<Blob>
): Promise<Blob> {
  const container = document
    .getElementById(elementId)
    ?.querySelector<HTMLElement>('[data-html-canvas="true"]')
  if (!container) throw new Error('Add a screenshot before exporting.')

  if (useImageStore.getState().blurRegions.some((region) => region.isVisible)) {
    const png = new Uint8Array(await (await renderPng()).arrayBuffer())
    return new Blob([rasterSvg(png, size)], { type: 'image/svg+xml' })
  }

  // Let a pending state change paint, as the raster export does.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const rect = { width: parseFloat(container.style.width), height: parseFloat(container.style.height) }
  const svg = await domToForeignObjectSvg(container, {
    backgroundColor: null,
    fetch: { requestInit: { mode: 'cors', cache: 'no-cache' } },
    filter: shouldIncludeInExport,
    height: rect.height,
    onCloneNode: cleanExportClone,
    width: rect.width,
  })
  // The viewBox stays the stage's CSS size, so the drawing scales to the output size.
  svg.setAttribute('width', String(Math.round(size.width)))
  svg.setAttribute('height', String(Math.round(size.height)))
  return new Blob([serializeSvg(svg)], { type: 'image/svg+xml' })
}
