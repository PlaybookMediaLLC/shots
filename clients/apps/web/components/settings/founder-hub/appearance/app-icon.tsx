// Ported from apps/desktop/src/settings/appearance/app-icon.tsx; see dev/import-founder-hub-ui.mjs.
import { Button as UnstyledButton } from '@/components/ui/button'
import { publicImageUrl } from '@/lib/assets/public-image'
import { useSelectedDevice } from '@/components/settings/founder-hub/device-context'
import { Trans as _Trans } from '@lingui/react'
import { useLingui as _useLingui } from '@lingui/react'
import { CircleNotch, LockSimple } from '@phosphor-icons/react'
import { cn } from '@/lib/utils'
import { useBillingAccess } from '@/components/settings/founder-hub/billing-access'
import { useNotifyPlanRequired } from '@/components/settings/founder-hub/plan-gate'
import { useSetSettingValue } from '@/components/settings/founder-hub/settings-context'
import { useConfigValue } from '@/components/settings/founder-hub/settings-context'
import {
  type AppIconPreference,
  hasDarkAppIconVariant,
  normalizeAppIconPreference,
  resolveAppIconName,
} from '@/components/settings/founder-hub/appearance/icon'
import type { ThemePreference } from '@/components/settings/founder-hub/appearance/resolve'
const APP_ICON_OPTIONS = [
  'default',
  'stable',
  'anagram',
  'dev',
  'staging',
  'journal',
  'notepad',
  'stone',
  'typewriter-key',
  'walnut',
] as const satisfies readonly AppIconPreference[]
const PREVIEW_CLASS =
  'size-16 scale-[1.16] transition-transform duration-150 select-none group-hover:scale-[1.21]'
