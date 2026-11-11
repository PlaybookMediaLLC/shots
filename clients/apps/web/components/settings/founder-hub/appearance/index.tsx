// Ported from apps/desktop/src/settings/appearance/index.tsx; see dev/import-founder-hub-ui.mjs.
import { Trans as _Trans } from '@lingui/react'
import { AppIconSelector } from './app-icon'
import { SidebarItemFieldsSettings } from './sidebar-item-fields'
import { ThemeSelector } from './theme'
import { TimeFormatSettings } from './time-format'
import { SettingsPageTitle } from '@/components/settings/founder-hub/page-title'
export function SettingsAppearance() {
  return (
    <div className="flex max-w-5xl flex-col gap-10">
      <SettingsPageTitle
        title={
          <_Trans
            {
              /*i18n*/
              ...{
                id: 'aAIQg2',
                message: 'Appearance',
              }
            }
          />
        }
      />
      <ThemeSelector />
      <TimeFormatSettings />
      <AppIconSelector />
      <SidebarItemFieldsSettings />
    </div>
  )
}
