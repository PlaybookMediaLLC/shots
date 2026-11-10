'use client'

import { useMemo, useState, type ComponentType } from 'react'
import { useQuery } from '@tanstack/react-query'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { z } from 'zod'
import { founderHubSettingsSchema, founderHubDeviceSchema } from 'screenshot-studio-backend-sdk'
import { Link } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import {
  Gear,
  Sun,
  BookOpen,
  VideoCamera,
  ShieldCheck,
  Bell,
  LockKey,
  FileText,
  Microphone,
  Brain,
  Waveform,
  Lightning,
  ArrowsClockwise,
  CheckSquare,
  Code,
  AddressBook,
  CreditCard,
} from '@phosphor-icons/react'
import { settingsRequest, settingsErrorMessage } from '@/lib/settings/client'
import { FOUNDER_HUB_PAGES, type FounderHubPage } from './founder-hub/pages'
import {
  FounderHubSettingsProvider,
  validateFounderHubCatalog,
} from './founder-hub/settings-context'
import { FounderHubDevicesProvider } from './founder-hub/device-context'
import { SettingsApp } from './founder-hub/general/app'
import { SettingsMeetings } from './founder-hub/general/meetings'
import { SettingsAppearance } from './founder-hub/appearance'
import { SettingsDictionary } from './founder-hub/dictionary'
import { SettingsPrivacy } from './founder-hub/privacy'
import { SettingsNotifications } from './founder-hub/notifications'
import { SettingsPermissions } from './founder-hub/permissions'
import { SettingsTemplates } from './founder-hub/templates'
import { SettingsDictation } from './founder-hub/dictation'
import { SettingsAIProvider } from './founder-hub/ai-provider'
import { SettingsAutomations } from './founder-hub/automations'
import { SettingsSync } from './founder-hub/sync'
import { SettingsTodo } from './founder-hub/todo'
import { SettingsDevelopers } from './founder-hub/developers'
import { SettingsCRM } from './founder-hub/crm'
import { WorkspaceBilling } from '@/components/workspace/WorkspaceBilling'

const PAGE_CONTENT = {
  general: SettingsApp,
  appearance: SettingsAppearance,
  dictionary: SettingsDictionary,
  meetings: SettingsMeetings,
  privacy: SettingsPrivacy,
  notifications: SettingsNotifications,
  permissions: SettingsPermissions,
  templates: SettingsTemplates,
  dictation: SettingsDictation,
  intelligence: () => <SettingsAIProvider kind="llm" />,
  transcription: () => <SettingsAIProvider kind="stt" />,
  automations: SettingsAutomations,
  sync: SettingsSync,
  todo: SettingsTodo,
  developers: () => <SettingsDevelopers canManage={false} />,
  crm: () => <SettingsCRM canManage={false} />,
  billing: () => <WorkspaceBilling canManage={false} />,
} satisfies Record<FounderHubPage, ComponentType>
const PAGE_ICONS = {
  general: Gear,
  appearance: Sun,
  dictionary: BookOpen,
  meetings: VideoCamera,
  privacy: ShieldCheck,
  notifications: Bell,
  permissions: LockKey,
  templates: FileText,
  dictation: Microphone,
  intelligence: Brain,
  transcription: Waveform,
  automations: Lightning,
  sync: ArrowsClockwise,
  todo: CheckSquare,
  developers: Code,
  crm: AddressBook,
  billing: CreditCard,
}
/** Original Founder Hub settings pages backed by the authenticated Shots account. */
export function FounderHubSettings({
  userId,
  page = 'general',
  canManageDeveloper = false,
  canManageBilling = false,
}: {
  userId: string
  page?: FounderHubPage
  canManageDeveloper?: boolean
  canManageBilling?: boolean
}) {
  const [selection, setSelection] = useState<{ userId: string; deviceId: string }>()
  const i18n = useMemo(() => setupI18n({ locale: 'en', messages: { en: {} } }), [])
  const settings = useQuery({
    queryKey: ['founder-hub-settings', userId],
    queryFn: async ({ signal }) => {
      const data = await settingsRequest('/api/founder-hub/settings', founderHubSettingsSchema, {
        signal,
      })
      validateFounderHubCatalog(data)
      return data
    },
    refetchInterval: 15_000,
  })
  const devices = useQuery({
    queryKey: ['founder-hub-devices', userId],
    queryFn: ({ signal }) =>
      settingsRequest('/api/founder-hub/devices', z.array(founderHubDeviceSchema), { signal }),
    refetchInterval: 15_000,
  })
  if (settings.isPending || devices.isPending)
    return (
      <p role="status" className="p-6">
        Loading Founder Hub settings…
      </p>
    )
  if (!settings.data || !devices.data)
    return (
      <div role="alert" className="p-6">
        <p>{settingsErrorMessage(settings.error || devices.error)}</p>
        <Button
          onClick={() => {
            void settings.refetch()
            void devices.refetch()
          }}
        >
          Try again
        </Button>
      </div>
    )
  const deviceIds = new Set([
    ...devices.data.map((device) => device.deviceId),
    ...settings.data.profiles.map((profile) => profile.deviceId).filter(Boolean),
  ])
  const selectedId =
    selection?.userId === userId && deviceIds.has(selection.deviceId)
      ? selection.deviceId
      : (deviceIds.values().next().value ?? '')
  if (selection?.userId !== userId || selection.deviceId !== selectedId) {
    setSelection({ userId, deviceId: selectedId })
  }
  const selected = devices.data.find((device) => device.deviceId === selectedId)
  return (
    <I18nProvider i18n={i18n}>
      <FounderHubSettingsProvider userId={userId} deviceId={selectedId} data={settings.data}>
        <FounderHubDevicesProvider userId={userId} selected={selected} devices={devices.data}>
          <div className="flex h-full min-h-0 flex-col">
            {(settings.isError || devices.isError) && (
              <div
                role="alert"
                className="flex shrink-0 items-center gap-3 px-4 py-2 text-sm text-destructive"
              >
                <span>
                  Settings could not refresh. Your draft is still here.{' '}
                  {settingsErrorMessage(settings.error || devices.error)}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void settings.refetch()
                    void devices.refetch()
                  }}
                >
                  Retry
                </Button>
              </div>
            )}
            <SettingsSurface
              page={page}
              canManageDeveloper={canManageDeveloper}
              canManageBilling={canManageBilling}
              deviceId={selectedId}
              onDeviceChange={(deviceId) => setSelection({ userId, deviceId })}
              devices={devices.data}
            />
          </div>
        </FounderHubDevicesProvider>
      </FounderHubSettingsProvider>
    </I18nProvider>
  )
}

