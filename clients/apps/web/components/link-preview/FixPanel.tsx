'use client'

import { characterCount } from '@/lib/link-preview/text'
import { isHttpUrl } from '@/lib/link-preview/urls'
import { CheckIcon as Check } from '@phosphor-icons/react/dist/ssr/Check'
import { CopyIcon as Copy } from '@phosphor-icons/react/dist/ssr/Copy'
import { SpinnerGapIcon as Loader2 } from '@phosphor-icons/react/dist/ssr/SpinnerGap'
import { ArrowCounterClockwiseIcon as RotateCcw } from '@phosphor-icons/react/dist/ssr/ArrowCounterClockwise'
import { SparkleIcon as Sparkles } from '@phosphor-icons/react/dist/ssr/Sparkle'
import { useState } from 'react'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import type {
  LinkCopyVariant,
  LinkPreview,
  LinkPreviewAgent,
} from '@/lib/api/contracts/link-preview'
import { auditLinkPreview, issueCategorySchema } from '@/lib/link-preview/audit'
import { CHAR_LIMITS } from '@/lib/link-preview/metadata'
import {
  type LinkPreviewEdits,
  NO_EDITS,
  recommendedHtml,
  recommendedJsonLd,
  recommendedNextMetadata,
  recommendedNuxt,
  recommendedReactRouter,
  recommendedSvelteKit,
} from '@/lib/link-preview/snippets'
import { cn } from '@/lib/utils'
import { copyText } from './client'
import { IssueList, PANEL } from './MetadataPanels'
import { PLATFORMS, PlatformPreview } from './PlatformPreviews'
import { Label } from '@/components/ui/label'

/** The code formats the recommended tags come in. */
export const snippetFormatSchema = z.enum([
  'html',
  'next',
  'nuxt',
  'sveltekit',
  'reactrouter',
  'jsonld',
])

const F = snippetFormatSchema.enum
const SNIPPETS = [
  { format: F.html, label: 'HTML', render: recommendedHtml },
  { format: F.next, label: 'Next.js', render: recommendedNextMetadata },
  { format: F.nuxt, label: 'Nuxt', render: recommendedNuxt },
  { format: F.sveltekit, label: 'SvelteKit', render: recommendedSvelteKit },
  { format: F.reactrouter, label: 'React Router', render: recommendedReactRouter },
  { format: F.jsonld, label: 'JSON-LD', render: recommendedJsonLd },
]

const FIELDS: Array<{
  key: keyof LinkPreviewEdits
  label: string
  placeholder: (preview: LinkPreview) => string | undefined
  limit?: number
  multiline?: boolean
}> = [
  {
    key: 'title',
    label: 'Title',
    limit: CHAR_LIMITS.title,
    placeholder: (preview) => preview.ogTitle || preview.title,
  },
  {
    key: 'description',
    label: 'Description',
    limit: CHAR_LIMITS.description,
    multiline: true,
    placeholder: (preview) => preview.ogDescription || preview.description,
  },
  {
    key: 'image',
    label: 'Image URL',
    placeholder: (preview) => preview.ogImage || preview.twitterImage,
  },
  { key: 'siteName', label: 'Site name', placeholder: (preview) => preview.ogSiteName },
]

