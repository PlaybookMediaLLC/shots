'use client'

import { usePathname, useSearchParams } from 'next/navigation'
import { useEffect } from 'react'
import { platformArea, safeReturnPath } from '@/lib/platform/navigation'
import { withoutLocale } from '@/lib/settings/appearance'

/** The page outside settings this tab was last on, so leaving settings returns there. */
const ORIGIN_KEY = 'shots:settings-origin'
/** The pages this tab visited, newest first, for Search's Recently visited. */
const RECENT_KEY = 'shots:recent-pages'
const RECENT_LIMIT = 8

/** Records each page this tab shows; mounted once in the shell. */
export function RememberVisits() {
  const pathname = usePathname()
  const query = useSearchParams().toString()
  useEffect(() => {
    const page = `${withoutLocale(pathname)}${query ? `?${query}` : ''}`
    try {
      if (platformArea(pathname) !== 'settings')
        sessionStorage.setItem(ORIGIN_KEY, query ? `${pathname}?${query}` : pathname)
      sessionStorage.setItem(
        RECENT_KEY,
        JSON.stringify(
          [page, ...recentPages().filter((item) => item !== page)].slice(0, RECENT_LIMIT)
        )
      )
    } catch {
      /* Without storage, leaving settings opens Home and Search lists no recent pages. */
    }
  }, [pathname, query])
  return null
}

/** Where leaving settings goes: the page settings was opened from, or Home. */
export function settingsOrigin(): string {
  try {
    return safeReturnPath(sessionStorage.getItem(ORIGIN_KEY))
  } catch {
    return '/home'
  }
}

/** The pages this tab visited, newest first, without their locale. */
export function recentPages(): string[] {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(stored)
      ? stored.filter(
          (item): item is string => typeof item === 'string' && safeReturnPath(item, '') !== ''
        )
      : []
  } catch {
    return []
  }
}
