import 'server-only'

import type { OrganizationAccess, TenantContext } from '@/lib/auth/access'
import { backendSDK } from '@/lib/backend/sdk'
import { ScheduledPostError } from '@/lib/tenant/scheduled-posts'
import {
  BackendSDKError,
  type OAuthProvider,
  type SocialOAuthStartOptions,
  type ScheduledPost,
} from 'screenshot-studio-backend-sdk'

export { BackendSDKError as PublishingBackendError }

type ListedScheduledPost = ScheduledPost & {
  channelConnection: NonNullable<ScheduledPost['channelConnection']>
}

export async function listBackendScheduledPosts(access: TenantContext, limit: number) {
  const result = await backendSDK(access).listScheduledPosts(limit)
  if (result.items.some((post) => !post.channelConnection)) {
    throw new BackendSDKError('Publishing backend returned an incomplete post.', 503)
  }
  return result.items as ListedScheduledPost[]
}

export async function listBackendConnections(access: OrganizationAccess) {
  const result = await backendSDK(access).listConnections()
  return result.items
}

/** Removes an account from the workspace; the Go domain cancels its queue and checks its brand's visibility. */
export async function removeBackendConnection(access: OrganizationAccess, connectionId: string) {
  return backendSDK(access).removeConnection(connectionId)
}

/** Reads an account's profile from its platform again and returns it with its health. */
export async function refreshBackendConnection(access: OrganizationAccess, connectionId: string) {
  return backendSDK(access).refreshConnection(connectionId)
}

export async function createBackendConnection(
  access: OrganizationAccess,
  input: {
    externalAccountId: string
    platform: string
    providerSettings: Record<string, unknown>
    secretReference: string
  }
) {
  return backendSDK(access).createConnection(input)
}

export async function createBackendScheduledPost(
  access: TenantContext,
  input: {
    caption: string
    channelConnectionId: string
    contentDraftId?: string
    idempotencyKey: string
    scheduledFor: Date
    variantId?: string
  }
) {
  const { contentDraftId, variantId, ...post } = input
  if (variantId && !contentDraftId)
    return backendSDK(access).createScheduledPost({ ...post, variantId })
  if (contentDraftId && !variantId) {
    return backendSDK(access).createScheduledPost({ ...post, contentDraftId })
  }
  throw new ScheduledPostError('Give exactly one of variantId and contentDraftId.', 400)
}

export async function cancelBackendScheduledPost(access: TenantContext, id: string) {
  const scheduledPost = await backendSDK(access).cancelScheduledPost(id)
  return { scheduledPost }
}

export async function beginBackendSocialOAuth(
  access: OrganizationAccess,
  provider: OAuthProvider,
  socialSetId?: string,
  options: SocialOAuthStartOptions = {}
) {
  const result = await backendSDK(access).beginSocialOAuth(provider, socialSetId, options)
  return result.url
}

export async function verifyBackendSocialOAuth(
  access: OrganizationAccess,
  provider: OAuthProvider,
  state: string,
  integrationId?: string
) {
  await backendSDK(access).verifySocialOAuth(provider, state, integrationId)
}

export async function rememberBackendInstagramIntegration(
  access: OrganizationAccess,
  state: string,
  integrationId: string
) {
  await backendSDK(access).rememberInstagramIntegration(state, integrationId)
}

export async function completeBackendSocialOAuth(
  access: OrganizationAccess,
  provider: OAuthProvider,
  state: string,
  integrationId: string
) {
  await backendSDK(access).completeSocialOAuth(provider, state, integrationId)
}
