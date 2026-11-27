'use client'

import { useEffect } from 'react'

const classRefCounts = new Map<string, number>()

/**
 * Mirrors editor font variable classes onto `<html>` while any EditorFontsScope
 * is mounted so Radix portals (`Sheet`, `Dialog`, `Popover`, `Select`) under
 * `document.body` inherit all `--font-*` CSS variables.
 */
export function EditorFontsPortalBridge({ className }: { className: string }) {
  useEffect(() => {
    const tokens = className.split(/\s+/).filter(Boolean)
    const root = document.documentElement
    for (const token of tokens) {
      const next = (classRefCounts.get(token) ?? 0) + 1
      classRefCounts.set(token, next)
      if (next === 1) root.classList.add(token)
    }
    return () => {
      for (const token of tokens) {
        const next = (classRefCounts.get(token) ?? 1) - 1
        if (next <= 0) {
          classRefCounts.delete(token)
          root.classList.remove(token)
        } else {
          classRefCounts.set(token, next)
        }
      }
    }
  }, [className])

  return null
}
