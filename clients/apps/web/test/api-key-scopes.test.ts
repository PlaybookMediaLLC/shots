import assert from 'node:assert/strict'
import test from 'node:test'
import {
  apiKeyRefusal,
  apiKeyScopeDescriptions,
  apiKeyScopes,
  defaultAgentScopes,
  preselectedAgentScopes,
} from '@/lib/auth/api-key-scopes'

// Stored drafts are scheduled by a session only (RFC 013). post:schedule
// schedules approved campaign content; post:publish writes and publishes new
// posts, and only when someone chose it (RFC 026).
test('organization API keys expose only intake, artifact, draft, onboarding, and scheduling scopes', () => {
  assert.deepEqual(apiKeyScopes, [
    'artifact:read',
    'asset:write',
    'draft:comment',
    'draft:write',
    'onboarding:run',
    'post:delete',
    'post:publish',
    'post:schedule',
    'queue:write',
    'release:create',
    'source:write',
    'upload:sign',
  ])
})

test('post:publish is only ever ticked by the person approving', () => {
  assert.ok(!defaultAgentScopes.includes('post:publish'))
  assert.ok(!preselectedAgentScopes([]).includes('post:publish'))
  // A client can ask for it, and the person still has to choose it.
  assert.deepEqual(preselectedAgentScopes(['artifact:read', 'post:publish']), ['artifact:read'])
  // A new connection can write a post without further setup.
  assert.ok(defaultAgentScopes.includes('draft:write'))
})

test('post:delete is only ever ticked by the person approving', () => {
  assert.ok(!defaultAgentScopes.includes('post:delete'))
  assert.deepEqual(preselectedAgentScopes(['draft:write', 'post:delete']), ['draft:write'])
})

test('a key over its rate limit is told to wait, not that it lacks permission', () => {
  assert.equal(apiKeyRefusal({ code: 'RATE_LIMITED' }).status, 429)
  assert.equal(apiKeyRefusal({ code: 'KEY_DISABLED' }).status, 403)
  assert.equal(apiKeyRefusal(null).status, 403)
})

// Consent and settings label each checkbox with its scope and description, so
// naming another scope in a description makes the two labels ambiguous.
test('a scope description names no other scope', () => {
  for (const scope of apiKeyScopes) {
    for (const other of apiKeyScopes) {
      if (other !== scope)
        assert.ok(!apiKeyScopeDescriptions[scope].includes(other), `${scope}: ${other}`)
    }
  }
})
