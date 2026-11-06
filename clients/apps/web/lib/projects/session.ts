'use client'

import { type TRPCClient, TRPCClientError } from '@trpc/client'
import { z } from 'zod'
import { create } from 'zustand'
import {
  DESIGN_DOCUMENT_VERSION,
  type DesignDocument,
  parseDesignDocument,
} from '@/lib/design/document'
import { documentFromState } from '@/lib/design/export'
import { applyStoredDocument } from '@/lib/design/open-design'
import {
  rememberUploadedSources,
  uploadDesignSources,
  withUploadedSources,
} from '@/lib/design/upload-sources'
import { hashString } from '@/lib/render/preview-cache'
import { type ImageState, useImageStore } from '@/lib/store'
import type { AppRouter } from '@/lib/trpc/router'
import { WorkspaceSaveError } from '@/lib/workspace/save-export'
import { draftRestored } from './draft-ready'
import { projectIdSchema, type ProjectSaveStatus } from './schema'

/**
 * The cloud project open in the editor, and its autosave.
 *
 * Edits are saved a moment after they pause. Each write names the revision
 * it was based on; a refusal (someone saved elsewhere) stops autosave and
 * shows `conflict`, so newer work is never overwritten. Local images are
 * uploaded once and referenced by asset id from then on. A dropped
 * connection shows `offline` and retries.
 *
 * Recovery: the editor already keeps its canvas in a local draft
 * (IndexedDB). A small record notes which project that draft belongs to and
 * whether it holds changes the server does not have, so a reload or a
 * crash reopens the project with those changes and saves them.
 */

/** The open project as the editor shows it. */
export type ProjectSession = {
  /** Why saving stopped, for `conflict`, `error`, and `offline`. */
  error: string | null
  name: string
  projectId: string | null
  /** The revision the editor's document is based on. */
  revision: number
  savedAt: Date | null
  status: ProjectSaveStatus
}

/** A project as the router returns it. */
type StoredProject = { id: string; name: string; revision: number; updatedAt: Date }

/** How {@link openProject} found the project. */
export const projectOpenOutcomeSchema = z.enum(['opened', 'recovered', 'conflict'])
/** One of {@link projectOpenOutcomeSchema}. */
export type ProjectOpenOutcome = z.infer<typeof projectOpenOutcomeSchema>

type Client = TRPCClient<AppRouter>

const CLOSED: ProjectSession = {
  error: null,
  name: '',
  projectId: null,
  revision: 0,
  savedAt: null,
  status: 'saved',
}

/** Wait after the last edit before saving. */
const AUTOSAVE_DELAY_MS = 1_500
/** Wait before retrying a save that could not reach the server. */
const RETRY_DELAY_MS = 5_000
/** Statuses with work only this device has; leaving warns first. */
const UNSAVED = new Set<ProjectSaveStatus>(['unsaved', 'saving', 'offline', 'error', 'conflict'])

/** Editor state that is not part of the design: changing it is not an edit. */
const SESSION_KEYS = new Set<keyof ImageState>([
  'activeAnnotationTool',
  'canvasDimensions',
  'isMainImageSelected',
  'isPreviewing',
  'previewIndex',
  'previewStartedAt',
  'rulerInterval',
  'selectedAnnotationId',
  'selectedBlurId',
  'selectedElementId',
  'selectedOverlayId',
  'selectedTextId',
  'showGrid',
  'showRulers',
  'showTemplates',
  'showTimeline',
])

/** The open project, for components. */
export const useProjectSession = create<ProjectSession>(() => CLOSED)

let client: Client | null = null
/** The last document the server holds for the open project, by content. */
let savedKey: string | null = null
/** Edits since the project opened; a save is clean when none landed during it. */
let edits = 0
/** True while the editor is being written from the server, which is not an edit. */
let applying = false
let saveTimer: ReturnType<typeof setTimeout> | undefined
let running: Promise<void> | null = null
let rerun = false
let unsubscribe: (() => void) | null = null
/**
 * This tab unlinked its canvas from any project. The recovery record is
 * shared by every tab, so another tab's clean record then says nothing about
 * what is on this canvas.
 */
