'use client'

import * as React from 'react'
import dynamic from 'next/dynamic'
import { ClosedCaptioningIcon } from '@phosphor-icons/react/dist/ssr/ClosedCaptioning'
import { DotsThreeIcon } from '@phosphor-icons/react/dist/ssr/DotsThree'
import { DownloadSimpleIcon } from '@phosphor-icons/react/dist/ssr/DownloadSimple'
import { FileArrowUpIcon } from '@phosphor-icons/react/dist/ssr/FileArrowUp'
import { LinkSimpleIcon } from '@phosphor-icons/react/dist/ssr/LinkSimple'
import { SlidersHorizontalIcon } from '@phosphor-icons/react/dist/ssr/SlidersHorizontal'
import { SmileyIcon } from '@phosphor-icons/react/dist/ssr/Smiley'
import { SparkleIcon } from '@phosphor-icons/react/dist/ssr/Sparkle'
import type { PlateEditor } from '@shots/platejs-editor/platejs/react'
import { useEditorRef } from '@shots/platejs-editor/platejs/react'
import { ToolbarButton } from '@shots/platejs-editor/ui'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import type { DocumentActions } from '@/components/drafts/DraftEditor'
import type { DraftChannel } from '@/lib/write/document'
import { useKeys, useShortcuts } from '../shortcuts'
import { useWrite } from '../write-context'
import { type Command, ComposerCommandsContext, type ComposerTool, commandsFor, rememberCommand } from './commands'
import { DescribeImages } from './describe-images'
import { ComposerEmojiPicker } from './emoji-picker'
import { MediaTools } from './media-tools'
import { RefineMenu, useRefine } from './refine'
import { MentionPicker } from './social-mention'
import { FinisherDialog } from './version-options'

const LibraryAssetPicker = dynamic(
  () =>
    import('@/components/platform-hub/LibraryAssetPicker').then(
      (module) => module.LibraryAssetPicker
    ),
  { ssr: false }
)

/** Commands the toolbar shows as their own buttons, so More leaves them out. */
const ON_TOOLBAR = new Set(['insert-media', 'insert-emoji'])

/**
 * Write's part of the editor's one-row toolbar: Emoji, Ask AI and More (the
 * registry's insert commands, media tools, import and export), and the Write
 * tools those open. The editor draws Add post and Image before it.
 */
