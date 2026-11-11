import 'server-only'

import { randomUUID } from 'node:crypto'
import { context, propagation } from '@opentelemetry/api'
import type { StoreProvider } from '@/lib/api/contracts/store-publishing'
import type { Principal } from '@/lib/auth/principal'
import {
  BackendSDKError,
  ScreenshotStudioBackendSDK,
  type BackendScope,
} from 'screenshot-studio-backend-sdk'

type BackendContext = { organizationId: string; principal: Principal; requestId: string }

/** The principal half of a backend scope, per principal kind. */
type PrincipalScope = BackendScope extends infer Scope
  ? Scope extends unknown
    ? Omit<Scope, 'organizationId' | 'requestId'>
    : never
  : never

function principalScope(principal: Principal): PrincipalScope {
  switch (principal.kind) {
    case 'session':
      return {
        client: principal.client,
        display: principal.display,
        kind: 'session',
        sessionId: principal.sessionId,
        userId: principal.userId,
      }
    case 'organization_api_key':
      return { display: principal.display, keyId: principal.keyId, kind: 'api_key' }
    case 'support':
      return { grantId: principal.grantId, kind: 'support', userId: principal.userId }
    case 'webhook':
      return { display: principal.connectionId, kind: 'webhook' }
    case 'trigger_service':
      return { display: principal.taskRunId, kind: 'service' }
  }
}

/**
 * fetch that sends the active trace to the Go backend as `traceparent`, so a
 * backend span joins the web request's trace. Without telemetry the global
 * propagator adds nothing.
 */
const tracedFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers)
  propagation.inject(context.active(), headers, {
    set: (carrier, key, value) => carrier.set(key, value),
  })
  return fetch(input, { ...init, headers })
}

function client(scope: BackendScope): ScreenshotStudioBackendSDK {
  return new ScreenshotStudioBackendSDK(
    process.env.PUBLISHING_API_URL ?? '',
    process.env.PUBLISHING_SERVICE_TOKEN ?? '',
    scope,
    tracedFetch
  )
}

/** The backend client acting for this principal in its workspace. */
export function backendSDK(context: BackendContext): ScreenshotStudioBackendSDK {
  return client({
    organizationId: context.organizationId,
    requestId: context.requestId,
    ...principalScope(context.principal),
  } as BackendScope)
}

/**
 * The backend client for the web facade itself: the Better Auth adapter and
 * effects of auth changes, which run before or outside any tenant principal.
 */
export function serviceBackend(): ScreenshotStudioBackendSDK {
  return client({ display: 'web', kind: 'service', organizationId: '', requestId: randomUUID() })
}

/** A backend 404 is a missing tenant row, which the readers return as null. */
export async function orNull<T>(request: Promise<T>): Promise<T | null> {
  try {
    return await request
  } catch (error) {
    if (error instanceof BackendSDKError && error.status === 404) return null
    throw error
  }
}

type WithDates<T> = T extends string
  ? T
  : T extends (infer Item)[]
    ? WithDates<Item>[]
    : T extends object
      ? {
          [Key in keyof T]: Key extends `${string}At`
            ? Exclude<T[Key], string> | Date
            : WithDates<T[Key]>
        }
      : T

/** Backend JSON carries ISO timestamps; the web readers return `*At` fields as Dates. */
export function withDates<T>(value: T): WithDates<T> {
  if (Array.isArray(value)) return value.map(withDates) as WithDates<T>
  if (!value || typeof value !== 'object') return value as WithDates<T>
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key.endsWith('At') && typeof item === 'string' ? new Date(item) : withDates(item),
    ])
  ) as WithDates<T>
}

type StoreBackendRequest = <T>(
  path: string,
  init?: { body?: unknown; headers?: Record<string, string>; method?: 'GET' | 'POST' | 'PUT' | 'DELETE' }
) => Promise<T>

/**
 * Store screenshot review and credential endpoints. They are added to the
 * SDK package source in this release; until the app installs a published
 * SDK that includes them, they are called through the installed client's
 * own request pipeline, so base URL, auth headers, principal headers, and
 * error mapping stay identical.
 *
 * ponytail: remove this bridge and call backendSDK(context) directly once
 * screenshot-studio-backend-sdk >= 0.1.16 (the first release with these methods) is installed.
 */
