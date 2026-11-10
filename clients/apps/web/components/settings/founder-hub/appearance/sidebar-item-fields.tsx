// Ported from apps/desktop/src/settings/appearance/sidebar-item-fields.tsx; see dev/import-founder-hub-ui.mjs.
import { Trans as _Trans } from '@lingui/react'
import { useSetSettingValue } from '@/components/settings/founder-hub/settings-context'
import { SettingSwitchRow } from '@/components/settings/founder-hub/setting-row'
import { useConfigValue } from '@/components/settings/founder-hub/settings-context'
export function SidebarItemFieldsSettings() {
  const showFolder = useConfigValue('sidebar_show_folder')
  const showTags = useConfigValue('sidebar_show_tags')
  const setShowFolder = useSetSettingValue('sidebar_show_folder')
  const setShowTags = useSetSettingValue('sidebar_show_tags')
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h3 className="text-lg font-semibold">
          <_Trans
            {
              /*i18n*/
              ...{
                id: 'lXLpzW',
                message: 'Notes list',
              }
            }
          />
        </h3>
        <p className="text-muted-foreground mt-1 text-sm">
          <_Trans
            {
              /*i18n*/
              ...{
                id: 'R6qIZC',
                message: 'Choose extra fields to show on each note.',
              }
            }
          />
        </p>
      </div>
      <div className="flex flex-col gap-4">
        <SettingSwitchRow
          title={
            <_Trans
              {
                /*i18n*/
                ...{
                  id: 'kNqMMd',
                  message: 'Folder',
                }
              }
            />
          }
          description={
            <_Trans
              {
                /*i18n*/
                ...{
                  id: 'V925WN',
                  message: 'Show the folder above the title.',
                }
              }
            />
          }
          checked={showFolder}
          onChange={setShowFolder}
        />
        <SettingSwitchRow
          title={
            <_Trans
              {
                /*i18n*/
                ...{
                  id: 'OYHzN1',
                  message: 'Tags',
                }
              }
            />
          }
          description={
            <_Trans
              {
                /*i18n*/
                ...{
                  id: '2W_tce',
                  message: 'Show tags under the date and time.',
                }
              }
            />
          }
          checked={showTags}
          onChange={setShowTags}
        />
      </div>
    </section>
  )
}
