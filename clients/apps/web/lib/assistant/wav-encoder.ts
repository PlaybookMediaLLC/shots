/**
 * Pure 16kHz mono 16-bit PCM WAV encoder for in-browser voice dictation.
 * Produces standard RIFF/WAVE bytes (~1.9 MB/min) that pass `validateVoiceMemo`
 * and work identically across Chromium, Safari, and Firefox.
 */

const TARGET_SAMPLE_RATE = 16_000

/** Downsample mono PCM float samples (`-1..1`) to 16 kHz via linear interpolation. */
function downsampleMono(samples: Float32Array, sourceRate: number): Float32Array {
  if (sourceRate <= TARGET_SAMPLE_RATE || samples.length === 0) return samples
  const ratio = sourceRate / TARGET_SAMPLE_RATE
  const length = Math.max(1, Math.floor(samples.length / ratio))
  const out = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio
    const left = Math.floor(position)
    const right = Math.min(samples.length - 1, left + 1)
    const frac = position - left
    out[i] = samples[left]! * (1 - frac) + samples[right]! * frac
  }
  return out
}

/** Encode mono PCM float samples into a 16-bit RIFF/WAVE byte array. */
export function encodePcmWav(samples: Float32Array, sourceRate: number): Uint8Array<ArrayBuffer> {
  const rate = sourceRate > TARGET_SAMPLE_RATE ? TARGET_SAMPLE_RATE : Math.round(sourceRate)
  const mono = sourceRate > TARGET_SAMPLE_RATE ? downsampleMono(samples, sourceRate) : samples
  const dataBytes = mono.length * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }

  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM subchunk size
  view.setUint16(20, 1, true) // PCM format
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeAscii(36, 'data')
  view.setUint32(40, dataBytes, true)

  for (let i = 0; i < mono.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, mono[i]!))
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  }

  return new Uint8Array(buffer)
}
