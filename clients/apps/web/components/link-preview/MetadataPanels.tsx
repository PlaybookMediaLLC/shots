'use client'

import { characterCount } from '@/lib/link-preview/text'
import { CheckIcon as Check } from '@phosphor-icons/react/dist/ssr/Check'
import { CopyIcon as Copy } from '@phosphor-icons/react/dist/ssr/Copy'
import { DownloadIcon as Download } from '@phosphor-icons/react/dist/ssr/Download'
import { ArrowSquareOutIcon as ExternalLink } from '@phosphor-icons/react/dist/ssr/ArrowSquareOut'
import { EyeIcon as Eye } from '@phosphor-icons/react/dist/ssr/Eye'
import { SpinnerGapIcon as Loader2 } from '@phosphor-icons/react/dist/ssr/SpinnerGap'
import { MagicWandIcon as Wand2 } from '@phosphor-icons/react/dist/ssr/MagicWand'
import { XCircleIcon as XCircle } from '@phosphor-icons/react/dist/ssr/XCircle'
import { WarningIcon as AlertTriangle } from '@phosphor-icons/react/dist/ssr/Warning'
import { InfoIcon as Info } from '@phosphor-icons/react/dist/ssr/Info'
import { motion } from 'motion/react'
import { type ReactNode, useState } from 'react'
import { z } from 'zod'
import { Pill, type PillTone } from '@/components/platform-ui'
import { Button } from '@/components/ui/button'
import {
  type LinkPreview,
  linkPreviewAgentSchema,
  type LinkPreviewImage,
} from '@/lib/api/contracts/link-preview'
import { issueSeveritySchema, type LinkPreviewIssue } from '@/lib/link-preview/audit'
import { CRAWLERS } from '@/lib/link-preview/crawlers'
import { CHAR_LIMITS, scoreLinkPreview, toMetaTagsHtml } from '@/lib/link-preview/metadata'
import { SEVERITY_LABEL } from '@/lib/link-preview/snippets'
import { cn } from '@/lib/utils'
import { copyText, downloadText } from './client'
import { hostname } from './PlatformPreviews'
import { SERP_LIMITS, serpFit } from './serp'

type PanelProps = { preview: LinkPreview }

/** The signed-in platform's card surface, as `Group` in platform-ui draws it. */
export const PANEL = 'rounded-2xl bg-white/[0.015] ring-1 ring-white/[0.08]'

const { error, info, warning } = issueSeveritySchema.enum
const SEVERITY_TONE: Record<LinkPreviewIssue['severity'], PillTone> = {
  [error]: 'red',
  [info]: 'blue',
  [warning]: 'yellow',
}
const RING_RADIUS = 45
const RING_LENGTH = 2 * Math.PI * RING_RADIUS
const MB = 1024 * 1024

