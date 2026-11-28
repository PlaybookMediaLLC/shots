import assert from 'node:assert/strict'
import test from 'node:test'
import {
  captionFromFileName,
  filenameCaptionIfEligible,
  isVideoAsset,
} from '@/lib/write/filename-caption'

test('isVideoAsset recognizes video MIME types and video file extensions only', () => {
  assert.equal(isVideoAsset({ mimeType: 'video/mp4' }), true)
  assert.equal(isVideoAsset({ mimeType: 'VIDEO/QUICKTIME' }), true)
  assert.equal(isVideoAsset({ fileName: 'demo-clip.MOV' }), true)
  assert.equal(isVideoAsset({ fileName: 'walkthrough.webm' }), true)
  assert.equal(isVideoAsset({ fileName: 'hero.png', mimeType: 'image/png' }), false)
  assert.equal(isVideoAsset({ fileName: 'notes.pdf', mimeType: 'application/pdf' }), false)
})

test('captionFromFileName preserves stem verbatim after stripping path and final extension', () => {
  assert.equal(captionFromFileName('Launch_Demo_v2.mp4'), 'Launch_Demo_v2')
  assert.equal(captionFromFileName('  How we shipped v2.1.mov  '), 'How we shipped v2.1')
  assert.equal(captionFromFileName('C:\\Videos\\Release Clip.webm'), 'Release Clip')
  assert.equal(captionFromFileName('/Users/alice/clips/My Clip.mp4'), 'My Clip')
  assert.equal(captionFromFileName('.mp4'), '')
  assert.equal(captionFromFileName('no-extension'), 'no-extension')
})

test('filenameCaptionIfEligible only fills when enabled, video asset, and caption is empty', () => {
  assert.equal(
    filenameCaptionIfEligible({
      currentCaption: '',
      enabled: true,
      fileName: 'Product_Tour_2026.mp4',
      mimeType: 'video/mp4',
    }),
    'Product_Tour_2026'
  )

  // Whitespace-only caption counts as empty.
  assert.equal(
    filenameCaptionIfEligible({
      currentCaption: '   \n\t  ',
      enabled: true,
      fileName: 'Product_Tour_2026.mp4',
      mimeType: 'video/mp4',
    }),
    'Product_Tour_2026'
  )

  // Never overwrites existing caption text.
  assert.equal(
    filenameCaptionIfEligible({
      currentCaption: 'Already drafted copy',
      enabled: true,
      fileName: 'Product_Tour_2026.mp4',
      mimeType: 'video/mp4',
    }),
    null
  )

  // Preference disabled -> never fills.
  assert.equal(
    filenameCaptionIfEligible({
      currentCaption: '',
      enabled: false,
      fileName: 'Product_Tour_2026.mp4',
      mimeType: 'video/mp4',
    }),
    null
  )

  // Non-video assets (images) are ignored.
  assert.equal(
    filenameCaptionIfEligible({
      currentCaption: '',
      enabled: true,
      fileName: 'Screenshot_2026.png',
      mimeType: 'image/png',
    }),
    null
  )
})
