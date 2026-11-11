import { z } from 'zod'

export const founderHubCRMProviderSchema = z.object({
  id: z.enum(['hubspot', 'attio', 'salesforce', 'pipedrive', 'close']),
  name: z.string(),
})
export const founderHubCRMProvidersSchema = z.object({
  providers: z.array(founderHubCRMProviderSchema),
  configured: z.boolean(),
})
export const founderHubCRMConnectionSchema = z.object({
  integration_id: z.string(),
  connection_id: z.string(),
  status: z.string().optional(),
})
export const founderHubCRMConnectionsSchema = z.object({
  connections: z.array(founderHubCRMConnectionSchema),
})
export const founderHubCRMConnectInputSchema = z
  .object({
    provider: z.enum(['hubspot', 'attio', 'salesforce', 'pipedrive', 'close']),
    mode: z.enum(['connect', 'reconnect']),
    connection_id: z.string().min(1).max(200).optional(),
  })
  .strict()
export const founderHubCRMRegisterInputSchema = z
  .object({
    provider: z.enum(['hubspot', 'attio', 'salesforce', 'pipedrive', 'close']),
    connection_id: z.string().min(1).max(200),
  })
  .strict()
export const founderHubCRMRegisterResultSchema = z.object({ registered: z.boolean() })
export const founderHubCRMConnectSessionSchema = z.object({
  token: z.string().min(1),
  expires_at: z.iso.datetime(),
  api_url: z.url(),
  connect_url: z.url(),
  mode: z.enum(['connect', 'reconnect']),
  connection_id: z.string().optional(),
})
export const founderHubCRMDisconnectResultSchema = z.object({ disconnected: z.boolean() })
