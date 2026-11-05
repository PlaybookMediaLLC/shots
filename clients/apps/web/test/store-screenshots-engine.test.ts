import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createDeviceLayer,
  createDocument,
  createStandardSlide,
  createStarterDocument,
  createTextLayer,
  hashRichText,
  publicAsset,
} from '../lib/store-screenshots/document/factory'
import { migrateV1Project, readStoreDocument } from '../lib/store-screenshots/document/migrate'
import { storeDocumentSchema, type StoreDocument } from '../lib/store-screenshots/document/schema'
import {
  contrastRatio,
  linearGradientAt,
  parseHex,
  pickReadableColor,
  sampleBackground,
} from '../lib/store-screenshots/engine/color'
import { rotatedBounds } from '../lib/store-screenshots/engine/geometry'
import {
  deviceImagePointToSlide,
  evaluateSlide,
  screenImageRect,
  slidePointToDeviceImage,
  type SceneDevice,
  type SceneText,
} from '../lib/store-screenshots/engine/scene'
import { approximateMeasurer } from '../lib/store-screenshots/engine/text'
import { createStarterStoreProject, createStoreSlide } from '../lib/store-screenshots/project'
import { createStoreProject } from '../lib/store-screenshots/project'

const IPHONE = { width: 1320, height: 2868 }
const IPAD = { width: 2064, height: 2752 }

function evaluate(document: StoreDocument, index = 0, size = IPHONE, locale = 'en-US') {
  return evaluateSlide(document, index, {
    size,
    targetId: 'ios-iphone-6.9',
    locale,
    measurer: approximateMeasurer,
  })
}

function textNodes(scene: ReturnType<typeof evaluate>): SceneText[] {
  return scene.nodes.filter((node): node is SceneText => node.type === 'text')
}

function deviceNodes(scene: ReturnType<typeof evaluate>): SceneDevice[] {
  return scene.nodes.filter((node): node is SceneDevice => node.type === 'device')
}

function singleSlideDocument(heading: string, subheading = ''): StoreDocument {
  return createDocument({
    name: 'Test',
    slides: [createStandardSlide('One', null, heading, subheading)],
  })
}

test('contrast ratios follow WCAG', () => {
  assert.equal(Math.round(contrastRatio(parseHex('#FFFFFF'), parseHex('#000000'))), 21)
  assert.equal(contrastRatio(parseHex('#777777'), parseHex('#777777')), 1)
})

test('automatic text on a dark red background is light (UX-02)', () => {
  const samples = [parseHex('#831843'), parseHex('#9F1239')]
  assert.equal(pickReadableColor(samples, 'strong', 4.5).color, '#FFFFFF')
  const pale = [parseHex('#FAFAFA'), parseHex('#F3D7F7')]
  assert.equal(pickReadableColor(pale, 'strong', 4.5).color, '#111111')
})

test('gradient sampling follows CSS angle semantics', () => {
  const from = parseHex('#000000')
  const to = parseHex('#FFFFFF')
  const box = { width: 100, height: 200 }
  assert.equal(linearGradientAt(from, to, 180, box, { x: 50, y: 0 }).r, 0)
  assert.equal(linearGradientAt(from, to, 180, box, { x: 50, y: 200 }).r, 255)
  assert.equal(Math.round(linearGradientAt(from, to, 90, box, { x: 50, y: 100 }).r), 128)
})

test('the scene picks readable heading colors per background and keeps explicit colors', () => {
  const document = singleSlideDocument('Track every workout')
  document.slides[0].background = { kind: 'linear', from: '#831843', to: '#F472B6', angle: 145 }
  const [heading] = textNodes(evaluate(document))
  assert.equal(heading.autoColor, true)
  assert.equal(heading.color, '#FFFFFF')
  assert.ok(heading.contrast >= 3)

  const textLayer = document.slides[0].layers.find((layer) => layer.type === 'text')!
  if (textLayer.type === 'text') textLayer.style = { color: '#111111' }
  const [explicit] = textNodes(evaluate(document))
  assert.equal(explicit.autoColor, false)
  assert.equal(explicit.color, '#111111')
  assert.ok(
    explicit.contrast < explicit.requiredContrast,
    'low contrast is reported, not silently fixed'
  )
})

test('devices never start inside the measured copy block (UX-03)', () => {
  const long = 'Plan smarter training blocks with adaptive weekly goals and recovery insights'
  for (const layout of [
    'classic',
    'hero',
    'editorial-left',
    'editorial-right',
    'offset',
    'duo',
    'minimal',
    'tablet-phone',
    'trio',
  ] as const) {
    const document = singleSlideDocument(
      long,
      'A subheading that explains the benefit in one sentence.'
    )
    document.slides[0].layout = layout
    const scene = evaluate(document)
    const copyBottom = Math.max(...textNodes(scene).map((node) => node.box.y + node.box.height))
    for (const device of deviceNodes(scene)) {
      const bounds = rotatedBounds(device.box, device.rotation)
      assert.ok(
        bounds.y >= copyBottom,
        `${layout}: device top ${bounds.y} overlaps copy bottom ${copyBottom}`
      )
    }
  }
})

