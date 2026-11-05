'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { SidebarLink } from '@/components/platform-shell/SidebarLink'
import { useNearViewport } from '@/components/design/DocumentPreview'
import { ImageTemplatePreview } from '@/components/templates/ImageTemplateGallery'
import { AnimatedTemplatePreview } from '@/components/templates/AnimatedTemplateGallery'
import { RecipePreview } from '@/components/canvas-workspace/RecipePreview'
import { StoreTemplatePreview } from '@/components/store-screenshots/StoreTemplatePreview'
import { WorkflowTemplatePreview } from '@/components/workflows/WorkflowTemplatePreview'
import { DesignTemplatePreview } from '@/components/design/DesignTemplatePreview'
import { designTemplates } from '@/lib/design/templates'
import { IMAGE_TEMPLATES } from '@/lib/templates/image-templates'
import { ANIMATED_TEMPLATES } from '@/lib/animation/templates'
import { CANVAS_RECIPES, canvasRecipeSchema } from '@/lib/canvas/recipes'
import { STORE_SCREENSHOTS } from '@/lib/platform/navigation'
import { BUILT_IN_TEMPLATES, type StoreTemplate } from '@/lib/store-screenshots/templates'
import { listSavedTemplates } from '@/lib/store-screenshots/persistence/library'
import { WORKFLOW_TEMPLATES, buildWorkflowTemplate } from '@/lib/workflows/templates'

const CATEGORIES = [
  'Screenshots',
  'Animated',
  'Layouts & presets',
  'Canvas',
  'Store screenshots',
  'Workflows',
] as const

function PreviewCard({
  name,
  description,
  href,
  action,
  children,
}: {
  name: string
  description: string
  href: string
  action: string
  children: ReactNode
}) {
  const [ref, near] = useNearViewport<HTMLDivElement>()
  return (
    <li className="studio-shot">
      <div ref={ref} role="img" aria-label={`Preview of ${name}`} className="studio-shot-media">
        <div className="grid size-full place-items-center p-3">
          {near ? (
            <div className="w-full" aria-hidden="true">
              {children}
            </div>
          ) : (
            <span className="text-sm text-muted-foreground">Preview loads as you scroll</span>
          )}
        </div>
        <span aria-hidden="true" className="studio-shot-overlay">
          {description}
        </span>
      </div>
      <div className="studio-shot-meta">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-medium">{name}</h3>
          <p className="truncate text-xs text-muted-foreground">{description}</p>
        </div>
        <SidebarLink
          aria-label={`${action}: ${name}`}
          href={href}
          className="shrink-0 rounded-full border border-border px-3 py-1.5 text-xs font-medium hover:bg-foreground/[0.04]"
        >
          {action}
        </SidebarLink>
      </div>
    </li>
  )
}

/** A short row of screenshot templates for Home, opening the same editor. */
export function TemplateStrip({ count = 4 }: { count?: number }) {
  return (
    <ul className="studio-grid studio-strip">
      {IMAGE_TEMPLATES.slice(0, count).map((template) => (
        <PreviewCard
          key={template.preset.id}
          name={template.preset.name}
          description={template.preset.description}
          href={newScreenshotFrom(template.preset.id)}
          action="Use template"
        >
          <ImageTemplatePreview template={template} />
        </PreviewCard>
      ))}
    </ul>
  )
}

/** A new screenshot that opens with this template applied (ProjectLoader). */
const newScreenshotFrom = (id: string) => `/?start=new&template=${encodeURIComponent(id)}`

