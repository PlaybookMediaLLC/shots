import { newId } from '../document/factory'
import { readStoreDocument, type MigrationResult } from '../document/migrate'
import type { StoreDocument } from '../document/schema'
import {
  deleteRecord,
  getAllRecords,
  getRecord,
  putRecord,
  requestResult,
  STORES,
  transact,
} from './db'

/**
 * Project, version, and asset persistence with revision checks.
 *
 * Every save names the revision it was based on. If another tab saved a
 * newer revision first, the save fails with `ProjectConflictError` instead
 * of overwriting it, and the editor asks the user what to keep.
 */

/** A stored project. `document` is validated when read. */
export type ProjectRecord = {
  id: string
  name: string
  updatedAt: number
  slideCount: number
  thumbnail: string | null
  document: unknown
}

/** What the project library lists. */
export type ProjectSummary = Omit<ProjectRecord, 'document'>

/** A named snapshot of a project. */
export type VersionRecord = {
  id: string
  projectId: string
  name: string
  createdAt: number
  slideCount: number
  thumbnail: string | null
  document: unknown
}

/** A stored image. */
export type AssetRecord = { id: string; blob: Blob; mime: string; bytes: number; createdAt: number }

/** Another tab saved this project after the revision being saved. */
export class ProjectConflictError extends Error {
  /** The newer stored document. */
  readonly stored: unknown

  /** Create a conflict error carrying the stored document. */
  constructor(stored: unknown) {
    super('This project was changed in another tab.')
    this.name = 'ProjectConflictError'
    this.stored = stored
  }
}

const CHANNEL_NAME = 'shots-store-projects'

/** Identifies this tab in cross-tab messages. */
export const TAB_ID = typeof crypto !== 'undefined' ? crypto.randomUUID() : 'server'

/** Cross-tab save notification. */
export type SavedMessage = { type: 'saved'; projectId: string; revision: number; tabId: string }

let poster: BroadcastChannel | null = null

function announce(message: SavedMessage): void {
  if (typeof BroadcastChannel === 'undefined') return
  poster ??= new BroadcastChannel(CHANNEL_NAME)
  poster.postMessage(message)
}

/** Listen for saves from other tabs. Returns an unsubscribe function. */
export function onProjectSaved(listener: (message: SavedMessage) => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined
  const subscription = new BroadcastChannel(CHANNEL_NAME)
  subscription.onmessage = (event: MessageEvent<SavedMessage>) => {
    if (event.data?.type === 'saved' && event.data.tabId !== TAB_ID) listener(event.data)
  }
  return () => subscription.close()
}

