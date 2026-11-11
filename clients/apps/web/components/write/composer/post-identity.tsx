import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { CHANNEL_META } from '@/components/drafts/channel-meta'
import { countingNote } from '@/lib/write/caption-counting'
import type { DraftChannel } from '@/lib/write/document'
import { cn } from '@/lib/utils'
// The editor's type and its caret-only focus, wherever a post is written outside the editor.
import '@/components/drafts/draft-prose.css'

/**
 * How a post looks in Write, shared by the composer, a blank new post and the
 * posts of a batch, so all three read as the same thing: the account's avatar
 * in the post column's gutter, its name and handle, and the length ring.
 */

/**
 * A post's words written in a plain textarea, set as the editor sets them:
 * the editor's type and measure, no field box. Pass it with
 * `data-slot="post-text"` so the shell's form-field styles leave it alone.
 */
export const POST_TEXT =
  'draft-prose min-h-0 resize-none border-0 bg-transparent px-0 py-0 text-body text-foreground shadow-none outline-none placeholder:text-muted-foreground focus-visible:border-0 focus-visible:ring-0 md:text-body dark:bg-transparent'

/** What an empty post invites, where a platform words it its own way. */
export const PLACEHOLDERS: Partial<Record<DraftChannel, string>> = {
  tiktok: 'Write your TikTok caption…',
  x: 'What’s happening?',
}

/** Up to two initials for an avatar without an image. */
export function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0]?.toUpperCase())
      .join('') || 'S'
  )
}

/** The account a post goes out as, above its text; the avatar sits in POST_COLUMN's gutter. */
export function PostAuthor({
  avatarUrl,
  channel,
  handle,
  name,
}: {
  avatarUrl?: string | null
  channel: DraftChannel
  handle?: string | null
  name: string
}) {
  return (
    <div className="flex items-center gap-2 sm:gap-3" data-testid="post-header">
      <Avatar
        // Covers the thread line where it meets the avatar.
        className="relative z-[1] -ms-10 size-8 ring-4 ring-card sm:-ms-12 sm:size-9"
        data-post-avatar
      >
        {avatarUrl ? <AvatarImage alt="" src={avatarUrl} /> : null}
        {/* Also shown when a provider's avatar link has expired. */}
        <AvatarFallback className="bg-accent text-ui font-medium text-accent-foreground">
          {initials(name)}
        </AvatarFallback>
      </Avatar>
      <p className="min-w-0 flex-1 truncate text-ui">
        <span className="font-medium text-foreground">{name}</span>
        <span className="ml-1.5 text-muted-foreground">
          {handle ? `@${handle.replace(/^@/, '')}` : CHANNEL_META[channel].label}
        </span>
      </p>
    </div>
  )
}

/**
 * A post's length for the platform being edited: a ring that fills toward
 * the limit, amber from 90%, red past it. It is always readable — a counter
 * you can only see once you are nearly over cannot be written to — and dims
 * on a post that is not in use so the page stays quiet.
 *
 * An account whose platform raised its limit (a verified X account posts up
 * to 25,000) also shows the standard count, because the length that matters
 * to most writers is still the one everyone else sees.
 */
export function PostCount({
  active,
  channel,
  length,
  limit,
  number,
  standard,
  thread,
}: {
  active: boolean
  channel: DraftChannel
  length: number
  limit: number
  number: number
  /** The platform's standard limit, when this account's is higher. */
  standard?: number
  thread: boolean
}) {
  const ratio = length / limit
  const tone =
    ratio > 1
      ? 'text-destructive'
      : ratio >= 0.9
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-muted-foreground'
  const overStandard = standard !== undefined && length > standard
  return (
    <span
      className={cn(
        'flex items-center gap-1.5 text-caption tabular-nums transition-opacity duration-150 motion-reduce:transition-none',
        tone,
        !active && ratio < 0.9 && 'opacity-60'
      )}
      // Counted as the platform counts it, which writers cannot check outside the app.
      title={countingNote(channel)}
    >
      <span
        aria-hidden
        className="size-4 rounded-full"
        style={{
          background: `conic-gradient(currentColor ${Math.min(ratio, 1) * 360}deg, color-mix(in srgb, currentColor 20%, transparent) 0)`,
          mask: 'radial-gradient(farthest-side, transparent calc(100% - 2.5px), black calc(100% - 2px))',
        }}
      />
      <span data-testid={`post-length-${number}`}>
        {length} / {limit}
      </span>
      {standard !== undefined ? (
        <span
          className={cn(overStandard ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground')}
          data-testid={`post-standard-length-${number}`}
        >
          ({standard} for a standard account)
        </span>
      ) : null}
      {thread ? <span className="text-muted-foreground">#{number}</span> : null}
    </span>
  )
}

