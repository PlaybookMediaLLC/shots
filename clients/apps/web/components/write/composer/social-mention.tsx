'use client'

import * as React from 'react'
import { toast } from 'sonner'
import type { PlateEditor, PlateElementProps } from '@shots/platejs-editor/platejs/react'
import { createPlatePlugin, PlateElement, useSelected } from '@shots/platejs-editor/platejs/react'
import { MentionInputPlugin, MentionPlugin } from '@shots/platejs-editor/@platejs/mention/react'
import {
  InlineCombobox,
  InlineComboboxContent,
  InlineComboboxEmpty,
  InlineComboboxInput,
  InlineComboboxItem,
} from '@shots/platejs-editor/ui'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { CHANNEL_META, ChannelIcon } from '@/components/drafts/channel-meta'
import { call } from '@/lib/content-drafts/client'
import { SOCIAL_MENTION } from '@/lib/content-drafts/serialize'
import type { DraftChannel } from '@/lib/write/document'
import { cn } from '@/lib/utils'
import type { z } from 'zod'
import type { socialMentionSchema } from '@/lib/api/contracts/social-mentions'

/**
 * Atomic social mentions (RFC 025): an account picked from the platform's
 * own lookup, kept as one inline element that cannot be split or half
 * deleted. It is written per platform at publishing: the LinkedIn
 * annotation for a LinkedIn organization, the @handle for an X user, and
 * the plain name anywhere else, so it never tags the wrong account.
 */

/** A mention as the lookup returns it. */
type FoundMention = z.output<typeof socialMentionSchema>

/** The current version's destination, shared without recreating the editor. */
export const SocialMentionContext = React.createContext<{
  channel: DraftChannel
  setId: string | null
}>({ channel: 'x', setId: null })

