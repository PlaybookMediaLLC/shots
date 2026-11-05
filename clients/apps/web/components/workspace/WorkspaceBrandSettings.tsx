'use client'

import { type FormEvent, useEffect, useState } from 'react'
import { WritingInheritance } from '@/components/settings/WritingInheritance'
import { SettingsSaveBar } from '@/components/settings/SettingsSaveBar'
import { useUnsavedSettings } from '@/components/settings/useUnsavedSettings'
import { HandleRows, StyleChips, type HandleRow } from '@/components/settings/BrandVoiceFields'
import { Group, Pill, Row, Section } from '@/components/platform-ui'
import { Button } from '@/components/ui/button'
import { SwatchColorPicker } from '@/components/ui/color-picker'
import { FileDropZone } from '@/components/ui/file-drop-zone'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { fontFamilies } from '@/lib/constants/fonts'
import {
  contrastRatio,
  type ProhibitedTermEntry,
  prohibitedTermEntries,
  prohibitedTermsForSave,
} from '@/lib/launch/brand'
import {
  brandKitDefinitionSchema,
  BRAND_LOGO_MAX_BYTES,
  brandLogoContentTypeSchema,
  prohibitedTermMatchModeSchema,
  type ProhibitedTermMatchMode,
} from '@/lib/tenant/schemas'
import { useTRPCClient } from '@/lib/trpc/react'
import { saveExportToWorkspace } from '@/lib/workspace/save-export'
import { getErrorMessage } from './settings-client'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'

type BrandKitSummary = {
  id: string
  name: string
  status: string
  version: number
  definition: unknown
}

/** The stored BrandProfile; the list and handle fields are JSON columns. */
type BrandProfile = {
  audience: string
  ctaConventions: string | null
  preferredStyles: unknown
  productDescription: string
  prohibitedTerms: unknown
  socialHandles: unknown
  tagline: string | null
  tone: string
}

type WorkspaceBrandSettingsProps = { canManage: boolean }

type BrandColors = { accent: string; background: string; text: string }

const DEFAULT_COLORS: BrandColors = { accent: '#6d5dfc', background: '#ffffff', text: '#111111' }
const HEX_COLOR = /^#[0-9a-f]{6}$/i
/** WCAG AA contrast for body text. */
const MIN_TEXT_CONTRAST = 4.5

