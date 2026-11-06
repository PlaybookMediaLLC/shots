'use client'

import * as React from 'react'
import type { Icon } from '@phosphor-icons/react'
import { ArrowsInIcon } from '@phosphor-icons/react/dist/ssr/ArrowsIn'
import { ArrowsLeftRightIcon } from '@phosphor-icons/react/dist/ssr/ArrowsLeftRight'
import { AsteriskIcon } from '@phosphor-icons/react/dist/ssr/Asterisk'
import { AtIcon } from '@phosphor-icons/react/dist/ssr/At'
import { ChartBarHorizontalIcon } from '@phosphor-icons/react/dist/ssr/ChartBarHorizontal'
import { CopyIcon } from '@phosphor-icons/react/dist/ssr/Copy'
import { GifIcon } from '@phosphor-icons/react/dist/ssr/Gif'
import { HashIcon } from '@phosphor-icons/react/dist/ssr/Hash'
import { ImageIcon } from '@phosphor-icons/react/dist/ssr/Image'
import { ImagesIcon } from '@phosphor-icons/react/dist/ssr/Images'
import { LightningIcon } from '@phosphor-icons/react/dist/ssr/Lightning'
import { LinkIcon } from '@phosphor-icons/react/dist/ssr/Link'
import { ListBulletsIcon } from '@phosphor-icons/react/dist/ssr/ListBullets'
import { ListNumbersIcon } from '@phosphor-icons/react/dist/ssr/ListNumbers'
import { MathOperationsIcon } from '@phosphor-icons/react/dist/ssr/MathOperations'
import { PencilSimpleLineIcon } from '@phosphor-icons/react/dist/ssr/PencilSimpleLine'
import { PlusIcon } from '@phosphor-icons/react/dist/ssr/Plus'
import { ScissorsIcon } from '@phosphor-icons/react/dist/ssr/Scissors'
import { SmileyIcon } from '@phosphor-icons/react/dist/ssr/Smiley'
import { SparkleIcon } from '@phosphor-icons/react/dist/ssr/Sparkle'
import { StackIcon } from '@phosphor-icons/react/dist/ssr/Stack'
import { TableIcon } from '@phosphor-icons/react/dist/ssr/Table'
import { TrashIcon } from '@phosphor-icons/react/dist/ssr/Trash'
import { triggerFloatingLink } from '@shots/platejs-editor/@platejs/link/react'
import { KEYS } from '@shots/platejs-editor/platejs'
import type { PlateEditor } from '@shots/platejs-editor/platejs/react'
import { CHANNEL_META } from '@/components/drafts/channel-meta'
import {
  caretPost,
  deletePost,
  duplicatePost,
  insertPostBreak,
  postRanges,
  splitPostAtCaret,
} from '@/components/drafts/thread'
import { CAPABILITIES, pollRules } from '@/lib/write/capabilities'
import type { DraftChannel } from '@/lib/write/document'
import { DESTINATION_MEDIA } from '@/lib/write/media-rules'
import { COMMAND_SHORTCUTS, type Shortcut } from '../shortcuts'
import type { RefineApi } from './refine'

/**
 * Write's editor commands (the post editor brief): one typed registry that the
 * slash menu, the toolbar's More menu, the command palette and the shortcut
 * reference all read, so they never drift apart. Every command publishes on
 * the platform being edited, or says how it publishes with a badge; commands
 * a platform cannot publish are left out for it.
 */

/** Where a command sits in the menus. */
export type CommandGroup = 'AI' | 'Post' | 'Insert' | 'Snippets'

/** The Write tools a command can open. */
export type ComposerTool =
  | 'alt'
  | 'emoji'
  | 'gif'
  | 'library'
  | 'link-image'
  | 'media'
  | 'mention'
  | 'snippets'

/** A thread finisher, offered as a snippet. */
export type Snippet = { id: string; name: string; text: string }

