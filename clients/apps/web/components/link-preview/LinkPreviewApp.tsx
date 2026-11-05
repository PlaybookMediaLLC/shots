'use client'

import { ErrorIcon as AlertCircle } from '@/components/platform-shell/icons'
import { CheckIcon as Check } from '@/components/platform-shell/icons'
import { ChevronDownIcon as ChevronDown } from '@/components/platform-shell/icons'
import { CopyIcon as Copy } from '@/components/platform-shell/icons'
import { OutwardIcon as ExternalLink } from '@/components/platform-shell/icons'
import { PostIcon as FileText } from '@/components/platform-shell/icons'
import { LinkIcon as Link2 } from '@/components/platform-shell/icons'
import { SpinnerGapIcon as Loader2 } from '@phosphor-icons/react/dist/ssr/SpinnerGap'
import { RefreshIcon as RefreshCw } from '@/components/platform-shell/icons'
import { CloseIcon as X } from '@/components/platform-shell/icons'
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import { useDeveloperMode } from '@/components/settings/PreferencesProvider'
import { Button, buttonVariants } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  type LinkPreview,
  type LinkPreviewAgent,
  linkPreviewAgentSchema,
} from '@/lib/api/contracts/link-preview'
import { auditLinkPreview, issueSeveritySchema } from '@/lib/link-preview/audit'
import { CRAWLERS } from '@/lib/link-preview/crawlers'
import { CANONICAL_HOST } from '@/lib/canonical-host'
import { scoreLinkPreview } from '@/lib/link-preview/metadata'
import {
  type LinkPreviewSnapshot,
  linkPreviewSnapshotSchema,
  snapshotOf,
} from '@/lib/link-preview/history'
import { applyEdits, markdownReport, NO_EDITS } from '@/lib/link-preview/snippets'
import { cn } from '@/lib/utils'
import { AutomatePanel } from './AutomatePanel'
import { BatchCheck } from './BatchCheck'
import { checkAddress, copyText, normalizeUrl, requestPreview } from './client'
import { CompareView } from './CompareView'
import { CrawlerMatrix } from './CrawlerMatrix'
import { ExtrasPanel } from './ExtrasPanel'
import { FixPanel } from './FixPanel'
import { HistoryCard } from './HistoryCard'
import { JavaScriptCheck } from './JavaScriptCheck'
import { ImageStudio } from './ImageStudio'
import {
  BasicPanel,
  ImagesPanel,
  OpenGraphPanel,
  OverviewPanel,
  PANEL,
  RawPanel,
  TechnicalPanel,
  XCardPanel,
} from './MetadataPanels'
import {
  AllPreviews,
  CacheRefresh,
  hostname,
  PLATFORMS,
  PlatformPreview,
  type PreviewDevice,
  previewDeviceSchema,
  previewPlatformSchema,
  type PreviewTheme,
  previewThemeSchema,
} from './PlatformPreviews'
import { PostComposer, SharePanel } from './SharePanel'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion'

const EXAMPLES = [CANONICAL_HOST, 'linear.app', 'vercel.com']
const RECENT_KEY = 'link-preview:recent'
const MAX_RECENT = 10

/** Check one link in depth, many at once, or two side by side. */
export const linkPreviewModeSchema = z.enum(['single', 'batch', 'compare'])

/** The result tabs, in order. */
export const linkPreviewTabSchema = z.enum([
  'overview',
  'previews',
  'fix',
  'share',
  'extras',
  'basic',
  'opengraph',
  'x',
  'images',
  'technical',
  'automate',
  'raw',
])

/** Which preview is showing: every platform, or one. */
export const platformViewSchema = z.enum(['all', ...previewPlatformSchema.options])

const MODE = linkPreviewModeSchema.enum
const TAB = linkPreviewTabSchema.enum
const ALL = platformViewSchema.enum.all

const TAB_LABELS: Record<z.infer<typeof linkPreviewTabSchema>, string> = {
  automate: 'Automate',
  basic: 'Basic',
  extras: 'More tags',
  fix: 'Fix',
  images: 'Images',
  opengraph: 'Open Graph',
  overview: 'Result',
  previews: 'Previews',
  raw: 'Raw',
  share: 'Share',
  technical: 'Technical',
  x: 'X',
}