function SettingsSurface({
  page,
  canManageDeveloper,
  canManageBilling,
  deviceId,
  onDeviceChange,
  devices,
}: {
  page: FounderHubPage
  canManageDeveloper: boolean
  canManageBilling: boolean
  deviceId: string
  onDeviceChange: (value: string) => void
  devices: z.infer<typeof founderHubDeviceSchema>[]
}) {
  const [search, setSearch] = useState('')
  const Component = PAGE_CONTENT[page]
  const visible = FOUNDER_HUB_PAGES.filter((item) =>
    item.title.toLowerCase().includes(search.trim().toLowerCase())
  )
  return (
    <div className="flex min-h-0 flex-1 flex-col p-2">
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-background text-foreground">
        <div className="flex h-12 shrink-0 items-center justify-between gap-4 border-b px-4">
          <span className="text-sm font-medium">Shots Founder Hub</span>
          {devices.length ? (
            <Select value={deviceId} onValueChange={onDeviceChange}>
              <SelectTrigger aria-label="Computer settings" className="h-8 w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {devices.map((device) => (
                  <SelectItem key={device.deviceId} value={device.deviceId}>
                    {device.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="text-muted-foreground text-xs">
              Open the desktop and sign in to connect its settings.
            </p>
          )}
        </div>
        <div className="flex min-h-0 flex-1">
          <nav
            aria-label="Founder Hub settings"
            className="scrollbar-hide flex w-52 shrink-0 flex-col gap-5 overflow-y-auto p-2"
          >
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search settings"
              aria-label="Search Founder Hub settings"
              className="h-8"
            />
            {[...new Set(visible.map((item) => item.group))].map((group) => (
              <div key={group} className="flex flex-col gap-0.5">
                <span className="text-muted-foreground/60 px-3 pb-1 text-[11px] font-medium tracking-wider uppercase">
                  {group}
                </span>
                {visible
                  .filter((item) => item.group === group)
                  .map((item) => {
                    const Icon = PAGE_ICONS[item.id]
                    return (
                      <Link
                        href={`/settings/founder-hub/${item.id}`}
                        key={item.id}
                        aria-current={page === item.id ? 'page' : undefined}
                        className={`flex w-full items-center gap-2 rounded-full px-3 py-2 text-left text-sm transition-colors ${page === item.id ? 'bg-sidebar-accent text-foreground font-medium' : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground'}`}
                      >
                        <Icon size={15} className="shrink-0" />
                        <span>{item.title}</span>
                      </Link>
                    )
                  })}
              </div>
            ))}
          </nav>
          <div className="bg-card min-h-0 min-w-0 flex-1 overflow-hidden rounded-tl-xl">
            <div className="scrollbar-hide h-full min-h-0 w-full min-w-0 overflow-x-hidden overflow-y-auto px-6 pt-6 pb-10">
              <fieldset
                disabled={!deviceId && !['appearance', 'templates'].includes(page)}
                className="min-w-0 border-0 p-0"
              >
              {page === 'developers' ? (
                <SettingsDevelopers canManage={canManageDeveloper} />
              ) : page === 'crm' ? (
                <SettingsCRM canManage={canManageDeveloper} />
              ) : page === 'billing' ? (
                <WorkspaceBilling canManage={canManageBilling} />
              ) : (
                <Component key={`${page}:${deviceId}`} />
              )}
              </fieldset>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
