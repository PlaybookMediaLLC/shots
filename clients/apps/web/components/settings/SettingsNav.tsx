'use client'

import { useTranslations } from 'next-intl'
import { usePathname } from 'next/navigation'
import { useState, useSyncExternalStore } from 'react'
import {
  AddBusinessIcon,
  AdminIcon,
  AgentIcon,
  ArrowBackIcon,
  BrushIcon,
  CodeIcon,
  ContrastIcon,
  CreditCardIcon,
  ExtensionIcon,
  GearIcon,
  GroupIcon,
  HubIcon,
  InstallIcon,
  InventoryIcon,
  LinkIcon,
  LockIcon,
  LoginIcon,
  NotificationsIcon,
  PersonIcon,
  ReceiptIcon,
  ScienceIcon,
  VoiceIcon,
  WebIcon,
} from '@/components/platform-shell/icons'
import { type NavIcon, NavRow } from '@/components/platform-shell/NavRow'
import { Input } from '@/components/ui/input'
import {
  SETTING_GROUPS,
  SETTINGS_SECTIONS,
  type SettingId,
  settingsHref,
  settingsSectionAt,
} from '@/components/workspace/settings-sections'
import { settingsOrigin } from '@/components/platform-shell/PageVisits'
import { withoutLocale } from '@/lib/settings/appearance'

const noSubscription = () => () => {}

const ICONS = {
  profile: PersonIcon,
  notifications: NotificationsIcon,
  appearance: ContrastIcon,
  security: LockIcon,
  install: InstallIcon,
  general: GearIcon,
  billing: CreditCardIcon,
  members: GroupIcon,
  roles: AdminIcon,
  'new-team': AddBusinessIcon,
  brand: BrushIcon,
  product: InventoryIcon,
  surfaces: WebIcon,
  sharing: LinkIcon,
  'social-sets': VoiceIcon,
  channels: HubIcon,
  integrations: ExtensionIcon,
  agents: AgentIcon,
  sso: LoginIcon,
  audit: ReceiptIcon,
  api: CodeIcon,
  experimental: ScienceIcon,
} satisfies Record<SettingId, NavIcon>

/**
 * Polar's settings sidebar, shown in place of the destinations on every
 * settings page: a way back to the page settings was opened from, a search,
 * and the sections grouped by owner.
 * The compact rail keeps the icons, with each name in a tooltip.
 */
export function SettingsNav({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean
  onNavigate?: () => void
}) {
  const t = useTranslations('platformNavigation')
  const pathname = usePathname()
  const [query, setQuery] = useState('')
  const current = settingsSectionAt(withoutLocale(pathname))?.id
  // Settings pages never write the origin, so it only changes on the way in.
  const origin = useSyncExternalStore(noSubscription, settingsOrigin, () => '/home')
  // The compact rail has no search box, so it always lists every section.
  const search = collapsed ? '' : query.trim().toLowerCase()
  const sections = SETTINGS_SECTIONS.filter(
    (section) =>
      // Create workspace lives in the account menu.
      section.id !== 'new-team' &&
      `${section.title} ${section.description} ${section.keywords ?? ''}`
        .toLowerCase()
        .includes(search)
  )
  return (
    <div className="flex min-h-full flex-col gap-4">
      <div data-platform-back>
        <NavRow
          active={false}
          collapsed={collapsed}
          href={origin}
          icon={ArrowBackIcon}
          label={t('back')}
          name={t('leaveSettings')}
          onNavigate={onNavigate}
        />
      </div>
      <nav aria-label="Settings sections" className="grid gap-4">
        {collapsed ? null : (
          <Input
            aria-label="Search settings"
            className="h-8"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search settings"
            type="search"
            value={query}
          />
        )}
        {sections.length === 0 ? (
          <p className="px-3 text-sm text-muted-foreground" role="status">
            No settings match your search.
          </p>
        ) : null}
        {SETTING_GROUPS.map((group) => {
          const matches = sections.filter((section) => section.group === group.id)
          return matches.length ? (
            <div className="grid gap-0.5" key={group.id}>
              {collapsed ? null : <p className="platform-eyebrow mb-1 px-3">{group.title}</p>}
              {matches.map((section) => (
                <NavRow
                  active={section.id === current}
                  collapsed={collapsed}
                  href={settingsHref(section)}
                  icon={ICONS[section.id]}
                  key={section.id}
                  label={section.title}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          ) : null
        })}
      </nav>
    </div>
  )
}
