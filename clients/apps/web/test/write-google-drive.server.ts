import assert from 'node:assert/strict'
import test from 'node:test'
import { googleDriveConfig } from '../lib/content-drafts/google-drive'

test('Drive import is unavailable until all three Picker keys are deployed', () => {
  const keys = ['GOOGLE_PICKER_API_KEY', 'GOOGLE_PICKER_APP_ID', 'GOOGLE_PICKER_CLIENT_ID'] as const
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  const errors: unknown[] = []
  const log = console.error
  console.error = (...args: unknown[]) => errors.push(args)
  try {
    for (const key of keys) delete process.env[key]
    assert.equal(googleDriveConfig(), null)
    assert.equal(errors.length, 0, 'an unset Drive is not an error')

    process.env.GOOGLE_PICKER_API_KEY = 'picker-key'
    process.env.GOOGLE_PICKER_CLIENT_ID = 'client.apps.googleusercontent.com'
    assert.equal(googleDriveConfig(), null, 'a half setup stays unavailable')
    assert.equal(errors.length, 1, 'and says why')

    process.env.GOOGLE_PICKER_APP_ID = '123456789012'
    assert.deepEqual(googleDriveConfig(), {
      apiKey: 'picker-key',
      appId: '123456789012',
      clientId: 'client.apps.googleusercontent.com',
    })
  } finally {
    console.error = log
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
})
