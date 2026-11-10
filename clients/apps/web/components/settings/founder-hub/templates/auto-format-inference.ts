import { z } from 'zod'
import {
  founderHubDeviceCommandSchema,
  founderHubDeviceSchema,
} from 'screenshot-studio-backend-sdk'
import { settingsRequest } from '@/lib/settings/client'
import { sealAutoFormatRequest } from '../private-action'

export const MAX_FORMAT_EXAMPLES = 3
export const MAX_FORMAT_EXAMPLE_LENGTH = 12000

export async function inferSummaryFormat({
  device,
  examples,
}: {
  device: z.infer<typeof founderHubDeviceSchema>
  examples: string[]
}): Promise<string> {
  if (!device.report.autoFormatKey)
    throw new Error('Update and connect the selected desktop first.')
  const encrypted = await sealAutoFormatRequest(device.report.autoFormatKey, examples)
  let command = await settingsRequest(
    '/api/founder-hub/devices/commands',
    founderHubDeviceCommandSchema,
    {
      method: 'POST',
      body: { deviceId: device.deviceId, kind: 'auto-format', argument: encrypted.argument },
      signal: AbortSignal.timeout(15000),
    }
  )
  while (command.status === 'pending' || command.status === 'running') {
    if (Date.parse(command.expiresAt) <= Date.now())
      throw new Error('The request expired. Check the desktop and try again.')
    await new Promise((resolve) => setTimeout(resolve, 1000))
    command = await settingsRequest(
      `/api/founder-hub/devices/commands/${command.id}`,
      founderHubDeviceCommandSchema,
      {
        signal: AbortSignal.timeout(Math.max(1, Date.parse(command.expiresAt) - Date.now())),
      }
    )
  }
  if (command.status !== 'succeeded')
    throw new Error(command.error || 'The request expired. Check the desktop and try again.')
  return encrypted.readResult(command.result)
}
