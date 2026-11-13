import assert from 'node:assert/strict'
import { getAuthBaseUrl } from '@/lib/auth/environment'
import { afterEach, test } from 'node:test'
import {
  completeSocialOAuth,
  selectInstagramAccount,
  socialOAuthSignInRedirect,
} from '../lib/tenant/social-oauth-callback'
import { socialOAuthCompletionRedirect } from '../lib/tenant/social-oauth-completion'
import { safeReturnPath } from '../lib/platform/navigation'

afterEach(() => {
  delete process.env.BETTER_AUTH_SECRET
})

test('completion removes the provider code and redirects only after the connection commits', async () => {
  let committed = false
  const response = await completeSocialOAuth(
    new Request(
      'https://app.test/integrations/social/x?oauth_token=original&oauth_verifier=secret-code'
    ),
    'x',
    {
      exchange: async () => ({ id: 'account' }),
      onConnected: async () => {
        committed = true
      },
      redirect: async (state) => {
        assert.equal(committed, true)
        return socialOAuthCompletionRedirect('x', state)
      },
    }
  )
  assert.equal(response.status, 303)
  assert.equal(response.headers.get('location'), '/integrations/social/x/complete?state=original')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.doesNotMatch(response.headers.get('location') ?? '', /secret-code/)
})

test('X maps its OAuth 1 callback fields to the backend exchange', async () => {
  const calls: string[][] = []
  const result = await completeSocialOAuth(
    new Request('http://localhost/integrations/social/x?oauth_token=token&oauth_verifier=verifier'),
    'x',
    {
      exchange: async (state, code) => {
        calls.push([state, code])
        return { id: 'go-x', pages: [] }
      },
    }
  )
  assert.equal(result.status, 303)
  assert.equal(result.headers.get('Location'), '/settings/channels?connected=x')
  assert.deepEqual(calls, [['token', 'verifier']])
})

test('Instagram Login forwards code and state without exposing the backend response', async () => {
  const calls: string[][] = []
  const result = await completeSocialOAuth(
    new Request(
      'http://localhost/integrations/social/instagram-standalone?code=code1&state=state1'
    ),
    'instagram-standalone',
    {
      exchange: async (state, code) => {
        calls.push([state, code])
        return { id: 'go-ig', pages: [] }
      },
    }
  )
  assert.equal(result.status, 303)
  assert.equal(result.headers.get('Location'), '/settings/channels?connected=instagram-standalone')
  assert.deepEqual(calls, [['state1', 'code1']])
})

test('LinkedIn uses the same session-bound callback exchange', async () => {
  const result = await completeSocialOAuth(
    new Request('http://localhost/integrations/social/linkedin?code=code1&state=state1'),
    'linkedin',
    { exchange: async () => ({ id: 'go-linkedin' }) }
  )
  assert.equal(result.status, 303)
})

test('a Facebook Page is chosen after Facebook Login, as a LinkedIn page is', async () => {
  process.env.BETTER_AUTH_SECRET = 'test-picker-secret-at-least-thirty-two-characters'
  const url = 'http://localhost/integrations/social/facebook?code=code1&state=state1'
  const choices: string[] = []
  const picker = await completeSocialOAuth(new Request(url), 'facebook', {
    exchange: async () => ({ id: 'go-fb', pages: [{ id: 'p1', pageId: 'p1', name: 'Acme Page' }] }),
    onPageChoice: async (_state, id) => {
      choices.push(id)
    },
  })
  assert.equal(picker.status, 200)
  assert.match(await picker.text(), /Acme Page/)
  assert.deepEqual(choices, ['go-fb'])
  // A Page chosen in an earlier attempt completes without asking again.
  const completed = await completeSocialOAuth(new Request(url), 'facebook', {
    exchange: async () => ({ completed: true, id: 'go-fb' }),
  })
  assert.equal(completed.status, 303)
})

test('Facebook Login requires a linked Instagram account selection', async () => {
  process.env.BETTER_AUTH_SECRET = 'test-picker-secret-at-least-thirty-two-characters'
  const url = 'http://localhost/integrations/social/instagram?code=code1&state=state1'
  const picker = await completeSocialOAuth(new Request(url), 'instagram', {
    exchange: async () => ({
      id: 'go-ig',
      pages: [{ id: 'ig1', pageId: 'fb1', name: 'Company <A>' }],
    }),
  })
  assert.equal(picker.status, 200)
  const html = await picker.text()
  assert.match(html, /Company &lt;A&gt;/)
  assert.doesNotMatch(html, /Company <A>/)
  assert.equal(picker.headers.get('Referrer-Policy'), 'no-referrer')
  const choice = html.match(/name="choice" value="([^"]+)"/)?.[1]
  assert.ok(choice)

  const selections: unknown[] = []
  const selected = await selectInstagramAccount(
    new Request(url, {
      body: new URLSearchParams({ choice }),
      headers: { origin: new URL(getAuthBaseUrl()).origin },
      method: 'POST',
    }),
    {
      selectPage: async (value) => {
        selections.push(value)
      },
    }
  )
  assert.equal(selected.status, 303)
  assert.equal(selected.headers.get('Location'), '/settings/channels?connected=instagram')
  assert.deepEqual(selections, [
    {
      provider: 'instagram',
      accountId: 'ig1',
      expiresAt: (selections[0] as { expiresAt: number }).expiresAt,
      integrationId: 'go-ig',
      pageId: 'fb1',
      state: 'state1',
    },
  ])

  const rejected = await selectInstagramAccount(
    new Request(url, {
      body: new URLSearchParams({ choice: `${choice}tampered` }),
      headers: { origin: new URL(getAuthBaseUrl()).origin },
      method: 'POST',
    }),
    {
      selectPage: async (value) => {
        selections.push(value)
      },
    }
  )
  assert.equal(rejected.status, 400)
  assert.equal(selections.length, 1)
})

