import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyBrandKit,
  BRAND_CATEGORIES,
  BRAND_LOGO_ID,
  pickLogo,
  readableOn,
} from '@/lib/brand/apply'
import {
  brandKitById,
  brandKitDefinition,
  brandKitLibrary,
  fontIdForName,
  fullHex,
  readBrandKit,
  type StoredBrandKit,
} from '@/lib/brand/kit'
import { parseDesignDocument } from '@/lib/design/document'

const LOGO_LIGHT = 'asset:1b4e28ba-2fa1-11d2-883f-0016d3cca427'
const LOGO_DARK = 'asset:2c4e28ba-2fa1-11d2-883f-0016d3cca427'

const stored = (
  definition: Record<string, unknown>,
  extra: Partial<StoredBrandKit> = {}
): StoredBrandKit => ({
  definition,
  id: 'ckkit000000000000000000001',
  name: 'Acme',
  status: 'ACTIVE',
  version: 1,
  ...extra,
})

const kit = readBrandKit(
  stored(
    brandKitDefinition({
      colors: {
        accent: '#FF5A1F',
        background: '#0B1020',
        foreground: '#F8FAFC',
        secondary: '#7C3AED',
      },
      fonts: { primary: 'google:Sora', secondary: 'inter' },
      logos: [
        { id: 'l1', name: 'Light', src: LOGO_LIGHT, tone: 'light' },
        { id: 'l2', name: 'Dark', src: LOGO_DARK, tone: 'dark' },
      ],
    })
  )
)!

const design = () =>
  parseDesignDocument({
    version: 2,
    annotations: [{ end: { x: 0.5, y: 0.5 }, id: 'a1', start: { x: 0.1, y: 0.1 }, type: 'arrow' }],
    elements: [
      {
        height: 0.06,
        id: 'badge-1',
        props: {
          background: '#000000',
          borderColor: '#ffffff',
          borderWidth: 0,
          color: '#ffffff',
          fontScale: 0.5,
          number: 1,
          numbering: 'numeric',
          shadow: { blur: 0, color: '#000000', enabled: false, offsetX: 0, offsetY: 0 },
          shape: 'circle',
        },
        type: 'badge',
        width: 0.06,
        x: 0.2,
        y: 0.2,
      },
    ],
    image: { src: null },
    texts: [
      { fontSize: 0.06, id: 'h', position: { x: 50, y: 10 }, text: 'Headline' },
      {
        fill: { angle: 45, from: '#000000', kind: 'gradient', to: '#ffffff' },
        fontSize: 0.03,
        id: 's',
        position: { x: 50, y: 20 },
        text: 'Sub',
      },
    ],
  })

test('older kits (colours and a typeface name) still read', () => {
  const legacy = readBrandKit(
    stored({
      colors: { accent: '#6d5dfc', background: '#ffffff', foreground: '#111111' },
      typography: { fontFamily: 'Bricolage Grotesque' },
    })
  )
  assert.equal(legacy?.accent, '#6d5dfc')
  assert.equal(legacy?.primaryFont, 'google:Bricolage Grotesque')
  assert.equal(legacy?.secondaryFont, 'google:Bricolage Grotesque')
  assert.deepEqual(legacy?.logos, [])
  assert.equal(
    readBrandKit(stored({ accent: '#7047eb' })),
    null,
    'a kit without colours is not shown'
  )
  assert.equal(fontIdForName('Montserrat'), 'montserrat', 'a catalog font wins')
  assert.equal(fontIdForName('Inter'), 'inter')
  assert.equal(fontIdForName('"Inter", sans-serif'), 'inter')
})

