import 'server-only'

import { type Browser, chromium } from 'playwright-core'
import { GOOGLE_FONT_ORIGINS } from '@/lib/typography/google-fonts'
import { createRenderToken } from './render-token'
import type { DesignDocument } from './document'
import { RENDER_FRAME_PATH, type RenderResponse } from '@/lib/render/protocol'

/**
 * Headless renderer for design documents.
 *
 * Opens the chrome-free render page in Chromium, waits for the editor stage to
 * report ready, and runs the editor's own export in the page, so a rendered
 * design is the same PNG the editor's Export button would produce.
 *
 * Enable with PLATFORM_DESIGN_RENDERER=enabled. With PLATFORM_RENDER_CDP_URL
 * the browser is remote, reached over the Chrome DevTools Protocol: Cloudflare
 * Browser Rendering in production (authorized by PLATFORM_RENDER_CDP_TOKEN),
 * or the Compose headless Chrome locally. Without it, Chromium runs in this
 * process (`npx playwright install chromium` or PLATFORM_RENDER_CHROMIUM_PATH).
 * Either way the browser opens the app at PLATFORM_RENDER_BASE_URL (default:
 * the public app URL), so a remote browser must be able to reach it.
 */

const RENDER_TIMEOUT_MS = 60_000
const LOCAL_IDLE_TTL_MS = 60_000
const CDP_IDLE_TTL_MS = 30_000
export const KIT_ASSET_PREFIX = '/__kit-asset/'

function maxRenderConcurrency(): number {
  const parsed = Number.parseInt(process.env.PLATFORM_RENDER_CONCURRENCY ?? '', 10)
  if (!Number.isFinite(parsed) || parsed < 1) return 4
  return Math.min(8, parsed)
}

/** Bounded semaphore gating concurrent headless render pages across the process. */
export class RenderSemaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly getLimit: () => number = maxRenderConcurrency) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.getLimit()) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    } else {
      this.active += 1
    }
    try {
      return await task()
    } finally {
      const next = this.waiters.shift()
      if (next) {
        // Transfer the permit directly to the next queued waiter without dropping active.
        next()
      } else {
        this.active -= 1
      }
    }
  }
}

const renderSemaphore = new RenderSemaphore()

/** A strict check refused an artboard (a missing font or image, overflowing copy). */
export class CanvasPrintRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CanvasPrintRefusedError'
  }
}

export function isDesignRendererAvailable(): boolean {
  return process.env.PLATFORM_DESIGN_RENDERER === 'enabled'
}

let readiness: { expiresAt: number; ready: boolean } | null = null

/**
 * Whether renders can run right now (cached briefly). A local CDP browser
 * answers /json/version; Cloudflare opens a billed session on connect, so it
 * is trusted until a render fails. Callers fall back to sharp product shots
 * when this is false.
 */
export async function isDesignRendererReady(): Promise<boolean> {
  if (!isDesignRendererAvailable()) return false
  const cdpUrl = process.env.PLATFORM_RENDER_CDP_URL
  if (!cdpUrl?.startsWith('http')) return true
  if (readiness && readiness.expiresAt > Date.now()) return readiness.ready
  const ready = await fetch(new URL('/json/version', cdpUrl), {
    signal: AbortSignal.timeout(8_000),
  })
    .then((response) => response.ok)
    .catch(() => false)
  readiness = { expiresAt: Date.now() + (ready ? 30_000 : 10_000), ready }
  return ready
}

function getRenderBaseUrl(): string {
  return (
    process.env.PLATFORM_RENDER_BASE_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    `http://localhost:${process.env.PORT ?? 3000}`
  )
}

export type DesignRenderOptions = {
  /** Default `png`. JPEG suits previews and photo-heavy designs. */
  format?: 'jpeg' | 'png' | 'webp'
  /** Multiple of the aspect ratio's base size. Default 2, the editor's export default. */
  scale?: 1 | 2 | 3
}

export type RenderedDesign = {
  bytes: Buffer
  height: number
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp'
  width: number
}

export type SnapshotLocalAsset = {
  bytes: Buffer
  mediaType: string
}

