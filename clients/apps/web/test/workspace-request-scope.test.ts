import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isOwnApiRequest } from '../lib/auth/browser-scope'
import { matchesWorkspaceScope, workspaceScopeHeaders } from '../lib/auth/request-scope'

test('browser expectations cannot follow a different workspace or signed-in person', () => {
  const displayed = { userId: 'person-a', workspaceId: 'workspace-a' }
  const headers = new Headers(workspaceScopeHeaders(displayed))
  assert.equal(matchesWorkspaceScope(headers, displayed), true)
  assert.equal(matchesWorkspaceScope(headers, { ...displayed, workspaceId: 'workspace-b' }), false)
  assert.equal(matchesWorkspaceScope(headers, { ...displayed, userId: 'person-b' }), false)
  headers.delete('x-playbook-user')
  assert.equal(matchesWorkspaceScope(headers, displayed), false)
  headers.set('x-playbook-user', '')
  assert.equal(matchesWorkspaceScope(headers, displayed), false)
  assert.equal(matchesWorkspaceScope(new Headers(), displayed), true)
})

test("only requests to this app's own API carry the workspace scope", () => {
  const origin = 'https://app.example'
  assert.equal(isOwnApiRequest('/api/trpc/project.create', origin), true)
  assert.equal(isOwnApiRequest(`${origin}/api/v1/content-drafts`, origin), true)
  assert.equal(isOwnApiRequest(new URL('/api/v1/assets', origin), origin), true)
  assert.equal(isOwnApiRequest('/publish', origin), false)
  // A signed storage upload must not receive headers its signature does not cover.
  assert.equal(isOwnApiRequest('https://storage.example/api/put', origin), false)
})

test('every browser write goes through fetch, where the workspace scope is bound', () => {
  const sources: string[] = []
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      if (statSync(path).isDirectory()) {
        if (name !== 'node_modules' && name !== 'api') walk(path)
      } else if (/\.tsx?$/.test(name)) sources.push(path)
    }
  }
  for (const directory of ['app', 'components', 'hooks', 'lib']) walk(directory)
  const bypasses = sources.filter((path) =>
    /new XMLHttpRequest|sendBeacon\(/.test(readFileSync(path, 'utf8'))
  )
  // Its XMLHttpRequest sends file bytes to signed storage URLs only, never to this app.
  assert.deepEqual(bypasses, ['lib/workspace/save-export.ts'])
})