function SocialMentionInput(props: PlateElementProps) {
  const { channel, setId } = React.useContext(SocialMentionContext)
  const [query, setQuery] = React.useState(String(props.element.value ?? ''))
  const [lookup, setLookup] = React.useState<{
    key: string
    items: FoundMention[]
    error?: string
  } | null>(null)
  const supported = channel === 'x' || channel === 'linkedin'
  const term = query.trim().replace(/^@/, '')
  const key = JSON.stringify([setId, channel, term])
  React.useEffect(() => {
    if (!supported || !setId || !term) return
    // Cancellation prevents a slower earlier query or another platform's response
    // from becoming selectable after the user changes the input/version.
    let cancelled = false
    const timer = setTimeout(() => {
      void call<{ items: FoundMention[] }>(
        `/api/v1/social-sets/${encodeURIComponent(setId)}/mentions?${new URLSearchParams({ channel, q: term })}`
      ).then(
        ({ items }) => {
          if (!cancelled) setLookup({ key, items })
        },
        (error: unknown) => {
          if (!cancelled)
            setLookup({
              key,
              items: [],
              error: error instanceof Error ? error.message : 'Lookup unavailable. Try again.',
            })
        }
      )
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [channel, key, setId, supported, term])
  const current = lookup?.key === key ? lookup : null
  const message = !supported
    ? 'This platform does not support account lookup. Escape keeps your text.'
    : !setId
      ? 'Connect an account to look up mentions.'
      : !term
        ? channel === 'x'
          ? 'Enter an exact X username.'
          : 'Enter a LinkedIn company page name.'
        : !current
          ? 'Looking up account…'
          : (current.error ?? 'No matching account. Escape keeps your text.')
  return (
    <PlateElement {...props} as="span" className="rounded-sm bg-accent px-0.5 text-accent-foreground">
      <InlineCombobox
        element={props.element}
        trigger="@"
        filter={false}
        value={query}
        setValue={(value) => {
          setQuery(value)
          const path = props.editor.api.findPath(props.element)
          if (path) props.editor.tf.setNodes({ value }, { at: path })
        }}
      >
        <InlineComboboxInput aria-label="Social account username" placeholder="Username" />
        <InlineComboboxContent>
          <InlineComboboxEmpty>
            <span role="status">{message}</span>
          </InlineComboboxEmpty>
          {current?.items.map((mention) => (
            <InlineComboboxItem
              key={mention.providerId}
              value={mention.providerId}
              onClick={() => insertMention(props.editor, channel, mention)}
            >
              {mention.label}
              {mention.handle ? ` (@${mention.handle})` : ' (Company page)'}
            </InlineComboboxItem>
          ))}
        </InlineComboboxContent>
      </InlineCombobox>
      {props.children}
    </PlateElement>
  )
}

/** Only platforms with account search open the @ lookup; elsewhere @ stays plain text. */
export function setMentionLookup(editor: PlateEditor, channel: DraftChannel): void {
  const lookup = channel === 'x' || channel === 'linkedin'
  editor.setOption(MentionPlugin, 'triggerQuery', () => lookup)
}

/** Provider-backed @ input; the upstream workspace/demo suggestions stay disabled. */
export const SocialMentionInputPlugins = [
  MentionPlugin.configure({
    options: { triggerPreviousCharPattern: /^$|^[\s"']$/, triggerQuery: () => true },
  }),
  MentionInputPlugin.withComponent(SocialMentionInput),
]

type MentionNode = {
  handle?: string
  label?: string
  platform?: DraftChannel
  providerId?: string
}

function SocialMentionElement(props: PlateElementProps) {
  const node = props.element as MentionNode
  const selected = useSelected()
  return (
    <PlateElement
      {...props}
      as="span"
      attributes={{ ...props.attributes, contentEditable: false, draggable: true }}
      className={cn(
        'mx-0.5 inline-flex items-baseline gap-1 rounded-md bg-sky-400/10 px-1 align-baseline text-sky-700 dark:text-sky-200',
        selected && 'ring-2 ring-sky-400/60'
      )}
    >
      <span
        data-testid="social-mention"
        title={`${node.platform ? CHANNEL_META[node.platform].label : ''} · ${node.providerId ?? ''}`}
      >
        @{node.label}
      </span>
      {props.children}
    </PlateElement>
  )
}

/** The inline, void element social mentions are. */
export const SocialMentionPlugin = createPlatePlugin({
  key: SOCIAL_MENTION,
  node: { component: SocialMentionElement, isElement: true, isInline: true, isVoid: true },
})

/** Put a mention at the caret, then a space after it. */
function insertMention(editor: PlateEditor, channel: DraftChannel, mention: FoundMention) {
  if (!editor.selection) editor.tf.select(editor.api.end([]))
  editor.tf.insertNodes({
    children: [{ text: '' }],
    handle: mention.handle,
    label: mention.label,
    kind: mention.kind,
    platform: channel,
    providerId: mention.providerId,
    type: SOCIAL_MENTION,
  })
  editor.tf.move({ unit: 'offset' })
  editor.tf.insertText(' ')
  editor.tf.focus()
}

/** The platforms a mention can be looked up on, of those being written for. */
export function mentionLookups(channels: DraftChannel[]): ('x' | 'linkedin')[] {
  return channels.filter(
    (channel): channel is 'x' | 'linkedin' => channel === 'x' || channel === 'linkedin'
  )
}

/**
 * The mention picker: look an account up on X or LinkedIn with the set's
 * own account and put it in the post. People searches use the connected
 * LinkedIn Page's restricted follower lookup grant.
 */
export function MentionPicker({
  channels,
  editor,
  onOpenChange: setOpen,
  open,
  setId,
}: {
  channels: readonly DraftChannel[]
  editor: React.MutableRefObject<PlateEditor | null> | { current: PlateEditor }
  /** Opened from the toolbar's More menu or the slash menu's Mention. */
  onOpenChange: (open: boolean) => void
  open: boolean
  setId: string | null
}) {
  const lookups = channels.filter(
    (channel): channel is 'x' | 'linkedin' => channel === 'x' || channel === 'linkedin'
  )
  const [channel, setChannel] = React.useState<'x' | 'linkedin'>(lookups[0] ?? 'x')
  const [query, setQuery] = React.useState('')
  const [kind, setKind] = React.useState<'organization' | 'person'>('organization')
  const lookupVersion = React.useRef(0)
  const [lookupResult, setResults] = React.useState<{ key: string; items: FoundMention[] } | null>(
    null
  )
  const searchKey = JSON.stringify([setId, channel, kind, query.trim()])
  const results = lookupResult?.key === searchKey ? lookupResult.items : null
  const [busy, setBusy] = React.useState(false)
  if (!setId || lookups.length === 0) return null
  const search = async (term = query) => {
    if (!term.trim() && channel !== 'linkedin') return
    setBusy(true)
    const version = ++lookupVersion.current
    try {
      const found = await call<{ items: FoundMention[] }>(
        `/api/v1/social-sets/${encodeURIComponent(setId)}/mentions?${new URLSearchParams({ channel, q: term.trim(), kind: channel === 'x' ? 'person' : kind })}`
      )
      if (version === lookupVersion.current)
        setResults({ key: JSON.stringify([setId, channel, kind, term.trim()]), items: found.items })
    } catch (error) {
      if (version !== lookupVersion.current) return
      setResults(null)
      toast.error(error instanceof Error ? error.message : 'The lookup did not work.')
    } finally {
      if (version === lookupVersion.current) setBusy(false)
    }
  }
  return (
    <Popover
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          lookupVersion.current++
          setBusy(false)
          setResults(null)
        }
      }}
      open={open}
    >
      {/* Opens above the toolbar's end, where the More menu that asked for it was. */}
      <PopoverAnchor className="h-8 w-0" />
      <PopoverContent
        className="grid w-80 gap-2 p-3"
        data-testid="mention-picker"
        // It has no trigger to return to: closing hands focus back to the post.
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          editor.current?.tf.focus()
        }}
        side="top"
      >
        <div className="flex gap-1">
          {lookups.map((item) => (
            <Button
              aria-pressed={item === channel}
              className={cn(
                'h-7 gap-1 px-2 text-xs',
                item === channel && 'bg-foreground/[0.08] text-foreground'
              )}
              key={item}
              onClick={() => {
                lookupVersion.current++
                setBusy(false)
                setChannel(item)
                setResults(null)
              }}
              size={null}
              type="button"
              variant="ghost"
            >
              <ChannelIcon channel={item} />
              {CHANNEL_META[item].label}
            </Button>
          ))}
        </div>
        {channel === 'linkedin' ? (
          <div className="flex gap-1" aria-label="LinkedIn mention type">
            {(['organization', 'person'] as const).map((value) => (
              <Button
                key={value}
                size="sm"
                variant="ghost"
                aria-pressed={kind === value}
                onClick={() => {
                  lookupVersion.current++
                  setBusy(false)
                  setKind(value)
                  setResults(null)
                }}
              >
                {value === 'person' ? 'People' : 'Companies'}
              </Button>
            ))}
          </div>
        ) : null}
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void search()
          }}
        >
          <Input
            aria-label="Mention lookup"
            autoFocus
            className="h-8 text-sm"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={
              channel === 'x'
                ? 'X username, e.g. @jack'
                : kind === 'person'
                  ? 'Page follower’s first or last name'
                  : 'Company page, e.g. acme or its URL'
            }
            value={query}
          />
          <Button disabled={busy || !query.trim()} size="sm" type="submit">
            Find
          </Button>
        </form>
        <p className="text-label text-muted-foreground">
          {channel === 'x'
            ? 'Looked up on X with this set’s account, by exact username.'
            : kind === 'person'
              ? 'Search followers of this LinkedIn Page. Requires approved People Typeahead access and r_organization_followers permission.'
              : 'Search company pages or reuse companies mentioned in this profile. Mentions use native LinkedIn identities.'}
        </p>
        {channel === 'linkedin' ? (
          <Button disabled={busy} variant="ghost" size="sm" onClick={() => void search('')}>
            Recently mentioned {kind === 'person' ? 'people' : 'companies'}
          </Button>
        ) : null}
        {results?.length === 0 ? (
          <p className="text-xs text-muted-foreground">No account by that name.</p>
        ) : null}
        {results && results.length > 0 ? (
          <ul className="grid gap-1">
            {results.map((mention) => (
              <li key={mention.providerId}>
                <Button
                  className="flex h-auto w-full items-center justify-start gap-2 px-2 py-1.5 text-left text-sm"
                  data-testid="mention-result"
                  onClick={() => {
                    if (editor.current) insertMention(editor.current, channel, mention)
                    setOpen(false)
                    setQuery('')
                    setResults(null)
                  }}
                  size={null}
                  type="button"
                  variant="ghost"
                >
                  {mention.image ? (
                    // biome-ignore lint/performance/noImgElement: a provider avatar URL
                    <img alt="" className="size-6 rounded-full" src={mention.image} />
                  ) : null}
                  <span className="min-w-0 flex-1 truncate">
                    {mention.label}
                    <span className="ml-1 text-muted-foreground">
                      {mention.handle
                        ? `@${mention.handle}`
                        : mention.kind === 'organization'
                          ? 'Company page'
                          : 'Person'}
                    </span>
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