export type DesignRenderer = {
  close: () => Promise<void>
  /** Render an immutable document with owned media already resolved to pinned bytes or local assets. */
  renderSnapshot: (
    document: DesignDocument,
    localAssets?: ReadonlyMap<string, SnapshotLocalAsset>
  ) => Promise<RenderedDesign>
  render: (
    designId: string,
    organizationId: string,
    options?: DesignRenderOptions
  ) => Promise<RenderedDesign>
  /** Print canvas artboards to one PDF, a page per artboard at its own size. */
  printCanvas: (canvasId: string, organizationId: string, artboardIds: string[]) => Promise<Buffer>
  /** Render one slide of a Code Studio project (RFC 053) as a PNG, as the studio exports it. */
  renderCode: (
    projectId: string,
    organizationId: string,
    options: { slide: number; scale: 1 | 2 | 3 }
  ) => Promise<RenderedDesign>
}

type ExportResult = { base64: string; height: number; mediaType?: string; width: number }

function toRenderedDesign(result: ExportResult, options: DesignRenderOptions): RenderedDesign {
  return {
    bytes: Buffer.from(result.base64, 'base64'),
    height: result.height,
    mediaType: `image/${options.format ?? 'png'}` as RenderedDesign['mediaType'],
    width: result.width,
  }
}

function renderPageUrl(
  designId: string,
  organizationId: string,
  options: DesignRenderOptions
): URL {
  const url = new URL(`/render/${designId}`, getRenderBaseUrl())
  url.searchParams.set('token', createRenderToken(designId, organizationId))
  url.searchParams.set('format', options.format ?? 'png')
  url.searchParams.set('scale', String(options.scale ?? 2))
  return url
}

function openBrowser(): Promise<Browser> {
  const cdpUrl = process.env.PLATFORM_RENDER_CDP_URL
  if (cdpUrl) {
    const token = process.env.PLATFORM_RENDER_CDP_TOKEN
    return chromium.connectOverCDP(cdpUrl, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      timeout: RENDER_TIMEOUT_MS,
    })
  }
  return chromium.launch({
    executablePath: process.env.PLATFORM_RENDER_CHROMIUM_PATH || undefined,
    headless: true,
  })
}

interface PooledBrowserState {
  browserPromise: Promise<Browser> | null
  configKey: string
  idleTimer: ReturnType<typeof setTimeout> | null
  leases: number
}

const pool: PooledBrowserState = {
  browserPromise: null,
  configKey: '',
  idleTimer: null,
  leases: 0,
}

function currentPoolConfigKey(): string {
  return `${process.env.PLATFORM_RENDER_CDP_URL ?? ''}|${process.env.PLATFORM_RENDER_CHROMIUM_PATH ?? ''}`
}

function clearPoolIdleTimer() {
  if (pool.idleTimer) {
    clearTimeout(pool.idleTimer)
    pool.idleTimer = null
  }
}

function schedulePoolIdleClose() {
  clearPoolIdleTimer()
  if (pool.leases > 0 || !pool.browserPromise) return
  const ttl = process.env.PLATFORM_RENDER_CDP_URL ? CDP_IDLE_TTL_MS : LOCAL_IDLE_TTL_MS
  pool.idleTimer = setTimeout(() => {
    pool.idleTimer = null
    if (pool.leases === 0) void closeDesignRendererPool()
  }, ttl)
  // Unref so idle warm browsers never keep short-lived test or CLI processes alive.
  pool.idleTimer.unref?.()
}

/** Close any idle or active pooled Chromium/CDP browser instance. */
export async function closeDesignRendererPool(): Promise<void> {
  clearPoolIdleTimer()
  const pending = pool.browserPromise
  pool.browserPromise = null
  if (!pending) return
  try {
    const browser = await pending
    await browser.close().catch(() => undefined)
  } catch {
    // Browser failed to launch; nothing to close.
  }
}

async function acquirePooledBrowser(): Promise<Browser> {
  clearPoolIdleTimer()
  const key = currentPoolConfigKey()
  if (pool.browserPromise && pool.configKey !== key) {
    await closeDesignRendererPool()
  }
  while (pool.browserPromise) {
    const pending = pool.browserPromise
    try {
      const existing = await pending
      if (existing.isConnected()) return existing
      await existing.close().catch(() => undefined)
    } catch {
      // Previous launch failed; replace below if still the active slot.
    }
    if (pool.browserPromise === pending) {
      pool.browserPromise = null
    }
  }
  pool.configKey = key
  const launched = openBrowser()
  pool.browserPromise = launched
  try {
    return await launched
  } catch (error) {
    if (pool.browserPromise === launched) pool.browserPromise = null
    throw error
  }
}

