import 'server-only'

import { BackendSDKError } from 'screenshot-studio-backend-sdk'
import { z } from 'zod'
import { type OrganizationAccess, requireActiveOrganizationPermission } from '@/lib/auth/access'
import { getAuthBaseUrl } from '@/lib/auth/environment'
import { backendSDK, serviceBackend } from '@/lib/backend/sdk'
import { githubChoiceStateSchema, githubInstallationChoiceSchema } from './github-choices'
import { verifyWebhookSignature } from './webhooks'

/** Where users return in the app after connecting GitHub. */
const SETTINGS_PATH = '/workflows/sources'

/** The outcome shown on the settings page after a connection attempt. */
export const githubConnectOutcomeSchema = z.enum([
  'choose',
  'connected',
  'failed',
  'none',
  'requested',
  'unavailable',
])

/** One of {@link githubConnectOutcomeSchema}. */
export type GitHubConnectOutcome = z.infer<typeof githubConnectOutcomeSchema>

const appSettingsSchema = z.object({
  GITHUB_APP_CLIENT_ID: z.string().min(1),
  GITHUB_APP_SLUG: z.string().regex(/^[a-z0-9-]+$/),
  GITHUB_WEB_URL: z.string().url().default('https://github.com'),
})

/** The GitHub App's public settings, or `null` when the deployment has no App. */
export function getGitHubAppSettings() {
  const parsed = appSettingsSchema.safeParse(process.env)
  return parsed.success ? parsed.data : null
}

/** The settings page with the outcome of a connection attempt, and what it needs to show it. */
export function githubSettingsUrl(
  outcome: GitHubConnectOutcome,
  extra: Record<string, string> = {}
): string {
  return `${SETTINGS_PATH}?${new URLSearchParams({ github: outcome, ...extra })}`
}

/** The backend's answer when the user must pick one of several installations. */
const choiceRequiredSchema = z.object({
  choices: z.array(githubInstallationChoiceSchema).min(2).max(100),
  code: z.literal('github_installation_choice_required'),
})

/** GitHub's authorization page; the installation (0: one the user already has) rides in the state. */
function authorizeUrl(
  settings: NonNullable<ReturnType<typeof getGitHubAppSettings>>,
  state: string,
  installationId: string
): string {
  const authorize = new URL('/login/oauth/authorize', settings.GITHUB_WEB_URL)
  authorize.searchParams.set('client_id', settings.GITHUB_APP_CLIENT_ID)
  authorize.searchParams.set(
    'redirect_uri',
    new URL('/integrations/github/callback', getAuthBaseUrl()).toString()
  )
  authorize.searchParams.set('state', `${state}.${installationId}`)
  return authorize.toString()
}

/** GitHub's install page; GitHub returns to the setup route with what was installed. */
function installUrl(
  settings: NonNullable<ReturnType<typeof getGitHubAppSettings>>,
  state: string
): string {
  return `${settings.GITHUB_WEB_URL}/apps/${settings.GITHUB_APP_SLUG}/installations/new?state=${encodeURIComponent(state)}`
}

/**
 * Begin connecting a GitHub App installation to the active workspace, with a
 * single-use state bound to this user and session. Authorization comes first:
 * it shows what the user can already reach, so an existing install links with
 * no install page, and {@link completeGitHubConnection} sends everyone else
 * there. `install` goes straight to it, for a person choosing another account.
 */
export async function startGitHubConnection(headers: Headers, install = false): Promise<string> {
  const settings = getGitHubAppSettings()
  if (!settings) return githubSettingsUrl('unavailable')
  const access = await requireActiveOrganizationPermission(headers, 'workspace:update')
  const { state } = await backendSDK(access).startGitHubConnection()
  return install ? installUrl(settings, state) : authorizeUrl(settings, state, '0')
}

const setupSchema = z.object({
  installation_id: z.string().regex(/^[1-9][0-9]{0,18}$/),
  setup_action: z.string().optional(),
  state: z.string().max(200).optional(),
})

/**
 * After an install, send the user through GitHub's authorization so the
 * backend can confirm they can access the installation GitHub named. The
 * installation ID rides in the OAuth state; it stays a hint until verified.
 */
export async function continueGitHubSetup(
  headers: Headers,
  params: URLSearchParams
): Promise<string> {
  const settings = getGitHubAppSettings()
  if (!settings) return githubSettingsUrl('unavailable')
  if (params.get('setup_action') === 'request') return githubSettingsUrl('requested')
  const setup = setupSchema.safeParse(Object.fromEntries(params))
  if (!setup.success) return githubSettingsUrl('failed')
  // An install begun on GitHub, not from the app, gets a state now.
  const access = await requireActiveOrganizationPermission(headers, 'workspace:update')
  const state = setup.data.state || (await backendSDK(access).startGitHubConnection()).state
  return authorizeUrl(settings, state, setup.data.installation_id)
}

const callbackSchema = z.object({
  code: z.string().min(1).max(200),
  state: z.string().regex(/^[A-Za-z0-9_-]{20,200}\.(0|[1-9][0-9]{0,18})$/),
})

/**
 * Finish connecting: the backend verifies the user's access and links the
 * installation. Linking an existing one may need the user to pick it first.
 */
