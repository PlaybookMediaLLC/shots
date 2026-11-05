'use client'

import * as React from 'react'
import { toast } from 'sonner'
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { serializeDraft } from '@/lib/content-drafts/serialize'
import { CAPABILITIES, type AccountStanding } from '@/lib/write/capabilities'
import { VideoOptions } from './video-options'
import { type DraftFinisherWire, writeApi } from '@/lib/write/client'
import {
  type DraftChannel,
  type Numbering,
  numberingPositionSchema,
  numberingStyleSchema,
  type VersionOptions,
} from '@/lib/write/document'
import { threadLabels } from '@/lib/write/numbering'
import { cn } from '@/lib/utils'
import { PdfCarousel } from './pdf-carousel'
import { AutoDmDraft } from './auto-dm-draft'

/** A numbering style as the dialog shows it. */
const STYLE_EXAMPLES: Record<Numbering['style'], string> = {
  dot: '1.',
  emoji: '1️⃣',
  fraction: '1/9',
  hash: '#1',
  leading: '/1',
  of: '1 of 9',
  slash: '1/',
}

/**
 * A platform version's settings bar (RFC 025): on X, numbering, finishers
 * and a community; on LinkedIn, visibility, a first comment and a PDF
 * document. Each is stored with the version and applied when it publishes.
 */
