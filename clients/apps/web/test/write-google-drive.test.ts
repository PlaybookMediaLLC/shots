import assert from 'node:assert/strict'
import test from 'node:test'
import {
  downloadDriveFiles,
  DRIVE_MAX_BYTES,
  DRIVE_PICK_LIMIT,
  googleDriveConfigSchema,
} from '../lib/write/google-drive'

const pick = (
  overrides: Partial<{ id: string; mimeType: string; name: string; sizeBytes: number }> = {}
) => ({
  id: 'file-1',
  mimeType: 'image/png',
  name: 'launch.png',
  sizeBytes: 3,
  ...overrides,
})

test('picked Drive files download with the person token and keep their name and type', async () => {
  const seen: { url: string; auth: string | null }[] = []
  const request: typeof fetch = async (input, init) => {
    seen.push({ url: String(input), auth: new Headers(init?.headers).get('Authorization') })
    return new Response(new Uint8Array([1, 2, 3]))
  }
  const files = await downloadDriveFiles(
    [pick(), pick({ id: 'a/b', mimeType: 'video/mp4', name: 'clip.mp4' })],
    'token-1',
    request
  )
  assert.deepEqual(
    files.map((file) => [file.name, file.type, file.size]),
    [
      ['launch.png', 'image/png', 3],
      ['clip.mp4', 'video/mp4', 3],
    ]
  )
  assert.deepEqual(seen, [
    { url: 'https://www.googleapis.com/drive/v3/files/file-1?alt=media', auth: 'Bearer token-1' },
    { url: 'https://www.googleapis.com/drive/v3/files/a%2Fb?alt=media', auth: 'Bearer token-1' },
  ])
})

test('what no post takes is refused before any byte is fetched', async () => {
  let requests = 0
  const request: typeof fetch = async () => {
    requests++
    return new Response('')
  }
  await assert.rejects(
    downloadDriveFiles([pick({ mimeType: 'application/pdf', name: 'deck.pdf' })], 't', request),
    /deck\.pdf is not an image or video/
  )
  await assert.rejects(
    downloadDriveFiles([pick({ sizeBytes: DRIVE_MAX_BYTES + 1 })], 't', request),
    /larger than any platform takes/
  )
  await assert.rejects(
    downloadDriveFiles(
      Array.from({ length: DRIVE_PICK_LIMIT + 1 }, () => pick()),
      't',
      request
    ),
    /up to 20 files/
  )
  assert.equal(requests, 0)
})

test('a file Drive does not send fails the import with its name', async () => {
  const request: typeof fetch = async () => new Response('', { status: 403 })
  await assert.rejects(
    downloadDriveFiles([pick({ name: 'private.png' })], 't', request),
    /did not send private\.png/
  )
})

test('Picker keys need the Cloud project number as the app id', () => {
  assert.ok(
    googleDriveConfigSchema.safeParse({ apiKey: 'k', appId: '1234', clientId: 'c' }).success
  )
  assert.ok(
    !googleDriveConfigSchema.safeParse({ apiKey: 'k', appId: 'shots-app', clientId: 'c' }).success
  )
})
