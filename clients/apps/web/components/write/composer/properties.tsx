'use client'

import { useWriteRouter } from '@/components/write/write-context'

import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { CHANNEL_META, ChannelIcon } from '@/components/drafts/channel-meta'
import { LocalTime } from '@/components/drafts/local-time'
import { call, type DraftWire } from '@/lib/content-drafts/client'
import { type DraftActivityWire, writeApi } from '@/lib/write/client'
import type { Publication } from '@/lib/write/publication'
import { cn } from '@/lib/utils'
import { TagChip, TagManager } from '../tags'
import { useWrite } from '../write-context'

/** Words in plain text. */
export function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0
}

/** Reading time at 238 words a minute, rounded to the next 5 seconds. */
export function readingSeconds(words: number): number {
  return Math.ceil(((words / 238) * 60) / 5) * 5
}

/** An activity event's action as a person reads it. */
const ACTIONS: Record<string, string> = {
  'post.reconciled_live': 'Marked a post as live',
  'post.reconciled_not_live': 'Marked a post as not published',
  'post.retried': 'Retried a destination',
  'post.thread_resumed': 'Posted the rest of a thread',
  'product.content_draft_created': 'Created the draft',
  'product.content_draft_deleted': 'Deleted the draft',
  'product.content_draft_planned': 'Changed the plan',
  'product.content_draft_properties_updated': 'Organized the draft',
  'product.content_draft_recovered': 'Recovered a backup as a new draft',
  'product.content_draft_review': 'Review step',
  'product.content_draft_scheduled': 'Scheduled',
  'product.content_draft_shared': 'Changed sharing',
  'product.content_draft_updated': 'Edited',
  'post.cancelled': 'Cancelled a post',
  'post.scheduled': 'Queued a post',
  'post.published': 'Published a post',
  'post.publish_failed': 'A post failed',
  'post.publish_recovery_required': 'A post’s outcome is unknown',
}

/** What an event changed, from its references. */
function detail(item: DraftActivityWire): string {
  const metadata = item.metadata
  const changed = Array.isArray(metadata.changed) ? (metadata.changed as string[]) : []
  if (changed.length > 0) return changed.join(', ').replaceAll('_', ' ')
  if (typeof metadata.enabled === 'boolean')
    return metadata.enabled ? 'public link on' : 'public link off'
  if (metadata.cleared) return 'plan cleared'
  if (typeof metadata.plannedFor === 'string')
    return `for ${new Date(metadata.plannedFor).toLocaleString()}`
  if (typeof metadata.reason === 'string' && metadata.reason !== 'schedule') return metadata.reason
  if (typeof metadata.action === 'string') return metadata.action
  return ''
}

/**
 * The draft's properties (RFC 025): its internal title, tags, scratchpad,
 * id, counts, times, status and activity. The title, tags and scratchpad
 * are internal and never part of a post. A platform's count is shown beside
 * the plain counts, so an over-limit X post is never hidden by a green one.
 */
