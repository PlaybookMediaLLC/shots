import assert from 'node:assert/strict'
import test from 'node:test'
import {
  downloadDriveFiles,
  DRIVE_PICK_LIMIT,
  type DrivePick,
  googleDriveConfigSchema,
} from '../lib/write/google-drive'
import { uploadByteLimit } from '../lib/write/media-limits'

const pick = (overrides: Partial<DrivePick> = {}): DrivePick => ({
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
  const { failed, files } = await downloadDriveFiles(
    [pick(), pick({ id: 'a/b', mimeType: 'video/mp4', name: 'clip.mp4' })],
    'token-1',
    { request }
  )
  assert.deepEqual(failed, [])
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

test('what the upload refuses is refused before any byte is fetched', async () => {
  let requests = 0
  const request: typeof fetch = async () => {
    requests++
    return new Response('')
  }
  await assert.rejects(
    downloadDriveFiles([pick({ mimeType: 'application/pdf', name: 'deck.pdf' })], 't', { request }),
    /deck\.pdf is not an image or video/
  )
  // The upload's own ceiling for each type, not a destination's.
  await assert.rejects(
    downloadDriveFiles(
      [pick({ name: 'huge.png', sizeBytes: uploadByteLimit('image/png') + 1 })],
      't',
      { request }
    ),
    /huge\.png is larger than Shots uploads/
  )
  await assert.rejects(
    downloadDriveFiles(
      Array.from({ length: DRIVE_PICK_LIMIT + 1 }, () => pick()),
      't',
      { request }
    ),
    /up to 20 files/
  )
  assert.equal(requests, 0)
})

test('a file Drive does not send is named, and the others still arrive', async () => {
  const request: typeof fetch = async (input) =>
    String(input).includes('private')
      ? new Response('', { status: 403 })
      : new Response(new Uint8Array([7]))
  const { failed, files } = await downloadDriveFiles(
    [pick({ id: 'private', name: 'private.png' }), pick({ name: 'open.png' })],
    't',
    { request }
  )
  assert.deepEqual(failed, ['private.png'])
  assert.deepEqual(
    files.map((file) => file.name),
    ['open.png']
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