const size = (bytes: number) =>
  bytes >= MB ? `${(bytes / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

function ScoreRing({ score }: { score: number }) {
  return (
    <div className="relative mx-auto size-32 shrink-0">
      <svg className="size-32 -rotate-90" viewBox="0 0 100 100" aria-hidden="true">
        <circle
          cx="50"
          cy="50"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="8"
          className="stroke-muted"
        />
        <motion.circle
          cx="50"
          cy="50"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={RING_LENGTH}
          initial={{ strokeDashoffset: RING_LENGTH }}
          animate={{ strokeDashoffset: RING_LENGTH * (1 - score / 100) }}
          transition={{ delay: 0.2, duration: 1, ease: 'easeOut' }}
          className={
            score >= 80 ? 'stroke-emerald-500' : score >= 50 ? 'stroke-amber-500' : 'stroke-red-500'
          }
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-3xl font-semibold tabular-nums">
        {score}
        <span className="sr-only"> out of 100</span>
      </span>
    </div>
  )
}

/** Issues as a list: severity, what is wrong, and the fix. */
export function IssueList({ issues }: { issues: LinkPreviewIssue[] }) {
  if (!issues.length) {
    return (
      <p className="flex items-center gap-2 text-sm text-emerald-400">
        <Check className="size-4" /> Nothing to fix. This link previews well everywhere we check.
      </p>
    )
  }
  return (
    <ul className={cn(PANEL, 'divide-y divide-white/[0.07]')}>
      {issues.map((issue) => (
        <li key={issue.id} className="flex gap-3 p-4">
          <div className="w-24 shrink-0 pt-0.5">
            <Pill tone={SEVERITY_TONE[issue.severity]}>{SEVERITY_LABEL[issue.severity]}</Pill>
          </div>
          <div className="min-w-0">
            <p className="text-ui-lg font-medium text-foreground">{issue.title}</p>
            <p className="mt-0.5 text-sm text-muted-foreground">{issue.fix}</p>
          </div>
        </li>
      ))}
    </ul>
  )
}

/** The score, each weighted check, and every issue with its fix. */
export function OverviewPanel({ issues, preview }: PanelProps & { issues: LinkPreviewIssue[] }) {
  const { checks, score } = scoreLinkPreview(preview)
  const count = (severity: LinkPreviewIssue['severity']) =>
    issues.filter((issue) => issue.severity === severity).length
  return (
    <div className="space-y-6">
      <div className={cn(PANEL, 'flex flex-col gap-8 p-6 sm:flex-row')}>
        <div className="flex flex-col items-center gap-3">
          <ScoreRing score={score} />
          <div className="flex gap-1.5">
            <Pill tone="red">{count(error)} error{count(error) === 1 ? '' : 's'}</Pill>
            <Pill tone="yellow">{count(warning)} warning{count(warning) === 1 ? '' : 's'}</Pill>
          </div>
        </div>
        <ul className="grid flex-1 grid-cols-2 gap-x-6 gap-y-2 text-sm">
          {checks.map((check) => (
            <li
              key={check.id}
              className={cn(
                'flex items-center gap-2',
                check.passed ? 'text-emerald-400' : check.severity === error ? 'text-red-400' : check.severity === warning ? 'text-amber-400' : 'text-sky-400'
              )}
            >
              {check.passed ? (
                <Check className="size-4 shrink-0" aria-label="Passed" />
              ) : check.severity === error ? (
                <XCircle className="size-4 shrink-0" aria-label="Error" />
              ) : check.severity === warning ? (
                <AlertTriangle className="size-4 shrink-0" aria-label="Warning" />
              ) : (
                <Info className="size-4 shrink-0" aria-label="Suggestion" />
              )}
              {check.name}{!check.passed && ` (−${check.weight})`}
            </li>
          ))}
        </ul>
      </div>
      <p className="text-xs text-muted-foreground">Start at 100: each error deducts 40 points, warnings deduct 10 each (up to 40), and suggestions deduct 1 each (up to 9). The minimum score is 0.</p>
      <section className="space-y-3">
        <h3 className="text-ui-lg font-medium text-foreground">
          What to fix{' '}
          <span className="text-muted-foreground">
            · {issues.length} {issues.length === 1 ? 'item' : 'items'}, {count(info)} suggestions
          </span>
        </h3>
        <IssueList issues={issues} />
      </section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={cn(PANEL, 'p-6')}>
      <h3 className="mb-2 text-ui-lg font-medium text-foreground">{title}</h3>
      <dl>{children}</dl>
    </section>
  )
}

function Field({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-white/[0.07] py-3 last:border-b-0">
      <dt className="shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-right text-sm text-foreground">
        {children || <span className="text-muted-foreground">Not set</span>}
      </dd>
    </div>
  )
}

function counted(text: string | undefined, max: number): ReactNode {
  if (!text) return null
  return (
    <>
      {text}
      <span
        className={cn(
          'mt-1 block text-xs',
          characterCount(text) > max ? 'text-amber-500' : 'text-muted-foreground'
        )}
      >
        {characterCount(text)} / {max} chars
      </span>
    </>
  )
}

/** How much of `text` Google shows, measured in pixels as the results page sets it. */
function serpHint(text: string | undefined, part: keyof typeof SERP_LIMITS): ReactNode {
  if (!text) return null
  const fit = serpFit(text, part)
  const limit = SERP_LIMITS[part].width
  return (
    <span className={cn('block text-xs', fit.cut ? 'text-amber-500' : 'text-muted-foreground')}>
      {fit.cut
        ? `Google cuts it to “${fit.shown}” (${Math.round(fit.width)} of about ${limit} px)`
        : `Fits in Google: ${Math.round(fit.width)} of about ${limit} px`}
    </span>
  )
}

const isWebUrl = (value: string) => /^https?:\/\//i.test(value)

function link(url: string | undefined, label: ReactNode = url, className?: string): ReactNode {
  if (!url) return null
  // Values come from an untrusted page; only web URLs become links.
  if (!isWebUrl(url)) return url
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn('inline-flex items-center gap-1.5 break-all hover:underline', className)}
    >
      {label}
      <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    </a>
  )
}

function found(url: string | undefined): ReactNode {
  return url ? (
    link(url, 'Found', 'text-emerald-400')
  ) : (
    <span className="text-muted-foreground">Not found</span>
  )
}

function image(url: string | undefined, alt: string): ReactNode {
  if (!url) return null
  return (
    <img
      src={url}
      alt={alt}
      referrerPolicy="no-referrer"
      className="ml-auto max-h-48 max-w-xs rounded-lg border border-border object-contain"
    />
  )
}

/** Title, description, canonical, technical tags, and SEO files. */
export function BasicPanel({ preview }: PanelProps) {
  return (
    <div className="space-y-6">
      <Section title="Essential">
        <Field label="Favicon">
          {preview.favicon && (
            <img
              src={preview.favicon}
              alt="Favicon"
              referrerPolicy="no-referrer"
              className="ml-auto size-6 rounded"
            />
          )}
        </Field>
        <Field label="Title">
          {counted(preview.title, CHAR_LIMITS.title)}
          {serpHint(preview.title, 'title')}
        </Field>
        <Field label="Description">
          {counted(preview.description, CHAR_LIMITS.description)}
          {serpHint(preview.description, 'description')}
        </Field>
        <Field label="Canonical">{link(preview.canonical)}</Field>
      </Section>
      <Section title="Technical">
        <Field label="Language">{preview.language}</Field>
        <Field label="Charset">{preview.charset}</Field>
        <Field label="Viewport">{preview.viewport}</Field>
        <Field label="Robots">{preview.robots}</Field>
        <Field label="Theme color">
          {preview.themeColor && (
            <span className="inline-flex items-center gap-2">
              <span
                className="size-4 rounded ring-1 ring-white/20"
                style={{ background: preview.themeColor }}
              />
              {preview.themeColor}
            </span>
          )}
        </Field>
      </Section>
      <Section title="SEO files">
        <Field label="robots.txt">{found(preview.robotsFile)}</Field>
        <Field label="Sitemap">{found(preview.sitemap)}</Field>
      </Section>
    </div>
  )
}

/** The `og:*` tags. */
export function OpenGraphPanel({ preview }: PanelProps) {
  const declared =
    preview.ogImageWidth || preview.ogImageHeight
      ? `${preview.ogImageWidth ?? '?'} × ${preview.ogImageHeight ?? '?'}`
      : undefined
  return (
    <Section title="Open Graph">
      <Field label="Title">{counted(preview.ogTitle, CHAR_LIMITS.ogTitle)}</Field>
      <Field label="Description">{counted(preview.ogDescription, CHAR_LIMITS.ogDescription)}</Field>
      <Field label="Image">{image(preview.ogImage, 'Open Graph image')}</Field>
      <Field label="Image alt">{preview.ogImageAlt}</Field>
      <Field label="Declared size">{declared}</Field>
      <Field label="Type">{preview.ogType}</Field>
      <Field label="URL">{link(preview.ogUrl)}</Field>
      <Field label="Site name">{preview.ogSiteName}</Field>
      <Field label="Locale">{preview.ogLocale}</Field>
    </Section>
  )
}

/** The `twitter:*` tags X reads, with the Open Graph image as its fallback. */
export function XCardPanel({ preview }: PanelProps) {
  return (
    <Section title="X card">
      <Field label="Card type">{preview.twitterCard}</Field>
      <Field label="Title">{counted(preview.twitterTitle, CHAR_LIMITS.twitterTitle)}</Field>
      <Field label="Description">
        {counted(preview.twitterDescription, CHAR_LIMITS.twitterDescription)}
      </Field>
      <Field label="Image">{image(preview.twitterImage || preview.ogImage, 'X card image')}</Field>
      <Field label="Image alt">{preview.twitterImageAlt}</Field>
      <Field label="Site">{preview.twitterSite}</Field>
      <Field label="Creator">{preview.twitterCreator}</Field>
    </Section>
  )
}

/** Each platform's image limit, checked against what the server measured. */
function verdicts(measured: LinkPreviewImage, recommended: [number, number]) {
  const bytes = measured.tooLarge ? Infinity : (measured.bytes ?? 0)
  const { height = 0, width = 0 } = measured
  const ratio = width && height ? width / height : 0
  const target = recommended[0] / recommended[1]
  return [
    { label: 'Under 5 MB for X and LinkedIn', passed: bytes <= 5 * MB },
    { label: 'Under 8 MB for Facebook', passed: bytes <= 8 * MB },
    { label: 'Under 600 KB for WhatsApp', passed: bytes <= 600 * 1024 },
    { label: 'At least 600 px wide for large cards', passed: width >= 600 },
    {
      label: `Close to ${target.toFixed(2)}:1`,
      passed: !!ratio && Math.abs(ratio - target) / target <= 0.1,
    },
    {
      label: 'JPEG, PNG, WebP, or GIF',
      passed: ['jpeg', 'png', 'webp', 'gif'].includes(measured.format ?? ''),
    },
  ]
}

/** The crop a platform makes: none, its large 1.91:1 card, a 1:1 thumbnail, or where text stays safe. */
export const cropGuideSchema = z.enum(['none', 'card', 'square', 'safe'])

const G = cropGuideSchema.enum
const GUIDES = [
  { id: G.none, label: 'Full image' },
  { id: G.card, label: '1.91:1 large card' },
  { id: G.square, label: '1:1 thumbnail' },
  { id: G.safe, label: 'Text-safe area' },
]

/** The visible box of a centered crop to `target` (width / height), in percent of the image. */
function centeredCrop(ratio: number, target: number) {
  return ratio > target
    ? {
        height: 100,
        left: (100 - (target / ratio) * 100) / 2,
        top: 0,
        width: (target / ratio) * 100,
      }
    : {
        height: (ratio / target) * 100,
        left: 0,
        top: (100 - (ratio / target) * 100) / 2,
        width: 100,
      }
}

function guideBox(guide: z.infer<typeof cropGuideSchema>, ratio: number) {
  if (guide === G.square) return centeredCrop(ratio, 1)
  const card = centeredCrop(ratio, 1.91)
  if (guide === G.card) return card
  // Cards overlay the edges with UI and round corners; keep text in the middle 80%.
  return {
    height: card.height * 0.8,
    left: card.left + card.width * 0.1,
    top: card.top + card.height * 0.1,
    width: card.width * 0.8,
  }
}

function ImageCheck({
  label,
  measured,
  onUse,
  recommended,
  url,
}: {
  label: string
  measured?: LinkPreviewImage
  /** Show an image in every preview; receives a blob: URL. */
  onUse?: (imageUrl: string) => void
  /** `[width, height]` the platform crops to; omitted for the favicon. */
  recommended?: [number, number]
  url: string | undefined
}) {
  const [loaded, setLoaded] = useState<[number, number] | null>(null)
  const [failed, setFailed] = useState(false)
  const [guide, setGuide] = useState<z.infer<typeof cropGuideSchema>>(G.none)
  const [fixing, setFixing] = useState(false)
  const [fixError, setFixError] = useState('')
  if (!url) return null
  const width = measured?.width ?? loaded?.[0]
  const height = measured?.height ?? loaded?.[1]
  const ratio = width && height ? width / height : 0
  const box = recommended && ratio && guide !== G.none ? guideBox(guide, ratio) : null
  const optimized = `/api/link-preview/image?${new URLSearchParams({ url })}`

  async function tryOptimized() {
    setFixing(true)
    setFixError('')
    try {
      const response = await fetch(optimized)
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.message ?? 'The image could not be converted.')
      }
      onUse?.(URL.createObjectURL(await response.blob()))
    } catch (caught) {
      setFixError(caught instanceof Error ? caught.message : 'The image could not be converted.')
    } finally {
      setFixing(false)
    }
  }

  return (
    <div className={cn(PANEL, 'grid gap-5 p-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]')}>
      <div className="space-y-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <div
          className={cn(
            'relative overflow-hidden rounded-lg border border-border bg-muted',
            recommended ? (ratio ? '' : 'aspect-[1.91/1]') : 'size-16'
          )}
          style={recommended && ratio ? { aspectRatio: `${width} / ${height}` } : undefined}
        >
          {failed ? (
            <p className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
              Failed to load
            </p>
          ) : (
            <img
              src={url}
              alt={label}
              referrerPolicy="no-referrer"
              onLoad={(event) =>
                setLoaded([event.currentTarget.naturalWidth, event.currentTarget.naturalHeight])
              }
              onError={() => setFailed(true)}
              className={cn('size-full', recommended ? 'object-fill' : 'object-contain p-2')}
            />
          )}
          {box && (
            <span
              className="pointer-events-none absolute rounded-sm border-2 border-white/90"
              style={{
                boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
                height: `${box.height}%`,
                left: `${box.left}%`,
                top: `${box.top}%`,
                width: `${box.width}%`,
              }}
            />
          )}
        </div>
        {recommended && ratio > 0 && (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Crop guide">
            {GUIDES.map((item) => (
              <Button variant="custom" size={null}
                key={item.id}
                type="button"
                aria-pressed={guide === item.id}
                onClick={() => setGuide(item.id)}
                className={cn(
                  'rounded-full px-2.5 py-1 text-xs transition-colors',
                  guide === item.id
                    ? 'bg-white text-black'
                    : 'bg-white/[0.05] text-muted-foreground hover:text-foreground'
                )}
              >
                {item.label}
              </Button>
            ))}
          </div>
        )}
        <p className="break-all text-xs text-muted-foreground">{url}</p>
      </div>
      <div className="space-y-3 text-sm">
        {measured?.error ? (
          <p className="text-red-400">{measured.error}</p>
        ) : (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            <dt className="text-muted-foreground">Size</dt>
            <dd>{width && height ? `${width} × ${height}` : 'Loading…'}</dd>
            {recommended && (
              <>
                <dt className="text-muted-foreground">Recommended</dt>
                <dd>
                  {recommended[0]} × {recommended[1]}
                </dd>
              </>
            )}
            {measured?.bytes !== undefined && (
              <>
                <dt className="text-muted-foreground">Weight</dt>
                <dd>{measured.tooLarge ? 'Over 8 MB' : size(measured.bytes)}</dd>
              </>
            )}
            {measured?.format && (
              <>
                <dt className="text-muted-foreground">Format</dt>
                <dd className="uppercase">{measured.format}</dd>
              </>
            )}
          </dl>
        )}
        {measured && !measured.error && recommended && (
          <ul className="space-y-1.5 border-t border-white/[0.07] pt-3">
            {verdicts(measured, recommended).map((verdict) => (
              <li
                key={verdict.label}
                className={cn(
                  'flex items-center gap-2',
                  verdict.passed ? 'text-emerald-400' : 'text-amber-400'
                )}
              >
                {verdict.passed ? (
                  <Check className="size-4 shrink-0" />
                ) : (
                  <XCircle className="size-4 shrink-0" />
                )}
                {verdict.label}
              </li>
            ))}
          </ul>
        )}
        {recommended && !measured?.error && (
          <div className="space-y-2 border-t border-white/[0.07] pt-3">
            <p className="text-xs text-muted-foreground">
              Fix it: a 1200 × 630 JPEG under 600 KB, cropped around the most important part.
            </p>
            <div className="flex flex-wrap gap-2">
              <a
                href={optimized}
                download="og-image-1200x630.jpg"
                className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm ring-1 ring-white/10 hover:bg-white/[0.05]"
              >
                <Wand2 className="size-4" />
                Download fixed image
              </a>
              {onUse && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={tryOptimized}
                  disabled={fixing}
                >
                  {fixing ? <Loader2 className="animate-spin" /> : <Eye />}
                  Preview it
                </Button>
              )}
            </div>
            {fixError && <p className="text-xs text-red-400">{fixError}</p>}
          </div>
        )}
      </div>
    </div>
  )
}

/** Each image with what the server measured: pixels, weight, format, and platform limits. */
export function ImagesPanel({
  onUse,
  preview,
}: PanelProps & { onUse?: (imageUrl: string) => void }) {
  const xImage = preview.twitterImage || preview.ogImage
  const measured = (url?: string) => preview.images?.find((entry) => entry.url === url)
  if (!preview.ogImage && !xImage && !preview.favicon) {
    return <p className="text-sm text-muted-foreground">This page declares no images.</p>
  }
  return (
    <div className="space-y-6">
      <ImageCheck
        label="Open Graph"
        url={preview.ogImage}
        measured={measured(preview.ogImage)}
        onUse={onUse}
        recommended={[1200, 630]}
      />
      {xImage !== preview.ogImage && (
        <ImageCheck
          label="X"
          url={xImage}
          measured={measured(xImage)}
          onUse={onUse}
          recommended={[1200, 628]}
        />
      )}
      <ImageCheck label="Favicon" url={preview.favicon} />
    </div>
  )
}

const statusTone = (status: number): PillTone =>
  status >= 400 ? 'red' : status >= 300 ? 'yellow' : 'green'

/** How the page answered, its redirect chain, crawler access, and structured data. */
export function TechnicalPanel({ preview }: PanelProps) {
  const { crawlers, response } = preview
  return (
    <div className="space-y-6">
      {response && (
        <Section title="Response">
          <Field label="Fetched as">
            {preview.agent && preview.agent !== linkPreviewAgentSchema.enum.default
              ? CRAWLERS[preview.agent].name
              : 'Browser-like preview bot'}
          </Field>
          <Field label="Status">
            <Pill tone={statusTone(response.hops.at(-1)?.status ?? 200)}>
              {response.hops.at(-1)?.status ?? 200}
            </Pill>
          </Field>
          <Field label="Response time">{`${(response.durationMs / 1000).toFixed(2)} s`}</Field>
          <Field label="HTML size">
            {`${size(response.bytes)}${response.truncated ? ' (read the first 1.5 MB)' : ''}`}
          </Field>
          <Field label="Content type">{response.contentType}</Field>
          <Field label="X-Robots-Tag">{response.xRobotsTag}</Field>
        </Section>
      )}
      {response && response.hops.length > 1 && (
        <section className={cn(PANEL, 'p-6')}>
          <h3 className="mb-3 text-ui-lg font-medium text-foreground">
            Redirect chain · {response.hops.length - 1} redirect
            {response.hops.length > 2 ? 's' : ''}
          </h3>
          <ol className="space-y-2">
            {response.hops.map((hop, index) => (
              <li key={`${index}-${hop.url}`} className="flex items-center gap-3 text-sm">
                <Pill tone={statusTone(hop.status)}>{hop.status}</Pill>
                <span className="min-w-0 break-all text-muted-foreground">{hop.url}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      {(preview.targets?.length || preview.tracking) && (
        <Section title="Link targets">
          {preview.targets?.map((target) => (
            <Field key={target.kind} label={`${target.kind} → ${target.url}`}>
              {target.error ? (
                <span className="text-red-400">{target.error}</span>
              ) : (
                <span className="inline-flex flex-wrap items-center justify-end gap-2">
                  <Pill tone={statusTone(target.status ?? 0)}>{target.status}</Pill>
                  {target.finalUrl && target.finalUrl !== target.url ? (
                    <span className="text-amber-300">redirects to {target.finalUrl}</span>
                  ) : (
                    <span className="text-muted-foreground">reaches the page</span>
                  )}
                </span>
              )}
            </Field>
          ))}
          {preview.tracking && (
            <Field label="UTM tags through redirects">
              {preview.tracking.error ? (
                <span className="text-red-400">{preview.tracking.error}</span>
              ) : preview.tracking.kept ? (
                <span className="text-emerald-400">Kept, so campaign analytics see the source</span>
              ) : (
                <span className="text-red-400">
                  Dropped on the way to {preview.tracking.finalUrl}
                </span>
              )}
            </Field>
          )}
        </Section>
      )}
      {crawlers && (
        <Section title="Crawler access (robots.txt)">
          {crawlers.map((access) => (
            <Field
              key={access.crawler}
              label={`${CRAWLERS[access.crawler].name} · ${CRAWLERS[access.crawler].token}`}
            >
              {access.allowed ? (
                <span className="text-emerald-400">Allowed</span>
              ) : (
                <span className="text-red-400">Blocked by {access.rule}</span>
              )}
            </Field>
          ))}
        </Section>
      )}
      {preview.robotsTxt !== undefined && <RobotsViewer preview={preview} />}
      {response?.headers && Object.keys(response.headers).length > 0 && (
        <section className={cn(PANEL, 'p-6')}>
          <h3 className="mb-3 text-ui-lg font-medium text-foreground">Response headers</h3>
          <dl className="grid gap-x-6 gap-y-1.5 font-mono text-xs sm:grid-cols-[minmax(10rem,auto)_1fr]">
            {Object.entries(response.headers)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([name, value]) => (
                <div key={name} className="contents">
                  <dt className="text-muted-foreground">{name}</dt>
                  <dd className="break-all text-foreground">{value}</dd>
                </div>
              ))}
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">
            Cookies are left out. Cache-Control and Age show how long crawlers and CDNs reuse the
            page.
          </p>
        </section>
      )}
      <Section title="Structured data (JSON-LD)">
        <Field label="Types">
          {preview.jsonLd.length > 0 && (
            <span className="inline-flex flex-wrap justify-end gap-1.5">
              {preview.jsonLd.map((type) => (
                <Pill key={type} tone="purple">
                  {type}
                </Pill>
              ))}
            </span>
          )}
        </Field>
        <Field label="Host">{hostname(preview.url)}</Field>
      </Section>
    </div>
  )
}

/** robots.txt as served, with the lines that block a platform crawler highlighted. */
function RobotsViewer({ preview }: PanelProps) {
  const blocked = (preview.crawlers ?? []).filter((access) => !access.allowed)
  const rules = new Set(blocked.map((access) => access.rule?.toLowerCase().replace(/\s+/g, ' ')))
  const tokens = new Set(blocked.map((access) => CRAWLERS[access.crawler].token.toLowerCase()))
  const lines = (preview.robotsTxt ?? '').split(/\r?\n/)
  const decides = (line: string) => {
    const clean = line
      .replace(/#.*$/, '')
      .trim()
      .toLowerCase()
      .replace(/\s*:\s*/, ': ')
    const agent = clean.match(/^user-agent: (.+)$/)?.[1]
    return (
      rules.has(clean) ||
      (agent !== undefined && [...tokens].some((token) => token.startsWith(agent)))
    )
  }
  return (
    <section className={cn(PANEL, 'p-6')}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-ui-lg font-medium text-foreground">robots.txt</h3>
        {preview.robotsFile && link(preview.robotsFile, 'Open', 'text-xs')}
      </div>
      {lines.join('').trim() ? (
        <pre className="max-h-96 overflow-auto rounded-lg bg-muted py-3 font-mono text-xs leading-relaxed">
          {lines.map((line, index) => (
            <span
              key={index}
              className={cn('block px-4', decides(line) && 'bg-amber-500/15 text-amber-200')}
            >
              <span className="mr-4 inline-block w-8 select-none text-right text-muted-foreground/60">
                {index + 1}
              </span>
              {line || ' '}
            </span>
          ))}
        </pre>
      ) : (
        <p className="text-sm text-muted-foreground">
          The file is empty, so every crawler is allowed.
        </p>
      )}
      {blocked.length > 0 && (
        <p className="mt-3 text-xs text-amber-300">
          Highlighted lines block{' '}
          {blocked.map((access) => CRAWLERS[access.crawler].name).join(', ')}.
        </p>
      )}
    </section>
  )
}

/** Every tag on the page as JSON or as `<head>` markup, ready to copy or download. */
export function RawPanel({ preview }: PanelProps) {
  const [html, setHtml] = useState(false)
  const [copied, setCopied] = useState(false)
  const content = html ? toMetaTagsHtml(preview) : JSON.stringify(preview, null, 2)

  async function copy() {
    if (!(await copyText(content))) return
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <section className={cn(PANEL, 'space-y-4 p-6')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg bg-muted p-[3px]" role="group" aria-label="Format">
          {['JSON', 'HTML'].map((format) => (
            <Button variant="custom" size={null}
              key={format}
              type="button"
              aria-pressed={html === (format === 'HTML')}
              onClick={() => setHtml(format === 'HTML')}
              className={cn(
                'rounded-md px-3 py-1 text-ui-lg font-medium text-muted-foreground transition-colors',
                html === (format === 'HTML') && 'bg-background text-foreground shadow-sm'
              )}
            >
              {format}
            </Button>
          ))}
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              downloadText(
                `${hostname(preview.url)}-link-preview.json`,
                JSON.stringify(preview, null, 2),
                'application/json'
              )
            }
          >
            <Download />
            Download JSON
          </Button>
          <Button variant="outline" size="sm" onClick={copy}>
            {copied ? <Check className="text-emerald-500" /> : <Copy />}
            {copied ? 'Copied' : `Copy ${html ? 'HTML' : 'JSON'}`}
          </Button>
        </div>
      </div>
      <pre className="max-h-[600px] overflow-auto rounded-lg bg-muted p-4 font-mono text-xs leading-relaxed">
        {content}
      </pre>
    </section>
  )
}