export async function completeGitHubConnection(
  headers: Headers,
  params: URLSearchParams
): Promise<string> {
  const callback = callbackSchema.safeParse(Object.fromEntries(params))
  if (!callback.success) return githubSettingsUrl('failed')
  const access = await requireActiveOrganizationPermission(headers, 'workspace:update')
  const separator = callback.data.state.lastIndexOf('.')
  const state = callback.data.state.slice(0, separator)
  const installationId = Number(callback.data.state.slice(separator + 1))
  try {
    await backendSDK(access).completeGitHubConnection({
      code: callback.data.code,
      installationId,
      state,
    })
  } catch (error) {
    if (!(error instanceof BackendSDKError)) throw error
    if (error.status === 404) {
      // Nothing to link yet, so install. The unused state carries the return trip.
      const settings = getGitHubAppSettings()
      return installationId === 0 && settings
        ? installUrl(settings, state)
        : githubSettingsUrl('none')
    }
    const choice = choiceRequiredSchema.safeParse(error.details)
    if (error.status !== 409 || !choice.success) throw error
    const choices = choice.data.choices.map(({ accountLogin, id }) => `${id}:${accountLogin}`)
    return githubSettingsUrl('choose', { choices: choices.join(','), state })
  }
  return githubSettingsUrl('connected')
}

const chooseSchema = z.object({
  installation_id: z.string().regex(/^[1-9][0-9]{0,18}$/),
  state: githubChoiceStateSchema,
})

/** Link the installation the user picked; the backend accepts only ones GitHub verified. */
export async function chooseGitHubInstallation(
  headers: Headers,
  params: URLSearchParams
): Promise<string> {
  const choice = chooseSchema.safeParse(Object.fromEntries(params))
  if (!choice.success) return githubSettingsUrl('failed')
  const access = await requireActiveOrganizationPermission(headers, 'workspace:update')
  await backendSDK(access).completeGitHubConnection({
    code: '',
    installationId: Number(choice.data.installation_id),
    state: choice.data.state,
  })
  return githubSettingsUrl('connected')
}

/** The installations the workspace has connected. */
export async function listGitHubConnections(access: OrganizationAccess) {
  return (await backendSDK(access).listGitHubConnections()).connections
}

/** The repositories a connected installation can read. */
export async function listGitHubRepositories(access: OrganizationAccess, connectionId: string) {
  return (await backendSDK(access).listGitHubRepositories(connectionId)).repositories
}

/** Disconnect an installation; the workspace's sources from it are archived. */
export async function deleteGitHubConnection(access: OrganizationAccess, connectionId: string) {
  return backendSDK(access).deleteGitHubConnection(connectionId)
}

/**
 * The App's deliveries are signed with the secret configured on the App.
 * During a rotation the previous secret also verifies (docs/deployment.md).
 */
export function verifyGitHubAppDelivery(body: string, signature: string | null): boolean {
  return [
    process.env.GITHUB_APP_WEBHOOK_SECRET,
    process.env.GITHUB_APP_WEBHOOK_SECRET_PREVIOUS,
  ].some((secret) => Boolean(secret) && verifyWebhookSignature(body, signature, secret ?? ''))
}

/** App events the platform acts on; any other is acknowledged and ignored. */
export const githubAppEventSchema = z.enum([
  'deployment_status',
  'workflow_run',
  'workflow_job',
  'check_run',
  'status',
  'installation',
  'installation_repositories',
  'milestone',
  'pull_request',
  'push',
  'release',
])

const installationSchema = z.object({
  account: z.object({ login: z.string().min(1).max(100), type: z.string().min(1).max(40) }),
  id: z.number().int().positive(),
  repository_selection: z.string().max(20).nullish(),
  suspended_at: z.string().nullish(),
})

const installationEventSchema = z.object({ action: z.string(), installation: installationSchema })

const installationRepositoriesSchema = z.object({
  action: z.string(),
  installation: z.object({ id: z.number().int().positive() }),
  repositories_removed: z.array(z.object({ id: z.number().int().positive() })).nullish(),
})

/** GitHub installation lifecycle actions and the state each leaves. */
const installationStatus = {
  deleted: 'DELETED',
  suspend: 'SUSPENDED',
  unsuspend: 'ACTIVE',
} as const

/**
 * Act on one verified App delivery: keep installations current, archive what
 * GitHub access was removed from, and fan a repository event out to every
 * workspace watching that repository, each under its own rules. Returns how
 * many records the delivery touched; a failure throws so GitHub shows it and
 * a redelivery (idempotent per workspace) can retry.
 */
export async function handleGitHubAppDelivery(input: {
  body: string
  deliveryId: string
  eventName: string | null
}): Promise<{ handled: number }> {
  const event = githubAppEventSchema.safeParse(input.eventName)
  if (!event.success) return { handled: 0 }
  const payload = JSON.parse(input.body) as unknown
  const backend = serviceBackend()
  switch (event.data) {
    case 'installation': {
      const { action, installation } = installationEventSchema.parse(payload)
      const status = installationStatus[action as keyof typeof installationStatus]
      if (status === 'DELETED' || status === 'SUSPENDED') {
        await backend.setGitHubInstallationStatus(installation.id, status)
        return { handled: 1 }
      }
      await backend.recordGitHubInstallation(installation.id, {
        accountLogin: installation.account.login,
        accountType: installation.account.type,
        repositorySelection: installation.repository_selection ?? 'selected',
        suspended: Boolean(installation.suspended_at) && action !== 'unsuspend',
      })
      return { handled: 1 }
    }
    case 'installation_repositories': {
      const { installation, repositories_removed: removed } =
        installationRepositoriesSchema.parse(payload)
      if (!removed?.length) return { handled: 0 }
      const result = await backend.removeGitHubRepositories(
        installation.id,
        removed.map((repository) => String(repository.id))
      )
      return { handled: result.archived }
    }
    default: {
      return backend.acceptGitHubEvent({
        body: payload,
        deliveryId: input.deliveryId,
        eventName: event.data,
      })
    }
  }
}
