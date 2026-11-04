import assert from 'node:assert/strict'
import { test } from 'node:test'
import { brandIdentity, brandThemeCss, whitelabelSettingsSchema } from '@/lib/whitelabeling'

test('an unbranded organization keeps the Shots identity and theme', () => {
  assert.deepEqual(brandIdentity(null), { logoUrl: undefined, name: 'Shots' })
  assert.deepEqual(brandIdentity({ brandName: '', logoUrl: '' }), {
    logoUrl: undefined,
    name: 'Shots',
  })
  assert.equal(brandThemeCss(null), null)
  assert.equal(brandThemeCss({ brandName: 'Acme', primaryColor: '' }), null)
})

test('the theme picks a readable foreground for each color', () => {
  assert.equal(
    brandThemeCss({ primaryColor: '#0A66FF', accentColor: '#FFE600' }),
    ":root,.dark{--primary:#0A66FF;--primary-foreground:#ffffff;--ring:#0A66FF;--accent:#FFE600;--accent-foreground:#000000}:is([data-platform-shell],.platform-overlay) [data-slot='button'][data-variant='default']{background:#0A66FF;color:#ffffff}"
  )
})

test('a stored value that is not a color cannot add CSS', () => {
  assert.equal(brandThemeCss({ primaryColor: '#000000;}body{display:none' }), null)
})

test('settings accept https images and #rrggbb colors only', () => {
  for (const settings of [{}, { logoUrl: '' }, { logoUrl: 'https://cdn.acme.test/l.png' }]) {
    assert.equal(whitelabelSettingsSchema.safeParse(settings).success, true)
  }
  for (const settings of [
    { logoUrl: 'http://cdn.acme.test/l.png' },
    { faviconUrl: 'javascript:alert(1)' },
    { primaryColor: 'red' },
    { brandName: 'x'.repeat(65) },
  ]) {
    assert.equal(whitelabelSettingsSchema.safeParse(settings).success, false)
  }
})