export function VersionOptionsBar({
  captionLimit,
  tiktokCreator,
  channel,
  onApplyFinisher,
  onChange,
  options,
  postCount,
  readOnly,
  setId,
  uploadFile,
}: {
  channel: DraftChannel
  tiktokCreator?: AccountStanding['tiktokCreator']
  captionLimit?: number
  onApplyFinisher?: (text: string, quoteFirstPost: boolean) => void
  onChange: (options: VersionOptions) => void
  options: VersionOptions
  postCount: number
  readOnly: boolean
  setId: string | null
  uploadFile?: (file: File) => Promise<{ assetId: string }>
}) {
  const [dialog, setDialog] = React.useState<'numbering' | 'finisher' | 'community' | null>(null)
  const capabilities = CAPABILITIES[channel]
  const button =
    'h-8 rounded-md border border-border px-3 text-ui text-muted-foreground hover:border-input hover:text-foreground'
  const tools: React.ReactNode[] = []
  // Privacy, consent and YouTube's required fields sit above the post, in the composer.
  if (channel === 'tiktok')
    tools.push(
      <VideoOptions
        key="video"
        channel={channel}
        options={options}
        onChange={onChange}
        disabled={readOnly}
        creator={tiktokCreator}
        part="rest"
      />
    )
  if (capabilities.thread) {
    tools.push(
      <Button
        className={cn(
          button,
          options.numbering?.enabled && 'border-sky-400/40 text-sky-700 dark:text-sky-200'
        )}
        disabled={readOnly}
        key="numbering"
        onClick={() => setDialog('numbering')}
        size={null}
        type="button"
        variant="custom"
      >
        Auto-numbering
        {options.numbering?.enabled ? `: ${STYLE_EXAMPLES[options.numbering.style]}` : ''}
      </Button>
    )
  }
  if (['x', 'bluesky', 'mastodon'].includes(channel) && onApplyFinisher && setId) {
    tools.push(
      <Button
        className={button}
        disabled={readOnly}
        key="finisher"
        onClick={() => setDialog('finisher')}
        size={null}
        type="button"
        variant="custom"
      >
        Closing-post templates
      </Button>
    )
  }
  if (capabilities.settings.community) {
    tools.push(
      <Button
        className={cn(
          button,
          options.community && 'border-sky-400/40 text-sky-700 dark:text-sky-200'
        )}
        disabled={readOnly}
        key="community"
        onClick={() => setDialog('community')}
        size={null}
        type="button"
        variant="custom"
      >
        {options.community
          ? `Community: ${options.community.name || options.community.id}`
          : 'Audience: everyone'}
      </Button>
    )
  }
  if (capabilities.settings.visibility) {
    tools.push(
      <Select
        disabled={readOnly}
        key="visibility"
        onValueChange={(value) =>
          onChange({ ...options, visibility: value === 'PUBLIC' ? undefined : 'CONNECTIONS' })
        }
        value={options.visibility ?? 'PUBLIC'}
      >
        <SelectTrigger aria-label="LinkedIn visibility" className="h-8 w-auto rounded-md text-ui">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="PUBLIC">Visible to anyone</SelectItem>
          <SelectItem value="CONNECTIONS">Connections only</SelectItem>
        </SelectContent>
      </Select>
    )
  }
  if (capabilities.settings.firstComment) {
    tools.push(
      <FirstComment
        key="comment"
        label={capabilities.label}
        onChange={(firstComment) => onChange({ ...options, firstComment })}
        readOnly={readOnly}
        value={options.firstComment ?? ''}
      />
    )
  }
  if (capabilities.settings.pdfDocument) {
    tools.push(
      <PdfDocument
        document={options.document}
        key="pdf"
        onChange={(document) => onChange({ ...options, document })}
        readOnly={readOnly}
        uploadFile={uploadFile}
      />
    )
  }
  if (tools.length === 0) return null
  return (
    <div
      className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3 has-[[data-option-rows]]:p-0"
      data-testid={`version-options-${channel}`}
    >
      {tools}
      {channel === 'x' ? (
        <AutoDmDraft
          value={options.autoDm}
          onChange={(autoDm) => onChange({ ...options, autoDm })}
          readOnly={readOnly}
        />
      ) : null}
      {dialog === 'numbering' ? (
        <NumberingDialog
          numbering={options.numbering}
          onChange={(numbering) => onChange({ ...options, numbering })}
          onClose={() => setDialog(null)}
          postCount={postCount}
        />
      ) : null}
      {dialog === 'finisher' && setId && onApplyFinisher ? (
        <FinisherDialog
          channel={channel}
          captionLimit={captionLimit}
          onApply={onApplyFinisher}
          onClose={() => setDialog(null)}
          setId={setId}
        />
      ) : null}
      {dialog === 'community' ? (
        <CommunityDialog
          setId={setId}
          community={options.community}
          onChange={(community) => onChange({ ...options, community })}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  )
}

/**
 * Auto-numbering: on or off, at the start or end, a style, and how many
 * posts to skip at each end. The preview shows the labels the thread gets;
 * the text itself never holds them.
 */
export function NumberingDialog({
  numbering,
  onChange,
  onClose,
  postCount,
}: {
  numbering?: Numbering
  onChange: (numbering: Numbering | undefined) => void
  onClose: () => void
  postCount: number
}) {
  const current: Numbering = numbering ?? { enabled: false, position: 'end', style: 'fraction' }
  const set = (change: Partial<Numbering>) => onChange({ ...current, ...change })
  const labels = threadLabels(Math.max(postCount, 2), { ...current, enabled: true })
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Auto-numbering</DialogTitle>
          <DialogDescription>
            Numbers are added when the thread is previewed and published, and count toward each
            post’s limit. Your text stays as you wrote it.
          </DialogDescription>
        </DialogHeader>
        <Label className="flex items-center justify-between text-sm">
          Number the thread’s posts
          <Switch
            aria-label="Enable auto-numbering"
            checked={current.enabled}
            onCheckedChange={(checked) => set({ enabled: checked === true })}
          />
        </Label>
        <fieldset className="grid gap-2" disabled={!current.enabled}>
          <Label className="grid gap-1 text-xs text-muted-foreground">
            Position
            <Select
              onValueChange={(value) => set({ position: numberingPositionSchema.parse(value) })}
              value={current.position}
            >
              <SelectTrigger aria-label="Numbering position">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="start">Start of the post</SelectItem>
                <SelectItem value="end">End of the post</SelectItem>
              </SelectContent>
            </Select>
          </Label>
          <div className="grid gap-1">
            <span className="text-xs text-muted-foreground">Format</span>
            <div className="flex flex-wrap gap-1.5">
              {numberingStyleSchema.options.map((style) => (
                <Button
                  aria-pressed={current.style === style}
                  className={cn(
                    'rounded-md border px-2 py-1 text-xs',
                    current.style === style
                      ? 'border-sky-400/60 text-foreground'
                      : 'border-border text-muted-foreground'
                  )}
                  key={style}
                  onClick={() => set({ style })}
                  size={null}
                  type="button"
                  variant="custom"
                >
                  {STYLE_EXAMPLES[style]}
                </Button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Label className="grid gap-1 text-xs text-muted-foreground">
              Skip first posts
              <Input
                aria-label="Skip first posts"
                inputMode="numeric"
                max={24}
                min={0}
                onChange={(event) =>
                  set({
                    skipFirst:
                      Math.max(0, Math.min(24, Number(event.target.value) || 0)) || undefined,
                  })
                }
                type="number"
                value={current.skipFirst ?? 0}
              />
            </Label>
            <Label className="grid gap-1 text-xs text-muted-foreground">
              Skip last posts
              <Input
                aria-label="Skip last posts"
                inputMode="numeric"
                max={24}
                min={0}
                onChange={(event) =>
                  set({
                    skipLast:
                      Math.max(0, Math.min(24, Number(event.target.value) || 0)) || undefined,
                  })
                }
                type="number"
                value={current.skipLast ?? 0}
              />
            </Label>
          </div>
          <p className="text-xs text-muted-foreground" data-testid="numbering-preview">
            This thread: {labels.map((label) => label ?? '—').join('  ')}
          </p>
        </fieldset>
        <DialogFooter>
          <Button onClick={onClose} type="button">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The set's closing-post templates: browse, create, edit, preview, delete, and add
 * one to the end of the thread. One that quotes the first post is resolved
 * to that post only after it is live.
 */
export function FinisherDialog({
  channel = 'x',
  captionLimit,
  onApply,
  onClose,
  setId,
}: {
  channel?: DraftChannel
  captionLimit?: number
  onApply: (text: string, quoteFirstPost: boolean) => void
  onClose: () => void
  setId: string
}) {
  const quoteSupported = ['x', 'bluesky', 'mastodon'].includes(channel)
  const [items, setItems] = React.useState<DraftFinisherWire[] | null>(null)
  const [editing, setEditing] = React.useState<{
    id?: string
    name: string
    quoteFirstPost: boolean
    text: string
  } | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [search, setSearch] = React.useState('')
  const count = serializeDraft(
    [{ type: 'p', children: [{ text: editing?.text ?? '' }] }],
    channel
  ).length
  const limit = captionLimit ?? CAPABILITIES[channel].captionLimit
  React.useEffect(() => {
    void writeApi
      .finishers(setId)
      .then(({ items: found }) => setItems(found))
      .catch((error: unknown) => {
        setItems([])
        toast.error(error instanceof Error ? error.message : 'Finishers could not be read.')
      })
  }, [setId])
  const save = async () => {
    if (!editing) return
    setBusy(true)
    try {
      const fields = {
        name: editing.name,
        text: editing.text,
        quoteFirstPost: editing.quoteFirstPost,
      }
      const saved = editing.id
        ? await writeApi.updateFinisher(setId, editing.id, fields)
        : await writeApi.createFinisher(setId, fields)
      setItems((current) => [...(current ?? []).filter((item) => item.id !== saved.id), saved])
      setEditing(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The finisher could not be saved.')
    } finally {
      setBusy(false)
    }
  }
  const remove = async (id: string) => {
    setBusy(true)
    try {
      await writeApi.deleteFinisher(setId, id)
      setItems((current) => (current ?? []).filter((item) => item.id !== id))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The finisher could not be deleted.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Closing-post templates</DialogTitle>
          <DialogDescription>
            A closing post that asks readers to follow or engage. Your finishers belong to this
            profile. Nothing is ever added to a draft without you choosing it.
          </DialogDescription>
        </DialogHeader>
        {editing ? (
          <div className="grid gap-2">
            <Label className="grid gap-1 text-xs text-muted-foreground">
              Name
              <Input
                maxLength={80}
                onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                value={editing.name}
              />
            </Label>
            <Label className="grid gap-1 text-xs text-muted-foreground">
              <span className="flex justify-between">
                Text
                <span className={cn(count > limit && 'text-red-700 dark:text-red-300')}>
                  {count}/{limit}
                </span>
              </span>
              <Textarea
                className="min-h-24"
                maxLength={25_000}
                onChange={(event) => setEditing({ ...editing, text: event.target.value })}
                value={editing.text}
              />
            </Label>
            <Label className="flex items-center justify-between text-sm">
              <span>
                Quote the first post
                <span className="block text-label text-muted-foreground">
                  Added once the first post is live.
                </span>
              </span>
              <Switch
                aria-label="Quote the first post"
                disabled={!quoteSupported}
                checked={editing.quoteFirstPost}
                onCheckedChange={(checked) =>
                  setEditing({ ...editing, quoteFirstPost: checked === true })
                }
              />
            </Label>
            <FinisherPreview quoteFirstPost={editing.quoteFirstPost} text={editing.text} />
            <div className="flex justify-end gap-2">
              <Button onClick={() => setEditing(null)} type="button" variant="ghost">
                Cancel
              </Button>
              <Button
                disabled={busy || !editing.name.trim() || !editing.text.trim()}
                onClick={() => void save()}
                type="button"
              >
                Save finisher
              </Button>
            </div>
          </div>
        ) : (
          <>
            {items === null ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
            {items?.length === 0 ? (
              <p className="text-sm text-muted-foreground">No finishers yet.</p>
            ) : null}
            <Input
              aria-label="Search finishers"
              placeholder="Search finishers…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <ul className="grid gap-2">
              {items
                ?.filter((item) =>
                  `${item.name} ${item.text}`
                    .toLocaleLowerCase()
                    .includes(search.trim().toLocaleLowerCase())
                )
                .map((item) => (
                  <li
                    className="rounded-lg border border-border p-3"
                    data-testid="finisher"
                    key={item.id}
                  >
                    <p className="flex items-center justify-between text-sm text-foreground">
                      {item.name}
                      {item.quoteFirstPost ? (
                        <span className="text-label text-sky-700 dark:text-sky-300">
                          quotes the first post
                        </span>
                      ) : null}
                    </p>
                    <FinisherPreview quoteFirstPost={item.quoteFirstPost} text={item.text} />
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <Button
                        onClick={() => {
                          onApply(item.text, item.quoteFirstPost)
                          onClose()
                        }}
                        size="sm"
                        type="button"
                      >
                        Add to current draft
                      </Button>
                      <Button
                        onClick={() => setEditing({ ...item })}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        Edit
                      </Button>
                      <Button
                        className="text-red-700 dark:text-red-300"
                        disabled={busy}
                        onClick={() => void remove(item.id)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        Delete
                      </Button>
                    </div>
                  </li>
                ))}
            </ul>
            <DialogFooter>
              <Button
                onClick={() => setEditing({ name: '', quoteFirstPost: quoteSupported, text: '' })}
                type="button"
                variant="outline"
              >
                Create new template
              </Button>
              <Button onClick={onClose} type="button">
                Close
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** A finisher as it will post, with the quoted first post shown as a placeholder. */
function FinisherPreview({ quoteFirstPost, text }: { quoteFirstPost: boolean; text: string }) {
  return (
    <div className="mt-2 rounded-lg bg-foreground/[0.03] p-2 text-sm text-foreground">
      <p className="whitespace-pre-wrap">{text || ' '}</p>
      {quoteFirstPost ? (
        <p className="mt-2 rounded-md border border-dashed border-input px-2 py-1 text-xs text-muted-foreground">
          First post quote… (linked once the first post is live)
        </p>
      ) : null}
    </div>
  )
}

const COMMUNITY_URL = /^(?:https:\/\/(?:x|twitter)\.com\/i\/communities\/)?(\d{1,30})\/?$/

/** Post the X version to a community, by its URL or id, and choose whether followers see it too. */
function CommunityDialog({
  setId,
  community,
  onChange,
  onClose,
}: {
  setId: string | null
  community?: VersionOptions['community']
  onChange: (community: VersionOptions['community']) => void
  onClose: () => void
}) {
  const [value, setValue] = React.useState(community?.id ?? '')
  const [name, setName] = React.useState(community?.name ?? '')
  const [shareWithFollowers, setShareWithFollowers] = React.useState(
    community?.shareWithFollowers ?? true
  )
  const [query, setQuery] = React.useState('')
  const [results, setResults] = React.useState<{ id: string; name: string }[] | null>(null)
  const [searching, setSearching] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const id = COMMUNITY_URL.exec(value.trim())?.[1]
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Audience</DialogTitle>
          <DialogDescription>
            Everyone (Anyone on X) is the default audience. Community posts remain visible to
            everyone on X. Who can reply is set per post.
          </DialogDescription>
        </DialogHeader>
        <Label className="grid gap-1 text-xs text-muted-foreground">
          Community URL or id
          <Input
            onChange={(event) => setValue(event.target.value)}
            placeholder="https://x.com/i/communities/1493446837214187523"
            value={value}
          />
        </Label>
        {value && !id ? (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            Use a community’s URL or its numeric id.
          </p>
        ) : null}
        {setId ? (
          <form
            className="grid gap-2"
            onSubmit={async (event) => {
              event.preventDefault()
              if (searching) return
              setSearching(true)
              setError(null)
              try {
                setResults((await writeApi.communities(setId, query)).items)
              } catch (error) {
                setResults(null)
                setError(
                  error instanceof Error ? error.message : 'Community search is unavailable.'
                )
              } finally {
                setSearching(false)
              }
            }}
          >
            <Label htmlFor="community-search">Search X communities</Label>
            <div className="flex gap-2">
              <Input
                id="community-search"
                maxLength={200}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by topic or name"
              />
              <Button disabled={searching || !query.trim()} type="submit">
                {searching ? 'Searching…' : 'Search'}
              </Button>
            </div>
            {error ? (
              <p role="alert" className="text-xs text-red-700 dark:text-red-300">
                {error}
              </p>
            ) : null}
            {results?.length === 0 ? (
              <p role="status" className="text-xs">
                No communities found.
              </p>
            ) : null}
            <div className="grid max-h-36 gap-1 overflow-auto">
              {results?.map((item) => (
                <Button
                  className="justify-start"
                  variant="ghost"
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setValue(item.id)
                    setName(item.name)
                  }}
                >
                  {item.name}
                </Button>
              ))}
            </div>
          </form>
        ) : null}
        <Label className="grid gap-1 text-xs text-muted-foreground">
          Name, for your reference
          <Input maxLength={200} onChange={(event) => setName(event.target.value)} value={name} />
        </Label>
        <Label className="flex items-center justify-between gap-3 text-sm">
          <span>
            Share to timeline
            <span className="block text-xs text-muted-foreground">
              Also share with your followers. Turning this off stops that broadcast; the community
              post remains public.
            </span>
          </span>
          <Switch
            aria-label="Share to timeline"
            checked={shareWithFollowers}
            onCheckedChange={setShareWithFollowers}
          />
        </Label>
        <DialogFooter>
          {community ? (
            <Button
              className="mr-auto"
              onClick={() => {
                onChange(undefined)
                onClose()
              }}
              type="button"
              variant="ghost"
            >
              Post to everyone
            </Button>
          ) : null}
          <Button
            disabled={!id}
            onClick={() => {
              if (id) onChange({ id, name: name.trim() || undefined, shareWithFollowers })
              onClose()
            }}
            type="button"
          >
            Post to this community
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** A first comment, posted under the post once it is live. */
function FirstComment({
  label,
  onChange,
  readOnly,
  value,
}: {
  label: string
  onChange: (value: string | undefined) => void
  readOnly: boolean
  value: string
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          className={cn(
            'h-8 rounded-md border border-border px-3 text-ui text-muted-foreground hover:text-foreground',
            value && 'border-sky-400/40 text-sky-700 dark:text-sky-200'
          )}
          disabled={readOnly}
          size={null}
          type="button"
          variant="custom"
        >
          {value ? 'First comment ✓' : `Add ${label} comment`}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="grid w-80 gap-2 p-3">
        <Label className="grid gap-1 text-xs text-muted-foreground">
          <span className="flex justify-between">
            Comment below the post
            <span>{[...value].length}/1250</span>
          </span>
          <Textarea
            aria-label="First comment"
            className="min-h-20"
            maxLength={1250}
            onChange={(event) => onChange(event.target.value || undefined)}
            value={value}
          />
        </Label>
        <p className="text-label text-muted-foreground">
          Posted after the post is live. If it fails, the post stays published and the comment shows
          as failed.
        </p>
      </PopoverContent>
    </Popover>
  )
}

/** A PDF uploaded as a LinkedIn document carousel: up to 100 MB and 300 pages. */
function PdfDocument({
  document,
  onChange,
  readOnly,
  uploadFile,
}: {
  document?: VersionOptions['document']
  onChange: (document: VersionOptions['document']) => void
  readOnly: boolean
  uploadFile?: (file: File) => Promise<{ assetId: string }>
}) {
  const input = React.useRef<HTMLInputElement>(null)
  const [state, setState] = React.useState<'idle' | 'uploading' | 'failed'>('idle')
  const [preview, setPreview] = React.useState(false)
  const choose = async (file: File) => {
    if (file.type !== 'application/pdf') return toast.error('Choose a PDF file.')
    if (file.size > 100 * 1024 * 1024)
      return toast.error('LinkedIn takes documents of up to 100 MB.')
    if (!uploadFile) return
    setState('uploading')
    try {
      const { assetId } = await uploadFile(file)
      onChange({ assetId, title: file.name.replace(/\.pdf$/i, '').slice(0, 200) })
      setState('idle')
    } catch (error) {
      setState('failed')
      toast.error(error instanceof Error ? error.message : 'The PDF could not be uploaded.')
    }
  }
  return (
    <>
      <Button
        className={cn(
          'h-8 rounded-md border border-border px-3 text-ui text-muted-foreground hover:text-foreground',
          document && 'border-sky-400/40 text-sky-700 dark:text-sky-200',
          state === 'failed' && 'border-red-400/40 text-red-700 dark:text-red-200'
        )}
        disabled={readOnly || state === 'uploading'}
        onClick={() => (document ? setPreview(true) : input.current?.click())}
        size={null}
        type="button"
        variant="custom"
      >
        {state === 'uploading'
          ? 'Uploading PDF…'
          : state === 'failed'
            ? 'PDF failed: retry'
            : document
              ? `PDF: ${document.title ?? 'document'}`
              : 'Add PDF carousel'}
      </Button>
      <Input
        accept="application/pdf"
        aria-label="PDF document"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void choose(file)
        }}
        ref={input}
        type="file"
      />
      {preview && document ? (
        <Dialog onOpenChange={setPreview} open>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>{document.title ?? 'PDF carousel'}</DialogTitle>
              <DialogDescription>
                How the document pages read on LinkedIn. The shaded edges are where LinkedIn draws
                its own controls: keep important content clear of them.
              </DialogDescription>
            </DialogHeader>
            <PdfCarousel assetId={document.assetId} />
            <Label className="grid gap-1 text-xs text-muted-foreground">
              Document title
              <Input
                maxLength={200}
                onChange={(event) => onChange({ ...document, title: event.target.value })}
                value={document.title ?? ''}
              />
            </Label>
            <DialogFooter>
              <Button
                className="mr-auto text-red-700 dark:text-red-300"
                onClick={() => {
                  onChange(undefined)
                  setPreview(false)
                }}
                type="button"
                variant="ghost"
              >
                Remove PDF
              </Button>
              <Button onClick={() => input.current?.click()} type="button" variant="outline">
                Replace
              </Button>
              <Button onClick={() => setPreview(false)} type="button">
                Done
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  )
}
