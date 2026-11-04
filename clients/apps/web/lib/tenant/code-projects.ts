import 'server-only'

import type { BackendCreativeSet } from 'screenshot-studio-backend-sdk'
import type { TenantContext } from '@/lib/auth/access'
import { backendSDK, orNull, withDates } from '@/lib/backend/sdk'
import { resolveCodeTheme } from '@/lib/code-studio/brand-theme'
import {
  codeDocumentSchema,
  codeStyleSchema,
  newCodeFile,
  newCodeSlide,
  readCodeDocument,
  type CodeStyle,
} from '@/lib/code-studio/document'
import { languageForFileName, type CodeLanguageId } from '@/lib/code-studio/languages'
import type { CodeProjectListInput } from '@/lib/code-studio/schema'
import { newCreativeSetId } from '@/lib/creative-sets/document'

/**
 * Code Studio projects (RFC 053). The backend stores them as creative sets of
 * kind `code`: it scopes every query to the workspace, checks roles, bounds
 * the document, refuses stale revisions with a 409 (tRPC `CONFLICT`) and keeps
 * a row's kind fixed. This layer validates documents in both directions and
 * never returns a canvas or Story Set as a code project.
 */

function readProject(record: BackendCreativeSet) {
  return { ...withDates(record), document: codeDocumentSchema.parse(record.document) }
}

/** The code project row, or null when the id is not a code project of this workspace. */
async function projectRow(context: TenantContext, projectId: string) {
  const record = await orNull(backendSDK(context).getCreativeSet(projectId))
  return record?.kind === 'code' ? record : null
}

/** One page of the workspace's code projects. One a newer app wrote lists without a preview. */
export async function listCodeProjects(context: TenantContext, query: CodeProjectListInput) {
  const page = await backendSDK(context).listCreativeSets({ ...query, kind: 'code' })
  return {
    items: page.items.map((record) => ({
      ...withDates(record),
      document: readCodeDocument(record.document),
    })),
    nextCursor: page.nextCursor,
  }
}

/** Create a code project. A retry with the same id and document returns the same row. */
export async function createCodeProject(
  context: TenantContext,
  input: { id: string; document: unknown; name: string }
) {
  const document = codeDocumentSchema.parse(input.document)
  return readProject(
    await backendSDK(context).createCreativeSet({ id: input.id, document, name: input.name })
  )
}

/** A code project of this workspace, or null. */
export async function getCodeProject(context: TenantContext, projectId: string) {
  const record = await projectRow(context, projectId)
  return record ? readProject(record) : null
}

/** Rename a code project; null when it is not one of this workspace. */
export async function renameCodeProject(context: TenantContext, projectId: string, name: string) {
  if (!(await projectRow(context, projectId))) return null
  const record = await orNull(backendSDK(context).renameCreativeSet(projectId, name))
  return record ? readProject(record) : null
}

/** Write a document based on `baseRevision`; a stale write fails with a 409. */
export async function updateCodeProjectDocument(
  context: TenantContext,
  projectId: string,
  input: { baseRevision: number; document: unknown }
) {
  const document = codeDocumentSchema.parse(input.document)
  return withDates(
    await backendSDK(context).updateCreativeSetDocument(projectId, {
      baseRevision: input.baseRevision,
      document,
    })
  )
}

/** Copy a code project as a new one. */
export async function duplicateCodeProject(
  context: TenantContext,
  projectId: string,
  name?: string
) {
  if (!(await projectRow(context, projectId))) return null
  const record = await orNull(backendSDK(context).duplicateCreativeSet(projectId, name))
  return record ? readProject(record) : null
}

/** Archive a code project or return it to the library; false when it is not here. */
export async function archiveCodeProject(
  context: TenantContext,
  projectId: string,
  archived = true
) {
  if (!(await projectRow(context, projectId))) return false
  return (await orNull(backendSDK(context).archiveCreativeSet(projectId, archived))) !== null
}

/**
 * Read the code a GitHub link points to (RFC 053). This is the only path that
 * reads source code, and only because a member pasted the link; nothing is
 * stored until they save a project.
 */
export async function importCode(context: TenantContext, url: string) {
  return backendSDK(context).importCode(url)
}

/** Where a member opens a code project in Code Studio. */
function studioUrl(projectId: string) {
  const origin = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
  return new URL(`/create/code/${projectId}`, origin).toString()
}

/** A code project for the public API, with its Code Studio link; null when it is not here. */
export async function codeProjectForApi(context: TenantContext, projectId: string) {
  const project = await getCodeProject(context, projectId)
  return project ? { ...project, url: studioUrl(project.id) } : null
}

/**
 * Create a code project from plain code, for the API, CLI and editor
 * extensions: one slide with each file as a tab.
 */
export async function createCodeProjectFromCode(
  context: TenantContext,
  input: {
    files: { code: string; lang?: CodeLanguageId; name?: string }[]
    name?: string
    theme?: string
    aspect?: CodeStyle['aspect']
    dark?: boolean
    title?: string
  }
) {
  const files = input.files.map((file) =>
    newCodeFile({
      code: file.code,
      lang: file.lang ?? (file.name ? languageForFileName(file.name) : null) ?? 'text',
      name: file.name ?? '',
    })
  )
  const style = codeStyleSchema.parse({
    ...(input.theme && resolveCodeTheme({ theme: input.theme, brandTheme: null }).id === input.theme
      ? { theme: input.theme }
      : {}),
    ...(input.aspect ? { aspect: input.aspect } : {}),
    ...(input.dark !== undefined ? { dark: input.dark } : {}),
    ...(input.title ? { title: input.title } : {}),
  })
  const document = codeDocumentSchema.parse({
    version: 1,
    kind: 'code',
    style,
    slides: [newCodeSlide(files)],
  })
  const project = await createCodeProject(context, {
    id: newCreativeSetId(),
    document,
    name: input.name ?? (files[0]!.name || 'Untitled code'),
  })
  return { ...project, url: studioUrl(project.id) }
}
