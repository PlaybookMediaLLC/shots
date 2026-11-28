// Playwright capture, visual annotation overlay, synchronized beat runner,
// Shots auth helper, and terminal/backend view helper for PR video evidence.

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { detectSensitiveData } from './schema.mjs'

const execFileAsync = promisify(execFile)
const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(MODULE_DIR, '../..')

/**
 * Resolve the local cache directory for Kokoro ONNX venv and model files.
 */
export function resolveCacheDir() {
  return process.env.PR_VIDEO_EVIDENCE_CACHE_DIR
    ? resolve(process.env.PR_VIDEO_EVIDENCE_CACHE_DIR)
    : join(process.env.HOME || '/tmp', '.cache/shots-pr-evidence')
}

/**
 * Resolve Playwright from the repository's `clients/node_modules` workspace so
 * scripts can run from any working directory without global installs.
 */
export function loadPlaywright() {
  const candidates = [
    join(REPO_ROOT, 'clients/node_modules/playwright/index.js'),
    join(REPO_ROOT, 'clients/apps/web/package.json'),
    join(REPO_ROOT, 'clients/package.json'),
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      const req = createRequire(candidate)
      return req('playwright')
    } catch {
      // Try next candidate
    }
  }
  const req = createRequire(import.meta.url)
  return req('playwright')
}

/**
 * Resolve the Python interpreter to use for `tts.py` (preferring the cached
 * Kokoro ONNX venv when present).
 */
export function resolveTtsPython() {
  const venvPython = join(resolveCacheDir(), 'venv/bin/python')
  if (existsSync(venvPython)) return venvPython
  return process.env.PR_VIDEO_EVIDENCE_PYTHON || 'python3'
}

/**
 * Validate cue IDs and narration text before synthesizing audio.
 *
 * @param {Array<{ id: string, text: string }>} cues
 */
export function assertValidCues(cues) {
  if (!Array.isArray(cues) || cues.length === 0) {
    throw new Error('Storyboard must contain at least one narration cue.')
  }
  const seenIds = new Set()
  for (const cue of cues) {
    const id = String(cue.id || '').trim()
    const text = String(cue.text || '').trim()
    if (!id) throw new Error('Every narration cue must have a non-empty id.')
    if (seenIds.has(id)) throw new Error(`Duplicate narration cue id "${id}".`)
    seenIds.add(id)
    if (!text) throw new Error(`Narration cue "${id}" has empty text.`)
    const secrets = detectSensitiveData(text)
    if (secrets.length > 0) {
      throw new Error(
        `Refusing to synthesize narration cue "${id}": potential secret detected (${secrets.join(', ')}).`
      )
    }
  }
}

/**
 * Synthesize all narration cues asynchronously ahead of capture and read the
 * structured `segments.json` written by `tts.py` (tolerating any noisy stdout
 * warnings from native runtimes).
 *
 * @param {Array<{ id: string, text: string }>} cues
 * @param {{ outDir: string, provider?: string, voice?: string, speed?: number }} options
 */
export async function synthesizeNarration(cues, options) {
  assertValidCues(cues)

  mkdirSync(options.outDir, { recursive: true })
  const cuesPath = join(options.outDir, 'cues.json')
  writeFileSync(cuesPath, JSON.stringify(cues, null, 2) + '\n', 'utf8')

  const pythonBin = resolveTtsPython()
  const ttsScript = join(MODULE_DIR, 'tts.py')
  const args = [
    ttsScript,
    '--cues',
    cuesPath,
    '--out-dir',
    options.outDir,
    '--provider',
    options.provider || 'kokoro',
    '--voice',
    options.voice || 'af_heart',
    '--speed',
    String(options.speed ?? 0.98),
  ]

  await execFileAsync(pythonBin, args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })
  const segmentsPath = join(options.outDir, 'segments.json')
  return JSON.parse(readFileSync(segmentsPath, 'utf8'))
}

