'use client'

import { SparkleIcon } from '@phosphor-icons/react/dist/ssr/Sparkle'
import { TextBIcon } from '@phosphor-icons/react/dist/ssr/TextB'
import { TextItalicIcon } from '@phosphor-icons/react/dist/ssr/TextItalic'
import { KEYS } from '@shots/platejs-editor/platejs'
import { createPlatePlugin, useEditorRef, useMarkToolbarButtonState } from '@shots/platejs-editor/platejs/react'
import {
  CommentToolbarButton,
  FloatingToolbar,
  LinkToolbarButton,
  MarkToolbarButton,
  ToolbarButton,
  ToolbarGroup,
} from '@shots/platejs-editor/ui'
import { useKeys } from '../shortcuts'
import { useRefine } from './refine'

/** Bold and italic, filled while on. */
function Mark({ label, nodeType, shortcut }: { label: string; nodeType: string; shortcut: string }) {
  const { pressed } = useMarkToolbarButtonState({ nodeType })
  const Icon = nodeType === KEYS.bold ? TextBIcon : TextItalicIcon
  return (
    <MarkToolbarButton aria-label={label} nodeType={nodeType} tooltip={`${label} (${shortcut})`}>
      <Icon aria-hidden weight={pressed ? 'fill' : 'regular'} />
    </MarkToolbarButton>
  )
}

/**
 * The bar over selected text: Bold, Italic, Link, Rewrite and Comment. Rewrite
 * opens Refine on the selection at the post, as ⌘J does.
 */
function SelectionTools() {
  const editor = useEditorRef()
  const refine = useRefine()
  const { mod } = useKeys()
  return (
    <FloatingToolbar aria-label="Selected text tools">
      <ToolbarGroup>
        <Mark label="Bold" nodeType={KEYS.bold} shortcut={`${mod}B`} />
        <Mark label="Italic" nodeType={KEYS.italic} shortcut={`${mod}I`} />
        <LinkToolbarButton aria-label="Link" tooltip={`Link (${mod}K)`} />
      </ToolbarGroup>
      <ToolbarGroup>
        {refine ? (
          <ToolbarButton
            aria-label="Rewrite selection"
            onClick={() => refine.open()}
            onMouseDown={(event) => event.preventDefault()}
            tooltip={`Rewrite selection (${mod}J)`}
          >
            <SparkleIcon aria-hidden className="text-primary" />
          </ToolbarButton>
        ) : null}
        {editor.plugins[KEYS.comment] ? <CommentToolbarButton aria-label="Comment" /> : null}
      </ToolbarGroup>
    </FloatingToolbar>
  )
}

/** Replaces the kit's document formatting bar in Write's editor. */
export const SelectionToolbarPlugin = createPlatePlugin({
  key: 'floating-toolbar',
  render: { afterEditable: () => <SelectionTools /> },
})
