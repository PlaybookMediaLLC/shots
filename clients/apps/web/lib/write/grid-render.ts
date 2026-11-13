'use client'

import type { BatchGrid, OverlayPosition } from '@/lib/api/contracts/content-batches'
import { decodeAudioSource, MIX_SAMPLE_RATE, renderAudioMix } from '@/lib/animation/audio-mix'
import type { AudioClip } from '@/lib/animation/motion-schema'
import { assetContentUrl } from '@/lib/editor/services'
import { isAudioEncodingSupported } from '@/lib/export/audio-track'
import { FFmpegVideoEncoder } from '@/lib/export/ffmpeg-encoder'
import { isH264Supported, WebCodecsVideoEncoder } from '@/lib/export/webcodecs-encoder'
import { clampStart } from './audio-trim'
import {
  containFit,
  coverCrop,
  frameAlpha,
  frameSource,
  GRID_VIDEO,
  gridLayout,
  isRtl,
  OVERLAY,
  overlayBlock,
  SINGLE_FADE_IN_FRAMES,
  singleLayout,
  ugcTimeline,
  wrapLines,
} from './grid-layout'

/** A still compresses well; this keeps uploads small without visible loss. */
const STILL_BITRATE = 2_500_000
/** Moving footage needs more to stay sharp at 1080×1920. */
const CLIP_BITRATE = 6_000_000
/**
 * FFmpeg writes every frame into its memory before it encodes, so the fallback
 * takes clips up to this long. shortcut: a fixed cap, until FFmpeg streams frames.
 */
const FFMPEG_CLIP_MS = 20_000

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

async function loadImage(assetId: string) {
  const response = await fetch(assetContentUrl(assetId))
  if (!response.ok) throw new Error(`An image could not be loaded (status ${response.status}).`)
  return createImageBitmap(await response.blob())
}

/** Write a block of centred text in `box`, vertically centred. */
function drawText(
  context: Context2D,
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
    context.direction = isRtl(line) ? 'rtl' : 'ltr'
    context.fillText(line, box.x + box.width / 2, first + index * lineHeight)
  })
  context.direction = 'ltr'
}

/** A UGC video's text, white with a dark outline: the preview draws it with this too. */
export function drawOverlay(context: Context2D, text: string, position: OverlayPosition) {
  context.font = `800 ${OVERLAY.size}px ${FONT}`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.lineJoin = 'round'
  context.lineWidth = 10
  context.strokeStyle = '#000000'
  context.fillStyle = '#ffffff'
  const width = overlayBlock(1, position).width - context.lineWidth
  const lines = wrapLines(text, width, OVERLAY.maxLines, (line) => context.measureText(line).width)
  const block = overlayBlock(lines.length, position)
  lines.forEach((line, index) => {
    const y = block.y + OVERLAY.lineHeight * (index + 0.5)
    context.direction = isRtl(line) ? 'rtl' : 'ltr'
    context.strokeText(line, block.x + block.width / 2, y)
    context.fillText(line, block.x + block.width / 2, y)
  })
  context.direction = 'ltr'
}

/** Draw an image asset into `box`, whole or covering it. */
async function drawAsset(
  context: Context2D,
  assetId: string,
  box: { height: number; width: number; x: number; y: number },
  fit: 'contain' | 'cover'
) {
  const bitmap = await loadImage(assetId)
  try {
    if (fit === 'contain') {
      const at = containFit(bitmap, box)
      context.drawImage(bitmap, at.x, at.y, at.width, at.height)
      return
    }
    const crop = coverCrop(bitmap, box)
    context.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, box.x, box.y, box.width, box.height)
  } finally {
    bitmap.close()
  }
}

/**
 * The one frame a grid or fade-in video shows. The editor's preview draws this
 * same frame, so what is previewed is what renders; empty slots stay blank.
 */