let unlinkedHere = false
/** This tab's canvas was deliberately taken out of its project, and stays out until a new start. */
let unlinkedByClosing = false
const AUTOSAVED_NAME = 'Untitled screenshot'

// The draft owner record. The editor has one local draft, so one record.
const OWNER_KEY = 'shots.project-draft'
const ownerSchema = z.object({
  baseRevision: z.number().int().min(1),
  dirty: z.boolean(),
  projectId: projectIdSchema,
})
type DraftOwner = z.infer<typeof ownerSchema>

function readOwner(): DraftOwner | null {
  try {
    return ownerSchema.parse(JSON.parse(localStorage.getItem(OWNER_KEY) ?? 'null'))
  } catch {
    return null
  }
}

function writeOwner(owner: DraftOwner | null): void {
  try {
    if (owner) localStorage.setItem(OWNER_KEY, JSON.stringify(owner))
    else localStorage.removeItem(OWNER_KEY)
  } catch {
    // Storage is unavailable (private mode, quota): recovery is best effort.
  }
}

/** Keep `?project=` in the address bar, so a reload reopens the project. */
function setProjectParam(projectId: string | null): void {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  if (projectId) url.searchParams.set('project', projectId)
  else url.searchParams.delete('project')
  window.history.replaceState(window.history.state, '', url)
}

function documentKey(document: DesignDocument): string {
  return hashString(JSON.stringify(document))
}

/**
 * The editor's design with images it already uploaded referenced by asset id,
 * for comparing with a stored version. Nothing is uploaded.
 */
export function currentProjectDocument(): DesignDocument {
  return withUploadedSources(projectDocument(useImageStore.getState()))
}

/** Slide selection belongs to the viewing session, so saved designs start at slide one. */
function projectDocument(state: ImageState): DesignDocument {
  const first = state.slides[0]
  return documentFromState(first ? {
    ...state,
    activeSlideId: first.id,
    uploadedImageUrl: first.src,
    imageName: first.name,
    mockups: state.mockups.map((mockup) => !mockup.screen.isCustom && !mockup.screen.code
      ? { ...mockup, screen: { ...mockup.screen, src: first.src, name: first.name } } : mockup),
  } : state, { keepLocalSources: true })
}

function editorDocument(trpcClient: Client) {
  return uploadDesignSources(trpcClient, projectDocument(useImageStore.getState()))
}

function scheduleSave(): void {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void saveProjectNow(), AUTOSAVE_DELAY_MS)
}

function isEdit(state: ImageState, previous: ImageState): boolean {
  for (const key of Object.keys(state) as Array<keyof ImageState>) {
    if (state[key] !== previous[key] && !SESSION_KEYS.has(key)) {
      return documentKey(projectDocument(state)) !== documentKey(projectDocument(previous))
    }
  }
  return false
}

function onEditorChange(state: ImageState, previous: ImageState): void {
  const session = useProjectSession.getState()
  if (applying || !session.projectId || !isEdit(state, previous)) return
  edits++
  if (session.status === 'conflict' || session.status === 'loading') return
  if (session.status === 'saved') {
    useProjectSession.setState({ status: 'unsaved' })
    writeOwner({ baseRevision: session.revision, dirty: true, projectId: session.projectId })
  }
  scheduleSave()
}

function onOnline(): void {
  if (useProjectSession.getState().status === 'offline') void saveProjectNow()
}

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (UNSAVED.has(useProjectSession.getState().status)) event.preventDefault()
}

function listen(): void {
  if (unsubscribe) return
  const stopEditor = useImageStore.subscribe(onEditorChange)
  if (typeof window === 'undefined') {
    unsubscribe = stopEditor
    return
  }
  window.addEventListener('online', onOnline)
  window.addEventListener('beforeunload', onBeforeUnload)
  unsubscribe = () => {
    stopEditor()
    window.removeEventListener('online', onOnline)
    window.removeEventListener('beforeunload', onBeforeUnload)
  }
}

