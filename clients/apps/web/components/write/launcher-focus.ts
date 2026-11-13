'use client'

import * as React from 'react'

/**
 * Remember what had focus when a dialog opened, and put focus back there when
 * it closes. Radix returns focus only to a DialogTrigger; a dialog opened from
 * state or a shortcut has none. In a contenteditable the caret is put back too
 * (focusing one alone moves its caret to the start), and the scroll of the
 * surrounding `main` stays where it was.
 */
export function useLauncherFocus(): { remember: () => void; restore: () => void } {
  const launcher = React.useRef<HTMLElement | null>(null)
  const range = React.useRef<Range | null>(null)
  const scroll = React.useRef<{ element: HTMLElement; top: number; left: number } | null>(null)
  const remember = React.useCallback(() => {
    launcher.current = document.activeElement as HTMLElement | null
    const selection = window.getSelection()
    const current = selection?.rangeCount ? selection.getRangeAt(0) : null
    range.current =
      current && launcher.current?.contains(current.commonAncestorContainer)
        ? current.cloneRange()
        : null
    const element = launcher.current?.closest('main')
    scroll.current = element ? { element, top: element.scrollTop, left: element.scrollLeft } : null
  }, [])
  const restore = React.useCallback(() => {
    // Once the dialog's focus trap has released, not while it still holds focus.
    setTimeout(() => {
      // Another dialog opened as this one closed (Preview, on a phone): leave it focused.
      if (!launcher.current?.isConnected || document.activeElement?.closest('[role="dialog"]'))
        return
      launcher.current.focus({ preventScroll: true })
      const saved = range.current
      if (saved?.startContainer.isConnected && saved.endContainer.isConnected) {
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(saved)
      }
      const place = scroll.current
      if (place?.element.isConnected) place.element.scrollTo(place.left, place.top)
    }, 0)
  }, [])
  return { remember, restore }
}
