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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MobileDrawer } from '@/components/ui/responsive-popover'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import type { DocumentActions } from '@/components/drafts/DraftEditor'
import { insertSnippet } from '@/components/drafts/thread'
import type { DraftChannel } from '@/lib/write/document'
import { useKeys, useShortcuts } from '../shortcuts'
import { useWrite } from '../write-context'
import { type Command, ComposerCommandsContext, type ComposerTool, commandsFor, rememberCommand } from './commands'
import { DescribeImages } from './describe-images'
import { insertAttachments } from '@/lib/write/media-operations'
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

const noSubscription = () => () => {}

/** Whether the main pointer is a finger, where menus open as sheets from the bottom. */
export function useCoarsePointer(): boolean {
  return React.useSyncExternalStore(
    noSubscription,
    () => window.matchMedia('(pointer: coarse)').matches,
    () => false
  )
}

/** Commands the toolbar shows as their own buttons, so More leaves them out. */
const ON_TOOLBAR = new Set(['insert-media', 'insert-emoji'])

/**
 * Write's part of the editor's one-row toolbar: Emoji, Ask AI and More (the
 * registry's insert commands, media tools, import and export), and the Write
 * tools those open. The editor draws Add to thread and Image before it.
 */
export function ComposerToolbar({
  aiEnabled,
  channel,
  document: actions,
  draftId,
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
  draftId: string
  onDescriptionSaved: (assetId: string, alt: string) => void
  /** Called after the snippets dialog closes, to read them again. */
  onSnippetsChange: () => void
  onTool: (tool: ComposerTool | null) => void
  setId: string | null
  tool: ComposerTool | null
}) {
  const editor = useEditorRef()
  const keys = useKeys()
  const coarse = useCoarsePointer()
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
  // More's rows, in sections: the registry's inserts, media tools, import and export.
  type Row = { badge?: string; icon: Command['icon']; key: string; label: string; run: () => void; shortcut?: string }
  const sections: Row[][] = [
    commands.map((command) => ({
      badge: command.badge,
      icon: command.icon,
      key: command.id,
      label: command.label,
      run: () => {
        rememberCommand(command.id)
        command.run()
      },
      shortcut: command.shortcut ? keys.label(command.shortcut) : undefined,
    })),
    [
      { icon: LinkSimpleIcon, key: 'link-image', label: 'Image from link', run: () => onTool('link-image') },
      { icon: SlidersHorizontalIcon, key: 'media', label: 'Manage media', run: () => onTool('media') },
      { icon: ClosedCaptioningIcon, key: 'alt', label: 'Alt text', run: () => onTool('alt') },
    ],
    [
      ...actions.imports.map((file) => ({
        icon: FileArrowUpIcon,
        key: file.label,
        label: file.label,
        run: () => files.current[file.label]?.click(),
      })),
      ...actions.exports.map((file) => ({
        icon: DownloadSimpleIcon,
        key: file.label,
        label: file.label,
        run: () => void file.run(),
      })),
    ],
  ]
  const [sheet, setSheet] = React.useState(false)
  const trigger = (
    <ToolbarButton aria-label="More" tooltip="More: insert, media, import and export">
      <DotsThreeIcon aria-hidden />
    </ToolbarButton>
  )
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
      {coarse ? (
        // On touch, the same rows as a sheet from the bottom, above the keyboard.
        <MobileDrawer
          description="Insert, media tools, import and export"
          onOpenChange={setSheet}
          open={sheet}
          title="More"
          trigger={trigger}
        >
          <div className="grid gap-px px-2 pb-3">
            {sections.flat().map((row) => (
              <Button
                className="h-11 justify-start gap-3 px-3 text-ui-lg font-normal"
                key={row.key}
                onClick={() => {
                  setSheet(false)
                  row.run()
                }}
                variant="ghost"
              >
                <row.icon aria-hidden className="size-5 text-muted-foreground" />
                <span className="flex-1 text-left">{row.label}</span>
                {row.badge ? <span className="text-label text-muted-foreground">{row.badge}</span> : null}
              </Button>
            ))}
          </div>
        </MobileDrawer>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="max-h-[min(30rem,var(--radix-dropdown-menu-content-available-height))] w-64 overflow-y-auto"
            onCloseAutoFocus={(event) => event.preventDefault()}
            side="top"
          >
            {sections.map((rows, index) => (
              <React.Fragment key={index}>
                {index ? <DropdownMenuSeparator /> : null}
                {rows.map((row) => (
                  <DropdownMenuItem key={row.key} onSelect={row.run}>
                    <row.icon aria-hidden />
                    <span className="flex-1">{row.label}</span>
                    {row.badge ? (
                      <span className="text-label text-muted-foreground">{row.badge}</span>
                    ) : row.shortcut ? (
                      <DropdownMenuShortcut aria-hidden>{row.shortcut}</DropdownMenuShortcut>
                    ) : null}
                  </DropdownMenuItem>
                ))}
              </React.Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
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
        draftId={draftId}
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
          channel={channel}
          onClose={close}
          onInsert={(nodes) => insertAttachments(editor as PlateEditor, nodes)}
        />
      ) : null}
      {tool === 'snippets' && setId ? (
        <FinisherDialog
          channel={channel}
          onApply={(text) => insertSnippet(editor as PlateEditor, text)}
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