/**
 * Browser-side visual annotation overlay script injected via `addInitScript`.
 * Uses static crisp bounding-box styling (avoiding infinite non-composited
 * box-shadow repaints during static narration holds) plus visible cursor
 * travel, click ripple indicator, directional arrow, numbered callout badge,
 * optional spotlight scrim, smart non-obscuring label, and restrained zoom.
 */
const OVERLAY_INIT_SCRIPT = () => {
  const ROOT_ID = '__shots_pr_evidence_overlay__'
  const STYLE_ID = '__shots_pr_evidence_style__'

  function ensureOverlay() {
    if (!document.documentElement) return null
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
        @keyframes __shots_ev_enter {
          0% { opacity: 0; transform: scale(0.985); }
          100% { opacity: 1; transform: scale(1); }
        }
        @keyframes __shots_ev_ripple {
          0% { transform: translate(-50%, -50%) scale(0.35); opacity: 0.95; }
          100% { transform: translate(-50%, -50%) scale(1.9); opacity: 0; }
        }
        #${ROOT_ID} {
          position: fixed;
          inset: 0;
          pointer-events: none;
          z-index: 2147483646;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "DejaVu Sans", sans-serif;
        }
        #${ROOT_ID} .__ev_scrim {
          position: fixed;
          background: rgba(15, 23, 42, 0.34);
          transition: opacity 200ms ease;
        }
        #${ROOT_ID} .__ev_box {
          position: fixed;
          border-radius: 8px;
          border: 3px solid #2563eb;
          box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.24);
          animation: __shots_ev_enter 200ms ease-out forwards;
          box-sizing: border-box;
        }
        #${ROOT_ID} .__ev_label {
          position: fixed;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          max-width: 520px;
          padding: 7px 12px;
          border-radius: 8px;
          background: rgba(15, 23, 42, 0.92);
          color: #f8fafc;
          font-size: 14px;
          font-weight: 600;
          line-height: 1.3;
          letter-spacing: 0.01em;
          box-shadow: 0 8px 24px rgba(15, 23, 42, 0.28);
          border: 1px solid rgba(148, 163, 184, 0.35);
          animation: __shots_ev_enter 200ms ease-out forwards;
        }
        #${ROOT_ID} .__ev_badge {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 22px;
          height: 22px;
          padding: 0 6px;
          border-radius: 999px;
          background: #2563eb;
          color: #ffffff;
          font-size: 12px;
          font-weight: 700;
        }
        #${ROOT_ID} .__ev_cursor {
          position: fixed;
          left: 0;
          top: 0;
          width: 24px;
          height: 24px;
          transform: translate3d(960px, 540px, 0);
          transition: transform 280ms cubic-bezier(0.22, 1, 0.36, 1);
          filter: drop-shadow(0 2px 4px rgba(15, 23, 42, 0.45));
          z-index: 2147483647;
        }
        #${ROOT_ID} .__ev_ripple {
          position: fixed;
          width: 34px;
          height: 34px;
          border-radius: 999px;
          border: 3px solid #2563eb;
          background: rgba(37, 99, 235, 0.16);
          animation: __shots_ev_ripple 520ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
        }
        #${ROOT_ID} .__ev_arrow {
          position: fixed;
          width: 44px;
          height: 44px;
          filter: drop-shadow(0 2px 6px rgba(15, 23, 42, 0.35));
          animation: __shots_ev_enter 200ms ease-out forwards;
        }
      `
      ;(document.head || document.documentElement).appendChild(style)
    }

    let root = document.getElementById(ROOT_ID)
    if (!root) {
      root = document.createElement('div')
      root.id = ROOT_ID
      const cursor = document.createElement('div')
      cursor.className = '__ev_cursor'
      cursor.innerHTML =
        '<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><path d="M4 2.5L20 12.2L12.6 13.7L9.3 20.8L4 2.5Z" fill="#0f172a" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/></svg>'
      root.appendChild(cursor)
      document.documentElement.appendChild(root)
    }
    return root
  }

  function clearAnnotations() {
    const root = document.getElementById(ROOT_ID)
    if (root) {
      for (const el of Array.from(root.children)) {
        if (!el.classList.contains('__ev_cursor')) el.remove()
      }
    }
    if (document.body) {
      document.body.style.transition = 'transform 420ms cubic-bezier(0.22, 1, 0.36, 1)'
      document.body.style.transform = ''
      document.body.style.transformOrigin = ''
    }
  }

  function moveCursor(x, y) {
    const root = ensureOverlay()
    if (!root) return
    const cursor = root.querySelector('.__ev_cursor')
    if (cursor) {
      cursor.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`
    }
  }

  function clickRipple(x, y) {
    const root = ensureOverlay()
    if (!root) return
    moveCursor(x, y)
    const ripple = document.createElement('div')
    ripple.className = '__ev_ripple'
    ripple.style.left = `${Math.round(x)}px`
    ripple.style.top = `${Math.round(y)}px`
    root.appendChild(ripple)
    setTimeout(() => ripple.remove(), 600)
  }

  function highlightRect(rect, options = {}) {
    const root = ensureOverlay()
    if (!root) return
    clearAnnotations()

    const pad = options.padding ?? 6
    const vw = window.innerWidth
    const vh = window.innerHeight
    const left = Math.max(4, rect.x - pad)
    const top = Math.max(4, rect.y - pad)
    const width = Math.min(vw - left - 4, rect.width + pad * 2)
    const height = Math.min(vh - top - 4, rect.height + pad * 2)

    if (options.spotlight) {
      const scrims = [
        { left: 0, top: 0, width: vw, height: top },
        { left: 0, top: top + height, width: vw, height: Math.max(0, vh - (top + height)) },
        { left: 0, top, width: left, height },
        { left: left + width, top, width: Math.max(0, vw - (left + width)), height },
      ]
      for (const s of scrims) {
        if (s.width <= 0 || s.height <= 0) continue
        const div = document.createElement('div')
        div.className = '__ev_scrim'
        div.style.left = `${Math.round(s.left)}px`
        div.style.top = `${Math.round(s.top)}px`
        div.style.width = `${Math.round(s.width)}px`
        div.style.height = `${Math.round(s.height)}px`
        root.appendChild(div)
      }
    }

    const box = document.createElement('div')
    box.className = '__ev_box'
    box.style.left = `${Math.round(left)}px`
    box.style.top = `${Math.round(top)}px`
    box.style.width = `${Math.round(width)}px`
    box.style.height = `${Math.round(height)}px`
    root.appendChild(box)

    if (options.label || options.stepNumber != null) {
      const labelEl = document.createElement('div')
      labelEl.className = '__ev_label'
      if (options.stepNumber != null) {
        const badge = document.createElement('span')
        badge.className = '__ev_badge'
        badge.textContent = String(options.stepNumber)
        labelEl.appendChild(badge)
      }
      if (options.label) {
        const textSpan = document.createElement('span')
        textSpan.textContent = String(options.label)
        labelEl.appendChild(textSpan)
      }
      const preferAbove = top > 56
      const labelTop = preferAbove ? Math.max(12, top - 46) : Math.min(vh - 140, top + height + 12)
      const labelLeft = Math.max(16, Math.min(vw - 540, left))
      labelEl.style.left = `${Math.round(labelLeft)}px`
      labelEl.style.top = `${Math.round(labelTop)}px`
      root.appendChild(labelEl)
    }

    if (options.arrow) {
      const arrowEl = document.createElement('div')
      arrowEl.className = '__ev_arrow'
      const arrowLeft = Math.max(8, left - 42)
      const arrowTop = Math.max(8, top + height / 2 - 22)
      arrowEl.style.left = `${Math.round(arrowLeft)}px`
      arrowEl.style.top = `${Math.round(arrowTop)}px`
      arrowEl.innerHTML =
        '<svg viewBox="0 0 44 44" width="44" height="44" fill="none"><path d="M6 22H34M34 22L23 11M34 22L23 33" stroke="#2563eb" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      root.appendChild(arrowEl)
    }

    if (typeof options.zoom === 'number' && options.zoom > 1.01 && document.body) {
      const clampedZoom = Math.min(1.4, Math.max(1.05, options.zoom))
      const cx = Math.min(vw - 120, Math.max(120, left + width / 2))
      const cy = Math.min(vh - 140, Math.max(100, top + height / 2))
      document.body.style.transition = 'transform 460ms cubic-bezier(0.22, 1, 0.36, 1)'
      document.body.style.transformOrigin = `${Math.round(cx)}px ${Math.round(cy)}px`
      document.body.style.transform = `scale(${clampedZoom})`
    }
  }

  window.__shotsPrEvidence = {
    ensureOverlay,
    clearAnnotations,
    moveCursor,
    clickRipple,
    highlightRect,
  }
}

