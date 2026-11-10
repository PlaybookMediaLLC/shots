'use client'

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import {
  founderHubDeviceSchema,
  founderHubDeviceCommandInputSchema,
  founderHubDeviceCommandSchema,
} from 'screenshot-studio-backend-sdk'
import { settingsRequest, settingsErrorMessage } from '@/lib/settings/client'

const Devices = createContext<{
  selected: z.infer<typeof founderHubDeviceSchema> | undefined
  devices: z.infer<typeof founderHubDeviceSchema>[]
  userId: string
} | null>(null)

/** Device facts come from the native app and remain separate from editable preferences. */
export function FounderHubDevicesProvider({
  selected,
  devices,
  userId,
  children,
}: {
  selected: z.infer<typeof founderHubDeviceSchema> | undefined
  devices: z.infer<typeof founderHubDeviceSchema>[]
  userId: string
  children: ReactNode
}) {
  return <Devices.Provider value={{ selected, devices, userId }}>{children}</Devices.Provider>
}

/** The selected computer's reported capabilities, never the web browser's microphone or OS. */
export function useSelectedDevice() {
  const context = useContext(Devices)
  if (!context) throw new Error('Founder Hub device provider is missing.')
  return context.selected
}
/** Computers that can apply the authenticated person's device preferences. */
export function useFounderHubDevices() {
  const context = useContext(Devices)
  if (!context) throw new Error('Founder Hub device provider is missing.')
  return context.devices
}
export function useFounderHubUserId() {
  const context = useContext(Devices)
  if (!context) throw new Error('Founder Hub device provider is missing.')
  return context.userId
}
/** A bounded native action; only the selected desktop can acknowledge its execution. */
export function useNativeSettingsAction() {
  const context = useContext(Devices)
  if (!context) throw new Error('Founder Hub device provider is missing.')
  const { selected, userId } = context
  const client = useQueryClient()
  const [commandId, setCommandId] = useState<string>()
  const requestNumber = useRef(0)
  const mutation = useMutation({
    mutationKey: ['founder-hub-command', userId],
    mutationFn: async (
      input: Omit<z.infer<typeof founderHubDeviceCommandInputSchema>, 'deviceId'>
    ) => {
      if (!selected) throw new Error('Select a connected desktop first.')
      const command = await settingsRequest('/api/founder-hub/devices/commands', founderHubDeviceCommandSchema, {
        method: 'POST',
        body: founderHubDeviceCommandInputSchema.parse({
          ...input,
          deviceId: selected.deviceId,
          expectedUserId: input.expectedUserId ?? userId,
        }),
      })
      return command
    },
  })
  const mutate = mutation.mutate
  const run = useCallback(
    (input: Omit<z.infer<typeof founderHubDeviceCommandInputSchema>, 'deviceId'>) => {
      const request = ++requestNumber.current
      setCommandId(undefined)
      mutate(input, {
        onSuccess: (created) => {
          if (request !== requestNumber.current) return
          client.setQueryData(['founder-hub-command', userId, created.id], created)
          setCommandId(created.id)
        },
      })
    },
    [client, mutate, userId]
  )
  const command = useQuery({
    queryKey: ['founder-hub-command', userId, commandId],
    enabled: Boolean(commandId),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      const queryKey = ['founder-hub-command', userId, commandId] as const
      const created = client.getQueryData<z.infer<typeof founderHubDeviceCommandSchema>>(queryKey)
      if (created && Date.parse(created.expiresAt) <= Date.now()) {
        return { ...created, status: 'expired' as const }
      }
      const result = await settingsRequest(
        `/api/founder-hub/devices/commands/${commandId}`,
        founderHubDeviceCommandSchema,
        { signal }
      )
      if (result.status === 'succeeded') {
        await Promise.all([
          client.invalidateQueries({ queryKey: ['founder-hub-settings', userId] }),
          client.invalidateQueries({ queryKey: ['founder-hub-devices', userId] }),
        ])
      }
      return result
    },
    refetchInterval: (query) =>
      query.state.status !== 'error' &&
      (!query.state.data || ['pending', 'running'].includes(query.state.data.status))
        ? 1000
        : false,
  })
  const result = command.data ?? mutation.data
  const error = mutation.error || command.error
  return {
    userId,
    run,
    isPending:
      Boolean(!result && mutation.isPending) ||
      Boolean(!error && result && ['pending', 'running'].includes(result.status)),
    deviceId: result?.deviceId,
    commandId: result?.id,
    kind: result?.kind,
    argument: result?.argument,
    result: result?.result ?? '',
    error: error
      ? settingsErrorMessage(error)
      : result?.status === 'failed'
        ? result.error
        : result?.status === 'expired'
          ? 'This request expired. Check the desktop before trying again.'
          : null,
  }
}
