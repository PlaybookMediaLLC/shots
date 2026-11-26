'use client'

import { useEffect, useRef } from 'react'
import type { z } from 'zod'
import type {
  AssistantAbility,
  AssistantEntry,
  AssistantPresentationMode,
  AssistantQuickAction,
} from '@/lib/assistant/ability'
import type { AssistantSurfaceKind, PageEntity } from '@/lib/assistant/page-context'
import type { AppliedEdit } from '@/lib/assistant/surface-edits'
import { useAssistantAbility, useAssistantPage } from './AssistantProvider'
import { type ClientToolExecutor, runUnifiedAssistant } from './run-unified-assistant'

/** The inspect and edit tools of a surface that changes through typed commands. */
export function commandExecutor<C>({
  editTool,
  editSchema,
  inspectTool,
  inspect,
  apply,
}: {
  editTool: string
  editSchema: z.ZodType<{ commands: C[]; summary: string }>
  inspectTool: string
  inspect: () => unknown
  /** Applies every command or throws having applied none. */
  apply: (commands: C[]) => AppliedEdit
}): ClientToolExecutor {
  return async (call, { push }) => {
    if (call.toolName === inspectTool)
      return { type: 'text', value: JSON.stringify(inspect()).slice(0, 200_000) }
    if (call.toolName !== editTool)
      return { type: 'error-text', value: `Unknown tool ${call.toolName}.` }
    const parsed = editSchema.safeParse(call.input)
    if (!parsed.success)
      return { type: 'error-text', value: `Invalid commands: ${parsed.error.message.slice(0, 600)}` }
    const edit = apply(parsed.data.commands)
    const entry: AssistantEntry = {
      kind: 'change',
      text: parsed.data.summary,
      undo: () => {
        if (!edit.isNewest()) return false
        edit.undo()
        return true
      },
    }
    push(entry)
    return { type: 'text', value: JSON.stringify({ applied: true }) }
  }
}

/** Register a studio with the assistant: its tools, page facts, and suggested asks. */
export function useSurfaceAbility({
  active = true,
  entity,
  moreEntities = [],
  facts,
  prompts,
  setupLink,
  executeClientTool,
  label,
  placeholder,
  preferredMode = 'dock',
  quickActions,
  selection = null,
  surface,
  tools,
}: {
  active?: boolean
  entity: PageEntity
  /** Further open items the page reports, such as the platform being written for. */
  moreEntities?: PageEntity[]
  prompts?: AssistantAbility['prompts']
  setupLink?: AssistantAbility['setupLink']
  facts: string[]
  executeClientTool: ClientToolExecutor
  label: string
  placeholder: string
  preferredMode?: AssistantPresentationMode
  quickActions: readonly AssistantQuickAction[]
  selection?: string | null
  surface: AssistantSurfaceKind
  tools: readonly string[]
}) {
  // The executor closes over live state; a run in progress must see the newest.
  const latest = useRef(executeClientTool)
  useEffect(() => {
    latest.current = executeClientTool
  })
  useAssistantAbility(
    {
      id: `${surface}:${entity.id}`,
      label,
      placeholder,
      preferredMode,
      priority: 10,
      prompts,
      quickActions,
      setupLink,
      run: (run) =>
        runUnifiedAssistant({
          ...run,
          clientTools: tools,
          executeClientTool: (call, context) => latest.current(call, context),
        }),
      selection,
      suggestions: quickActions.map((action) => action.prompt),
      surface,
    },
    active
  )
  useAssistantPage({ entities: [entity, ...moreEntities], facts }, active)
}
