// FFmpeg/FFprobe post-processing pipeline for Shots PR video evidence.
// Produces 1920x1080 @ 30fps H.264 (yuv420p) + AAC MP4 with synchronized
// narration, SRT/VTT sidecar captions, burned-in legible captions, media
// inspection via ffprobe + volumedetect, and single-pass per-beat keyframes.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Wrap caption text cleanly onto up to 2 lines (max ~58 chars per line) for
 * crisp 1080p readability without obscuring the application UI.
 *
 * @param {string} text
 * @param {number} [maxCharsPerLine]
 * @returns {string[]}
 */
export function wrapCaptionText(text, maxCharsPerLine = 58) {
  const words = String(text ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) return []

  const chunks = []
  let current = []
  let line = ''

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (candidate.length <= maxCharsPerLine) {
      line = candidate
    } else {
      if (line) current.push(line)
      line = word
      if (current.length === 2) {
        chunks.push(current.join('\n'))
        current = []
      }
    }
  }
  if (line) current.push(line)
  if (current.length > 0) chunks.push(current.join('\n'))
  return chunks
}

/**
 * Format seconds as SRT timestamp (`HH:MM:SS,mmm`).
 *
 * @param {number} sec
 * @returns {string}
 */
export function formatSrtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000))
  const hours = Math.floor(ms / 3_600_000)
  const mins = Math.floor((ms % 3_600_000) / 60_000)
  const secs = Math.floor((ms % 60_000) / 1000)
  const remMs = ms % 1000
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(remMs).padStart(3, '0')}`
}

/**
 * Format seconds as WebVTT timestamp (`HH:MM:SS.mmm`).
 *
 * @param {number} sec
 * @returns {string}
 */
export function formatVttTime(sec) {
  return formatSrtTime(sec).replace(',', '.')
}

/**
 * Safely parse an ffprobe duration field (which can be `"N/A"` on WebM files
 * lacking EBML duration headers).
 *
 * @param {unknown} raw
 * @returns {number}
 */
export function parseProbeDuration(raw) {
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/**
 * Sanitize a beat ID for safe use as a filename stem inside `review-frames/`.
 *
 * @param {string} id
 * @param {number} index
 * @returns {string}
 */
export function sanitizeFileStem(id, index) {
  const cleaned = String(id ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
  if (!cleaned || cleaned.includes('..')) {
    return `beat-${String(index + 1).padStart(2, '0')}`
  }
  return cleaned
}

/**
 * Format seconds as ASS timestamp (`H:MM:SS.cc`).
 *
 * @param {number} sec
 * @returns {string}
 */
export function formatAssTime(sec) {
  const cs = Math.max(0, Math.round(sec * 100))
  const hours = Math.floor(cs / 360_000)
  const mins = Math.floor((cs % 360_000) / 6_000)
  const secs = Math.floor((cs % 6_000) / 100)
  const remCs = cs % 100
  return `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(remCs).padStart(2, '0')}`
}

/**
 * Build synchronized SRT, VTT, ASS (1920x1080 scaled), and plain-text
 * transcript strings from timeline cues, splitting longer spoken cues
 * proportionally across readable 2-line caption chunks.
 *
 * @param {Array<{ audioStartSec: number, audioDurationSeconds: number, text: string }>} cues
 * @param {{ width?: number, height?: number }} [dimensions]
 * @returns {{ srt: string, vtt: string, ass: string, transcript: string }}
 */
export function buildCaptionsAndTranscript(cues, dimensions = {}) {
  const width = dimensions.width || 1920
  const height = dimensions.height || 1080
  const srtBlocks = []
  const vttBlocks = ['WEBVTT', '']
  const assEvents = []
  const transcriptLines = []
  let seq = 1

  for (const cue of cues) {
    const chunks = wrapCaptionText(cue.text, 64)
    if (chunks.length === 0) continue
    transcriptLines.push(`[${formatVttTime(cue.audioStartSec)}] ${cue.text.trim()}`)

    const totalWeight = chunks.reduce((sum, ch) => sum + ch.length, 0) || 1
    let cursor = cue.audioStartSec
    for (let i = 0; i < chunks.length; i++) {
      const share = (chunks[i].length / totalWeight) * cue.audioDurationSeconds
      const end =
        i === chunks.length - 1 ? cue.audioStartSec + cue.audioDurationSeconds : cursor + share
      srtBlocks.push(`${seq}\n${formatSrtTime(cursor)} --> ${formatSrtTime(end)}\n${chunks[i]}\n`)
      vttBlocks.push(`${formatVttTime(cursor)} --> ${formatVttTime(end)}\n${chunks[i]}\n`)
      const assText = chunks[i]
        .replace(/\\/g, '\\\\')
        .replace(/\{/g, '\\{')
        .replace(/\}/g, '\\}')
        .replace(/\n/g, '\\N')
      assEvents.push(
        `Dialogue: 0,${formatAssTime(cursor)},${formatAssTime(end)},Default,,0,0,0,,${assText}`
      )
      seq++
      cursor = end
    }
  }

  const ass = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,DejaVu Sans,30,&H00F8FAFC,&H000000FF,&H800F172A,&HC80F172A,0,0,0,0,100,100,0,0,3,10,0,2,180,180,26,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...assEvents,
    '',
  ].join('\n')

  return {
    srt: srtBlocks.join('\n') + '\n',
    vtt: vttBlocks.join('\n') + '\n',
    ass,
    transcript: transcriptLines.join('\n') + '\n',
  }
}

/**
 * Measure mean/max audio volume (dB) using FFmpeg `volumedetect`.
 *
 * @param {string} mediaPath
 * @returns {{ meanVolumeDb: number | null, maxVolumeDb: number | null }}
 */
export function measureAudioVolume(mediaPath) {
  const res = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-i',
      mediaPath,
      '-af',
      'volumedetect',
      '-vn',
      '-sn',
      '-dn',
      '-f',
      'null',
      '-',
    ],
    { encoding: 'utf8' }
  )
  if (res.error) {
    throw new Error(`ffmpeg volumedetect failed to start: ${res.error.message}`)
  }
  if (res.status !== 0) {
    throw new Error(
      `ffmpeg volumedetect failed (exit ${res.status}): ${(res.stderr || '').trim().slice(0, 300)}`
    )
  }
  const stderr = res.stderr || ''
  const meanMatch = stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/)
  const maxMatch = stderr.match(/max_volume:\s*(-?[\d.]+)\s*dB/)
  return {
    meanVolumeDb: meanMatch ? Number(meanMatch[1]) : null,
    maxVolumeDb: maxMatch ? Number(maxMatch[1]) : null,
  }
}

/**
 * Probe a rendered media file and verify H.264 video, AAC audio, geometry,
 * frame rate, positive finite duration, and audible narration track.
 *
 * @param {string} mp4Path
 */
export function inspectRenderedVideo(mp4Path) {
  const probeRaw = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', mp4Path],
    { encoding: 'utf8' }
  )
  const probe = JSON.parse(probeRaw)
  const videoStream = (probe.streams || []).find((s) => s.codec_type === 'video')
  const audioStream = (probe.streams || []).find((s) => s.codec_type === 'audio')
  if (!videoStream) throw new Error(`Rendered video ${mp4Path} has no video stream.`)
  if (!audioStream) throw new Error(`Rendered video ${mp4Path} has no audio stream.`)

  const [num, den] = String(videoStream.r_frame_rate || '30/1')
    .split('/')
    .map(Number)
  const fps = den ? Number((num / den).toFixed(2)) : Number(num || 30)
  const durationSeconds = Number(parseProbeDuration(probe.format?.duration).toFixed(2))
  if (durationSeconds <= 0) {
    throw new Error(`Rendered video ${mp4Path} has invalid duration (${probe.format?.duration}).`)
  }
  const volume = measureAudioVolume(mp4Path)
  if (volume.maxVolumeDb === null || volume.maxVolumeDb < -50) {
    throw new Error(
      `Rendered video ${mp4Path} appears silent (max_volume=${String(volume.maxVolumeDb)} dB).`
    )
  }

  return {
    width: Number(videoStream.width),
    height: Number(videoStream.height),
    fps,
    pixelFormat: String(videoStream.pix_fmt || ''),
    videoCodec: String(videoStream.codec_name || ''),
    audioCodec: String(audioStream.codec_name || ''),
    sampleRate: Number(audioStream.sample_rate || 0),
    durationSeconds,
    sizeBytes: Number(probe.format?.size || 0),
    meanVolumeDb: volume.meanVolumeDb,
    maxVolumeDb: volume.maxVolumeDb,
  }
}

/**
 * Compose raw Playwright video + synchronized per-beat narration WAVs + burned-in
 * legible captions into a verified 1920x1080 @ 30fps H.264/AAC MP4, plus
 * review keyframes extracted in a single ffmpeg pass.
 *
 * @param {{
 *   rawVideoPath: string,
 *   cues: Array<{ id: string, audioPath: string, audioStartSec: number, audioDurationSeconds: number, startSec: number, endSec: number, text: string }>,
 *   outDir: string,
 *   outputName?: string,
 *   width?: number,
 *   height?: number,
 *   fps?: number,
 * }} input
 */
export function composeEvidenceVideo(input) {
  const outDir = resolve(input.outDir)
  mkdirSync(outDir, { recursive: true })
  const width = input.width || 1920
  const height = input.height || 1080
  const fps = input.fps || 30
  const outputMp4 = join(outDir, input.outputName || 'evidence.mp4')
  const rawVideoPath = resolve(input.rawVideoPath)

  if (!existsSync(rawVideoPath)) {
    throw new Error(`Raw recording not found at ${rawVideoPath}`)
  }
  if (!Array.isArray(input.cues) || input.cues.length === 0) {
    throw new Error('Cannot compose narrated video without narration cues.')
  }

  // 1. Write SRT, VTT, ASS (1920x1080 PlayRes), and transcript files.
  const { srt, vtt, ass, transcript } = buildCaptionsAndTranscript(input.cues, { width, height })
  const srtPath = join(outDir, 'captions.srt')
  const vttPath = join(outDir, 'captions.vtt')
  const assPath = join(outDir, 'captions.ass')
  const transcriptPath = join(outDir, 'transcript.txt')
  writeFileSync(srtPath, srt, 'utf8')
  writeFileSync(vttPath, vtt, 'utf8')
  writeFileSync(assPath, ass, 'utf8')
  writeFileSync(transcriptPath, transcript, 'utf8')

  // 2. Measure raw video duration safely (Playwright WebMs may report "N/A").
  const rawProbe = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_format', '-of', 'json', rawVideoPath], {
      encoding: 'utf8',
    })
  )
  const rawDurationSec = parseProbeDuration(rawProbe.format?.duration)
  const lastAudioEndSec = Math.max(
    ...input.cues.map((c) => c.audioStartSec + c.audioDurationSeconds + 0.5)
  )
  const targetDurationSec = Math.max(rawDurationSec, lastAudioEndSec)

  // 3. Mix each beat's narration WAV onto one 48kHz timeline at its exact offset.
  const mixedAudioPath = join(outDir, 'narration-mixed.wav')
  try {
    const audioArgs = [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-t',
      targetDurationSec.toFixed(3),
      '-i',
      'anullsrc=r=48000:cl=mono',
    ]
    const filterParts = []
    const mixInputs = ['[0:a]']

    for (let i = 0; i < input.cues.length; i++) {
      const cue = input.cues[i]
      audioArgs.push('-i', resolve(cue.audioPath))
      const delayMs = Math.max(0, Math.round(cue.audioStartSec * 1000))
      const inputIdx = i + 1
      filterParts.push(`[${inputIdx}:a]adelay=${delayMs}|${delayMs}[a${inputIdx}]`)
      mixInputs.push(`[a${inputIdx}]`)
    }
    filterParts.push(
      `${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]`
    )
    audioArgs.push(
      '-filter_complex',
      filterParts.join(';'),
      '-map',
      '[aout]',
      '-ar',
      '48000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      mixedAudioPath
    )
    execFileSync('ffmpeg', audioArgs, { stdio: 'inherit' })

    // 4. Encode final 1920x1080 @ 30fps H.264 + AAC MP4 with burned-in captions.
    // Pad the video tail via tpad when Playwright's raw WebM is shorter than
    // the narration timeline (or lacks a duration header) so trailing audio is
    // never truncated. Run with cwd=outDir and constant filename `captions.ass`
    // to avoid filter-string path escaping issues.
    const padSec =
      rawDurationSec > 0 ? Math.max(0, targetDurationSec - rawDurationSec + 0.5) : targetDurationSec
    const videoFilters = [
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=#0b1120`,
    ]
    if (padSec > 0.05) {
      videoFilters.push(`tpad=stop_mode=clone:stop_duration=${padSec.toFixed(3)}`)
    }
    videoFilters.push('ass=captions.ass')

    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        rawVideoPath,
        '-i',
        mixedAudioPath,
        '-vf',
        videoFilters.join(','),
        '-t',
        targetDurationSec.toFixed(3),
        '-r',
        String(fps),
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-tune',
        'stillimage',
        '-crf',
        '21',
        '-g',
        String(fps * 2),
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-ar',
        '48000',
        '-movflags',
        '+faststart',
        outputMp4,
      ],
      { cwd: outDir, stdio: 'inherit' }
    )
  } finally {
    if (existsSync(mixedAudioPath)) {
      unlinkSync(mixedAudioPath)
    }
  }

  // 5. Inspect rendered MP4 metadata and verify compliance + no audio truncation.
  const media = inspectRenderedVideo(outputMp4)
  if (media.videoCodec !== 'h264') {
    throw new Error(`Expected H.264 video codec, got "${media.videoCodec}".`)
  }
  if (media.audioCodec !== 'aac') {
    throw new Error(`Expected AAC audio codec, got "${media.audioCodec}".`)
  }
  if (media.pixelFormat !== 'yuv420p') {
    throw new Error(`Expected yuv420p pixel format, got "${media.pixelFormat}".`)
  }
  if (media.width !== width || media.height !== height) {
    throw new Error(`Expected ${width}x${height}, got ${media.width}x${media.height}.`)
  }
  if (media.durationSeconds < lastAudioEndSec - 0.6) {
    throw new Error(
      `Rendered video duration (${media.durationSeconds}s) is shorter than narration end (${lastAudioEndSec.toFixed(2)}s); audio may be truncated.`
    )
  }

  // 6. Extract representative review frames (one per beat midpoint) in one
  // ffmpeg invocation so the agent can visually inspect every beat.
  const framesDir = join(outDir, 'review-frames')
  mkdirSync(framesDir, { recursive: true })
  const reviewFrames = []
  const frameArgs = ['-y', '-hide_banner', '-loglevel', 'error']
  const outputArgs = []
  for (let i = 0; i < input.cues.length; i++) {
    const cue = input.cues[i]
    const midpoint = Math.min(
      Math.max(0.2, (cue.startSec + cue.endSec) / 2),
      Math.max(0.2, media.durationSeconds - 0.2)
    )
    const stem = sanitizeFileStem(cue.id, i)
    const framePath = join(framesDir, `beat-${String(i + 1).padStart(2, '0')}-${stem}.png`)
    frameArgs.push('-ss', midpoint.toFixed(3), '-i', outputMp4)
    outputArgs.push('-map', `${i}:v:0`, '-frames:v', '1', framePath)
    reviewFrames.push({
      beatId: cue.id,
      timestampSec: Number(midpoint.toFixed(2)),
      path: framePath,
    })
  }
  execFileSync('ffmpeg', [...frameArgs, ...outputArgs], { stdio: 'inherit' })

  return {
    outputMp4,
    srtPath,
    vttPath,
    transcriptPath,
    media,
    reviewFrames,
  }
}