export function AppIconSelector() {
  const { _: _t } = _useLingui()
  const billing = useBillingAccess()
  const notifyPlanRequired = useNotifyPlanRequired()
  const value = normalizeAppIconPreference(useConfigValue('app_icon'))
  const storedTheme = useConfigValue('theme') as ThemePreference
  const theme: ThemePreference =
    storedTheme === 'light' || storedTheme === 'dark' ? storedTheme : 'system'
  const setAppIcon = useSetSettingValue('app_icon')
  const device = useSelectedDevice()
  const appIdentifier = device?.report.identifier ?? 'com.hyprnote.stable'
  const labels = {
    default: _t(
      /*i18n*/
      {
        id: 'ovBPCi',
        message: 'Default',
      }
    ),
    stable: _t(
      /*i18n*/
      {
        id: 'w6qPWt',
        message: 'Production',
      }
    ),
    anagram: _t(
      /*i18n*/
      {
        id: 'p2wgGs',
        message: 'Anagram',
      }
    ),
    dev: _t(
      /*i18n*/
      {
        id: 'JdMp7P',
        message: 'Blueprint',
      }
    ),
    staging: _t(
      /*i18n*/
      {
        id: 'NjtJ0y',
        message: 'Sketch',
      }
    ),
    journal: _t(
      /*i18n*/
      {
        id: 'C8_CvT',
        message: 'Field Journal',
      }
    ),
    notepad: _t(
      /*i18n*/
      {
        id: 'XcKuak',
        message: 'Notepad',
      }
    ),
    stone: _t(
      /*i18n*/
      {
        id: 'a-49Cg',
        message: 'Stone',
      }
    ),
    'typewriter-key': _t(
      /*i18n*/
      {
        id: '2pItNo',
        message: 'Typewriter Key',
      }
    ),
    walnut: _t(
      /*i18n*/
      {
        id: 'O8_Srb',
        message: 'Walnut',
      }
    ),
  }
  const defaultIconName = resolveAppIconName('default', appIdentifier)
  const selectedIconName = resolveAppIconName(value, appIdentifier)
  const options = APP_ICON_OPTIONS.filter(
    (option) => option === 'default' || option !== defaultIconName
  )
  if (device?.report.platform !== 'macos') {
    return null
  }
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h3 className="text-lg font-semibold">
          <_Trans
            {
              /*i18n*/
              ...{
                id: 'POKEJo',
                message: 'App icon',
              }
            }
          />
        </h3>
        <p className="text-muted-foreground mt-1 text-sm">
          <_Trans
            {
              /*i18n*/
              ...{
                id: 'Co51qE',
                message: 'Choose how Shots Founder Hub appears in the Dock.',
              }
            }
          />
        </p>
      </div>
      <div
        role="radiogroup"
        aria-label={_t(
          /*i18n*/
          {
            id: 'POKEJo',
            message: 'App icon',
          }
        )}
        className="flex flex-wrap gap-3"
      >
        {options.map((option) => {
          const selected = resolveAppIconName(option, appIdentifier) === selectedIconName
          const previewName = resolveAppIconName(option, appIdentifier)
          const hasDarkVariant = hasDarkAppIconVariant(previewName)
          const locked = !billing.isPro && !selected
          return (
            <UnstyledButton
              variant="custom"
              size={null}
              key={option}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-disabled={locked}
              aria-label={labels[option]}
              title={labels[option]}
              disabled={locked && billing.isUpgradingToPro}
              className={cn([
                'group text-foreground focus-visible:ring-ring focus-visible:ring-offset-background relative flex cursor-pointer items-center justify-center rounded-[22px] bg-transparent p-0.5 pb-2.5 transition-transform duration-150 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none active:scale-[0.98] disabled:cursor-wait',
              ])}
              onClick={() => {
                if (locked) {
                  notifyPlanRequired('pro')
                  return
                }
                setAppIcon(option)
              }}
            >
              <span
                aria-hidden
                data-app-icon-stage=""
                className={cn([
                  'rounded-pill pointer-events-none absolute bottom-0.5 left-1/2 h-4 w-14 -translate-x-1/2',
                  'bg-sky-400/60 blur-md dark:bg-sky-300/55',
                  'transition-opacity duration-150',
                  selected ? 'opacity-100' : 'opacity-0',
                ])}
              />
              <span
                aria-hidden
                className={cn([
                  'rounded-pill pointer-events-none absolute bottom-1.5 left-1/2 h-1.5 w-8 -translate-x-1/2',
                  'bg-sky-300/90 blur-[3px] dark:bg-sky-200/80',
                  'transition-opacity duration-150',
                  selected ? 'opacity-100' : 'opacity-0',
                ])}
              />
              <span
                className={cn([
                  'relative flex size-16 overflow-hidden rounded-[18px]',
                  'transition-transform duration-150',
                  selected && '-translate-y-1.5',
                ])}
              >
                {theme === 'system' && hasDarkVariant ? (
                  <picture>
                    <source
                      media="(prefers-color-scheme: dark)"
                      srcSet={publicImageUrl(`/founder-hub/app-icons/${previewName}-dark.png`)}
                    />
                    <img
                      src={publicImageUrl(`/founder-hub/app-icons/${previewName}-light.png`)}
                      alt=""
                      draggable={false}
                      className={PREVIEW_CLASS}
                    />
                  </picture>
                ) : (
                  <img
                    src={publicImageUrl(
                      `/founder-hub/app-icons/${previewName}${hasDarkVariant ? `-${theme}` : ''}.png`
                    )}
                    alt=""
                    draggable={false}
                    className={PREVIEW_CLASS}
                  />
                )}
              </span>
              {locked ? (
                <span className="bg-background border-border text-muted-foreground pointer-events-none absolute right-1 bottom-3 flex size-5 items-center justify-center rounded-full border shadow-sm">
                  {billing.isUpgradingToPro ? (
                    <CircleNotch className="size-3 animate-spin" aria-hidden />
                  ) : (
                    <LockSimple className="size-3" aria-hidden />
                  )}
                </span>
              ) : null}
            </UnstyledButton>
          )
        })}
      </div>
    </section>
  )
}
