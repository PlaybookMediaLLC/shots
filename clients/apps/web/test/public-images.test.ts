import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import images from '../lib/assets/public-images.json'
import { isDesignSource } from '../lib/design/document'
import { publicImageUrl } from '../lib/assets/public-image'
import { getR2ImageUrl, getR2PublicUrl } from '../lib/r2'

test('every bundled public image has a content-versioned R2 key', () => {
  const files = readdirSync('public', { recursive: true }).filter(
    (path) => typeof path === 'string' && /\.(png|jpe?g|webp|avif|gif|svg|ico)$/i.test(path)
  ) as string[]
  assert.equal(files.length, Object.keys(images).length)
  for (const path of files) {
    const hash = createHash('sha256')
      .update(readFileSync(join('public', path)))
      .digest('hex')
      .slice(0, 20)
    assert.equal(
      images[`/${path}` as keyof typeof images],
      `static/${hash}/${path.replace(/[^A-Za-z0-9_./-]/g, '-')}`
    )
    assert.ok(isDesignSource(`/r2-assets/static/${hash}/${path.replace(/[^A-Za-z0-9_./-]/g, '-')}`))
  }
})

test('R2 image URLs preserve local builds, legacy paths, and query fragments', () => {
  const original = process.env.NEXT_PUBLIC_R2_PUBLIC_URL
  try {
    delete process.env.NEXT_PUBLIC_R2_PUBLIC_URL
    assert.equal(publicImageUrl('/logo-mark.png'), '/logo-mark.png')
    process.env.NEXT_PUBLIC_R2_PUBLIC_URL = 'https://shots-assets.oppulence.io'
    const logo = `https://shots-assets.oppulence.io/${images['/logo-mark.png']}`
    assert.equal(publicImageUrl('/logo-mark.png?v=2#icon'), `${logo}?v=2#icon`)
    assert.equal(publicImageUrl(logo), logo)
    assert.equal(getR2ImageUrl({ src: logo }), logo)
    assert.ok(isDesignSource(logo))
    assert.equal(
      getR2PublicUrl('backgrounds/raycast/red_distortion_4.webp'),
      `https://shots-assets.oppulence.io/${images['/raycast/red_distortion_4.webp']}`
    )
    for (const src of [
      'https://example.com/image.png',
      'blob:local-image',
      'data:image/png;base64,abc',
      '/api/private/image',
    ]) {
      assert.equal(publicImageUrl(src), src)
    }
    process.env.NEXT_PUBLIC_R2_PUBLIC_URL = 'custom-cdn.example/'
    assert.equal(isDesignSource('https://custom-cdn.example/static/a.webp'), true)
    assert.equal(isDesignSource('https://custom-cdn.example.evil.com/static/a.webp'), false)
    assert.equal(isDesignSource('http://custom-cdn.example/static/a.webp'), false)
    assert.equal(isDesignSource('https://custom-cdn.example/static/../a.webp'), false)
    assert.equal(isDesignSource('https://user@custom-cdn.example/static/a.webp'), false)
    assert.equal(isDesignSource('https://custom-cdn.example/'), false)
  } finally {
    if (original === undefined) delete process.env.NEXT_PUBLIC_R2_PUBLIC_URL
    else process.env.NEXT_PUBLIC_R2_PUBLIC_URL = original
  }
})
