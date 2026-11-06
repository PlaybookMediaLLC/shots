import { startGitHubConnection, githubSettingsUrl } from '@/lib/tenant/github'
import { headersWithNavigationScope } from '@/lib/auth/request-scope'

/** Send an admin to GitHub to link the App, or install it if there is nothing to link; `?install=1` goes straight to installing. */
export async function GET(request: Request): Promise<Response> {
  let destination: string
  try {
    const install = new URL(request.url).searchParams.get('install') === '1'
    destination = await startGitHubConnection(headersWithNavigationScope(request), install)
  } catch {
    destination = githubSettingsUrl('failed')
  }
  return new Response(null, {
    headers: { 'Cache-Control': 'no-store', Location: destination },
    status: 303,
  })
}
