#!/usr/bin/env node
// Unified CLI for Shots mandatory narrated PR video evidence.
//
// Commands:
//   check-deps                         Verify ffmpeg, ffprobe, Playwright, Kokoro TTS
//   setup-kokoro                       Install Kokoro ONNX venv + models in ~/.cache/shots-pr-evidence
//   record <scenario.mjs> [options]    Run scenario -> Kokoro TTS -> Playwright -> FFmpeg -> manifest
//   render-markdown <manifest.json>    Render PR evidence summary markdown block
//   validate [options]                 Validate PR body or manifest JSON (used by CI and locally)

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { composeEvidenceVideo } from './compose.mjs'
import { formatTimestamp, renderPrEvidenceMarkdown, upsertPrEvidenceBlock } from './markdown.mjs'
import {
  EvidenceRecorder,
  loadPlaywright,
  resolveCacheDir,
  resolveTtsPython,
} from './playwright-helpers.mjs'
import { EVIDENCE_SCHEMA_VERSION, validateManifest, validatePrEvidence } from './schema.mjs'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(MODULE_DIR, '../..')

function gitValue(args, fallback = '') {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return fallback
  }
}

function detectRepository() {
  const envRepo = process.env.PR_REPO || process.env.GITHUB_REPOSITORY
  if (envRepo) return envRepo
  const origin = gitValue(['remote', 'get-url', 'origin'])
  const match = origin.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/)
  return match ? match[1] : 'PlaybookMediaLLC/shots'
}

/**
 * Resolve an input path flexibly whether invoked from repo root or `clients/`
 * (`npm run devx:video-evidence -- ...`).
 *
 * @param {string} rawPath
 * @returns {string}
 */
function resolveInputPath(rawPath) {
  const fromCwd = resolve(process.cwd(), rawPath)
  if (existsSync(fromCwd)) return fromCwd
  const fromRoot = resolve(REPO_ROOT, rawPath)
  if (existsSync(fromRoot)) return fromRoot
  return fromCwd
}

function parsePositiveInt(value, flagName) {
  if (value === undefined || value === null || value === '') return null
  if (!/^\d+$/.test(String(value))) {
    console.error(`Invalid ${flagName}: expected a positive integer (got "${value}").`)
    process.exit(2)
  }
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n <= 0) {
    console.error(`Invalid ${flagName}: expected a positive integer (got "${value}").`)
    process.exit(2)
  }
  return n
}

function parsePositiveFloat(value, flagName, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`Invalid ${flagName}: expected a positive number (got "${value}").`)
    process.exit(2)
  }
  return n
}

function cmdCheckDeps() {
  const checks = []
  for (const bin of ['ffmpeg', 'ffprobe', 'espeak-ng']) {
    const res = spawnSync('which', [bin], { encoding: 'utf8' })
    checks.push({
      tool: bin,
      available: res.status === 0,
      path: res.status === 0 ? res.stdout.trim() : null,
      required: bin !== 'espeak-ng',
    })
  }

  let playwrightOk = false
  try {
    loadPlaywright()
    playwrightOk = true
  } catch {
    playwrightOk = false
  }
  checks.push({ tool: 'playwright', available: playwrightOk, required: true })

  const py = resolveTtsPython()
  const kokoroRes = spawnSync(py, ['-c', 'import kokoro_onnx, soundfile; print("ok")'], {
    encoding: 'utf8',
  })
  checks.push({
    tool: 'kokoro-onnx',
    available: kokoroRes.status === 0,
    python: py,
    required: false,
  })

  console.log(JSON.stringify({ checks }, null, 2))
  const missingRequired = checks.filter((c) => c.required && !c.available)
  if (missingRequired.length > 0) {
    console.error(`Missing required tools: ${missingRequired.map((c) => c.tool).join(', ')}`)
    process.exit(1)
  }
}