/** What the commands act on. */
export type CommandContext = {
  editor: PlateEditor
  /** The platform whose text is being edited. */
  channel: DraftChannel
  /** Every platform the draft publishes to. */
  channels: readonly DraftChannel[]
  /** Refine, or null when AI is off. */
  ai: RefineApi | null
  /** Whether GIF search is available here. */
  giphy: boolean
  snippets: readonly Snippet[]
  addMedia: () => void
  openTool: (tool: ComposerTool) => void
  /** Open a post's poll or audience settings. */
  postSetting: (number: number, setting: 'audience' | 'poll') => void
}

/** One command, ready to run. */
export type Command = {
  id: string
  label: string
  aliases: readonly string[]
  group: CommandGroup
  icon: Icon
  /** A one-line explanation. */
  hint?: string
  /** How it publishes when that is not plain text in place. */
  badge?: string
  shortcut?: Pick<Shortcut, 'alt' | 'key' | 'mod' | 'shift'>
  /** Runs with the caret where the command was asked for. */
  run: () => void
}

/** The kit's block and inline inserts, loaded with the editor (and kept out of this module's imports). */
function insert(editor: PlateEditor, type: string, inline = false): void {
  void import('@shots/platejs-editor/components').then(({ insertBlock, insertInlineElement }) =>
    inline ? insertInlineElement(editor, type) : insertBlock(editor, type)
  )
}

function keysOf(id: (typeof COMMAND_SHORTCUTS)[number]['id']): Command['shortcut'] {
  const { key, mod, shift } = { shift: false, ...COMMAND_SHORTCUTS.find((entry) => entry.id === id)! }
  return { key, mod, shift }
}

const PUBLISHES_AS_IMAGE = 'Publishes as image'
const PLAIN_TEXT = 'Converted to plain text'

