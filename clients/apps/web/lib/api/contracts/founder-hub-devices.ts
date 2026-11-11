import { z } from 'zod'
import {
  founderHubDeviceSchema,
  founderHubDeviceReportInputSchema,
  founderHubDeviceCommandInputSchema,
  founderHubDeviceCommandSchema,
  founderHubDeviceCommandResultSchema,
} from 'screenshot-studio-backend-sdk'
import { defineContract } from '@/lib/api/contract'

/** Read the current person's connected desktop capabilities. */
export const getFounderHubDevicesContract = defineContract({
  method: 'GET',
  name: 'founder-hub.devices.list',
  path: '/api/founder-hub/devices',
  summary: 'Read Founder Hub devices',
  output: z.array(founderHubDeviceSchema),
})
/** Record native capabilities and claim the next expiring settings action. */
export const reportFounderHubDeviceContract = defineContract({
  method: 'POST',
  name: 'founder-hub.devices.report',
  path: '/api/founder-hub/devices/report',
  summary: 'Report Founder Hub device state',
  body: founderHubDeviceReportInputSchema,
  output: z.array(founderHubDeviceCommandSchema),
})
/** Queue an allowlisted settings action on a connected computer. */
export const createFounderHubDeviceCommandContract = defineContract({
  method: 'POST',
  name: 'founder-hub.devices.command',
  path: '/api/founder-hub/devices/commands',
  summary: 'Request a native Founder Hub settings action',
  body: founderHubDeviceCommandInputSchema,
  output: founderHubDeviceCommandSchema,
})
/** Read a private settings action result. */
export const getFounderHubDeviceCommandContract = defineContract({
  method: 'GET',
  name: 'founder-hub.devices.command.get',
  path: '/api/founder-hub/devices/commands/{id}',
  params: z.object({ id: z.string().min(1).max(160) }),
  summary: 'Read a Founder Hub settings action',
  output: founderHubDeviceCommandSchema,
})
/** Acknowledge execution on the native device. */
export const finishFounderHubDeviceCommandContract = defineContract({
  method: 'PATCH',
  name: 'founder-hub.devices.command.finish',
  path: '/api/founder-hub/devices/commands/{id}',
  params: z.object({ id: z.string().min(1).max(160) }),
  summary: 'Complete a Founder Hub settings action',
  body: founderHubDeviceCommandResultSchema,
  output: founderHubDeviceCommandSchema,
})