test('a stored definition is the canonical RFC 019 kit plus the editor block', () => {
  const definition = brandKitDefinition({
    colors: { accent: '#6D5DFC', background: '#fff', foreground: '#111111', palette: ['#abc'] },
    fonts: { primary: 'google:Plus Jakarta Sans', secondary: 'inter' },
    logos: [{ id: 'l1', name: 'Light', src: LOGO_LIGHT, tone: 'light' }],
  })
  // Every reader understands the canonical part: hex colours, catalog fonts, a primary logo.
  assert.deepEqual(definition.colors, { accent: '#6d5dfc', background: '#ffffff', text: '#111111' })
  assert.equal(definition.typography.bodyFamily, 'inter')
  assert.ok(definition.typography.headingFamily, 'a Google font falls back to a catalog font')
  assert.equal(definition.logo?.primaryAssetId, LOGO_LIGHT.slice('asset:'.length))
  assert.equal(definition.schemaVersion, 1)
  // The editor block keeps the rest, and the kit reads back as edited.
  assert.equal(definition.editor?.fonts.heading, 'google:Plus Jakarta Sans')
  assert.deepEqual(definition.editor?.palette, ['#aabbcc'])
  const read = readBrandKit(stored(JSON.parse(JSON.stringify(definition))))!
  assert.equal(read.primaryFont, 'google:Plus Jakarta Sans')
  assert.equal(read.secondaryFont, 'inter')
  assert.equal(read.colors.foreground, '#111111')
  assert.equal(read.logos[0]?.tone, 'light')
  assert.throws(() =>
    brandKitDefinition({
      colors: { accent: '#000000', background: 'red', foreground: '#111111' },
      fonts: { primary: 'inter' },
    })
  )
})

test('a kit made in workspace settings (canonical only) reads with its logo', () => {
  const kit = readBrandKit(
    stored({
      colors: { accent: '#7047eb', background: '#ffffff', text: '#0f172a' },
      logo: { primaryAssetId: LOGO_DARK.slice('asset:'.length) },
      schemaVersion: 1,
      typography: { headingFamily: 'montserrat' },
    })
  )!
  assert.equal(kit.primaryFont, 'montserrat')
  assert.equal(kit.colors.foreground, '#0f172a')
  assert.deepEqual(kit.logos, [{ id: 'primary', name: 'Logo', src: LOGO_DARK, tone: 'any' }])
})

test('the library shows the latest active version of each kit', () => {
  const library = brandKitLibrary([
    stored({ colors: { background: '#ffffff', foreground: '#000000' } }, { id: 'a1', version: 1 }),
    stored({ colors: { background: '#000000', foreground: '#ffffff' } }, { id: 'a2', version: 2 }),
    stored(
      { colors: { background: '#000000', foreground: '#ffffff' } },
      { id: 'b1', name: 'Gone', status: 'ARCHIVED' }
    ),
  ])
  assert.deepEqual(
    library.map((entry) => [entry.name, entry.id]),
    [['Acme', 'a2']]
  )
})

test('a kit reads back by the exact version id a design applied, not only the latest', () => {
  const versions = [
    stored({ colors: { background: '#ffffff', foreground: '#000000' } }, { id: 'a1', version: 1 }),
    stored({ colors: { background: '#000000', foreground: '#ffffff' } }, { id: 'a2', version: 2 }),
  ]
  // A design bound to v1 keeps v1's colours after v2 is published; the
  // library would have dropped v1 and left the design with no brand at all.
  assert.equal(brandKitById(versions, 'a1')?.colors.background, '#ffffff')
  assert.equal(brandKitById(versions, 'a2')?.colors.background, '#000000')
  assert.equal(brandKitById(versions, 'another-workspace'), null)
})

