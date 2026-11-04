'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { codeProjectRequest, createCodeProject, shotsOrigin } = require('../lib/request')

test('a selection becomes a named code project with a Code Studio language', () => {
  assert.deepEqual(
    codeProjectRequest({ fileName: '/repo/src/App.tsx', languageId: 'typescriptreact', text: 'a\r\nb\n', startLine: 4, endLine: 5 }),
    { name: 'App.tsx:4-5', files: [{ name: 'App.tsx', code: 'a\nb', lang: 'tsx' }] }
  )
  const unknown = codeProjectRequest({ fileName: 'C:\\x\\main.nim', languageId: 'nim', text: 'echo 1', startLine: 1, endLine: 1, theme: 'noir' })
  assert.deepEqual(unknown, { name: 'main.nim:1', files: [{ name: 'main.nim', code: 'echo 1' }], theme: 'noir' })
  assert.throws(() => codeProjectRequest({ fileName: 'a', languageId: 'text', text: '  ', startLine: 1, endLine: 1 }), /Select some code/)
})

test('code goes only to an HTTPS origin, and the key never follows a redirect', async () => {
  assert.equal(shotsOrigin('https://shots.example.com'), 'https://shots.example.com')
  assert.equal(shotsOrigin('http://localhost:3000'), 'http://localhost:3000')
  assert.throws(() => shotsOrigin('http://shots.example.com'), /HTTPS/)
  let seen
  const project = await createCodeProject('https://shots.example.com', 'k', { files: [] }, async (url, init) => {
    seen = { url, init }
    return Response.json({ id: 'c1', url: 'https://shots.example.com/create/code/c1' }, { status: 201 })
  })
  assert.equal(project.url, 'https://shots.example.com/create/code/c1')
  assert.equal(seen.url, 'https://shots.example.com/api/v1/code-projects')
  assert.equal(seen.init.redirect, 'error')
  assert.equal(seen.init.headers['x-api-key'], 'k')
  await assert.rejects(
    createCodeProject('https://shots.example.com', 'k', { files: [] }, async () => Response.json({ error: 'Invalid API key' }, { status: 401 })),
    /Invalid API key/
  )
})
