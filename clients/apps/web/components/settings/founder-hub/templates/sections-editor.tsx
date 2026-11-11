// Ported from apps/desktop/src/templates/sections-editor.tsx; see dev/import-founder-hub-ui.mjs.
import { Button as UnstyledButton } from '@/components/ui/button'
import { Textarea as UnstyledTextarea } from '@/components/ui/textarea'
import { Trans as _Trans } from '@lingui/react'
import { useLingui as _useLingui } from '@lingui/react'
import { Reorder, useDragControls } from 'motion/react'
import { useState } from 'react'
import type { TemplateSection } from './queries'
import { DotsSixVertical, DotsThree, Plus } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
type SectionDraft = TemplateSection & {
  key: string
}
function useEditableSections({
  disabled,
  initialItems,
  onChange,
}: {
  disabled: boolean
  initialItems: TemplateSection[]
  onChange: (items: TemplateSection[]) => void
}) {
  const [state, setState] = useState(() => ({
    items: initialItems,
    drafts: initialItems.map((item) => ({
      ...item,
      key: crypto.randomUUID(),
    })),
  }))
  if (state.items !== initialItems) {
    setState({
      items: initialItems,
      drafts: initialItems.map((item, index) => ({
        ...item,
        key: state.drafts[index]?.key ?? crypto.randomUUID(),
      })),
    })
  }
  const commit = (drafts: SectionDraft[]) => {
    const items = drafts.map(({ title, description }) => ({
      title,
      description,
    }))
    setState({
      items,
      drafts,
    })
    onChange(items)
  }
  const insertSectionAt = (index: number) => {
    const next = [...state.drafts]
    next.splice(index, 0, {
      title: '',
      description: '',
      key: crypto.randomUUID(),
    })
    commit(next)
  }
  return {
    drafts: state.drafts,
    addSection: () => insertSectionAt(state.drafts.length),
    changeSection: (draft: SectionDraft) =>
      commit(state.drafts.map((item) => (item.key === draft.key ? draft : item))),
    deleteSection: (key: string) => commit(state.drafts.filter((item) => item.key !== key)),
    insertSectionAt,
    moveSection: (key: string, direction: -1 | 1) => {
      const index = state.drafts.findIndex((item) => item.key === key)
      const target = index + direction
      if (index < 0 || target < 0 || target >= state.drafts.length) return
      const next = [...state.drafts]
      next.splice(target, 0, next.splice(index, 1)[0])
      commit(next)
    },
    reorderSections: (next: SectionDraft[]) => {
      if (!disabled) commit(next)
    },
  }
}
export function SectionsList({
  disabled,
  items,
  onChange,
}: {
  disabled: boolean
  items: TemplateSection[]
  onChange: (items: TemplateSection[]) => void
}) {
  const {
    drafts,
    addSection,
    changeSection,
    deleteSection,
    insertSectionAt,
    moveSection,
    reorderSections,
  } = useEditableSections({
    disabled,
    initialItems: items,
    onChange,
  })
  return (
    <div className="flex flex-col gap-3">
      <Reorder.Group values={drafts} onReorder={reorderSections}>
        <div className="flex flex-col gap-2">
          {drafts.map((draft, index) => (
            <div key={draft.key}>
              <SectionItem
                disabled={disabled}
                index={index}
                total={drafts.length}
                item={draft}
                onChange={changeSection}
                onDelete={deleteSection}
                onInsertAbove={insertSectionAt}
                onInsertBelow={insertSectionAt}
                onMove={moveSection}
              />
            </div>
          ))}
        </div>
      </Reorder.Group>

      {!disabled && (
        <Button
          variant="outline"
          size="sm"
          className="border-border bg-card text-foreground hover:bg-background h-auto w-fit rounded-full px-4 py-2.5 text-sm shadow-[0_2px_6px_rgba(87,83,78,0.08),0_10px_18px_-10px_rgba(87,83,78,0.22)]"
          onClick={addSection}
          disabled={disabled}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add Section
        </Button>
      )}
    </div>
  )
}
function SectionItem({
  disabled,
  index,
  total,
  item,
  onChange,
  onDelete,
  onInsertAbove,
  onInsertBelow,
  onMove,
}: {
  disabled: boolean
  index: number
  total: number
  item: SectionDraft
  onChange: (item: SectionDraft) => void
  onDelete: (key: string) => void
  onInsertAbove: (index: number) => void
  onInsertBelow: (index: number) => void
  onMove: (key: string, direction: -1 | 1) => void
}) {
  const { _: _t } = _useLingui()
  const [isFocused, setIsFocused] = useState(false)
  const dragControls = useDragControls()
  return (
    <Reorder.Item
      value={item}
      dragControls={dragControls}
      dragListener={false}
      className="group bg-card relative"
    >
      {!disabled && (
        <UnstyledButton
          variant="custom"
          size={null}
          type="button"
          aria-label="Move section"
          className="absolute top-2.5 -left-5 cursor-move opacity-0 transition-opacity group-hover:opacity-30 hover:opacity-60"
          onPointerDown={(event) => dragControls.start(event)}
          disabled={disabled}
        >
          <DotsSixVertical className="text-muted-foreground h-4 w-4" />
        </UnstyledButton>
      )}

      {!disabled && (
        <div className="absolute top-2 right-2 opacity-0 transition-all group-hover:opacity-100">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="text-muted-foreground hover:text-muted-foreground h-7 w-7"
                aria-label={_t(
                  /*i18n*/
                  {
                    id: '8gtQoG',
                    message: 'Section actions',
                  }
                )}
              >
                <DotsThree className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onInsertAbove(index)} className="cursor-pointer">
                <_Trans
                  {
                    /*i18n*/
                    ...{
                      id: 'FL1M-n',
                      message: 'Insert above',
                    }
                  }
                />
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onInsertBelow(index + 1)} className="cursor-pointer">
                <_Trans
                  {
                    /*i18n*/
                    ...{
                      id: 'UF6vwM',
                      message: 'Insert below',
                    }
                  }
                />
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => onMove(item.key, -1)}
                disabled={index === 0}
                className="cursor-pointer"
              >
                <_Trans
                  {
                    /*i18n*/
                    ...{
                      id: 'QyioBP',
                      message: 'Move up',
                    }
                  }
                />
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => onMove(item.key, 1)}
                disabled={index === total - 1}
                className="cursor-pointer"
              >
                <_Trans
                  {
                    /*i18n*/
                    ...{
                      id: '3Ib6FN',
                      message: 'Move down',
                    }
                  }
                />
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => onDelete(item.key)}
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
      )}

      <div className="flex flex-col gap-1 pr-9">
        <Input
          aria-label={`Section ${index + 1} title`}
          disabled={disabled}
          value={item.title}
          onChange={(e) =>
            onChange({
              ...item,
              title: e.target.value,
            })
          }
          placeholder={_t(
            /*i18n*/
            {
              id: 'wja8aL',
              message: 'Untitled',
            }
          )}
          className="placeholder:text-muted-foreground/60 border-0 bg-transparent p-0 font-medium shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
        />

        <UnstyledTextarea
          aria-label={`Section ${index + 1} instructions`}
          disabled={disabled}
          value={item.description}
          onChange={(e) =>
            onChange({
              ...item,
              description: e.target.value,
            })
          }
          placeholder={_t(
            /*i18n*/
            {
              id: 'F2o3dO',
              message: 'Template content with Jinja2: {{ variable }}, {% if condition %}',
            }
          )}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          className={cn([
            'min-h-[100px] w-full resize-y rounded-xl border p-3 text-sm transition-colors',
            'focus-visible:outline-hidden',
            disabled
              ? 'bg-muted'
              : isFocused
                ? 'ring-primary/20 border-blue-500 ring-2'
                : 'border-input',
          ])}
        />
      </div>
    </Reorder.Item>
  )
}