/** Shared catalog. Screenshot and Canvas templates open applied; the rest open their editor. */
export default function TemplateCatalog() {
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>('Screenshots')
  const [saved, setSaved] = useState<StoreTemplate[]>([])
  const [localError, setLocalError] = useState(false)
  useEffect(() => {
    if (category !== 'Store screenshots') return
    let cancelled = false
    listSavedTemplates().then(
      (items) => {
        if (!cancelled) {
          setSaved(items)
          setLocalError(false)
        }
      },
      () => {
        if (!cancelled) setLocalError(true)
      }
    )
    return () => {
      cancelled = true
    }
  }, [category])
  return (
    <section aria-label="Template previews" className="space-y-5">
      <div className="platform-tabs" role="group" aria-label="Template categories">
        {CATEGORIES.map((item) => (
          <Button
            key={item}
            variant="custom"
            size={null}
            aria-current={category === item ? 'page' : undefined}
            aria-pressed={category === item}
            className={
              category === item
                ? 'platform-tab text-foreground'
                : 'platform-tab text-muted-foreground hover:text-foreground'
            }
            onClick={() => setCategory(item)}
            type="button"
          >
            {item}
          </Button>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        Use template opens a new screenshot or Canvas with that template applied. Animated, store
        and workflow templates are chosen again in their editor. Browsing never changes your saved
        work.
      </p>
      {category === 'Store screenshots' ? (
        <p className="text-sm text-muted-foreground">
          Built-in templates and templates saved on this browser.
        </p>
      ) : null}
      {localError && category === 'Store screenshots' ? (
        <p role="alert" className="text-sm text-destructive">
          Saved templates could not load. Built-in templates are still available. Reopen this
          category to retry.
        </p>
      ) : null}
      <ul key={category} className="studio-grid">
        {category === 'Screenshots'
          ? IMAGE_TEMPLATES.map((template) => (
              <PreviewCard
                key={template.preset.id}
                name={template.preset.name}
                description={template.preset.description}
                href={newScreenshotFrom(template.preset.id)}
                action="Use template"
              >
                <ImageTemplatePreview template={template} />
              </PreviewCard>
            ))
          : null}
        {category === 'Animated'
          ? ANIMATED_TEMPLATES.map((template) => (
              <PreviewCard
                key={template.id}
                name={template.name}
                description={template.description}
                href="/?start=new"
                action="Open editor"
              >
                <AnimatedTemplatePreview template={template} active={false} />
              </PreviewCard>
            ))
          : null}
        {category === 'Layouts & presets'
          ? designTemplates
              .filter((template) => template.kind !== 'editor-template')
              .map((template) => (
                <PreviewCard
                  key={template.id}
                  name={template.name}
                  description={template.description}
                  href={newScreenshotFrom(template.id)}
                  action="Use template"
                >
                  <DesignTemplatePreview id={template.id} />
                </PreviewCard>
              ))
          : null}
        {category === 'Canvas'
          ? canvasRecipeSchema.options.map((recipe) => (
              <PreviewCard
                key={recipe}
                name={CANVAS_RECIPES[recipe].name}
                description={CANVAS_RECIPES[recipe].description}
                href={`/canvas/new?start=template&recipe=${recipe}`}
                action="Use template"
              >
                <RecipePreview recipe={recipe} />
              </PreviewCard>
            ))
          : null}
        {category === 'Store screenshots'
          ? [...BUILT_IN_TEMPLATES, ...saved].map((template) => (
              <PreviewCard
                key={template.id}
                name={template.name}
                description={template.description}
                href={STORE_SCREENSHOTS.href}
                action="Open studio"
              >
                <StoreTemplatePreview template={template} />
              </PreviewCard>
            ))
          : null}
        {category === 'Workflows'
          ? WORKFLOW_TEMPLATES.map((template) => (
              <PreviewCard
                key={template.id}
                name={template.name}
                description={template.description}
                href="/workflows/new"
                action="New workflow"
              >
                <WorkflowTemplatePreview
                  name={template.name}
                  {...buildWorkflowTemplate(template.id, {
                    brandKitId: '',
                    destinationIds: [],
                    creditLimit: 0,
                    branch: 'main',
                    aiRelevance: false,
                    majorMinorOnly: template.versioned,
                    renderTemplateIds: [],
                    canvas: false,
                  })}
                />
              </PreviewCard>
            ))
          : null}
      </ul>
    </section>
  )
}
