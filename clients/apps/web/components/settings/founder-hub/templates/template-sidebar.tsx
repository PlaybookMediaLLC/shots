// Ported from apps/desktop/src/templates/template-sidebar.tsx; see dev/import-founder-hub-ui.mjs.
import { Input as UnstyledInput } from '@/components/ui/input'
import { Button as UnstyledButton } from '@/components/ui/button'
import { Trans as _Trans } from '@lingui/react'
import { useLingui as _useLingui } from '@lingui/react'
import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  ArrowsDownUp,
  BookOpenText,
  MagnifyingGlass,
  Plus,
  Sparkle,
  X,
} from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { type WebTemplate } from './codec'
import { getTemplateCopyTitle, type UserTemplate } from './queries'
import { TemplateIconGlyph } from './template-icon'
import { AUTO_TEMPLATE_ID, useTemplateTab } from './utils'
import { parseSharedTemplatePayload, SharedResourceLibrarySection } from './sharing'
import { useConfigValue } from '@/components/settings/founder-hub/settings-context'
import { DotsThree } from '@phosphor-icons/react'
import { DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { type Tab } from './navigation'
type SortOption = 'alphabetical' | 'reverse-alphabetical'
export function TemplatesSidebarContent({
  tab,
}: {
  tab: Extract<
    Tab,
    {
      type: 'templates'
    }
  >
}) {
  const { _: _t } = _useLingui()
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLDivElement>(null)
  const [search, setSearch] = useState('')
  const [sortOption, setSortOption] = useState<SortOption>('alphabetical')
  const autoPrompt = useConfigValue('auto_summary_prompt')
  const {
    userTemplates,
    webTemplates,
    isWebLoading,
    isWebMode,
    selectedMineId: effectiveSelectedMineId,
    selectedWebIndex: effectiveSelectedWebIndex,
    setSelectedMineId,
    setSelectedWebIndex,
    createTemplate,
    createDefaultTemplate,
    deleteTemplate,
    toggleTemplateFavorite,
  } = useTemplateTab(tab)
  const handleDuplicateTemplate = useCallback(
    async (template: UserTemplate) => {
      const id = await createTemplate({
        title: getTemplateCopyTitle(template.title),
        description: template.description ?? '',
        category: template.category,
        icon: template.icon,
        targets: template.targets,
        sections: template.sections.map((section) => ({
          ...section,
        })),
      })
      if (id) {
        setSelectedMineId(id)
      }
    },
    [createTemplate, setSelectedMineId]
  )
  const handleDeleteTemplate = useCallback(
    async (id: string) => {
      await deleteTemplate(id)
      if (effectiveSelectedMineId === id) {
        setSelectedMineId(null)
      }
    },
    [deleteTemplate, effectiveSelectedMineId, setSelectedMineId]
  )
  const handleToggleFavorite = useCallback(
    async (id: string) => {
      await toggleTemplateFavorite(id)
    },
    [toggleTemplateFavorite]
  )
  const sortedUserTemplates = useMemo(() => {
    const favorites = userTemplates
      .filter((template) => template.pinned)
      .sort((a, b) => {
        const orderA = a.pinOrder ?? Infinity
        const orderB = b.pinOrder ?? Infinity
        if (orderA !== orderB) {
          return orderA - orderB
        }
        return (a.title || '').localeCompare(b.title || '')
      })
    const others = userTemplates.filter((template) => !template.pinned)
    switch (sortOption) {
      case 'alphabetical':
        others.sort((a, b) => (a.title || '').localeCompare(b.title || ''))
        break
      case 'reverse-alphabetical':
      default:
        others.sort((a, b) => (b.title || '').localeCompare(a.title || ''))
        break
    }
    return [...favorites, ...others]
  }, [userTemplates, sortOption])
  const filteredMine = useMemo(() => {
    if (!search.trim()) return sortedUserTemplates
    const q = search.toLowerCase()
    return sortedUserTemplates.filter(
      (template) =>
        template.title?.toLowerCase().includes(q) ||
        template.description?.toLowerCase().includes(q) ||
        template.category?.toLowerCase().includes(q) ||
        template.targets?.some((target) => target.toLowerCase().includes(q))
    )
  }, [sortedUserTemplates, search])
  const filteredWeb = useMemo(() => {
    const query = search.toLowerCase().trim()
    const matchingTemplates = webTemplates.flatMap((template, index) => {
      const matches =
        !query ||
        template.title?.toLowerCase().includes(query) ||
        template.description?.toLowerCase().includes(query) ||
        template.category?.toLowerCase().includes(query) ||
        template.targets?.some((target) => target.toLowerCase().includes(query))
      return matches
        ? [
            {
              template,
              index,
            },
          ]
        : []
    })
    matchingTemplates.sort((a, b) => {
      const titleA = a.template.title || ''
      const titleB = b.template.title || ''
      return sortOption === 'reverse-alphabetical'
        ? titleB.localeCompare(titleA)
        : titleA.localeCompare(titleB)
    })
    return matchingTemplates
  }, [search, sortOption, webTemplates])
  const combinedTemplates = useMemo<
    Array<
      | {
          key: typeof AUTO_TEMPLATE_ID
          title: 'Auto'
          selected: boolean
          source: 'auto'
          customized: boolean
        }
      | {
          key: string
          title: string
          selected: boolean
          pinned: boolean
          source: 'user'
          template: UserTemplate
        }
      | {
          key: string
          title: string
          selected: boolean
          pinned: false
          source: 'web'
          index: number
          template: WebTemplate
        }
    >
  >(() => {
    const query = search.trim().toLowerCase()
    const auto =
      !query || 'auto'.includes(query)
        ? [
            {
              key: AUTO_TEMPLATE_ID as typeof AUTO_TEMPLATE_ID,
              title: 'Auto' as const,
              selected: !isWebMode && effectiveSelectedMineId === AUTO_TEMPLATE_ID,
              source: 'auto' as const,
              customized: Boolean(autoPrompt.trim()),
            },
          ]
        : []
    const mine = filteredMine.map((template) => ({
      key: template.id,
      title: template.title?.trim() || 'Untitled',
      selected: !isWebMode && effectiveSelectedMineId === template.id,
      pinned: Boolean(template.pinned),
      source: 'user' as const,
      template,
    }))
    const web = filteredWeb.map(({ template, index }) => ({
      key: template.slug || `web-${index}`,
      title: template.title?.trim() || 'Untitled',
      selected: isWebMode && effectiveSelectedWebIndex === index,
      pinned: false as const,
      source: 'web' as const,
      index,
      template,
    }))
    return [...auto, ...mine, ...web]
  }, [
    autoPrompt,
    effectiveSelectedMineId,
    effectiveSelectedWebIndex,
    filteredMine,
    filteredWeb,
    isWebMode,
    search,
  ])
  const hasResults = combinedTemplates.length > 0
  const isEmpty = !isWebLoading && !hasResults
  const selectCombinedTemplate = useCallback(
    (
      item:
        | {
            source: 'auto'
          }
        | {
            source: 'user'
            template: UserTemplate
          }
        | {
            source: 'web'
            index: number
          }
    ) => {
      if (item.source === 'auto') {
        setSelectedMineId(AUTO_TEMPLATE_ID)
        return
      }
      if (item.source === 'user') {
        setSelectedMineId(item.template.id)
        return
      }
      setSelectedWebIndex(item.index)
    },
    [setSelectedMineId, setSelectedWebIndex]
  )
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      !event.altKey ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')
    ) {
      return
    }
    const target = event.target
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        target.closest("input, textarea, select, [contenteditable='true']"))
    ) {
      return
    }
    if (combinedTemplates.length === 0) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const currentIndex = combinedTemplates.findIndex((item) => item.selected)
    const nextIndex =
      currentIndex === -1
        ? event.key === 'ArrowDown'
          ? 0
          : combinedTemplates.length - 1
        : Math.max(
            0,
            Math.min(
              combinedTemplates.length - 1,
              currentIndex + (event.key === 'ArrowDown' ? 1 : -1)
            )
          )
    const nextItem = combinedTemplates[nextIndex]
    if (!nextItem || nextIndex === currentIndex) {
      return
    }
    selectCombinedTemplate(nextItem)
  }
  return (
    <div onKeyDownCapture={handleKeyDown} className="flex h-full w-full flex-col overflow-hidden">
      <div>
        <div className="flex h-12 items-center justify-between">
          <span className="text-sm font-semibold">Templates</span>
          <div className="flex items-center">
            {userTemplates.length > 1 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <ArrowsDownUp aria-label="Sort templates" size={16} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setSortOption('alphabetical')}>
                    <_Trans
                      {
                        /*i18n*/
                        ...{
                          id: 'oGcLFq',
                          message: 'A to Z',
                        }
                      }
                    />
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setSortOption('reverse-alphabetical')}>
                    <_Trans
                      {
                        /*i18n*/
                        ...{
                          id: 'In2v7W',
                          message: 'Z to A',
                        }
                      }
                    />
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            <Button
              size="icon"
              variant="ghost"
              className="text-muted-foreground hover:text-foreground"
              aria-label="Create template"
              onClick={() => void createDefaultTemplate().catch(() => {})}
            >
              <Plus size={16} />
            </Button>
          </div>
        </div>

        <div className="pb-2">
          <div
            ref={searchRef}
            className={cn([
              'border-border bg-accent/50 flex h-8 w-full shrink-0 items-center gap-2 rounded-lg border px-3',
              'focus-within:bg-accent transition-colors',
            ])}
          >
            <MagnifyingGlass className="text-muted-foreground h-4 w-4 shrink-0" />
            <UnstyledInput
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setSearch('')
                }
              }}
              placeholder={_t(
                /*i18n*/
                {
                  id: 'pECIKL',
                  message: 'Search templates...',
                }
              )}
              className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm placeholder:text-sm focus:outline-hidden"
            />
            {search && (
              <UnstyledButton
                variant="custom"
                size={null}
                onClick={() => setSearch('')}
                className={cn([
                  'h-4 w-4 shrink-0',
                  'text-muted-foreground hover:text-muted-foreground',
                  'transition-colors',
                ])}
                aria-label={_t(
                  /*i18n*/
                  {
                    id: 'V8yTm6',
                    message: 'Clear search',
                  }
                )}
              >
                <X className="h-4 w-4" />
              </UnstyledButton>
            )}
          </div>
        </div>
      </div>

      <div ref={scrollContainerRef} className="scrollbar-hide flex-1 overflow-y-auto">
        {isEmpty ? (
          <div className="text-muted-foreground px-3 py-8 text-center">
            <BookOpenText size={32} className="text-muted-foreground/70 mx-auto mb-2" />
            <p className="text-sm">{search ? 'No templates found' : 'No templates yet'}</p>
            {!search && (
              <UnstyledButton
                variant="custom"
                size={null}
                onClick={createDefaultTemplate}
                className="text-muted-foreground hover:text-foreground mt-3 text-sm underline"
              >
                Create my first template
              </UnstyledButton>
            )}
          </div>
        ) : (
          <>
            {hasResults && (
              <div className="pt-1">
                {combinedTemplates.map((item) =>
                  item.source === 'auto' ? (
                    <UnstyledButton
                      variant="custom"
                      size={null}
                      key={item.key}
                      type="button"
                      onClick={() => setSelectedMineId(AUTO_TEMPLATE_ID)}
                      ref={(node) => {
                        if (item.selected)
                          node?.scrollIntoView({
                            block: 'nearest',
                          })
                      }}
                      data-template-selected={item.selected}
                      className={cn([
                        'w-full rounded-lg px-3 py-2 text-left text-sm transition-colors select-none',
                        item.selected ? 'bg-accent' : 'hover:bg-accent/50',
                      ])}
                    >
                      <div className="flex items-center gap-2">
                        <Sparkle className="size-4 text-violet-500" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{item.title}</div>
                          {item.customized ? (
                            <div className="text-muted-foreground truncate text-xs">
                              <_Trans
                                {
                                  /*i18n*/
                                  ...{
                                    id: '63Q_VZ',
                                    message: 'Customized',
                                  }
                                }
                              />
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </UnstyledButton>
                  ) : item.source === 'user' ? (
                    <TemplateListItem
                      key={item.key}
                      template={item.template}
                      selected={item.selected}
                      onSelect={setSelectedMineId}
                      onToggleFavorite={handleToggleFavorite}
                      onDuplicate={handleDuplicateTemplate}
                      onDelete={handleDeleteTemplate}
                    />
                  ) : (
                    <UnstyledButton
                      variant="custom"
                      size={null}
                      key={item.key}
                      onClick={() => setSelectedWebIndex(item.index)}
                      ref={(node) => {
                        if (item.selected)
                          node?.scrollIntoView({
                            block: 'nearest',
                          })
                      }}
                      data-template-selected={item.selected}
                      className={cn([
                        'w-full rounded-lg px-3 py-2 text-left text-sm transition-colors select-none',
                        item.selected ? 'bg-accent' : 'hover:bg-accent/50',
                      ])}
                    >
                      <div className="flex items-center gap-2">
                        <TemplateIconGlyph icon={item.template.icon} className="size-4 text-sm" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{item.title}</div>
                        </div>
                      </div>
                    </UnstyledButton>
                  )
                )}
              </div>
            )}

            {isWebLoading && !hasResults && (
              <div className="pt-1">
                <div className="flex flex-col gap-1">
                  {[0, 1, 2, 3].map((index) => (
                    <div key={index} className="animate-pulse rounded-lg px-3 py-2">
                      <div className="bg-accent h-4 w-3/4 rounded-xs" />
                      <div className="bg-muted mt-1.5 h-3 w-1/3 rounded-xs" />
                    </div>
                  ))}
                </div>
              </div>
            )}
            <SharedResourceLibrarySection
              resourceType="template"
              search={search}
              onImport={async (resource) => {
                const id = await createTemplate(parseSharedTemplatePayload(resource.payload))
                if (id) setSelectedMineId(id)
              }}
            />
          </>
        )}
      </div>
    </div>
  )
}
function TemplateListItem({
  template,
  selected,
  onSelect,
  onToggleFavorite,
  onDuplicate,
  onDelete,
}: {
  template: UserTemplate
  selected: boolean
  onSelect: (id: string) => void
  onToggleFavorite: (id: string) => void
  onDuplicate: (template: UserTemplate) => void
  onDelete: (id: string) => void
}) {
  const contextMenu = useMemo(
    () => [
      {
        id: `favorite-template-${template.id}`,
        text: template.pinned ? 'Unfavorite' : 'Favorite',
        action: () => onToggleFavorite(template.id),
      },
      {
        separator: true as const,
      },
      {
        id: `duplicate-template-${template.id}`,
        text: 'Duplicate',
        action: () => onDuplicate(template),
      },
      {
        id: `delete-template-${template.id}`,
        text: 'Delete',
        action: () => onDelete(template.id),
      },
    ],
    [onDelete, onDuplicate, onToggleFavorite, template]
  )
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <div className="relative group">
      <UnstyledButton
        variant="custom"
        size={null}
        onClick={() => onSelect(template.id)}
        onContextMenu={(e) => {
          onSelect(template.id)
          e.preventDefault()
          setMenuOpen(true)
        }}
        ref={(node) => {
          if (selected)
            node?.scrollIntoView({
              block: 'nearest',
            })
        }}
        data-template-selected={selected}
        className={cn([
          'w-full rounded-lg px-3 py-2 text-left text-sm transition-colors select-none',
          selected ? 'bg-accent' : 'hover:bg-accent/50',
        ])}
      >
        <div className="flex items-center gap-2">
          <TemplateIconGlyph icon={template.icon} className="size-4 text-sm" />
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{template.title?.trim() || 'Untitled'}</div>
          </div>
        </div>
      </UnstyledButton>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-0 top-1 h-7 w-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            aria-label={`Actions for ${template.title || 'Untitled'}`}
          >
            <DotsThree size={16} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {contextMenu.map((item, index) =>
            'separator' in item ? (
              <DropdownMenuSeparator key={index} />
            ) : (
              <DropdownMenuItem
                key={item.id}
                onSelect={() => {
                  void Promise.resolve(item.action()).catch(() => {})
                }}
              >
                {item.text}
              </DropdownMenuItem>
            )
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
