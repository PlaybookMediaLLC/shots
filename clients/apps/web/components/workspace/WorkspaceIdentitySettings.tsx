'use client'

import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react'
import { z } from 'zod'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { useHydratedSession } from '@/lib/auth/client'
import { useTRPCClient } from '@/lib/trpc/react'
import { Group, Row, Section } from '@/components/platform-ui'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { WorkspaceSsoList } from './WorkspaceSsoList'
import { getErrorMessage, requestJson } from './settings-client'
import { Label } from '@/components/ui/label'

const ssoProviderSchema = z.object({
  domain: z.string(),
  organizationId: z.string().nullable(),
  providerId: z.string(),
})
const ssoProvidersSchema = z.object({ providers: z.array(ssoProviderSchema) })
const scimProviderSchema = z.object({
  id: z.string(),
  organizationId: z.string().nullable(),
  providerId: z.string(),
})
const scimProvidersSchema = z.object({ providers: z.array(scimProviderSchema) })
const scimTokenSchema = z.object({ scimToken: z.string() })
const ssoInputSchema = z.object({
  clientId: z.string().trim().min(1),
  clientSecret: z.string().trim().min(1),
  domain: z.string().trim().min(3),
  issuer: z.string().url(),
  providerId: z
    .string()
    .trim()
    .regex(/^[a-z0-9_-]+$/),
})

type WorkspaceIdentitySettingsProps = {
  canManage: boolean
  isOwner: boolean
  organizationId: string
}
type ScimProvider = z.infer<typeof scimProviderSchema>
export type SsoProvider = z.infer<typeof ssoProviderSchema>

export function WorkspaceIdentitySettings({
  canManage,
  isOwner,
  organizationId,
}: WorkspaceIdentitySettingsProps) {
  const trpcClient = useTRPCClient()
  const { data: session } = useHydratedSession()
  const billing = useQuery({
    enabled: canManage,
    queryFn: () => trpcClient.billing.summary.query(),
    queryKey: ['billing', organizationId, 'summary'],
  })
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  const fresh = Boolean(
    session && now - new Date(session.session.createdAt).getTime() < 15 * 60 * 1000
  )
  const twoFactor = session?.user.twoFactorEnabled === true
  const enterprise = billing.data?.plan === 'enterprise' && billing.data.paid
  const ready = canManage && enterprise && fresh && twoFactor
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [scimProviders, setScimProviders] = useState<ScimProvider[]>([])
  const [ssoProviders, setSsoProviders] = useState<SsoProvider[]>([])
  const [token, setToken] = useState<string | null>(null)

  const loadProviders = useCallback(async (): Promise<void> => {
    try {
      const [sso, scim] = await Promise.all([
        requestJson('/api/auth/sso/providers', ssoProvidersSchema),
        requestJson('/api/auth/scim/list-provider-connections', scimProvidersSchema),
      ])
      setSsoProviders(
        sso.providers.filter((provider) => provider.organizationId === organizationId)
      )
      setScimProviders(
        scim.providers.filter((provider) => provider.organizationId === organizationId)
      )
    } catch (requestError) {
      setError(getErrorMessage(requestError))
    }
  }, [organizationId])

  useEffect(() => {
    if (canManage) void loadProviders()
  }, [canManage, loadProviders])

  async function registerSso(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!ready) return
    setError(null)
    const form = event.currentTarget
    const input = ssoInputSchema.safeParse(Object.fromEntries(new FormData(form)))
    if (!input.success) {
      setError(input.error.issues[0]?.message ?? 'Check the provider details.')
      return
    }
    setPending('sso')
    try {
      await requestJson('/api/auth/sso/register', z.unknown(), {
        body: {
          ...input.data,
          oidcConfig: {
            clientId: input.data.clientId,
            clientSecret: input.data.clientSecret,
            pkce: true,
          },
          organizationId,
        },
        method: 'POST',
      })
      form.reset()
      await loadProviders()
    } catch (requestError) {
      setError(getErrorMessage(requestError))
    } finally {
      setPending(null)
    }
  }

  async function generateScimToken(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!ready) return
    setError(null)
    const form = event.currentTarget
    const providerId = String(new FormData(form).get('providerId') ?? '')
    setPending('scim')
    try {
      const result = await requestJson('/api/auth/scim/generate-token', scimTokenSchema, {
        body: { organizationId, providerId },
        method: 'POST',
      })
      setToken(result.scimToken)
      form.reset()
      await loadProviders()
    } catch (requestError) {
      setError(getErrorMessage(requestError))
    } finally {
      setPending(null)
    }
  }

  async function removeScimProvider(provider: ScimProvider): Promise<void> {
    setError(null)
    setPending(provider.id)
    try {
      await requestJson('/api/auth/scim/delete-provider-connection', z.unknown(), {
        body: { providerId: provider.providerId },
        method: 'POST',
      })
      await loadProviders()
    } catch (requestError) {
      setError(getErrorMessage(requestError))
    } finally {
      setPending(null)
    }
  }

  if (!canManage)
    return (
      <p className="text-sm text-muted-foreground">
        SSO and SCIM configuration is available to workspace admins.
      </p>
    )
  return (
    <div className="flex flex-col gap-10">
      <Section title="Before you connect">
        <ul className="grid gap-3 text-sm">
          <li>
            Enterprise plan:{' '}
            {billing.isPending
              ? 'Checking…'
              : billing.isError
                ? 'Could not verify'
                : enterprise
                  ? 'Active'
                  : 'Required'}{' '}
            ·{' '}
            <Link className="underline" href="/settings/billing">
              View billing
            </Link>
          </li>
          <li>
            Two-factor authentication: {twoFactor ? 'Enabled' : 'Required'} ·{' '}
            <Link className="underline" href="/settings/security">
              Security settings
            </Link>
          </li>
          <li>
            Sign-in within the last 15 minutes: {fresh ? 'Confirmed' : 'Required'} ·{' '}
            <Link
              className="underline"
              href="/sign-in?reauthenticate=1&callbackURL=%2Fworkspace%2Fsso"
            >
              Verify identity
            </Link>
          </li>
        </ul>
        {!ready ? (
          <p className="text-sm text-muted-foreground">
            Complete these steps to enter your provider credentials.
          </p>
        ) : null}
      </Section>
      {token ? <ScimTokenNotice onDismiss={() => setToken(null)} token={token} /> : null}
      <Section
        description="Connect Okta, Microsoft Entra ID, or another OIDC identity provider."
        title="OpenID Connect SSO"
      >
        <Group>
          <WorkspaceSsoList providers={ssoProviders} />
          {ready ? (
            <Row>
              <SsoForm isSubmitting={pending === 'sso'} onSubmit={registerSso} />
            </Row>
          ) : null}
        </Group>
      </Section>
      <Section
        description="Create a provisioning token for your directory provider."
        title="SCIM directory sync"
      >
        <Group>
          <ScimList
            isDeleting={pending}
            onDelete={removeScimProvider}
            disabled={!ready}
            providers={scimProviders}
          />
          {isOwner && ready ? (
            <Row>
              <ScimForm isSubmitting={pending === 'scim'} onSubmit={generateScimToken} />
            </Row>
          ) : null}
        </Group>
      </Section>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  )
}