test('invalid OAuth callbacks make no backend request', async () => {
  let exchanges = 0
  for (const [url, provider] of [
    ['http://localhost/integrations/social/x?oauth_token=a&oauth_verifier=b&state=c', 'x'],
    ['http://localhost/integrations/social/x?denied=a', 'x'],
    ['http://localhost/integrations/social/instagram?code=c', 'instagram'],
    ['http://localhost/integrations/social/linkedin?code=c', 'linkedin'],
    ['http://localhost/integrations/social/unknown?code=c&state=s', 'unknown'],
  ]) {
    const response = await completeSocialOAuth(new Request(url), provider, {
      exchange: async () => {
        exchanges++
        return { id: 'unexpected' }
      },
    })
    assert.ok(response.status >= 400)
  }
  assert.equal(exchanges, 0)
})

test('page selection rejects cross-origin form submission', async () => {
  process.env.BETTER_AUTH_SECRET = 'test-picker-secret-at-least-thirty-two-characters'
  const result = await selectInstagramAccount(
    new Request('http://localhost/integrations/social/instagram', {
      body: new URLSearchParams({ choice: 'invalid' }),
      headers: { origin: 'https://other.test' },
      method: 'POST',
    })
  )
  assert.equal(result.status, 403)
})

for (const path of [
  '/publish/abcdefghij1234',
  '/settings/publishing-brands/abcdefghij1234',
  '//evil.example',
  '/publish/abcdefghij1234?next=https://evil.example',
  'https://evil.example',
  '/publish/../workspace',
]) {
  test(`OAuth return destination is confined to local drafts and brand settings: ${path}`, async () => {
    const result = await completeSocialOAuth(
      new Request('http://localhost/integrations/social/linkedin?code=code&state=state', {
        headers: { cookie: `shots-oauth-return=${encodeURIComponent(path)}` },
      }),
      'linkedin',
      { exchange: async () => ({ id: 'connected' }) }
    )
    assert.equal(
      result.headers.get('Location'),
      `${['/publish/abcdefghij1234', '/settings/publishing-brands/abcdefghij1234'].includes(path) ? path : '/settings/channels'}?connected=linkedin`
    )
  })
}

test('malformed OAuth return cookie falls back to channels', async () => {
  const result = await completeSocialOAuth(
    new Request('http://localhost/integrations/social/linkedin?code=code&state=state', {
      headers: { cookie: 'shots-oauth-return=%ZZ' },
    }),
    'linkedin',
    { exchange: async () => ({ id: 'connected' }) }
  )
  assert.equal(result.headers.get('Location'), '/settings/channels?connected=linkedin')
})

test('the immutable attempt return path overrides a cookie changed by another tab', async () => {
  const response = await completeSocialOAuth(
    new Request('http://localhost/integrations/social/x?oauth_token=state&oauth_verifier=code', {
      headers: { cookie: 'shots-oauth-return=%2Fpublish%2Fanotherdraft1234' },
    }),
    'x',
    {
      exchange: async () => ({ id: 'verified-account', completed: true }),
      returnTo: async (state) => {
        assert.equal(state, 'state')
        return '/settings/publishing-brands/originalset1234'
      },
    }
  )
  assert.equal(
    response.headers.get('Location'),
    '/settings/publishing-brands/originalset1234?connected=x'
  )
})

test('a completed Instagram callback recovers without asking for page selection again', async () => {
  let completed = 0
  const response = await completeSocialOAuth(
    new Request('http://localhost/integrations/social/instagram?state=state&code=code'),
    'instagram',
    {
      exchange: async () => ({ id: 'verified-account', completed: true }),
      onConnected: async () => {
        completed++
      },
      onPageChoice: async () => {
        assert.fail('completed callback requested another selection')
      },
      returnTo: async () => '',
    }
  )
  assert.equal(response.status, 303)
  assert.equal(completed, 1)
})

test('a start without a fresh sign-in signs in again and returns to the same start', () => {
  const start = '/integrations/social/tiktok/start?socialSet=cmw1m3hsq00010ayj93w7zag8&reconnect=c1'
  const response = socialOAuthSignInRedirect(`https://app.test${start}`)
  assert.equal(response.status, 303)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const location = new URL(response.headers.get('location') ?? '', 'https://app.test')
  assert.equal(location.pathname, '/sign-in')
  assert.equal(location.searchParams.get('reauthenticate'), '1')
  assert.equal(location.searchParams.get('callbackURL'), start)
  // The sign-in page follows only internal paths; this one must survive unchanged.
  assert.equal(safeReturnPath(location.searchParams.get('callbackURL')), start)
})
