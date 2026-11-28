import { z } from 'zod'
import type { Webhook, WebhookDelivery } from 'screenshot-studio-backend-sdk'
import { defineContract, mirrors } from '@/lib/api/contract'
import { contentDraftIdSchema } from '@/lib/api/contracts/content-drafts'
import { isoInstantSchema } from '@/lib/api/contracts/settings-platform'

/**
 * Outbound webhooks (RFC 024): subscriptions, secrets shown once, and the
 * delivery history. Each schema mirrors the backend SDK's type.
 */

/** A webhook event a subscription can choose. */
export const webhookEventSchema = z.enum([
  'draft.created',
  'draft.updated',
  'draft.published',
  'draft.scheduled',
  'draft.planned',
  'draft.status_changed',
  'draft.tags_changed',
  'draft.deleted',
  'post.completed',
  'connection.needs_reconnect',
])

/** An outbound webhook, without its secret. */
export const webhookSchema = mirrors<Webhook>()(
  z.object({
    createdAt: isoInstantSchema,
    enabled: z.boolean(),
    events: z.array(z.string()),
    id: z.string(),
    lastFailureAt: isoInstantSchema.nullable(),
    lastSuccessAt: isoInstantSchema.nullable(),
    name: z.string(),
    previousSecretExpiresAt: isoInstantSchema.nullable(),
    updatedAt: isoInstantSchema,
    url: z.string(),
  })
)

/** A webhook just made or rotated, with its secret, shown this once. */
export const webhookWithSecretSchema = z.object({ secret: z.string(), webhook: webhookSchema })

/** Path parameters naming one webhook. */
export const webhookParamsSchema = z.object({ id: contentDraftIdSchema })

/** `GET /api/v1/webhooks` */
export const listWebhooksContract = defineContract({
  method: 'GET',
  name: 'webhooks.list',
  output: z.object({ events: z.array(z.string()), items: z.array(webhookSchema) }),
  path: '/api/v1/webhooks',
  summary: "List the workspace's outbound webhooks",
})

/** `POST /api/v1/webhooks` */
export const createWebhookContract = defineContract({
  body: z
    .object({
      events: z.array(webhookEventSchema).min(1).max(webhookEventSchema.options.length),
      name: z.string().trim().min(1).max(80),
      url: z.url({ protocol: /^https$/ }).max(2_048),
    })
    .strict(),
  method: 'POST',
  name: 'webhooks.create',
  output: webhookWithSecretSchema,
  path: '/api/v1/webhooks',
  status: 201,
  summary: 'Add an outbound webhook',
})

/** `PATCH /api/v1/webhooks/{id}` */
export const updateWebhookContract = defineContract({
  body: z
    .object({
      enabled: z.boolean().optional(),
      events: z.array(webhookEventSchema).min(1).max(webhookEventSchema.options.length).optional(),
      name: z.string().trim().min(1).max(80).optional(),
      url: z
        .url({ protocol: /^https$/ })
        .max(2_048)
        .optional(),
    })
    .strict(),
  method: 'PATCH',
  name: 'webhooks.update',
  output: webhookSchema,
  params: webhookParamsSchema,
  path: '/api/v1/webhooks/{id}',
  summary: 'Change an outbound webhook',
})

/** `DELETE /api/v1/webhooks/{id}` */
export const deleteWebhookContract = defineContract({
  method: 'DELETE',
  name: 'webhooks.delete',
  output: z.object({ deleted: z.literal(true) }),
  params: webhookParamsSchema,
  path: '/api/v1/webhooks/{id}',
  summary: 'Delete an outbound webhook',
})

/** `POST /api/v1/webhooks/{id}/rotate` */
export const rotateWebhookSecretContract = defineContract({
  method: 'POST',
  name: 'webhooks.rotate',
  output: webhookWithSecretSchema,
  params: webhookParamsSchema,
  path: '/api/v1/webhooks/{id}/rotate',
  summary: "Rotate a webhook's signing secret",
})

/** One event owed to a webhook, and its attempts. */
export const webhookDeliverySchema = mirrors<WebhookDelivery>()(
  z.object({
    attempts: z.number().int(),
    createdAt: isoInstantSchema,
    errorClass: z.string().nullable(),
    eventId: z.string(),
    eventType: z.string(),
    history: z.array(
      z.object({
        attemptNumber: z.number().int(),
        durationMs: z.number().int(),
        errorClass: z.string().nullable(),
        outcome: z.enum(['SUCCEEDED', 'FAILED']),
        responseStatus: z.number().int().nullable(),
        startedAt: isoInstantSchema,
      })
    ),
    id: z.string(),
    lastAttemptAt: isoInstantSchema.nullable(),
    manual: z.boolean(),
    nextAttemptAt: isoInstantSchema.nullable(),
    responseStatus: z.number().int().nullable(),
    status: z.enum(['PENDING', 'SENDING', 'SUCCEEDED', 'DEAD']),
  })
)

/** `POST /api/v1/webhooks/{id}/test` */
export const testWebhookContract = defineContract({
  method: 'POST',
  name: 'webhooks.test',
  output: webhookDeliverySchema,
  params: webhookParamsSchema,
  path: '/api/v1/webhooks/{id}/test',
  status: 202,
  summary: 'Send a test delivery',
})

/** `GET /api/v1/webhooks/{id}/deliveries` */
export const listWebhookDeliveriesContract = defineContract({
  method: 'GET',
  name: 'webhooks.deliveries',
  output: z.object({ items: z.array(webhookDeliverySchema) }),
  params: webhookParamsSchema,
  path: '/api/v1/webhooks/{id}/deliveries',
  summary: "List a webhook's recent deliveries",
})

/** `POST /api/v1/webhook-deliveries/{id}/retry` */
export const retryWebhookDeliveryContract = defineContract({
  method: 'POST',
  name: 'webhooks.delivery-retry',
  output: webhookDeliverySchema,
  params: z.object({ id: z.string().regex(/^[a-z0-9]{10,32}$/) }),
  path: '/api/v1/webhook-deliveries/{id}/retry',
  status: 202,
  summary: 'Replay a delivery that stopped retrying',
})