/** Make `project` the open project; `key` is the document the server holds. */
function adopt(trpcClient: Client, project: StoredProject, key: string | null): void {
  client = trpcClient
  savedKey = key
  unlinkedHere = false
  useProjectSession.setState({
    error: null,
    name: project.name,
    projectId: project.id,
    revision: project.revision,
    savedAt: project.updatedAt,
    status: 'saved',
  })
  writeOwner({ baseRevision: project.revision, dirty: false, projectId: project.id })
  setProjectParam(project.id)
  listen()
}

/** Write a stored document into the editor and remember what the server holds. */
async function load(trpcClient: Client, document: DesignDocument, history: 'clear' | 'step') {
  applying = true
  try {
    const sources = await applyStoredDocument(trpcClient, document, history, { replace: true })
    rememberUploadedSources(sources)
    // The editor's own reading of what it loaded, so only real edits save.
    return documentKey(await editorDocument(trpcClient))
  } finally {
    applying = false
  }
}

function failSave(error: unknown): void {
  if (error instanceof TRPCClientError && error.data?.code === 'CONFLICT') {
    useProjectSession.setState({ error: error.message, status: 'conflict' })
    return
  }
  const answered = error instanceof TRPCClientError && Boolean(error.data)
  const refused = error instanceof WorkspaceSaveError && error.code !== 'upload-failed'
  if (answered || refused) {
    const message = error instanceof Error ? error.message : 'The project could not be saved.'
    useProjectSession.setState({ error: message, status: 'error' })
    return
  }
  useProjectSession.setState({
    error: 'No connection. Changes are kept on this device and saved when it is back.',
    status: 'offline',
  })
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void saveProjectNow(), RETRY_DELAY_MS)
}

async function saveOnce(): Promise<void> {
  const session = useProjectSession.getState()
  const trpcClient = client
  if (!trpcClient || !session.projectId) return
  if (session.status === 'conflict' || session.status === 'loading') return
  const { projectId, revision } = session
  const editsAtStart = edits
  try {
    const document = await editorDocument(trpcClient)
    if (useProjectSession.getState().projectId !== projectId) return
    const key = documentKey(document)
    let saved = { revision, savedAt: session.savedAt }
    if (key !== savedKey) {
      useProjectSession.setState({ status: 'saving' })
      const result = await trpcClient.project.updateDocument.mutate({
        baseRevision: revision,
        document,
        projectId,
      })
      if (useProjectSession.getState().projectId !== projectId) return
      savedKey = key
      saved = { revision: result.revision, savedAt: result.updatedAt }
    }
    const clean = edits === editsAtStart
    useProjectSession.setState({ ...saved, error: null, status: clean ? 'saved' : 'unsaved' })
    writeOwner({ baseRevision: saved.revision, dirty: !clean, projectId })
  } catch (error) {
    if (useProjectSession.getState().projectId === projectId) failSave(error)
  }
}

/**
 * Save the open project now instead of after the autosave delay. Resolves
 * once the editor's current document is saved or saving has stopped; read
 * `status` for which.
 */
export function saveProjectNow(): Promise<void> {
  clearTimeout(saveTimer)
  if (running) {
    rerun = true
    return running
  }
  running = (async () => {
    do {
      rerun = false
      await saveOnce()
    } while (rerun)
  })().finally(() => {
    running = null
  })
  return running
}

/** Save, then require that the server holds exactly what the editor shows. */
async function saved(): Promise<{ projectId: string; revision: number; trpcClient: Client }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await saveProjectNow()
    if (useProjectSession.getState().status !== 'unsaved') break
  }
  const { error, projectId, revision, status } = useProjectSession.getState()
  if (!client || !projectId) throw new Error('No project is open.')
  if (status !== 'saved') throw new Error(error ?? 'Wait for the project to finish saving.')
  return { projectId, revision, trpcClient: client }
}