export function WorkspaceBrandSettings({ canManage }: WorkspaceBrandSettingsProps) {
  const trpcClient = useTRPCClient()
  const [brandKits, setBrandKits] = useState<BrandKitSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [colors, setColors] = useState(DEFAULT_COLORS)
  const [voice, setVoice] = useState(() => voiceDraft())
  const [name, setName] = useState('')
  const [font, setFont] = useState('inter')
  const [savedVisual, setSavedVisual] = useState('')
  const [notice, setNotice] = useState('')
  const [baseDefinition, setBaseDefinition] = useState<ReturnType<
    typeof brandKitDefinitionSchema.parse
  > | null>(null)
  const [published, setPublished] = useState(false)
  const [previewColors, setPreviewColors] = useState(DEFAULT_COLORS)
  const [sample, setSample] = useState<{ voice: string; text: string } | null>(null)
  const [sampling, setSampling] = useState(false)
  const [sampleError, setSampleError] = useState('')
  const [logo, setLogo] = useState<{ assetId: string; previewUrl: string } | null>(null)
  const [isUploadingLogo, setIsUploadingLogo] = useState(false)
  const generatedSample = sample?.voice === JSON.stringify(voice) ? sample.text : null
  const visual = JSON.stringify({ colors, name, font, logo: logo?.assetId })
  const visualDirty = savedVisual
    ? visual !== savedVisual
    : Boolean(
        name ||
        logo ||
        font !== 'inter' ||
        JSON.stringify(colors) !== JSON.stringify(DEFAULT_COLORS)
      )
  useUnsavedSettings(visualDirty)
  const colorsValid = Object.values(colors).every((color) => HEX_COLOR.test(color))
  const contrast =
    HEX_COLOR.test(colors.text) && HEX_COLOR.test(colors.background)
      ? contrastRatio(colors.text, colors.background)
      : null

  useEffect(() => () => (logo ? URL.revokeObjectURL(logo.previewUrl) : undefined), [logo])

  useEffect(() => {
    trpcClient.brandKit.list
      .query()
      .then((result) => setBrandKits(result.brandKits))
      .catch((requestError) => setError(getErrorMessage(requestError)))
  }, [trpcClient])

  async function handleLogoFile(file: File): Promise<void> {
    setError(null)
    if (!brandLogoContentTypeSchema.safeParse(file.type).success) {
      setError('Upload the logo as a PNG, WebP, or JPEG.')
      return
    }
    if (file.size > BRAND_LOGO_MAX_BYTES) {
      setError('The logo must be 5 MB or smaller.')
      return
    }
    setIsUploadingLogo(true)
    try {
      const { assetId } = await saveExportToWorkspace({
        blob: file,
        fileName: file.name.slice(-128),
        trpcClient,
      })
      setLogo({ assetId, previewUrl: URL.createObjectURL(file) })
    } catch (uploadError) {
      setError(getErrorMessage(uploadError))
    } finally {
      setIsUploadingLogo(false)
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (isSaving || isUploadingLogo || !name.trim()) return
    setError(null)
    if (!colorsValid) {
      setError('Correct the highlighted colors before publishing.')
      return
    }
    const publish =
      (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'publish'
    setIsSaving(true)
    try {
      await trpcClient.brandKit.create.mutate({
        definition: {
          ...baseDefinition,
          colors,
          logo: logo ? { primaryAssetId: logo.assetId } : undefined,
          schemaVersion: 1,
          typography: { ...baseDefinition?.typography, headingFamily: font },
        },
        name,
        publish,
      })
      setSavedVisual(visual)
      setPublished(publish)
      setNotice(
        publish
          ? 'Visual brand kit published.'
          : 'Visual brand kit draft saved. It is not active until published.'
      )
      const result = await trpcClient.brandKit.list.query()
      setBrandKits(result.brandKits)
    } catch (requestError) {
      setError(getErrorMessage(requestError))
    } finally {
      setIsSaving(false)
    }
  }

  function resume(kit: BrandKitSummary) {
    if (visualDirty && !window.confirm('Discard unsaved visual changes and open this version?'))
      return
    const parsed = brandKitDefinitionSchema.safeParse(kit.definition)
    if (!parsed.success) {
      setError('This version cannot be opened in this form. Its saved definition has not changed.')
      return
    }
    const definition = parsed.data
    setBaseDefinition(definition)
    setColors(definition.colors)
    setPreviewColors(definition.colors)
    setName(kit.name)
    setFont(definition.typography.headingFamily)
    setLogo(definition.logo ? { assetId: definition.logo.primaryAssetId, previewUrl: '' } : null)
    setSavedVisual(
      JSON.stringify({
        colors: definition.colors,
        name: kit.name,
        font: definition.typography.headingFamily,
        logo: definition.logo?.primaryAssetId,
      })
    )
    setPublished(kit.status.toLowerCase() === 'active')
    setError(null)
    setNotice(`Opened ${kit.name} v${kit.version}. Saving or publishing creates a new version.`)
  }

  async function generateSample() {
    if (sampling) return
    setSampling(true)
    setSampleError('')
    const snapshot = JSON.stringify(voice)
    try {
      const result = await trpcClient.brandProfile.preview.mutate(voiceInput(voice))
      setSample({ voice: snapshot, text: result.texts[0] ?? '' })
    } catch (failure) {
      setSampleError(getErrorMessage(failure))
    } finally {
      setSampling(false)
    }
  }

  return (
    <div className="flex flex-col gap-10">
      <WritingInheritance />
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,1fr)_280px]">
        <section
          aria-label="Brand preview"
          className="grid gap-3 rounded-2xl border border-border p-5 xl:sticky xl:top-6 xl:order-last"
        >
          <p className="text-xs font-medium text-muted-foreground">
            Live sample · your copy and visual style
          </p>
          <div
            className="rounded-xl border p-6"
            style={{
              background: previewColors.background,
              color: previewColors.text,
              fontFamily: fontFamilies.find((item) => item.id === font)?.cssVariable
                ? `var(${fontFamilies.find((item) => item.id === font)?.cssVariable})`
                : fontFamilies.find((item) => item.id === font)?.fallback,
            }}
          >
            <div className="mb-4 h-1 w-12 rounded" style={{ background: previewColors.accent }} />
            <p className="text-xl font-semibold">{name || 'Your next announcement'}</p>
            <p className="mt-3 whitespace-pre-wrap text-sm">
              {generatedSample
                ? generatedSample
                : voice.productDescription ||
                  'Add your product description to preview a post here.'}
            </p>
            {!generatedSample ? (
              <p className="mt-3 text-sm font-medium">{voice.ctaConventions}</p>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            Audience: {voice.audience || 'Not set'} · Tone: {voice.tone || 'Not set'}
          </p>
          <p className="text-xs text-muted-foreground">
            {voice.styles.join(' · ')}
            {voice.terms.length
              ? ` · Avoid: ${voice.terms
                  .map((term) => term.term)
                  .filter(Boolean)
                  .join(', ')}`
              : ''}
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={
              sampling ||
              !voice.productDescription.trim() ||
              !voice.audience.trim() ||
              !voice.tone.trim()
            }
            onClick={() => void generateSample()}
          >
            {sampling ? 'Generating…' : 'Generate voice sample'}
          </Button>
          <p className="text-xs text-muted-foreground">
            Uses AI credits and the voice values above, including unsaved edits. Review generated
            copy before using it. Changing voice settings clears the generated preview.
          </p>
          {sampleError ? (
            <p role="alert" className="text-sm text-destructive">
              {sampleError}
            </p>
          ) : null}
        </section>
        <div className="flex min-w-0 flex-col gap-8">
          <BrandVoiceSection canManage={canManage} onPreview={setVoice} />
          <Section title="Saved visual brand kits">
            <Group>
              {brandKits.length === 0 ? (
                <Row>
                  <p className="text-sm text-muted-foreground">
                    No visual brand kits have been created.
                  </p>
                </Row>
              ) : (
                brandKits.map((brandKit) => (
                  <div
                    className="flex items-center justify-between gap-4 px-5 py-4"
                    key={brandKit.id}
                  >
                    <span className="min-w-0 truncate text-sm text-foreground">
                      {brandKit.name}
                    </span>
                    <Pill tone={brandKit.status.toLowerCase() === 'active' ? 'green' : 'gray'}>
                      v{brandKit.version} · {brandKit.status.toLowerCase()}
                    </Pill>
                    {canManage ? (
                      <Button
                        size="sm"
                        type="button"
                        variant="outline"
                        disabled={isSaving || isUploadingLogo}
                        onClick={() => resume(brandKit)}
                      >
                        {brandKit.status.toLowerCase() === 'draft'
                          ? 'Resume draft'
                          : 'Use as starting point'}
                      </Button>
                    ) : null}
                  </div>
                ))
              )}
            </Group>
          </Section>
          {canManage ? (
            <Section
              title="Visual brand kit"
              description="Save a draft to review it. Publish creates an active version for future work; existing approved content keeps its original version."
            >
              <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
                <fieldset disabled={isSaving || isUploadingLogo}>
                  <Group>
                    <Row label={<Label htmlFor="brand-name">Visual brand kit name</Label>}>
                      <Input
                        className="h-10 rounded-lg md:w-72"
                        id="brand-name"
                        name="name"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        maxLength={100}
                        required
                      />
                    </Row>
                    <Row description="Hex values, like #6d5dfc." label="Colors" layout="stacked">
                      <div className="grid w-full gap-3 sm:grid-cols-3">
                        {(['text', 'background', 'accent'] as const).map((key) => (
                          <ColorField
                            id={`brand-${key}`}
                            key={key}
                            label={key[0]!.toUpperCase() + key.slice(1)}
                            swatches={Object.values(colors).filter((color) => HEX_COLOR.test(color))}
                            onChange={(value) => {
                              setColors((current) => ({ ...current, [key]: value }))
                              if (HEX_COLOR.test(value))
                                setPreviewColors((current) => ({ ...current, [key]: value }))
                            }}
                            value={colors[key]}
                          />
                        ))}
                      </div>
                      {contrast !== null && contrast < MIN_TEXT_CONTRAST ? (
                        <p className="text-sm text-amber-700 dark:text-amber-400" role="status">
                          Text on background contrast is {contrast.toFixed(1)}:1. Body text needs at
                          least {MIN_TEXT_CONTRAST}:1 to stay readable.
                        </p>
                      ) : null}
                    </Row>
                    <Row label={<Label htmlFor="brand-font-family">Primary typeface</Label>}>
                      <Select value={font} onValueChange={setFont} name="headingFamily" required>
                        <SelectTrigger
                          className="h-10 rounded-lg bg-foreground/[0.03] px-3 text-sm text-foreground ring-1 ring-foreground/[0.08] outline-none md:w-72"
                          id="brand-font-family"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {fontFamilies.map((font) => (
                            <SelectItem key={font.id} value={font.id}>
                              {font.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Row>
                    <Row
                      description="PNG, WebP, or JPEG, up to 5 MB."
                      label={<Label htmlFor="brand-logo">Logo</Label>}
                    >
                      <FileDropZone
                        accept={Object.fromEntries(
                          brandLogoContentTypeSchema.options.map((type) => [type, []])
                        )}
                        busy={isUploadingLogo}
                        className="w-full md:w-96"
                        hint="PNG, WebP or JPEG, up to 5 MB."
                        id="brand-logo"
                        label="Logo"
                        maxSize={BRAND_LOGO_MAX_BYTES}
                        onFiles={([file]) => {
                          if (file) void handleLogoFile(file)
                        }}
                        onRemove={() => setLogo(null)}
                        preview={
                          logo?.previewUrl ? (
                            // A local object URL; next/image cannot optimize it.
                            <img
                              alt="Uploaded logo preview"
                              className="h-10 w-10 rounded-lg bg-foreground/[0.03] object-contain ring-1 ring-foreground/[0.08]"
                              src={logo.previewUrl}
                            />
                          ) : logo ? (
                            <span className="text-xs text-muted-foreground">Saved logo retained</span>
                          ) : null
                        }
                      />
                    </Row>
                  </Group>
                </fieldset>
                {!name.trim() && visualDirty ? (
                  <p role="alert" className="text-sm text-destructive">
                    Enter a brand kit name before saving or publishing.
                  </p>
                ) : null}
                {notice ? (
                  <p role="status" className="text-sm">
                    {notice}
                  </p>
                ) : null}
                <div className="sticky bottom-4 z-10 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-background p-3 shadow-sm">
                  <p className="mr-auto text-sm" role="status">
                    {visualDirty ? 'Unsaved changes' : notice || 'Start with a name and colors'}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={isSaving || isUploadingLogo || !visualDirty}
                    onClick={() => {
                      const previous = savedVisual
                        ? JSON.parse(savedVisual)
                        : { name: '', font: 'inter', colors: DEFAULT_COLORS }
                      setName(previous.name)
                      setFont(previous.font)
                      setColors(previous.colors)
                      setPreviewColors(previous.colors)
                      if (logo?.assetId !== previous.logo)
                        setLogo(previous.logo ? { assetId: previous.logo, previewUrl: '' } : null)
                      setError(null)
                    }}
                  >
                    Discard
                  </Button>
                  <Button
                    type="submit"
                    value="draft"
                    variant="outline"
                    disabled={
                      isSaving || isUploadingLogo || !colorsValid || !name.trim() || !visualDirty
                    }
                  >
                    Save draft
                  </Button>
                  <Button
                    className="rounded-lg"
                    disabled={
                      isSaving ||
                      isUploadingLogo ||
                      !colorsValid ||
                      !name.trim() ||
                      (published && !visualDirty)
                    }
                    type="submit"
                    value="publish"
                  >
                    {isUploadingLogo
                      ? 'Uploading logo…'
                      : isSaving
                        ? 'Saving…'
                        : 'Publish visual brand kit'}
                  </Button>
                </div>
              </form>
            </Section>
          ) : null}
        </div>
      </div>
    </div>
  )
}

type VoiceDraft = {
  productDescription: string
  audience: string
  tone: string
  tagline: string
  ctaConventions: string
  styles: string[]
  handles: HandleRow[]
  terms: ProhibitedTermEntry[]
}
function voiceDraft(profile?: BrandProfile | null): VoiceDraft {
  return {
    productDescription: profile?.productDescription ?? '',
    audience: profile?.audience ?? '',
    tone: profile?.tone ?? '',
    tagline: profile?.tagline ?? '',
    ctaConventions: profile?.ctaConventions ?? '',
    styles: Array.isArray(profile?.preferredStyles)
      ? profile.preferredStyles.filter((item): item is string => typeof item === 'string')
      : [],
    handles:
      profile?.socialHandles && typeof profile.socialHandles === 'object'
        ? Object.entries(profile.socialHandles)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
            .map(([platform, handle]) => ({ platform, handle }))
        : [],
    terms: prohibitedTermEntries(profile?.prohibitedTerms),
  }
}

function voiceInput(draft: VoiceDraft) {
  return {
    productDescription: draft.productDescription,
    audience: draft.audience,
    tone: draft.tone,
    tagline: draft.tagline,
    ctaConventions: draft.ctaConventions,
    preferredStyles: draft.styles,
    socialHandles: Object.fromEntries(
      draft.handles.map((row) => [row.platform, row.handle.trim()])
    ),
    prohibitedTerms: prohibitedTermsForSave(draft.terms),
  }
}

function BrandVoiceSection({
  canManage,
  onPreview,
}: WorkspaceBrandSettingsProps & { onPreview: (voice: VoiceDraft) => void }) {
  const trpcClient = useTRPCClient()
  const [saved, setSaved] = useState<VoiceDraft | null>(null)
  const [draft, setDraft] = useState(() => voiceDraft())
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const dirty = saved !== null && JSON.stringify(draft) !== JSON.stringify(saved)
  useUnsavedSettings(dirty)
  useEffect(() => {
    if (!canManage) return
    trpcClient.brandProfile.get
      .query()
      .then((result) => {
        const next = voiceDraft(result.brandProfile)
        setSaved(next)
        setDraft(next)
        onPreview(next)
      })
      .catch((failure) => setError(getErrorMessage(failure)))
  }, [canManage, trpcClient, onPreview])
  const change = (patch: Partial<VoiceDraft>) => {
    const next = { ...draft, ...patch }
    setDraft(next)
    onPreview(next)
  }
  const invalidHandles =
    new Set(draft.handles.map((row) => row.platform)).size !== draft.handles.length ||
    draft.handles.some((row) => !row.handle.trim())
  const requiredMissing =
    !draft.productDescription.trim() || !draft.audience.trim() || !draft.tone.trim()
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!saved || isSaving || invalidHandles || requiredMissing) return
    setIsSaving(true)
    setError(null)
    try {
      await trpcClient.brandProfile.upsert.mutate(voiceInput(draft))
      setNotice('Brand voice saved.')
      setSaved(draft)
    } catch (failure) {
      setError(getErrorMessage(failure))
    } finally {
      setIsSaving(false)
    }
  }
  return (
    <Section
      title="Brand voice"
      description="Workspace defaults for writing. Profile instructions can refine these; prohibited terms always apply. Voice changes save separately from visual brand kits."
    >
      <form className="grid gap-4" onSubmit={handleSubmit}>
        <fieldset disabled={!canManage || saved === null || isSaving} className="grid gap-4">
          <Group>
            {(
              [
                ['productDescription', 'Product description', 2000],
                ['audience', 'Audience', 1000],
                ['tone', 'Tone', 500],
                ['tagline', 'Tagline', 200],
                ['ctaConventions', 'Call-to-action conventions', 1000],
              ] as const
            ).map(([key, label, limit]) => (
              <Row
                key={key}
                label={<Label htmlFor={`brand-voice-${key}`}>{label}</Label>}
                layout="stacked"
              >
                <Textarea
                  id={`brand-voice-${key}`}
                  value={draft[key]}
                  maxLength={limit}
                  required={['productDescription', 'audience', 'tone'].includes(key)}
                  onChange={(event) => change({ [key]: event.target.value })}
                />
              </Row>
            ))}
            <Row
              label="Never use"
              description="These rules apply to all writing, including profile overrides."
              layout="stacked"
            >
              <ProhibitedTermsEditor value={draft.terms} onChange={(terms) => change({ terms })} />
            </Row>
            <Row label="Preferred styles" layout="stacked">
              <StyleChips value={draft.styles} onChange={(styles) => change({ styles })} />
            </Row>
            <Row label="Social handles" layout="stacked">
              <HandleRows value={draft.handles} onChange={(handles) => change({ handles })} />
              {invalidHandles ? (
                <p role="alert" className="text-sm text-destructive">
                  Enter a handle for each row and use each platform only once.
                </p>
              ) : null}
            </Row>
          </Group>
        </fieldset>
        {notice && !dirty ? (
          <p role="status" className="text-sm">
            {notice}
          </p>
        ) : null}
        {requiredMissing && dirty ? (
          <p className="text-sm text-destructive" role="alert">
            Product description, audience, and tone are required.
          </p>
        ) : null}
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {canManage ? (
          <SettingsSaveBar
            dirty={dirty}
            busy={isSaving}
            disabled={saved === null || invalidHandles || requiredMissing}
            label="Save brand voice"
            onDiscard={() => {
              if (saved) {
                setDraft(saved)
                onPreview(saved)
              }
              setError(null)
            }}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Ask an administrator to update the brand voice.
          </p>
        )}
      </form>
    </Section>
  )
}

const MATCH_MODES: Record<ProhibitedTermMatchMode, string> = {
  phrase: 'Anywhere, even inside a word',
  word: 'As a whole word',
}

/** One row per prohibited term: the term, why it is off brand, and how it matches. */
function ProhibitedTermsEditor({
  onChange,
  value,
}: {
  onChange: (terms: ProhibitedTermEntry[]) => void
  value: ProhibitedTermEntry[]
}) {
  const update = (index: number, change: Partial<ProhibitedTermEntry>) =>
    onChange(value.map((entry, at) => (at === index ? { ...entry, ...change } : entry)))
  return (
    <div className="flex w-full flex-col gap-3">
      {value.length === 0 ? (
        <p className="text-sm text-muted-foreground">No prohibited terms.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {value.map((entry, index) => (
            // Rows have no identity of their own; editing never reorders them.
            <li className="grid gap-2 md:grid-cols-[1fr_1.5fr_auto_auto]" key={index}>
              <Input
                aria-label={`Term ${index + 1}`}
                className="h-10 rounded-lg"
                maxLength={100}
                onChange={(event) => update(index, { term: event.target.value })}
                placeholder="guaranteed"
                value={entry.term}
              />
              <Input
                aria-label={`Reason for term ${index + 1}`}
                className="h-10 rounded-lg"
                maxLength={300}
                onChange={(event) => update(index, { reason: event.target.value })}
                placeholder="Why it is off brand (optional)"
                value={entry.reason}
              />
              <Select
                onValueChange={(nextValue) =>
                  update(index, {
                    matchMode: prohibitedTermMatchModeSchema.parse(nextValue),
                  })
                }
                value={entry.matchMode}
              >
                <SelectTrigger
                  aria-label={`How term ${index + 1} matches`}
                  className="h-10 rounded-lg bg-foreground/[0.03] px-3 text-sm text-foreground ring-1 ring-foreground/[0.08] outline-none"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {prohibitedTermMatchModeSchema.options.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {MATCH_MODES[mode]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                aria-label={`Remove term ${index + 1}`}
                className="h-10 rounded-lg"
                onClick={() => onChange(value.filter((_, at) => at !== index))}
                type="button"
                variant="ghost"
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Button
        className="self-start rounded-lg"
        onClick={() => onChange([...value, { matchMode: 'word', reason: '', term: '' }])}
        size="sm"
        type="button"
        variant="outline"
      >
        Add term
      </Button>
    </div>
  )
}

function ColorField({
  id,
  label,
  onChange,
  swatches,
  value,
}: {
  id: string
  label: string
  onChange: (value: string) => void
  /** The kit's other colors, one click away. */
  swatches: string[]
  value: string
}) {
  const isValid = HEX_COLOR.test(value)
  const [lastValid, setLastValid] = useState(value)
  if (isValid && value !== lastValid) setLastValid(value)
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs font-medium text-foreground/65" htmlFor={id}>
        {label}
      </Label>
      <div className="flex items-center gap-2">
        <SwatchColorPicker
          aria-label={`${label} color picker`}
          className="h-10 w-10 shrink-0"
          onChange={onChange}
          swatchOnly
          swatches={swatches}
          value={(isValid ? value : lastValid).toLowerCase()}
        />
        <Input
          aria-describedby={!isValid ? `${id}-error` : undefined}
          aria-invalid={!isValid}
          className="h-10 rounded-lg font-mono"
          id={id}
          onChange={(event) => onChange(event.target.value)}
          pattern="#[0-9A-Fa-f]{6}"
          required
          title="A hex color, like #6d5dfc."
          type="text"
          value={value}
        />
      </div>
      {!isValid ? (
        <p className="text-sm text-red-700 dark:text-red-300" id={`${id}-error`} role="alert">
          Enter a six-digit hex color, like #6d5dfc.
        </p>
      ) : null}
    </div>
  )
}
