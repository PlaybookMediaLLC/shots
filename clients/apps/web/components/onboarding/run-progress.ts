'use client'

import { useEffect, useRef, useState } from 'react'
import type { StoredOnboardingRun } from '@/lib/tenant/onboarding-runs'
import { useTRPCClient } from '@/lib/trpc/react'

/** The run's stages and the share of the progress bar each one fills (RFC 034). */
export const ONBOARDING_STAGES = [
  { from: 0, key: 'fast_path', label: 'First read', to: 20 },
  { from: 20, key: 'crawl', label: 'Reading your pages', to: 55 },
  { from: 55, key: 'classify', label: 'Updating the profile', to: 75 },
  { from: 75, key: 'enrich', label: 'Looking around the web', to: 85 },
  { from: 85, key: 'icp', label: 'Finding your customer', to: 95 },
  { from: 95, key: 'brand', label: 'Seeding your brand', to: 98 },
  { from: 98, key: 'surfaces', label: 'Mapping product pages', to: 100 },
] as const

/** One of {@link ONBOARDING_STAGES}. */
export type OnboardingStage = (typeof ONBOARDING_STAGES)[number]

/** Whether a run has ended and will not change again. */
export function isTerminal(status: string): boolean {
  return status !== 'queued' && status !== 'running'
}

/** How far a stage is, 0–100, from the run's monotonic progress. */
export function stagePercent(run: StoredOnboardingRun, stage: OnboardingStage): number {
  if ((run.completedStages as string[]).includes(stage.key) || run.progress >= stage.to) return 100
  if (run.progress <= stage.from) return 0
  return Math.round(((run.progress - stage.from) / (stage.to - stage.from)) * 100)
}

/** The label of the stage a run is on. */
export function stageLabel(run: StoredOnboardingRun): string {
  return ONBOARDING_STAGES.find((stage) => stage.key === run.stage)?.label ?? 'Finishing up'
}

/**
 * A run kept current: polled with backoff from 1s to 5s until it ends.
 * `onAdvance` runs when progress moves or the run ends, before the new state
 * is shown, so callers can refresh what the run changed. `setRun` replaces
 * the run (after a cancel or re-run) and restarts polling for it.
 */
export function useOnboardingRun(
  initial: StoredOnboardingRun,
  onAdvance?: (run: StoredOnboardingRun, signal: AbortSignal) => Promise<void>
) {
  const trpcClient = useTRPCClient()
  const [run, setRunState] = useState(initial)
  const [lost, setLost] = useState(false)
  const [revision, setRevision] = useState(0)
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const progress = useRef(initial.progress)
  const advance = useRef(onAdvance)
  useEffect(() => {
    advance.current = onAdvance
  }, [onAdvance])

  useEffect(() => {
    if (isTerminal(run.status)) return
    const ownedGeneration = generation.current
    const abort = new AbortController()
    controller.current = abort
    const active = () => !abort.signal.aborted && generation.current === ownedGeneration
    let delay = 1_000
    let failures = 0
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = (
          await trpcClient.onboarding.run.query({ runId: run.id }, { signal: abort.signal })
        ).run
        if (!active()) return
        if (next.progress > progress.current || isTerminal(next.status)) {
          await advance.current?.(next, abort.signal)
          if (!active()) return
          progress.current = next.progress
        }
        if (!active()) return
        failures = 0
        setLost(false)
        setRunState(next)
        if (isTerminal(next.status)) return
      } catch {
        if (!active()) return
        failures += 1
        if (failures >= 5) {
          setLost(true)
          return
        }
      }
      if (!active()) return
      delay = Math.min(5_000, delay * 1.5)
      timer = setTimeout(poll, delay)
    }
    timer = setTimeout(poll, delay)
    return () => {
      abort.abort()
      clearTimeout(timer)
    }
  }, [revision, run.id, run.status, trpcClient])

  const setRun = (next: StoredOnboardingRun) => {
    generation.current++
    controller.current?.abort()
    setLost(false)
    setRevision((value) => value + 1)
    progress.current = next.progress
    setRunState(next)
  }
  return { lost, run, setRun, retry: () => setRun(run) }
}
