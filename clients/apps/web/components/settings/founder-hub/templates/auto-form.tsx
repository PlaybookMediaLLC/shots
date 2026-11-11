// Ported from apps/desktop/src/templates/auto-form.tsx; see dev/import-founder-hub-ui.mjs.
import { useLingui as _useLingui } from '@lingui/react'
import { Trans as _Trans } from '@lingui/react'
import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { Textarea } from '@/components/ui/textarea'
import defaultFormat from './default-format.json'
import { Check, DotsThree, MagicWand, Sparkle } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { AutoFormatExamplesDialog } from './auto-format-examples-dialog'
import { useBillingAccess } from '@/components/settings/founder-hub/billing-access'
import { PlanGate, useNotifyPlanRequired } from '@/components/settings/founder-hub/plan-gate'
import { useSetSettingValues } from '@/components/settings/founder-hub/settings-context'
import { useConfigValue } from '@/components/settings/founder-hub/settings-context'
const LEGACY_CUSTOM_INSTRUCTIONS_PREAMBLE =
  'For structure, formatting, tone, and emphasis, these instructions take precedence over the Format Requirements. They do not override the requirements to stay accurate, use only the provided source material, and return only the summary.'
export function AutoTemplateDetails() {
  const formatOverride = useConfigValue('auto_summary_prompt')
  const sourceQuery = useQuery({
    queryKey: ['template-source', 'enhance-format'],
    queryFn: loadDefaultAutoFormat,
    staleTime: Number.POSITIVE_INFINITY,
  })
  if (sourceQuery.isLoading) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
        <_Trans
          {
            /*i18n*/
            ...{
              id: 'xCx9Xo',
              message: 'Loading Auto format...',
            }
          }
        />
      </div>
    )
  }
  if (sourceQuery.error || !sourceQuery.data) {
    return (
      <div className="text-destructive flex h-full items-center justify-center px-6 text-center text-sm">
        {sourceQuery.error?.message || 'Auto format is unavailable.'}
      </div>
    )
  }
  return (
    <AutoFormatForm
      key={sourceQuery.data}
      defaultFormat={sourceQuery.data}
      formatOverride={formatOverride}
    />
  )
}
export function AutoFormatForm({
  defaultFormat,
  formatOverride,
}: {
  defaultFormat: string
  formatOverride: string
}) {
  const { _: _t } = _useLingui()
  const billing = useBillingAccess()
  const notifyPlanRequired = useNotifyPlanRequired()
  const setValues = useSetSettingValues()
  const [acknowledged, setAcknowledged] = useState(formatOverride)
  const attempted = useRef<string | undefined>(undefined)
  const [showExamplesDialog, setShowExamplesDialog] = useState(false)
  const selectedTemplateId = useConfigValue('selected_template_id')
  const isDefault = !selectedTemplateId
  const normalizedOverride = normalizeFormatOverride(formatOverride)
  const isCustomized =
    Boolean(normalizedOverride) && !formatsMatch(normalizedOverride, defaultFormat)
  const initialFormat = isCustomized ? normalizedOverride : defaultFormat
  const [initialValue, setInitialValue] = useState(initialFormat)
  const saveMutation = useMutation({
    mutationFn: async (source: string) => {
      const normalized = normalizeFormat(source)
      if (!normalized) {
        throw new Error(
          _t(
            /*i18n*/
            {
              id: 'adZx1i',
              message: 'Summary format cannot be empty.',
            }
          )
        )
      }
      const stored = formatsMatch(normalized, defaultFormat) ? '' : normalized
      if (stored.length > 16000)
        throw new Error('Summary format must be 16,000 characters or fewer.')
      if (formatOverride !== acknowledged && attempted.current !== formatOverride)
        throw new Error('The saved summary format changed elsewhere. Your draft has been kept.')
      attempted.current = stored
      if (
        !(await setValues({
          auto_summary_prompt: stored,
        }))
      )
        throw new Error('The summary format was not saved.')
      setAcknowledged(stored)
      attempted.current = undefined
      return stored
    },
    onError: (error) => toast.error(error.message),
  })
  const form = useForm({
    defaultValues: {
      format: initialValue,
    },
    onSubmit: async ({ value }) => {
      if (!billing.isPro) {
        notifyPlanRequired('pro')
        return
      }
      const stored = await saveMutation.mutateAsync(value.format)
      const nextFormat = stored || defaultFormat
      setInitialValue(nextFormat)
      form.reset({
        format: nextFormat,
      })
    },
  })
  const resetToDefault = async () => {
    if (!billing.isPro) {
      notifyPlanRequired('pro')
      return
    }
    await saveMutation.mutateAsync(defaultFormat)
    setInitialValue(defaultFormat)
    form.reset({
      format: defaultFormat,
    })
  }
  return (
    <form
      className="flex h-full min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault()
        event.stopPropagation()
        void form.handleSubmit().catch(() => {})
      }}
    >
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 pr-1 pl-3">
        <div className="flex min-w-0 items-center gap-2">
          <Sparkle className="size-4 shrink-0 text-violet-500" />
          <span className="truncate text-sm font-semibold">Auto</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className={cn([
              'text-muted-foreground shrink-0 hover:text-foreground',
              isDefault
                ? 'text-emerald-600 hover:bg-transparent hover:text-emerald-700 disabled:opacity-100 dark:text-emerald-400 dark:hover:text-emerald-300'
                : null,
            ])}
            onClick={() => {
              void setValues({
                selected_template_id: '',
              }).catch((error) => {
                console.error('[templates] failed to set Auto as default', error)
              })
            }}
            disabled={isDefault}
          >
            {isDefault ? (
              <>
                <Check className="size-3.5" weight="bold" />
                <_Trans
                  {
                    /*i18n*/
                    ...{
                      id: 'Fi5cYq',
                      message: 'Current default',
                    }
                  }
                />
              </>
            ) : (
              <_Trans
                {
                  /*i18n*/
                  ...{
                    id: 'PPcets',
                    message: 'Set as default',
                  }
                }
              />
            )}
          </Button>
          <form.Subscribe selector={(state) => state.values.format}>
            {(currentFormat) => (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={_t(
                      /*i18n*/
                      {
                        id: '8U287n',
                        message: 'Template actions',
                      }
                    )}
                    className="text-muted-foreground hover:bg-accent hover:text-foreground rounded-full"
                  >
                    <DotsThree size={16} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem
                    className="cursor-pointer"
                    disabled={
                      (!isCustomized && formatsMatch(currentFormat, defaultFormat)) ||
                      saveMutation.isPending
                    }
                    onClick={() => {
                      void resetToDefault().catch(() => {})
                    }}
                  >
                    <_Trans
                      {
                        /*i18n*/
                        ...{
                          id: 'mvUHTg',
                          message: 'Reset to default format',
                        }
                      }
                    />
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </form.Subscribe>
        </div>
      </div>

      <div className="scroll-fade-y min-h-0 flex-1 overflow-y-auto px-6 pt-3 pb-6">
        <div className="flex max-w-4xl flex-col gap-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-lg font-semibold">
                <_Trans
                  {
                    /*i18n*/
                    ...{
                      id: 'Vu6Y8G',
                      message: 'Summary format',
                    }
                  }
                />
              </h1>
              <p className="text-muted-foreground mt-1 text-sm">
                <_Trans
                  {
                    /*i18n*/
                    ...{
                      id: 'XrJHYR',
                      message: 'Choose how Auto structures and styles your summaries.',
                    }
                  }
                />
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="shrink-0"
              onClick={() => {
                if (!billing.isPro) {
                  notifyPlanRequired('pro')
                  return
                }
                setShowExamplesDialog(true)
              }}
            >
              <MagicWand className="size-4" />
              <_Trans
                {
                  /*i18n*/
                  ...{
                    id: 'tujNJm',
                    message: 'Improve with examples',
                  }
                }
              />
            </Button>
          </div>

          {formatOverride !== acknowledged && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-2 text-sm text-destructive"
            >
              <span>The saved summary format changed elsewhere. Your draft has been kept.</span>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setAcknowledged(formatOverride)
                  attempted.current = undefined
                  setInitialValue(initialFormat)
                  form.reset({
                    format: initialFormat,
                  })
                  saveMutation.reset()
                }}
              >
                Load saved format
              </Button>
            </div>
          )}
          <PlanGate plan="pro" allowed={billing.isPro}>
            <div className="flex flex-col gap-5">
              <form.Field name="format">
                {(field) => (
                  <div className="border-border bg-card overflow-hidden rounded-2xl border">
                    <Textarea
                      aria-label={_t(
                        /*i18n*/
                        {
                          id: 'A2N1zA',
                          message: 'Auto summary format',
                        }
                      )}
                      className="min-h-[28rem] px-4 py-3 font-mono text-sm leading-5"
                      value={field.state.value}
                      maxLength={16000}
                      onChange={(event) => field.handleChange(event.target.value)}
                      onBlur={field.handleBlur}
                    />
                  </div>
                )}
              </form.Field>

              <div className="flex items-center justify-end gap-2">
                <form.Subscribe selector={(state) => [state.canSubmit, state.isDirty] as const}>
                  {([canSubmit, isDirty]) => (
                    <Button
                      type="submit"
                      disabled={!canSubmit || !isDirty || saveMutation.isPending}
                    >
                      <_Trans
                        {
                          /*i18n*/
                          ...{
                            id: 'tfDRzk',
                            message: 'Save',
                          }
                        }
                      />
                    </Button>
                  )}
                </form.Subscribe>
              </div>
            </div>
          </PlanGate>
        </div>
      </div>

      {showExamplesDialog ? (
        <AutoFormatExamplesDialog
          onClose={() => setShowExamplesDialog(false)}
          onGenerated={(format) => {
            form.setFieldValue('format', format)
          }}
        />
      ) : null}
    </form>
  )
}
async function loadDefaultAutoFormat(): Promise<string> {
  return defaultFormat
}
function normalizeFormat(value: string): string {
  return value.replace(/\r\n/g, '\n').trim()
}
function formatsMatch(a: string, b: string): boolean {
  return normalizeFormat(a) === normalizeFormat(b)
}
function normalizeFormatOverride(value: string): string {
  const normalized = normalizeFormat(value)
  if (!normalized.includes('# General Instructions') || !normalized.includes('# About Notes')) {
    return normalized
  }
  const formatRequirements = headingSection(normalized, '# Format Requirements')
  if (formatRequirements === null) {
    return normalized
  }
  const customInstructions = headingSection(normalized, '# Custom Summary Instructions')
    ?.replace(LEGACY_CUSTOM_INSTRUCTIONS_PREAMBLE, '')
    .trim()
  return [formatRequirements, customInstructions].filter(Boolean).join('\n\n')
}
function headingSection(source: string, heading: string): string | null {
  const lines = source.split('\n')
  const headingIndex = lines.findIndex((line) => line.trim() === heading)
  if (headingIndex === -1) return null
  const followingLines = lines.slice(headingIndex + 1)
  const nextHeadingIndex = followingLines.findIndex((line) => line.trimStart().startsWith('# '))
  return followingLines
    .slice(0, nextHeadingIndex === -1 ? undefined : nextHeadingIndex)
    .join('\n')
    .trim()
}
