'use client'

import * as React from 'react'
import { TrashIcon as Delete02Icon } from '@phosphor-icons/react/dist/ssr/Trash'
import { PlusIcon as PlusSignIcon } from '@phosphor-icons/react/dist/ssr/Plus'
import { FontPicker } from '@/components/editor/typography/FontPicker'
import { ColorField, ChoiceField } from '@/components/editor/inspector/fields'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  type BrandFrame,
  type BrandKit,
  type BrandKitDraft,
  type BrandLogo,
  fontName,
  type LogoTone,
} from '@/lib/brand/kit'
import { saveBrandKit } from '@/lib/brand/library'
import type { DesignDocument } from '@/lib/design/document'
import { exportDesignDocument } from '@/lib/design/export'
import { fetchAssetUrl } from '@/lib/design/open-design'
import { uploadSource } from '@/lib/design/upload-sources'
import { useTRPCClient } from '@/lib/trpc/react'

/** Logo types workspace assets accept (SVG is not one). */
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const LOGO_MAX_BYTES = 5 * 1024 * 1024

const TONES: readonly { label: string; value: LogoTone }[] = [
  { label: 'Any', value: 'any' },
  { label: 'Light logo', value: 'light' },
  { label: 'Dark logo', value: 'dark' },
]

type Choice = 'brand' | 'design' | 'saved'

type Draft = {
  accent: string
  background: string
  foreground: string
  logos: BrandLogo[]
  name: string
  palette: string[]
  primaryFont: string
  secondary: string
  secondaryFont: string | null
}

function initialDraft(kit: BrandKit | undefined): Draft {
  return {
    accent: kit?.accent ?? '#6d5dfc',
    background: kit?.colors.background ?? '#0b1020',
    foreground: kit?.colors.foreground ?? '#f8fafc',
    logos: kit?.logos ?? [],
    name: kit?.name ?? '',
    palette: kit?.colors.palette ?? [],
    primaryFont: kit?.primaryFont ?? 'inter',
    secondary: kit?.colors.secondary ?? kit?.accent ?? '#22d3ee',
    secondaryFont: kit && kit.secondaryFont !== kit.primaryFont ? kit.secondaryFont : null,
  }
}

function backgroundCss(background: NonNullable<DesignDocument['background']>): string | undefined {
  if (background.type === 'solid') return background.value
  if (background.type === 'gradient' && background.value.startsWith('linear-gradient('))
    return background.value
  return undefined
}