export function storeBackend(context: BackendContext) {
  const request = ((client) =>
    (client as unknown as { request: StoreBackendRequest }).request.bind(client))(
    backendSDK(context)
  )
  const id = (value: string) => encodeURIComponent(value)
  return {
    createStoreReview: (input: StoreReviewCreateInput) =>
      request<StoreReviewPayload>('v1/store-reviews', { body: input, method: 'POST' }),
    listStoreReviews: (projectId: string) =>
      request<{ reviews: StoreReviewPayload[] }>(`v1/store-reviews?projectId=${id(projectId)}`),
    getStoreReview: (reviewId: string) => request<StoreReviewPayload>(`v1/store-reviews/${id(reviewId)}`),
    getSharedStoreReview: (reviewId: string, shareTokenId: string) =>
      request<StoreReviewPayload>(`v1/store-reviews/${id(reviewId)}/shared`, {
        headers: { 'x-share-token-id': shareTokenId },
      }),
    revokeStoreReview: (reviewId: string) =>
      request<{ revoked: boolean }>(`v1/store-reviews/${id(reviewId)}/revoke`, { method: 'POST' }),
    addStoreReviewComment: (reviewId: string, input: StoreReviewCommentInput, shareTokenId?: string) =>
      request<StoreReviewPayload['comments'][number]>(`v1/store-reviews/${id(reviewId)}/comments`, {
        body: input,
        headers: shareTokenId ? { 'x-share-token-id': shareTokenId } : {},
        method: 'POST',
      }),
    resolveStoreReviewComment: (reviewId: string, commentId: string, resolved: boolean) =>
      request<{ resolved: boolean }>(
        `v1/store-reviews/${id(reviewId)}/comments/${id(commentId)}/resolution`,
        { body: { resolved }, method: 'PUT' }
      ),
    listStorePublishingCredentials: () =>
      request<{ credentials: StoreCredentialPayload[] }>('v1/store-publishing/credentials'),
    createStorePublishingCredential: (input: StoreCredentialCreateInput) =>
      request<StoreCredentialPayload>('v1/store-publishing/credentials', { body: input, method: 'POST' }),
    getStorePublishingCredentialSecret: (credentialId: string) =>
      request<StoreCredentialPayload & { encryptedSecret: string }>(
        `v1/store-publishing/credentials/${id(credentialId)}/secret`,
        { method: 'POST' }
      ),
    deleteStorePublishingCredential: (credentialId: string) =>
      request<{ deleted: boolean }>(`v1/store-publishing/credentials/${id(credentialId)}`, {
        method: 'DELETE',
      }),
  }
}

/** Review as the backend returns it. */
export type StoreReviewPayload = {
  id: string
  projectId: string
  name: string
  versionLabel: string
  projectRevision: number
  shareTokenId: string
  slides: Array<{ slideId: string; name: string; assetId: string; width: number; height: number }>
  revokedAt: string | null
  createdAt: string
  updatedAt: string
  comments: Array<{
    id: string
    slideId: string
    x: number | null
    y: number | null
    authorName: string
    body: string
    fromLink: boolean
    resolvedAt: string | null
    createdAt: string
  }>
}

/** Input to create a review. */
export type StoreReviewCreateInput = Omit<
  StoreReviewPayload,
  'id' | 'shareTokenId' | 'revokedAt' | 'createdAt' | 'updatedAt' | 'comments'
>

/** Input to add a comment. */
export type StoreReviewCommentInput = {
  slideId: string
  x: number | null
  y: number | null
  authorName: string
  body: string
}

/** Credential as the backend returns it, without its secret. */
export type StoreCredentialPayload = {
  id: string
  provider: StoreProvider
  label: string
  metadata: Record<string, string>
  lastUsedAt: string | null
  createdAt: string
}

/** Input to store a credential. */
export type StoreCredentialCreateInput = {
  provider: StoreCredentialPayload['provider']
  label: string
  metadata: Record<string, string>
  encryptedSecret: string
}
