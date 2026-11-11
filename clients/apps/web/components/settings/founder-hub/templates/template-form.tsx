// Ported from apps/desktop/src/templates/template-form.tsx; see dev/import-founder-hub-ui.mjs.
import { Input as UnstyledInput } from '@/components/ui/input'
import { Button as UnstyledButton } from '@/components/ui/button'
import { Trans as _Trans } from '@lingui/react'
import { useLingui as _useLingui } from '@lingui/react'
import { useForm } from '@tanstack/react-form'
import { useRef, useState } from 'react'
import { Check, DotsThree, Heart, Plus, X } from '@phosphor-icons/react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import {
  type UserTemplate,
  useSaveTemplate,
  useTemplateInitialValue,
  useToggleTemplateFavorite,
} from './queries'
import { SectionsList } from './sections-editor'
import { TemplateIconPicker } from './template-icon-picker'
import { ResourceShareButton, sharedTemplatePayload } from './sharing'
import { useSetSettingValue } from '@/components/settings/founder-hub/settings-context'
import { useConfigValue } from '@/components/settings/founder-hub/settings-context'
function parseTargets(value: string) {
  return value
    .split(',')
    .map((target) => target.trim())
    .filter(Boolean)
}
function TemplateTargetsInput({
  value,
  onChange,
}: {
  value: string[]
  onChange: (value: string[]) => void
}) {
  const [inputValue, setInputValue] = useState('')
  const [isAddingTag, setIsAddingTag] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const submitTargets = () => {
    const nextTargets = parseTargets(inputValue)
    if (nextTargets.length === 0) {
      setInputValue('')
      setIsAddingTag(false)
      return
    }
    onChange([...value, ...nextTargets])
    setInputValue('')
    setIsAddingTag(false)
  }
  return (
    <div
      className="mt-2 flex min-h-6 w-full cursor-text flex-wrap items-center gap-1.5"
      onClick={() => {
        if (!isAddingTag) {
          setIsAddingTag(true)
          return
        }
        inputRef.current?.focus()
      }}
    >
      {value.map((target, index) => (
        <Badge
          key={`${target}-${index}`}
          variant="secondary"
          className="bg-muted flex h-6 items-center gap-1 rounded-md px-2 py-0.5 text-xs font-normal"
        >
          {target}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-0.5 h-3 w-3 p-0 hover:bg-transparent"
            onClick={(e) => {
              e.stopPropagation()
              onChange(value.filter((_, currentIndex) => currentIndex !== index))
            }}
          >
            <X className="h-2.5 w-2.5" />
          </Button>
        </Badge>
      ))}

      {!isAddingTag ? (
        <UnstyledButton
          variant="custom"
          size={null}
          type="button"
          className="bg-muted text-muted-foreground hover:bg-muted/80 inline-flex h-6 items-center gap-1 rounded-md px-2 py-0.5 text-xs transition-colors"
          onClick={() => setIsAddingTag(true)}
        >
          <Plus className="h-3 w-3" />
          Add tag
        </UnstyledButton>
      ) : (
        <UnstyledInput
          ref={inputRef}
          type="text"
          autoFocus
          value={inputValue}
          className="text-muted-foreground min-w-[84px] flex-1 bg-transparent py-0 text-xs leading-none outline-hidden"
          onChange={(e) => setInputValue(e.target.value)}
          onBlur={submitTargets}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Tab' || e.key === ',') {
              if (!inputValue.trim()) {
                return
              }
              e.preventDefault()
              submitTargets()
              return
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              setInputValue('')
              setIsAddingTag(false)
              return
            }
            if (e.key === 'Backspace' && !inputValue && value.length > 0) {
              e.preventDefault()
              onChange(value.slice(0, -1))
            }
          }}
        />
      )}
    </div>
  )
}
export function TemplateForm({
  template,
  handleDeleteTemplate,
  handleDuplicateTemplate,
}: {
  template: UserTemplate
  handleDeleteTemplate: (id: string) => void
  handleDuplicateTemplate: (id: string) => void
}) {
  const { _: _t } = _useLingui()
  const { id } = template
  const draft = useTemplateInitialValue(template)
  const [initialTemplate] = useState(draft)
  const saveTemplate = useSaveTemplate(initialTemplate)
  const toggleTemplateFavorite = useToggleTemplateFavorite()
  const [actionsOpen, setActionsOpen] = useState(false)
  const selectedTemplateId = useConfigValue('selected_template_id')
  const isDefault = selectedTemplateId === id
  const setDefaultTemplateId = useSetSettingValue('selected_template_id')
  const setSelectedTemplateId = () => {
    setDefaultTemplateId(isDefault ? '' : id)
  }
  const form = useForm({
    defaultValues: {
      title: initialTemplate.title ?? '',
      description: initialTemplate.description ?? '',
      icon: initialTemplate.icon,
      targets: initialTemplate.targets ?? [],
      sections: initialTemplate.sections ?? [],
    },
    listeners: {
      onChange: ({ formApi }) => {
        queueMicrotask(() => {
          const {
            form: { errors },
          } = formApi.getAllErrors()
          if (errors.length === 0) {
            void saveTemplate({
              ...initialTemplate,
              ...formApi.state.values,
            }).catch(() => {})
          }
        })
      },
    },
    onSubmit: ({ value }) => {
      return saveTemplate({
        ...initialTemplate,
        ...value,
      })
    },
  })
  return (
    <div className="flex h-full flex-1 flex-col">
      <div className="flex h-12 items-center justify-between gap-3 pr-1 pl-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <form.Field name="icon">
            {(field) => (
              <TemplateIconPicker
                size="sm"
                value={field.state.value}
                onChange={field.handleChange}
              />
            )}
          </form.Field>
          <form.Field name="title">
            {(field) => (
              <div className="relative max-w-full min-w-0">
                <span
                  aria-hidden="true"
                  className="invisible block px-0 py-0 text-sm font-semibold whitespace-pre"
                >
                  {(field.state.value ||
                    _t(
                      /*i18n*/
                      {
                        id: '9fD_Oh',
                        message: 'Enter template title',
                      }
                    )) + ' '}
                </span>
                <Input
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  aria-label={_t(
                    /*i18n*/
                    {
                      id: 'URdrTr',
                      message: 'Template title',
                    }
                  )}
                  placeholder={_t(
                    /*i18n*/
                    {
                      id: '9fD_Oh',
                      message: 'Enter template title',
                    }
                  )}
                  className="absolute inset-0 h-auto w-full max-w-full min-w-0 border-0 px-0 py-0 text-sm font-semibold shadow-none focus-visible:ring-0 md:text-sm"
                />
              </div>
            )}
          </form.Field>
        </div>
        <div className="flex items-center gap-0">
          <ResourceShareButton
            resourceType="template"
            sourceId={template.id}
            title={
              form.state.values.title.trim() ||
              _t(
                /*i18n*/
                {
                  id: 'Xm-eHu',
                  message: 'Untitled template',
                }
              )
            }
            buildPayload={() =>
              sharedTemplatePayload({
                ...template,
                ...form.state.values,
              })
            }
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={setSelectedTemplateId}
            aria-pressed={isDefault}
            title={isDefault ? 'Remove as default' : 'Set as default'}
            className={cn([
              'text-muted-foreground shrink-0 hover:text-foreground',
              isDefault
                ? 'text-emerald-600 hover:bg-transparent hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300'
                : null,
            ])}
          >
            {isDefault ? (
              <>
                <Check className="size-3.5" weight="bold" />
                Current default
              </>
            ) : (
              'Set as default'
            )}
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={() => toggleTemplateFavorite(id)}
            className={cn([
              'text-muted-foreground hover:text-foreground',
              template.pinned && 'text-rose-500 hover:text-rose-600',
            ])}
            title={template.pinned ? 'Unfavorite template' : 'Favorite template'}
            aria-label={template.pinned ? 'Unfavorite template' : 'Favorite template'}
          >
            <Heart className="size-4" weight={template.pinned ? 'bold' : 'regular'} />
          </Button>
          <DropdownMenu open={actionsOpen} onOpenChange={setActionsOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className={cn([
                  'text-muted-foreground hover:text-foreground',
                  actionsOpen && 'bg-muted text-foreground hover:bg-accent',
                ])}
                aria-label={_t(
                  /*i18n*/
                  {
                    id: '8U287n',
                    message: 'Template actions',
                  }
                )}
              >
                <DotsThree className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => handleDuplicateTemplate(id)}
                className="cursor-pointer"
              >
                <_Trans
                  {
                    /*i18n*/
                    ...{
                      id: 'euc6Ns',
                      message: 'Duplicate',
                    }
                  }
                />
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => handleDeleteTemplate(id)}
                className="cursor-pointer text-destructive focus:text-destructive"
              >
                <_Trans
                  {
                    /*i18n*/
                    ...{
                      id: 'cnGeoo',
                      message: 'Delete',
                    }
                  }
                />
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className="scroll-fade-y h-full overflow-y-auto px-6 pt-3 pb-6">
          <div className="min-w-0">
            <form.Field name="description">
              {(field) => (
                <Textarea
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  aria-label={_t(
                    /*i18n*/
                    {
                      id: 'itMH7G',
                      message: 'Template description',
                    }
                  )}
                  placeholder={_t(
                    /*i18n*/
                    {
                      id: '5ScI97',
                      message: 'Describe the template purpose...',
                    }
                  )}
                  className="text-muted-foreground min-h-[24px] resize-none border-0 px-0 py-0 text-sm shadow-none focus-visible:ring-0"
                  rows={1}
                />
              )}
            </form.Field>
            <form.Field name="targets">
              {(field) => (
                <TemplateTargetsInput value={field.state.value} onChange={field.handleChange} />
              )}
            </form.Field>
          </div>

          <form.Field name="sections">
            {(field) => (
              <div className="mt-6">
                <SectionsList
                  disabled={false}
                  items={field.state.value}
                  onChange={(items) => field.handleChange(items)}
                />
              </div>
            )}
          </form.Field>
        </div>
      </div>
    </div>
  )
}
