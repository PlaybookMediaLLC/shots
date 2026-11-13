import type { Page } from '@playwright/test'

/**
 * A small reader for MP4 exports, so specs can check what a file holds
 * (tracks, codecs, durations, frames, and sound) without ffprobe.
 */

/** One sample of an MP4 track: where its bytes are, and whether it is a keyframe. */
export type Mp4Sample = { key: boolean; offset: number; size: number }

/** One MP4 track as its boxes describe it. */
export type Mp4Track = {
  /** The sample entry, such as avc1 or mp4a. */
  codec: string
  /** For video: the WebCodecs codec string and decoder description (avcC). */
  decoder?: { codec: string; description: string }
  /** Seconds. */
  duration: number
  /** vide or soun. */
  handler: string
  samples: Mp4Sample[]
}

/**
 * Read the tracks of an MP4 from its moov box: handler, sample entry,
 * duration, and where every sample is, from the sample tables (stsz, stsc,
 * stco/co64, stss). Enough of ISO BMFF to check an export without ffprobe.
 */
export function readMp4Tracks(file: Buffer): Mp4Track[] {
  type Box = { body: number; end: number; type: string }
  const children = (start: number, end: number): Box[] => {
    const found: Box[] = []
    for (let at = start; at + 8 <= end;) {
      let size = file.readUInt32BE(at)
      let header = 8
      if (size === 1) {
        size = Number(file.readBigUInt64BE(at + 8))
        header = 16
      } else if (size === 0) {
        size = end - at
      }
      found.push({
        body: at + header,
        end: at + size,
        type: file.toString('latin1', at + 4, at + 8),
      })
      at += size
    }
    return found
  }
  const find = (box: Box, ...types: string[]) =>
    children(box.body, box.end).find((item) => types.includes(item.type))
  const child = (box: Box, type: string) => {
    const found = find(box, type)
    if (!found) throw new Error(`No ${type} box in ${box.type}`)
    return found
  }
  const u32 = (at: number) => file.readUInt32BE(at)
  const moov = children(0, file.length).find((box) => box.type === 'moov')
  if (!moov) throw new Error('The file has no moov box.')
  return children(moov.body, moov.end)
    .filter((box) => box.type === 'trak')
    .map((trak) => {
      const mdia = child(trak, 'mdia')
      const mdhd = child(mdia, 'mdhd')
      const version = file.readUInt8(mdhd.body)
      const timescale = u32(mdhd.body + (version === 1 ? 20 : 12))
      const units =
        version === 1 ? Number(file.readBigUInt64BE(mdhd.body + 24)) : u32(mdhd.body + 16)
      const stbl = child(child(mdia, 'minf'), 'stbl')
      const stsd = child(stbl, 'stsd')
      const entry = children(stsd.body + 8, stsd.end)[0]!
      // A visual sample entry has 78 bytes of fields before its child boxes.
      const avcC =
        entry.type === 'avc1'
          ? children(entry.body + 78, entry.end).find((box) => box.type === 'avcC')
          : undefined
      const stsz = child(stbl, 'stsz')
      const fixedSize = u32(stsz.body + 4)
      const sizes = Array.from(
        { length: u32(stsz.body + 8) },
        (_, index) => fixedSize || u32(stsz.body + 12 + index * 4)
      )
      const stco = find(stbl, 'stco', 'co64')!
      const chunks = Array.from({ length: u32(stco.body + 4) }, (_, index) =>
        stco.type === 'co64'
          ? Number(file.readBigUInt64BE(stco.body + 8 + index * 8))
          : u32(stco.body + 8 + index * 4)
      )
      const stsc = child(stbl, 'stsc')
      const runs = Array.from({ length: u32(stsc.body + 4) }, (_, index) => ({
        firstChunk: u32(stsc.body + 8 + index * 12),
        perChunk: u32(stsc.body + 12 + index * 12),
      }))
      const stss = find(stbl, 'stss')
      const keys = stss
        ? new Set(
            Array.from(
              { length: u32(stss.body + 4) },
              (_, index) => u32(stss.body + 8 + index * 4) - 1
            )
          )
        : null
      const samples: Mp4Sample[] = []
      chunks.forEach((offset, chunk) => {
        const run = runs.filter((item) => item.firstChunk <= chunk + 1).pop()!
        for (let index = 0; index < run.perChunk && samples.length < sizes.length; index++) {
          const size = sizes[samples.length]!
          samples.push({ key: keys ? keys.has(samples.length) : true, offset, size })
          offset += size
        }
      })
      return {
        codec: entry.type,
        decoder: avcC
          ? {
              codec: `avc1.${[1, 2, 3].map((at) => file[avcC.body + at]!.toString(16).padStart(2, '0')).join('')}`,
              description: file.subarray(avcC.body, avcC.end).toString('base64'),
            }
          : undefined,
        duration: units / timescale,
        handler: file.toString(
          'latin1',
          child(mdia, 'hdlr').body + 8,
          child(mdia, 'hdlr').body + 12
        ),
        samples,
      }
    })
}

