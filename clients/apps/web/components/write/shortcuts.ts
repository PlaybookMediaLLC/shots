'use client'

import * as React from 'react'

/**
 * Write's keyboard contract (RFC 025, spec §26), with the platform's
 * modifier: ⌘ on macOS, Ctrl elsewhere. A shortcut never fires while a text
 * field or a dialog owns the keystroke unless it is marked for editors, and
 * publishing shortcuts only open the review; they never publish.
 */

/** Whether this browser is on an Apple platform. */
export function isApple(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
  )
}

const noSubscription = () => () => {}

/**
 * Shortcut labels for this platform: ⌘ and ⌥ on Apple, Ctrl and Alt
 * elsewhere. The server cannot tell, so it and hydration render Ctrl, then
 * the browser corrects it.
 */
export function useKeys() {
  const apple = React.useSyncExternalStore(noSubscription, isApple, () => false)
  const mod = apple ? '⌘' : 'Ctrl+'
  const alt = apple ? '⌥' : 'Alt+'
  return {
    alt,
    /** A shortcut's keys as the person reads them. */
    label: (shortcut: Pick<Shortcut, 'alt' | 'key' | 'mod' | 'shift'>) =>
      [
        shortcut.mod ? mod : '',
        shortcut.alt ? alt : '',
        shortcut.shift ? '⇧' : '',
        KEY_NAMES[shortcut.key] ?? shortcut.key.toUpperCase(),
      ].join(''),
    mod,
  }
}

const KEY_NAMES: Record<string, string> = {
  arrowdown: '↓',
  arrowup: '↑',
  enter: '↵',
}

/** One shortcut: its keys, what it does, and where it may fire. */
export type Shortcut = {
  /** Fires inside the editor and other text fields too. */
  inEditor?: boolean
  /** Lowercase key, as KeyboardEvent.key reports it (". " "enter" "arrowup"…). */
  key: string
  label: string
  mod?: boolean
  alt?: boolean
  shift?: boolean
  run: () => void
}

/** Whether a text field, an editor, or a dialog owns the keystroke. */
function owned(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element) return false
  if (element.closest('[role="dialog"],[role="alertdialog"],[role="menu"]')) return true
  return Boolean(element.closest('input,textarea,select,[contenteditable="true"]'))
}

/** Whether a key event matches a shortcut, with the platform's modifier. */
export function matches(event: KeyboardEvent, shortcut: Shortcut): boolean {
  const mod = isApple() ? event.metaKey : event.ctrlKey
  return (
    event.key.toLowerCase() === shortcut.key &&
    Boolean(shortcut.mod) === mod &&
    Boolean(shortcut.alt) === event.altKey &&
    Boolean(shortcut.shift) === event.shiftKey
  )
}

/** Listen for shortcuts on the window while mounted. */
export function useShortcuts(shortcuts: Shortcut[]): void {
  const onKey = React.useEffectEvent((event: KeyboardEvent) => {
    for (const shortcut of shortcuts) {
      if (!matches(event, shortcut)) continue
      if (!shortcut.inEditor && owned(event.target)) return
      event.preventDefault()
      shortcut.run()
      return
    }
  })
  React.useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])
}

/** The editor commands' keys (composer/commands.tsx); the shortcut reference lists these too. */
export const COMMAND_SHORTCUTS = [
  { id: 'ai-ask', key: 'j', label: 'Ask AI at the post', mod: true },
  { id: 'post-new', key: 'enter', label: 'New post below', mod: true },
  { id: 'insert-media', key: 'i', label: 'Image or video', mod: true, shift: true },
  { id: 'insert-emoji', key: '.', label: 'Emoji', mod: true, shift: true },
  { id: 'insert-link', key: 'k', label: 'Link on the selected text', mod: true },
] as const satisfies readonly (Pick<Shortcut, 'key' | 'mod' | 'shift'> & { id: string; label: string })[]
