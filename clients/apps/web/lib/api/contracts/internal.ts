import { z } from 'zod'
import { defineContract } from '@/lib/api/contract'
import { kitRenderOutputSchema } from '@/lib/releases/kit-render-schema'
import { emptyRequestSchema } from '@/lib/api/schemas'

/**
 * Internal contracts: called by billing, the Go worker, and operators, never
 * by browsers, and not part of the public OpenAPI surface.
 */

/** `POST /api/internal/billing/entitlements`: a signed billing event, read as raw text. */
export const syncBillingEntitlementContract = defineContract({
  body: z.string(),
  bodyFormat: 'text',
  method: 'POST',
  name: 'billing.entitlements.sync',
  output: z.object({ replayed: z.boolean(), version: z.number() }),
  path: '/api/internal/billing/entitlements',
  status: 202,
  summary: 'Apply a signed billing entitlement event',
})

/** `POST /api/internal/tenant-outbox/{eventId}/replay` */
export const replayOutboxEventContract = defineContract({
  body: emptyRequestSchema,
  method: 'POST',
  name: 'tenant-outbox.replay',
  output: z.object({ replayed: z.literal(true) }),
  params: z.object({ eventId: z.string().min(1) }),
  path: '/api/internal/tenant-outbox/{eventId}/replay',
  summary: 'Requeue a dead-lettered outbox event',
})

/** `POST /api/internal/workflow-renders`: a worker-signed request, read as raw text. */
export const workflowRenderContract = defineContract({
  body: z.string(),
  bodyFormat: 'text',
  method: 'POST',
  name: 'workflows.renders.create',
  output: z.object({
    renders: z.array(
      z.object({ assetId: z.string(), designId: z.string(), templateId: z.string() })
    ),
  }),
  path: '/api/internal/workflow-renders',
  summary: 'Render campaign creatives for a workflow run',
})

/** `POST /api/internal/workflow-code-visuals`: a worker-signed request, read as raw text. */
export const workflowCodeVisualContract = defineContract({
  body: z.string(),
  bodyFormat: 'text',
  method: 'POST',
  name: 'workflows.code-visuals.create',
  output: z.object({ assetId: z.string(), projectId: z.string() }),
  path: '/api/internal/workflow-code-visuals',
  summary: 'Render a code visual from a merged pull request for a workflow run',
})

/** `POST /api/internal/workflow-canvases`: a worker-signed request, read as raw text. */
export const workflowCanvasContract = defineContract({
  body: z.string(),
  bodyFormat: 'text',
  method: 'POST',
  name: 'workflows.canvases.create',
  output: z.object({ canvasId: z.string() }),
  path: '/api/internal/workflow-canvases',
  summary: 'Lay out a canvas from a release for a workflow run',
})

/** `POST /api/internal/kit-renders`: prepare only the worker's pinned native bytes. */
export const kitRenderContract = defineContract({
  body: z.string().max(140 << 20),
  bodyFormat: 'text',
  maxBodyBytes: 140 << 20,
  method: 'POST',
  name: 'release-kits.renders.create',
  output: kitRenderOutputSchema,
  path: '/api/internal/kit-renders',
  summary: 'Prepare an immutable release kit artifact',
})

/** Redeem an encrypted, expiring grant through its original principal and current kit readiness. */
export const kitExportContentContract = defineContract({
  method: 'GET',
  name: 'release-kits.content',
  params: z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    exportId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  }),
  query: z.object({ downloadToken: z.string().min(1).max(4096) }),
  output: z.never(),
  path: '/api/v1/releases/{id}/kit-exports/{exportId}/content',
  summary: 'Read currently authorized approved kit bytes',
})