const MODE_LABELS: Record<z.infer<typeof linkPreviewModeSchema>, string> = {
  batch: 'Batch',
  compare: 'Compare',
  single: 'One link',
}

/** The result and what to do about it; the remaining tabs are diagnostics. */
const PRIMARY_TABS = new Set<string>([TAB.overview, TAB.previews, TAB.fix, TAB.share])

const TAB_LIST =
  'h-auto w-max min-w-full justify-start rounded-none border-b border-border bg-transparent p-0'
const TAB_TRIGGER =
  'h-auto flex-none rounded-none border-0 border-b-2 border-transparent bg-transparent px-4 py-3 text-xs uppercase tracking-wide data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none'

const SHORTCUTS = [
  ['/', 'Go to the URL field'],
  ['Esc', 'Clear the URL field'],
  ['R', 'Check again'],
  ['1', 'All previews'],
  ['2–9', 'One platform'],
  ['[ ]', 'Previous or next platform'],
]

const LOCALHOST_STEPS = [
  { label: 'Install ngrok', command: 'bun add -g ngrok' },
  { label: 'Start your local server on port 3000' },
  { label: 'Open a tunnel', command: 'ngrok http 3000' },
  { label: 'Paste the https URL ngrok prints' },
]

const shareDraftSchema = z.object({
  post: z.string(),
  campaign: z.string(),
  content: z.string(),
  tab: linkPreviewTabSchema,
})
const draftKey = (url: string) => `link-preview:draft:v1:${url}`
function readDraft(url: string) {
  try {
    const parsed = shareDraftSchema.safeParse(
      JSON.parse(sessionStorage.getItem(draftKey(url)) ?? 'null')
    )
    if (parsed.success) return parsed.data
  } catch {
    // Storage may be unavailable.
  }
  return { post: '', campaign: '', content: '', tab: TAB.overview }
}

const historyKey = (url: string) => `link-preview:history:${url}`

/** Earlier checks of `url` in this browser, newest first. */
function readHistory(url: string): LinkPreviewSnapshot[] {
  try {
    const stored = z
      .array(linkPreviewSnapshotSchema)
      .safeParse(JSON.parse(localStorage.getItem(historyKey(url)) ?? '[]'))
    return stored.success ? stored.data : []
  } catch {
    return []
  }
}

/** Remember `snapshot` as the newest check of `url`, keeping the last ten. */
function recordHistory(url: string, snapshot: LinkPreviewSnapshot): LinkPreviewSnapshot[] {
  const entries = [snapshot, ...readHistory(url)].slice(0, 10)
  try {
    localStorage.setItem(historyKey(url), JSON.stringify(entries))
  } catch {
    // Storage is unavailable in some private modes; history is a convenience.
  }
  return entries
}

function Toggle<T extends string>({
  label,
  onChange,
  options,
  value,
}: {
  label: string
  onChange: (value: T) => void
  options: Array<{ id: T; label: string }>
  value: T
}) {
  return (
    <div className="inline-flex rounded-lg bg-muted p-[3px]" role="group" aria-label={label}>
      {options.map((option) => (
        <Button
          variant="custom"
          size={null}
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          className={cn(
            'rounded-md px-3 py-1 text-xs font-medium text-muted-foreground transition-colors',
            value === option.id && 'bg-background text-foreground shadow-sm'
          )}
        >
          {option.label}
        </Button>
      ))}
    </div>
  )
}

function readRecent(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(stored) ? stored.filter((item) => typeof item === 'string') : []
  } catch {
    return []
  }
}

function writeRecent(urls: string[]) {
  try {
    if (urls.length) localStorage.setItem(RECENT_KEY, JSON.stringify(urls))
    else localStorage.removeItem(RECENT_KEY)
  } catch {
    // Storage is unavailable in some private modes; recents are a convenience.
  }
}

function isTyping(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName) ||
      // A focused menu takes letters as its own type-to-find.
      target.closest('[role="listbox"],[role="combobox"]') !== null)
  )
}

