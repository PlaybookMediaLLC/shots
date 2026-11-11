'use client'

import * as React from 'react'
import { toast } from 'sonner'
import type { Value } from '@shots/platejs-editor/platejs'
import { DraftRequestError, type DraftWire, draftsApi } from '@/lib/content-drafts/client'
import {
  type DraftDiscussions,
  mergeDiscussions,
  readDiscussions,
} from '@/lib/content-drafts/discussions'
import { type DraftChannel, draftPlainText, serializeDraft } from '@/lib/content-drafts/serialize'
import {
  type Article,
  type DraftTarget,
  type PlatformVersions,
  primaryChannel,
} from '@/lib/write/document'
import { normalizeMentions } from '@/lib/write/normalize-mentions'
import { readVersions } from '@/lib/write/versions'

/**
 * A draft's document in the composer (RFC 025): the primary body, the
 * platform versions, the title, destinations, target and article, saved on
 * a short debounce against the version the editor last saw. A save that
 * meets a newer version reloads it (or, in a live session, merges comment
 * threads and saves again) instead of overwriting it.
 */

/** Where the last save stands. */
export type SaveState = 'saved' | 'saving' | 'unsaved' | 'error' | 'offline'

/** How long typing waits before a save. */
const AUTOSAVE_DELAY_MS = 800

// Keep failed edits across client route changes (including browser Back).
const pendingDocuments = new Map<
  string,
  {
    document: DraftDocument
    baseline: DraftDocument
    discussions: DraftDiscussions
    version: number
    generation: number
  }
>()
// A local edit a newer version replaced, kept until the writer restores or discards it.
const conflictedDocuments = new Map<string, DraftDocument>()

/** The parts of a draft the composer edits and saves. */
export type DraftDocument = {
  article: Article | null
  channelConnectionIds: string[]
  primaryPlatform: DraftChannel
  target: DraftTarget | null
  title: string
  value: Value
  versions: PlatformVersions
}

/** The document a draft opens with: legacy per-channel text becomes manual versions. */
export function documentOf(draft: DraftWire): DraftDocument {
  return {
    article: draft.article,
    channelConnectionIds: draft.channelConnectionIds,
    primaryPlatform: primaryChannel(draft.primaryPlatform),
    target: draft.target,
    title: draft.title === 'Untitled draft' ? '' : draft.title,
    value: normalizeMentions(draft.body) as Value,
    versions: readVersions(
      draft.platformVersions,
      draft.channelText as Partial<Record<DraftChannel, string>>,
      draft.body
    ),
  }
}