export async function composeStill(grid: BatchGrid) {
  const { height, width } = GRID_VIDEO
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Video rendering is unavailable in this browser.')
  context.fillStyle = '#000000'
  context.fillRect(0, 0, width, height)
  context.fillStyle = '#ffffff'
  if (grid.kind === 'single') {
    const layout = singleLayout(Boolean(grid.hideHeadline))
    context.fillRect(layout.panel.x, layout.panel.y, layout.panel.width, layout.panel.height)
    if (layout.headline) drawText(context, grid.headline, layout.headline, 64, 700, 2)
    const assetId = grid.slots[0]?.assetId
    if (assetId) await drawAsset(context, assetId, layout.image, 'contain')
    return canvas
  }
  const layout = gridLayout()
  context.fillRect(layout.panel.x, layout.panel.y, layout.panel.width, layout.panel.height)
  drawText(context, grid.headline, layout.headline, 64, 700, 2)
  for (const [index, cell] of layout.cells.entries()) {
    const slot = grid.slots[index]
    if (slot?.assetId) await drawAsset(context, slot.assetId, cell.image, 'cover')
    drawText(context, slot?.topic ?? '', cell.label, 36, 500, 2)
  }
  return canvas
}

/** Whether this browser's own encoders can make the video and its sound. */
async function canUseWebCodecs(audio: AudioBuffer | null) {
  return (
    typeof VideoEncoder !== 'undefined' &&
    (await isH264Supported()) &&
    (!audio || (await isAudioEncodingSupported('mp4', audio)))
  )
}

/**
 * Encode `frames` frames that `draw` paints, with the browser's own encoders,
 * or with FFmpeg where the browser has no H.264 or AAC encoder.
 */
