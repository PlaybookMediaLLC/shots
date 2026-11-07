import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalJson } from '@/lib/design/canonical-json'
import { designRenderKey } from '@/lib/design/render-key'
import { getDesignTemplate } from '@/lib/design/templates'

const screenshot = 'asset:11111111-1111-4111-8111-111111111111'
const document = getDesignTemplate('layout-headline-spotlight')!.build({
  headline: 'Hi',
  screenshot,
})
const assets = { '11111111-1111-4111-8111-111111111111': 'a'.repeat(64) }
const png = { format: 'png', scale: 2 }

test('equivalent documents share a render key regardless of key order', () => {
  const reordered = JSON.parse(JSON.stringify(document, Object.keys(document).sort().reverse()))
  assert.equal(
    designRenderKey({ assets, document, options: png }),
    designRenderKey({ assets, document: { ...reordered, ...document }, options: png })
  )
})

test('any change to pixels-relevant input changes the key', () => {
  const base = designRenderKey({ assets, document, options: png })
  assert.notEqual(
    base,
    designRenderKey({ assets, document, options: { format: 'jpeg', scale: 2 } })
  )
  assert.notEqual(base, designRenderKey({ assets, document, options: { format: 'png', scale: 1 } }))
  assert.notEqual(
    base,
    designRenderKey({
      assets: { ...assets, '11111111-1111-4111-8111-111111111111': 'b'.repeat(64) },
      document,
      options: png,
    })
  )
  assert.notEqual(
    base,
    designRenderKey({ assets, document: { ...document, texts: [] }, options: png })
  )
})

test('canonical text is what both the server and the browser hash', () => {
  // The server key (node:crypto) and the editor's publish revision
  // (contentHash) hash this one text, so they agree on what "the same
  // design" means.
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}')
  // An absent value and an undefined one are the same design.
  assert.equal(canonicalJson({ a: 1, b: undefined }), canonicalJson({ a: 1 }))
  // Leaf strings can be rewritten, which is how an asset is keyed by its content.
  assert.equal(
    canonicalJson({ src: 'asset:1' }, (text) => text.replace('asset:1', 'asset:aa')),
    '{"src":"asset:aa"}'
  )
})

test('the same bytes under a new asset id share a render key', () => {
  const recaptured = '22222222-2222-4222-8222-222222222222'
  const moved = JSON.parse(JSON.stringify(document).replaceAll(screenshot.slice(6), recaptured))
  assert.equal(
    designRenderKey({ assets, document, options: png }),
    designRenderKey({ assets: { [recaptured]: 'a'.repeat(64) }, document: moved, options: png })
  )
  assert.notEqual(
    designRenderKey({ assets, document, options: png }),
    designRenderKey({ assets: { [recaptured]: `${recaptured}@x` }, document: moved, options: png })
  )
})
