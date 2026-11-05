'use client'

import * as React from 'react'
import { MagicWandIcon } from '@phosphor-icons/react/dist/ssr/MagicWand'
import { PlusIcon } from '@phosphor-icons/react/dist/ssr/Plus'
import { TrashIcon } from '@phosphor-icons/react/dist/ssr/Trash'
import { BackgroundPicker } from '@/components/code-image/BackgroundPicker'
import { CODE_THEMES, FONTS, PADDING_OPTIONS } from '@/components/code-image/code-themes'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SegmentedControl } from '@/components/ui/segmented-control'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import type { BrandKit } from '@/lib/brand/kit'
import { BRAND_THEME_ID, brandCodeTheme, resolveCodeTheme } from '@/lib/code-studio/brand-theme'
import {
  activeFile,
  CODE_ASPECT_LABELS,
  CODE_ASPECTS,
  type CodeDocument,
  type CodeFile,
  type CodeStyle,
  type LineRange,
} from '@/lib/code-studio/document'
import {
  addAnnotation,
  addFile,
  removeFile,
  setLayout,
  toggleMark,
  updateFile,
} from '@/lib/code-studio/edit'
import { CODE_LANGUAGES, detectLanguage, languageForFileName } from '@/lib/code-studio/languages'
import { compileTape, EXAMPLE_TAPE } from '@/lib/code-studio/tape'
import { FRAME_WIDTH_MAX, FRAME_WIDTH_MIN } from '@/components/code-image/code-themes'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 border-b px-4 py-4 last:border-b-0">
      <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h2>
      {children}
    </section>
  )
}

function Row({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor={htmlFor} className="text-sm font-normal">
        {label}
      </Label>
      {children}
    </div>
  )
}

/** Props of {@link CodeInspector}. */
export type CodeInspectorProps = {
  document: CodeDocument
  slideIndex: number
  paneId: string
  selection: { paneId: string; fileId: string; range: LineRange } | null
  brandKits: BrandKit[]
  disabled: boolean
  onChange: (document: CodeDocument) => void
  onPane: (paneId: string) => void
}

