import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { chromium } from 'playwright-core'

// Production renders in Cloudflare Browser Rendering over CDP. This drives the
// same code path against a local Chromium with a fake render page.
const cdpPort = 9339
const exported = Buffer.from('rendered-design')
let app: Server
let thirdParty: Server
let thirdPartyRequests = 0
let browser: ChildProcess | undefined
let profile: string
const renderQueries: URLSearchParams[] = []

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    )
  )
}

async function startBrowser(): Promise<void> {
  const args = [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
  ]
  // Ubuntu runners block Chromium's sandbox; Playwright's own launch also disables it.
  if (process.platform === 'linux') args.push('--no-sandbox')
  // Its own process group, so stopping it also stops Chrome's helper processes.
  browser = spawn(chromium.executablePath(), args, {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let output = ''
  browser.stderr?.on('data', (chunk) => (output = (output + chunk).slice(-2_000)))
  for (let attempt = 0; attempt < 100; attempt++) {
    const ready = await fetch(`http://127.0.0.1:${cdpPort}/json/version`)
      .then((response) => response.ok)
      .catch(() => false)
    if (ready) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Chromium did not expose CDP: ${output}`)
}

async function stopBrowser(): Promise<void> {
  if (!browser || browser.exitCode !== null || browser.signalCode !== null) return
  const exited = new Promise((resolve) => browser?.once('exit', resolve))
  process.kill(-browser.pid!, 'SIGKILL')
  await exited
}

before(async () => {
  profile = mkdtempSync(join(tmpdir(), 'design-renderer-'))
  thirdParty = createServer((_request, response) => {
    thirdPartyRequests++
    response.end()
  })
  const thirdPartyUrl = await listen(thirdParty)
  app = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://app.local')
    renderQueries.push(url.searchParams)
    response.setHeader('content-type', 'text/html')
    if (url.pathname.startsWith('/render/canvas/')) {
      // A print page: two named pages at their own sizes, or a strict-check refusal.
      response.end(
        url.pathname.endsWith('/broken')
          ? `<!doctype html><script>window.__canvasPrintError = 'Font failed to load: Missing.'</script>`
          : `<!doctype html><style>
              html, body { margin: 0 }
              @page { size: 1080px 1350px; margin: 0 }
              @page a0 { size: 1080px 1350px; margin: 0 }
              @page a1 { size: 1600px 900px; margin: 0 }
            </style>
            <div style="page: a0; width: 1080px; height: 1350px; break-after: page">Portrait</div>
            <div style="page: a1; width: 1600px; height: 900px">Landscape</div>
            <script>window.__canvasPrintReady = true</script>`
      )
      return
    }
    response.end(`<!doctype html><script>
      fetch(${JSON.stringify(thirdPartyUrl)}).catch(() => {})
      window.__exportDesign = async () => ({
        base64: ${JSON.stringify(exported.toString('base64'))},
        height: innerHeight,
        width: innerWidth,
      })
      window.__designReady = true
    </script>`)
  })
  process.env.PLATFORM_RENDER_BASE_URL = await listen(app)
  process.env.PLATFORM_RENDER_CDP_URL = `http://127.0.0.1:${cdpPort}`
  process.env.PLATFORM_DESIGN_RENDERER = 'enabled'
  await startBrowser()
})

after(async () => {
  await stopBrowser()
  app.close()
  thirdParty.close()
  // Chrome's child processes can still be writing to the profile as it exits.
  rmSync(profile, { force: true, maxRetries: 5, recursive: true, retryDelay: 200 })
})

test('renders over CDP, keeps the page on the app origin, and reconnects', async () => {
  const { createDesignRenderer, isDesignRendererReady } = await import('../lib/design/renderer')
  assert.equal(await isDesignRendererReady(), true)

  const renderer = await createDesignRenderer()
  try {
    const first = await renderer.render('design1', 'org1', { format: 'jpeg', scale: 1 })
    assert.deepEqual(first.bytes, exported)
    assert.equal(first.mediaType, 'image/jpeg')
    assert.deepEqual([first.width, first.height], [2200, 1400])
    assert.equal(renderQueries[0]?.get('format'), 'jpeg')
    assert.ok(renderQueries[0]?.get('token'))
    assert.equal(thirdPartyRequests, 0)

    // Cloudflare ends an idle session; the next render opens a new one.
    await stopBrowser()
    await startBrowser()
    const second = await renderer.render('design1', 'org1')
    assert.deepEqual(second.bytes, exported)
    assert.equal(second.mediaType, 'image/png')
  } finally {
    await renderer.close().catch(() => {})
  }
})

test('prints canvas artboards to one PDF, a page per artboard at its own size', async () => {
  const { CanvasPrintRefusedError, createDesignRenderer } = await import('../lib/design/renderer')
  const renderer = await createDesignRenderer()
  try {
    const pdf = (await renderer.printCanvas('c1', 'org1', ['a', 'b'])).toString('latin1')
    assert.ok(pdf.startsWith('%PDF-'))
    // Chromium writes 0.75 pt per CSS pixel.
    const pages = [...pdf.matchAll(/\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/g)].map(
      (match) => [Math.round(Number(match[1]) / 0.75), Math.round(Number(match[2]) / 0.75)]
    )
    // Page sizes round to Chromium's device units: within a pixel.
    const sorted = pages.sort((a, b) => a[0]! - b[0]!)
    assert.equal(sorted.length, 2)
    for (const [index, [width, height]] of [
      [1080, 1350],
      [1600, 900],
    ].entries()) {
      assert.ok(Math.abs(sorted[index]![0]! - width!) <= 1, `width ${sorted[index]}`)
      assert.ok(Math.abs(sorted[index]![1]! - height!) <= 1, `height ${sorted[index]}`)
    }
    const query = renderQueries.at(-1)
    assert.equal(query?.get('ids'), 'a,b')
    assert.ok(query?.get('token'))
    assert.equal(thirdPartyRequests, 0)
    await assert.rejects(renderer.printCanvas('broken', 'org1', ['a']), CanvasPrintRefusedError)
  } finally {
    await renderer.close().catch(() => {})
  }
})
