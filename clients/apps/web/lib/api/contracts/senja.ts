import { z } from 'zod'
import { defineContract } from '@/lib/api/contract'
import { memberDocs } from '@/lib/api/contracts/workspace-docs'

/** Whether the workspace has a Senja key, and whether one can be saved here. */
const senjaStatusSchema = z.object({
  /** An admin saved the workspace's Senja API key. */
  configured: z.boolean(),
  /** This deployment can seal a key (`INTEGRATION_ENCRYPTION_KEY`). */
  sealable: z.boolean(),
})

/** `GET /api/v1/integrations/senja`: whether Senja import is set up. The key is never returned. */
export const senjaStatusContract = defineContract({
  docs: memberDocs({
    operationId: 'getSenjaStatus',
    description: 'Whether the workspace saved a Senja API key. The key itself is never returned.',
    tag: 'Workspace',
    responses: { '200': 'Senja import status.' },
  }),
  method: 'GET',
  name: 'integrations.senja-status',
  output: senjaStatusSchema,
  path: '/api/v1/integrations/senja',
  summary: 'Read whether Senja import is set up',
})

/** `PUT /api/v1/integrations/senja`: check a Senja API key with Senja, then seal and save it. */
export const saveSenjaKeyContract = defineContract({
  docs: memberDocs({
    operationId: 'saveSenjaKey',
    description:
      'Check a Senja project API key with Senja, then seal and save it as the workspace’s one Senja key.',
    tag: 'Workspace',
    responses: {
      '200': 'The key is saved.',
      '422': 'Senja refused the key.',
      '503': 'Senja is unreachable, or keys cannot be sealed here.',
    },
  }),
  body: z.object({ apiKey: z.string().trim().min(8).max(500) }),
  method: 'PUT',
  name: 'integrations.senja-save',
  output: senjaStatusSchema,
  path: '/api/v1/integrations/senja',
  summary: 'Save the workspace’s Senja API key',
})

/** `DELETE /api/v1/integrations/senja`: forget the workspace's Senja key. */
export const removeSenjaKeyContract = defineContract({
  docs: memberDocs({
    operationId: 'removeSenjaKey',
    description: 'Forget the workspace’s Senja API key. Imported videos stay in the workspace.',
    tag: 'Workspace',
    responses: { '200': 'The key is gone.' },
  }),
  method: 'DELETE',
  name: 'integrations.senja-remove',
  output: senjaStatusSchema,
  path: '/api/v1/integrations/senja',
  summary: 'Remove the workspace’s Senja API key',
})

/** A Senja video testimonial a draft can import. */
const senjaVideoSchema = z.object({
  customerName: z.string(),
  durationSeconds: z.number().nullable(),
  id: z.string(),
  thumbnailUrl: z.string().url().nullable(),
})

/** `GET /api/v1/content-drafts/senja`: the newest approved video testimonials. */
export const listSenjaVideosContract = defineContract({
  docs: memberDocs({
    operationId: 'listSenjaVideos',
    description:
      'The newest approved video testimonials of the workspace’s Senja project, up to 100.',
    tag: 'Assets',
    responses: {
      '200': 'Video testimonials.',
      '409': 'The workspace has no Senja key.',
      '422': 'Senja refused the saved key.',
      '503': 'Senja is unreachable.',
    },
  }),
  method: 'GET',
  name: 'content-drafts.senja-videos',
  output: z.object({ items: z.array(senjaVideoSchema) }),
  path: '/api/v1/content-drafts/senja',
  summary: 'List Senja video testimonials to import',
})

/** `POST /api/v1/content-drafts/senja`: import one testimonial's video as a workspace asset. */
export const importSenjaVideoContract = defineContract({
  docs: memberDocs({
    operationId: 'importSenjaVideo',
    description:
      'Re-read a testimonial from Senja and store its video through the workspace upload pipeline.',
    tag: 'Assets',
    responses: {
      '200': 'The video is a workspace asset.',
      '404': 'The testimonial is no longer in Senja.',
      '409': 'The workspace has no Senja key.',
      '422': 'The testimonial has no usable video, or Senja refused the saved key.',
      '503': 'Senja is unreachable.',
    },
  }),
  body: z.object({ id: z.string().min(1).max(100) }),
  method: 'POST',
  name: 'content-drafts.senja-import',
  output: z.object({ assetId: z.string(), mediaType: z.literal('video/mp4') }),
  path: '/api/v1/content-drafts/senja',
  summary: 'Import a Senja video testimonial',
})
