import type { DesignChanges } from '@/lib/design/document'
import type { AssistantSurfaceKind, PageContext } from './page-context'

/** Characters one message to the assistant may have. */
export const ASSISTANT_ASK_MAX = 4_000

/** How the unified Shots Assistant is presented on screen. */
export type AssistantPresentationMode = 'bar' | 'dock'

/** One design review suggestion rendered as an interactive one-click card. */
export type AssistantDesignSuggestion = {
  changes: DesignChanges
  reason: string
  title: string
}

/** One quick action chip offered directly in the unified Assistant header/strip. */
export type AssistantQuickAction = {
  description?: string
  id: string
  label: string
  /** Sends a prompt directly through the unified assistant. */
  prompt: string
}

/**
 * The unified assistant's plug-in point. Every page and editor registers what
 * it offers via `useAssistantAbility` while keeping workspace-wide capabilities
 * composed inside the same conversation.
 */

/** One item in the assistant's conversation thread. */
export type AssistantEntry = {
  /** Assigned by the thread; names the card's saved state. */
  id?: number
  /** The part of the surface a card acts on; the card is idle while another is open. */
  target?: string
} & (
  | { kind: 'user' | 'assistant' | 'error' | 'note'; text: string }
  /** A live or completed tool step indicator shown while the assistant works. */
  | { kind: 'activity'; text: string; done?: boolean }
  /**
   * A change applied directly to the open canvas/document. `undo` answers false,
   * and changes nothing, once a newer edit exists.
   */
  | { kind: 'change'; text: string; undo?: () => boolean }
  | { kind: 'link'; text: string; href: string }
  /** A post the assistant wrote, offered to open as a draft. */
  | { kind: 'post'; text: string }
  /** Up to three one-click design critique improvements applied in one undo step. */
  | { kind: 'suggestions'; items: AssistantDesignSuggestion[] }
  /** Inline side-by-side design variants explorer inside the unified assistant. */
  | { kind: 'variants'; count: number; instruction: string }
  /** Inline captions & alt-text panel inside the unified assistant. */
  | { kind: 'captions'; instruction?: string }
  /** Offered draft text. `accept` answers false, and changes nothing, if the draft moved on. */
  | { kind: 'proposal'; text: string; summary: string; accept: () => boolean }
  /** Buttons to post the open design or keep it in the library. */
  | { kind: 'handoff' }
  /** Inline on-device PII redaction scanner & review card inside the unified assistant. */
  | { kind: 'redactions'; autoScan?: boolean }
)

/** What an ability's run gets. */
export type AbilityRun = {
  ask: string
  /** Attached images as base64 JPEG. */
  images?: readonly string[]
  page: PageContext
  /** Aborts when the person stops the run, the page closes, or the ability goes. */
  signal: AbortSignal
  push: (entry: AssistantEntry) => void
  /** Shows the reply as it is written; an empty string clears it. */
  stream?: (text: string) => void
  /** Kept between turns of one conversation with this ability; cleared by New chat. */
  memory: { current: unknown[] }
  /** Active selection scope label when the user kept scope enabled, or null. */
  selection?: string | null
}

/** Something the assistant can do on the page it is registered from. */
export type AssistantAbility = {
  /** Stable for one target: a new id starts a new conversation. */
  id: string
  /** Active editing surface kind (e.g. `screenshot-editor`, `store-screenshots`, `canvas`). */
  surface?: AssistantSurfaceKind
  /** What the assistant acts on, shown beside the input ("Screenshot Editor", "Artboard 2 · Hero"). */
  label: string
  placeholder: string
  /** Default presentation mode on this surface (`dock` for editors, `bar` for platform pages). */
  preferredMode?: AssistantPresentationMode
  /** Saved prompts the person picks to start a message, then edits before sending. */
  prompts?: readonly { label: string; text: string }[]
  /** A page where this surface's assistant is set up. */
  setupLink?: { href: string; label: string }
  /** One-click asks shown when the conversation is empty. */
  suggestions?: readonly string[]
  /** Always-accessible quick tools shown as compact chips (e.g. Review, Variants, Captions, Redact). */
  quickActions?: readonly AssistantQuickAction[]
  /** Live selected layer/element label when the user has something selected on the surface. */
  selection?: string | null
  /** The part of the surface cards would act on now, e.g. the open artboard. */
  target?: string
  /** The highest registered priority answers; the workspace assistant is 0. */
  priority: number
  /** Open the bar on arrival, as where this ability is the page's main tool. */
  prominent?: boolean
  /** Do the work, reporting through `push`. A throw is shown as the run's error. */
  run: (run: AbilityRun) => Promise<void>
}
