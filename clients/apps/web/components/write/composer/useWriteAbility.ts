'use client'

import { type RefObject, useEffect, useRef, useState } from 'react'
import type { PlateEditor } from '@shots/platejs-editor/platejs/react'
import { useSurfaceAbility } from '@/components/assistant/use-surface-ability'
import { useAssistantStore } from '@/components/assistant/assistant-store'
import { appendPost } from '@/components/drafts/thread'
import { socialSetHref } from '@/components/workspace/settings-sections'
import { WRITING_PROMPTS } from '@/lib/write/prompt-library'
import { promptBrief, screenshotPrompts } from '@/lib/write/screenshot-post'
import { draftProposalSchema } from '@/lib/assistant/surface-commands'
import { type DraftChannel, DRAFT_CHANNEL_LIMITS } from '@/lib/content-drafts/serialize'

/**
 * Registers the post composer with the assistant: it reads the open draft and
 * offers text as a card. The draft changes only when the writer accepts.
 */
/** Starting points for a conversation about the draft. */
const STARTERS = [
  'Give me three stronger hooks for the first post.',
  'How could the ending get more replies?',
  'What is unclear or too long here?',
  'Adapt this for LinkedIn.',
  'Continue this unfinished thought using only the facts in this draft.',
  'Give constructive feedback on clarity, evidence, and audience fit. Do not rewrite yet.',
  'Suggest a concise call to action that follows naturally from this draft.',
  'Suggest two relevant emoji and explain where each fits.',
]

export function useWriteAbility({
  canManageSets,
  hasImage,
  openWithPrompt,
  openOnArrival,
  setId,
  canEditText,
  channel,
  draftId,
  editor,
  posts,
  title,
}: {
  canManageSets: boolean
  /** The draft carries a screenshot, so the image prompts come first. */
  hasImage: boolean
  /** A saved prompt the draft was opened with, put in the composer to send. */
  openWithPrompt: string | null
  /** The address asks for the assistant to be open. */
  openOnArrival: boolean
  /** The publishing profile whose voice the assistant writes in. */
  setId: string | null
  /** The open tab's own text may be changed. */
  canEditText: boolean
  channel: DraftChannel
  draftId: string
  editor: RefObject<PlateEditor | null>
  posts: string[]
  title: string
}) {
  // What is open when the writer clicks Accept, not when the text was offered.
  const open = useRef({ canEditText, channel })
  useEffect(() => {
    open.current = { canEditText, channel }
  })
  const selected = () => {
    const at = editor.current?.selection
    const text = at ? editor.current!.api.string(at) : ''
    return at && text ? { at: structuredClone(at), text } : null
  }
  const [selectionLabel, setSelectionLabel] = useState<string | null>(null)
  useEffect(() => {
    let timer: number | null = null
    const sync = () => {
      if (
        document.activeElement instanceof HTMLElement &&
        document.activeElement.hasAttribute('data-assistant-composer')
      ) {
        return
      }
      const instance = editor.current
      const at = instance?.selection
      if (!instance || !at || instance.api.isCollapsed()) {
        if (timer !== null) {
          window.clearTimeout(timer)
          timer = null
        }
        setSelectionLabel((prev) => (prev === null ? prev : null))
        return
      }
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        try {
          const currentSelection = editor.current?.selection
          const current =
            currentSelection && !editor.current!.api.isCollapsed()
              ? editor.current!.api.string(currentSelection).trim()
              : ''
          const next = current
            ? `Selected text (“${current.slice(0, 48)}${current.length > 48 ? '…' : ''}”)`
            : null
          setSelectionLabel((prev) => (prev === next ? prev : next))
        } catch {
          setSelectionLabel(null)
        }
      }, 120)
    }
    document.addEventListener('selectionchange', sync)
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      document.removeEventListener('selectionchange', sync)
    }
  }, [editor])
  const saved = hasImage ? screenshotPrompts() : [...WRITING_PROMPTS]
  const arrived = useRef(false)
  const firstPosts = useRef(posts)
  useEffect(() => {
    if (arrived.current || (!openOnArrival && !openWithPrompt)) return
    arrived.current = true
    const chosen = WRITING_PROMPTS.find((prompt) => prompt.id === openWithPrompt)
    useAssistantStore.setState({
      prefill: {
        abilityId: `write-composer:${draftId}`,
        text: chosen ? promptBrief(chosen, firstPosts.current.join('\n\n')) : '',
      },
    })
  }, [draftId, openOnArrival, openWithPrompt])
  useSurfaceAbility({
    moreEntities: [{ id: channel, type: 'channel' }],
    prompts: [
      ...saved.map((prompt) => ({
        label: prompt.title,
        text: hasImage ? promptBrief(prompt) : prompt.instruction,
      })),
      ...STARTERS.map((text) => ({ label: text, text })),
    ],
    setupLink:
      setId && canManageSets
        ? {
            href: socialSetHref(setId, 'writing-assistant'),
            label: 'Style guide and samples',
          }
        : undefined,
    entity: { id: draftId, name: title || 'Untitled draft', type: 'draft' },
    executeClientTool: async (call, { push }) => {
      if (call.toolName === 'inspectDraft') {
        return {
          type: 'text',
          value: JSON.stringify({
            channel,
            characterLimit: DRAFT_CHANNEL_LIMITS[channel],
            posts,
            selectedText: selected()?.text ?? null,
          }),
        }
      }
      const parsed = draftProposalSchema.safeParse(call.input)
      if (call.toolName !== 'proposeDraftText' || !parsed.success)
        return { type: 'error-text', value: 'Invalid draft proposal.' }
      const { mode, summary, text } = parsed.data
      const target = mode === 'replace-selection' ? selected() : null
      if (mode === 'replace-selection' && !target)
        return { type: 'error-text', value: 'No text is selected. Offer a new post instead.' }
      if (!canEditText)
        return { type: 'error-text', value: 'This version of the draft cannot be edited.' }
      push({
        accept: () => {
          const current = editor.current
          if (!current || !open.current.canEditText || open.current.channel !== channel) return false
          if (!target) {
            appendPost(current, text)
            return true
          }
          try {
            if (current.api.string(target.at) !== target.text) return false
            current.tf.insertText(text, { at: target.at })
            return true
          } catch {
            // The selected block no longer exists.
            return false
          }
        },
        kind: 'proposal',
        summary,
        text,
      })
      return {
        type: 'text',
        value: 'Offered the text as a card. The draft is unchanged until the writer accepts it.',
      }
    },
    facts: [
      `A post draft for ${channel} with ${posts.length} post${posts.length === 1 ? '' : 's'}.`,
    ],
    label: 'Post draft',
    placeholder: 'Ask to tighten, adapt, or continue this draft',
    quickActions: [
      { id: 'tighten', label: 'Tighten', prompt: 'Tighten the first post for this platform.' },
      { id: 'hooks', label: 'Hooks', prompt: 'Offer a stronger opening post.' },
    ],
    selection: selectionLabel,
    surface: 'write-composer',
    tools: ['inspectDraft', 'proposeDraftText'],
  })
}
