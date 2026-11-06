import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { BackendSDKError } from 'screenshot-studio-backend-sdk'
import { ConnectionCompletion } from '@/components/social-connections/Completion'
import { backendSDK } from '@/lib/backend/sdk'
import { getRequestId } from '@/lib/auth/access'
import { auth } from '@/lib/auth/server'
import {
  socialOAuthCompletedPath,
  socialOAuthCompletionQuerySchema,
  socialOAuthCompletionViewSchema,
} from '@/lib/tenant/social-oauth-completion'

export const metadata: Metadata = {
  title: 'Connection completed',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

/** Resolve the receipt using its original session, independent of the currently selected workspace. */
export default async function Page(
  props: PageProps<'/[locale]/integrations/social/[provider]/complete'>
) {
  const [{ provider }, query, requestHeaders] = await Promise.all([
    props.params,
    props.searchParams,
    headers(),
  ])
  const input = socialOAuthCompletionQuerySchema.safeParse({ provider, state: query.state })
  const session = await auth.api.getSession({
    headers: requestHeaders,
    query: { disableCookieCache: true },
  })
  let confirmation = null
  if (input.success && session) {
    const client = backendSDK({
      organizationId: '',
      principal: {
        kind: 'session',
        userId: session.user.id,
        sessionId: session.session.id,
        display: session.user.email,
      },
      requestId: getRequestId(requestHeaders),
    })
    try {
      const context = await client.resolveSocialOAuthContext(input.data.provider, input.data.state)
      if (context.completed) {
        const { workspaces } = await client.listWorkspaces()
        const workspace = workspaces.find(
          (item) => item.id === context.organizationId && !item.isScheduledForDeletion
        )
        if (workspace)
          confirmation = socialOAuthCompletionViewSchema.parse({
            ...context,
            provider: input.data.provider,
            workspaceName: workspace.name,
            userId: session.user.id,
            sessionId: session.session.id,
          })
      }
    } catch (error) {
      if (!(error instanceof BackendSDKError) || ![403, 404, 409, 410].includes(error.status))
        throw error
    }
  }
  if (confirmation && session?.session.activeOrganizationId === confirmation.organizationId)
    redirect(socialOAuthCompletedPath(confirmation))
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6 py-12 text-foreground">
      <section className="w-full max-w-md rounded-xl border border-border bg-card p-7">
        {confirmation ? (
          <ConnectionCompletion {...confirmation} />
        ) : (
          <div className="space-y-4">
            <h1 className="text-xl font-semibold">Connection confirmation unavailable</h1>
            <p className="text-sm text-muted-foreground">
              This confirmation has expired or your access has changed. Open your workspace to check
              the account.
            </p>
            <Link href="/settings/channels" className="text-sm underline underline-offset-4">
              Open workspace
            </Link>
          </div>
        )}
      </section>
    </main>
  )
}