/** Three AI-written options from the page itself; picking one fills the editor. */
function AiCopy({
  agent,
  onPick,
  url,
}: {
  agent: LinkPreviewAgent
  onPick: (variant: LinkCopyVariant) => void
  url: string
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [variants, setVariants] = useState<LinkCopyVariant[]>([])

  async function write() {
    setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/link-preview/suggestions', {
        body: JSON.stringify({ agent, url }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      const body = await response.json().catch(() => null)
      if (!response.ok) throw new Error(body?.message ?? 'The copy could not be written.')
      setVariants(body.variants)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The copy could not be written.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className={cn(PANEL, 'space-y-4 p-5')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-ui-lg font-medium text-foreground">Write it with AI</h3>
          <p className="text-xs text-muted-foreground">
            Three title and description options from what the page says. Uses your workspace&apos;s AI
            credits.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={write} disabled={loading}>
          {loading ? <Loader2 className="animate-spin" /> : <Sparkles />}
          {variants.length ? 'Write new options' : 'Write options'}
        </Button>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {variants.length > 0 && (
        <ul className="grid gap-3 md:grid-cols-3">
          {variants.map((variant) => (
            <li
              key={variant.title}
              className="flex flex-col gap-2 rounded-xl bg-white/[0.03] p-4 ring-1 ring-white/[0.08]"
            >
              <p className="text-[11px] uppercase tracking-wide text-sky-300">{variant.angle}</p>
              <p className="text-ui-lg font-medium text-foreground">{variant.title}</p>
              <p className="flex-1 text-sm text-muted-foreground">{variant.description}</p>
              <p className="text-[11px] tabular-nums text-muted-foreground">
                {characterCount(variant.title)} / 60 · {characterCount(variant.description)} / 160
              </p>
              <Button type="button" size="sm" variant="secondary" onClick={() => onPick(variant)}>
                Use this
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

const INPUT =
  'w-full rounded-lg bg-white/[0.03] px-3 py-2 text-sm text-foreground ring-1 ring-white/[0.08] outline-none placeholder:text-muted-foreground focus:ring-white/25'

/**
 * Try new copy and a new image, watch the cards and issues update, then copy
 * the full recommended tag set as HTML or a Next.js `metadata` export.
 */
export function FixPanel({
  agent,
  edited,
  edits,
  onEdit,
  preview,
  url,
}: {
  agent: LinkPreviewAgent
  /** `preview` with `edits` applied. */
  edited: LinkPreview
  edits: LinkPreviewEdits
  onEdit: (edits: LinkPreviewEdits) => void
  preview: LinkPreview
  url: string
}) {
  const [platform, setPlatform] = useState(PLATFORMS[3]!)
  const [format, setFormat] = useState(SNIPPETS[0]!)
  const [copied, setCopied] = useState(false)
  const code = format.render(edited)
  const remaining = auditLinkPreview(edited).filter(
    (issue) =>
      issue.category === issueCategorySchema.enum.content ||
      issue.category === issueCategorySchema.enum.social ||
      issue.category === issueCategorySchema.enum.images
  )
  const changed = Object.values(edits).some((value) => value.trim())

  return (
    <div className="space-y-6">
      <AiCopy
        agent={agent}
        url={preview.url}
        onPick={({ description, title }) => onEdit({ ...edits, description, title })}
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <section className={cn(PANEL, 'space-y-4 p-5')}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-ui-lg font-medium text-foreground">Try changes</h3>
              <p className="text-xs text-muted-foreground">
                Every preview on this page updates as you type.
              </p>
            </div>
            {changed && (
              <Button variant="ghost" size="sm" onClick={() => onEdit(NO_EDITS)}>
                <RotateCcw />
                Reset
              </Button>
            )}
          </div>
          {FIELDS.map((field) => {
            const value = edits[field.key]
            const shown = value || field.placeholder(preview) || ''
            const Input = field.multiline ? 'textarea' : 'input'
            return (
              <Label key={field.key} className="block space-y-1.5">
                <span className="flex items-center justify-between text-xs text-muted-foreground">
                  {field.label}
                  {field.limit && (
                    <span className={cn(characterCount(shown) > field.limit && 'text-amber-400')}>
                      {characterCount(shown)} / {field.limit}
                    </span>
                  )}
                </span>
                <Input
                  value={value}
                  placeholder={field.placeholder(preview) ?? `No ${field.label.toLowerCase()} yet`}
                  onChange={(event) => onEdit({ ...edits, [field.key]: event.target.value })}
                  aria-invalid={field.key === 'image' && !!value.trim() && !isHttpUrl(value.trim())}
                  rows={field.multiline ? 3 : undefined}
                  className={cn(INPUT, field.multiline && 'resize-none')}
                />
              </Label>
            )
          })}
        </section>
        <section className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {PLATFORMS.map((item) => (
              <Button variant="custom" size={null}
                key={item.id}
                type="button"
                onClick={() => setPlatform(item)}
                className={cn(
                  'rounded-full px-2.5 py-1 text-xs transition-colors',
                  item.id === platform.id
                    ? 'bg-white text-black'
                    : 'bg-white/[0.05] text-muted-foreground hover:text-foreground'
                )}
              >
                {item.name}
              </Button>
            ))}
          </div>
          <PlatformPreview platform={platform} preview={edited} url={url} />
        </section>
      </div>

      <section className={cn(PANEL, 'space-y-4 p-5')}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-ui-lg font-medium text-foreground">Recommended tags</h3>
            <p className="text-xs text-muted-foreground">
              The full set, with your edits, for your stack. JSON-LD adds structured data for
              search. Replace anything marked TODO.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <div
              className="inline-flex flex-wrap rounded-lg bg-muted p-[3px]"
              role="group"
              aria-label="Format"
            >
              {SNIPPETS.map((snippet) => (
                <Button variant="custom" size={null}
                  key={snippet.format}
                  type="button"
                  aria-pressed={snippet.format === format.format}
                  onClick={() => setFormat(snippet)}
                  className={cn(
                    'rounded-md px-3 py-1 text-ui-lg font-medium text-muted-foreground transition-colors',
                    snippet.format === format.format && 'bg-background text-foreground shadow-sm'
                  )}
                >
                  {snippet.label}
                </Button>
              ))}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                if (!(await copyText(code))) return
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
              }}
            >
              {copied ? <Check className="text-emerald-500" /> : <Copy />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
        <pre className="max-h-[480px] overflow-auto rounded-lg bg-muted p-4 font-mono text-xs leading-relaxed">
          {code}
        </pre>
      </section>

      <section className="space-y-3">
        <h3 className="text-ui-lg font-medium text-foreground">
          Copy, social, and image issues left{changed ? ' with your edits' : ''}
        </h3>
        <IssueList issues={remaining} />
      </section>
    </div>
  )
}
