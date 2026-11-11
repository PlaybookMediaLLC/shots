import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authPageSearch, authRedirect } from '../lib/auth/oauth-navigation'

test('OAuth navigation preserves the signed query and follows the code response', () => {
  const query = 'client_id=shots-founder-hub&state=state&sig=signed&exp=123'
  assert.equal(authPageSearch(query, '/home'), query)
  assert.equal(authPageSearch('email=ada%40example.test', '/home'), 'callbackURL=%2Fhome')
  assert.equal(
    authRedirect(
      { redirect: true, url: 'anarlog-dev://auth/callback?code=once&state=state' },
      '/home'
    ),
    'anarlog-dev://auth/callback?code=once&state=state'
  )
  assert.equal(authRedirect({ token: 'session' }, '/home'), '/home')
  assert.throws(() => authRedirect({ redirect: true, url: 'javascript:alert(1)' }, '/home'))
  assert.throws(() => authRedirect({ redirect: true, url: 'anarlog://untrusted/path' }, '/home'))
})