/** The composer's draft state and its saving. */
export function useDraftDocument({
  canEdit,
  collaborating,
  draft,
  onSaved,
}: {
  canEdit: boolean
  /** In a live session every editor holds the same body. */
  collaborating: boolean
  draft: DraftWire
  onSaved?: (saved: DraftWire) => void
}) {
  const [recovery] = React.useState(() => pendingDocuments.get(draft.id))
  const [conflict, setConflict] = React.useState<DraftDocument | null>(
    () => conflictedDocuments.get(draft.id) ?? null
  )
  const [document, setDocument] = React.useState<DraftDocument>(
    () => recovery?.document ?? documentOf(draft)
  )
  const [editorKey, setEditorKey] = React.useState(0)
  const [saveState, setSaveState] = React.useState<SaveState>(recovery ? 'error' : 'saved')
  const [server, setServer] = React.useState<DraftWire>(draft)
  const version = React.useRef(recovery?.version ?? draft.version)
  const generation = React.useRef(recovery?.generation ?? draft.collabGeneration)
  const latest = React.useRef(document)
  const baseline = React.useRef(recovery?.baseline ?? document)
  const serverRecord = React.useRef(draft)
  const savedCallback = React.useRef(onSaved)
  savedCallback.current = onSaved
  const discussions = React.useRef(recovery?.discussions ?? readDiscussions(draft.discussions))
  const dirty = React.useRef(Boolean(recovery))
  const [retryCount, setRetryCount] = React.useState(0)
  const retryable = React.useRef(true)
  const inFlight = React.useRef<Promise<boolean> | null>(null)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const legacyText = React.useRef(Object.keys(draft.channelText).length > 0)

  const replaceLatest = React.useCallback(
    (fetched: DraftWire, preserveConflict = false) => {
      const fresh = fetched.version >= serverRecord.current.version ? fetched : serverRecord.current
      if (preserveConflict) {
        conflictedDocuments.set(draft.id, latest.current)
        setConflict(latest.current)
      }
      version.current = fresh.version
      generation.current = fresh.collabGeneration
      pendingDocuments.delete(draft.id)
      discussions.current = readDiscussions(fresh.discussions)
      serverRecord.current = fresh
      setServer(fresh)
      latest.current = documentOf(fresh)
      baseline.current = latest.current
      dirty.current = false
      setDocument(latest.current)
      setEditorKey((key) => key + 1)
    },
    [draft.id]
  )

  const reloadLatest = React.useCallback(
    async (preserveConflict = false) => {
      replaceLatest(await draftsApi.get(draft.id), preserveConflict)
    },
    [draft.id, replaceLatest]
  )

  const save = React.useCallback(async (): Promise<boolean> => {
    if (!canEdit) return !dirty.current
    if (inFlight.current) return inFlight.current
    if (!dirty.current) return true
    const run = (async () => {
      setSaveState('saving')
      for (let attempt = 0; ; attempt += 1) {
        const next = latest.current
        // An open "@", "#" or ":" lookup saves as the text typed so far, in the body and the plain text.
        const body = normalizeMentions(next.value)
        dirty.current = false
        try {
          const saved = await draftsApi.save(draft.id, {
            article: next.article ?? undefined,
            assetIds: serializeDraft(next.value, 'linkedin').assetIds,
            baseVersion: version.current,
            collabGeneration: collaborating ? generation.current : undefined,
            body,
            channelConnectionIds: next.channelConnectionIds,
            // Legacy per-channel text moved into platform versions: clear it once.
            ...(legacyText.current ? { channelText: {} } : {}),
            discussions: discussions.current,
            plainText: draftPlainText(body),
            platformVersions: normalizeMentions(next.versions),
            primaryPlatform: next.primaryPlatform,
            target: next.target ?? undefined,
            title: next.title,
          })
          pendingDocuments.delete(draft.id)
          setRetryCount(0)
          legacyText.current = false
          version.current = saved.version
          generation.current = saved.collabGeneration
          baseline.current = documentOf(saved)
          if (saved.version >= serverRecord.current.version) {
            serverRecord.current = saved
            setServer(saved)
          }
          savedCallback.current?.(saved)
          // Drain edits made during this request before reporting Saved or leaving.
          if (dirty.current) {
            attempt = -1
            continue
          }
          setSaveState('saved')
          return true
        } catch (error) {
          if (
            error instanceof DraftRequestError &&
            error.status === 409 &&
            collaborating &&
            attempt < 3
          ) {
            const fresh = await draftsApi.get(draft.id)
            const remote = documentOf(fresh)
            // Only the primary body is shared live. Rebase the other fields against
            // the document that our version belongs to, refusing overlapping edits.
            const merged = { ...latest.current }
            let overlaps = fresh.collabGeneration !== generation.current
            for (const key of Object.keys(remote) as (keyof DraftDocument)[]) {
              if (key === 'value') continue
              const localValue = JSON.stringify(latest.current[key])
              const remoteValue = JSON.stringify(remote[key])
              const baseValue = JSON.stringify(baseline.current[key])
              if (localValue === baseValue) Object.assign(merged, { [key]: remote[key] })
              else if (remoteValue !== baseValue && remoteValue !== localValue) overlaps = true
            }
            if (overlaps) {
              replaceLatest(fresh, true)
              setSaveState('saved')
              toast.info('This draft was changed elsewhere. Your edit is kept above the editor.')
              return false
            }
            latest.current = merged
            setDocument(merged)
            baseline.current = remote
            version.current = fresh.version
            discussions.current = mergeDiscussions(
              discussions.current,
              readDiscussions(fresh.discussions)
            )
            continue
          }
          if (error instanceof DraftRequestError && error.status === 409) {
            // Someone saved a newer version: show it, and keep ours to restore or copy.
            await reloadLatest(true)
            setSaveState('saved')
            toast.info('This draft was changed elsewhere. Your edit is kept above the editor.')
            return false
          }
          if (
            error instanceof DraftRequestError &&
            (error.status === 404 || error.status === 403)
          ) {
            dirty.current = true
            retryable.current = false
            setSaveState('error')
            toast.error('You no longer have access to this draft; nothing more is saved.')
            return false
          }
          retryable.current =
            !(error instanceof DraftRequestError) || error.status >= 500 || error.status === 429
          dirty.current = true
          setSaveState(typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'error')
          return false
        }
      }
    })().catch(() => {
      // A failed conflict reload must keep the local revision dirty, too.
      dirty.current = true
      setSaveState(typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'error')
      return false
    })
    inFlight.current = run
    try {
      return await run
    } finally {
      inFlight.current = null
      if (dirty.current)
        pendingDocuments.set(draft.id, {
          document: latest.current,
          baseline: baseline.current,
          discussions: discussions.current,
          version: version.current,
          generation: generation.current,
        })
    }
  }, [canEdit, collaborating, draft.id, replaceLatest, reloadLatest])

  const scheduleSave = React.useCallback(() => {
    if (!canEdit) return
    dirty.current = true
    setRetryCount(0)
    pendingDocuments.set(draft.id, {
      document: latest.current,
      baseline: baseline.current,
      discussions: discussions.current,
      version: version.current,
      generation: generation.current,
    })
    setSaveState('unsaved')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void save(), AUTOSAVE_DELAY_MS)
  }, [canEdit, draft.id, save])

  /** Change the document and save it shortly. */
  const update = React.useCallback(
    (change: Partial<DraftDocument> | ((current: DraftDocument) => Partial<DraftDocument>)) => {
      const current = latest.current
      latest.current = { ...current, ...(typeof change === 'function' ? change(current) : change) }
      setDocument(latest.current)
      scheduleSave()
    },
    [scheduleSave]
  )

  /** Put the conflicting edit back over the newer version and save it on top. */
  const restoreConflict = React.useCallback(() => {
    const mine = conflictedDocuments.get(draft.id)
    conflictedDocuments.delete(draft.id)
    setConflict(null)
    if (!mine) return
    latest.current = mine
    setDocument(mine)
    setEditorKey((key) => key + 1)
    scheduleSave()
  }, [draft.id, scheduleSave])

  /** Drop the conflicting edit and keep the newer version. */
  const discardConflict = React.useCallback(() => {
    conflictedDocuments.delete(draft.id)
    setConflict(null)
  }, [draft.id])

  /** Save now, waiting for any save in flight: before scheduling, sharing, or leaving. */
  const flush = React.useCallback(async () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    if (!(await save()))
      throw new Error('The latest changes could not be saved. Try again before continuing.')
  }, [save])

  const onDiscussionsChange = React.useCallback(
    (next: DraftDiscussions) => {
      discussions.current = next
      scheduleSave()
    },
    [scheduleSave]
  )

  React.useEffect(() => {
    if (saveState !== 'error' || !retryable.current || retryCount >= 3) return
    const retry = setTimeout(
      () => {
        setRetryCount((count) => count + 1)
        void save()
      },
      1000 * 2 ** retryCount
    )
    return () => clearTimeout(retry)
  }, [retryCount, save, saveState])

  // A failed save retries when the network comes back, keeping the edits.
  React.useEffect(() => {
    const retry = () => {
      if (dirty.current) void save()
    }
    window.addEventListener('online', retry)
    return () => window.removeEventListener('online', retry)
  }, [save])
  // Leaving with unsaved edits asks first.
  React.useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (dirty.current || inFlight.current) event.preventDefault()
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [])
  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      void save()
    },
    [save]
  )

  // Metadata responses may contain remote edits. A write version advances only
  // together with its document; dirty/in-flight work keeps its conflict protection.
  const adopt = React.useCallback((next: DraftWire) => {
    if (next.version < version.current || next.version < serverRecord.current.version) return
    serverRecord.current = next
    setServer(next)
    if (next.version === version.current || dirty.current || inFlight.current) return
    version.current = next.version
    generation.current = next.collabGeneration
    baseline.current = documentOf(next)
    latest.current = baseline.current
    discussions.current = readDiscussions(next.discussions)
    setDocument(latest.current)
    setEditorKey((key) => key + 1)
  }, [])
  return {
    conflict,
    discardConflict,
    discussions,
    document,
    editorKey,
    flush,
    onDiscussionsChange,
    reloadLatest,
    restoreConflict,
    saveState,
    server,
    setServer: adopt,
    update,
    versionRef: version,
  }
}