export function ComposerToolbar({
  aiEnabled,
  channel,
  document: actions,
  onDescriptionSaved,
  onSnippetsChange,
  onTool,
  setId,
  tool,
}: {
  aiEnabled: boolean
  /** The version being edited. */
  channel: DraftChannel
  document: DocumentActions
  onDescriptionSaved: (assetId: string, alt: string) => void
  /** Called after the snippets dialog closes, to read them again. */
  onSnippetsChange: () => void
  onTool: (tool: ComposerTool | null) => void
  setId: string | null
  tool: ComposerTool | null
}) {
  const editor = useEditorRef()
  const keys = useKeys()
  const refine = useRefine()
  const composer = React.useContext(ComposerCommandsContext)
  const files = React.useRef<Record<string, HTMLInputElement | null>>({})
  const { editorCommandsRef } = useWrite()
  // The command palette lists the same commands while this editor is open.
  React.useEffect(() => {
    editorCommandsRef.current = () =>
      composer ? commandsFor({ ...composer, ai: refine, editor }) : []
    return () => {
      editorCommandsRef.current = null
    }
  })
  useShortcuts([
    { key: '>', label: 'Emoji', mod: true, shift: true, run: () => onTool('emoji'), inEditor: true },
    { key: '.', label: 'Emoji', mod: true, shift: true, run: () => onTool('emoji'), inEditor: true },
  ])
  const commands = composer
    ? commandsFor({ ...composer, ai: refine, editor }).filter(
        (command) =>
          (command.group === 'Insert' || command.group === 'Snippets' || command.id === 'post-split') &&
          !ON_TOOLBAR.has(command.id)
      )
    : []
  const close = () => {
    onTool(null)
    editor.tf.focus()
  }
  const item = (command: Command) => {
    const Icon = command.icon
    return (
      <DropdownMenuItem
        key={command.id}
        onSelect={() => {
          rememberCommand(command.id)
          command.run()
        }}
      >
        <Icon aria-hidden />
        <span className="flex-1">{command.label}</span>
        {command.badge ? (
          <span className="text-label text-muted-foreground">{command.badge}</span>
        ) : command.shortcut ? (
          <DropdownMenuShortcut>{keys.label(command.shortcut)}</DropdownMenuShortcut>
        ) : null}
      </DropdownMenuItem>
    )
  }
  return (
    <>
      <Popover onOpenChange={(open) => onTool(open ? 'emoji' : null)} open={tool === 'emoji'}>
        <PopoverAnchor asChild>
          <span className="inline-flex">
            <ToolbarButton
              aria-label="Emoji"
              onClick={() => onTool('emoji')}
              onMouseDown={(event) => event.preventDefault()}
              tooltip={`Emoji (${keys.mod}⇧.)`}
            >
              <SmileyIcon aria-hidden />
            </ToolbarButton>
          </span>
        </PopoverAnchor>
        <PopoverContent
          className="w-80 p-2"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            editor.tf.focus()
          }}
          side="top"
        >
          <ComposerEmojiPicker
            onSelect={(emoji) => {
              if (!editor.selection) editor.tf.select(editor.api.end([]))
              editor.tf.insertText(emoji)
              close()
            }}
          />
        </PopoverContent>
      </Popover>
      {refine ? (
        <RefineMenu at="toolbar">
          <ToolbarButton
            aria-label="Ask AI"
            onMouseDown={(event) => event.preventDefault()}
            tooltip={`Ask AI (${keys.mod}J)`}
          >
            <SparkleIcon aria-hidden className="text-primary" />
          </ToolbarButton>
        </RefineMenu>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <ToolbarButton aria-label="More" tooltip="More: insert, media, import and export">
            <DotsThreeIcon aria-hidden />
          </ToolbarButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="max-h-[min(30rem,var(--radix-dropdown-menu-content-available-height))] w-64 overflow-y-auto"
          onCloseAutoFocus={(event) => event.preventDefault()}
          side="top"
        >
          {commands.map(item)}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onTool('link-image')}>
            <LinkSimpleIcon aria-hidden />
            Image from link
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onTool('media')}>
            <SlidersHorizontalIcon aria-hidden />
            Manage media
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onTool('alt')}>
            <ClosedCaptioningIcon aria-hidden />
            Alt text
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {actions.imports.map((file) => (
            <DropdownMenuItem key={file.label} onSelect={() => files.current[file.label]?.click()}>
              <FileArrowUpIcon aria-hidden />
              {file.label}
            </DropdownMenuItem>
          ))}
          {actions.exports.map((file) => (
            <DropdownMenuItem key={file.label} onSelect={() => void file.run()}>
              <DownloadSimpleIcon aria-hidden />
              {file.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {actions.imports.map((file) => (
        <Input
          accept={file.accept}
          aria-label={file.label}
          className="hidden"
          key={file.label}
          onChange={(event) => {
            const picked = event.target.files?.[0]
            event.target.value = ''
            if (picked) file.onFile(picked)
          }}
          ref={(element) => {
            files.current[file.label] = element
          }}
          type="file"
        />
      ))}
      <MediaTools
        channel={channel}
        onClose={close}
        onDescriptionSaved={onDescriptionSaved}
        setId={setId}
        tool={tool === 'gif' || tool === 'link-image' || tool === 'media' ? tool : null}
      />
      <MentionPicker
        channels={composer?.channels ?? [channel]}
        editor={{ current: editor as PlateEditor }}
        onOpenChange={(open) => (open ? onTool('mention') : close())}
        open={tool === 'mention'}
        setId={setId}
      />
      {tool === 'alt' ? (
        <DescribeImages
          aiEnabled={aiEnabled}
          editor={editor as PlateEditor}
          onClose={close}
          onSaved={onDescriptionSaved}
        />
      ) : null}
      {tool === 'library' ? (
        <LibraryAssetPicker
          onClose={close}
          onInsert={(node) => {
            if (!editor.selection) editor.tf.select(editor.api.end([]))
            editor.tf.insertNodes(node)
            editor.tf.focus()
          }}
        />
      ) : null}
      {tool === 'snippets' && setId ? (
        <FinisherDialog
          channel={channel}
          onApply={(text) => {
            if (!editor.selection) editor.tf.select(editor.api.end([]))
            editor.tf.insertText(text)
          }}
          onClose={() => {
            onSnippetsChange()
            close()
          }}
          setId={setId}
        />
      ) : null}
    </>
  )
}
