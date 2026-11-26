'use client'

import { commandExecutor, useSurfaceAbility } from '@/components/assistant/use-surface-ability'
import { applyToSession } from '@/lib/assistant/surface-edits'
import { storySetEditSchema } from '@/lib/assistant/surface-commands'
import { applySetCommand, type SetCommand } from '@/lib/creative-sets/commands'
import type { CreativeSetSession } from '@/lib/creative-sets/session'

/** Registers a Story Set with the assistant: read it, and edit it through its commands. */
export function useStorySetAbility({
  activeOutputId,
  canEdit,
  flush,
  session,
}: {
  activeOutputId: string
  canEdit: boolean
  /** Saves what the open canvas holds, before a command reads the document. */
  flush: () => void
  session: CreativeSetSession
}) {
  const { document } = session.snapshot()
  useSurfaceAbility({
    active: canEdit,
    entity: { id: session.record.id, name: session.record.name, type: 'story-set' },
    executeClientTool: commandExecutor<SetCommand>({
      apply: (commands) => {
        flush()
        return applyToSession(session, applySetCommand, commands)
      },
      editSchema: storySetEditSchema,
      editTool: 'editStorySet',
      inspect: () => {
        flush()
        const { stories, outputs } = session.snapshot().document
        return {
          activeOutputId,
          outputs: outputs.map((output) => ({
            id: output.id,
            overrides: output.overrides,
            storyId: output.storyId,
            texts: output.document.texts.map((text) => ({ id: text.id, text: text.text })),
          })),
          stories: stories.map((story) => ({ ...story, source: undefined })),
        }
      },
      inspectTool: 'inspectStorySet',
    }),
    facts: [
      `A Story Set with ${document.stories.length} stories and ${document.outputs.length} formats.`,
    ],
    label: 'Story Set',
    placeholder: 'Ask to write story captions, adjust wording, or reorder stories',
    quickActions: [
      { id: 'captions', label: 'Story captions', prompt: 'Write a sharp headline for each story.' },
      { id: 'flow', label: 'Check flow', prompt: 'Review the story order and wording.' },
    ],
    surface: 'creative-sets',
    tools: ['inspectStorySet', 'editStorySet'],
  })
}