/** What decoding an MP4 in the browser shows. */
export type DecodedMp4 = {
  /** Seconds of decoded audio. */
  audioDuration: number
  /** RMS of the first channel from 0.05 s to 0.4 s. */
  before: number
  decodedFrames: number
  /** RMS of the first channel from 0.7 s to 1.6 s. */
  during: number
  /** Mean brightness (0-1) of the early frame. */
  firstLuma: number
  /** Mean per-channel difference (0-255) between an early and a middle frame. */
  firstToMiddle: number
  /** Mean brightness (0-1) of the middle frame. */
  middleLuma: number
  /** Mean per-channel difference between a middle and a late frame. */
  middleToLast: number
}

/**
 * Decode an MP4 in the page: every video sample with WebCodecs (no media
 * element, so no seeking or presentation timing is involved), comparing an
 * early, a middle, and a late frame, and the audio with Web Audio.
 */
export async function decodeMp4(page: Page, file: Buffer, video: Mp4Track): Promise<DecodedMp4> {
  if (!video.decoder) throw new Error(`No decoder for ${video.codec} samples.`)
  const picks = [2, Math.round(video.samples.length / 2), video.samples.length - 2]
  return page.evaluate(
    async ({ base64, decoder, picks, samples }) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
      const grabbed = new Map<number, Uint8ClampedArray>()
      let decodedFrames = 0
      let failure: Error | null = null
      const videoDecoder = new VideoDecoder({
        error: (error) => {
          failure = error
        },
        output: (frame) => {
          const index = decodedFrames++
          if (picks.includes(index)) {
            const canvas = new OffscreenCanvas(160, 120)
            const context = canvas.getContext('2d')!
            context.drawImage(frame, 0, 0, 160, 120)
            grabbed.set(index, context.getImageData(0, 0, 160, 120).data)
          }
          frame.close()
        },
      })
      videoDecoder.configure({
        codec: decoder.codec,
        description: Uint8Array.from(atob(decoder.description), (character) =>
          character.charCodeAt(0)
        ),
      })
      samples.forEach((sample, index) =>
        videoDecoder.decode(
          new EncodedVideoChunk({
            data: bytes.subarray(sample.offset, sample.offset + sample.size),
            timestamp: Math.round((index * 1_000_000) / 60),
            type: sample.key ? 'key' : 'delta',
          })
        )
      )
      await videoDecoder.flush()
      if (failure) throw failure
      const difference = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
        let total = 0
        for (let index = 0; index < a.length; index += 4) {
          total +=
            Math.abs(a[index]! - b[index]!) +
            Math.abs(a[index + 1]! - b[index + 1]!) +
            Math.abs(a[index + 2]! - b[index + 2]!)
        }
        return total / (a.length / 4) / 3
      }
      const [first, middle, last] = picks.map((pick) => grabbed.get(pick)!)
      const luma = (pixels: Uint8ClampedArray) => {
        let total = 0
        for (let index = 0; index < pixels.length; index += 4)
          total += pixels[index]! + pixels[index + 1]! + pixels[index + 2]!
        return total / (pixels.length / 4) / 3 / 255
      }
      const audio = await new OfflineAudioContext(1, 1, 48_000).decodeAudioData(
        bytes.buffer.slice(0)
      )
      const rms = (from: number, to: number) => {
        const channel = audio
          .getChannelData(0)
          .subarray(Math.floor(from * audio.sampleRate), Math.floor(to * audio.sampleRate))
        return Math.sqrt(
          channel.reduce((total, sample) => total + sample * sample, 0) /
            Math.max(1, channel.length)
        )
      }
      return {
        audioDuration: audio.duration,
        before: rms(0.05, 0.4),
        decodedFrames,
        during: rms(0.7, 1.6),
        firstLuma: luma(first!),
        firstToMiddle: difference(first!, middle!),
        middleLuma: luma(middle!),
        middleToLast: difference(middle!, last!),
      }
    },
    { base64: file.toString('base64'), decoder: video.decoder, picks, samples: video.samples }
  )
}