test('long copy shrinks with auto-fit before it overflows', () => {
  const document = singleSlideDocument(
    'An extremely long headline that keeps going far beyond what any screenshot should ever carry in one line'
  )
  const [heading] = textNodes(evaluate(document))
  assert.equal(heading.shrunk, true)
  assert.ok(heading.lines <= 3 || heading.overflow)
})

test('minimal keeps the heading visible in a compact band (UX-12)', () => {
  const document = singleSlideDocument('Chat in voice mode')
  document.slides[0].layout = 'minimal'
  const scene = evaluate(document)
  const [heading] = textNodes(scene)
  assert.ok(heading, 'heading is still rendered')
  const classic = singleSlideDocument('Chat in voice mode')
  const [classicHeading] = textNodes(evaluate(classic))
  assert.ok(heading.fontSizePx < classicHeading.fontSizePx)
  assert.equal(scene.hidden.length, 0)
})

test('text-only layout hides devices without deleting them', () => {
  const document = singleSlideDocument('Words only')
  document.slides[0].layout = 'no-mockup'
  const scene = evaluate(document)
  assert.equal(deviceNodes(scene).length, 0)
  assert.equal(scene.hidden[0]?.reason, 'layout')
  assert.equal(document.slides[0].layers.filter((layer) => layer.type === 'device').length, 1)
})

test('a duo slide renders two independent devices with their own screenshots (F07)', () => {
  const slide = createStandardSlide('Duo', 'a', 'Two flows')
  slide.layout = 'duo'
  slide.layers.unshift(createDeviceLayer('b', 1))
  const document = createDocument({ name: 'Duo', slides: [slide] })
  const devices = deviceNodes(evaluate(document))
  assert.equal(devices.length, 2)
  assert.deepEqual(new Set(devices.map((device) => device.assetId)), new Set(['a', 'b']))
})

test('the same composition adapts to an iPad target with smaller relative type (F02)', () => {
  const document = singleSlideDocument('Same design, every size')
  const phone = evaluate(document, 0, IPHONE)
  const tablet = evaluate(document, 0, IPAD)
  const [phoneHeading] = textNodes(phone)
  const [tabletHeading] = textNodes(tablet)
  assert.ok(tabletHeading.fontSizePx / IPAD.width < phoneHeading.fontSizePx / IPHONE.width)
  const [device] = deviceNodes(tablet)
  assert.ok(device.box.y + device.box.height <= IPAD.height * 1.1)
})

test('screen image framing matches object-fit and the crop transform', () => {
  assert.deepEqual(
    screenImageRect(100, 200, 1, { mode: 'fill', scale: 1, offsetX: 0, offsetY: 0 }),
    {
      x: -50,
      y: 0,
      width: 200,
      height: 200,
    }
  )
  assert.deepEqual(
    screenImageRect(100, 200, 1, { mode: 'fit', scale: 1, offsetX: 0, offsetY: 0 }),
    {
      x: 0,
      y: 50,
      width: 100,
      height: 100,
    }
  )
  const custom = screenImageRect(100, 200, 0.5, {
    mode: 'custom',
    scale: 2,
    offsetX: 10,
    offsetY: 0,
  })
  assert.deepEqual(custom, { x: -40, y: -100, width: 200, height: 400 })
})

test('device image coordinates round-trip through rotation (UX-13, F19)', () => {
  const document = singleSlideDocument('Rotate me')
  const device = document.slides[0].layers[0]
  if (device.type === 'device') device.transform = { ...device.transform, rotation: 17 }
  const [node] = deviceNodes(evaluate(document))
  const point = deviceImagePointToSlide(node, 0.3, 0.7)
  const back = slidePointToDeviceImage(node, point)
  assert.ok(Math.abs(back.x - 0.3) < 1e-9 && Math.abs(back.y - 0.7) < 1e-9)
})

test('panorama slides paint one continuous background and shared layers line up (F08)', () => {
  const slides = [
    createStandardSlide('A', null, 'Left'),
    createStandardSlide('B', null, 'Middle'),
    createStandardSlide('C', null, 'Right'),
  ]
  const document = createDocument({ name: 'Pano', slides })
  const shared = createDeviceLayer('wide', 0, undefined, {
    placement: { mode: 'free', x: 50, y: 50, width: 20 },
  })
  document.panoramas = [
    {
      id: 'p',
      slideIds: slides.map((slide) => slide.id),
      background: { kind: 'linear', from: '#000000', to: '#FFFFFF', angle: 90 },
      layers: [shared],
    },
  ]
  const scenes = [0, 1, 2].map((index) => evaluate(document, index))
  scenes.forEach((scene, index) => {
    assert.equal(scene.background.spanWidth, IPHONE.width * 3)
    assert.equal(scene.background.offsetX, IPHONE.width * index)
  })
  const middle = scenes[1].nodes.find((node) => node.layerId === shared.id)!
  assert.ok(middle.panorama)
  assert.ok(Math.abs(middle.box.x + middle.box.width / 2 - IPHONE.width / 2) < 1e-6)
  assert.equal(
    scenes[0].nodes.some((node) => node.layerId === shared.id),
    false
  )
  const rightEdge = sampleBackground(
    scenes[0].background.fill,
    {},
    { width: IPHONE.width * 3, height: IPHONE.height },
    { x: IPHONE.width - 1, y: 0, width: 1, height: 10 },
    0
  )
  const leftEdge = sampleBackground(
    scenes[1].background.fill,
    {},
    { width: IPHONE.width * 3, height: IPHONE.height },
    { x: 0, y: 0, width: 1, height: 10 },
    IPHONE.width
  )
  assert.ok(Math.abs(rightEdge[0].r - leftEdge[0].r) < 1)
})