/** Stop autosave, leaving the address bar and the recovery record as they are. */
function stopSession(): void {
  unsubscribe?.()
  unsubscribe = null
  clearTimeout(saveTimer)
  savedKey = null
  edits = 0
  useProjectSession.setState(CLOSED)
}

/** Stop autosave and unlink the editor from the project; the canvas stays as it is. */
export function closeProject(): void {
  stopSession()
  writeOwner(null)
  setProjectParam(null)
  unlinkedHere = true
  unlinkedByClosing = true
}

/**
 * Open a project in the editor. When this device's draft holds the
 * project's unsaved changes they are kept and saved (`recovered`), unless
 * the project moved on meanwhile (`conflict`).
 */
export async function openProject(
  trpcClient: Client,
  projectId: string
): Promise<ProjectOpenOutcome> {
  await draftRestored()
  // A save still in flight (from leaving the editor) must land before the
  // owner record is read, or this device's own write would look like a conflict.
  await running
  const owner = readOwner()
  stopSession()
  client = trpcClient
  useProjectSession.setState({ ...CLOSED, projectId, status: 'loading' })
  try {
    const project = await trpcClient.project.get.query({ projectId })
    const recovering = owner?.projectId === projectId && owner.dirty &&
      documentKey(currentProjectDocument()) !== documentKey(project.document)
    if (recovering && owner.baseRevision === project.revision) {
      adopt(trpcClient, project, null)
      useProjectSession.setState({ status: 'unsaved' })
      writeOwner({ ...owner, dirty: true })
      void saveProjectNow()
      return 'recovered'
    }
    if (recovering) {
      adopt(trpcClient, project, null)
      useProjectSession.setState({
        error: 'This device has unsaved changes, but the project was saved elsewhere since.',
        status: 'conflict',
      })
      writeOwner({ ...owner, dirty: true })
      return 'conflict'
    }
    const key = await load(trpcClient, project.document, 'clear')
    adopt(trpcClient, project, key)
    return 'opened'
  } catch (error) {
    stopSession()
    // A reload retries and recovers, unless the project is gone.
    if (error instanceof TRPCClientError && error.data?.code === 'NOT_FOUND') {
      if (owner?.projectId === projectId) writeOwner(null)
      setProjectParam(null)
    }
    throw error
  }
}

/** Save the editor's design as a new project and open it. */
export async function createProjectFromEditor(trpcClient: Client, name: string) {
  const document = await editorDocument(trpcClient)
  const project = await trpcClient.project.create.mutate({ document, name })
  edits = 0
  adopt(trpcClient, project, documentKey(document))
  return project
}

/**
 * Save a design with real content as a project of its own, so it survives this
 * browser. A person who closed a project meant to leave its copy unlinked, and
 * a design already saving or opening is left to that.
 */
export async function autosaveDesignAsProject(trpcClient: Client): Promise<void> {
  await draftRestored()
  await running
  const { projectId, status } = useProjectSession.getState()
  if (projectId || status === 'loading' || unlinkedByClosing) return
  if (!hasDesignContent(currentProjectDocument())) return
  await createProjectFromEditor(trpcClient, AUTOSAVED_NAME)
}

/** Resolve a conflict by loading the saved project; this device's changes are dropped. */
export async function loadLatestProject(): Promise<void> {
  const { projectId } = useProjectSession.getState()
  if (!client || !projectId) throw new Error('No project is open.')
  const trpcClient = client
  const { error } = useProjectSession.getState()
  useProjectSession.setState({ status: 'loading' })
  try {
    const project = await trpcClient.project.get.query({ projectId })
    adopt(trpcClient, project, await load(trpcClient, project.document, 'clear'))
  } catch (failure) {
    useProjectSession.setState({ error, status: 'conflict' })
    throw failure
  }
}

