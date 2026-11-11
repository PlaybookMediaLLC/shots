'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  ALT_TEXT_LIMIT,
  CAPTION_CHANNELS,
  type CaptionChannel,
  captionChannelSchema,
  captionLength,
  type DesignCopy,
} from '@/lib/captions/channels'
import { writeDesignCaptions } from '@/lib/captions/write'
import { usePostHandoff } from '@/lib/editor/post-handoff'
import { usePublishSets } from '@/lib/editor/use-publish-targets'
import { useCanStartPost } from '@/lib/platform/can-start-post'
import { useImageStore } from '@/lib/store'
import { useTRPCClient } from '@/lib/trpc/react'
import { cn } from '@/lib/utils'
import { UseInPostButton } from '@/components/workspace/SaveToWorkspaceButton'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const DEFAULT_CHANNELS: CaptionChannel[] = ['x', 'linkedin', 'instagram']

async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`Copied ${what}`)
  } catch {
    toast.error('The clipboard is not available here. Select the text and copy it.')
  }
}

function Counter({ length, limit }: { length: number; limit: number }) {
  return (
    <span
      className={cn(
        'tabular-nums',
        length > limit ? 'font-medium text-destructive' : 'text-muted-foreground'
      )}
    >
      {length}/{limit}
    </span>
  )
}

/**
 * Alt text and a caption per platform for the design, written from a
 * snapshot and its text. Everything is editable; it is saved with the
 * design (so projects keep it), the Share dialog uses it, and "Use in post"
 * attaches each caption to the platform it was written for.
 *
 * The captions are written in a publishing profile's voice: the same style
 * guide and writing samples the composer's writing assistant uses (RFC 024),
 * rather than generic marketing copy. The profile is the one the post
 * dialog posts from, so the voice and the account agree.
 */
export function CaptionsPanel({ disabled }: { disabled: boolean }) {
  const trpcClient = useTRPCClient()
  const canStartPost = useCanStartPost()
  const { defaultSetId, sets } = usePublishSets(true)
  const chosenSetId = usePostHandoff((state) => state.socialSetId)
  const chooseSet = usePostHandoff((state) => state.setSocialSetId)
  const set =
    sets.find((item) => item.id === chosenSetId) ??
    sets.find((item) => item.id === defaultSetId) ??
    null
  const saved = useImageStore((state) => state.copy)
  const [channels, setChannels] = useState<CaptionChannel[]>(() => {
    const existing = captionChannelSchema.options.filter((channel) => saved?.captions[channel])
    return existing.length ? existing : DEFAULT_CHANNELS
  })
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(false)
  // Edits stay local while typing and are saved on blur: one undo step per edit, not per key.
  const [copy, setDraft] = useState<DesignCopy>(saved ?? { captions: {} })
  useEffect(() => setDraft(saved ?? { captions: {} }), [saved])

  const save = (next: DesignCopy) => useImageStore.getState().setCopy(next)
  const commit = () => {
    if (JSON.stringify(copy) !== JSON.stringify(saved ?? { captions: {} })) save(copy)
  }

  async function generate() {
    setLoading(true)
    try {
      await writeDesignCaptions(trpcClient, {
        channels,
        notes: notes.trim() || undefined,
        socialSetId: set?.id,
      })
    } catch (error) {
      toast.error('Could not write captions', {
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex-1 space-y-3 overflow-y-auto p-3 text-sm">
      <p className="text-muted-foreground">
        Alt text and captions for each platform, from what the design shows. Review them before
        posting: AI can misread an image.
      </p>
      {sets.length > 1 && set ? (
        <Label className="grid gap-1 text-xs font-medium">
          Voice
          <Select onValueChange={chooseSet} value={set.id}>
            <SelectTrigger aria-label="Write in the voice of">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sets.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Label>
      ) : null}
      {set ? (
        <p className="text-xs text-muted-foreground">
          Written in {set.name}’s voice: its style guide and writing samples.
        </p>
      ) : null}
      <div aria-label="Platforms" className="flex flex-wrap gap-1.5" role="group">
        {captionChannelSchema.options.map((channel) => {
          const on = channels.includes(channel)
          return (
            <Button variant="custom" size={null}
              aria-pressed={on}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs',
                on ? 'border-foreground bg-foreground text-background' : 'text-muted-foreground'
              )}
              key={channel}
              onClick={() =>
                setChannels((current) =>
                  on ? current.filter((value) => value !== channel) : [...current, channel]
                )
              }
              type="button"
            >
              {CAPTION_CHANNELS[channel].name}
            </Button>
          )
        })}
      </div>
      <Textarea
        aria-label="Notes for the captions"
        className="w-full resize-none rounded-md border bg-transparent px-3 py-2 text-sm"
        onChange={(event) => setNotes(event.target.value)}
        placeholder="Optional: what is new, who it is for, a call to action"
        rows={2}
        value={notes}
      />
      <Button
        className="w-full"
        disabled={disabled || loading || channels.length === 0}
        onClick={() => void generate()}
        type="button"
      >
        {loading ? 'Writing…' : saved ? 'Write again' : 'Write alt text and captions'}
      </Button>
      <p className="text-[11px] text-muted-foreground">
        Sends a snapshot of the design to the AI provider and uses AI credits.
      </p>

      {saved && canStartPost ? (
        <UseInPostButton disabled={disabled} label="Post with these captions" variant="outline" />
      ) : null}

      {saved ? (
        <div className="space-y-3">
          <Label className="block space-y-1">
            <span className="flex items-center justify-between text-xs font-medium">
              Alt text <Counter length={(copy.altText ?? '').length} limit={ALT_TEXT_LIMIT} />
            </span>
            <Textarea
              className="w-full resize-y rounded-md border bg-transparent px-3 py-2 text-sm"
              maxLength={1000}
              onBlur={commit}
              onChange={(event) => setDraft({ ...copy, altText: event.target.value })}
              rows={3}
              value={copy.altText ?? ''}
            />
            <Button
              onClick={() => void copyText(copy.altText ?? '', 'alt text')}
              size="sm"
              type="button"
              variant="outline"
            >
              Copy alt text
            </Button>
          </Label>
          {captionChannelSchema.options
            .filter((channel) => copy.captions[channel] !== undefined)
            .map((channel) => {
              const text = copy.captions[channel] ?? ''
              const { limit, name } = CAPTION_CHANNELS[channel]
              return (
                <Label className="block space-y-1" key={channel}>
                  <span className="flex items-center justify-between text-xs font-medium">
                    {name} <Counter length={captionLength(text, channel)} limit={limit} />
                  </span>
                  <Textarea
                    aria-label={`${name} caption`}
                    className="w-full resize-y rounded-md border bg-transparent px-3 py-2 text-sm"
                    maxLength={3000}
                    onBlur={commit}
                    onChange={(event) =>
                      setDraft({
                        ...copy,
                        captions: { ...copy.captions, [channel]: event.target.value },
                      })
                    }
                    rows={4}
                    value={text}
                  />
                  <Button
                    onClick={() => void copyText(text, `the ${name} caption`)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Copy
                  </Button>
                </Label>
              )
            })}
        </div>
      ) : null}
    </div>
  )
}
