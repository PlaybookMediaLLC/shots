import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test, { afterEach } from 'node:test';
import { getBackgroundCSS, getBackgroundImageUrl } from '../lib/constants/backgrounds';
import images from '../lib/assets/public-images.json';
import { getR2ImageUrl, getR2PublicUrl, getResizedImageUrl, isR2AssetUrl } from '../lib/r2'

const originalPublicUrl = process.env.NEXT_PUBLIC_R2_PUBLIC_URL
afterEach(() => {
  if (originalPublicUrl === undefined) delete process.env.NEXT_PUBLIC_R2_PUBLIC_URL
  else process.env.NEXT_PUBLIC_R2_PUBLIC_URL = originalPublicUrl
})

test('the default background uses the immutable R2 image when configured', () => {
  process.env.NEXT_PUBLIC_R2_PUBLIC_URL = 'https://unavailable.example'
  const config = { type: 'image', value: 'backgrounds/raycast/red_distortion_4.webp' } as const
  const cdnUrl = `https://unavailable.example/${images['/raycast/red_distortion_4.webp']}`

  assert.equal(getR2PublicUrl(config.value), cdnUrl)
  assert.equal(getR2PublicUrl(`/${config.value}`), cdnUrl)
  assert.equal(getR2ImageUrl({ src: config.value }), cdnUrl)
  assert.equal(getBackgroundImageUrl(config), cdnUrl)
  assert.equal(getBackgroundCSS(config).backgroundImage, `url(${cdnUrl})`)
  assert.equal(
    getBackgroundCSS(config, 32).backgroundImage,
    `url(/_next/image?url=${encodeURIComponent(cdnUrl)}&w=32&q=75)`
  )
  assert.ok(existsSync(new URL('../public/raycast/red_distortion_4.webp', import.meta.url)))
})

test('other assets use direct R2 CDN and retain local fallback paths', () => {
  process.env.NEXT_PUBLIC_R2_PUBLIC_URL = 'https://assets.example/'
  assert.equal(
    getR2PublicUrl('backgrounds/raycast/blue_distortion_1.webp'),
    `https://assets.example/${images['/raycast/blue_distortion_1.webp']}`
  )
  assert.equal(
    getR2PublicUrl('/overlays/shadow/window.png'),
    'https://assets.example/overlays/shadow/window.png'
  )
  assert.equal(
    getR2PublicUrl('/r2-assets/overlays/shadow/window.png'),
    'https://assets.example/overlays/shadow/window.png'
  )

  delete process.env.NEXT_PUBLIC_R2_PUBLIC_URL
  assert.equal(
    getR2PublicUrl('backgrounds/raycast/blue_distortion_1.webp'),
    '/raycast/blue_distortion_1.webp'
  )
  assert.equal(
    getR2PublicUrl('backgrounds/raycast/red_distortion_4.webp'),
    '/raycast/red_distortion_4.webp'
  )
  assert.equal(getR2PublicUrl('overlays/shadow/window.png'), '/overlay-shadow/window.png')
  assert.equal(
    getR2PublicUrl('/r2-assets/overlays/shadow/window.png'),
    '/r2-assets/overlays/shadow/window.png'
  )
})

test('isR2AssetUrl and getResizedImageUrl reject spoofed hosts and third-party URLs', () => {
  process.env.NEXT_PUBLIC_R2_PUBLIC_URL = 'https://assets.example/'
  assert.equal(isR2AssetUrl('https://assets.example/static/a.webp'), true)
  assert.equal(isR2AssetUrl('/r2-assets/static/a.webp'), true)
  assert.equal(isR2AssetUrl('https://assets.example.evil.com/static/a.webp'), false)
  assert.equal(isR2AssetUrl('https://evil.example/static/a.webp'), false)

  assert.equal(
    getResizedImageUrl('https://assets.example/static/a.webp', 64),
    `/_next/image?url=${encodeURIComponent('https://assets.example/static/a.webp')}&w=64&q=75`
  )
  assert.equal(
    getResizedImageUrl('/local/a.webp', 64),
    `/_next/image?url=${encodeURIComponent('/local/a.webp')}&w=64&q=75`
  )
  assert.equal(getResizedImageUrl('//evil.example/a.webp', 64), '//evil.example/a.webp')
  assert.equal(
    getResizedImageUrl('https://assets.example.evil.com/static/a.webp', 64),
    'https://assets.example.evil.com/static/a.webp'
  )
})

test('custom background URLs are unchanged', () => {
  for (const value of [
    'https://example.com/image.webp',
    '/custom.webp',
    'blob:upload',
    'data:image/png;base64,AA==',
  ]) {
    assert.equal(getBackgroundImageUrl({ type: 'image', value }), value)
  }
})
