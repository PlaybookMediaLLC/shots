'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { brandKitFromDocument, type BrandKit, type BrandKitParts } from '@/lib/store-screenshots/brand-kits'
import { DEVICE_MODELS, getDeviceModel } from '@/lib/store-screenshots/devices'
import { newId } from '@/lib/store-screenshots/document/factory'
import type { StoreDocument } from '@/lib/store-screenshots/document/schema'
import { BUNDLED_FONTS, fontNameFor } from '@/lib/store-screenshots/fonts'
import type { SlideScope } from '@/lib/store-screenshots/commands/schema'
import { ingestImageFile } from '@/lib/store-screenshots/persistence/ingest'
import { deleteBrandKit, deleteTemplate, listBrandKits, listSavedTemplates, saveBrandKit, saveTemplate } from '@/lib/store-screenshots/persistence/library'
import { BUILT_IN_TEMPLATES, createDocumentFromTemplate, templateCategorySchema, templateFromDocument, type StoreTemplate, type TemplateCategory } from '@/lib/store-screenshots/templates'
import { useTRPCClient } from '@/lib/trpc/react'
import { cn } from '@/lib/utils'
import { StoreTemplatePreview } from '../../StoreTemplatePreview'
import { ColorField } from '../controls'
import { useEditor, useEditorApi } from '../editor-store'
import { BackgroundField } from '../inspector/BackgroundField'
import { FontPicker } from '../inspector/FontPicker'
import type { DialogProps } from './BasicDialogs'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'

const CATEGORY_LABELS: Record<TemplateCategory, string> = {
  fitness: 'Fitness',
  finance: 'Finance',
  productivity: 'Productivity',
  games: 'Games',
  education: 'Education',
  health: 'Health',
  saas: 'SaaS',
  ecommerce: 'E-commerce',
  general: 'General',
  saved: 'Saved by you',
}