function cmdSetupKokoro() {
  const cacheBase = resolveCacheDir()
  const venvDir = join(cacheBase, 'venv')
  const venvPy = join(venvDir, 'bin/python')
  const venvPip = join(venvDir, 'bin/pip')

  mkdirSync(cacheBase, { recursive: true })
  if (!existsSync(venvPy)) {
    execFileSync('python3', ['-m', 'venv', venvDir], { stdio: 'inherit' })
  }
  execFileSync(venvPip, ['install', '--quiet', '--upgrade', 'pip'], { stdio: 'inherit' })
  execFileSync(venvPip, ['install', '--quiet', 'kokoro-onnx', 'soundfile'], { stdio: 'inherit' })
  execFileSync(venvPy, [join(MODULE_DIR, 'tts.py'), '--setup-only'], { stdio: 'inherit' })
}

async function cmdRecord(argv) {
  const { positionals, values: flags } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      slug: { type: 'string' },
      'base-url': { type: 'string' },
      tts: { type: 'string' },
      voice: { type: 'string' },
      speed: { type: 'string' },
      'allow-fallback': { type: 'boolean', default: false },
      'video-url': { type: 'string' },
      'output-name': { type: 'string' },
      'commit-sha': { type: 'string' },
      branch: { type: 'string' },
      repo: { type: 'string' },
      env: { type: 'string' },
      pr: { type: 'string' },
      'review-file': { type: 'string' },
    },
  })

  const scenarioArg = positionals[0]
  if (!scenarioArg) {
    console.error(
      'Usage: cli.mjs record <scenario.mjs> [--out <dir>] [--base-url <url>] [--tts kokoro|espeak-ng|openai] [--voice af_heart] [--speed 1.05] [--allow-fallback] [--video-url <https://...>] [--review-file <review.json>] [--pr <number>]'
    )
    process.exit(2)
  }

  const scenarioPath = resolveInputPath(scenarioArg)
  if (!existsSync(scenarioPath)) {
    throw new Error(`Scenario file not found: ${scenarioPath}`)
  }

  const speed = parsePositiveFloat(flags.speed, '--speed', 1.05)
  const prNumber = parsePositiveInt(flags.pr, '--pr')

  const slug =
    String(
      flags.slug ||
        scenarioPath
          .split('/')
          .pop()
          .replace(/\.m?js$/, '')
    ) +
    '-' +
    new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outDir = resolve(REPO_ROOT, String(flags.out || join('.local/pr-evidence', slug)))
  mkdirSync(outDir, { recursive: true })

  const scenarioMod = await import(pathToFileURL(scenarioPath).href)
  if (typeof scenarioMod.createScenario !== 'function') {
    throw new Error(
      `Scenario ${scenarioArg} must export an async createScenario(context) function.`
    )
  }

  const baseUrl = String(flags['base-url'] || process.env.E2E_BASE_URL || 'http://localhost:3000')
  const recorder = new EvidenceRecorder({
    outDir,
    baseUrl,
    ttsProvider: String(flags.tts || 'kokoro'),
    ttsVoice: String(flags.voice || 'af_heart'),
    ttsSpeed: speed,
    allowTtsFallback: Boolean(flags['allow-fallback']),
  })

  let scenarioDef
  let captured
  let primaryError = null
  try {
    await recorder.openBrowser()
    scenarioDef = await scenarioMod.createScenario({
      recorder,
      page: recorder.page,
      context: recorder.context,
      baseUrl,
      outDir,
    })
    await recorder.closeWarmupContext()
    await recorder.preSynthesize(scenarioDef.beats)
    await recorder.startRecording()
    await recorder.runBeats(scenarioDef.beats)
  } catch (err) {
    primaryError = err
    throw err
  } finally {
    try {
      captured = await recorder.finish()
    } catch (cleanupErr) {
      if (!primaryError) throw cleanupErr
      console.error(`Cleanup error after failure: ${cleanupErr}`)
    }
  }

  const composed = composeEvidenceVideo({
    rawVideoPath: captured.rawVideoPath,
    cues: captured.cues,
    outDir,
    outputName: String(flags['output-name'] || 'evidence.mp4'),
  })

  const criteriaById = new Map()
  for (const cue of captured.cues) {
    if (!cue.criterionId) continue
    const existing = criteriaById.get(cue.criterionId)
    if (!existing) {
      criteriaById.set(cue.criterionId, { startSec: cue.startSec, endSec: cue.endSec })
    } else {
      existing.endSec = Math.max(existing.endSec, cue.endSec)
    }
  }

  const acceptanceCriteria = (scenarioDef.acceptanceCriteria || []).map((ac) => {
    const span = criteriaById.get(ac.id)
    return {
      ...ac,
      timestampRange: span
        ? `${formatTimestamp(span.startSec)}–${formatTimestamp(span.endSec)}`
        : ac.timestampRange || '00:00',
    }
  })

  const commitSha = String(flags['commit-sha'] || gitValue(['rev-parse', 'HEAD']))
  const branch = String(flags.branch || gitValue(['rev-parse', '--abbrev-ref', 'HEAD']))

  let review = scenarioDef.review
  if (flags['review-file']) {
    const reviewPath = resolveInputPath(flags['review-file'])
    review = JSON.parse(readFileSync(reviewPath, 'utf8'))
  }

  const manifest = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    status: 'recorded',
    repository: String(flags.repo || detectRepository()),
    branch,
    commitSha,
    pullRequestNumber: prNumber,
    capturedAt: new Date().toISOString(),
    testEnvironment: String(flags.env || scenarioDef.testEnvironment || 'native-stack'),
    applicationRoutes:
      scenarioDef.applicationRoutes && scenarioDef.applicationRoutes.length > 0
        ? scenarioDef.applicationRoutes
        : captured.routesVisited,
    redactionConfirmed: true,
    acceptanceCriteria,
    assertionResults: scenarioDef.assertionResults || [],
    knownLimitations: scenarioDef.knownLimitations || [],
    recordings: [
      {
        title: scenarioDef.title || 'PR verification demonstration',
        videoUrl: flags['video-url'] ? String(flags['video-url']) : '',
        durationSeconds: composed.media.durationSeconds,
        width: composed.media.width,
        height: composed.media.height,
        fps: composed.media.fps,
        videoCodec: composed.media.videoCodec,
        audioCodec: composed.media.audioCodec,
        ttsProvider: captured.ttsProvider,
        narrated: true,
        captioned: true,
        artifacts: {
          renderedMp4: relative(REPO_ROOT, composed.outputMp4),
          rawFootage: relative(REPO_ROOT, captured.rawVideoPath),
          transcript: relative(REPO_ROOT, composed.transcriptPath),
          captionsSrt: relative(REPO_ROOT, composed.srtPath),
          captionsVtt: relative(REPO_ROOT, composed.vttPath),
          playwrightTrace: relative(REPO_ROOT, captured.tracePath),
          timeline: relative(REPO_ROOT, captured.timelinePath),
        },
      },
    ],
    ...(review ? { review } : {}),
  }

  const manifestPath = join(outDir, 'manifest.json')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  const markdown = renderPrEvidenceMarkdown(manifest)
  const markdownPath = join(outDir, 'pr-evidence.md')
  writeFileSync(markdownPath, markdown + '\n', 'utf8')

  const localValidation = validateManifest(manifest, {
    headSha: commitSha,
    requireVideoUrl: Boolean(flags['video-url']),
  })

  console.log(
    JSON.stringify(
      {
        ok: localValidation.valid,
        outputMp4: composed.outputMp4,
        manifestPath,
        markdownPath,
        reviewFrames: composed.reviewFrames,
        media: composed.media,
        ttsProvider: captured.ttsProvider,
        errors: localValidation.errors,
        warnings: localValidation.warnings,
      },
      null,
      2
    )
  )

  if (!localValidation.valid) {
    process.exit(1)
  }
}