/** All projects, most recent first. */
export async function listProjects(): Promise<ProjectSummary[]> {
  const records = await getAllRecords<ProjectRecord>(STORES.projects)
  return records
    .map(({ document: _document, ...summary }) => summary)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Load and upgrade a project. */
export async function loadProject(id: string): Promise<MigrationResult | null> {
  const record = await getRecord<ProjectRecord>(STORES.projects, id)
  return record ? readStoreDocument(record.document) : null
}

/**
 * Save a project if the stored revision still equals `baseRevision`.
 * Returns the saved document with its new revision.
 */
export async function saveProject(
  document: StoreDocument,
  baseRevision: number,
  thumbnail: string | null
): Promise<StoreDocument> {
  const saved = { ...document, revision: baseRevision + 1 }
  await transact([STORES.projects], 'readwrite', async (transaction) => {
    const store = transaction.objectStore(STORES.projects)
    const existing = (await requestResult(store.get(document.id))) as ProjectRecord | undefined
    const storedRevision = (existing?.document as { revision?: number } | undefined)?.revision ?? 0
    if (existing && storedRevision !== baseRevision) throw new ProjectConflictError(existing.document)
    const record: ProjectRecord = {
      id: saved.id,
      name: saved.name,
      updatedAt: saved.updatedAt,
      slideCount: saved.slides.length,
      thumbnail: thumbnail ?? existing?.thumbnail ?? null,
      document: saved,
    }
    await requestResult(store.put(record))
  })
  announce({ type: 'saved', projectId: saved.id, revision: saved.revision, tabId: TAB_ID })
  await setMeta('lastProjectId', saved.id)
  return saved
}

/** Overwrite whatever is stored, after the user chose to keep this tab's copy. */
export async function forceSaveProject(document: StoreDocument, thumbnail: string | null): Promise<StoreDocument> {
  const record = await getRecord<ProjectRecord>(STORES.projects, document.id)
  const storedRevision = (record?.document as { revision?: number } | undefined)?.revision ?? 0
  return saveProject(document, storedRevision, thumbnail)
}

/** Copy a project under a new id and name. Images are shared, not copied. */
export async function duplicateProject(id: string, name: string): Promise<StoreDocument | null> {
  const loaded = await loadProject(id)
  if (!loaded) return null
  const now = Date.now()
  const copy: StoreDocument = { ...loaded.document, id: newId(), name, createdAt: now, updatedAt: now, revision: 0 }
  const record = await getRecord<ProjectRecord>(STORES.projects, id)
  return saveProject(copy, 0, record?.thumbnail ?? null)
}

/** Rename without loading the editor. */
export async function renameProject(id: string, name: string): Promise<void> {
  const record = await getRecord<ProjectRecord>(STORES.projects, id)
  if (!record) return
  const loaded = readStoreDocument(record.document)
  await saveProject({ ...loaded.document, name, updatedAt: Date.now() }, loaded.document.revision, record.thumbnail)
}

/** Delete a project, its versions, and images nothing else uses. */
export async function deleteProject(id: string): Promise<void> {
  await transact([STORES.projects, STORES.versions], 'readwrite', async (transaction) => {
    await requestResult(transaction.objectStore(STORES.projects).delete(id))
    const versions = transaction.objectStore(STORES.versions)
    const keys = await requestResult(versions.index('byProject').getAllKeys(id))
    for (const key of keys) await requestResult(versions.delete(key))
  })
  if ((await getMeta<string>('lastProjectId')) === id) await setMeta('lastProjectId', null)
  await collectUnusedAssets(new Set())
}

/** Save a named version of the current document. */
export async function createVersion(document: StoreDocument, name: string, thumbnail: string | null): Promise<VersionRecord> {
  const version: VersionRecord = {
    id: newId(),
    projectId: document.id,
    name: name.trim().slice(0, 80) || 'Untitled version',
    createdAt: Date.now(),
    slideCount: document.slides.length,
    thumbnail,
    document,
  }
  await putRecord(STORES.versions, version)
  return version
}

/** Versions of a project, newest first. */
export async function listVersions(projectId: string): Promise<Array<Omit<VersionRecord, 'document'>>> {
  const versions = await transact([STORES.versions], 'readonly', (transaction) =>
    requestResult(transaction.objectStore(STORES.versions).index('byProject').getAll(projectId) as IDBRequest<VersionRecord[]>)
  )
  return versions.map(({ document: _document, ...summary }) => summary).sort((a, b) => b.createdAt - a.createdAt)
}

/** Load a version's document, upgraded to the current schema. */
export async function loadVersion(id: string): Promise<MigrationResult | null> {
  const version = await getRecord<VersionRecord>(STORES.versions, id)
  return version ? readStoreDocument(version.document) : null
}

/** Delete a named version. */
export async function deleteVersion(id: string): Promise<void> {
  await deleteRecord(STORES.versions, id)
  await collectUnusedAssets(new Set())
}

/** Store image bytes under an asset id. Existing ids are left as they are. */
export async function putAsset(id: string, blob: Blob): Promise<void> {
  await transact([STORES.assets], 'readwrite', async (transaction) => {
    const store = transaction.objectStore(STORES.assets)
    const existing = await requestResult(store.getKey(id))
    if (existing !== undefined) return
    const record: AssetRecord = { id, blob, mime: blob.type, bytes: blob.size, createdAt: Date.now() }
    await requestResult(store.put(record))
  })
}

/** Image bytes for an asset id. */
export async function getAssetBlob(id: string): Promise<Blob | null> {
  const record = await getRecord<AssetRecord>(STORES.assets, id)
  return record?.blob ?? null
}

function referencedAssets(document: unknown, into: Set<string>): void {
  const assets = (document as { assets?: Record<string, unknown> } | null)?.assets
  if (assets) Object.keys(assets).forEach((id) => into.add(id))
}

/**
 * Delete stored images that no project, version, brand kit, or template
 * references. `keep` protects images of the open, not-yet-saved document.
 * Images younger than a day are kept so an unsaved import is never lost.
 */
export async function collectUnusedAssets(keep: Set<string>): Promise<number> {
  const used = new Set(keep)
  for (const record of await getAllRecords<ProjectRecord>(STORES.projects)) referencedAssets(record.document, used)
  for (const record of await getAllRecords<VersionRecord>(STORES.versions)) referencedAssets(record.document, used)
  for (const record of await getAllRecords<{ assetIds?: string[] }>(STORES.brandKits)) record.assetIds?.forEach((id) => used.add(id))
  for (const record of await getAllRecords<{ assetIds?: string[] }>(STORES.templates)) record.assetIds?.forEach((id) => used.add(id))
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  return transact([STORES.assets], 'readwrite', async (transaction) => {
    const store = transaction.objectStore(STORES.assets)
    const records = (await requestResult(store.getAll())) as AssetRecord[]
    let removed = 0
    for (const record of records) {
      if (used.has(record.id) || record.createdAt > cutoff) continue
      await requestResult(store.delete(record.id))
      removed += 1
    }
    return removed
  })
}

/** Read a small settings value. */
export async function getMeta<T>(key: string): Promise<T | null> {
  return (await getRecord<T>(STORES.meta, key)) ?? null
}

/** Write a small settings value. */
export async function setMeta(key: string, value: unknown): Promise<void> {
  await putRecord(STORES.meta, value, key)
}
