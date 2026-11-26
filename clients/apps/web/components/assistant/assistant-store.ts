'use client'

import { useCallback, useState } from 'react'
import { create } from 'zustand'
import type { AssistantEntry, AssistantPresentationMode } from '@/lib/assistant/ability'
import { resumedMemory, type SavedEntry } from '@/lib/assistant/saved-thread'

/**
 * Shared state for the unified Shots assistant across every page and editor.
 * Kept outside individual pages so a conversation survives navigating across
 * pages that share an ability, and resets cleanly when switching workspaces.
 */
export type AssistantStoreState = {
  abilityId: string | null
  /** What each card in the thread has made or done, so hiding the panel loses nothing. */
  cards: Record<string, unknown>
  controller: AbortController | null
  entries: AssistantEntry[]
  /** The saved thread these entries belong to; null until the first run. */
  threadId: string | null
  /** Text a page asks to put in the composer, once its ability is the active one. */
  prefill: { abilityId: string; text: string } | null
  /** The reply being written now. */
  draft: string
  /** Bumped whenever a trigger asks for cursor focus in the composer. */
  focus: number
  memory: { current: unknown[] }
  /** Active presentation mode when the user explicitly toggled Dock vs Bar. */
  modeOverride: AssistantPresentationMode | null
  open: boolean
  /** Organization the current thread belongs to; switching workspaces resets it. */
  organizationId: string | null
  /** Whether the active selection scope chip is currently applied. */
  scopeEnabled: boolean
}

export const useAssistantStore = create<AssistantStoreState>(() => ({
  abilityId: null,
  cards: {},
  controller: null,
  draft: '',
  entries: [],
  focus: 0,
  prefill: null,
  threadId: null,
  memory: { current: [] },
  modeOverride: null,
  open: false,
  organizationId: null,
  scopeEnabled: true,
}))

/** Open the assistant and move focus to its composer. */
export function openAssistant(mode?: AssistantPresentationMode) {
  useAssistantStore.setState((state) => ({
    focus: state.focus + 1,
    ...(mode ? { modeOverride: mode } : {}),
    open: true,
  }))
}

/** Hide the assistant without clearing the conversation. */
export function closeAssistant() {
  useAssistantStore.setState({ open: false })
}

/** Toggle the assistant open or closed, focusing the composer when opening. */
export function toggleAssistant(mode?: AssistantPresentationMode) {
  useAssistantStore.setState((state) => {
    if (state.open) return { open: false }
    return {
      focus: state.focus + 1,
      ...(mode ? { modeOverride: mode } : {}),
      open: true,
    }
  })
}

/** Explicitly switch between compact floating bar and docked side inspector. */
export function setAssistantMode(mode: AssistantPresentationMode) {
  useAssistantStore.setState({ modeOverride: mode })
}

/** Saves and deletes of saved chats run one at a time, so a late save cannot undo a delete. */
let chatWrites: Promise<unknown> = Promise.resolve()
export function queueChatWrite<T>(write: () => Promise<T>): Promise<T> {
  const next = chatWrites.then(write, write)
  chatWrites = next.catch(() => undefined)
  return next
}

let entryCount = 0

/** Append one entry to the active assistant thread. */
export function pushAssistantEntry(entry: AssistantEntry) {
  useAssistantStore.setState((state) => ({
    entries: [...state.entries, { ...entry, id: ++entryCount }],
  }))
}

/** Start a fresh conversation for `abilityId`. */
export function startAssistantOver(abilityId: string | null) {
  useAssistantStore.setState({
    abilityId,
    cards: {},
    draft: '',
    entries: [],
    memory: { current: [] },
    threadId: null,
  })
}

/** Show a saved thread; the next message continues it. */
export function resumeAssistantThread(
  abilityId: string,
  threadId: string,
  entries: SavedEntry[]
) {
  useAssistantStore.setState({
    abilityId,
    cards: {},
    entries: entries.map((entry) => ({ ...entry, id: ++entryCount })),
    memory: { current: resumedMemory(entries) },
    open: true,
    threadId,
  })
}

/** Reset conversation state whenever the signed-in workspace changes. */
export function syncAssistantOrganization(organizationId: string | null) {
  const state = useAssistantStore.getState()
  if (state.organizationId === organizationId) return
  state.controller?.abort()
  useAssistantStore.setState({
    abilityId: null,
    cards: {},
    controller: null,
    entries: [],
    memory: { current: [] },
    draft: '',
    organizationId,
    threadId: null,
  })
}


/** `useState` for a thread card: the value lives with the conversation, not the component. */
export function useCardState<T>(key: string, initial: T) {
  const saved = useAssistantStore((state) => state.cards[key]) as T | undefined
  const [fallback] = useState(initial)
  const set = useCallback(
    (next: T | ((current: T) => T)) =>
      useAssistantStore.setState((state) => {
        const current = (key in state.cards ? state.cards[key] : fallback) as T
        const value = typeof next === 'function' ? (next as (current: T) => T)(current) : next
        return { cards: { ...state.cards, [key]: value } }
      }),
    [fallback, key]
  )
  return [saved === undefined ? fallback : saved, set] as const
}