/** The commands for the version being edited, in menu order. */
export function commandsFor(context: CommandContext): Command[] {
  const { channel, channels, editor } = context
  // Every AI command works on the words already written; on an empty post it could only refuse.
  const ai = editor.api.string([]).trim() ? context.ai : null
  const label = CHANNEL_META[channel].label
  const others = channels.filter((other) => other !== channel)
  const posts = postRanges(editor.children).length
  const pollChannels = channels.filter((other) => pollRules(other))
  // A table or equation publishes as an image, which a video-only platform refuses.
  const takesImages = DESTINATION_MEDIA[channel].images.length > 0
  const commands: (Command | false)[] = [
    Boolean(ai) && {
      aliases: ['ai', 'ask', 'write', 'prompt'],
      group: 'AI',
      hint: 'Tell the AI what to change; you review before it applies',
      icon: SparkleIcon,
      id: 'ai-ask',
      label: 'Ask AI…',
      run: () => ai?.open(),
      shortcut: keysOf('ai-ask'),
    },
    Boolean(ai) && {
      aliases: ['punch', 'hook', 'stronger'],
      group: 'AI',
      icon: LightningIcon,
      id: 'ai-punchier',
      label: 'Make it punchier',
      run: () => ai?.run({ action: 'punchier', scope: 'post' }),
    },
    Boolean(ai) && {
      aliases: ['shorten', 'fit', 'trim', 'condense'],
      group: 'AI',
      hint: `Within ${CAPABILITIES[channel].captionLimit.toLocaleString('en-US')} characters`,
      icon: ArrowsInIcon,
      id: 'ai-shorten',
      label: `Shorten to fit ${label}`,
      run: () => ai?.run({ action: 'condense', scope: 'post' }),
    },
    ...others.map(
      (other): Command | false =>
        Boolean(ai) && {
          aliases: ['adapt', 'rewrite', 'for', CHANNEL_META[other].label.toLowerCase()],
          group: 'AI',
          hint: `Written as ${CHANNEL_META[other].label}’s own text`,
          icon: ArrowsLeftRightIcon,
          id: `ai-rewrite-${other}`,
          label: `Rewrite for ${CHANNEL_META[other].label}`,
          run: () =>
            ai?.run({
              action: 'custom',
              prompt: `Rewrite this for ${CHANNEL_META[other].label}, in its style and within its limits.`,
              target: other,
            }),
        }
    ),
    Boolean(ai) && {
      aliases: ['continue', 'more', 'next'],
      group: 'AI',
      icon: PencilSimpleLineIcon,
      id: 'ai-continue',
      label: 'Continue writing',
      run: () => ai?.run({ action: 'continue', scope: 'post' }),
    },
    {
      aliases: ['split', 'thread', 'next', 'add'],
      group: 'Post',
      icon: PlusIcon,
      id: 'post-new',
      label: 'New post below',
      run: () => insertPostBreak(editor),
      shortcut: keysOf('post-new'),
    },
    {
      aliases: ['split here', 'cut', 'break'],
      group: 'Post',
      hint: 'What follows the caret starts the next post',
      icon: ScissorsIcon,
      id: 'post-split',
      label: 'Split at caret',
      run: () => splitPostAtCaret(editor),
    },
    {
      aliases: ['copy', 'dup', 'clone'],
      group: 'Post',
      icon: CopyIcon,
      id: 'post-duplicate',
      label: 'Duplicate post',
      run: () => duplicatePost(editor, caretPost(editor)),
    },
    posts > 1 && {
      aliases: ['remove', 'delete'],
      group: 'Post',
      icon: TrashIcon,
      id: 'post-delete',
      label: 'Delete post',
      run: () => deletePost(editor, caretPost(editor)),
    },
    {
      aliases: ['img', 'pic', 'photo', 'media', 'upload', 'video'],
      group: 'Insert',
      icon: ImageIcon,
      id: 'insert-media',
      label: 'Image or video',
      run: context.addMedia,
      shortcut: keysOf('insert-media'),
    },
    {
      aliases: ['library', 'asset'],
      group: 'Insert',
      icon: ImagesIcon,
      id: 'insert-library',
      label: 'From Library',
      run: () => context.openTool('library'),
    },
    context.giphy && {
      aliases: ['gif', 'giphy'],
      group: 'Insert',
      icon: GifIcon,
      id: 'insert-gif',
      label: 'GIF',
      run: () => context.openTool('gif'),
    },
    {
      aliases: ['emoji', 'smile'],
      group: 'Insert',
      hint: 'Or type : and a name',
      icon: SmileyIcon,
      id: 'insert-emoji',
      label: 'Emoji',
      run: () => context.openTool('emoji'),
      shortcut: keysOf('insert-emoji'),
    },
    {
      aliases: ['at', 'user', 'mention', 'tag'],
      group: 'Insert',
      hint: CAPABILITIES[channel].mentions === 'none' ? 'Written as plain text' : 'Or type @',
      icon: AtIcon,
      id: 'insert-mention',
      label: 'Mention',
      // X and LinkedIn look the account up; elsewhere "@" opens the inline lookup as text.
      run: () =>
        channel === 'x' || channel === 'linkedin'
          ? context.openTool('mention')
          : editor.tf.insertText('@'),
    },
    {
      aliases: ['tag', 'hash', 'hashtag'],
      group: 'Insert',
      hint: 'Or type #',
      icon: HashIcon,
      id: 'insert-hashtag',
      label: 'Hashtag',
      run: () => editor.tf.insertText('#'),
    },
    {
      aliases: ['url', 'link'],
      group: 'Insert',
      icon: LinkIcon,
      id: 'insert-link',
      label: 'Link',
      run: () => triggerFloatingLink(editor, { focused: true }),
      shortcut: keysOf('insert-link'),
    },
    pollChannels.includes(channel) && {
      aliases: ['poll', 'vote', 'survey'],
      badge:
        pollChannels.length < channels.length
          ? `${pollChannels.map((other) => CHANNEL_META[other].label).join(', ')} only`
          : undefined,
      group: 'Insert',
      icon: ChartBarHorizontalIcon,
      id: 'insert-poll',
      label: 'Poll',
      run: () => context.postSetting(caretPost(editor), 'poll'),
    },
    {
      aliases: ['list', 'bullets', 'ul'],
      badge: PLAIN_TEXT,
      group: 'Insert',
      hint: 'Publishes as lines starting with •',
      icon: ListBulletsIcon,
      id: 'insert-bullets',
      label: 'Bulleted list',
      run: () => insert(editor, KEYS.ul),
    },
    {
      aliases: ['numbers', 'steps', 'ol'],
      badge: PLAIN_TEXT,
      group: 'Insert',
      hint: 'Publishes as lines 1. 2. 3.',
      icon: ListNumbersIcon,
      id: 'insert-numbers',
      label: 'Numbered list',
      run: () => insert(editor, KEYS.ol),
    },
    takesImages && {
      aliases: ['table', 'grid'],
      badge: PUBLISHES_AS_IMAGE,
      group: 'Insert',
      icon: TableIcon,
      id: 'insert-table',
      label: 'Table',
      run: () => insert(editor, KEYS.table),
    },
    takesImages && {
      aliases: ['equation', 'formula', 'math', 'latex'],
      badge: PUBLISHES_AS_IMAGE,
      group: 'Insert',
      icon: MathOperationsIcon,
      id: 'insert-math',
      label: 'Math',
      run: () => insert(editor, KEYS.equation),
    },
    {
      aliases: ['note', 'ref', 'footnote'],
      group: 'Insert',
      hint: 'Publishes as text at the end of the post',
      icon: AsteriskIcon,
      id: 'insert-footnote',
      label: 'Footnote',
      run: () => insert(editor, KEYS.footnoteReference, true),
    },
    ...context.snippets.map(
      (snippet): Command => ({
        aliases: ['snippet', 'cta', 'template', 'finisher'],
        group: 'Snippets',
        hint: snippet.text.split('\n')[0],
        icon: StackIcon,
        id: `snippet-${snippet.id}`,
        label: snippet.name,
        run: () => editor.tf.insertText(snippet.text),
      })
    ),
    {
      aliases: ['snippet', 'cta', 'template', 'signature', 'finisher'],
      group: 'Snippets',
      hint: 'Save text you reuse: a call to action, a signature, a closing post',
      icon: StackIcon,
      id: 'snippets-manage',
      label: context.snippets.length ? 'Manage snippets…' : 'Saved snippets…',
      run: () => context.openTool('snippets'),
    },
  ]
  return commands.filter((command): command is Command => Boolean(command))
}