function cmdRenderMarkdown(argv) {
  const { positionals, values: flags } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'upsert-body': { type: 'string' },
    },
  })
  const manifestFile = positionals[0]
  if (!manifestFile) {
    console.error('Usage: cli.mjs render-markdown <manifest.json> [--upsert-body <pr-body.md>]')
    process.exit(2)
  }
  const manifest = JSON.parse(readFileSync(resolveInputPath(manifestFile), 'utf8'))
  const rendered = renderPrEvidenceMarkdown(manifest)
  if (flags['upsert-body']) {
    const bodyPath = resolve(process.cwd(), flags['upsert-body'])
    const existing = existsSync(bodyPath) ? readFileSync(bodyPath, 'utf8') : ''
    const updated = upsertPrEvidenceBlock(existing, rendered)
    writeFileSync(bodyPath, updated + '\n', 'utf8')
    console.log(`Updated ${bodyPath}`)
  } else {
    process.stdout.write(rendered + '\n')
  }
}

function cmdValidate(argv) {
  const { values: flags } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      manifest: { type: 'string' },
      'pr-body-file': { type: 'string' },
      'head-sha': { type: 'string' },
      'pr-number': { type: 'string' },
      'base-ref': { type: 'string' },
      'head-ref': { type: 'string' },
      'head-repo': { type: 'string' },
      repo: { type: 'string' },
      draft: { type: 'string' },
      'changed-files': { type: 'string' },
      'allow-empty-video-url': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  })

  const rawHeadSha = flags['head-sha'] ?? process.env.PR_HEAD_SHA
  const headSha =
    rawHeadSha !== undefined ? String(rawHeadSha).trim() : gitValue(['rev-parse', 'HEAD'])
  const prNumber = parsePositiveInt(flags['pr-number'] ?? process.env.PR_NUMBER, '--pr-number')
  const baseRef = String(flags['base-ref'] ?? process.env.PR_BASE_REF ?? '')
  const headRef = String(flags['head-ref'] ?? process.env.PR_HEAD_REF ?? '')
  const repository = String(
    flags.repo ?? process.env.PR_REPO ?? process.env.GITHUB_REPOSITORY ?? ''
  )
  const headRepo = String(flags['head-repo'] ?? process.env.PR_HEAD_REPO ?? repository)
  const isDraft = String(flags.draft ?? process.env.PR_IS_DRAFT ?? 'false') === 'true'
  const requireVideoUrl = !flags['allow-empty-video-url']
  let changedFiles = []
  if (flags['changed-files']) {
    const raw = readFileSync(resolveInputPath(flags['changed-files']), 'utf8')
    changedFiles = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  }

  let result
  if (flags.manifest) {
    const manifest = JSON.parse(readFileSync(resolveInputPath(flags.manifest), 'utf8'))
    const res = validateManifest(manifest, {
      headSha: headSha || undefined,
      prNumber,
      repository: repository || undefined,
      changedFiles,
      requireVideoUrl,
    })
    result = { ok: res.valid, errors: res.errors, warnings: res.warnings, manifest }
  } else {
    const prBody = flags['pr-body-file']
      ? readFileSync(resolveInputPath(flags['pr-body-file']), 'utf8')
      : process.env.PR_BODY || ''
    result = validatePrEvidence({
      prBody,
      headSha,
      prNumber,
      baseRef,
      headRef,
      headRepo,
      repository,
      isDraft,
      changedFiles,
      requireVideoUrl,
    })
  }

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2))
  } else if (result.ok) {
    if (result.exempt) {
      console.log(`pr-video-evidence PASS (exempt): ${result.reason}`)
    } else {
      console.log(
        `pr-video-evidence PASS: verified commit ${headSha ? headSha.slice(0, 12) : 'manifest'}.`
      )
    }
    for (const warning of result.warnings) {
      console.warn(`WARNING: ${warning}`)
    }
  } else {
    console.error('pr-video-evidence FAILED:')
    for (const err of result.errors) {
      console.error(`  - ${err}`)
    }
    for (const warning of result.warnings) {
      console.warn(`  WARNING: ${warning}`)
    }
  }

  if (!result.ok) process.exit(1)
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  switch (command) {
    case 'check-deps':
      cmdCheckDeps()
      break
    case 'setup-kokoro':
      cmdSetupKokoro()
      break
    case 'record':
      await cmdRecord(rest)
      break
    case 'render-markdown':
      cmdRenderMarkdown(rest)
      break
    case 'validate':
      cmdValidate(rest)
      break
    default:
      console.error(
        'Usage: dev/pr-video-evidence/cli.mjs <check-deps|setup-kokoro|record|render-markdown|validate> [options]'
      )
      process.exit(2)
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err))
  process.exit(1)
})
