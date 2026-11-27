'use client'

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CircleDashedIcon } from '@phosphor-icons/react/dist/ssr/CircleDashed'
import { SparkleIcon } from '@phosphor-icons/react/dist/ssr/Sparkle'
import { XIcon } from '@phosphor-icons/react/dist/ssr/X'
import { openAssistantWithPrompt } from '@/components/assistant/assistant-store'
import { useAiAvailable } from '@/components/assistant/useAiAvailable'
import { SidebarLink } from '@/components/platform-shell/SidebarLink'
import { Button } from '@/components/ui/button'
import { useTRPC } from '@/lib/trpc/react'

const STORAGE_KEY_PREFIX = 'shots:readiness-card-hidden'

const SETUP_PROMPT =
  'Check my workspace setup with inspectWorkspaceSetup, tell me what is still missing, and walk me step by step through configuring my product profile, brand kit, product pages, and first campaign or AI agent. I will review and enter any secrets myself.'

/**
 * Bottom-left workspace readiness card anchored above the sidebar footer.
 * Tracks product profile, brand kit, product pages, and first campaign/agent
 * with a single hairline progress bar and an "Ask Shots to set up" action.
 */
export function WorkspaceReadinessCard({
  onNavigate,
  workspaceId,
}: {
  onNavigate?: () => void
  workspaceId: string
}) {
  const trpc = useTRPC()
  const aiAvailable = useAiAvailable()
  const [hidden, setHidden] = useState(true)
  const storageKey = `${STORAGE_KEY_PREFIX}:${workspaceId}`

  useEffect(() => {
    try {
      setHidden(window.localStorage.getItem(storageKey) === '1')
    } catch {
      setHidden(false)
    }
  }, [storageKey])

  const readiness = useQuery(
    trpc.workspace.readiness.queryOptions(undefined, {
      enabled: !hidden,
      refetchOnWindowFocus: false,
      staleTime: 5 * 60_000,
    })
  )

  const complete = Boolean(
    readiness.data && readiness.data.total > 0 && readiness.data.completed >= readiness.data.total
  )

  // Remember finished workspaces so completed paid workspaces stop polling on every reload.
  useEffect(() => {
    if (!complete) return
    setHidden(true)
    try {
      window.localStorage.setItem(storageKey, '1')
    } catch {
      // Storage unavailable; hide for this session only.
    }
  }, [complete, storageKey])

  if (hidden || !readiness.data || complete) return null
  const { completed, steps, total } = readiness.data
  if (total === 0) return null

  const remaining = steps.filter((step) => !step.done)
  const percent = Math.round((completed / total) * 100)

  function dismiss() {
    setHidden(true)
    try {
      window.localStorage.setItem(storageKey, '1')
    } catch {
      // Storage unavailable; dismiss for this session only.
    }
  }

  return (
    <div
      aria-label="Finish setting up workspace"
      className="rounded-xl border border-border bg-card p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-foreground">Finish setting up</p>
        <Button
          aria-label="Dismiss setup checklist"
          className="grid size-5 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
          onClick={dismiss}
          size={null}
          type="button"
          variant="custom"
        >
          <XIcon aria-hidden="true" className="size-3" />
        </Button>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <div
          aria-hidden="true"
          className="h-1 flex-1 overflow-hidden rounded-full bg-foreground/[0.1]"
        >
          <div
            className="h-full rounded-full bg-foreground transition-[width] duration-300"
            style={{ width: `${Math.max(8, percent)}%` }}
          />
        </div>
        <span className="shrink-0 text-[0.6875rem] text-muted-foreground tabular-nums">
          {completed} of {total}
        </span>
      </div>

      <ul className="mt-2.5 space-y-1.5">
        {remaining.slice(0, 3).map((step) => (
          <li key={step.id}>
            <SidebarLink
              className="flex items-center gap-2 rounded-md text-xs text-foreground/85 transition-colors hover:text-foreground"
              href={step.href}
              onNavigate={onNavigate}
            >
              <CircleDashedIcon
                aria-hidden="true"
                className="size-3.5 shrink-0 text-muted-foreground"
              />
              <span className="truncate">{step.label}</span>
            </SidebarLink>
          </li>
        ))}
      </ul>

      {aiAvailable ? (
        <Button
          className="mt-3 h-7 w-full justify-center gap-1.5 rounded-lg text-xs"
          onClick={() => {
            onNavigate?.()
            openAssistantWithPrompt(SETUP_PROMPT)
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          <SparkleIcon aria-hidden="true" className="size-3" />
          Ask Shots to set up
        </Button>
      ) : null}
    </div>
  )
}