function decodeKitAssetId(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname.slice(KIT_ASSET_PREFIX.length))
  } catch {
    return null
  }
}

/** Lease a pooled Chromium/CDP browser; each render gets a fresh isolated context under the concurrency cap. */
export async function createDesignRenderer(): Promise<DesignRenderer> {
  const baseUrl = new URL(getRenderBaseUrl())
  pool.leases += 1
  let closed = false
  try {
    await acquirePooledBrowser()
  } catch (error) {
    pool.leases = Math.max(0, pool.leases - 1)
    schedulePoolIdleClose()
    throw error
  }

  /** Run one render inside a semaphore permit with a fresh isolated browser context. */
  async function withPage<T>(
    work: (page: Awaited<ReturnType<Browser['newPage']>>) => Promise<T>,
    options: {
      externalFonts?: boolean
      localAssets?: ReadonlyMap<string, SnapshotLocalAsset>
    } = {}
  ): Promise<T> {
    const { externalFonts = true, localAssets } = options
    pool.leases += 1
    try {
      return await renderSemaphore.run(async () => {
        const browser = await acquirePooledBrowser()
        const context = await browser.newContext({
          deviceScaleFactor: 1,
          viewport: { height: 1400, width: 2200 },
        })
        try {
          const page = await context.newPage()
          const allowedAssetOrigins = new Set<string>([
            'https://assets.screenshot-studio.com',
            'https://shots-assets.oppulence.io',
          ])
          const configuredR2 = process.env.NEXT_PUBLIC_R2_PUBLIC_URL?.trim()
          if (configuredR2) {
            try {
              allowedAssetOrigins.add(
                new URL(configuredR2.includes('://') ? configuredR2 : `https://${configuredR2}`)
                  .origin
              )
            } catch {
              // Ignore malformed override.
            }
          }
          // Only the app itself, its static R2 asset CDN, local pinned snapshot assets, and Google Fonts:
          // no analytics or ad scripts in a render.
          await page.route('**/*', (route) => {
            const url = new URL(route.request().url())
            if (
              localAssets &&
              url.origin === baseUrl.origin &&
              url.pathname.startsWith(KIT_ASSET_PREFIX)
            ) {
              const assetId = decodeKitAssetId(url.pathname)
              const pinned = assetId !== null ? localAssets.get(assetId) : undefined
              if (pinned) {
                return route.fulfill({
                  body: pinned.bytes,
                  contentType: pinned.mediaType,
                  status: 200,
                })
              }
              return route.fulfill({ status: 404 })
            }
            return url.protocol === 'data:' ||
              url.protocol === 'blob:' ||
              url.origin === baseUrl.origin ||
              allowedAssetOrigins.has(url.origin) ||
              (externalFonts && (GOOGLE_FONT_ORIGINS as readonly string[]).includes(url.origin))
              ? route.continue()
              : route.abort()
          })
          return await work(page)
        } finally {
          await context.close().catch(() => undefined)
        }
      })
    } finally {
      pool.leases = Math.max(0, pool.leases - 1)
      schedulePoolIdleClose()
    }
  }

  return {
    close: async () => {
      if (closed) return
      closed = true
      pool.leases = Math.max(0, pool.leases - 1)
      schedulePoolIdleClose()
    },
    renderSnapshot: async (document, localAssets) =>
      withPage(
        async (page) => {
          await page.addInitScript(() => {
            window.addEventListener('message', (event: MessageEvent<RenderResponse>) => {
              if (
                event.source === window &&
                event.origin === location.origin &&
                event.data.type === 'ready'
              )
                window.document.documentElement.dataset.renderReady = 'true'
            })
          })
          const response = await page.goto(new URL(RENDER_FRAME_PATH, baseUrl).toString(), {
            timeout: RENDER_TIMEOUT_MS,
          })
          if (!response?.ok()) throw new Error('Snapshot render page is unavailable.')
          await page.waitForFunction(
            () => window.document.documentElement.dataset.renderReady === 'true',
            undefined,
            { timeout: RENDER_TIMEOUT_MS }
          )
          const result = await page.evaluate(
            ({ serializedDocument, timeout }) =>
              new Promise<ExportResult>((resolve, reject) => {
                const id = crypto.randomUUID()
                const timer = setTimeout(() => {
                  window.removeEventListener('message', listener.receive)
                  reject(new Error('Snapshot rendering timed out.'))
                }, timeout)
                const listener = {
                  receive(event: MessageEvent<RenderResponse>) {
                    if (
                      event.source !== window ||
                      event.origin !== location.origin ||
                      !('id' in event.data) ||
                      event.data.id !== id
                    )
                      return
                    if (event.data.type !== 'error' && event.data.type !== 'result') return
                    clearTimeout(timer)
                    window.removeEventListener('message', listener.receive)
                    if (event.data.type === 'error') {
                      reject(new Error(event.data.message))
                      return
                    }
                    const { blob, width, height } = event.data
                    const reader = new FileReader()
                    reader.onerror = () => reject(new Error('Snapshot bytes could not be read.'))
                    reader.onload = () =>
                      resolve({ base64: String(reader.result).split(',')[1], width, height })
                    reader.readAsDataURL(blob)
                  },
                }
                window.addEventListener('message', listener.receive)
                window.postMessage(
                  {
                    type: 'render',
                    id,
                    document: JSON.parse(serializedDocument),
                    output: { format: 'png', scale: 1, strict: true },
                  },
                  location.origin
                )
              }),
            { serializedDocument: JSON.stringify(document), timeout: RENDER_TIMEOUT_MS }
          )
          return toRenderedDesign(result, { format: 'png' })
        },
        { externalFonts: false, localAssets }
      ),
    printCanvas: async (canvasId, organizationId, artboardIds) =>
      withPage(async (page) => {
        const url = new URL(`/render/canvas/${canvasId}`, getRenderBaseUrl())
        url.searchParams.set('token', createRenderToken(`canvas:${canvasId}`, organizationId))
        url.searchParams.set('ids', artboardIds.join(','))
        const response = await page.goto(url.toString(), { timeout: RENDER_TIMEOUT_MS })
        if (!response?.ok())
          throw new Error(`Print page returned ${response?.status() ?? 'no response'}.`)
        await page.waitForFunction(
          () => window.__canvasPrintReady === true || Boolean(window.__canvasPrintError),
          undefined,
          { timeout: RENDER_TIMEOUT_MS * Math.max(1, Math.ceil(artboardIds.length / 4)) }
        )
        const failure = await page.evaluate(() => window.__canvasPrintError)
        if (failure) throw new CanvasPrintRefusedError(failure)
        // Each artboard is a named page at its own size; text and shapes stay vector.
        return await page.pdf({ preferCSSPageSize: true, printBackground: true })
      }),
    renderCode: async (projectId, organizationId, { slide, scale }) =>
      withPage(async (page) => {
        const url = new URL(`/render/code/${projectId}`, getRenderBaseUrl())
        url.searchParams.set('token', createRenderToken(`code:${projectId}`, organizationId))
        url.searchParams.set('slide', String(slide))
        url.searchParams.set('scale', String(scale))
        const response = await page.goto(url.toString(), { timeout: RENDER_TIMEOUT_MS })
        if (!response?.ok())
          throw new Error(`Code render page returned ${response?.status() ?? 'no response'}.`)
        await page.waitForFunction(() => window.__codeReady === true, undefined, {
          timeout: RENDER_TIMEOUT_MS,
        })
        return toRenderedDesign(await page.evaluate(() => window.__exportCode!()), {
          format: 'png',
        })
      }),
    render: async (designId, organizationId, options = {}) =>
      withPage(async (page) => {
        const response = await page.goto(
          renderPageUrl(designId, organizationId, options).toString(),
          {
            timeout: RENDER_TIMEOUT_MS,
          }
        )
        if (!response?.ok())
          throw new Error(`Render page returned ${response?.status() ?? 'no response'}.`)
        await page.waitForFunction(() => window.__designReady === true, undefined, {
          timeout: RENDER_TIMEOUT_MS,
        })
        return toRenderedDesign(await page.evaluate(() => window.__exportDesign!()), options)
      }),
  }
}
