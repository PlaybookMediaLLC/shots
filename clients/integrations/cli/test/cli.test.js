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

test('parseCommand supports setup, whoami, accounts, drafts, releases, and posts create', async () => {
  const { parseCommand } = await import('../lib/args.js')
  assert.deepEqual(parseCommand(['setup', '--key', 'ss_test', '--origin', 'https://shots.example']), {
    command: 'setup',
    options: { key: 'ss_test', origin: 'https://shots.example', json: false },
  })
  assert.deepEqual(parseCommand(['whoami', '--json']), {
    command: 'whoami',
    options: { json: true },
  })
  assert.deepEqual(parseCommand(['accounts', 'list']), {
    command: 'accounts:list',
    options: { json: false },
  })
  assert.deepEqual(
    parseCommand(['posts', 'create', '--account', 'cc_1', '--text', 'hello', '--now', '--idempotency-key', 'k1234567890123456']),
    {
      command: 'posts:create',
      options: {
        accounts: ['cc_1'],
        texts: ['hello'],
        publishNow: true,
        queue: false,
        idempotencyKey: 'k1234567890123456',
        json: false,
      },
    }
  )
  assert.deepEqual(
    parseCommand(['posts', 'create', '--account', 'cc_1', '--text', '--leading-dashes', '--text', '-h', '--at', '2026-12-01T10:00:00Z']),
    {
      command: 'posts:create',
      options: {
        accounts: ['cc_1'],
        texts: ['--leading-dashes', '-h'],
        publishNow: false,
        scheduledFor: '2026-12-01T10:00:00Z',
        queue: false,
        json: false,
      },
    }
  )
  assert.throws(() => parseCommand(['setup']), /--key/)
  assert.throws(() => parseCommand(['setup', '--key', '   ']), /non-empty/)
  assert.throws(() => parseCommand(['setup', '--key', 'ss_1', '--origin', '   ']), /non-empty/)
  assert.throws(() => parseCommand(['setup', '--key', 'ss_1', '--bogus']), /Unknown option --bogus/)
  assert.throws(() => parseCommand(['whoami', '--bogus']), /Unknown option --bogus/)
  assert.throws(() => parseCommand(['posts', 'list', '--limit', '5']), /Unknown option --limit/)
  assert.throws(() => parseCommand(['posts', 'create', '--account', '  ', '--text', 'hi', '--now']), /non-empty/)
  assert.throws(() => parseCommand(['posts', 'create', '--account', 'cc_1', '--text', 'hi']), /exactly one/)
  assert.throws(() => parseCommand(['posts', 'create', '--account', 'cc_1', '--text', 'hi', '--now', '--queue']), /exactly one/)
})

test('config persists atomically with owner-only permissions, recovers from corrupt JSON, and env vars override', async () => {
  const { mkdtemp, rm, stat, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { defaultConfigPath, loadConfig, resolveCredentials, saveConfig } = await import('../lib/config.js')
  const dir = await mkdtemp(join(tmpdir(), 'shots-cli-test-'))
  try {
    assert.equal(defaultConfigPath({ XDG_CONFIG_HOME: dir }), join(dir, 'shots', 'config.json'))
    const configPath = join(dir, 'shots', 'config.json')
    await saveConfig({ apiKey: 'ss_saved_key', origin: 'https://shots.example' }, configPath)
    const info = await stat(configPath)
    assert.equal(info.mode & 0o777, 0o600)
    assert.deepEqual(await loadConfig(configPath), {
      apiKey: 'ss_saved_key',
      origin: 'https://shots.example',
    })
    assert.deepEqual(await resolveCredentials({ configPath, env: {} }), {
      apiKey: 'ss_saved_key',
      origin: 'https://shots.example',
    })
    assert.deepEqual(
      await resolveCredentials({
        configPath,
        env: { SHOTS_API_KEY: 'ss_env_override', SHOTS_ORIGIN: 'https://override.example' },
      }),
      {
        apiKey: 'ss_env_override',
        origin: 'https://override.example',
      }
    )
    await writeFile(configPath, '{corrupt json', 'utf8')
    assert.deepEqual(await loadConfig(configPath), {})
  } finally {
    await rm(dir, { force: true, recursive: true })
  }
})

test('ShotsClient validates JSON/whoami responses, forwards headers, and supports list endpoints', async () => {
  const calls = []
  const transport = async (url, init) => {
    calls.push({ url, init })
    if (url.endsWith('/api/v1/auth/me')) {
      return Response.json({
        key: { id: 'k1', name: 'CLI', prefix: 'ss_', start: 'ss_123', scopes: ['artifact:read'], expiresAt: null },
        workspace: { id: 'org1', name: 'Acme', slug: 'acme' },
      })
    }
    if (url.endsWith('/api/v1/social-sets')) return Response.json({ items: [] })
    if (url.endsWith('/api/v1/scheduled-posts')) return Response.json({ items: [] })
    if (url.endsWith('/api/v1/content-drafts')) return Response.json({ items: [] })
    if (url.endsWith('/api/v1/releases')) return Response.json({ items: [] })
    return Response.json({ status: 'scheduled' }, { status: 201 })
  }
  const client = new ShotsClient('http://localhost:3000', 'ss_secret', transport)
  const me = await client.whoami()
  assert.equal(me.workspace.slug, 'acme')
  await client.createPost({ channelConnectionIds: ['cc_1'], posts: [{ text: 'hi' }], publishNow: true }, 'idem_1234567890123456')
  assert.equal(calls[1].init.headers['idempotency-key'], 'idem_1234567890123456')
  await client.listSocialSets()
  await client.listScheduledPosts()
  await client.listDrafts()
  await client.listReleases()
  await assert.rejects(() => client.request('/not-v1'), /Invalid API path/)

  const htmlClient = new ShotsClient('https://example.com', 'ss_secret', async () => new Response('<html>login</html>', { status: 200 }))
  await assert.rejects(() => htmlClient.whoami(), /invalid JSON/)

  const badShapeClient = new ShotsClient('https://example.com', 'ss_secret', async () => Response.json({ ok: true }))
  await assert.rejects(() => badShapeClient.whoami(), /unexpected authentication payload/)

  assert.throws(() => new ShotsClient('   ', 'ss_secret'), /SHOTS_ORIGIN/)
})