export function PropertiesPanel({
  aiEnabled = false,
  canEdit,
  draft,
  plainText,
  publications,
  status,
  title,
  onTitle,
}: {
  /** Offer a title written by AI, from the draft's text. */
  aiEnabled?: boolean
  canEdit: boolean
  draft: DraftWire
  plainText: string
  publications: { channel: Publication['serialized']['channel']; publication: Publication }[]
  /** The status the header shows, derived from the draft's posts. */
  status: string
  title: string
  onTitle: (title: string) => void
}) {
  const router = useWriteRouter()
  const { data } = useWrite()
  const [scratchpad, setScratchpad] = React.useState(draft.scratchpad)
  const [tagIds, setTagIds] = React.useState(draft.tagIds)
  const [managing, setManaging] = React.useState(false)
  const [activity, setActivity] = React.useState<DraftActivityWire[] | null>(null)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const [naming, setNaming] = React.useState(false)
  const [skipSlack,setSkipSlack] = React.useState(Boolean(draft.suppressSlackOnPublish))
  const [savingSlack,setSavingSlack] = React.useState(false)
  React.useEffect(() => setSkipSlack(Boolean(draft.suppressSlackOnPublish)),[draft.suppressSlackOnPublish])
  const setId = draft.socialSetId ?? data.sets.find((set) => set.visibility === 'WORKSPACE')?.id
  const tags = data.sets.find((set) => set.id === setId)?.id === data.activeSet?.id ? data.tags : []
  React.useEffect(() => {
    void writeApi
      .activity(draft.id)
      .then(({ items }) => setActivity(items))
      .catch(() => setActivity([]))
  }, [draft.id, draft.version])
  React.useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])
  const saveScratchpad = (value: string) => {
    setScratchpad(value)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      void writeApi
        .properties(draft.id, { scratchpad: value })
        .catch((error: unknown) =>
          toast.error(error instanceof Error ? error.message : 'The scratchpad was not saved.')
        )
    }, 600)
  }
  const toggleTag = async (id: string) => {
    const on = tagIds.includes(id)
    try {
      const saved = await writeApi.properties(
        draft.id,
        on ? { removeTagIds: [id] } : { addTagIds: [id] }
      )
      setTagIds(saved.tagIds)
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The tag did not change.')
    }
  }
  const words = wordCount(plainText)
  const seconds = readingSeconds(words)
  return (
    <div className="flex flex-col gap-5 p-4 text-sm" data-testid="properties-panel">
      <Label className="flex items-center justify-between gap-3">
        <span>Skip Slack publish notice<span className="block text-xs text-muted-foreground">Only this draft’s shared-channel success notice. Failure alerts and personal notifications still follow workspace rules.</span></span>
        <Switch aria-label="Skip Slack publish notice" checked={skipSlack} disabled={!canEdit || savingSlack} onCheckedChange={(suppressSlackOnPublish) => {
          setSavingSlack(true)
          void writeApi.properties(draft.id,{suppressSlackOnPublish}).then((saved) => {setSkipSlack(Boolean(saved.suppressSlackOnPublish));router.refresh()}).catch((error:unknown) => toast.error(error instanceof Error ? error.message : 'The notification preference was not saved.')).finally(() => setSavingSlack(false))
        }}/>
      </Label>
      <Label className="grid gap-1 text-xs text-muted-foreground">
        Internal title
        <Input
          aria-label="Internal title"
          disabled={!canEdit}
          maxLength={200}
          onChange={(event) => onTitle(event.target.value)}
          value={title}
        />
        <span className="flex items-center justify-between text-[11px] text-muted-foreground">
          Only you and your team see it; it is never posted.
          {aiEnabled && canEdit ? (
            <Button
              className="text-sky-700 dark:text-sky-300 hover:text-sky-800 dark:hover:text-sky-200"
              disabled={naming || !plainText.trim()}
              onClick={async () => {
                setNaming(true)
                try {
                  const answer = await call<{ texts: string[] }>('/api/v1/content-drafts/refine', {
                    body: {
                      action: 'title',
                      channel: draft.primaryPlatform,
                      limit: 80,
                      scope: 'draft',
                      socialSetId: setId,
                      texts: [plainText.slice(0, 20_000)],
                    },
                    method: 'POST',
                  })
                  onTitle(answer.texts[0])
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : 'The AI could not answer.')
                } finally {
                  setNaming(false)
                }
              }}
              size={null}
              type="button"
              variant="custom"
            >
              {naming ? 'Writing…' : 'Generate title'}
            </Button>
          ) : null}
        </span>
      </Label>
      {data.experiments.tags ? (
        <div className="grid gap-1.5">
          <span className="text-xs text-muted-foreground">Tags</span>
          <div className="flex flex-wrap items-center gap-1">
            {tags
              .filter((tag) => tagIds.includes(tag.id))
              .map((tag) => (
                <TagChip key={tag.id} tag={tag} />
              ))}
            {canEdit ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    className="h-8 rounded-md border border-border px-3 text-ui text-muted-foreground hover:text-foreground"
                    size={null}
                    type="button"
                    variant="custom"
                  >
                    + Tag
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  {tags.length === 0 ? (
                    <DropdownMenuItem disabled>No tags in this set yet</DropdownMenuItem>
                  ) : null}
                  {tags.map((tag) => (
                    <DropdownMenuCheckboxItem
                      checked={tagIds.includes(tag.id)}
                      key={tag.id}
                      onCheckedChange={() => void toggleTag(tag.id)}
                    >
                      <TagChip tag={tag} />
                    </DropdownMenuCheckboxItem>
                  ))}
                  {setId ? (
                    <DropdownMenuItem onSelect={() => setManaging(true)}>
                      Manage tags…
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </div>
      ) : null}
      <Label className="grid gap-1 text-xs text-muted-foreground">
        Scratchpad
        <Textarea
          aria-label="Scratchpad"
          className="min-h-24"
          disabled={!canEdit}
          maxLength={20_000}
          onChange={(event) => saveScratchpad(event.target.value)}
          placeholder="Notes, links and ideas. Never part of the post."
          value={scratchpad}
        />
      </Label>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
        <dt className="text-muted-foreground">Words</dt>
        <dd data-testid="word-count">{words}</dd>
        <dt className="text-muted-foreground">Characters</dt>
        <dd data-testid="character-count">{[...plainText].length}</dd>
        <dt className="text-muted-foreground">Reading time</dt>
        <dd>{seconds < 60 ? `${seconds} seconds` : `${Math.round(seconds / 60)} min`}</dd>
        {publications.map(({ channel, publication }) => {
          const over = publication.serialized.posts.some(
            (post) => post.length > publication.serialized.limit
          )
          return (
            <React.Fragment key={channel}>
              <dt className="flex items-center gap-1 text-muted-foreground">
                <ChannelIcon channel={channel} /> {CHANNEL_META[channel].label}
              </dt>
              <dd className={cn(over && 'text-red-700 dark:text-red-300')} data-testid={`platform-count-${channel}`}>
                {publication.serialized.posts.length > 1
                  ? `longest post ${publication.serialized.length} of ${publication.serialized.limit}`
                  : `${publication.serialized.length} of ${publication.serialized.limit}`}
                {over ? ' — over the limit' : ''}
              </dd>
            </React.Fragment>
          )
        })}
        <dt className="text-muted-foreground">Draft id</dt>
        <dd className="flex items-center gap-1">
          <code className="truncate text-[11px] text-foreground">{draft.id}</code>
          <Button
            aria-label="Copy the draft id"
            className="text-[11px] text-sky-700 dark:text-sky-300"
            onClick={() => {
              void navigator.clipboard.writeText(draft.id)
              toast.success('Draft id copied.')
            }}
            size={null}
            type="button"
            variant="custom"
          >
            Copy
          </Button>
        </dd>
        <dt className="text-muted-foreground">Created</dt>
        <dd>
          <LocalTime value={draft.createdAt} />
        </dd>
        <dt className="text-muted-foreground">Updated</dt>
        <dd>
          <LocalTime value={draft.updatedAt} />
        </dd>
        <dt className="text-muted-foreground">Status</dt>
        <dd data-testid="properties-status">{status}</dd>
      </dl>
      <section>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Activity
        </h3>
        {activity === null ? <p className="text-xs text-muted-foreground">Loading…</p> : null}
        <ol className="grid gap-2" data-testid="activity">
          {activity?.map((item) => (
            <li className="text-xs" key={item.id}>
              <p className="text-foreground">
                {ACTIONS[item.action] ?? item.action.replace(/^product\./, '').replaceAll('_', ' ')}
                {detail(item) ? <span className="text-muted-foreground"> · {detail(item)}</span> : null}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {item.actorName ?? (item.actorType === 'SERVICE' ? 'Publishing' : 'Someone')} ·{' '}
                <LocalTime value={item.at} />
              </p>
            </li>
          ))}
        </ol>
      </section>
      {managing && setId ? <TagManager onClose={() => setManaging(false)} setId={setId} /> : null}
    </div>
  )
}
