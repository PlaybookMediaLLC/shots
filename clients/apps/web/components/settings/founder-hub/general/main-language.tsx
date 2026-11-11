// Ported from apps/desktop/src/settings/general/main-language.tsx; see dev/import-founder-hub-ui.mjs.
import { Trans as _Trans } from '@lingui/react'
import { useLingui as _useLingui } from '@lingui/react'
import { useMemo } from 'react'
import { getBaseLanguageDisplayName, parseLocale } from './language'
import { SearchableSelect, type SearchableSelectOption } from './searchable-select'
import { SettingRow } from '@/components/settings/founder-hub/setting-row'
export function MainLanguageView({
  value,
  onChange,
  supportedLanguages,
}: {
  value: string
  onChange: (value: string) => void
  supportedLanguages: readonly string[]
}) {
  const { i18n, _: _t } = _useLingui()
  const deduped = useMemo(() => {
    const map = new Map<string, string>()
    for (const code of supportedLanguages) {
      const { language } = parseLocale(code)
      if (!map.has(language)) {
        map.set(language, code)
      }
    }
    return map
  }, [supportedLanguages])
  const normalizedValue = useMemo(() => {
    const { language } = parseLocale(value)
    return deduped.get(language) ?? value
  }, [value, deduped])
  const options: SearchableSelectOption[] = useMemo(
    () =>
      [...deduped.values()].map((code) => ({
        value: code,
        label: getBaseLanguageDisplayName(code, i18n.locale),
      })),
    [deduped, i18n.locale]
  )
  return (
    <SettingRow
      title={
        <_Trans
          {
            /*i18n*/
            ...{
              id: '0L47q7',
              message: 'Main language',
            }
          }
        />
      }
      description={
        <_Trans
          {
            /*i18n*/
            ...{
              id: 'VpaRjf',
              message: 'Default language for transcription and AI responses.',
            }
          }
        />
      }
    >
      {(labelProps) => (
        <SearchableSelect
          {...labelProps}
          value={normalizedValue}
          onChange={onChange}
          options={options}
          placeholder={_t(
            /*i18n*/
            {
              id: 'k_sb6z',
              message: 'Select language',
            }
          )}
          searchPlaceholder={_t(
            /*i18n*/
            {
              id: 'BgiToP',
              message: 'Search language...',
            }
          )}
          emptyMessage={_t(
            /*i18n*/
            {
              id: 'kUWjsV',
              message: 'No matching languages found',
            }
          )}
          className="w-full"
        />
      )}
    </SettingRow>
  )
}
