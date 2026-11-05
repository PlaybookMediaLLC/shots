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
  { document: DraftDocument; discussions: DraftDiscussions; version: number; generation: number }
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
  const savedCallback = React.useRef(onSaved)
  savedCallback.current = onSaved
  const discussions = React.useRef(recovery?.discussions ?? readDiscussions(draft.discussions))
  const dirty = React.useRef(Boolean(recovery))
  const [retryCount, setRetryCount] = React.useState(0)
  const retryable = React.useRef(true)
  const inFlight = React.useRef<Promise<boolean> | null>(null)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const legacyText = React.useRef(Object.keys(draft.channelText).length > 0)

  const reloadLatest = React.useCallback(async () => {
    const fresh = await draftsApi.get(draft.id)
    version.current = fresh.version
    generation.current = fresh.collabGeneration
    pendingDocuments.delete(draft.id)
    discussions.current = readDiscussions(fresh.discussions)
    setServer(fresh)
    latest.current = documentOf(fresh)
    dirty.current = false
    setDocument(latest.current)
    setEditorKey((key) => key + 1)
  }, [draft.id])

  const keepConflict = React.useCallback(
    (mine: DraftDocument) => {
      conflictedDocuments.set(draft.id, mine)
      setConflict(mine)
    },
    [draft.id]
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
          setServer(saved)
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
            // Another editor's autosave moved the version: save on top of it,
            // keeping the comment threads they saved as well as ours.
            const fresh = await draftsApi.get(draft.id)
            if (fresh.collabGeneration !== generation.current) {
              const mine = latest.current
              await reloadLatest()
              keepConflict(mine)
              setSaveState('saved')
              toast.info('This draft was replaced elsewhere. Your edit is kept above the editor.')
              return false
            }
            version.current = fresh.version
            discussions.current = mergeDiscussions(
              discussions.current,
              readDiscussions(fresh.discussions)
            )
            continue
          }
          if (error instanceof DraftRequestError && error.status === 409) {
            // Someone saved a newer version: show it, and keep ours to restore or copy.
            const mine = latest.current
            await reloadLatest()
            keepConflict(mine)
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
          discussions: discussions.current,
          version: version.current,
          generation: generation.current,
        })
    }
  }, [canEdit, collaborating, draft.id, keepConflict, reloadLatest])

  const scheduleSave = React.useCallback(() => {
    if (!canEdit) return
    dirty.current = true
    setRetryCount(0)
    pendingDocuments.set(draft.id, {
      document: latest.current,
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

  // A draft the server sent back (scheduled, archived, reviewed): newer
  // saves build on its version; a late, older answer never moves it back.
  const adopt = React.useCallback((next: DraftWire) => {
    version.current = Math.max(version.current, next.version)
    setServer(next)
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