/** A logo stored as an asset, shown from the workspace. */
function LogoThumb({ src }: { src: string }) {
  const trpcClient = useTRPCClient()
  const [url, setUrl] = React.useState<string | null>(null)
  React.useEffect(() => {
    let active = true
    fetchAssetUrl(trpcClient, src.slice('asset:'.length))
      .then((value) => active && setUrl(value))
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [src, trpcClient])
  return url ? (
    <img
      alt=""
      className="size-10 rounded border border-foreground/10 bg-[conic-gradient(#ddd_25%,#fff_0_50%,#ddd_0_75%,#fff_0)] bg-[length:8px_8px] object-contain"
      src={url}
    />
  ) : (
    <div aria-hidden className="size-10 animate-pulse rounded bg-foreground/[0.06]" />
  )
}

/**
 * Create a brand kit or save the next version of one: colours, fonts, logos,
 * and the background and frame designs start from (taken from the current design).
 */
export function BrandKitDialog({
  kit,
  onOpenChange,
  onSaved,
  open,
}: {
  kit?: BrandKit
  onOpenChange: (open: boolean) => void
  onSaved: (name: string) => void
  open: boolean
}) {
  const trpcClient = useTRPCClient()
  const [draft, setDraft] = React.useState<Draft>(() => initialDraft(kit))
  const [background, setBackground] = React.useState<Choice>(kit?.background ? 'saved' : 'brand')
  const [frame, setFrame] = React.useState<Choice>(kit?.frame ? 'saved' : 'brand')
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const [uploading, setUploading] = React.useState(false)
  const fileRef = React.useRef<HTMLInputElement>(null)
  const nameId = React.useId()

  React.useEffect(() => {
    if (!open) return
    setDraft(initialDraft(kit))
    setBackground(kit?.background ? 'saved' : 'brand')
    setFrame(kit?.frame ? 'saved' : 'brand')
    setError(null)
  }, [kit, open])

  const set = <Key extends keyof Draft>(key: Key, value: Draft[Key]) =>
    setDraft((current) => ({ ...current, [key]: value }))

  async function addLogos(files: FileList | null) {
    if (!files?.length) return
    setUploading(true)
    setError(null)
    try {
      const added: BrandLogo[] = []
      for (const file of Array.from(files)) {
        if (!LOGO_TYPES.includes(file.type))
          throw new Error(`${file.name} is not a PNG, JPEG, or WebP image.`)
        if (file.size > LOGO_MAX_BYTES) throw new Error(`${file.name} is larger than 5 MB.`)
        const local = URL.createObjectURL(file)
        try {
          added.push({
            id: crypto.randomUUID().slice(0, 12),
            name: file.name.replace(/\.[^.]+$/, '').slice(0, 100) || 'Logo',
            src: await uploadSource(trpcClient, local),
            tone: 'any',
          })
        } finally {
          URL.revokeObjectURL(local)
        }
      }
      setDraft((current) => ({ ...current, logos: [...current.logos, ...added].slice(0, 6) }))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The logo could not be uploaded.')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function designBackground(): Promise<DesignDocument['background']> {
    const value = exportDesignDocument({ keepLocalSources: true }).background
    if (
      value?.type === 'image' &&
      !value.value.startsWith('asset:') &&
      /^(blob|data):/.test(value.value)
    ) {
      return { ...value, value: await uploadSource(trpcClient, value.value) }
    }
    return value
  }

  function designFrame(): BrandFrame {
    const document = exportDesignDocument({ keepLocalSources: true })
    const { chrome, frame } = document.image
    // The frame's look, not this design's content: no address, tabs,
    // bookmarks, or titles, and no tone sampled from this screenshot.
    return {
      browserHeaderSize: document.image.browserHeaderSize,
      chrome: chrome && {
        ...chrome,
        activeTab: 0,
        address: '',
        bookmarks: [],
        tabs: [],
        title: '',
        tone: undefined,
      },
      frame: frame && { ...frame, title: undefined },
      mode: document.mode,
      radius: document.image.radius,
      shadow: document.image.shadow,
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const name = draft.name.trim()
    if (!name) {
      setError('Enter a name.')
      document.getElementById(nameId)?.focus()
      return
    }
    setPending(true)
    setError(null)
    try {
      const input: BrandKitDraft = {
        background:
          background === 'saved'
            ? kit?.background
            : background === 'design'
              ? await designBackground()
              : undefined,
        colors: {
          accent: draft.accent,
          background: draft.background,
          foreground: draft.foreground,
          palette: draft.palette,
          secondary: draft.secondary,
        },
        fonts: { primary: draft.primaryFont, secondary: draft.secondaryFont ?? undefined },
        frame: frame === 'saved' ? kit?.frame : frame === 'design' ? designFrame() : undefined,
        logos: draft.logos,
      }
      await saveBrandKit(trpcClient, name, input, kit)
      onSaved(name)
      onOpenChange(false)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The brand kit could not be saved.')
    } finally {
      setPending(false)
    }
  }

  const savedBackground = kit?.background ? backgroundCss(kit.background) : undefined

  return (
    <Dialog onOpenChange={pending ? undefined : onOpenChange} open={open}>
      <DialogContent className="max-h-[90vh] overflow-y-auto bg-background sm:max-w-[520px]">
        <form className="grid gap-5" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{kit ? `Edit ${kit.name}` : 'New brand kit'}</DialogTitle>
            <DialogDescription>
              Saving adds a new version. Designs keep their own values until you apply the kit to
              them.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor={nameId}>Name</Label>
            <Input
              autoFocus
              id={nameId}
              maxLength={100}
              aria-invalid={error === 'Enter a name.'}
              aria-describedby={error === 'Enter a name.' ? `${nameId}-error` : undefined}
              onChange={(event) => { set('name', event.target.value); if (error === 'Enter a name.') setError(null) }}
              value={draft.name}
            />
            {error === 'Enter a name.' ? <p id={`${nameId}-error`} role="alert" className="text-xs text-destructive">{error}</p> : null}
          </div>

          <fieldset className="grid gap-2">
            <legend className="mb-1 text-ui-lg font-medium">Colours</legend>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2">
              <ColorField
                label="Background"
                onChange={(value) => set('background', value)}
                value={draft.background}
              />
              <ColorField
                label="Text"
                onChange={(value) => set('foreground', value)}
                value={draft.foreground}
              />
              <ColorField
                label="Accent"
                onChange={(value) => set('accent', value)}
                value={draft.accent}
              />
              <ColorField
                label="Secondary"
                onChange={(value) => set('secondary', value)}
                value={draft.secondary}
              />
            </div>
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <span className="mr-1 text-xs text-muted-foreground">Palette</span>
              {draft.palette.map((color, index) => (
                <Button variant="custom" size={null}
                  aria-label={`Remove ${color} from the palette`}
                  className="size-6 rounded-full border border-foreground/15"
                  key={`${color}-${index}`}
                  onClick={() =>
                    set(
                      'palette',
                      draft.palette.filter((_, other) => other !== index)
                    )
                  }
                  style={{ background: color }}
                  title={`${color} (click to remove)`}
                  type="button"
                />
              ))}
              {draft.palette.length < 12 ? (
                <Button
                  onClick={() => set('palette', [...draft.palette, draft.accent])}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <PlusSignIcon size={12} /> Add accent
                </Button>
              ) : null}
            </div>
          </fieldset>

          <fieldset className="grid gap-2">
            <legend className="mb-1 text-ui-lg font-medium">Fonts</legend>
            <div className="grid gap-1.5">
              <span className="text-xs text-muted-foreground">Headlines</span>
              <FontPicker
                onChange={(value) => set('primaryFont', value)}
                value={draft.primaryFont}
              />
            </div>
            <div className="grid gap-1.5">
              <span className="text-xs text-muted-foreground">
                Everything else
                {draft.secondaryFont ? '' : ` (same as headlines: ${fontName(draft.primaryFont)})`}
              </span>
              <FontPicker
                onChange={(value) =>
                  set('secondaryFont', value === draft.primaryFont ? null : value)
                }
                value={draft.secondaryFont ?? draft.primaryFont}
              />
            </div>
          </fieldset>

          <fieldset className="grid gap-2">
            <legend className="mb-1 text-ui-lg font-medium">Logos</legend>
            {draft.logos.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Add a light and a dark logo; designs pick the one that reads on their background.
              </p>
            ) : (
              <ul className="grid gap-2">
                {draft.logos.map((logo, index) => (
                  <li className="grid grid-cols-[auto_1fr_auto] items-center gap-2" key={logo.id}>
                    <LogoThumb src={logo.src} />
                    <div className="grid gap-1">
                      <Input
                        aria-label="Logo name"
                        className="h-8"
                        maxLength={100}
                        onChange={(event) =>
                          set(
                            'logos',
                            draft.logos.map((other, position) =>
                              position === index ? { ...other, name: event.target.value } : other
                            )
                          )
                        }
                        value={logo.name}
                      />
                      <ChoiceField
                        label="Use on"
                        onChange={(tone) =>
                          set(
                            'logos',
                            draft.logos.map((other, position) =>
                              position === index ? { ...other, tone } : other
                            )
                          )
                        }
                        options={TONES}
                        value={logo.tone}
                      />
                    </div>
                    <Button
                      aria-label={`Remove ${logo.name}`}
                      onClick={() =>
                        set(
                          'logos',
                          draft.logos.filter((_, position) => position !== index)
                        )
                      }
                      size="icon"
                      type="button"
                      variant="ghost"
                    >
                      <Delete02Icon size={14} />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <Input
              accept={LOGO_TYPES.join(',')}
              aria-label="Logo files"
              className="hidden"
              multiple
              onChange={(event) => void addLogos(event.target.files)}
              ref={fileRef}
              type="file"
            />
            {draft.logos.length < 6 ? (
              <Button
                disabled={uploading}
                onClick={() => fileRef.current?.click()}
                size="sm"
                type="button"
                variant="outline"
              >
                {uploading ? 'Uploading…' : 'Add logo'}
              </Button>
            ) : null}
          </fieldset>

          <fieldset className="grid gap-2">
            <legend className="mb-1 text-ui-lg font-medium">Defaults for designs</legend>
            <ChoiceField
              label="Background"
              onChange={setBackground}
              options={[
                { label: 'Brand gradient', value: 'brand' },
                ...(kit?.background ? [{ label: 'Saved', value: 'saved' as const }] : []),
                { label: 'This design’s', value: 'design' },
              ]}
              value={background}
            />
            {background === 'saved' && savedBackground ? (
              <div
                aria-hidden
                className="h-6 rounded border border-foreground/10"
                style={{ background: savedBackground }}
              />
            ) : null}
            <ChoiceField
              label="Frame"
              onChange={setFrame}
              options={[
                { label: 'None', value: 'brand' },
                ...(kit?.frame ? [{ label: 'Saved', value: 'saved' as const }] : []),
                { label: 'This design’s', value: 'design' },
              ]}
              value={frame}
            />
          </fieldset>

          {error && error !== 'Enter a name.' ? (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter className="sticky -bottom-6 border-t bg-background py-4">
            <Button
              disabled={pending}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button disabled={pending || uploading} type="submit">
              {pending ? 'Saving…' : kit ? 'Save new version' : 'Create brand kit'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
