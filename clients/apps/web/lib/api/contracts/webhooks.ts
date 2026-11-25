import { z } from 'zod'
import { defineContract, mirrors } from '@/lib/api/contract'
import type { WebhookIngestResult } from '@/lib/tenant/webhooks'

/** `POST /api/webhooks/source/{sourceAppId}`: a signed release event, read as raw text. */
export const ingestSourceWebhookContract = defineContract({
  body: z.string(),
  bodyFormat: 'text',
  method: 'POST',
  name: 'webhooks.source',
  // A release, a merged PR held for the next release, or a production deployment;
  // a delivery that ships nothing (a ping, an off-branch PR) is acknowledged as ignored.
  output: z.union([
    mirrors<WebhookIngestResult>()(
      z.union([
        z.object({ created: z.boolean(), releaseId: z.string() }),
        z.object({ changeId: z.string(), created: z.boolean() }),
        z.object({ created: z.boolean(), deploymentId: z.string() }),
      ])
    ),
    z.object({ ignored: z.literal(true) }),
  ]),
  params: z.object({ sourceAppId: z.string().min(1) }),
  path: '/api/webhooks/source/{sourceAppId}',
  status: 201,
  summary: 'Ingest a signed source-app release webhook',
})

/** `POST /api/webhooks/github`: a signed GitHub App delivery, read as raw text. */
export const ingestGitHubAppWebhookContract = defineContract({
  body: z.string(),
  bodyFormat: 'text',
  method: 'POST',
  name: 'webhooks.github',
  maxBodyBytes: 25 * 1024 * 1024,
  // How many records the delivery touched; zero means it shipped nothing.
  output: z.object({ handled: z.number().int().nonnegative() }),
  path: '/api/webhooks/github',
  status: 200,
  summary: 'Ingest a signed GitHub App webhook',
})

/**
 * `POST /api/webhooks/resend/capture-auth`: Resend's signed email.received
 * event, read as raw text. The backend verifies the Svix signature over these
 * exact bytes; the event carries metadata only, never the email body.
 */
export const ingestResendCaptureAuthWebhookContract = defineContract({
  body: z.string(),
  bodyFormat: 'text',
  maxBodyBytes: 64 * 1024,
  method: 'POST',
  name: 'webhooks.resend-capture-auth',
  output: z.object({ outcome: z.string() }),
  path: '/api/webhooks/resend/capture-auth',
  status: 200,
  summary: 'Ingest a signed Resend inbound email event for capture sign-in',
})

/** The Svix headers Resend signs a delivery with. */
export const resendSignatureSchema = z.object({
  svixId: z.string().min(1).max(255),
  svixSignature: z.string().min(1).max(2048),
  svixTimestamp: z.string().regex(/^\d{1,12}$/),
})

/** `POST /api/webhooks/stripe`: a Stripe event signed with the endpoint secret, read as raw text. */
export const stripeWebhookContract = defineContract({
  body: z.string(),
  bodyFormat: 'text',
  method: 'POST',
  name: 'webhooks.stripe',
  output: z.object({ synced: z.boolean() }),
  path: '/api/webhooks/stripe',
  summary: 'Sync a workspace plan from a Stripe subscription event',
})

/** Meta's deauthorize and data deletion callbacks: a form-encoded `signed_request`, verified by the backend. */
export const metaDataCallbackContract = defineContract({
  body: z.string(),
  bodyFormat: 'text',
  maxBodyBytes: 16 * 1024,
  method: 'POST',
  name: 'webhooks.meta',
  output: z.object({ url: z.string().url(), confirmation_code: z.string().min(1) }),
  params: z.object({ provider: z.enum(['instagram-standalone', 'threads']) }),
  path: '/api/webhooks/meta/{provider}',
  summary: 'Revoke a Meta account and erase its stored data when Meta asks',
})

/** The `signed_request` field of Meta's form-encoded callback body. */
export function metaSignedRequest(body: string): string | null {
  return new URLSearchParams(body).get('signed_request') || null
}

/** Provider signature verification happens in the backend before JSON normalization. */
export const frontendWebhookContract = defineContract({
  body: z.string(),
  bodyFormat: 'text',
  maxBodyBytes: 1024 * 1024,
  method: 'POST',
  name: 'webhooks.frontend',
  path: '/api/webhooks/frontends/{id}',
  status: 202,
  params: z.object({ id: z.string().min(1).max(100) }),
  output: z.object({ accepted: z.literal(true) }),
  summary: 'Durably accept a provider-signed frontend deployment observation',
})
