'use client'

import * as React from 'react'
import type { PublicationNode } from './publish-handoff'

/**
 * Media on its way from the screenshot editor into a draft.
 *
 * Publishing opens the draft at once and keeps rendering in the editor behind
 * it, so a person writes while a video encodes. Each export is a job here,
 * keyed by draft; the composer shows its progress and, once it is stored,
 * takes its attachments and inserts them through its own editor, so they
 * reach the draft the way any attachment does: in the live document, saved
 * with the person's next edit, never by replacing the body from outside.
 *
 * Jobs live in this browser tab only. A refresh leaves the draft as it was
 * saved; an export that was still running has to be started again.
 */

/** Where one export stands. */
export type IncomingState = 'working' | 'ready' | 'failed'

/** One export headed for a draft. */
export type IncomingJob = {
  id: string
  /** What it is, as the person chose it: "Image", "Video (MP4)", "All 3 slides". */
  label: string
  /** 0–100 while working. */
  progress: number
  state: IncomingState
  error?: string
  /** Attached already, so it is never inserted twice. */
  taken: boolean
}

type Run = (report: (progress: number) => void) => Promise<PublicationNode[]>

type Entry = IncomingJob & { nodes: PublicationNode[]; run: Run }

const jobs = new Map<string, Entry[]>()
/**
 * Exports run one at a time, whichever draft they are for: they all draw the
 * editor's one stage and report into its one export progress store.
 */
let chain: Promise<void> = Promise.resolve()

function enqueue(draftId: string, entry: Entry) {
  chain = chain.then(() => execute(draftId, entry))
}
const snapshots = new Map<string, readonly IncomingJob[]>()
const listeners = new Set<() => void>()
const EMPTY: readonly IncomingJob[] = []

function publish(draftId: string) {
  snapshots.set(
    draftId,
    (jobs.get(draftId) ?? []).map(({ nodes: _nodes, run: _run, ...job }) => job)
  )
  listeners.forEach((listener) => listener())
}

function update(draftId: string, id: string, change: Partial<Entry>) {
  const list = jobs.get(draftId)
  const entry = list?.find((job) => job.id === id)
  if (!entry) return
  Object.assign(entry, change)
  publish(draftId)
}

async function execute(draftId: string, entry: Entry) {
  update(draftId, entry.id, { error: undefined, progress: 0, state: 'working' })
  try {
    const nodes = await entry.run((progress) =>
      update(draftId, entry.id, { progress: Math.max(0, Math.min(100, progress)) })
    )
    update(draftId, entry.id, { nodes, progress: 100, state: 'ready' })
  } catch (error) {
    update(draftId, entry.id, {
      error: error instanceof Error ? error.message : 'The export failed.',
      state: 'failed',
    })
  }
}

/** Start an export for a draft; it runs after any export already under way. */
export function startIncomingMedia(draftId: string, label: string, run: Run): string {
  const entry: Entry = {
    id: crypto.randomUUID(),
    label,
    nodes: [],
    progress: 0,
    run,
    state: 'working',
    taken: false,
  }
  jobs.set(draftId, [...(jobs.get(draftId) ?? []), entry])
  publish(draftId)
  enqueue(draftId, entry)
  return entry.id
}

/** Run a failed export again. */
export function retryIncomingMedia(draftId: string, id: string): void {
  const entry = jobs.get(draftId)?.find((job) => job.id === id)
  if (!entry || entry.state !== 'failed') return
  // Working again at once, so a second click cannot queue it twice.
  update(draftId, id, { error: undefined, progress: 0, state: 'working' })
  enqueue(draftId, entry)
}

/** Forget a finished or failed export; one still running keeps going. */
export function dismissIncomingMedia(draftId: string, id: string): void {
  const list = jobs.get(draftId)
  if (!list) return
  jobs.set(
    draftId,
    list.filter((job) => job.id !== id || job.state === 'working')
  )
  publish(draftId)
}

/**
 * The attachments of every stored export not yet attached, in the order they
 * were started, marked as taken: a second call returns nothing, so a
 * re-rendering composer can never insert them twice.
 */
export function takeIncomingMedia(draftId: string): PublicationNode[] {
  const list = jobs.get(draftId) ?? []
  const ready = list.filter((job) => job.state === 'ready' && !job.taken)
  if (ready.length === 0) return []
  for (const job of ready) job.taken = true
  publish(draftId)
  return ready.flatMap((job) => job.nodes)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The exports headed for a draft, for its composer. */
export function useIncomingMedia(draftId: string): readonly IncomingJob[] {
  return React.useSyncExternalStore(
    subscribe,
    () => snapshots.get(draftId) ?? EMPTY,
    () => EMPTY
  )
}

/** The exports headed for a draft right now, outside React. */
export function incomingMedia(draftId: string): readonly IncomingJob[] {
  return snapshots.get(draftId) ?? EMPTY
}
