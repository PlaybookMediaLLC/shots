'use client'

import { useAssistantAbility } from '@/components/assistant/AssistantProvider'
import { runUnifiedAssistant } from '@/components/assistant/run-unified-assistant'

/**
 * Create's assistant ability: opens prominently on `/create` with visual-first
 * suggestions, backed by the real unified workspace assistant so both creative
 * starts (`startWork`) and workspace questions work seamlessly with attachments.
 */
export function CreateVisualAbility() {
  useAssistantAbility({
    id: 'create-visual',
    label: 'Create',
    placeholder: 'Describe a visual to start, or ask anything about your workspace',
    priority: 10,
    prominent: true,
    suggestions: [
      'Make a dark hero shot for a new feature',
      'Make a clean pricing visual on a soft gradient',
      'Start a product launch canvas',
      'What did I work on lately?',
    ],
    run: (run) => runUnifiedAssistant({ ...run, clientTools: [] }),
  })
  return null
}