/** Template gallery: preview, apply to this project, or start a new project. */
export function TemplatesDialog({ open, onOpenChange, onCreateProject }: DialogProps & { onCreateProject: (document: StoreDocument) => void }): React.JSX.Element {
  const api = useEditorApi()
  const [category, setCategory] = React.useState<TemplateCategory | null>(null)
  const [saved, setSaved] = React.useState<StoreTemplate[]>([])
  React.useEffect(() => {
    if (open) void listSavedTemplates().then(setSaved, () => setSaved([]))
  }, [open])
  const templates = [...BUILT_IN_TEMPLATES, ...saved].filter((template) => category === null || template.category === category)
  const categories = templateCategorySchema.options.filter((item) => item !== 'general' && (item !== 'saved' || saved.length > 0))
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid-cols-[minmax(0,1fr)] max-h-[92vh] sm:max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Templates</DialogTitle>
          <DialogDescription>Applying a template restyles this project (type, colors, layouts, devices) and keeps your copy and screenshots. Undo restores the previous look.</DialogDescription>
        </DialogHeader>
        <div role="tablist" aria-label="Template category" className="flex flex-wrap gap-1">
          {[null, ...categories].map((item) => (
            <Button variant="custom" size={null} key={item ?? 'all'} type="button" role="tab" aria-selected={category === item} onClick={() => setCategory(item)} className={cn('h-8 rounded-md px-2.5 text-xs', category === item ? 'bg-foreground text-background' : 'border border-foreground/10 hover:bg-foreground/[0.04]')}>
              {item === null ? 'All' : CATEGORY_LABELS[item]}
            </Button>
          ))}
        </div>
        <ul className="space-y-4" aria-label="Templates">
          {templates.map((template) => (
            <li key={template.id} className="space-y-2 rounded-lg border border-foreground/10 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-ui-lg font-semibold">
                    {template.name} <span className="text-xs font-normal text-muted-foreground">· {CATEGORY_LABELS[template.category]}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">{template.description}</p>
                </div>
                <div className="flex gap-1.5">
                  {template.category === 'saved' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      onClick={async () => {
                        await deleteTemplate(template.id)
                        setSaved(await listSavedTemplates())
                      }}
                    >
                      Delete
                    </Button>
                  ) : null}
                  <Button size="sm" variant="outline" onClick={() => onCreateProject(createDocumentFromTemplate(template))}>
                    New project
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => {
                      api.getState().dispatch({ type: 'template.apply', template })
                      onOpenChange(false)
                      toast.success(`Applied ${template.name}`, { action: { label: 'Undo', onClick: () => api.getState().undo() } })
                    }}
                  >
                    Apply to this project
                  </Button>
                </div>
              </div>
              <StoreTemplatePreview template={template} />
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}

/** Save the current design as a reusable template (screenshots are not included). */
export function SaveTemplateDialog({ open, onOpenChange }: DialogProps): React.JSX.Element {
  const document = useEditor((state) => state.document)
  const [name, setName] = React.useState(`${document.name} style`)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save as template</DialogTitle>
          <DialogDescription>Saves the type, colors, layouts, backgrounds, device style, placeholder copy, and badges. Screenshots and uploaded images are not part of a template.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={async (event) => {
            event.preventDefault()
            await saveTemplate(templateFromDocument(document, name))
            toast.success('Template saved', { description: 'Find it under Templates → Saved by you.' })
            onOpenChange(false)
          }}
        >
          <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} aria-label="Template name" className="h-9 w-full rounded-md border border-foreground/10 bg-foreground/[0.035] px-3 text-sm outline-none" />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim()}>
              Save template
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function workspaceKit(definition: Record<string, unknown>, name: string, base: BrandKit): BrandKit {
  const colors = (definition.colors ?? {}) as Record<string, unknown>
  const typography = (definition.typography ?? {}) as Record<string, unknown>
  const hex = (value: unknown) => (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : null)
  const palette = [hex(colors.accent), hex(colors.foreground), hex(colors.background)].filter((value): value is string => Boolean(value))
  const family = typeof typography.fontFamily === 'string' ? typography.fontFamily.trim() : ''
  const bundled = BUNDLED_FONTS.find((font) => font.name.toLowerCase() === family.toLowerCase())
  return {
    ...base,
    id: newId(),
    name: `${name} (workspace)`,
    palette: palette.length ? [...palette, ...base.palette].slice(0, 6) : base.palette,
    headingFont: bundled?.value ?? (family ? `"${family}", system-ui, sans-serif` : base.headingFont),
    bodyFont: bundled?.value ?? base.bodyFont,
    fontSources: !bundled && family && /^[A-Za-z0-9][A-Za-z0-9 -]*$/.test(family) ? [{ family, kind: 'google', assetId: null }] : [],
    background: hex(colors.background) ? { kind: 'solid', color: hex(colors.background)! } : base.background,
  }
}

const DEFAULT_PARTS: BrandKitParts = { colors: true, fonts: true, background: true, device: true, logo: true, keepOverrides: true }

