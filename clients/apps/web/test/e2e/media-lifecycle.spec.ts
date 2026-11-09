import sharp from 'sharp'
import { expect, test, type Page } from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

async function holdImages(page: Page) {
  await page.addInitScript({
    content: `
    window.__heldImages = 0;
    window.__terminatedImages = 0;
    window.__holdImages = true;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      postMessage(message, ...args) {
        if (message?.file && window.__holdImages) { window.__heldImages++; return; }
        return super.postMessage(message, ...args);
      }
      terminate() { window.__terminatedImages++; return super.terminate(); }
    };
  `,
  })
}
const png = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#336699' } })
    .png()
    .toBuffer()

test('crop replacement cancels old work and downloads only the new source with its own name', async ({
  app,
  page,
}) => {
  await holdImages(page)
  await app.open('/crop-image')
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'first.png', mimeType: 'image/png', buffer: await png(200, 100) })
  await page.getByRole('button', { name: /^Crop to / }).click()
  await expect.poll(() => page.evaluate('window.__heldImages')).toBe(1)
  await page.getByLabel('Width', { exact: true }).fill('40')
  await expect.poll(() => page.evaluate('window.__terminatedImages')).toBe(1)
  await expect(page.getByRole('button', { name: /^Crop to / })).toBeEnabled()
  await page.getByRole('button', { name: 'Choose another image', exact: true }).click()
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'second.png', mimeType: 'image/png', buffer: await png(80, 60) })
  await expect(page.getByRole('button', { name: /^Download \(/ })).toHaveCount(0)
  await page.evaluate('window.__holdImages = false')
  await page.getByLabel('Width', { exact: true }).fill('40')
  await page.getByLabel('Height', { exact: true }).fill('30')
  await page.getByRole('button', { name: /^Crop to / }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: /^Download \(/ }).click()
  const result = await download
  expect(result.suggestedFilename()).toBe('second-cropped.png')
  const metadata = await sharp((await result.path())!).metadata()
  expect({ width: metadata.width, height: metadata.height }).toEqual({ width: 40, height: 30 })
})

test('batch settings stay locked during processing and stop releases the worker', async ({
  app,
  page,
}) => {
  await holdImages(page)
  await app.open('/compress-image')
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'image.png', mimeType: 'image/png', buffer: await png(200, 100) })
  await page.getByRole('button', { name: 'Compress', exact: true }).click()
  await expect.poll(() => page.evaluate('window.__heldImages')).toBe(1)
  await expect(page.locator('fieldset')).toHaveAttribute('disabled', '')
  await expect(page.locator('fieldset button').last()).toBeDisabled()
  await expect(page.getByText('Settings are locked while processing.')).toBeVisible()
  await page.getByRole('button', { name: /^Stop/ }).click()
  await expect.poll(() => page.evaluate('window.__terminatedImages')).toBe(1)
  await expect(page.locator('fieldset')).not.toHaveAttribute('disabled')
  await expect(page.locator('fieldset button').last()).toBeEnabled()
})

test('cancelling video startup cannot mount the old file or cancel its replacement', async ({
  app,
  page,
}) => {
  // Only the external FFmpeg module/CDN boundary is controlled; auth and the app stay real.
  await page.route('https://unpkg.com/@ffmpeg/**', (route) =>
    route.fulfill({ body: '', contentType: 'application/octet-stream' })
  )
  await page.route('**/ffmpeg/0.12.15/classes.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `
    window.__videoMounts = [];
    export class FFmpeg {
      loaded = false;
      listeners = new Set();
      async load() { await new Promise(resolve => window.__finishVideoLoad = resolve); this.loaded = true; }
      terminate() { this.loaded = false; }
      async createDir() {}
      async mount(_kind, options) { window.__videoMounts.push(options.files[0].name); }
      async unmount() {}
      async deleteFile() {}
      on(_type, callback) { this.listeners.add(callback); }
      off(_type, callback) { this.listeners.delete(callback); }
      async exec() {
        for (const callback of this.listeners) {
          callback({ message: 'Duration: 00:00:05.00, start: 0.000000, bitrate: 500 kb/s' });
          callback({ message: 'Stream #0:0: Video: h264, yuv420p, 320x240, 30 fps' });
        }
        return 1;
      }
    }
  `,
    })
  )
  await app.open('/compress-video')
  const input = page.locator('input[type=file]')
  await input.setInputFiles({
    name: 'first.mp4',
    mimeType: 'video/mp4',
    buffer: Buffer.from('first video'),
  })
  await expect.poll(() => page.evaluate('typeof window.__finishVideoLoad')).toBe('function')
  await page.getByRole('button', { name: 'New video', exact: true }).click()
  await input.setInputFiles({
    name: 'second.webm',
    mimeType: 'video/webm',
    buffer: Buffer.from('second video'),
  })
  await page.evaluate('window.__finishVideoLoad()')
  await expect(page.getByRole('button', { name: 'Compress video', exact: true })).toBeEnabled()
  expect(await page.evaluate('window.__videoMounts')).toEqual(['source.webm'])
})