/** How well a term matches what was typed: 3 prefix, 2 word prefix, 1 in order, 0 none. */
function score(term: string, query: string): number {
  const text = term.toLowerCase()
  if (text.startsWith(query)) return 3
  if (text.split(/[\s-]+/).some((word) => word.startsWith(query))) return 2
  let at = 0
  for (const character of text) if (character === query[at]) at += 1
  return at === query.length ? 1 : 0
}

/**
 * The commands to show for a query. Empty: up to five recent ones first, then
 * the rest in registry order. Typed: matches on the label or an alias, best
 * first, the label before an alias; nothing is pinned above them.
 */
export function rankCommands(
  commands: readonly Command[],
  query: string,
  recent: readonly string[] = []
): Command[] {
  const typed = query.trim().toLowerCase()
  if (!typed) {
    const first = recent
      .slice(0, 5)
      .map((id) => commands.find((command) => command.id === id))
      .filter((command): command is Command => Boolean(command))
    return [...first, ...commands.filter((command) => !first.includes(command))]
  }
  return commands
    .map((command, index) => ({
      command,
      index,
      label: score(command.label, typed),
      score: Math.max(score(command.label, typed), ...command.aliases.map((alias) => score(alias, typed))),
    }))
    .filter((entry) => entry.score > 0)
    // On a tie, a match on the label beats one on an alias ("split": Split at caret).
    .sort((a, b) => b.score - a.score || b.label - a.label || a.index - b.index)
    .map((entry) => entry.command)
}

/** This browser's recently run commands, most recent first. */
const RECENT_KEY = 'shots-slash-recent'

/** The recently run command ids; empty when storage is unavailable. */
export function recentCommands(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

/** Remember a command as the most recent. */
export function rememberCommand(id: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recentCommands().filter((other) => other !== id)].slice(0, 5)))
  } catch {
    // Without storage the menu simply has no recent commands.
  }
}

/** What the composer gives the commands; the editor and Refine come from where they run. */
export type ComposerCommands = Omit<CommandContext, 'ai' | 'editor'>

/** The composer's commands, for the slash menu and toolbar inside the editor. */
export const ComposerCommandsContext = React.createContext<ComposerCommands | null>(null)
