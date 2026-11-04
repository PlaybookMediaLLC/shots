import assert from 'node:assert/strict'
import test from 'node:test'
import { parseArgs, selectLines } from '../lib/args.js'
import { ShotsClient } from '../lib/client.js'

test('arguments become a request, and mistakes explain themselves', () => {
  assert.deepEqual(parseArgs(['code', 'a.ts', '--lines', '10-20', '--png', 'out.png', '--light']), {
    file: 'a.ts',
    lines: [10, 20],
    png: 'out.png',
    dark: false,
    scale: 2,
    open: false,
  })
  assert.deepEqual(parseArgs(['code', 'a.ts', '--lines', '7']).lines, [7, 7])
  assert.throws(() => parseArgs(['code']), /Usage/)
  assert.throws(() => parseArgs(['code', 'a.ts', '--lines', '9-3']), /range/)
  assert.throws(() => parseArgs(['code', 'a.ts', '--aspect', '2:1']), /aspect/)
  assert.throws(() => parseArgs(['code', 'a.ts', '--name']), /needs a value/)
  assert.throws(() => parseArgs(['code', 'a.ts', '--nope']), /Unknown option/)
})

test('a line range selects inclusive 1-based lines', () => {
  assert.equal(selectLines('a\r\nb\nc\nd', [2, 3]), 'b\nc')
  assert.equal(selectLines('a\nb', [2, 9]), 'b')
  assert.throws(() => selectLines('a', [3, 4]), /1 lines/)
})

test('the client refuses unsafe origins and keeps the key on its origin', async () => {
  assert.throws(() => new ShotsClient('http://example.com', 'k'), /HTTPS/)
  assert.throws(() => new ShotsClient('https://example.com/path', 'k'), /HTTPS/)
  assert.throws(() => new ShotsClient('https://example.com', ' '), /SHOTS_API_KEY/)
  const calls = []
  const transport = async (url, init) => {
    calls.push({ url, init })
    if (url.endsWith('/api/v1/code-projects'))
      return Response.json({ id: 'c1', name: 'a.ts', url: 'https://example.com/create/code/c1' }, { status: 201 })
    if (url.endsWith('/render')) return Response.json({ assetId: 'a1', width: 10, height: 10, mediaType: 'image/png' })
    if (url.endsWith('/download-url')) return Response.json({ downloadUrl: 'https://storage.example.com/signed' })
    return new Response(new Uint8Array([137, 80, 78, 71]))
  }
  const client = new ShotsClient('https://example.com', 'secret', transport)
  const project = await client.createCodeProject({ files: [{ name: 'a.ts', code: 'x' }] })
  assert.equal(project.id, 'c1')
  const png = await client.renderPng('c1')
  assert.deepEqual([...png.slice(0, 4)], [137, 80, 78, 71])
  assert.equal(calls[0].init.headers['x-api-key'], 'secret')
  assert.equal(calls[0].init.redirect, 'error')
  // The signed download URL is not on the Shots origin, so it gets no key.
  assert.equal(calls.at(-1).url, 'https://storage.example.com/signed')
  assert.equal(calls.at(-1).init.headers, undefined)
  await assert.rejects(
    new ShotsClient('https://example.com', 'k', async () => Response.json({ error: 'No scope' }, { status: 403 })).request('/api/v1/code-projects'),
    /No scope/
  )
})