async function encodeFrames(
  frames: number,
  draw: (context: Context2D, frame: number) => Promise<void> | void,
  audio: AudioBuffer | null,
  bitrate: number,
  signal: AbortSignal,
  onProgress: (fraction: number) => void
): Promise<Blob> {
  const { fps, height, width } = GRID_VIDEO
  if (await canUseWebCodecs(audio)) {
    const encoder = new WebCodecsVideoEncoder({ audio, bitrate, container: 'mp4', fps, height, width })
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Video rendering is unavailable in this browser.')
    try {
      await encoder.initialize()
      for (let index = 0; index < frames; index++) {
        signal.throwIfAborted()
        await draw(context, index)
        await encoder.encodeFromCanvas(canvas, index)
        onProgress((index + 1) / frames)
      }
      return await encoder.finalize()
    } finally {
      encoder.dispose()
    }
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Video rendering is unavailable in this browser.')
  const encoder = new FFmpegVideoEncoder({ audio, format: 'mp4', fps, height, onProgress, quality: 'medium', width })
  try {
    await encoder.initialize()
    for (let index = 0; index < frames; index++) {
      signal.throwIfAborted()
      await draw(context, index)
      await encoder.addFrame(canvas)
    }
    signal.throwIfAborted()
    return await encoder.encode()
  } finally {
    await encoder.dispose()
  }
}

/** A part of an audio file on the video's timeline. */
function track(id: string, src: string, start: number, trimStart: number, length: number, gain: number): AudioClip {
  return { gain, id, muted: false, name: id, sourceDuration: trimStart + length, src, start, trimEnd: trimStart + length, trimStart }
}

/** The music for the whole video, from its chosen start; a shorter track simply ends early. */
async function musicTrack(grid: BatchGrid, durationMs: number, gain: number) {
  if (!grid.musicAssetId) return []
  const src = assetContentUrl(grid.musicAssetId)
  const buffer = await decodeAudioSource(src, new OfflineAudioContext(2, 1, MIX_SAMPLE_RATE))
  const start = clampStart(grid.musicStartMs ?? 0, buffer.duration * 1000, durationMs)
  return [track('music', src, 0, start, durationMs, gain)]
}

/** A clip of the workspace's, loaded whole so seeking does not wait on the network. */
async function openClip(assetId: string) {
  const response = await fetch(assetContentUrl(assetId))
  if (!response.ok) throw new Error(`A clip could not be loaded (status ${response.status}).`)
  const url = URL.createObjectURL(await response.blob())
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  try {
    await new Promise<void>((resolve, reject) => {
      video.addEventListener('loadeddata', () => resolve(), { once: true })
      video.addEventListener(
        'error',
        () => reject(new Error('This browser cannot play the clip. Use an H.264 MP4 or MOV.')),
        { once: true }
      )
      video.src = url
    })
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
  // Its own sound, when it has any: a clip without an audio track decodes to nothing.
  const sound = await decodeAudioSource(url, new OfflineAudioContext(2, 1, MIX_SAMPLE_RATE)).then(
    () => true,
    () => false
  )
  return {
    close: () => {
      video.removeAttribute('src')
      video.load()
      URL.revokeObjectURL(url)
    },
    durationMs: video.duration * 1000,
    sound,
    url,
    video,
  }
}

/** Show the clip's frame at `seconds`. */
async function seek(video: HTMLVideoElement, seconds: number) {
  const target = Math.min(seconds, Math.max(0, video.duration - 0.001))
  if (Math.abs(video.currentTime - target) < 1e-4) return
  await new Promise<void>((resolve, reject) => {
    video.addEventListener('seeked', () => resolve(), { once: true })
    video.addEventListener('error', () => reject(new Error('The clip stopped playing.')), { once: true })
    video.currentTime = target
  })
}

/**
 * A UGC video: its clip under its text, then the closing clip, each covering
 * the 9:16 frame whatever its own size, sampled at 30 fps whatever its own rate.
 * The clips keep their sound; music plays under it at half volume.
 */
async function renderUgc(grid: BatchGrid, signal: AbortSignal, onProgress: (fraction: number) => void) {
  const clip = await openClip(grid.slots[0]!.assetId!)
  const closing = grid.closingAssetId ? await openClip(grid.closingAssetId).catch((error: unknown) => {
    clip.close()
    throw error
  }) : null
  try {
    const timeline = ugcTimeline(clip.durationMs, closing?.durationMs ?? 0)
    const clipMs = (timeline.clipFrames / GRID_VIDEO.fps) * 1000
    const clips = [
      ...(clip.sound ? [track('clip', clip.url, 0, 0, clipMs, 1)] : []),
      ...(closing?.sound ? [track('closing', closing.url, clipMs, 0, timeline.durationMs - clipMs, 1)] : []),
      ...(await musicTrack(grid, timeline.durationMs, clip.sound || closing?.sound ? 0.5 : 1)),
    ]
    const audio = await renderAudioMix(clips, timeline.durationMs)
    if (!(await canUseWebCodecs(audio)) && timeline.durationMs > FFMPEG_CLIP_MS)
      throw new Error(
        `This browser renders UGC videos of up to ${FFMPEG_CLIP_MS / 1000} seconds. Use Chrome, Edge or Safari for longer ones.`
      )
    const { height, width } = GRID_VIDEO
    return await encodeFrames(
      timeline.frames,
      async (context, frame) => {
        const at = frameSource(frame, timeline.clipFrames)
        const source = at.closing ? closing!.video : clip.video
        await seek(source, at.seconds)
        context.fillStyle = '#000000'
        context.fillRect(0, 0, width, height)
        const crop = coverCrop({ height: source.videoHeight, width: source.videoWidth }, GRID_VIDEO)
        context.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height)
        if (!at.closing) drawOverlay(context, grid.headline, grid.textPosition ?? 'middle')
      },
      audio,
      CLIP_BITRATE,
      signal,
      onProgress
    )
  } finally {
    clip.close()
    closing?.close()
  }
}

/**
 * Render a template concept to an MP4 in this browser: 1080×1920 at 30 fps,
 * H.264, with AAC when it has sound. A grid or fade-in is one still composed
 * once and faded in, six seconds long; a UGC video is as long as its clips.
 */
export async function renderTemplateVideo(
  grid: BatchGrid,
  signal: AbortSignal,
  onProgress: (fraction: number) => void
): Promise<Blob> {
  if (grid.slots.some((slot) => !slot.assetId))
    throw new Error('Every image or clip of a video must be filled first.')
  if (grid.kind === 'ugc') return renderUgc(grid, signal, onProgress)
  const durationMs = GRID_VIDEO.seconds * 1000
  const still = await composeStill(grid)
  const audio = await renderAudioMix(await musicTrack(grid, durationMs, 1), durationMs)
  const frames = GRID_VIDEO.fps * GRID_VIDEO.seconds
  const fadeIn = grid.kind === 'single' ? SINGLE_FADE_IN_FRAMES : undefined
  return encodeFrames(
    frames,
    (context, frame) => {
      context.globalAlpha = 1
      context.fillStyle = '#000000'
      context.fillRect(0, 0, GRID_VIDEO.width, GRID_VIDEO.height)
      context.globalAlpha = frameAlpha(frame, frames, fadeIn)
      context.drawImage(still, 0, 0)
      context.globalAlpha = 1
    },
    audio,
    STILL_BITRATE,
    signal,
    onProgress
  )
}