test('applying a kit sets colours, fonts, background, and a logo', () => {
  const { binding, document } = applyBrandKit(design(), kit, BRAND_CATEGORIES)
  assert.equal(document.texts[0]?.color, '#f8fafc')
  assert.equal(document.texts[0]?.fontFamily, 'google:Sora', 'the headline gets the primary font')
  assert.equal(document.texts[1]?.fontFamily, 'inter', 'other text gets the secondary font')
  assert.deepEqual(document.texts[1]?.fill, {
    angle: 45,
    from: '#ff5a1f',
    kind: 'gradient',
    to: '#7c3aed',
  })
  assert.equal(document.annotations[0]?.strokeColor, '#ff5a1f')
  const badge = document.elements[0]
  assert.equal(badge?.type === 'badge' && badge.props.background, '#ff5a1f')
  assert.equal(badge?.type === 'badge' && badge.props.color, readableOn('#ff5a1f'))
  assert.match(document.background?.value ?? '', /#0b1020.*#ff5a1f/)
  const logo = document.overlays.find((overlay) => overlay.id === BRAND_LOGO_ID)
  assert.equal(logo?.src, LOGO_LIGHT, 'a light logo on a dark brand background')
  assert.equal(binding.kitId, kit.id)
  assert.equal(binding.applied['texts.h.color'], '#f8fafc')
})

test('only the chosen categories change', () => {
  const before = design()
  const { document } = applyBrandKit(before, kit, ['typography'])
  assert.equal(document.texts[0]?.fontFamily, 'google:Sora')
  assert.equal(document.texts[0]?.color, before.texts[0]?.color)
  assert.deepEqual(document.background, before.background)
  assert.equal(document.overlays.length, 0)
})

test('applying again keeps what the user changed, unless overrides are reset', () => {
  const first = applyBrandKit(design(), kit, BRAND_CATEGORIES)
  // The user recolours the headline and moves the logo.
  const edited = structuredClone(first.document)
  edited.texts[0]!.color = '#00ff00'
  const logo = edited.overlays.find((overlay) => overlay.id === BRAND_LOGO_ID)!
  logo.position = { x: 0.1, y: 0.1 }

  const newer = { ...kit, colors: { ...kit.colors, foreground: '#e2e8f0' }, version: 2 }
  const second = applyBrandKit(edited, newer, BRAND_CATEGORIES, { binding: first.binding })
  assert.equal(second.document.texts[0]?.color, '#00ff00', 'the override is kept')
  assert.equal(second.document.texts[1]?.color, '#e2e8f0', 'untouched properties follow the kit')
  assert.deepEqual(second.keptOverrides, ['texts.h.color'])
  assert.deepEqual(
    second.document.overlays.find((overlay) => overlay.id === BRAND_LOGO_ID)?.position,
    { x: 0.1, y: 0.1 },
    'the logo keeps its place'
  )

  const reset = applyBrandKit(edited, newer, BRAND_CATEGORIES, {
    binding: first.binding,
    resetOverrides: true,
  })
  assert.equal(reset.document.texts[0]?.color, '#e2e8f0')
  assert.deepEqual(reset.keptOverrides, [])
})

test('logos are picked by tone', () => {
  assert.equal(pickLogo(kit.logos, true)?.src, LOGO_LIGHT)
  assert.equal(pickLogo(kit.logos, false)?.src, LOGO_DARK)
  assert.equal(
    pickLogo([{ id: 'x', name: 'Any', src: LOGO_DARK, tone: 'any' }], true)?.src,
    LOGO_DARK
  )
})

test('a frame default carries the browser chrome along with the frame', () => {
  const framed = readBrandKit(
    stored(
      brandKitDefinition({
        colors: { accent: '#6d5dfc', background: '#0b1020', foreground: '#f8fafc' },
        fonts: { primary: 'inter' },
        frame: {
          chrome: { address: 'acme.com', appearance: 'dark', browser: 'firefox' },
          frame: { type: 'browser' },
          mode: 'browser',
          radius: 14,
        },
      })
    )
  )!
  const { document } = applyBrandKit(design(), framed, ['frame'])
  assert.equal(document.mode, 'browser')
  assert.equal(document.image.frame?.type, 'browser')
  assert.equal(document.image.chrome?.browser, 'firefox')
  assert.equal(document.image.chrome?.address, 'acme.com')
  assert.equal(document.image.radius, 14)
})

test('the canvas corner radius is not a brand override', () => {
  const first = applyBrandKit(design(), kit, ['background'])
  const edited = structuredClone(first.document)
  edited.background = { ...edited.background!, radius: 24 }
  const again = applyBrandKit(edited, { ...kit, accent: '#00ff00', version: 2 }, ['background'], {
    binding: first.binding,
  })
  assert.deepEqual(again.keptOverrides, [])
  assert.match(again.document.background?.value ?? '', /#00ff00/)
  assert.equal(again.document.background?.radius, 24)
})

test('picker colours become full hex for the canonical definition', () => {
  assert.equal(fullHex('#ABC'), '#aabbcc')
  assert.equal(fullHex('#11223380'), '#112233')
  assert.equal(fullHex('rgba(255, 0, 16, 0.5)'), '#ff0010')
  assert.equal(fullHex('rgb(1 2 3)'), '#010203')
})