/**
 * Load `STUDIO_DEV_PASSWORD` from `.local/dev.env` when not passed in env.
 */
export function readDevPassword() {
  if (process.env.STUDIO_DEV_PASSWORD) return process.env.STUDIO_DEV_PASSWORD
  const devEnv = join(REPO_ROOT, '.local/dev.env')
  if (!existsSync(devEnv)) return ''
  const lines = readFileSync(devEnv, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    if (line.startsWith('STUDIO_DEV_PASSWORD=')) {
      return line.slice('STUDIO_DEV_PASSWORD='.length).trim()
    }
  }
  return ''
}

/**
 * Orchestrates a synchronized, visually annotated Playwright evidence capture.
 */
export class EvidenceRecorder {
  /**
   * @param {{
   *   outDir: string,
   *   baseUrl?: string,
   *   ttsProvider?: string,
   *   ttsVoice?: string,
   *   ttsSpeed?: number,
   *   width?: number,
   *   height?: number,
   * }} options
   */
  constructor(options) {
    const rawBaseUrl = (options.baseUrl || 'http://localhost:3000').replace(/\/+$/, '')
    let parsedBaseUrl
    try {
      parsedBaseUrl = new URL(rawBaseUrl)
    } catch {
      throw new Error(`Invalid baseUrl "${rawBaseUrl}": expected an http(s):// URL.`)
    }
    this.outDir = resolve(options.outDir)
    this.rawDir = join(this.outDir, 'raw')
    this.audioDir = join(this.outDir, 'audio')
    this.baseUrl = rawBaseUrl
    this.baseOrigin = parsedBaseUrl.origin
    this.ttsProvider = options.ttsProvider || 'kokoro'
    this.ttsVoice = options.ttsVoice || 'af_heart'
    this.ttsSpeed = options.ttsSpeed ?? 0.98
    this.width = options.width || 1920
    this.height = options.height || 1080
    this.browser = null
    this.context = null
    this.page = null
    this.storageState = {
      cookies: [],
      origins: [
        {
          origin: this.baseOrigin,
          localStorage: [{ name: 'shots-consent', value: '{"analytics":false,"ads":false}' }],
        },
      ],
    }
    this.recordingStartMs = 0
    this.tracingActive = false
    this.timeline = []
    this.routesVisited = new Set()
    this.ttsResult = null
  }

