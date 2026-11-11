import 'server-only'

import { z } from 'zod'
import { backendSDK, orNull, serviceBackend } from '@/lib/backend/sdk'
import { getAuthBaseUrl } from '@/lib/auth/environment'
import type { WebhookPrincipal } from '@/lib/auth/principal'
import { sourceProviderSchema, type SourceWebhookSetup } from './schemas'
import {
  type WebhookIntent,
  deriveSourceWebhookSecret,
  verifyGenericWebhookSignature,
  verifyGitLabWebhookSignature,
  verifyWebhookSignature,
} from './webhook-security'

export {
  getWebhookIntent,
  hasFreshWebhookTimestamp,
  verifyGenericWebhookSignature,
  verifyGitLabWebhookSignature,
  verifyWebhookSignature,
} from './webhook-security'

const secretReferenceSchema = /^[A-Z][A-Z0-9_]{0,127}$/

/**
 * A source as the backend reports it before its webhook is verified. Rules an
 * older backend does not send take the same defaults as the database, so a web
 * deploy that lands first never fails a delivery.
 */
const webhookSourceSchema = z.object({
  branch: z.string().nullable().default(null),
  externalId: z.string().nullable().default(null),
  id: z.string().min(1),
  ignoreBotPullRequests: z.boolean().default(true),
  ignoredPullRequestAuthors: z.array(z.string()).default([]),
  organizationId: z.string().min(1),
  provider: z.string(),
  secretReference: z.string().nullable(),
  skipPrereleases: z.boolean().default(false),
})

type WebhookSource = z.infer<typeof webhookSourceSchema>

/** What one delivery recorded: a release, a held change, or a deployment. */
export const webhookIngestResultSchema = z.union([
  z.object({ created: z.boolean(), releaseId: z.string() }),
  z.object({ changeId: z.string(), created: z.boolean() }),
  z.object({ created: z.boolean(), deploymentId: z.string() }),
])

/** One of {@link webhookIngestResultSchema}. */
export type WebhookIngestResult = z.infer<typeof webhookIngestResultSchema>

/**
 * A key that derives secrets for sources without an operator-managed one: the
 * current one, or the previous one during a rotation (docs/deployment.md).
 */
function getSourceSigningKey(
  name: 'SOURCE_WEBHOOK_SIGNING_KEY' | 'SOURCE_WEBHOOK_SIGNING_KEY_PREVIOUS'
): string | null {
  const key = process.env[name]
  return key && key.length >= 32 ? key : null
}

/**
 * The secret a source's deliveries are signed with: the operator-managed one
 * when the source names it, else one derived from the platform key. GitLab
 * generates its own signing token, so a GitLab source needs the operator's.
 */
function getWebhookSecret(
  source: Pick<WebhookSource, 'id' | 'provider' | 'secretReference'>,
  key = getSourceSigningKey('SOURCE_WEBHOOK_SIGNING_KEY')
) {
  if (source.secretReference) {
    return secretReferenceSchema.test(source.secretReference)
      ? (process.env[source.secretReference] ?? null)
      : null
  }
  return key && source.provider !== sourceProviderSchema.enum.gitlab
    ? deriveSourceWebhookSecret(key, source.id)
    : null
}

/**
 * Where a new source's provider sends deliveries, and the secret to sign them
 * with. The secret is returned only for a derived one, and only here: an
 * operator-managed secret is never revealed.
 */
export function getSourceWebhookSetup(
  source: Pick<WebhookSource, 'id' | 'provider' | 'secretReference'>
): SourceWebhookSetup {
  return {
    secret: source.secretReference ? null : getWebhookSecret(source),
    url: new URL(`/api/webhooks/source/${source.id}`, getAuthBaseUrl()).toString(),
  }
}

function getWebhookPrincipal(
  source: Pick<WebhookSource, 'id' | 'organizationId'>
): WebhookPrincipal {
  return { connectionId: source.id, kind: 'webhook', organizationId: source.organizationId }
}

/** Resolves an active source app before its signature, and so its tenant, is known. */
export async function getWebhookSource(sourceAppId: string): Promise<WebhookSource | null> {
  const source = await orNull(serviceBackend().getWebhookSource(sourceAppId))
  return source && webhookSourceSchema.parse(source)
}

/**
 * Whether a delivery is signed with the source's secret. A source whose
 * secret is derived also verifies with the previous platform key's secret.
 */
export function verifyWebhookRequest(input: {
  body: string
  eventId: string | null
  signature: string | null
  source: WebhookSource
  timestamp: string | null
}): boolean {
  const secrets = new Set([
    getWebhookSecret(input.source),
    getWebhookSecret(input.source, getSourceSigningKey('SOURCE_WEBHOOK_SIGNING_KEY_PREVIOUS')),
  ])
  return [...secrets].some((secret) => Boolean(secret) && verifySignedWith(input, secret ?? ''))
}

function verifySignedWith(
  input: Parameters<typeof verifyWebhookRequest>[0],
  secret: string
): boolean {
  if (input.source.provider === sourceProviderSchema.enum.gitlab) {
    return verifyGitLabWebhookSignature({
      body: input.body,
      eventId: input.eventId,
      signature: input.signature,
      signingToken: secret,
      timestamp: input.timestamp,
    })
  }
  // GitHub sends no timestamp; its replays are defused by keys taken from the signed body.
  if (input.source.provider === sourceProviderSchema.enum.github) {
    return verifyWebhookSignature(input.body, input.signature, secret)
  }
  return verifyGenericWebhookSignature({
    body: input.body,
    eventId: input.eventId,
    secret,
    signature: input.signature,
    timestamp: input.timestamp,
  })
}

/**
 * Record what a verified delivery asks for. `deliveryId` is the provider's
 * delivery, kept for the audit trail; each intent carries its own idempotency
 * key. Call only after verifyWebhookRequest: the backend trusts the webhook
 * principal.
 */
export async function ingestWebhookIntent(input: {
  deliveryId: string
  intent: WebhookIntent
  source: Pick<WebhookSource, 'id' | 'organizationId'>
}): Promise<WebhookIngestResult> {
  const backend = backendSDK({
    organizationId: input.source.organizationId,
    principal: getWebhookPrincipal(input.source),
    requestId: input.deliveryId,
  })
  const { intent } = input
  switch (intent.kind) {
    case 'change':
      return backend.collectSourceChange({
        ...intent.change,
        eventId: input.deliveryId,
        sourceAppId: input.source.id,
      })
    case 'deployment':
      return backend.ingestDeployment({
        ...intent.deployment,
        eventId: input.deliveryId,
        sourceAppId: input.source.id,
      })
    case 'release': {
      const { audience, benefitStatement, description, sourceUrls, title } = intent.release
      return backend.ingestSourceRelease({
        audience,
        benefitStatement,
        description,
        eventId: intent.eventId,
        notes: intent.notes,
        repositoryId: intent.repositoryId,
        repositoryName: intent.repositoryName,
        sourceAppId: input.source.id,
        sourceUrls,
        title,
      })
    }
  }
}
