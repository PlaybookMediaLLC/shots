'use client'

import { Button } from '@/components/ui/button'
import { settingsErrorMessage } from '@/lib/settings/client'
import { useTemplatesQuery, useTemplateDrafts, useRecoverTemplateDraft } from './queries'
import { useWebResources } from '../resource-list/catalog'
import { TemplateNavigation, useTabs } from './navigation'
import { TemplatesSidebarContent } from './template-sidebar'
import { TemplateView } from './template-body'

export function SettingsTemplates() {
  const templates = useTemplatesQuery()
  const catalog = useWebResources('templates')
  if (templates.isPending || catalog.isPending) return <p role="status">Loading templates…</p>
  if (!templates.data || !catalog.data)
    return (
      <div role="alert">
        {settingsErrorMessage(templates.error || catalog.error)}{' '}
        <Button
          onClick={() => {
            void templates.refetch()
            void catalog.refetch()
          }}
        >
          Retry
        </Button>
      </div>
    )
  return (
    <TemplateNavigation>
      {(templates.isError || catalog.isError) && (
        <div role="alert" className="text-sm text-destructive">
          Templates could not refresh. Your draft is still here.{' '}
          <Button
            onClick={() => {
              void templates.refetch()
              void catalog.refetch()
            }}
          >
            Retry
          </Button>
        </div>
      )}
      <TemplateColumns />
    </TemplateNavigation>
  )
}

function TemplateColumns() {
  const tab = useTabs((state) => state.tab)
  const update = useTabs((state) => state.updateTemplatesTabState)
  const templates = useTemplatesQuery()
  const drafts = useTemplateDrafts()
  const recover = useRecoverTemplateDraft()
  const id = tab.state.selectedMineId
  const deletedDraft = id && drafts[id] && !templates.data?.some((item) => item.id === id)
  return (
    <div className="flex h-[min(75vh,900px)] min-h-96 gap-4">
      <nav aria-label="Templates" className="w-56 shrink-0">
        <TemplatesSidebarContent tab={tab} />
      </nav>
      <div className="min-w-0 flex-1 border-l pl-3">
        {deletedDraft && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm"
          >
            <span>This template was deleted elsewhere. Your unsaved draft is still here.</span>
            {[true, false].map((copy) => (
              <Button
                key={String(copy)}
                variant="outline"
                disabled={recover.isPending}
                onClick={() =>
                  recover.mutate(
                    { id, copy },
                    {
                      onSuccess: (createdId) =>
                        update(tab, { selectedMineId: createdId ?? '__auto__' }),
                    }
                  )
                }
              >
                {copy ? 'Save as copy' : 'Discard draft'}
              </Button>
            ))}
            {recover.error && (
              <span className="text-destructive">{settingsErrorMessage(recover.error)}</span>
            )}
          </div>
        )}
        <TemplateView tab={tab} />
      </div>
    </div>
  )
}