/** Brand kits: create, edit, duplicate, delete, import from the workspace, and apply. */
export function BrandKitsDialog({ open, onOpenChange }: DialogProps): React.JSX.Element {
  const api = useEditorApi()
  const trpcClient = useTRPCClient()
  const document = useEditor((state) => state.document)
  const selectedSlideIds = useEditor((state) => state.selectedSlideIds)
  const [kits, setKits] = React.useState<BrandKit[]>([])
  const [editing, setEditing] = React.useState<BrandKit | null>(null)
  const [parts, setParts] = React.useState<BrandKitParts>(DEFAULT_PARTS)
  const [scope, setScope] = React.useState<SlideScope>(selectedSlideIds.length > 1 ? 'selected' : 'all')
  const logoRef = React.useRef<HTMLInputElement>(null)
  const refresh = React.useCallback(() => void listBrandKits().then(setKits, () => setKits([])), [])
  React.useEffect(() => {
    if (open) refresh()
  }, [open, refresh])

  const persist = async (kit: BrandKit) => {
    const saved = await saveBrandKit(kit)
    setEditing(saved)
    refresh()
  }

  const importWorkspace = async () => {
    try {
      const { brandKits } = await trpcClient.brandKit.list.query()
      const active = brandKits.find((kit) => kit.status === 'ACTIVE') ?? brandKits[0]
      if (!active) {
        toast('Your workspace has no brand kit yet.')
        return
      }
      await persist(workspaceKit(active.definition as Record<string, unknown>, active.name, brandKitFromDocument(document, active.name)))
      toast.success(`Imported “${active.name}” from your workspace`)
    } catch {
      toast.error('Could not read the workspace brand kit', { description: 'You may not have permission to view brand settings.' })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid-cols-[minmax(0,1fr)] max-h-[92vh] sm:max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Brand kits</DialogTitle>
          <DialogDescription>Kits are saved in this browser and work in every project and language.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-6 md:grid-cols-[260px_1fr]">
          <div className="space-y-2">
            <Button className="w-full" onClick={() => void persist(brandKitFromDocument(document, `${document.name} kit`))}>
              New kit from this project
            </Button>
            <Button className="w-full" variant="outline" onClick={() => void importWorkspace()}>
              Import workspace brand kit
            </Button>
            <ul className="space-y-1" aria-label="Brand kits">
              {kits.map((kit) => (
                <li key={kit.id}>
                  <Button variant="custom" size={null} type="button" onClick={() => setEditing(kit)} className={cn('flex w-full items-center gap-2 rounded-md border p-2 text-left text-xs', editing?.id === kit.id ? 'border-foreground/40 bg-foreground/[0.05]' : 'border-foreground/10')}>
                    <span className="flex">
                      {kit.palette.slice(0, 4).map((color) => (
                        <span key={color} className="-ml-1 size-4 rounded-full border border-background first:ml-0" style={{ background: color }} />
                      ))}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium">{kit.name}</span>
                    {document.brandKitId === kit.id ? <span className="text-[10px] text-muted-foreground">in use</span> : null}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
          {editing ? (
            <div className="space-y-4">
              <div className="flex gap-2">
                <Input key={editing.id} defaultValue={editing.name} aria-label="Kit name" maxLength={80} onBlur={(event) => event.target.value.trim() && event.target.value !== editing.name && void persist({ ...editing, name: event.target.value.trim() })} className="h-9 min-w-0 flex-1 rounded-md border border-foreground/10 bg-foreground/[0.035] px-3 text-sm outline-none" />
                <Button variant="outline" onClick={() => void persist({ ...editing, id: newId(), name: `${editing.name} copy`, createdAt: Date.now() })}>
                  Duplicate
                </Button>
                <Button
                  variant="ghost"
                  className="text-destructive"
                  onClick={async () => {
                    await deleteBrandKit(editing.id)
                    setEditing(null)
                    refresh()
                  }}
                >
                  Delete
                </Button>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {editing.palette.map((color, index) => (
                  <ColorField
                    key={index}
                    label={`Color ${index + 1}`}
                    value={color}
                    onChange={(next) => {
                      if (!next) return
                      const palette = [...editing.palette]
                      palette[index] = next
                      setEditing({ ...editing, palette })
                    }}
                  />
                ))}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <FontPicker label="Heading font" value={editing.headingFont} onChange={(headingFont) => setEditing({ ...editing, headingFont, fontSources: [...editing.fontSources, ...document.fonts.filter((font) => headingFont.includes(font.family))].slice(0, 8) })} />
                <FontPicker label="Body font" value={editing.bodyFont} onChange={(bodyFont) => setEditing({ ...editing, bodyFont, fontSources: [...editing.fontSources, ...document.fonts.filter((font) => bodyFont.includes(font.family))].slice(0, 8) })} />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Heading: {fontNameFor(editing.headingFont)} · Body: {fontNameFor(editing.bodyFont)}
              </p>
              <div className="space-y-1">
                <span className="text-[11px] text-muted-foreground">Default background</span>
                <BackgroundField value={editing.background} onChange={(background) => background && background.kind !== 'image' && setEditing({ ...editing, background })} />
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <Label className="block space-y-1">
                  <span className="text-muted-foreground">Device</span>
                  <Select
                    value={editing.deviceFrame.modelId}
                    onValueChange={(nextValue) =>
                      setEditing({
                        ...editing,
                        deviceFrame: {
                          ...editing.deviceFrame,
                          modelId: nextValue,
                          finishId: getDeviceModel(nextValue).finishes[0].id,
                        },
                      })
                    }
                  >
                    <SelectTrigger className="h-8 w-full rounded-md border border-foreground/10 bg-background px-2">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DEVICE_MODELS.map((model) => (
                        <SelectItem key={model.id} value={model.id}>
                          {model.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Label>
                <div className="space-y-1">
                  <span className="text-muted-foreground">Logo</span>
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="outline" onClick={() => logoRef.current?.click()}>
                      {editing.logoAssetId ? 'Replace logo' : 'Upload logo'}
                    </Button>
                    {editing.logoAssetId ? (
                      <Button size="sm" variant="ghost" onClick={() => setEditing({ ...editing, logoAssetId: null, assets: editing.assets.filter((asset) => asset.id !== editing.logoAssetId) })}>
                        Remove
                      </Button>
                    ) : null}
                  </div>
                  <Input
                    ref={logoRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={async (event) => {
                      const file = event.target.files?.[0]
                      event.currentTarget.value = ''
                      if (!file) return
                      try {
                        const asset = await ingestImageFile(file)
                        setEditing({ ...editing, logoAssetId: asset.id, assets: [...editing.assets.filter((item) => item.id !== editing.logoAssetId), asset] })
                      } catch (cause) {
                        toast.error('Could not use that logo', { description: cause instanceof Error ? cause.message : undefined })
                      }
                    }}
                  />
                </div>
              </div>
              <Button variant="outline" onClick={() => void persist(editing).then(() => toast.success('Kit saved'))}>
                Save kit
              </Button>
              <fieldset className="space-y-2 rounded-md border border-foreground/10 p-3 text-xs">
                <legend className="px-1 font-medium">Apply</legend>
                <div className="flex gap-3">
                  <Label className="flex items-center gap-1.5">
                    <Input type="radio" name="kit-scope" checked={scope === 'all'} onChange={() => setScope('all')} /> Whole project
                  </Label>
                  <Label className="flex items-center gap-1.5">
                    <Input type="radio" name="kit-scope" checked={scope === 'selected'} disabled={selectedSlideIds.length === 0} onChange={() => setScope('selected')} /> Selected slides ({selectedSlideIds.length})
                  </Label>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {(['colors', 'fonts', 'background', 'device', 'logo'] as const).map((part) => (
                    <Label key={part} className="flex items-center gap-1.5 capitalize">
                      <Checkbox  checked={parts[part]} onCheckedChange={(checked) => setParts({ ...parts, [part]: (checked === true) })} />
                      {part}
                    </Label>
                  ))}
                  <Label className="col-span-3 flex items-center gap-1.5">
                    <Checkbox  checked={parts.keepOverrides} onCheckedChange={(checked) => setParts({ ...parts, keepOverrides: (checked === true) })} />
                    Keep text styles a slide sets on purpose
                  </Label>
                </div>
                <Button
                  onClick={async () => {
                    const saved = await saveBrandKit(editing)
                    api.getState().dispatch({ type: 'brandKit.apply', kit: saved, slideIds: scope === 'selected' ? selectedSlideIds : null, parts })
                    toast.success(`Applied ${saved.name}`, { action: { label: 'Undo', onClick: () => api.getState().undo() } })
                    onOpenChange(false)
                  }}
                >
                  Apply {scope === 'selected' ? `to ${selectedSlideIds.length} slides` : 'to the whole project'}
                </Button>
              </fieldset>
            </div>
          ) : (
            <p className="self-center text-sm text-muted-foreground">Choose a kit to edit or apply, or create one from this project.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
