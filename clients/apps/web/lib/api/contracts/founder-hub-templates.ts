import {
  founderHubTemplateSchema,
  founderHubTemplatePageSchema,
  founderHubTemplateQuerySchema,
  founderHubTemplateUpdateSchema,
} from 'screenshot-studio-backend-sdk'
import { z } from 'zod'
import { defineContract } from '@/lib/api/contract'

/** Read the person's own summary templates, independent of workspace membership. */
export const getFounderHubTemplatesContract = defineContract({
  method: 'GET',
  name: 'founder-hub.templates.list',
  path: '/api/founder-hub/templates',
  summary: 'Read Founder Hub summary templates',
  query: founderHubTemplateQuerySchema,
  output: founderHubTemplatePageSchema,
})

/** Preserve content, ordering and concurrent edits in the Shots-owned library. */
export const updateFounderHubTemplateContract = defineContract({
  method: 'PATCH',
  name: 'founder-hub.templates.update',
  path: '/api/founder-hub/templates/{id}',
  summary: 'Update a Founder Hub summary template',
  params: z.object({ id: founderHubTemplateSchema.shape.id }),
  body: founderHubTemplateUpdateSchema,
  output: founderHubTemplateSchema,
})