function Field({
  children,
  htmlFor,
  label,
}: {
  children: ReactNode
  htmlFor: string
  label: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs font-medium text-foreground/65" htmlFor={htmlFor}>
        {label}
      </Label>
      {children}
    </div>
  )
}

const inputClassName = 'h-10 rounded-lg'

function SsoForm({
  isSubmitting,
  onSubmit,
}: {
  isSubmitting: boolean
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>
}) {
  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit}>
      <div>
        <h3 className="text-sm font-medium text-foreground">Add a provider</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Use the issuer and client credentials from your identity provider.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field htmlFor="sso-provider-id" label="Provider ID">
          <Input
            className={inputClassName}
            id="sso-provider-id"
            name="providerId"
            placeholder="acme-okta"
            required
          />
        </Field>
        <Field htmlFor="sso-domain" label="Email domain">
          <Input
            className={inputClassName}
            id="sso-domain"
            name="domain"
            placeholder="company.com"
            required
          />
        </Field>
        <Field htmlFor="sso-issuer" label="Issuer URL">
          <Input
            className={inputClassName}
            id="sso-issuer"
            name="issuer"
            placeholder="https://company.okta.com"
            required
            type="url"
          />
        </Field>
        <Field htmlFor="sso-client-id" label="Client ID">
          <Input
            className={inputClassName}
            id="sso-client-id"
            name="clientId"
            placeholder="Client ID"
            required
          />
        </Field>
        <div className="sm:col-span-2">
          <Field htmlFor="sso-client-secret" label="Client secret">
            <Input
              className={inputClassName}
              id="sso-client-secret"
              name="clientSecret"
              placeholder="Client secret"
              required
              type="password"
            />
          </Field>
        </div>
      </div>
      <div className="flex justify-end">
        <Button className="rounded-lg" disabled={isSubmitting} type="submit">
          {isSubmitting ? 'Connecting…' : 'Connect SSO provider'}
        </Button>
      </div>
    </form>
  )
}

function ScimForm({
  isSubmitting,
  onSubmit,
}: {
  isSubmitting: boolean
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>
}) {
  return (
    <form className="flex flex-col gap-3" onSubmit={onSubmit}>
      <Label className="text-xs font-medium text-foreground/65" htmlFor="scim-provider-id">
        Provider ID
      </Label>
      <div className="flex gap-3">
        <Input
          className="h-10 flex-1 rounded-lg"
          id="scim-provider-id"
          name="providerId"
          placeholder="acme-scim"
          required
        />
        <Button className="h-10 rounded-lg" disabled={isSubmitting} type="submit">
          {isSubmitting ? 'Generating…' : 'Generate token'}
        </Button>
      </div>
    </form>
  )
}

function ScimTokenNotice({ onDismiss, token }: { onDismiss: () => void; token: string }) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-emerald-500/5 p-5 ring-1 ring-emerald-500/20">
      <p className="text-sm font-medium text-foreground">
        Copy this SCIM token now. It cannot be shown again.
      </p>
      <code className="overflow-x-auto rounded-lg bg-black/30 p-3 font-mono text-xs text-foreground/80 ring-1 ring-foreground/[0.08]">
        {token}
      </code>
      <Button className="w-fit rounded-lg" onClick={onDismiss} size="sm" type="button">
        Done
      </Button>
    </div>
  )
}

function ScimList({
  disabled,
  isDeleting,
  onDelete,
  providers,
}: {
  disabled: boolean
  isDeleting: string | null
  onDelete: (provider: ScimProvider) => Promise<void>
  providers: ScimProvider[]
}) {
  if (providers.length === 0)
    return (
      <Row>
        <p className="text-sm text-muted-foreground">No directory connections are configured.</p>
      </Row>
    )
  return providers.map((provider) => (
    <div className="flex items-center gap-4 px-5 py-4" key={provider.id}>
      <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-emerald-500" />
      <span className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">
        {provider.providerId}
      </span>
      <Button
        className="text-red-700 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
        disabled={disabled || isDeleting === provider.id}
        onClick={() => void onDelete(provider)}
        size="sm"
        type="button"
        variant="ghost"
      >
        Remove
      </Button>
    </div>
  ))
}
