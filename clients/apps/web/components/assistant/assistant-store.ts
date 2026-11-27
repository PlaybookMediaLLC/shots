'use client'

import { useCallback, useState } from 'react'
import { create } from 'zustand'
import type { AiEffort, AiModelTier } from '@/lib/ai/models/tiers'
import type { AssistantContextRef } from '@/lib/api/contracts/ai'
import type { AssistantEntry, AssistantPresentationMode } from '@/lib/assistant/ability'
import { resumedMemory, type SavedEntry } from '@/lib/assistant/saved-thread'

const MAX_CONTEXT_REFS = 6

/**
 * Shared state for the unified Shots assistant across every page and editor.
 * Kept outside individual pages so a conversation survives navigating across
 * pages that share an ability, and resets cleanly when switching workspaces.
 */
export type AssistantStoreState = {
  abilityId: string | null
  /** What each card in the thread has made or done, so hiding the panel loses nothing. */
  cards: Record<string, unknown>
  /** Explicit workspace items pinned to this thread via the `@` context picker. */
  contextRefs: AssistantContextRef[]
  controller: AbortController | null
  /** Per-thread reasoning effort override; null inherits workspace/surface default. */
  effortOverride: AiEffort | null
  entries: AssistantEntry[]
  /** The saved thread these entries belong to; null until the first run. */
  threadId: string | null
  /** Text a page or readiness card asks to put in the composer (`'*'` matches any active ability). */
  prefill: { abilityId: string; text: string } | null
  /** The reply being written now. */
  draft: string
  /** Live step label while long tools execute (e.g. "Generating AI background…"). */
  statusLabel: string
  /** Bumped whenever a trigger asks for cursor focus in the composer. */
  focus: number
  memory: { current: unknown[] }
  /** Active presentation mode when the user explicitly toggled Dock vs Bar. */
  modeOverride: AssistantPresentationMode | null
  /** Per-thread model tier override; null inherits workspace/surface default. */
  modelTierOverride: AiModelTier | null
  open: boolean
  /** Organization the current thread belongs to; switching workspaces resets it. */
  organizationId: string | null
  /** Whether the active selection scope chip is currently applied. */
  scopeEnabled: boolean
}

const MODE_STORAGE_KEY = 'shots:assistant-mode'

/** Hydrate any persisted Dock/Bar preference once on the client. */
export function loadStoredAssistantMode(): AssistantPresentationMode | null {
  if (typeof window === 'undefined') return null
  try {
    const value = window.localStorage.getItem(MODE_STORAGE_KEY)
    return value === 'bar' || value === 'dock' ? value : null
  } catch {
    return null
  }
}

export const useAssistantStore = create<AssistantStoreState>(() => ({
  abilityId: null,
  cards: {},
  contextRefs: [],
  controller: null,
  draft: '',
  effortOverride: null,
  entries: [],
  focus: 0,
  prefill: null,
  statusLabel: '',
  threadId: null,
  memory: { current: [] },
  modeOverride: null,
  modelTierOverride: null,
  open: false,
  organizationId: null,
  scopeEnabled: true,
}))

/** Open the assistant on any page with a pre-filled prompt ready to review and send. */
export function openAssistantWithPrompt(text: string) {
  useAssistantStore.setState((state) => ({
    focus: state.focus + 1,
    open: true,
    prefill: { abilityId: '*', text },
  }))
}

/** Pin or unpin one workspace context reference for the active thread. */
export function toggleAssistantContextRef(ref: AssistantContextRef) {
  useAssistantStore.setState((state) => {
    const exists = state.contextRefs.some((item) => item.kind === ref.kind && item.id === ref.id)
    if (exists) {
      return {
        contextRefs: state.contextRefs.filter(
          (item) => !(item.kind === ref.kind && item.id === ref.id)
        ),
      }
    }
    return { contextRefs: [...state.contextRefs, ref].slice(-MAX_CONTEXT_REFS) }
  })
}

/** Override model tier and/or reasoning effort for the active thread (null resets to default). */
export function setAssistantModelOverride(
  modelTierOverride: AiModelTier | null,
  effortOverride: AiEffort | null
) {
  useAssistantStore.setState({ effortOverride, modelTierOverride })
}

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
  try {
    window.localStorage.setItem(MODE_STORAGE_KEY, mode)
  } catch {
    // Storage unavailable (private browsing); keep in-memory override.
  }
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

/** Append one entry to the active assistant thread and return its assigned id. */
export function pushAssistantEntry(entry: AssistantEntry): number {
  const id = ++entryCount
  useAssistantStore.setState((state) => ({
    entries: [...state.entries, { ...entry, id }],
  }))
  return id
}

/** Update the live status of an existing activity entry in place. */
export function updateAssistantActivity(id: number, status: 'running' | 'done' | 'error') {
  useAssistantStore.setState((state) => ({
    entries: state.entries.map((entry) =>
      entry.id === id && entry.kind === 'activity'
        ? { ...entry, done: status === 'done', status }
        : entry
    ),
  }))
}

/** Start a fresh conversation for `abilityId`. */
export function startAssistantOver(abilityId: string | null) {
  useAssistantStore.setState({
    abilityId,
    cards: {},
    contextRefs: [],
    draft: '',
    effortOverride: null,
    entries: [],
    memory: { current: [] },
    modelTierOverride: null,
    statusLabel: '',
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
    contextRefs: [],
    effortOverride: null,
    entries: entries.map((entry) => ({ ...entry, id: ++entryCount })),
    memory: { current: resumedMemory(entries) },
    modelTierOverride: null,
    open: true,
    threadId,
  })
}

/** Reset conversation state whenever the signed-in workspace changes. */
export function syncAssistantOrganization(organizationId: string | null) {
  const state = useAssistantStore.getState()
  if (state.organizationId === organizationId) return
  const switchedWorkspace = state.organizationId !== null
  state.controller?.abort()
  useAssistantStore.setState({
    abilityId: null,
    cards: {},
    contextRefs: [],
    controller: null,
    effortOverride: null,
    entries: [],
    memory: { current: [] },
    modelTierOverride: null,
    draft: '',
    organizationId,
    ...(switchedWorkspace ? { prefill: null } : {}),
    statusLabel: '',
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
