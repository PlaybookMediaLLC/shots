// Ported from apps/desktop/src/templates/details.tsx; see dev/import-founder-hub-ui.mjs.
import { Trans as _Trans } from '@lingui/react'
import { useLingui as _useLingui } from '@lingui/react'
import { useState } from 'react'
import { DotsThree, Heart, Plus } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { AutoTemplateDetails } from './auto-form'
import { type WebTemplate } from './codec'
import { type UserTemplate, type UserTemplateDraft } from './queries'
import { SectionsList } from './sections-editor'
import { TemplateForm } from './template-form'
import { TemplateIconGlyph } from './template-icon'
import { getTemplateCreatorLabel } from './utils'
import { ResourceDetailEmpty, ResourcePreviewHeader } from '../resource-list'
export function TemplateDetailsColumn({
  isAutoSelected,
  isWebMode,
  selectedMineTemplate,
  selectedWebTemplate,
  handleCreateTemplate,
  handleDeleteTemplate,
  handleDuplicateTemplate,
  handleCloneTemplate,
  handleFavoriteTemplate,
  handleSetDefaultTemplate,
}: {
  isAutoSelected: boolean
  isWebMode: boolean
  selectedMineTemplate: UserTemplate | null
  selectedWebTemplate: WebTemplate | null
  handleCreateTemplate: () => void
  handleDeleteTemplate: (id: string) => void
  handleDuplicateTemplate: (id: string) => void
  handleCloneTemplate: (template: UserTemplateDraft) => void
  handleFavoriteTemplate: (template: UserTemplateDraft) => void
  handleSetDefaultTemplate: (template: UserTemplateDraft) => void
}) {
  const { _: _t } = _useLingui()
  if (isAutoSelected) {
    return <AutoTemplateDetails />
  }
  if (isWebMode) {
    if (!selectedWebTemplate) {
      return (
        <ResourceDetailEmpty
          message={_t(
            /*i18n*/
            {
              id: 'VPaARk',
              message: 'No community templates available',
            }
          )}
        />
      )
    }
    return (
      <WebTemplatePreview
        template={selectedWebTemplate}
        onClone={handleCloneTemplate}
        onFavorite={handleFavoriteTemplate}
        onSetDefault={handleSetDefaultTemplate}
      />
    )
  }
  if (!selectedMineTemplate) {
    return <TemplateDetailEmpty onCreate={handleCreateTemplate} />
  }
  return (
    <TemplateForm
      key={selectedMineTemplate.id}
      template={selectedMineTemplate}
      handleDeleteTemplate={handleDeleteTemplate}
      handleDuplicateTemplate={handleDuplicateTemplate}
    />
  )
}
function TemplateDetailEmpty({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3">
      <p className="text-muted-foreground text-sm">
        <_Trans
          {
            /*i18n*/
            ...{
              id: '5l9iMR',
              message: 'No templates yet',
            }
          }
        />
      </p>
      <Button type="button" size="sm" variant="outline" onClick={onCreate} className="gap-2">
        <Plus className="size-4" />
        <_Trans
          {
            /*i18n*/
            ...{
              id: 'A5hiCy',
              message: 'Create template',
            }
          }
        />
      </Button>
    </div>
  )
}
function WebTemplatePreview({
  template,
  onClone,
  onFavorite,
  onSetDefault,
}: {
  template: WebTemplate
  onClone: (template: UserTemplateDraft) => void
  onFavorite: (template: UserTemplateDraft) => void
  onSetDefault: (template: UserTemplateDraft) => void
}) {
  const { _: _t2 } = _useLingui()
  const nextTemplate: UserTemplateDraft = {
    title: template.title ?? '',
    description: template.description ?? '',
    category: template.category,
    icon: template.icon,
    targets: template.targets,
    sections: template.sections ?? [],
  }
  const [actionsOpen, setActionsOpen] = useState(false)
  return (
    <div className="flex h-full flex-1 flex-col">
      <ResourcePreviewHeader
        icon={<TemplateIconGlyph icon={template.icon} className="size-4 text-sm" />}
        title={
          template.title ||
          _t2(
            /*i18n*/
            {
              id: 'wja8aL',
              message: 'Untitled',
            }
          )
        }
        description={template.description}
        targets={template.targets}
        titleMeta={
          <span className="text-muted-foreground shrink-0 text-xs font-normal whitespace-nowrap">
            {getTemplateCreatorLabel({
              isUserTemplate: false,
              format: 'short',
            })}
          </span>
        }
        footer={null}
        actions={
          <>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => onSetDefault(nextTemplate)}
              className="text-muted-foreground shrink-0 hover:text-foreground"
            >
              <_Trans
                {
                  /*i18n*/
                  ...{
                    id: 'PPcets',
                    message: 'Set as default',
                  }
                }
              />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={() => onFavorite(nextTemplate)}
              className="text-muted-foreground hover:text-foreground"
              title={_t2(
                /*i18n*/
                {
                  id: 'OG_ZPr',
                  message: 'Favorite template',
                }
              )}
              aria-label={_t2(
                /*i18n*/
                {
                  id: 'OG_ZPr',
                  message: 'Favorite template',
                }
              )}
            >
              <Heart className="size-4" />
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
                  aria-label={_t2(
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
                <DropdownMenuItem onClick={() => onClone(nextTemplate)} className="cursor-pointer">
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
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      >
        <div className="mt-6">
          <SectionsList disabled={true} items={template.sections ?? []} onChange={() => {}} />
        </div>
      </ResourcePreviewHeader>
    </div>
  )
}
