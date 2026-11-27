import 'server-only'

import type { BackendProject } from 'screenshot-studio-backend-sdk'
import type { TenantContext } from '@/lib/auth/access'
import { backendSDK, orNull, withDates } from '@/lib/backend/sdk'
import {
  type DesignDocument,
  getLocalDesignSources,
  parseDesignDocument,
} from '@/lib/design/document'
import type { ProjectListInput } from '@/lib/projects/schema'
import { DesignError } from './designs'

/**
 * Cloud projects for a workspace. The backend scopes every query to the
 * workspace, checks roles and asset ownership, and refuses a document write
 * based on an older revision with a 409 (tRPC `CONFLICT`); this layer
 * validates documents in both directions.
 */

/** A document ready to store: valid, and every image uploaded to the workspace. */
function storableDocument(raw: unknown): DesignDocument {
  const document = parseDesignDocument(raw)
  if (getLocalDesignSources(document).length > 0) {
    throw new DesignError('Upload local images before saving the project.', 400)
  }
  return document
}

/** A stored project with its document read through the current schema. */
function readProject(project: BackendProject) {
  return { ...withDates(project), document: parseDesignDocument(project.document) }
}

/** A document this version cannot read (from a newer editor) lists without a preview. */
function listedDocument(raw: unknown): DesignDocument | null {
  try {
    return parseDesignDocument(raw)
  } catch {
    return null
  }
}

/** One page of the workspace's projects, optionally filtered by name. */
export async function listProjects(context: TenantContext, query: ProjectListInput) {
  const page = await backendSDK(context).listProjects(query)
  return {
    items: page.items.map((project) => ({
      ...withDates(project),
      document: listedDocument(project.document),
    })),
    nextCursor: page.nextCursor,
  }
}

/** Lightweight metadata for the workspace's newest projects and canvases (omits document payloads). */
export async function listRecentWork(context: TenantContext, limit?: number) {
  const page = await backendSDK(context).listRecentWork(limit)
  return {
    items: page.items.map((item) => ({
      ...item,
      updatedAt: new Date(item.updatedAt),
    })),
  }
}

/** Create a project from a stored-form document (no local images). */
export async function createProject(
  context: TenantContext,
  input: { document: unknown; name: string }
) {
  const document = storableDocument(input.document)
  return readProject(await backendSDK(context).createProject({ document, name: input.name }))
}

/** A project of this workspace, or null. */
export async function getProject(context: TenantContext, projectId: string) {
  const project = await orNull(backendSDK(context).getProject(projectId))
  return project ? readProject(project) : null
}

/** Rename a project; null when it is not in this workspace. */
export async function renameProject(context: TenantContext, projectId: string, name: string) {
  const project = await orNull(backendSDK(context).renameProject(projectId, name))
  return project ? readProject(project) : null
}

/** Write a document based on `baseRevision`; a stale write fails with a 409. */
export async function updateProjectDocument(
  context: TenantContext,
  projectId: string,
  input: { baseRevision: number; document: unknown }
) {
  const document = storableDocument(input.document)
  return withDates(
    await backendSDK(context).updateProjectDocument(projectId, {
      baseRevision: input.baseRevision,
      document,
    })
  )
}

/** Copy a project, with its current document, as a new project. */
export async function duplicateProject(context: TenantContext, projectId: string, name?: string) {
  const project = await orNull(backendSDK(context).duplicateProject(projectId, name))
  return project ? readProject(project) : null
}

/** Delete a project and its history; false when it is not in this workspace. */
export async function deleteProject(context: TenantContext, projectId: string) {
  return (await orNull(backendSDK(context).deleteProject(projectId))) !== null
}

/** A project's versions, newest first, without documents; null when it is not here. */
export async function listProjectVersions(context: TenantContext, projectId: string) {
  const result = await orNull(backendSDK(context).listProjectVersions(projectId))
  return result?.versions.map(({ document: _document, ...version }) => withDates(version)) ?? null
}

/** One version with its document, or null. */
export async function getProjectVersion(
  context: TenantContext,
  projectId: string,
  versionId: string
) {
  const version = await orNull(backendSDK(context).getProjectVersion(projectId, versionId))
  return version ? { ...withDates(version), document: parseDesignDocument(version.document) } : null
}

/** Name the project's current document as a version; null when it is not here. */
export async function createProjectVersion(
  context: TenantContext,
  projectId: string,
  name: string
) {
  const version = await orNull(backendSDK(context).createProjectVersion(projectId, name))
  return version ? withDates(version) : null
}

/** Make a version the project's document, based on `baseRevision`; stale fails with a 409. */
export async function restoreProjectVersion(
  context: TenantContext,
  projectId: string,
  versionId: string,
  baseRevision: number
) {
  const project = await orNull(
    backendSDK(context).restoreProjectVersion(projectId, versionId, baseRevision)
  )
  return project ? readProject(project) : null
}
