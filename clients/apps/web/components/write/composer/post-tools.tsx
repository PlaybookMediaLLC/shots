'use client'

import * as React from 'react'
import { GroupIcon, InfoIcon, PollIcon, PublicIcon } from '@/components/platform-shell/icons'
import { useEditorRef } from '@shots/platejs-editor/platejs/react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { CHANNEL_META } from '@/components/drafts/channel-meta'
import { postRanges, setPostSettings } from '@/components/drafts/thread'
import {
  CAPABILITIES,
  pollProblems,
  pollRules,
  type AccountStanding,
} from '@/lib/write/capabilities'
import {
  type DraftChannel,
  type PostPoll,
  type PostSettings,
  replySettingsSchema,
} from '@/lib/write/document'
import { cn } from '@/lib/utils'
import { copyPollOptions, type PollSource } from '@/lib/write/poll-copy'

/** Who-can-reply choices as X names them. */
const REPLY_LABELS: Record<PostSettings['replySettings'] & string, string> = {
  everyone: 'Everyone',
  following: 'Accounts you follow',
  mentionedUsers: 'Only accounts you mention',
  subscribers: 'Your subscribers',
  verified: 'Verified accounts',
}

/** A post's poll or audience settings, asked for from a command (the slash menu). */
export type PostSettingRequest = { at: number; number: number; setting: 'audience' | 'poll' }

/** The latest request; each tool opens when one names its post. */
export const PostSettingRequestContext = React.createContext<PostSettingRequest | null>(null)

/** A settings popover's open state, which a matching request also opens. */
function useRequestedOpen(number: number, setting: PostSettingRequest['setting']) {
  const request = React.useContext(PostSettingRequestContext)
  const [open, setOpen] = React.useState(false)
  React.useEffect(() => {
    if (request?.number === number && request.setting === setting) setOpen(true)
  }, [number, request, setting])
  return [open, setOpen] as const
}

/** A duration in minutes as a person reads it. */
function durationLabel(minutes: number): string {
  if (minutes === 0) return 'Set by the platform'
  if (minutes < 60) return `${minutes} minutes`
  if (minutes < 1_440) return `${minutes / 60} hour${minutes === 60 ? '' : 's'}`
  const days = minutes / 1_440
  return days === 7 ? '1 week' : days === 14 ? '2 weeks' : `${days} day${days === 1 ? '' : 's'}`
}

/**
 * A post's settings for the platform being edited (RFC 025): on X, who can
 * reply, its labels, a poll on the first post, and, on later posts, quoting
 * the first post; on LinkedIn, a poll. Audience, reply permissions and
 * labels stay separate settings.
 */
export function PostSettingsTools({
  channel,
  number,
  settings,
  standing,
  pollSources,
}: {
  channel: DraftChannel
  number: number
  settings: PostSettings
  standing?: AccountStanding
  pollSources?: PollSource[]
}) {
  const editor = useEditorRef()
  const capabilities = CAPABILITIES[channel]
  const set = (change: Partial<PostSettings>) => setPostSettings(editor, number, change)
  const tools: React.ReactNode[] = []
  if (capabilities.settings.replySettings || capabilities.settings.disclosures) {
    tools.push(
      <AudienceTools
        channel={channel}
        key="audience"
        number={number}
        set={set}
        settings={settings}
      />
    )
  }
  if (pollRules(channel, standing) && (number === 1 || capabilities.thread)) {
    tools.push(
      <PollTool
        channel={channel}
        number={number}
        standing={standing}
        key="poll"
        set={set}
        settings={settings}
        pollSources={pollSources}
      />
    )
  }
  if (['bluesky', 'mastodon'].includes(channel) && number > 1) {
    tools.push(
      <Button
        key="quote"
        size="sm"
        variant="ghost"
        aria-pressed={Boolean(settings.quoteFirstPost)}
        onClick={() => set({ quoteFirstPost: !settings.quoteFirstPost })}
      >
        Quote the first post
      </Button>
    )
  }
  return <>{tools}</>
}