/** The studio's controls: the code, its emphasis, the look and the footer. */
export function CodeInspector({
  document,
  slideIndex,
  paneId,
  selection,
  brandKits,
  disabled,
  onChange,
  onPane,
}: CodeInspectorProps) {
  const id = React.useId()
  const style = document.style
  const slide = document.slides[slideIndex]!
  const pane = slide.panes.find((item) => item.id === paneId) ?? slide.panes[0]!
  const file = activeFile(pane)
  const ref = { slide: slideIndex, pane: pane.id, file: file.id }
  const setFile = (patch: Partial<Omit<CodeFile, 'id'>>) =>
    onChange(updateFile(document, ref, patch))
  const setStyle = (patch: Partial<CodeStyle>) =>
    onChange({ ...document, style: { ...style, ...patch } })
  const theme = resolveCodeTheme(style)
  const themeValue =
    style.theme === BRAND_THEME_ID && style.brandTheme
      ? `brand:${style.brandTheme.kitId}`
      : style.theme
  const savedBrandMissing =
    style.brandTheme && !brandKits.some((kit) => kit.id === style.brandTheme!.kitId)
  const [detecting, setDetecting] = React.useState(false)
  const tape = file.tape !== undefined ? compileTape(file.tape) : null
  const range = selection && selection.fileId === file.id ? selection.range : null
  const brandLogo = brandKits
    .find((kit) => kit.id === style.brandTheme?.kitId)
    ?.logos.find((logo) => logo.src.startsWith('asset:'))

  return (
    <div className="text-sm" aria-disabled={disabled}>
      <Section title="Code">
        {slide.panes.length > 1 ? (
          <SegmentedControl
            ariaLabel="Pane"
            size="sm"
            value={pane.id}
            onChange={onPane}
            options={slide.panes.map((item, index) => ({
              id: item.id,
              label: index === 0 ? 'Left' : 'Right',
            }))}
          />
        ) : null}
        <div className="grid grid-cols-[1fr_auto] items-end gap-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-name`}>File name</Label>
            <Input
              id={`${id}-name`}
              value={file.name}
              placeholder="untitled"
              maxLength={120}
              disabled={disabled}
              onChange={(event) => {
                const name = event.target.value
                const lang = languageForFileName(name)
                setFile(lang ? { name, lang } : { name })
              }}
            />
          </div>
          <Button
            variant="outline"
            size="icon"
            aria-label="Add a file tab"
            disabled={disabled || pane.files.length >= 10}
            onClick={() => onChange(addFile(document, slideIndex, pane.id, { lang: file.lang }))}
          >
            <PlusIcon />
          </Button>
        </div>
        {pane.files.length > 1 ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            disabled={disabled}
            onClick={() => onChange(removeFile(document, ref))}
          >
            <TrashIcon /> Remove this tab
          </Button>
        ) : null}
        <div className="grid grid-cols-[1fr_auto] items-end gap-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-lang`}>Language</Label>
            <Select
              value={file.lang}
              onValueChange={(lang) => setFile({ lang: lang as CodeFile['lang'] })}
              disabled={disabled}
            >
              <SelectTrigger id={`${id}-lang`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CODE_LANGUAGES.map((language) => (
                  <SelectItem key={language.id} value={language.id}>
                    {language.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="outline"
            size="icon"
            aria-label="Detect the language"
            disabled={disabled || detecting}
            onClick={async () => {
              setDetecting(true)
              try {
                const lang = await detectLanguage(file.code)
                if (lang) setFile({ lang })
              } finally {
                setDetecting(false)
              }
            }}
          >
            <MagicWandIcon />
          </Button>
        </div>
        <Row label="Side-by-side panes" htmlFor={`${id}-split`}>
          <Switch
            id={`${id}-split`}
            checked={slide.layout === 'split'}
            disabled={disabled}
            onCheckedChange={(on) =>
              onChange(setLayout(document, slideIndex, on ? 'split' : 'single'))
            }
          />
        </Row>
        <Row label="Show as a diff" htmlFor={`${id}-diff`}>
          <Switch
            id={`${id}-diff`}
            checked={file.base !== undefined}
            disabled={disabled || file.tape !== undefined}
            onCheckedChange={(on) =>
              setFile(
                on ? { base: file.code, diff: 'unified' } : { base: undefined, diff: undefined }
              )
            }
          />
        </Row>
        {file.base !== undefined ? (
          <>
            <SegmentedControl
              ariaLabel="Diff view"
              size="sm"
              value={file.diff ?? 'unified'}
              onChange={(diff) => setFile({ diff: diff as CodeFile['diff'] })}
              options={[
                { id: 'unified', label: 'Unified' },
                { id: 'split', label: 'Side by side' },
              ]}
            />
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-before`}>Before</Label>
              <Textarea
                id={`${id}-before`}
                value={file.base}
                disabled={disabled}
                spellCheck={false}
                className="max-h-48 font-mono text-xs"
                onChange={(event) => setFile({ base: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-after`}>After</Label>
              <Textarea
                id={`${id}-after`}
                value={file.code}
                disabled={disabled}
                spellCheck={false}
                className="max-h-48 font-mono text-xs"
                onChange={(event) => setFile({ code: event.target.value })}
              />
            </div>
          </>
        ) : null}
        <Row label="Terminal script" htmlFor={`${id}-tape`}>
          <Switch
            id={`${id}-tape`}
            checked={file.tape !== undefined}
            disabled={disabled || file.base !== undefined}
            onCheckedChange={(on) => setFile({ tape: on ? EXAMPLE_TAPE : undefined })}
          />
        </Row>
        {file.tape !== undefined ? (
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-script`}>Script</Label>
            <Textarea
              id={`${id}-script`}
              value={file.tape}
              disabled={disabled}
              spellCheck={false}
              className="max-h-64 font-mono text-xs"
              onChange={(event) => setFile({ tape: event.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              Uses VHS commands (Type, Enter, Sleep, Backspace, Ctrl+L, Hide, Show, Set
              TypingSpeed). Print &quot;…&quot; shows output. Nothing is run.
            </p>
            {tape?.warnings.map((warning) => (
              <p key={warning} role="status" className="text-xs text-amber-600 dark:text-amber-400">
                {warning}
              </p>
            ))}
          </div>
        ) : null}
      </Section>

      {file.tape === undefined && file.base === undefined ? (
        <Section title="Emphasis">
          <p className="text-xs text-muted-foreground">
            {range
              ? `Lines ${range[0]}${range[1] > range[0] ? `–${range[1]}` : ''} selected.`
              : 'Click a line number, then Shift-click another, to select lines.'}
          </p>
          <div className="grid grid-cols-3 gap-2">
            {(['highlight', 'focus', 'blur'] as const).map((kind) => (
              <Button
                key={kind}
                variant="outline"
                size="sm"
                disabled={disabled || !range}
                onClick={() => setFile({ marks: toggleMark(file.marks, kind, range!) })}
              >
                {kind === 'highlight' ? 'Highlight' : kind === 'focus' ? 'Focus' : 'Blur'}
              </Button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(['marker', 'callout'] as const).map((kind) => (
              <Button
                key={kind}
                variant="outline"
                size="sm"
                disabled={disabled || !range}
                onClick={() =>
                  setFile({ annotations: addAnnotation(file.annotations, kind, range![0]) })
                }
              >
                {kind === 'marker' ? 'Add marker' : 'Add callout'}
              </Button>
            ))}
          </div>
          {file.marks &&
          (file.marks.highlight.length || file.marks.focus.length || file.marks.blur.length) ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              disabled={disabled}
              onClick={() => setFile({ marks: undefined })}
            >
              Clear emphasis
            </Button>
          ) : null}
          {(file.annotations ?? []).map((note) => (
            <div key={note.id} className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
              <span className="text-xs text-muted-foreground tabular-nums">L{note.line}</span>
              <Input
                aria-label={`${note.kind === 'marker' ? 'Marker' : 'Callout'} text for line ${note.line}`}
                value={note.text}
                maxLength={280}
                placeholder={note.kind === 'marker' ? 'Optional label' : 'Callout text'}
                disabled={disabled}
                onChange={(event) =>
                  setFile({
                    annotations: file.annotations!.map((item) =>
                      item.id === note.id ? { ...item, text: event.target.value } : item
                    ),
                  })
                }
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label="Remove annotation"
                disabled={disabled}
                onClick={() =>
                  setFile({
                    annotations: file.annotations!.filter((item) => item.id !== note.id),
                  })
                }
              >
                <TrashIcon />
              </Button>
            </div>
          ))}
        </Section>
      ) : null}

      <Section title="Look">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-theme`}>Theme</Label>
          <Select
            value={themeValue}
            disabled={disabled}
            onValueChange={(value) => {
              if (!value.startsWith('brand:')) return setStyle({ theme: value })
              const kit = brandKits.find((item) => `brand:${item.id}` === value)
              if (kit) setStyle({ theme: BRAND_THEME_ID, brandTheme: brandCodeTheme(kit) })
              else if (style.brandTheme) setStyle({ theme: BRAND_THEME_ID })
            }}
          >
            <SelectTrigger id={`${id}-theme`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {brandKits.length || savedBrandMissing ? (
                <SelectGroup>
                  <SelectLabel>Brand</SelectLabel>
                  {brandKits.map((kit) => (
                    <SelectItem key={kit.id} value={`brand:${kit.id}`}>
                      <span className="size-3 rounded-full" style={{ background: kit.accent }} />
                      {kit.name}
                    </SelectItem>
                  ))}
                  {savedBrandMissing ? (
                    <SelectItem value={`brand:${style.brandTheme!.kitId}`}>
                      <span
                        className="size-3 rounded-full"
                        style={{ background: style.brandTheme!.accent }}
                      />
                      {style.brandTheme!.name} (saved)
                    </SelectItem>
                  ) : null}
                </SelectGroup>
              ) : null}
              <SelectGroup>
                <SelectLabel>Themes</SelectLabel>
                {CODE_THEMES.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    <span className="size-3 rounded-full" style={{ background: item.swatch }} />
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <Row label="Dark mode" htmlFor={`${id}-dark`}>
          <Switch
            id={`${id}-dark`}
            checked={style.dark}
            disabled={disabled}
            onCheckedChange={(dark) => setStyle({ dark })}
          />
        </Row>
        <Row label="Background" htmlFor={`${id}-background`}>
          <div className="flex items-center gap-2">
            <BackgroundPicker
              theme={theme}
              dark={style.dark}
              background={style.background}
              onBackgroundChange={(background) => setStyle({ background })}
              disabled={disabled || !style.showBackground}
            />
            <Switch
              id={`${id}-background`}
              checked={style.showBackground}
              disabled={disabled}
              onCheckedChange={(showBackground) => setStyle({ showBackground })}
            />
          </div>
        </Row>
        <div className="space-y-1.5">
          <Label id={`${id}-frame`}>Frame</Label>
          <SegmentedControl
            ariaLabel="Frame"
            size="sm"
            value={style.frame}
            onChange={(frame) => setStyle({ frame: frame as CodeStyle['frame'] })}
            options={[
              { id: 'mac', label: 'Editor' },
              { id: 'terminal', label: 'Terminal' },
              { id: 'card', label: 'Card' },
              { id: 'none', label: 'None' },
            ]}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-title`}>Window title</Label>
          <Input
            id={`${id}-title`}
            value={style.title}
            maxLength={60}
            placeholder={file.name || 'untitled'}
            disabled={disabled}
            onChange={(event) => setStyle({ title: event.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-font`}>Font</Label>
          <Select
            value={style.font}
            onValueChange={(font) => setStyle({ font })}
            disabled={disabled}
          >
            <SelectTrigger id={`${id}-font`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FONTS.map((font) => (
                <SelectItem key={font.id} value={font.id}>
                  {font.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Row label="Line numbers" htmlFor={`${id}-numbers`}>
          <Switch
            id={`${id}-numbers`}
            checked={style.lineNumbers}
            disabled={disabled}
            onCheckedChange={(lineNumbers) => setStyle({ lineNumbers })}
          />
        </Row>
        <div className="space-y-1.5">
          <Label>Padding</Label>
          <SegmentedControl
            ariaLabel="Padding"
            size="sm"
            value={String(style.padding)}
            onChange={(padding) => setStyle({ padding: Number(padding) })}
            options={PADDING_OPTIONS.map((value) => ({ id: String(value), label: String(value) }))}
          />
        </div>
        <Slider
          label="Width"
          min={FRAME_WIDTH_MIN}
          max={FRAME_WIDTH_MAX}
          step={10}
          value={[style.width]}
          valueDisplay={`${style.width}px`}
          disabled={disabled}
          onValueChange={([width]) => setStyle({ width: width! })}
        />
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-aspect`}>Size</Label>
          <Select
            value={style.aspect}
            disabled={disabled}
            onValueChange={(aspect) => setStyle({ aspect: aspect as CodeStyle['aspect'] })}
          >
            <SelectTrigger id={`${id}-aspect`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CODE_ASPECTS.map((aspect) => (
                <SelectItem key={aspect} value={aspect}>
                  {CODE_ASPECT_LABELS[aspect]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </Section>

      <Section title="Footer">
        <Row label="Show a footer" htmlFor={`${id}-footer`}>
          <Switch
            id={`${id}-footer`}
            checked={style.footer.show}
            disabled={disabled}
            onCheckedChange={(show) => setStyle({ footer: { ...style.footer, show } })}
          />
        </Row>
        {style.footer.show ? (
          <>
            <Input
              aria-label="Name"
              placeholder="Name"
              value={style.footer.name}
              maxLength={80}
              disabled={disabled}
              onChange={(event) =>
                setStyle({ footer: { ...style.footer, name: event.target.value } })
              }
            />
            <Input
              aria-label="Handle"
              placeholder="@handle"
              value={style.footer.handle}
              maxLength={80}
              disabled={disabled}
              onChange={(event) =>
                setStyle({ footer: { ...style.footer, handle: event.target.value } })
              }
            />
            <Row label="Brand logo" htmlFor={`${id}-logo`}>
              <Switch
                id={`${id}-logo`}
                checked={!!style.footer.logo}
                disabled={disabled || (!brandLogo && !style.footer.logo)}
                onCheckedChange={(on) =>
                  setStyle({
                    footer: {
                      ...style.footer,
                      logo: on ? (brandLogo?.src as CodeStyle['footer']['logo']) : undefined,
                    },
                  })
                }
              />
            </Row>
            {!brandLogo && !style.footer.logo ? (
              <p className="text-xs text-muted-foreground">
                Choose a brand theme whose kit has an uploaded logo to add it.
              </p>
            ) : null}
          </>
        ) : null}
      </Section>
    </div>
  )
}
