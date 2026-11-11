// Ported from apps/desktop/src/settings/appearance/theme.tsx; see dev/import-founder-hub-ui.mjs.
import { Button as UnstyledButton } from '@/components/ui/button'
import { Trans as _Trans } from '@lingui/react'
import { useLingui as _useLingui } from '@lingui/react'
import { Check } from '@phosphor-icons/react'
import { cn } from '@/lib/utils'
import { useSetSettingValue } from '@/components/settings/founder-hub/settings-context'
import { useConfigValue } from '@/components/settings/founder-hub/settings-context'
import type { ThemePreference } from '@/components/settings/founder-hub/appearance/resolve'
const THEME_OPTIONS = ['light', 'dark', 'system'] as const satisfies readonly ThemePreference[]
export function ThemeSelector() {
  const { _: _t } = _useLingui()
  const storedValue = useConfigValue('theme') as ThemePreference
  const value = THEME_OPTIONS.includes(storedValue) ? storedValue : 'system'
  const setTheme = useSetSettingValue('theme')
  const options = [
    {
      value: 'light',
      label: _t(
        /*i18n*/
        {
          id: '1njn7W',
          message: 'Light',
        }
      ),
      description: _t(
        /*i18n*/
        {
          id: '4JC0UD',
          message: 'Bright canvas',
        }
      ),
    },
    {
      value: 'dark',
      label: _t(
        /*i18n*/
        {
          id: 'pvnfJD',
          message: 'Dark',
        }
      ),
      description: _t(
        /*i18n*/
        {
          id: 'CopAXR',
          message: 'Low-light canvas',
        }
      ),
    },
    {
      value: 'system',
      label: _t(
        /*i18n*/
        {
          id: 'D-NlUC',
          message: 'System',
        }
      ),
      description: _t(
        /*i18n*/
        {
          id: 'dMzhKx',
          message: 'Match your device',
        }
      ),
    },
  ] as const satisfies readonly {
    value: ThemePreference
    label: string
    description: string
  }[]
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h3 className="text-lg font-semibold">
          <_Trans
            {
              /*i18n*/
              ...{
                id: 'FEr96N',
                message: 'Theme',
              }
            }
          />
        </h3>
        <p className="text-muted-foreground mt-1 text-sm">
          <_Trans
            {
              /*i18n*/
              ...{
                id: 'bfROkr',
                message: 'Choose how Shots Founder Hub looks on this device.',
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
            id: 'rFmBG3',
            message: 'Color theme',
          }
        )}
        className="grid gap-3 sm:grid-cols-3"
      >
        {options.map((option) => {
          const selected = value === option.value
          return (
            <UnstyledButton
              variant="custom"
              size={null}
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              className={cn([
                'group bg-background text-foreground focus-visible:ring-ring focus-visible:ring-offset-background relative cursor-pointer overflow-hidden rounded-2xl border text-left transition-[background-color,border-color,box-shadow,scale] duration-150 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none active:scale-[0.98]',
                selected
                  ? 'border-foreground/50 bg-accent/40 shadow-xs'
                  : 'border-border hover:border-foreground/30 hover:bg-accent/20',
              ])}
              onClick={() => {
                setTheme(option.value)
              }}
            >
              <ThemePreview theme={option.value} />
              <div className="border-border flex items-center gap-2 border-t p-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{option.label}</div>
                  <div className="text-muted-foreground text-xs">{option.description}</div>
                </div>
                <span
                  aria-hidden="true"
                  className={cn([
                    'bg-foreground text-background flex size-5 shrink-0 items-center justify-center rounded-full transition-[filter,opacity,scale] duration-150',
                    selected ? 'scale-100 opacity-100 blur-none' : 'scale-25 opacity-0 blur-[4px]',
                  ])}
                >
                  <Check className="size-3" weight="bold" />
                </span>
              </div>
            </UnstyledButton>
          )
        })}
      </div>
    </section>
  )
}
function ThemePreview({ theme }: { theme: ThemePreference }) {
  return (
    <div aria-hidden="true" className="relative h-28 overflow-hidden">
      <PreviewCanvas dark={theme === 'dark'} />
      {theme === 'system' ? (
        <div className="absolute inset-0 [clip-path:polygon(100%_0,100%_100%,0_100%)]">
          <PreviewCanvas dark />
        </div>
      ) : null}
    </div>
  )
}
function PreviewCanvas({ dark }: { dark: boolean }) {
  return (
    <div
      className={cn([
        'absolute inset-0 flex flex-col p-3',
        dark ? 'bg-neutral-950 text-neutral-100' : 'bg-white text-neutral-900',
      ])}
    >
      <div className="mb-3 flex gap-1">
        <span className="size-1.5 rounded-full bg-red-400" />
        <span className="size-1.5 rounded-full bg-amber-400" />
        <span className="size-1.5 rounded-full bg-green-400" />
      </div>
      <div className="flex flex-1 gap-3">
        <div className={cn(['w-1/4 rounded-md', dark ? 'bg-neutral-800' : 'bg-neutral-100'])} />
        <div className="flex flex-1 flex-col gap-2 py-1">
          <span
            className={cn(['h-1.5 w-10 rounded-full', dark ? 'bg-neutral-300' : 'bg-neutral-700'])}
          />
          <span
            className={cn(['h-1 w-4/5 rounded-full', dark ? 'bg-neutral-700' : 'bg-neutral-200'])}
          />
          <span
            className={cn(['h-1 w-3/5 rounded-full', dark ? 'bg-neutral-700' : 'bg-neutral-200'])}
          />
          <span
            className={cn(['h-1 w-2/3 rounded-full', dark ? 'bg-neutral-700' : 'bg-neutral-200'])}
          />
        </div>
      </div>
    </div>
  )
}
