'use client'

import { createContext, useContext, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import {
  founderHubSettingsSchema,
  founderHubSettingsProfileSchema,
} from 'screenshot-studio-backend-sdk'
import { settingsRequest, settingsErrorMessage } from '@/lib/settings/client'
import {
  SETTING_DEFINITIONS,
  SYNCED_SETTING_KEYS,
  type SettingKey,
  type SettingValue,
  type SettingValues,
} from './schema'

export { useConfigValue, useConfigValues, resolveConfigValue, resolveConfigValues } from './config'

export type StoredSettingValues = { values: SettingValues; hasValues: Set<SettingKey> }

const Context = createContext<{
  userId: string
  account: z.infer<typeof founderHubSettingsSchema>['account']
  stored: StoredSettingValues
  save: (values: SettingValues) => Promise<boolean>
  deviceId: string
} | null>(null)

/** The original pages read one effective profile; Shots persists each key in its authoritative scope. */
export function FounderHubSettingsProvider({
  userId,
  deviceId,
  data,
  children,
}: {
  userId: string
  deviceId: string
  data: z.infer<typeof founderHubSettingsSchema>
  children: ReactNode
}) {
  const client = useQueryClient()
  const queryKey = ['founder-hub-settings', userId]
  const mutation = useMutation({
    scope: { id: `founder-hub-settings:${userId}` },
    mutationFn: async ({
      values,
      profiles,
      deviceId,
    }: {
      values: SettingValues
      profiles: z.infer<typeof founderHubSettingsSchema>['profiles']
      deviceId: string
    }) => {
      if (
        !deviceId &&
        Object.keys(values).some((key) => !SYNCED_SETTING_KEYS.has(key as SettingKey))
      ) {
        throw new Error('Connect and select a desktop before changing its settings.')
      }
      for (const id of ['', deviceId].filter((value, index, all) => all.indexOf(value) === index)) {
        const patch = Object.fromEntries(
          Object.entries(values).filter(
            ([key]) => SYNCED_SETTING_KEYS.has(key as SettingKey) === (id === '')
          )
        )
        if (!Object.keys(patch).length) continue
        const profile = profiles.find((item) => item.deviceId === id)
        const saved = await settingsRequest(
          '/api/founder-hub/settings',
          founderHubSettingsProfileSchema,
          {
            method: 'PATCH',
            body: {
              deviceId: id,
              deviceName: profile?.deviceName ?? '',
              baseVersion: profile?.version ?? 0,
              values: patch,
            },
          }
        )
        client.setQueryData<z.infer<typeof founderHubSettingsSchema>>(
          queryKey,
          (previous) =>
            previous && {
              ...previous,
              profiles: [...previous.profiles.filter((item) => item.deviceId !== id), saved],
            }
        )
      }
    },
    onError: () => void client.invalidateQueries({ queryKey }),
  })
  const values = Object.assign(
    {},
    ...data.profiles
      .filter((profile) => profile.deviceId === '' || profile.deviceId === deviceId)
      .map((profile) => profile.values)
  ) as SettingValues
  const stored = { values, hasValues: new Set(Object.keys(values) as SettingKey[]) }
  const save = (next: SettingValues) => {
    // A queued edit must retain the version the person actually saw.
    return mutation.mutateAsync({ values: next, profiles: data.profiles, deviceId }).then(
      () => true,
      () => false
    )
  }
  return (
    <Context.Provider value={{ stored, save, deviceId, userId, account: data.account }}>
      {mutation.isError && (
        <p role="alert" className="text-destructive mb-4 text-sm">
          {settingsErrorMessage(mutation.error)} Not all changes were saved. Review the refreshed
          values and try again.
        </p>
      )}
      <fieldset
        disabled={mutation.isPending}
        aria-busy={mutation.isPending}
        className="h-full min-h-0 min-w-0 border-0 p-0"
      >
        {children}
      </fieldset>
    </Context.Provider>
  )
}

function useSettings() {
  const context = useContext(Context)
  if (!context) throw new Error('Founder Hub settings require their Shots provider.')
  return context
}

/** Scope every private resource cache to the authenticated person. */
export function useFounderHubUserId() {
  return useSettings().userId
}

/** The selected account and desktop cache, using the desktop's existing defaults. */
export function useStoredSettingValues(): StoredSettingValues {
  return useSettings().stored
}
/** Live Shots identity, memberships and entitlements. */
export function useFounderHubAccount() {
  return useSettings().account
}
/** The page is mounted after the authoritative query succeeds. */
export function useStoredSettingValuesQuery() {
  return { data: useStoredSettingValues(), isLoading: false, error: null }
}
/** Save a partial set of preferences through the Shots API. */
export function useSetSettingValues() {
  return useSettings().save
}
/** Save one preference without overwriting adjacent controls. */
export function useSetSettingValue<K extends SettingKey>(key: K) {
  const save = useSetSettingValues()
  return (value: SettingValue<K>) => save({ [key]: value } as SettingValues)
}
/** Assert that the server supports the entire desktop catalog before allowing edits. */
export function validateFounderHubCatalog(data: z.infer<typeof founderHubSettingsSchema>): void {
  for (const [key, definition] of Object.entries(SETTING_DEFINITIONS)) {
    if (
      data.catalog[key]?.type !== definition.type ||
      data.catalog[key]?.scope !==
        (SYNCED_SETTING_KEYS.has(key as SettingKey) ? 'account' : 'device')
    ) {
      throw new Error(
        `Shots does not support ${key}. Update the backend before editing Founder Hub settings.`
      )
    }
  }
}