  /**
   * Open headless Chromium and a non-recording preparation context so scenarios
   * can authenticate and warm up Next.js routes without adding dead frames to
   * the final video.
   */
  async openBrowser() {
    mkdirSync(this.rawDir, { recursive: true })
    mkdirSync(this.audioDir, { recursive: true })
    const { chromium } = loadPlaywright()
    const envExec = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    let executablePath = envExec && existsSync(envExec) ? envExec : undefined
    if (!executablePath && !existsSync(chromium.executablePath())) {
      const fallbacks = [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
      ]
      executablePath = fallbacks.find((candidate) => existsSync(candidate))
    }
    this.browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ['--font-render-hinting=none'],
    })
    this.context = await this.browser.newContext({
      viewport: { width: this.width, height: this.height },
      deviceScaleFactor: 1,
      storageState: this.storageState,
    })
    this.page = await this.context.newPage()
    return this.page
  }

  /**
   * Persist cookies/localStorage from the warmup context and close it to free
   * Chromium renderer memory before loading the Kokoro ONNX TTS model.
   */
  async closeWarmupContext() {
    if (!this.context || this.recordingStartMs > 0) return
    try {
      this.storageState = await this.context.storageState()
    } finally {
      const ctx = this.context
      this.context = null
      this.page = null
      await ctx.close().catch(() => {})
    }
  }

  /**
   * Pre-synthesize all beat narration WAV files asynchronously before recording
   * begins so TTS latency never introduces silent blank frames into the capture.
   *
   * @param {Array<{ id?: string, narration: string }>} beats
   */
  async preSynthesize(beats) {
    if (!Array.isArray(beats) || beats.length === 0) {
      throw new Error('Storyboard must contain at least one beat.')
    }
    this.ttsResult = await synthesizeNarration(
      beats.map((b, i) => ({ id: b.id || `beat-${i + 1}`, text: b.narration })),
      {
        outDir: this.audioDir,
        provider: this.ttsProvider,
        voice: this.ttsVoice,
        speed: this.ttsSpeed,
      }
    )
    return this.ttsResult
  }

  /**
   * Open the 1920x1080 recording + tracing context carrying forward the warmup
   * cookies and localStorage.
   */
  async startRecording() {
    if (!this.browser) {
      await this.openBrowser()
    }
    await this.closeWarmupContext()
    this.context = await this.browser.newContext({
      viewport: { width: this.width, height: this.height },
      deviceScaleFactor: 1,
      storageState: this.storageState,
      recordVideo: {
        dir: this.rawDir,
        size: { width: this.width, height: this.height },
      },
    })
    await this.context.addInitScript(OVERLAY_INIT_SCRIPT)
    // Disable duplicate JPEG screencast frames in trace.zip because full
    // 1920x1080 footage is already recorded to raw/*.webm and review-frames/.
    await this.context.tracing.start({ screenshots: false, snapshots: true, sources: true })
    this.tracingActive = true
    this.page = await this.context.newPage()
    this.recordingStartMs = performance.now()
    return this.page
  }

  /**
   * Sign into the local Shots dev account through the cookie API (never typing
   * or displaying passwords on screen).
   */
  async signInDev({ email = 'dev@localhost.test', password = readDevPassword() } = {}) {
    if (!password) {
      throw new Error(
        'STUDIO_DEV_PASSWORD is missing. Run `dev/native-stack login` or set STUDIO_DEV_PASSWORD.'
      )
    }
    const res = await this.context.request.post(`${this.baseUrl}/api/auth/sign-in/email`, {
      data: { email, password },
      headers: { origin: this.baseUrl },
    })
    if (!res.ok()) {
      throw new Error(`Shots dev sign-in failed with HTTP ${res.status()}`)
    }
  }

  /**
   * Smoothly move the visible cursor to a locator and click with ripple.
   */
  async clickWithIndicator(locator, options = {}) {
    await locator.waitFor({ state: 'visible', timeout: options.timeout ?? 20_000 })
    const box = await locator.boundingBox()
    if (!box) throw new Error('Target element has no bounding box.')
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    await this.page.evaluate(([x, y]) => window.__shotsPrEvidence?.moveCursor(x, y), [cx, cy])
    await this.page.waitForTimeout(320)
    await this.page.evaluate(([x, y]) => window.__shotsPrEvidence?.clickRipple(x, y), [cx, cy])
    await locator.click(options)
    await this.page.waitForTimeout(180)
  }

  /**
   * Highlight a Playwright locator with bounding box, optional numbered badge,
   * arrow, spotlight scrim, label, and restrained zoom.
   */
  async highlightLocator(locator, options = {}) {
    await locator.waitFor({ state: 'visible', timeout: options.timeout ?? 20_000 })
    await locator.scrollIntoViewIfNeeded()
    const box = await locator.boundingBox()
    if (!box) return
    await this.page.evaluate(
      ([rect, opts]) => window.__shotsPrEvidence?.highlightRect(rect, opts),
      [box, options]
    )
    await this.page.evaluate(
      ([x, y]) => window.__shotsPrEvidence?.moveCursor(x, y),
      [box.x + box.width / 2, box.y + box.height / 2]
    )
  }

  async clearAnnotations() {
    await this.page.evaluate(() => window.__shotsPrEvidence?.clearAnnotations())
  }

  /**
   * Render a crisp, legible 1920x1080 terminal/API verification screen inside
   * Playwright for backend, Go, database, or CLI PRs without a web UI.
   */
  async renderTerminalView({
    title,
    subtitle,
    command,
    output,
    status = 'PASS',
    highlightLines = [],
  }) {
    const secrets = detectSensitiveData(`${command}\n${output}`)
    if (secrets.length > 0) {
      throw new Error(
        `Refusing to display terminal output containing potential secret: ${secrets.join(', ')}`
      )
    }
    const escaped = (s) =>
      String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
    const outputLines = String(output ?? '')
      .split(/\r?\n/)
      .map((line, idx) => {
        const isHl = highlightLines.includes(idx + 1)
        const cls = isHl ? 'line hl' : 'line'
        return `<div class="${cls}" data-line="${idx + 1}"><span class="ln">${String(idx + 1).padStart(3, ' ')}</span><span class="tx">${escaped(line)}</span></div>`
      })
      .join('')

    await this.page.setContent(`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 1920px; height: 1080px; background: #0b1120; color: #e2e8f0;
    font-family: "DejaVu Sans", -apple-system, BlinkMacSystemFont, sans-serif;
    padding: 48px 64px 136px 64px; display: flex; flex-direction: column; gap: 20px;
  }
  .header { display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #1e293b; padding-bottom: 16px; }
  .title { font-size: 28px; font-weight: 700; color: #f8fafc; }
  .subtitle { font-size: 16px; color: #94a3b8; margin-top: 4px; }
  .status {
    padding: 8px 18px; border-radius: 999px; font-weight: 700; font-size: 15px;
    background: ${status === 'PASS' ? '#064e3b' : '#7f1d1d'};
    color: ${status === 'PASS' ? '#6ee7b7' : '#fecaca'};
    border: 1px solid ${status === 'PASS' ? '#10b981' : '#ef4444'};
  }
  .cmd {
    background: #111827; border: 1px solid #1f2937; border-radius: 10px; padding: 16px 20px;
    font-family: "DejaVu Sans Mono", ui-monospace, monospace; font-size: 18px; color: #93c5fd;
  }
  .term {
    flex: 1; background: #0f172a; border: 1px solid #1e293b; border-radius: 12px;
    padding: 20px; overflow: hidden;
    font-family: "DejaVu Sans Mono", ui-monospace, monospace; font-size: 16px; line-height: 1.55;
  }
  .line { display: flex; gap: 16px; padding: 2px 8px; border-radius: 4px; white-space: pre-wrap; word-break: break-word; }
  .line.hl { background: rgba(37, 99, 235, 0.25); border-left: 3px solid #3b82f6; color: #ffffff; font-weight: 600; }
  .ln { color: #64748b; user-select: none; min-width: 36px; text-align: right; }
</style>
</head>
<body>
  <div class="header" data-testid="terminal-header">
    <div>
      <div class="title">${escaped(title)}</div>
      <div class="subtitle">${escaped(subtitle)}</div>
    </div>
    <div class="status" data-testid="terminal-status">${escaped(status)}</div>
  </div>
  <div class="cmd" data-testid="terminal-command">$ ${escaped(command)}</div>
  <div class="term" data-testid="terminal-output">${outputLines}</div>
</body>
</html>`)
    await this.page.evaluate(OVERLAY_INIT_SCRIPT)
  }

  /**
   * Execute all storyboard beats with synchronized timing and visual annotations.
   *
   * @param {Array<{
   *   id: string,
   *   criterionId?: string,
   *   route?: string,
   *   narration: string,
   *   pauseAfterMs?: number,
   *   action: (helpers: {
   *     page: import('playwright').Page,
   *     recorder: EvidenceRecorder,
   *     baseUrl: string,
   *   }) => Promise<void>,
   * }>} beats
   */
  async runBeats(beats) {
    if (!Array.isArray(beats) || beats.length === 0) {
      throw new Error('Storyboard must contain at least one beat.')
    }

    if (!this.ttsResult) {
      await this.preSynthesize(beats)
    }

    const segmentsById = new Map(this.ttsResult.segments.map((seg) => [seg.id, seg]))

    for (let i = 0; i < beats.length; i++) {
      const beat = beats[i]
      const beatId = beat.id || `beat-${i + 1}`
      const segment = segmentsById.get(beatId)
      if (!segment) throw new Error(`Missing synthesized TTS segment for beat "${beatId}".`)

      const beatStartMs = performance.now()
      const startSec = Math.max(0, (beatStartMs - this.recordingStartMs) / 1000)
      const audioStartSec = startSec + 0.15

      if (beat.route) this.routesVisited.add(beat.route)

      await beat.action({
        page: this.page,
        recorder: this,
        baseUrl: this.baseUrl,
      })

      const pauseAfterSec = (beat.pauseAfterMs ?? 450) / 1000
      const targetEndMs = beatStartMs + (0.15 + segment.durationSeconds + pauseAfterSec) * 1000
      const remainingMs = Math.ceil(targetEndMs - performance.now())
      if (remainingMs > 0) {
        await this.page.waitForTimeout(remainingMs)
      }

      const endSec = (performance.now() - this.recordingStartMs) / 1000
      this.timeline.push({
        index: i + 1,
        id: beatId,
        criterionId: beat.criterionId || null,
        route: beat.route || this.page.url(),
        text: beat.narration.trim(),
        audioPath: segment.audioPath,
        audioDurationSeconds: segment.durationSeconds,
        startSec: Number(startSec.toFixed(3)),
        audioStartSec: Number(audioStartSec.toFixed(3)),
        endSec: Number(endSec.toFixed(3)),
      })
    }

    await this.clearAnnotations()
    await this.page.waitForTimeout(400)
  }

  /**
   * Finalize Playwright tracing and video capture safely, guaranteeing browser
   * shutdown even when context closure or video retrieval fails.
   */
  async finish() {
    const tracePath = join(this.rawDir, 'trace.zip')
    const video = this.page ? this.page.video() : null
    let rawVideoPath = null

    try {
      if (this.context) {
        const ctx = this.context
        this.context = null
        this.page = null
        if (this.tracingActive) {
          this.tracingActive = false
          await ctx.tracing.stop({ path: tracePath }).catch(() => {})
        }
        await ctx.close().catch(() => {})
      }
      if (video) {
        rawVideoPath = await video.path().catch(() => null)
      }
    } finally {
      if (this.browser) {
        const browser = this.browser
        this.browser = null
        await browser.close().catch(() => {})
      }
    }

    const totalDurationSeconds =
      this.recordingStartMs > 0
        ? Number(((performance.now() - this.recordingStartMs) / 1000).toFixed(3))
        : 0
    const timelinePath = join(this.outDir, 'timeline.json')
    if (this.recordingStartMs > 0) {
      writeFileSync(
        timelinePath,
        JSON.stringify(
          {
            ttsProvider: this.ttsResult?.provider ?? this.ttsProvider,
            ttsVoice: this.ttsResult?.voice ?? this.ttsVoice,
            totalDurationSeconds,
            routesVisited: [...this.routesVisited],
            cues: this.timeline,
          },
          null,
          2
        ) + '\n',
        'utf8'
      )
    }

    return {
      rawVideoPath,
      tracePath,
      timelinePath,
      ttsProvider: this.ttsResult?.provider ?? this.ttsProvider,
      totalDurationSeconds,
      routesVisited: [...this.routesVisited],
      cues: this.timeline,
    }
  }
}
