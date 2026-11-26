'use client'

import { useEffect, useRef } from 'react'
import type { z } from 'zod'
import { commandExecutor, useSurfaceAbility } from '@/components/assistant/use-surface-ability'
import { tweetEditSchema } from '@/lib/assistant/surface-commands'

type Command = z.infer<typeof tweetEditSchema>['commands'][number]
type Style = Omit<Required<Command>, 'type'>

/** Registers the tweet image editor with the assistant. Outside the app shell it does nothing. */
export function useTweetAbility({
  style,
  text,
  update,
}: {
  style: Style
  /** The post's words, which the assistant reads and never changes. */
  text: string
  update: (patch: Partial<Style>) => void
}) {
  const live = useRef(style)
  useEffect(() => {
    live.current = style
  })
  useSurfaceAbility({
    entity: { id: 'tweet-image', name: 'Tweet image', type: 'tweet-image' },
    executeClientTool: (call, context) =>
      commandExecutor<Command>({
        apply: (commands) => {
          const { padding, showBackground, theme } = live.current
          const before = { padding, showBackground, theme }
          let after = before
          for (const { type: _type, ...patch } of commands) after = { ...after, ...patch }
          const change = (next: Style) => {
            live.current = next
            update(next)
          }
          change(after)
          const applied = JSON.stringify(after)
          return {
            isNewest: () => {
              const now = live.current
              return (
                JSON.stringify({
                  padding: now.padding,
                  showBackground: now.showBackground,
                  theme: now.theme,
                }) === applied
              )
            },
            undo: () => change(before),
          }
        },
        editSchema: tweetEditSchema,
        editTool: 'editTweet',
        inspect: () => ({ post: text.slice(0, 4_000), style: live.current }),
        inspectTool: 'inspectTweet',
      })(call, context),
    facts: ['The tweet image editor. The assistant can style the card and draft a companion post.'],
    label: 'Tweet image',
    placeholder: 'Ask to restyle the card or write a companion post',
    quickActions: [
      { id: 'dark', label: 'Dark card', prompt: 'Make the card dark with more padding.' },
      { id: 'post', label: 'Companion post', prompt: 'Draft a post to share with this image.' },
    ],
    surface: 'tweet-image',
    tools: ['inspectTweet', 'editTweet'],
  })
}