/** Resolve a conflict by saving this device's design as a new project, then opening it. */
export async function saveConflictCopy() {
  const { name } = useProjectSession.getState()
  if (!client) throw new Error('No project is open.')
  return createProjectFromEditor(client, `${name} (my changes)`.slice(0, 200))
}

/** Rename the open project. */
export async function renameOpenProject(name: string): Promise<void> {
  const { projectId } = useProjectSession.getState()
  if (!client || !projectId) throw new Error('No project is open.')
  const project = await client.project.rename.mutate({ name, projectId })
  useProjectSession.setState({ name: project.name })
}

/** Name the open project's current design as a version. */
export async function saveNamedVersion(name: string) {
  const { projectId, trpcClient } = await saved()
  return trpcClient.project.createVersion.mutate({ name, projectId })
}

/** Copy the open project and continue in the copy. */
export async function duplicateOpenProject() {
  const { projectId, trpcClient } = await saved()
  const copy = await trpcClient.project.duplicate.mutate({ projectId })
  adopt(trpcClient, copy, savedKey)
  return copy
}

/** Make a version the open project's design, as one undoable step in the editor. */
export async function restoreProjectVersion(versionId: string): Promise<void> {
  const { projectId, revision, trpcClient } = await saved()
  const project = await trpcClient.project.restoreVersion.mutate({
    baseRevision: revision,
    projectId,
    versionId,
  })
  useProjectSession.setState({ status: 'loading' })
  try {
    adopt(trpcClient, project, await load(trpcClient, project.document, 'step'))
  } catch (error) {
    // The server restored it; the editor still shows the old design, so the next
    // save conflicts and offers to load the restored one.
    useProjectSession.setState({
      error: 'The version was restored but could not be shown.',
      status: 'error',
    })
    throw error
  }
}

/** Unlink a project the editor has open, after it was deleted elsewhere in this tab. */
export function forgetProject(projectId: string): void {
  if (useProjectSession.getState().projectId === projectId) closeProject()
  else if (readOwner()?.projectId === projectId) writeOwner(null)
}

/** The editor opened without a project: its draft belongs to no project now. */
export function releaseDraft(): void {
  writeOwner(null)
  unlinkedHere = true
}

/** A design with nothing on it yet, as a new screenshot starts. */
const BLANK_DESIGN = parseDesignDocument({ version: DESIGN_DOCUMENT_VERSION, image: { src: null } })

/** Whether a design holds something a person put there, beyond its styling. */
function hasDesignContent(document: DesignDocument): boolean {
  return Boolean(
    document.image.src ||
    document.devices?.mockups.length ||
    document.texts.length ||
    document.overlays.length ||
    document.annotations.length ||
    document.redactions.length ||
    document.elements.length ||
    document.slides?.items.length
  )
}

/**
 * Put a new design in the editor: a clean canvas, or `design` such as a
 * template. An open project is saved and closed first, so its work stays in
 * the workspace (`not-saved` when that fails). A design kept only on this
 * device is replaced only when `discardLocal` says the person chose to
 * (`local-design` asks first).
 */
export async function startNewDesign(
  trpcClient: Client,
  discardLocal = false,
  design: DesignDocument = BLANK_DESIGN
): Promise<'started' | 'local-design' | 'not-saved'> {
  await draftRestored()
  await running
  if (useProjectSession.getState().projectId) {
    await saveProjectNow()
    if (useProjectSession.getState().status !== 'saved') return 'not-saved'
    closeProject()
  } else {
    // A clean recovery record means the canvas is a saved project's copy,
    // unless this tab unlinked its canvas and the record is another tab's.
    const owner = readOwner()
    const saved = !unlinkedHere && owner !== null && !owner.dirty
    if (!discardLocal && !saved && hasDesignContent(currentProjectDocument())) return 'local-design'
    writeOwner(null)
  }
  await applyStoredDocument(trpcClient, design, 'clear', { replace: true })
  unlinkedHere = true
  unlinkedByClosing = false
  return 'started'
}
