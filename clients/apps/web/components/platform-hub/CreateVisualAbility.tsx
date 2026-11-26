'use client'

import { useRouter } from 'next/navigation'
import { useAssistantAbility } from '@/components/assistant/AssistantProvider'
import { editorAskHref } from '@/lib/ai/editor-ask'

/**
 * Create's assistant ability: describe a visual, and a new screenshot opens
 * with the editor's copilot holding the request (the assistant bar reads `ask`).
 * Rendered only for members who may edit.
 */
export function CreateVisualAbility() {
  const router = useRouter()
  useAssistantAbility({
    id: 'create-visual',
    label: 'New screenshot',
    placeholder: 'Describe the visual you want, then add your screenshot',
    priority: 10,
    prominent: true,
    suggestions: [
      'A dark hero shot for a new feature',
      'A clean pricing page on a soft gradient',
      'A phone mockup for our app release',
    ],
    run: async ({ ask, push }) => {
      push({ kind: 'note', text: 'Opening the editor with your request…' })
      router.push(editorAskHref(ask))
    },
  })
  return null
}
