import { createServer } from 'node:http'

// Local protocol fixture only: the application still verifies OAuth state,
// repository access, sessions, tenant ownership, and webhook signatures.
const port = Number(process.env.E2E_GITHUB_PORT ?? 8039)
const appURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const repository = { id: 1001, full_name: 'fixture/product', default_branch: 'main', private: true }
const installation = {
  id: 77,
  account: { login: 'release-fixture', type: 'Organization' },
  repository_selection: 'selected',
  suspended_at: null,
  permissions: { actions: 'read', deployments: 'read', contents: 'read', pull_requests: 'read' },
}
let mailCount = 0
let modelCalls = 0
let installPages = 0
// Calls per campaign post: fixture workspaces share one installation, so a
// test counts the calls for its own posts, not every tenant's.
const modelPosts = {}
const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://localhost:${port}`)
  const json = (body, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }
  const redirect = (target) => {
    response.writeHead(302, { location: target })
    response.end()
  }
  if (url.pathname === '/health') return json({ ready: true })
  if (url.pathname === '/__counts') return json({ installPages, mailCount, modelCalls, modelPosts })
  // A local stand-in for the OpenRouter chat API: it answers each requested
  // post deterministically so tests can prove a run paid for one call only.
  if (url.pathname === '/api/v1/chat/completions' && request.method === 'POST') {
    if (request.headers.authorization !== 'Bearer fixture-only-local-model')
      return json({ error: 'unauthorized' }, 401)
    let body = ''
    for await (const chunk of request) {
      body += chunk
      if (body.length > 1 << 20) return json({ error: 'too_large' }, 413)
    }
    modelCalls++
    const chat = JSON.parse(body)
    const prompt = chat.messages?.at(-1)?.content ?? ''
    // Relevance checks judge the fenced change: maintenance is not marketing.
    if (chat.response_format?.json_schema?.name === 'workflow_relevance') {
      const change = prompt.split('<change trust="untrusted">')[1] ?? ''
      const worthy = !/\b(chore|bump)\b/i.test(change)
      return json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                marketingWorthy: worthy,
                confidence: worthy ? 0.88 : 0.93,
                rationale: worthy
                  ? 'Customers get a visible improvement.'
                  : 'Only maintenance changes.',
              }),
            },
          },
        ],
        usage: { prompt_tokens: 400, completion_tokens: 30, cost: 0.004 },
      })
    }
    const posts = [...prompt.matchAll(/^- postId (\S+): (\S+),/gm)].map(([, postId, channel]) => ({
      postId,
      copy: `Fixture AI copy for ${channel}: exports now finish faster and more reliably.`,
    }))
    for (const { postId } of posts) modelPosts[postId] = (modelPosts[postId] ?? 0) + 1
    return json({
      choices: [{ message: { content: JSON.stringify({ posts }) } }],
      usage: { prompt_tokens: 900, completion_tokens: 60, cost: 0.031 },
    })
  }
  if (url.pathname === '/login/oauth/authorize') {
    const callback = new URL('/integrations/github/callback', appURL)
    callback.searchParams.set('state', url.searchParams.get('state') ?? '')
    callback.searchParams.set('code', 'fixture-user-code')
    return redirect(callback.toString())
  }
  if (url.pathname === '/apps/release-fixture/installations/new') {
    installPages++
    const setup = new URL('/integrations/github/setup', appURL)
    setup.searchParams.set('state', url.searchParams.get('state') ?? '')
    setup.searchParams.set('installation_id', '77')
    setup.searchParams.set('setup_action', 'install')
    return redirect(setup.toString())
  }
  if (url.pathname === '/login/oauth/access_token' && request.method === 'POST') {
    let body = ''
    for await (const chunk of request) {
      body += chunk
      if (body.length > 8192) return json({ error: 'too_large' }, 413)
    }
    try {
      if (JSON.parse(body).code !== 'fixture-user-code') return json({ error: 'bad_code' }, 400)
    } catch {
      return json({ error: 'invalid_json' }, 400)
    }
    return json({ access_token: 'fixture-user-token' })
  }
  if (url.pathname === '/user/installations') {
    if (request.headers.authorization !== 'Bearer fixture-user-token')
      return json({ error: 'unauthorized' }, 401)
    return json({ installations: [installation] })
  }
  if (url.pathname === '/app/installations/77') return json(installation)
  if (url.pathname === '/app') return json({ events: ['deployment_status', 'workflow_run', 'workflow_job', 'release', 'pull_request', 'push', 'milestone'] })
  const workflow = { id: 301, name: 'Web image', path: '.github/workflows/web-image.yml', state: 'active' }
  if (url.pathname === '/repositories/1001/actions/workflows') return json({total_count:1,workflows:[workflow]})
  const attempt = url.pathname.match(/^\/repositories\/1001\/actions\/runs\/(\d+)\/attempts\/(\d+)(\/jobs)?$/)
  if (attempt) {
    const runId = Number(attempt[1]), runAttempt = Number(attempt[2])
    if (attempt[3]) return json({total_count:1,jobs:[{id:701,run_id:runId,run_attempt:runAttempt,name:'deploy',status:'completed',conclusion:'success'}]})
    return json({id:runId,run_attempt:runAttempt,workflow_id:workflow.id,name:workflow.name,path:workflow.path,repository})
  }
  if (url.pathname === '/app/hook/deliveries') return json([])
  if (url.pathname === '/app/installations/77/access_tokens')
    return json({
      token: 'fixture-installation-token',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    })
  if (url.pathname === '/installation/repositories') return json({ repositories: [repository] })
  if (url.pathname === '/repositories/1001') return json(repository)
  if (url.pathname === '/repositories/1001/releases' || url.pathname === '/repositories/1001/pulls')
    return json([])
  if (/^\/repositories\/1001\/releases\/\d+$/.test(url.pathname)) return json({ body_html: '' })
  if (/^\/repositories\/1001\/pulls\/\d+$/.test(url.pathname))
    return json({ changed_files: 101, body_html: '' })
  if (/^\/repositories\/1001\/pulls\/\d+\/files$/.test(url.pathname)) {
    return json(
      url.searchParams.get('page') === '1'
        ? Array.from({ length: 100 }, (_, i) => ({ filename: `docs/${i}.md` }))
        : [{ filename: 'src/export.ts' }]
    )
  }
  if (url.pathname === '/mail' && request.method === 'POST') {
    for await (const _ of request) {
      /* Drain the transport request without retaining addresses or message bodies. */
    }
    mailCount++
    return json({ accepted: true })
  }
  return json({ error: 'fixture_route_not_found' }, 404)
})
server.listen(port, '0.0.0.0', () =>
  process.stdout.write(`Release automation GitHub fixture listening on ${port}\n`)
)
process.on('SIGTERM', () => server.close())
process.on('SIGINT', () => server.close())
