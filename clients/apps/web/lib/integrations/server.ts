import 'server-only'

import { backendSDK } from '@/lib/backend/sdk'
import { appOrigin } from '@/lib/sharing/page'
import { shareUrl } from '@/lib/sharing/schema'
import { getShareLink } from '@/lib/sharing/server'
import type { TenantContext } from '@/lib/auth/access'
import { canSealCredentials, openCredentials, sealCredentials } from './crypto'
import { deliverToFigma, deliverToNotion, type DeliveryResult } from './deliver'
import {
  type Grant,
  ProviderError,
  providerClient,
  providerEnvironment,
  refreshGrant,
} from './providers'
import {
  type DeliveryTarget,
  type Integration,
  type IntegrationProvider,
  integrationProviderSchema,
  integrationSchema,
} from './schema'

/** A workspace principal the backend acts for. */
type BackendContext = Parameters<typeof backendSDK>[0]

/** Refresh tokens this long before they expire. */
const REFRESH_MARGIN_MS = 2 * 60_000

/** Whether each provider can be connected here, and what is missing when not. */
export async function providerSetup(
  context: BackendContext
): Promise<Record<IntegrationProvider, { missing: string[]; ready: boolean }>> {
  const slack = await backendSDK(context).slackSetup()
  const sealing = canSealCredentials()
  return Object.fromEntries(
    integrationProviderSchema.options.map((provider) => {
      if (provider === 'SLACK')
        return [
          provider,
          { ready: slack.ready, missing: slack.ready ? [] : ['backend Slack configuration'] },
        ]
      const missing = [
        ...(providerClient(provider) ? [] : providerEnvironment(provider)),
        ...(sealing ? [] : ['INTEGRATION_ENCRYPTION_KEY']),
      ]
      return [provider, { missing, ready: missing.length === 0 }]
    })
  ) as Record<IntegrationProvider, { missing: string[]; ready: boolean }>
}

/** The workspace's connections, without credentials. */
export async function listIntegrations(context: BackendContext): Promise<Integration[]> {
  const { integrations } = await backendSDK(context).listIntegrations()
  // Senja's key imports testimonials (lib/content-drafts/senja.ts); it delivers nothing.
  return integrations
    .filter((integration) => integration.provider !== 'SENJA')
    .map((integration) => integrationSchema.parse(integration))
}

/** Store a new grant (a first connection, or a reconnection of the same account). */
export async function saveGrant(
  context: BackendContext,
  provider: IntegrationProvider,
  grant: Grant
) {
  return integrationSchema.parse(
    await backendSDK(context).saveIntegration({
      displayName: grant.displayName,
      encryptedCredentials: sealCredentials(grant.credentials),
      externalId: grant.externalId,
      provider,
      scopes: grant.scopes,
      tokenExpiresAt: grant.expiresAt,
    })
  )
}

/** Disconnect an account and forget its credentials. */
export async function disconnectIntegration(context: BackendContext, id: string) {
  await backendSDK(context).deleteIntegration(id)
}

/** A connection's access token, refreshed first when it is about to expire. */
export async function accessToken(
  context: TenantContext,
  id: string
): Promise<{ integration: Integration; token: string }> {
  const sdk = backendSDK(context)
  const stored = await sdk.integrationCredentials(id)
  const integration = integrationSchema.parse(stored)
  const credentials = openCredentials(stored.encryptedCredentials)
  const expiring =
    integration.tokenExpiresAt &&
    integration.tokenExpiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS
  if (!expiring) return { integration, token: credentials.accessToken }
  const client = providerClient(integration.provider)
  const refreshing =
    client && refreshGrant(integration.provider, client, { ...integration, credentials })
  if (!refreshing) throw new ProviderError('This connection expired. Connect it again.', true)
  const grant = await refreshing
  await sdk.updateIntegrationCredentials(id, {
    encryptedCredentials: sealCredentials(grant.credentials),
    tokenExpiresAt: grant.expiresAt,
  })
  return { integration, token: grant.credentials.accessToken }
}

const EXTENSIONS: Record<string, string> = {
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
}

/** Deliver a live share link of this workspace through one of its connections. */
export async function deliverShareLink(
  context: TenantContext,
  input: { integrationId: string; shareLinkId: string; target: DeliveryTarget }
): Promise<DeliveryResult> {
  if (input.target.kind === 'slack')
    return backendSDK(context).deliverSlackDesign(input.integrationId, {
      shareLinkId: input.shareLinkId,
      channelId: input.target.channelId,
      message: input.target.message,
    })
  const link = await getShareLink(context, input.shareLinkId)
  if (!link || link.revokedAt || (link.expiresAt && link.expiresAt <= new Date())) {
    throw new ProviderError('That share link is no longer live. Publish again.')
  }
  const { integration, token } = await accessToken(context, input.integrationId)
  const expected = { figma: 'FIGMA', notion: 'NOTION' }[input.target.kind]
  if (integration.provider !== expected)
    throw new ProviderError('That connection is for another app.')
  const bytes = await backendSDK(context).readAsset(link.assetId)
  const slug =
    link.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 60) || 'design'
  const delivery = {
    altText: link.altText,
    bytes,
    fileName: `${slug}.${EXTENSIONS[link.mediaType] ?? 'bin'}`,
    mediaType: link.mediaType,
    shareUrl: shareUrl(appOrigin(), link.token),
    title: link.title,
  }
  const { target } = input
  if (target.kind === 'notion') return deliverToNotion(token, delivery, target)
  return deliverToFigma(token, delivery, target)
}
