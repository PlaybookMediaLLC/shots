import { z } from 'zod'
import type { BackendWhitelabelSettings } from 'screenshot-studio-backend-sdk'
import { defineContract, mirrors } from '@/lib/api/contract'
import { whitelabelSettingsSchema } from '@/lib/whitelabeling'

/**
 * White-label contracts. These serve the workspace settings UI under a session;
 * they are not part of the public OpenAPI surface.
 */

const whitelabelQuerySchema = z.object({ organizationId: z.string().min(1).max(128) })

/** The organization's stored branding. */
export const whitelabelOutputSchema = mirrors<BackendWhitelabelSettings>()(whitelabelSettingsSchema)

/** `GET /api/enterprise/whitelabel` */
export const getWhitelabelContract = defineContract({
  method: 'GET',
  name: 'whitelabel.get',
  output: whitelabelOutputSchema,
  path: '/api/enterprise/whitelabel',
  query: whitelabelQuerySchema,
  summary: 'Get the organization branding',
})

/** `PUT /api/enterprise/whitelabel` */
export const updateWhitelabelContract = defineContract({
  body: whitelabelQuerySchema.extend(whitelabelSettingsSchema.shape),
  method: 'PUT',
  name: 'whitelabel.update',
  output: whitelabelOutputSchema,
  path: '/api/enterprise/whitelabel',
  summary: 'Change the organization branding',
})
