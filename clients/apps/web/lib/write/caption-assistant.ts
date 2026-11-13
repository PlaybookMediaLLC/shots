/**
 * The UGC caption assistant: a product description in, ideas for the video's
 * text out. Each request has a number; an answer counts only while its request
 * is the one waiting, so an answer that arrives after Cancel, after the dialog
 * closed or after a newer request changes nothing.
 */
export type AssistantState =
  | { phase: 'closed' }
  | { error?: string; phase: 'describe' }
  | { phase: 'requesting'; request: number }
  | { choices: string[]; phase: 'choices' }

/** What happens in the assistant. */
export type AssistantAction =
  | { type: 'open' }
  | { request: number; type: 'request' }
  | { choices: string[]; request: number; type: 'answered' }
  | { error: string; request: number; type: 'failed' }
  | { type: 'close' }

/** The assistant's next state. */
export function captionAssistant(state: AssistantState, action: AssistantAction): AssistantState {
  switch (action.type) {
    case 'open':
      return { phase: 'describe' }
    case 'request':
      return { phase: 'requesting', request: action.request }
    case 'answered':
    case 'failed': {
      if (state.phase !== 'requesting' || state.request !== action.request) return state
      if (action.type === 'failed') return { error: action.error, phase: 'describe' }
      const choices = action.choices.map((choice) => choice.trim()).filter(Boolean)
      return choices.length
        ? { choices, phase: 'choices' }
        : { error: 'No ideas came back. Try again.', phase: 'describe' }
    }
    case 'close':
      return { phase: 'closed' }
  }
}