/** Who can reply and the content labels, with a way to apply them to every post. */
function AudienceTools({
  channel,
  number,
  set,
  settings,
}: {
  channel: DraftChannel
  number: number
  set: (change: Partial<PostSettings>) => void
  settings: PostSettings
}) {
  const editor = useEditorRef()
  const replies = settings.replySettings ?? 'everyone'
  const labelled = settings.disclosures?.madeWithAi || settings.disclosures?.paidPartnership
  const count = postRanges(editor.children).length
  const applyToAll = () => {
    for (let post = 1; post <= count; post += 1) {
      setPostSettings(editor, post, { replySettings: replies === 'everyone' ? undefined : replies })
    }
  }
  const [open, setOpen] = useRequestedOpen(number, 'audience')
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-label={`Audience and disclosures for post ${number}`}
          className={cn(
            'flex h-6 items-center justify-center rounded-md px-1.5 text-[11px] hover:bg-foreground/[0.06]',
            replies !== 'everyone' || labelled
              ? 'text-sky-700 dark:text-sky-300'
              : 'text-muted-foreground hover:text-foreground'
          )}
          size={null}
          title="Audience & disclosures"
          type="button"
          variant="custom"
        >
          {replies !== 'everyone' ? (
            <GroupIcon aria-hidden size={15} />
          ) : (
            <PublicIcon aria-hidden size={15} />
          )}
          {labelled ? <InfoIcon aria-hidden className="ms-0.5" size={13} /> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-72 flex-col gap-3 p-3 text-sm">
        {CAPABILITIES[channel].settings.replySettings ? (
          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground" htmlFor={`replies-${number}`}>
              Who can reply
            </Label>
            <Select
              onValueChange={(value) =>
                set({
                  replySettings:
                    value === 'everyone' ? undefined : replySettingsSchema.parse(value),
                })
              }
              value={replies}
            >
              <SelectTrigger aria-label="Who can reply" id={`replies-${number}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {replySettingsSchema.options.map((option) => (
                  <SelectItem key={option} value={option}>
                    {REPLY_LABELS[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              Who can reply never changes who can see the post.
            </p>
            {count > 1 ? (
              <Button
                className="justify-self-start"
                onClick={applyToAll}
                size="sm"
                type="button"
                variant="ghost"
              >
                Apply to all posts
              </Button>
            ) : null}
          </div>
        ) : null}
        {CAPABILITIES[channel].settings.disclosures ? (
          <fieldset className="grid gap-2 border-t border-border pt-3">
            <legend className="mb-1 text-xs text-muted-foreground">Content disclosures</legend>
            <Label className="flex items-center justify-between gap-2 text-sm">
              Paid partnership
              <Switch
                aria-label="Paid partnership"
                checked={Boolean(settings.disclosures?.paidPartnership)}
                onCheckedChange={(checked) =>
                  set({
                    disclosures: {
                      ...settings.disclosures,
                      paidPartnership: checked === true || undefined,
                    },
                  })
                }
              />
            </Label>
            <Label className="flex items-center justify-between gap-2 text-sm">
              Made with AI
              <Switch
                aria-label="Made with AI"
                checked={Boolean(settings.disclosures?.madeWithAi)}
                onCheckedChange={(checked) =>
                  set({
                    disclosures: {
                      ...settings.disclosures,
                      madeWithAi: checked === true || undefined,
                    },
                  })
                }
              />
            </Label>
          </fieldset>
        ) : null}
        {['x', 'bluesky'].includes(channel) && number > 1 ? (
          <Label className="flex items-center justify-between gap-2 border-t border-border pt-3 text-sm">
            <span>
              Quote the first post
              <span className="block text-[11px] text-muted-foreground">
                Resolved once the first post is live.
              </span>
            </span>
            <Switch
              aria-label="Quote the first post"
              checked={Boolean(settings.quoteFirstPost)}
              onCheckedChange={(checked) => set({ quoteFirstPost: checked === true || undefined })}
            />
          </Label>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

/** A poll on the first post, with the platform's own rules. */
function PollTool({
  pollSources,
  standing,
  channel,
  number,
  set,
  settings,
}: {
  channel: DraftChannel
  number: number
  set: (change: Partial<PostSettings>) => void
  settings: PostSettings
  standing?: AccountStanding
  pollSources?: PollSource[]
}) {
  const rules = pollRules(channel, standing)
  const [open, setOpen] = useRequestedOpen(number, 'poll')
  if (!rules) return null
  const poll = settings.poll
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-label={poll ? 'Edit the poll' : 'Add a poll'}
          className={cn(
            'flex h-6 items-center justify-center rounded-md px-1.5 text-[11px] hover:bg-foreground/[0.06]',
            poll ? 'text-sky-700 dark:text-sky-300' : 'text-muted-foreground hover:text-foreground'
          )}
          size={null}
          title={poll ? 'Edit poll' : 'Add poll'}
          type="button"
          variant="custom"
        >
          <PollIcon aria-hidden size={15} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto p-3"
      >
        {poll ? (
          <>
            <PollEditor
              channel={channel}
              standing={standing}
              onChange={(next) => set({ poll: next ?? undefined })}
              poll={poll}
            />
            {pollSources?.length ? (
              <div className="mt-3 border-t border-border pt-3">
                <Select
                  value=""
                  onValueChange={(key) => {
                    const source = pollSources.find((item) => item.key === key)
                    if (source) set({ poll: copyPollOptions(source.poll, poll) })
                  }}
                >
                  <SelectTrigger aria-label="Copy poll options from">
                    <SelectValue placeholder="Copy options from…" />
                  </SelectTrigger>
                  <SelectContent>
                    {pollSources.map((source) => (
                      <SelectItem key={source.key} value={source.key}>
                        {source.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="mt-1 text-xs text-muted-foreground">
                  Replaces only the choices. Your question and duration stay as set.
                </p>
              </div>
            ) : null}
          </>
        ) : (
          <div className="grid gap-2 text-sm">
            <p className="text-foreground">{CHANNEL_META[channel].label} poll</p>
            <p className="text-xs text-muted-foreground">
              {rules.question === 'post-text'
                ? 'The post’s text is the question.'
                : `A question of up to ${rules.questionLimit} characters.`}{' '}
              {rules.minOptions}–{rules.maxOptions} options of up to {rules.maxOptionLength}{' '}
              characters. No media beside it.
            </p>
            <Button
              onClick={() =>
                set({
                  poll: {
                    durationMinutes: rules.durationsMinutes.includes(1_440)
                      ? 1_440
                      : rules.durationsMinutes[0],
                    options: ['', ''],
                    ...(rules.question === 'field' ? { question: '' } : {}),
                  },
                })
              }
              size="sm"
              type="button"
            >
              Add poll
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** A poll's fields, validated by Unicode character count as they are typed.
 * HTML maxLength counts UTF-16 units, so allow two units per provider character;
 * pollProblems enforces the actual limit without rejecting valid emoji early.
 */
export function PollEditor({
  standing,
  channel,
  media = 0,
  onChange,
  poll,
}: {
  channel: DraftChannel
  media?: number
  onChange: (poll: PostPoll | null) => void
  poll: PostPoll
  standing?: AccountStanding
}) {
  const rules = pollRules(channel, standing)
  if (!rules) return null
  const problems = pollProblems(channel, poll, media, standing)
  return (
    <div className="grid gap-2 text-sm" data-testid={`poll-editor-${channel}`}>
      {rules.question === 'field' ? (
        <Label className="grid gap-1 text-xs text-muted-foreground">
          <span className="flex justify-between">
            Poll question
            <span>
              {[...(poll.question ?? '')].length}/{rules.questionLimit}
            </span>
          </span>
          <Input
            aria-label="Poll question"
            maxLength={rules.questionLimit * 2}
            onChange={(event) => onChange({ ...poll, question: event.target.value })}
            value={poll.question ?? ''}
          />
        </Label>
      ) : (
        <p className="text-xs text-muted-foreground">The post’s text is the question.</p>
      )}
      {channel === 'mastodon' ? (
        <Label className="flex items-center gap-2">
          <Checkbox
            checked={poll.multiple ?? false}
            onCheckedChange={(checked) => onChange({ ...poll, multiple: checked === true })}
          />
          Allow multiple choices
        </Label>
      ) : null}
      {poll.options.map((option, index) => (
        <Label className="grid gap-1 text-xs text-muted-foreground" key={index}>
          <span className="flex justify-between">
            Option {index + 1}
            <span>
              {[...option].length}/{rules.maxOptionLength}
            </span>
          </span>
          <span className="flex gap-1">
            <Input
              aria-label={`Poll option ${index + 1}`}
              className="flex-1"
              maxLength={rules.maxOptionLength * 2}
              onChange={(event) =>
                onChange({
                  ...poll,
                  options: poll.options.map((item, at) =>
                    at === index ? event.target.value : item
                  ),
                })
              }
              value={option}
            />
            {poll.options.length > rules.minOptions ? (
              <Button
                aria-label={`Remove option ${index + 1}`}
                onClick={() =>
                  onChange({ ...poll, options: poll.options.filter((_, at) => at !== index) })
                }
                size="sm"
                type="button"
                variant="ghost"
              >
                ✕
              </Button>
            ) : null}
          </span>
        </Label>
      ))}
      {poll.options.length < rules.maxOptions ? (
        <Button
          className="justify-self-start"
          onClick={() => onChange({ ...poll, options: [...poll.options, ''] })}
          size="sm"
          type="button"
          variant="ghost"
        >
          + Add option
        </Button>
      ) : null}
      <Label className="grid gap-1 text-xs text-muted-foreground">
        Duration
        {rules.durationRange ? (
          <Input
            aria-label="Poll duration in minutes"
            type="number"
            min={rules.durationRange.min}
            max={rules.durationRange.max}
            value={poll.durationMinutes}
            onChange={(event) => onChange({ ...poll, durationMinutes: Number(event.target.value) })}
          />
        ) : (
          <Select
            onValueChange={(value) => onChange({ ...poll, durationMinutes: Number(value) })}
            value={String(
              channel === 'threads' && poll.durationMinutes === 1440 ? 0 : poll.durationMinutes
            )}
          >
            <SelectTrigger aria-label="Poll duration">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {rules.durationsMinutes.map((minutes) => (
                <SelectItem key={minutes} value={String(minutes)}>
                  {durationLabel(minutes)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Label>
      {problems.length > 0 ? (
        <ul className="grid gap-0.5" role="alert">
          {problems.map((problem) => (
            <li className="text-xs text-amber-700 dark:text-amber-300" key={problem}>
              {problem}
            </li>
          ))}
        </ul>
      ) : null}
      <Button
        className="justify-self-start text-red-700 dark:text-red-300"
        onClick={() => onChange(null)}
        size="sm"
        type="button"
        variant="ghost"
      >
        Remove poll
      </Button>
    </div>
  )
}
