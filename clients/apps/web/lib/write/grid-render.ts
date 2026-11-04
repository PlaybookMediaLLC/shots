'use client'

import type { BatchGrid } from '@/lib/api/contracts/content-batches'
import { renderAudioMix } from '@/lib/animation/audio-mix'
import { assetContentUrl } from '@/lib/editor/services'
import { WebCodecsVideoEncoder } from '@/lib/export/webcodecs-encoder'
import { coverCrop, frameAlpha, GRID_VIDEO, gridLayout, wrapLines } from './grid-layout'

/** A static grid compresses well; this keeps uploads small without visible loss. */
const BITRATE = 2_500_000

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'

/** Whether this browser can make the video; the page says so before a run starts. */
export const gridRenderSupported = () => typeof VideoEncoder !== 'undefined'

async function loadImage(assetId: string) {
  const response = await fetch(assetContentUrl(assetId))
  if (!response.ok) throw new Error(`An image could not be loaded (status ${response.status}).`)
  return createImageBitmap(await response.blob())
}

/** Write a block of centred text in `box`, vertically centred. */
function drawText(
  context: OffscreenCanvasRenderingContext2D,
  text: string,
  box: { height: number; width: number; x: number; y: number },
  size: number,
  weight: number,
  maxLines: number
) {
  context.font = `${weight} ${size}px ${FONT}`
  context.fillStyle = '#111111'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  const lines = wrapLines(text, box.width, maxLines, (line) => context.measureText(line).width)
  const lineHeight = size * 1.2
  const first = box.y + box.height / 2 - ((lines.length - 1) * lineHeight) / 2
  lines.forEach((line, index) => {
    context.fillText(line, box.x + box.width / 2, first + index * lineHeight)
  })
}

/** Compose the one frame a grid video shows. */
async function composeFrame(grid: BatchGrid) {
  const { height, width } = GRID_VIDEO
  const layout = gridLayout()
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Video rendering is unavailable in this browser.')
  context.fillStyle = '#000000'
  context.fillRect(0, 0, width, height)
  context.fillStyle = '#ffffff'
  context.fillRect(layout.panel.x, layout.panel.y, layout.panel.width, layout.panel.height)
  drawText(context, grid.headline, layout.headline, 64, 700, 2)
  for (const [index, cell] of layout.cells.entries()) {
    const slot = grid.slots[index]!
    if (!slot.assetId) throw new Error('Every image of a grid video must be filled first.')
    const bitmap = await loadImage(slot.assetId)
    try {
      const crop = coverCrop(bitmap, cell.image)
      context.drawImage(
        bitmap,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        cell.image.x,
        cell.image.y,
        cell.image.width,
        cell.image.height
      )
    } finally {
      bitmap.close()
    }
    drawText(context, slot.topic, cell.label, 36, 500, 2)
  }
  return canvas
}

/** Music for the video's whole length; a shorter track simply ends early. */
function musicMix(assetId: string | undefined, durationMs: number) {
  if (!assetId) return Promise.resolve(null)
  return renderAudioMix(
    [
      {
        gain: 1,
        id: 'grid-music',
        muted: false,
        name: 'Music',
        sourceDuration: durationMs,
        src: assetContentUrl(assetId),
        start: 0,
        trimEnd: durationMs,
        trimStart: 0,
      },
    ],
    durationMs
  )
}

/**
 * Render a concept to an MP4 in this browser. The frame is composed once and
 * only faded, so memory stays at two canvases however long the batch is.
 */
export async function renderGridVideo(
  grid: BatchGrid,
  signal: AbortSignal,
  onProgress: (fraction: number) => void
): Promise<Blob> {
  const { fps, height, seconds, width } = GRID_VIDEO
  const total = fps * seconds
  const frame = await composeFrame(grid)
  const audio = await musicMix(grid.musicAssetId, seconds * 1000)
  const encoder = new WebCodecsVideoEncoder({
    audio,
    bitrate: BITRATE,
    container: 'mp4',
    fps,
    height,
    width,
  })
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Video rendering is unavailable in this browser.')
  try {
    await encoder.initialize()
    for (let index = 0; index < total; index++) {
      signal.throwIfAborted()
      context.globalAlpha = 1
      context.fillStyle = '#000000'
      context.fillRect(0, 0, width, height)
      context.globalAlpha = frameAlpha(index, total)
      context.drawImage(frame, 0, 0)
      await encoder.encodeFromCanvas(canvas, index)
      onProgress((index + 1) / total)
    }
    return await encoder.finalize()
  } finally {
    encoder.dispose()
  }
}