test('a version 1 starter project migrates without losing slides, copy, or images', () => {
  const v1 = createStarterStoreProject()
  const { document, pendingAssets } = migrateV1Project(v1)
  assert.equal(storeDocumentSchema.safeParse(document).success, true)
  assert.equal(document.slides.length, 8)
  assert.equal(pendingAssets.length, 0, 'bundled screens stay public URLs')
  const first = document.slides[0]
  const heading = first.layers.find((layer) => layer.type === 'text')
  assert.equal(
    heading?.type === 'text' && heading.content[0].text,
    'Prepare for your\nnext challenge'
  )
  assert.equal(
    document.theme.textStyles.heading.color,
    null,
    'template default colors become automatic'
  )
  assert.equal(first.background?.kind, 'linear')
})

test('version 1 duo, extra text, overlay, and inline images all migrate', () => {
  const left = createStoreSlide('data:image/png;base64,AAAA', 'left.png')
  const right = createStoreSlide('data:image/png;base64,BBBB', 'right.png')
  left.layoutOverride = 'duo'
  left.duoRightSlideId = right.id
  left.headlineColorOverride = '#FF0000'
  left.extraTexts = [
    {
      id: 't',
      text: 'Extra',
      kind: 'heading',
      fontSize: 5.5,
      bold: true,
      italic: false,
      color: null,
      x: 40,
      y: 30,
    },
  ]
  left.overlay = {
    src: 'data:image/png;base64,CCCC',
    name: 'logo.png',
    x: 75,
    y: 20,
    size: 24,
    opacity: 0.8,
  }
  left.device = { scale: 1.1, offsetX: 3, offsetY: -2, rotation: 5, rotateX: 4, rotateY: -6 }
  const { document, pendingAssets } = migrateV1Project(createStoreProject([left, right]))
  assert.equal(pendingAssets.length, 3)
  const slide = document.slides[0]
  const devices = slide.layers.filter((layer) => layer.type === 'device')
  assert.equal(devices.length, 2)
  assert.notEqual(
    devices[0].type === 'device' && devices[0].assetId,
    devices[1].type === 'device' && devices[1].assetId
  )
  assert.deepEqual(devices[0].transform, {
    offsetX: 3,
    offsetY: -2,
    scale: 1.1,
    rotation: 5,
    tiltX: 4,
    tiltY: -6,
  })
  const texts = slide.layers.filter((layer) => layer.type === 'text')
  assert.equal(texts.length, 3)
  const extra = texts.find((layer) => layer.type === 'text' && layer.placement.mode === 'free')
  assert.equal(extra?.type === 'text' && extra.style.fontSize, Math.round(5.5 * 13.2))
  const heading = texts.find(
    (layer) => layer.type === 'text' && layer.role === 'heading' && layer.placement.mode === 'auto'
  )
  assert.equal(heading?.type === 'text' && heading.style.color, '#FF0000')
  assert.ok(slide.layers.some((layer) => layer.type === 'image' && layer.opacity === 0.8))
})

test('stored documents are validated and future versions refused', () => {
  const current = createStarterDocument()
  assert.equal(readStoreDocument(structuredClone(current)).document.slides.length, 8)
  assert.throws(() => readStoreDocument({ ...current, version: 99 }), /newer version/)
  assert.throws(() => readStoreDocument(null), /unreadable/)
})

test('bundled images served from R2 keep their saved project readable', () => {
  // Production builds serve samples from `/r2-assets/static/<hash>/<file>`, so their ids pass 64 characters.
  const document = createStarterDocument()
  const asset = publicAsset(
    '/r2-assets/static/f8e2652aa8f3c68d696e/store-screenshot-inspiration.png',
    'Inspiration'
  )
  assert.ok(asset.id.length > 64)
  document.assets[asset.id] = asset
  const device = document.slides[0]!.layers.find((layer) => layer.type === 'device')
  assert.ok(device?.type === 'device')
  device.assetId = asset.id
  assert.equal(readStoreDocument(structuredClone(document)).document.assets[asset.id]?.id, asset.id)
})

test('translations remember the source they were made from', () => {
  const layer = createTextLayer('heading', 'Hello')
  const hash = hashRichText(layer.content)
  assert.equal(hash, hashRichText([{ text: 'Hello' }]))
  assert.notEqual(hash, hashRichText([{ text: 'Hello', bold: true }]))
})
