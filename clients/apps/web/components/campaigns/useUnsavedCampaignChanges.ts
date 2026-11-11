'use client'

import { useEffect } from 'react'
import { registerNavigationGuard } from '@/lib/platform/navigation-guard'
import { guardWorkflowNavigation } from '@/lib/workflows/navigation-guard'

let activeEditors = 0
let removeListeners: (() => void) | undefined

/** Protect campaign drafts across links, history, reloads and guarded router actions. */
export function useUnsavedCampaignChanges(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return
    activeEditors++
    if (activeEditors === 1) {
      const confirm = () => window.confirm('Leave without saving your changes?')
      const removeGuard = registerNavigationGuard(() => {
        if (!confirm()) throw new Error('Save or discard your changes before leaving.')
      }, true)
      const removeNavigation = guardWorkflowNavigation((leave) => {
        if (confirm()) leave()
      })
      removeListeners = () => {
        removeGuard()
        removeNavigation()
      }
    }
    return () => {
      if (--activeEditors === 0) removeListeners?.()
    }
  }, [dirty])
}