/** This page's address with the check in the query, so it can be shared or reopened. */
function shareUrl(url: string, agent: LinkPreviewAgent): string {
  const share = new URL(window.location.href)
  share.search = ''
  share.searchParams.set('url', url)
  if (agent !== linkPreviewAgentSchema.enum.default) share.searchParams.set('agent', agent)
  return share.toString()
}

function CopyButton({ icon, label, text }: { icon: ReactNode; label: string; text: () => string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        if (!(await copyText(text()))) return
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }}
    >
      {copied ? <Check className="text-emerald-500" /> : icon}
      {copied ? 'Copied' : label}
    </Button>
  )
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 rounded-md bg-muted px-3 py-2 font-mono text-sm">{command}</code>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Copy ${command}`}
        onClick={async () => {
          if (!(await copyText(command))) return
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        }}
      >
        {copied ? <Check className="text-emerald-500" /> : <Copy />}
      </Button>
    </div>
  )
}

function ShortcutsMenu() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          aria-label="Keyboard shortcuts"
          className="hidden sm:inline-flex"
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          ?
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 text-xs">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
          {SHORTCUTS.map(([key, label]) => (
            <Fragment key={key}>
              <dt>
                <kbd className="font-mono">{key}</kbd>
              </dt>
              <dd className="text-muted-foreground">{label}</dd>
            </Fragment>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  )
}

function UrlList({ urls, onPick }: { urls: string[]; onPick: (url: string) => void }) {
  return (
    <ul className="flex flex-wrap gap-x-6 gap-y-2">
      {urls.map((url) => (
        <li key={url}>
          <Button
            variant="custom"
            size={null}
            type="button"
            onClick={() => onPick(url)}
            className="flex items-center gap-2 text-sm text-foreground transition-colors hover:text-foreground/70"
          >
            <span className="text-muted-foreground">›</span>
            {hostname(url)}
          </Button>
        </li>
      ))}
    </ul>
  )
}

/**
 * Paste a URL and see its score and every issue with the fix, its card on
 * thirteen platforms, a live editor that writes the corrected tags, image and
 * crawler checks, and every tag behind them. Or check a batch of links.
 */
export function LinkPreviewApp() {
  const developerMode = useDeveloperMode()
  const [mode, setMode] = useState<z.infer<typeof linkPreviewModeSchema>>(MODE.single)
  const [agent, setAgent] = useState<LinkPreviewAgent>(linkPreviewAgentSchema.enum.default)
  const [input, setInput] = useState('')
  const [url, setUrl] = useState('')
  const [preview, setPreview] = useState<LinkPreview | null>(null)
  const [edits, setEdits] = useState(NO_EDITS)
  const [post, setPost] = useState('')
  const [campaign, setCampaign] = useState('')
  const [content, setContent] = useState('')
  const [compareOpened, setCompareOpened] = useState(false)
  const [theme, setTheme] = useState<PreviewTheme>(previewThemeSchema.enum.dark)
  const [device, setDevice] = useState<PreviewDevice>(previewDeviceSchema.enum.desktop)
  const [history, setHistory] = useState<LinkPreviewSnapshot[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [recent, setRecent] = useState<string[]>([])
  const [tab, setTab] = useState<string>(TAB.overview)
  const [platform, setPlatform] = useState<string>(ALL)
  const inputRef = useRef<HTMLInputElement>(null)
  const pending = useRef<AbortController | null>(null)

  const issues = useMemo(() => (preview ? auditLinkPreview(preview) : []), [preview])
  const edited = useMemo(() => preview && applyEdits(preview, edits), [preview, edits])
  const hasEdits = Object.values(edits).some((value) => value.trim())

  const check = useCallback(async (value: string, as: LinkPreviewAgent, cached?: LinkPreview) => {
    const target = normalizeUrl(value)
    if (!target) {
      setError('Enter a valid http or https URL.')
      return
    }
    if (['localhost', '127.0.0.1', '[::1]'].includes(new URL(target).hostname)) {
      setError(
        'Localhost is only reachable on your computer. Open a tunnel with ngrok http 3000, then preview its public https URL.'
      )
      return
    }
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    setMode(MODE.single)
    setInput(target)
    setUrl(target)
    setPreview(null)
    setEdits(NO_EDITS)
    const draft = readDraft(target)
    setPost(draft.post)
    setCampaign(draft.campaign)
    setContent(draft.content)
    setTab(draft.tab)
    setError('')
    setLoading(true)
    try {
      const result = cached ?? (await requestPreview(target, as, controller.signal))
      if (controller.signal.aborted) return
      setAgent(result.agent ?? as)
      setPreview(result)
      setHistory(
        recordHistory(
          result.url,
          snapshotOf(result, scoreLinkPreview(result).score, auditLinkPreview(result))
        )
      )
      window.history.replaceState(null, '', checkAddress(window.location.href, target, as))
      const next = [target, ...readRecent().filter((item) => item !== target)].slice(0, MAX_RECENT)
      writeRecent(next)
      setRecent(next)
    } catch (caught) {
      if (controller.signal.aborted) return
      setError(caught instanceof Error ? caught.message : 'The page could not be read.')
    } finally {
      if (pending.current === controller) setLoading(false)
    }
  }, [])

  const clear = useCallback(() => {
    pending.current?.abort()
    setInput('')
    setUrl('')
    setPreview(null)
    setEdits(NO_EDITS)
    setError('')
    setLoading(false)
    const address = new URL(window.location.href)
    address.searchParams.delete('url')
    address.searchParams.delete('agent')
    window.history.replaceState(null, '', address)
  }, [])

  useEffect(() => {
    if (!url || !preview || loading) return
    try {
      sessionStorage.setItem(draftKey(url), JSON.stringify({ post, campaign, content, tab }))
    } catch {
      // Storage may be unavailable.
    }
  }, [url, preview, loading, post, campaign, content, tab])

  // Open a shared check: /publish/link-checks?url=…&agent=…
  useEffect(() => {
    setRecent(readRecent())
    const params = new URLSearchParams(window.location.search)
    const shared = params.get('url')
    const sharedAgent = linkPreviewAgentSchema.safeParse(params.get('agent'))
    const as = sharedAgent.success ? sharedAgent.data : linkPreviewAgentSchema.enum.default
    setAgent(as)
    if (shared) check(shared, as)
  }, [check])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        // Leave Escape to menus and dialogs that have focus.
        if (event.target === inputRef.current) clear()
        return
      }
      if (isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key.toLowerCase() === 'r' && url) {
        event.preventDefault()
        check(url, agent)
        return
      }
      if (event.key === '/') {
        event.preventDefault()
        inputRef.current?.focus()
        return
      }
      if (preview && (event.key === '[' || event.key === ']')) {
        const views: string[] = [ALL, ...PLATFORMS.map((item) => item.id)]
        const step = event.key === ']' ? 1 : views.length - 1
        setPlatform((current) => views[(views.indexOf(current) + step) % views.length]!)
        setTab(TAB.previews)
        return
      }
      const digit = Number(event.key)
      if (!preview || !Number.isInteger(digit) || digit < 1) return
      const view = digit === 1 ? ALL : PLATFORMS[digit - 2]?.id
      if (view) {
        setTab(TAB.previews)
        setPlatform(view)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [agent, check, clear, preview, url])

  const idle = !preview && !loading && !error
  /** Try an image in every preview, without changing the page. */
  const tryImage = (image: string) => {
    setEdits((current) => ({ ...current, image }))
    setTab(TAB.previews)
    setPlatform(ALL)
  }
  const pick = (picked: string, cached?: LinkPreview) =>
    check(picked, cached?.agent ?? agent, cached)
  const flagged = issues.filter((issue) => issue.severity !== issueSeveritySchema.enum.info).length

  return (
    <div className="w-full">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg bg-muted p-[3px]" role="group" aria-label="Mode">
          {linkPreviewModeSchema.options.map((option) => (
            <Button
              variant="custom"
              size={null}
              key={option}
              type="button"
              aria-pressed={mode === option}
              onClick={() => {
                if (option === MODE.compare) setCompareOpened(true)
                setMode(option)
              }}
              className={cn(
                'rounded-md px-3 py-1 text-ui-lg font-medium text-muted-foreground transition-colors',
                mode === option && 'bg-background text-foreground shadow-sm'
              )}
            >
              {MODE_LABELS[option]}
            </Button>
          ))}
        </div>
        <Label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          Fetch as
          <Select
            value={agent}
            onValueChange={(nextValue) => setAgent(linkPreviewAgentSchema.parse(nextValue))}
          >
            <SelectTrigger className="rounded-md bg-white/[0.04] px-2 py-1.5 text-sm text-foreground ring-1 ring-white/[0.08] outline-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {linkPreviewAgentSchema.options.map((option) => (
                <SelectItem key={option} value={option}>
                  {option === linkPreviewAgentSchema.enum.default
                    ? 'Preview bot'
                    : `${CRAWLERS[option].name} (${CRAWLERS[option].token})`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Label>
        <ShortcutsMenu />
      </div>

      <div hidden={mode !== MODE.batch}>
        <BatchCheck agent={agent} onOpen={pick} />
      </div>
      <div hidden={mode !== MODE.compare}>
        {compareOpened && <CompareView agent={agent} initialUrl={url} />}
      </div>
      <div hidden={mode !== MODE.single}>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            check(input, agent)
          }}
          className={cn(PANEL, 'flex items-center gap-1 p-2')}
        >
          <Input
            ref={inputRef}
            type="text"
            inputMode="url"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Enter a URL, like example.com"
            aria-label="URL to preview"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="h-11 min-w-0 flex-1 bg-transparent px-3 text-base outline-none placeholder:text-muted-foreground"
          />
          {input && !loading && (
            <Button type="button" variant="ghost" size="icon-sm" onClick={clear} aria-label="Clear">
              <X />
            </Button>
          )}
          {url && !loading && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => check(url, agent)}
              aria-label="Check again"
            >
              <RefreshCw />
            </Button>
          )}
          <Button type="submit" disabled={loading || !input.trim()} className="h-11 px-5">
            {loading && <Loader2 className="animate-spin" />}
            Preview
          </Button>
        </form>

        {idle && (
          <div className="mt-10 space-y-8">
            <div className="space-y-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Try these</p>
              <UrlList urls={EXAMPLES} onPick={pick} />
            </div>
            {recent.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Recent</p>
                  <Button
                    variant="custom"
                    size={null}
                    type="button"
                    onClick={() => {
                      writeRecent([])
                      setRecent([])
                    }}
                    className="flex items-center gap-1 text-xs uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <X className="size-3.5" />
                    Clear
                  </Button>
                </div>
                <UrlList urls={recent} onPick={pick} />
              </div>
            )}
            {developerMode ? (
              <Accordion type="single" collapsible>
                <AccordionItem value="details" className="group space-y-3">
                  <AccordionTrigger className="[&>svg:last-child]:hidden flex cursor-pointer list-none items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground [&::-webkit-details-marker]:hidden">
                    Testing localhost
                    <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180" />
                  </AccordionTrigger>
                  <AccordionContent className="p-0">
                    <p className="pt-3 text-sm text-muted-foreground">
                      Previews are read from our servers, so they cannot reach your machine. Tunnel
                      your local server with ngrok and preview the public URL.
                    </p>
                    <ol className="space-y-3">
                      {LOCALHOST_STEPS.map((step, index) => (
                        <li key={step.label} className="space-y-1.5">
                          <p className="text-xs uppercase text-muted-foreground">
                            {index + 1}. {step.label}
                          </p>
                          {step.command && <CopyCommand command={step.command} />}
                        </li>
                      ))}
                    </ol>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            ) : null}
          </div>
        )}

        {loading && (
          <div className="flex flex-col items-center gap-3 py-24" role="status">
            <Loader2 className="size-8 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Reading the page, its images, and its robots.txt…
            </p>
          </div>
        )}

        {error && !loading && (
          <div className="flex flex-col items-center py-16 text-center">
            <div className="mb-4 flex size-16 items-center justify-center rounded-full bg-destructive/10">
              <AlertCircle className="size-8 text-destructive" />
            </div>
            <h2 className="mb-2 text-xl font-semibold">Unable to fetch preview</h2>
            <p className="max-w-md text-muted-foreground" role="alert">
              {error}
            </p>
            <div className="mt-4 flex gap-2">
              {/* Only a failed fetch retries; a rejected entry has nothing to retry. */}
              {url && input === url ? (
                <Button onClick={() => check(url, agent)}>Try again</Button>
              ) : null}
              <Button onClick={clear} variant="outline">
                Try another URL
              </Button>
            </div>
            {url && (
              <div className="mt-10 w-full text-left">
                <p className="mb-3 text-sm text-muted-foreground">
                  Check whether other platform crawlers can read this URL.
                </p>
                <CrawlerMatrix key={url} url={url} />
              </div>
            )}
          </div>
        )}

        {preview && edited && !loading && (
          <>
            {preview.agent && preview.agent !== agent && (
              <p role="status" className="mt-4 text-sm text-amber-300">
                Results are for{' '}
                {preview.agent === 'default' ? 'Preview bot' : CRAWLERS[preview.agent].name}. Fetch
                as has changed;{' '}
                <Button variant="link" onClick={() => check(url, agent)}>
                  Re-run with {agent === 'default' ? 'Preview bot' : CRAWLERS[agent].name}
                </Button>
              </p>
            )}
            <div className="mt-8 flex flex-wrap items-center gap-2">
              <CopyButton
                icon={<Link2 />}
                label="Copy share link"
                text={() => shareUrl(url, preview.agent ?? agent)}
              />
              <CopyButton
                icon={<FileText />}
                label="Copy report"
                text={() => markdownReport(preview, scoreLinkPreview(preview).score, issues)}
              />
              <a
                href={preview.url}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonVariants({ size: 'sm', variant: 'outline' })}
              >
                <ExternalLink />
                Open page
              </a>
            </div>
            <Tabs value={tab} onValueChange={setTab} className="mt-6 gap-8">
              <div className="space-y-3">
                <div className="overflow-x-auto">
                  <TabsList aria-label="Result" className={TAB_LIST}>
                    {linkPreviewTabSchema.options
                      .filter((value) => PRIMARY_TABS.has(value))
                      .map((value) => (
                        <TabsTrigger key={value} value={value} className={TAB_TRIGGER}>
                          {TAB_LABELS[value]}
                          {value === TAB.overview && flagged > 0 && (
                            <span className="ml-1.5 rounded-full bg-amber-500/15 px-1.5 text-[10px] text-amber-300">
                              {flagged}
                            </span>
                          )}
                          {value === TAB.fix && hasEdits && (
                            <span className="ml-1.5 size-1.5 rounded-full bg-sky-400" />
                          )}
                        </TabsTrigger>
                      ))}
                  </TabsList>
                </div>
                <div className="flex items-center gap-2 overflow-x-auto">
                  <span className="shrink-0 text-xs text-muted-foreground">Advanced</span>
                  <TabsList
                    aria-label="Advanced diagnostics"
                    className="h-auto w-max justify-start gap-1 bg-transparent p-0"
                  >
                    {linkPreviewTabSchema.options
                      .filter((value) => !PRIMARY_TABS.has(value))
                      .map((value) => (
                        <TabsTrigger
                          key={value}
                          value={value}
                          className="h-7 flex-none rounded-md border border-border bg-transparent px-2.5 text-xs text-muted-foreground data-[state=active]:bg-muted data-[state=active]:text-foreground data-[state=active]:shadow-none"
                        >
                          {TAB_LABELS[value]}
                        </TabsTrigger>
                      ))}
                  </TabsList>
                </div>
              </div>
              <TabsContent value={TAB.overview} className="space-y-6">
                <OverviewPanel preview={preview} issues={issues} />
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => setTab(TAB.previews)}>
                    See how it unfurls on each platform
                  </Button>
                  {issues.length > 0 && (
                    <Button size="sm" variant="outline" onClick={() => setTab(TAB.fix)}>
                      Try fixes
                    </Button>
                  )}
                </div>
                <JavaScriptCheck key={preview.url} preview={preview} />
                <HistoryCard entries={history} />
              </TabsContent>
              <TabsContent value={TAB.previews} className="space-y-6">
                {hasEdits && (
                  <p className="flex items-center justify-between rounded-lg bg-sky-500/10 px-4 py-2 text-sm text-sky-200">
                    Showing your edits from the Fix tab.
                    <Button
                      variant="custom"
                      size={null}
                      type="button"
                      onClick={() => setEdits(NO_EDITS)}
                      className="text-xs underline-offset-4 hover:underline"
                    >
                      Show the live page
                    </Button>
                  </p>
                )}
                <PostComposer post={post} onChange={setPost} url={url} />
                <div className="flex flex-wrap gap-2">
                  <Toggle
                    label="Theme"
                    value={theme}
                    onChange={setTheme}
                    options={[
                      { id: previewThemeSchema.enum.dark, label: 'Dark' },
                      { id: previewThemeSchema.enum.light, label: 'Light' },
                    ]}
                  />
                  <Toggle
                    label="Device"
                    value={device}
                    onChange={setDevice}
                    options={[
                      { id: previewDeviceSchema.enum.desktop, label: 'Desktop' },
                      { id: previewDeviceSchema.enum.mobile, label: 'Mobile' },
                    ]}
                  />
                </div>
                <Tabs value={platform} onValueChange={setPlatform} className="gap-8">
                  <div className="overflow-x-auto">
                    <p className="mb-2 text-xs text-muted-foreground sm:hidden">
                      Swipe for more platforms →
                    </p>
                    <TabsList className={TAB_LIST}>
                      <TabsTrigger value={ALL} className={TAB_TRIGGER}>
                        All
                      </TabsTrigger>
                      {PLATFORMS.map((item) => (
                        <TabsTrigger key={item.id} value={item.id} className={TAB_TRIGGER}>
                          {item.name}
                        </TabsTrigger>
                      ))}
                    </TabsList>
                  </div>
                  <TabsContent
                    value={ALL}
                    className={cn(
                      theme === previewThemeSchema.enum.light && 'rounded-2xl bg-[#f3f4f6] p-6'
                    )}
                  >
                    <AllPreviews
                      device={device}
                      post={post}
                      preview={edited}
                      theme={theme}
                      url={url}
                    />
                  </TabsContent>
                  {PLATFORMS.map((item) => (
                    <TabsContent
                      key={item.id}
                      value={item.id}
                      className={cn(
                        theme === previewThemeSchema.enum.light && 'rounded-2xl bg-[#f3f4f6] p-6'
                      )}
                    >
                      <PlatformPreview
                        device={device}
                        platform={item}
                        post={post}
                        preview={edited}
                        theme={theme}
                        url={url}
                      />
                    </TabsContent>
                  ))}
                </Tabs>
                <CacheRefresh url={preview.url} />
              </TabsContent>
              <TabsContent value={TAB.fix}>
                <FixPanel
                  agent={agent}
                  preview={preview}
                  edited={edited}
                  edits={edits}
                  onEdit={setEdits}
                  url={url}
                />
              </TabsContent>
              <TabsContent value={TAB.share}>
                <SharePanel
                  campaign={campaign}
                  content={content}
                  onCampaignChange={setCampaign}
                  onContentChange={setContent}
                  canonical={!!preview.canonical}
                  post={post}
                  url={preview.canonical || preview.url}
                />
              </TabsContent>
              <TabsContent value={TAB.extras}>
                <ExtrasPanel preview={preview} />
              </TabsContent>
              <TabsContent value={TAB.automate}>
                <AutomatePanel url={preview.url} />
              </TabsContent>
              <TabsContent value={TAB.basic}>
                <BasicPanel preview={preview} />
              </TabsContent>
              <TabsContent value={TAB.opengraph}>
                <OpenGraphPanel preview={preview} />
              </TabsContent>
              <TabsContent value={TAB.x}>
                <XCardPanel preview={preview} />
              </TabsContent>
              <TabsContent
                forceMount
                value={TAB.images}
                className="space-y-6 data-[state=inactive]:hidden"
              >
                <ImageStudio preview={preview} url={url} onUse={tryImage} />
                <ImagesPanel preview={preview} onUse={tryImage} />
              </TabsContent>
              <TabsContent value={TAB.technical} className="space-y-6">
                <CrawlerMatrix key={preview.url} url={preview.url} />
                <TechnicalPanel preview={preview} />
              </TabsContent>
              <TabsContent value={TAB.raw}>
                <RawPanel preview={preview} />
              </TabsContent>
            </Tabs>
          </>
        )}
      </div>
    </div>
  )
}
