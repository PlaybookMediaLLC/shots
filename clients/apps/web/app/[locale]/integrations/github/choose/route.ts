import { chooseGitHubInstallation, githubSettingsUrl } from '@/lib/tenant/github'
import { headersWithNavigationScope } from '@/lib/auth/request-scope'

/** Link the installation the user picked after GitHub verified their access to several. */
export async function GET(request: Request): Promise<Response> {
  let destination: string
  try {
    destination = await chooseGitHubInstallation(
      headersWithNavigationScope(request),
      new URL(request.url).searchParams
    )
  } catch {
    destination = githubSettingsUrl('failed')
  }
  return new Response(null, {
    headers: { 'Cache-Control': 'no-store', Location: destination },
    status: 303,
  })
}
