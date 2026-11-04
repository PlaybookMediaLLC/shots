import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { BackendSDKError } from 'screenshot-studio-backend-sdk'
import { AuthShell } from '@/components/auth/AuthShell'
import { AgentAccessExpiry } from '@/components/auth/AgentAccessExpiry'
import { Button } from '@/components/ui/button'
import { AuthorizationError, requireActiveOrganizationPermission } from '@/lib/auth/access'
import { apiKeyScopeDescriptions, apiKeyScopes, type ApiKeyScope } from '@/lib/auth/api-key-scopes'
import { getLocalizedPath, getPageAccess } from '@/lib/auth/page-access'
import {
  agentAuthorizationQuerySchema,
  previewAgentAuthorization,
  requestedScopes,
} from '@/lib/tenant/agent-access'
import { approveAgentConnection, denyAgentConnection } from './actions'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'

export const metadata: Metadata = { robots: { index: false }, title: 'Connect an AI agent' }

type ConsentPageProps = {
  params: Promise<{ locale: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

const DEFAULT_SCOPES: ApiKeyScope[] = ['artifact:read', 'release:create']

function single(params: Record<string, string | string[] | undefined>) {
  return Object.fromEntries(
    Object.entries(params).flatMap(([key, value]) =>
      typeof value === 'string' ? [[key, value]] : []
    )
  )
}

function Refusal({ message }: { message: string }) {
  return (
    <AuthShell description={message} title="This connection can’t be approved">
      <p className="text-sm text-neutral-500">
        Start the connection again from your AI client. If it keeps failing, check the server URL in
        Settings → AI agents.
      </p>
    </AuthShell>
  )
}

/**
 * The OAuth consent page for MCP clients (RFC 026). The authorization server
 * metadata points clients here; approving issues a single-use code for a
 * workspace API key with exactly the scopes chosen below.
 */
export default async function AgentConsentPage({ params, searchParams }: ConsentPageProps) {
  const [{ locale }, raw, requestHeaders] = await Promise.all([params, searchParams, headers()])
  const query = agentAuthorizationQuerySchema.safeParse(single(raw))
  if (!query.success) return <Refusal message="The authorization request is incomplete." />

  const access = await getPageAccess(requestHeaders)
  if (!access) {
    const here = `/oauth/authorize?${new URLSearchParams(single(raw))}`
    redirect(getLocalizedPath(locale, `/sign-in?callbackURL=${encodeURIComponent(here)}`))
  }
  if (!access.hasOrganization) redirect(getLocalizedPath(locale, '/onboarding'))

  let consent
  try {
    const member = await requireActiveOrganizationPermission(requestHeaders, 'brand:manage')
    consent = await previewAgentAuthorization(member, query.data)
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return <Refusal message="Only a workspace owner or admin can connect an AI agent." />
    }
    if (error instanceof BackendSDKError && error.status === 400) {
      return <Refusal message={error.message} />
    }
    throw error
  }

  const requested = requestedScopes(query.data.scope)
  const checked = requested.length ? requested : DEFAULT_SCOPES
  const hidden = Object.entries(query.data).filter(([, value]) => value !== undefined)

  return (
    <AuthShell
      description={`${consent.clientName} wants to work in ${access.organization?.name ?? 'your workspace'} through the Shots MCP server.`}
      eyebrow="Connect an AI agent"
      title={`Connect ${consent.clientName}?`}
    >
      <form className="flex flex-col gap-6">
        {hidden.map(([key, value]) => (
          <Input key={key} name={key} type="hidden" value={value} />
        ))}
        <p className="rounded-xl bg-white/[0.03] p-3 text-sm text-neutral-400 ring-1 ring-white/[0.08]">
          After you approve, you return to{' '}
          <span className="text-white">{consent.redirectHost}</span>. Only approve if you started
          this connection.
        </p>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-ui-lg font-medium text-white">What it may do</legend>
          {apiKeyScopes.map((scope) => (
            <Label className="flex items-start gap-3" key={scope}>
              <Checkbox
                className="mt-1 size-4 accent-white"
                defaultChecked={checked.includes(scope)}
                name="scopes"
                value={scope}
              />
              <span className="flex flex-col">
                <span className="font-mono text-xs text-neutral-300">{scope}</span>
                <span className="text-sm text-neutral-500">{apiKeyScopeDescriptions[scope]}</span>
              </span>
            </Label>
          ))}
          <p className="text-xs text-neutral-500">
            No agent can approve content; a person does that in Shots. With post:schedule, it can
            schedule and cancel posts a person already approved.
          </p>
        </fieldset>
        <Label className="flex flex-col gap-1.5 text-sm text-neutral-400">
          Access expires
          <AgentAccessExpiry />
        </Label>
        <div className="flex gap-3">
          <Button className="flex-1 rounded-lg" formAction={approveAgentConnection} type="submit">
            Approve
          </Button>
          <Button
            className="flex-1 rounded-lg"
            formAction={denyAgentConnection}
            type="submit"
            variant="ghost"
          >
            Deny
          </Button>
        </div>
      </form>
    </AuthShell>
  )
}
