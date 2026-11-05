'use client'

import * as React from 'react'
import { HashIcon } from '@phosphor-icons/react/dist/ssr/Hash'
import {
  type TriggerComboboxPluginOptions,
  withTriggerCombobox,
} from '@shots/platejs-editor/@platejs/combobox'
import { createTSlatePlugin, type PluginConfig } from '@shots/platejs-editor/platejs'
import {
  createPlatePlugin,
  PlateElement,
  type PlateElementProps,
  toPlatePlugin,
} from '@shots/platejs-editor/platejs/react'
import {
  InlineCombobox,
  InlineComboboxContent,
  InlineComboboxInput,
  InlineComboboxItem,
} from '@shots/platejs-editor/ui'

/** Hashtags the workspace already writes, most used first (the composer's vocabulary). */
export const HashtagsContext = React.createContext<readonly string[]>([])

/**
 * "#" after a space or at the start of a line suggests the workspace's
 * hashtags as you type. Picking one writes "#tag "; a space or Enter ends a
 * new tag as plain text, so writing a hashtag never waits on the menu.
 */
function HashtagInput(props: PlateElementProps) {
  const { editor, element } = props
  const hashtags = React.useContext(HashtagsContext)
  return (
    <PlateElement
      {...props}
      as="span"
      className="rounded-sm bg-accent px-0.5 text-accent-foreground"
    >
      <InlineCombobox closeOnSpace="always" element={element} trigger="#">
        <InlineComboboxInput aria-label="Hashtag" />
        <InlineComboboxContent aria-label="Hashtags">
          {hashtags.slice(0, 50).map((tag) => (
            <InlineComboboxItem
              key={tag}
              onClick={() => editor.tf.insertText(`#${tag} `)}
              value={tag}
            >
              <HashIcon aria-hidden className="text-muted-foreground" />
              {tag}
            </InlineComboboxItem>
          ))}
        </InlineComboboxContent>
      </InlineCombobox>
      {props.children}
    </PlateElement>
  )
}

const HashtagInputPlugin = createPlatePlugin({
  editOnly: true,
  key: 'hashtag_input',
  node: { component: HashtagInput, isElement: true, isInline: true, isVoid: true },
})

/** The "#" trigger; its input element is transient and never saved (normalizeMentions). */
const HashtagTriggerPlugin = toPlatePlugin(
  createTSlatePlugin<PluginConfig<'hashtag', TriggerComboboxPluginOptions>>({
    key: 'hashtag',
    options: {
      createComboboxInput: (trigger) => ({
        children: [{ text: '' }],
        trigger,
        type: 'hashtag_input',
      }),
      trigger: '#',
      triggerPreviousCharPattern: /^\s?$/,
    },
  }).overrideEditor(withTriggerCombobox)
)

/** Hashtag autocomplete: the trigger and its input element. */
export const HashtagPlugins = [HashtagTriggerPlugin, HashtagInputPlugin]
