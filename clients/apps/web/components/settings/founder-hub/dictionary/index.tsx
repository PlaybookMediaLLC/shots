// Ported from apps/desktop/src/settings/dictionary/index.tsx; see dev/import-founder-hub-ui.mjs.
import { useLingui as _useLingui } from '@lingui/react'
import { Trans as _Trans } from '@lingui/react'
import { useForm } from '@tanstack/react-form'
import { useState } from 'react'
import { BookOpen, Check, MinusCircle, PencilSimple, Plus, X } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/settings/founder-hub/dictionary/input-group'
import { useBillingAccess } from '@/components/settings/founder-hub/billing-access'
import { SettingsPageTitle } from '@/components/settings/founder-hub/page-title'
import { PlanGate } from '@/components/settings/founder-hub/plan-gate'
import { useSetSettingValue } from '@/components/settings/founder-hub/settings-context'
import { useConfigValue } from '@/components/settings/founder-hub/settings-context'
import {
  normalizeKeywordList,
  parseDictionaryTermsText,
} from '@/components/settings/founder-hub/general/keywords'
export function SettingsDictionary() {
  const terms = useConfigValue('personalization_dictionary_terms')
  const setTerms = useSetSettingValue('personalization_dictionary_terms')
  const { isPro } = useBillingAccess()
  return (
    <div className="flex flex-col gap-8">
      <SettingsPageTitle
        title={
          <_Trans
            {
              /*i18n*/
              ...{
                id: 'VrH1k-',
                message: 'Dictionary',
              }
            }
          />
        }
      />
      <PlanGate plan="pro" allowed={isPro}>
        <DictionarySettings terms={terms} onSave={setTerms} />
      </PlanGate>
    </div>
  )
}
export function DictionarySettings({
  terms,
  onSave,
}: {
  terms: string[]
  onSave: (value: string) => Promise<boolean>
}) {
  const { _: _t } = _useLingui()
  const normalizedTerms = normalizeKeywordList(terms)
  const form = useForm({
    defaultValues: {
      term: '',
    },
    onSubmit: async ({ value }) => {
      const nextTerms = appendDictionaryTerms(normalizedTerms, value.term)
      if (nextTerms.length === normalizedTerms.length) {
        return
      }
      if (!(await onSave(JSON.stringify(nextTerms)))) return
      form.setFieldValue('term', '')
    },
  })
  const removeTerm = (term: string) => {
    const nextTerms = normalizedTerms.filter((value) => value !== term)
    return onSave(JSON.stringify(nextTerms))
  }
  const editTerm = (term: string, nextTerm: string) => {
    const nextTerms = normalizedTerms.map((value) => (value === term ? nextTerm : value))
    return onSave(JSON.stringify(nextTerms))
  }
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        event.stopPropagation()
        void form.handleSubmit()
      }}
    >
      <InputGroup className="border-border bg-card has-[[data-slot=input-group-control]:focus-visible]:border-border rounded-full shadow-none has-[[data-slot=input-group-control]:focus-visible]:ring-0">
        <form.Field name="term">
          {(field) => (
            <InputGroupInput
              className="pr-4 pl-4"
              placeholder={_t(
                /*i18n*/
                {
                  id: 'snzKVr',
                  message: 'Add names, jargon, or product terms to prefer',
                }
              )}
              value={field.state.value}
              onChange={(event) => field.handleChange(event.target.value)}
              onBlur={field.handleBlur}
            />
          )}
        </form.Field>
        <InputGroupAddon align="inline-end">
          <form.Subscribe selector={(state) => state.values.term}>
            {(value) => {
              const canAdd =
                appendDictionaryTerms(normalizedTerms, value).length !== normalizedTerms.length
              return (
                <InputGroupButton
                  type="submit"
                  variant="ghost"
                  size="xs"
                  className="rounded-full bg-black text-white hover:bg-black/90 hover:text-white dark:bg-white dark:text-black dark:hover:bg-white/90 dark:hover:text-black"
                  disabled={!canAdd}
                  aria-label={_t(
                    /*i18n*/
                    {
                      id: 'm16xKo',
                      message: 'Add',
                    }
                  )}
                >
                  <Plus className="size-3.5" />
                  <_Trans
                    {
                      /*i18n*/
                      ...{
                        id: 'm16xKo',
                        message: 'Add',
                      }
                    }
                  />
                </InputGroupButton>
              )
            }}
          </form.Subscribe>
        </InputGroupAddon>
      </InputGroup>

      <form.Subscribe selector={(state) => state.values.term}>
        {(value) => {
          const visibleTerms = getVisibleDictionaryTerms(normalizedTerms, value)
          const hasSearch = parseDictionaryTermsText(value).length > 0
          if (normalizedTerms.length === 0) {
            return (
              <div className="border-border bg-card flex min-h-40 flex-col items-center justify-center rounded-2xl border px-6 text-center">
                <BookOpen className="text-muted-foreground mb-3 size-5" />
                <p className="text-sm font-medium">
                  <_Trans
                    {
                      /*i18n*/
                      ...{
                        id: 'C0Fx9N',
                        message: 'Your dictionary is empty',
                      }
                    }
                  />
                </p>
                <p className="text-muted-foreground mt-1 max-w-sm text-xs">
                  <_Trans
                    {
                      /*i18n*/
                      ...{
                        id: 'KdtkLu',
                        message:
                          'Tip: Add teammate names, acronyms, company jargon, and product terms.',
                      }
                    }
                  />
                </p>
              </div>
            )
          }
          if (visibleTerms.length === 0) {
            return hasSearch ? (
              <p className="text-muted-foreground px-4 text-sm">
                <_Trans
                  {
                    /*i18n*/
                    ...{
                      id: 'mNXjQA',
                      message: 'No match',
                    }
                  }
                />
              </p>
            ) : null
          }
          return (
            <div className="border-border bg-card divide-border divide-y overflow-hidden rounded-2xl border">
              {visibleTerms.map((term) => (
                <DictionaryTermRow
                  key={term}
                  term={term}
                  terms={normalizedTerms}
                  onEdit={editTerm}
                  onRemove={removeTerm}
                />
              ))}
            </div>
          )
        }}
      </form.Subscribe>
    </form>
  )
}
function DictionaryTermRow({
  term,
  terms,
  onEdit,
  onRemove,
}: {
  term: string
  terms: string[]
  onEdit: (term: string, nextTerm: string) => Promise<boolean>
  onRemove: (term: string) => void
}) {
  const { _: _t2 } = _useLingui()
  const [editValue, setEditValue] = useState<string | null>(null)
  const nextTerm = editValue === null ? null : getEditedDictionaryTerm(terms, term, editValue)
  const saveEdit = async () => {
    if (!nextTerm) return
    if (await onEdit(term, nextTerm)) setEditValue(null)
  }
  if (editValue !== null) {
    return (
      <div className="flex min-h-12 items-center gap-2 py-2 pr-3 pl-4">
        <Input
          autoFocus
          className="h-8 min-w-0 flex-1"
          value={editValue}
          onChange={(event) => setEditValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              event.stopPropagation()
              saveEdit()
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              setEditValue(null)
            }
          }}
          aria-label={`${_t2(
            /*i18n*/
            {
              id: 'ePK91l',
              message: 'Edit',
            }
          )}: ${term}`}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-foreground size-7 shrink-0"
          onClick={saveEdit}
          disabled={!nextTerm}
          aria-label={_t2(
            /*i18n*/
            {
              id: 'tfDRzk',
              message: 'Save',
            }
          )}
        >
          <Check className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-foreground size-7 shrink-0"
          onClick={() => setEditValue(null)}
          aria-label={_t2(
            /*i18n*/
            {
              id: 'dEgA5A',
              message: 'Cancel',
            }
          )}
        >
          <X className="size-4" />
        </Button>
      </div>
    )
  }
  return (
    <div className="group flex min-h-12 items-center justify-between gap-3 py-3 pr-3 pl-4">
      <span className="text-sm">{term}</span>
      <div className="flex items-center">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-foreground size-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          onClick={() => setEditValue(term)}
          aria-label={`${_t2(
            /*i18n*/
            {
              id: 'ePK91l',
              message: 'Edit',
            }
          )}: ${term}`}
        >
          <PencilSimple className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-foreground size-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          onClick={() => onRemove(term)}
          aria-label={_t2(
            /*i18n*/
            {
              id: 'v9j_Kl',
              message: 'Remove {term}',
              values: {
                term: term,
              },
            }
          )}
        >
          <MinusCircle className="size-4" />
        </Button>
      </div>
    </div>
  )
}
function appendDictionaryTerms(terms: string[], value: string): string[] {
  return normalizeKeywordList([...terms, ...parseDictionaryTermsText(value)])
}
function getEditedDictionaryTerm(
  terms: string[],
  currentTerm: string,
  value: string
): string | null {
  const [nextTerm] = normalizeKeywordList([value])
  if (!nextTerm || nextTerm === currentTerm) return null
  const nextKey = nextTerm.toLocaleLowerCase()
  const isDuplicate = terms.some(
    (term) => term !== currentTerm && term.toLocaleLowerCase() === nextKey
  )
  return isDuplicate ? null : nextTerm
}
function getVisibleDictionaryTerms(terms: string[], value: string): string[] {
  const queries = parseDictionaryTermsText(value).map((term) => term.toLocaleLowerCase())
  if (queries.length === 0) {
    return terms
  }
  return terms.filter((term) => {
    const key = term.toLocaleLowerCase()
    return queries.some((query) => key.includes(query) || query.includes(key))
  })
}
