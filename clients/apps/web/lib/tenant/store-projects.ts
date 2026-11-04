import 'server-only'

import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { TenantContext } from '@/lib/auth/access'
import { backendSDK, orNull, withDates } from '@/lib/backend/sdk'
import {
  storeGroupSchema,
  storeGroupStored,
  type StoreGroup,
} from '@/lib/creative-sets/store-schema'
import { idSchema } from '@/lib/store-screenshots/document/schema'
import type {
  StoreProjectCreateInput,
  StoreProjectDocumentInput,
  StoreProjectListInput,
} from '@/lib/store-screenshots/workspace-schema'
import { DesignError } from './designs'

/**
 * Store screenshot projects saved to the workspace. The backend stores each as
 * a creative set of kind `store` holding one store group: it scopes every
 * query to the workspace, checks roles and image ownership, refuses stale
 * revisions with a 409 (tRPC `CONFLICT`) and keeps a row's kind fixed. This
 * layer names rows by local project id and never returns another kind.
 */

/** The row a local project is saved to in this workspace; every device derives the same one. */
function rowId(context: TenantContext, projectId: string) {
  const hash = createHash('sha256').update(`${context.organizationId}:${projectId}`).digest('hex')
  return `c${hash.slice(0, 24)}`
}

/** A group ready to store: it is this project, and every image is in workspace storage. */
function storableGroup(projectId: string, group: StoreGroup): StoreGroup {
  if (group.id !== projectId || group.document.id !== projectId)
    throw new DesignError('The saved project does not match its id.', 400)
  if (!storeGroupStored(group))
    throw new DesignError('Copy every store image to workspace storage before saving.', 400)
  return group
}

const summarySchema = z.object({
  name: z.string(),
  document: z.object({ id: idSchema, slides: z.array(z.unknown()) }),
})

/** One page of the workspace's store projects, newest first, without their documents. */
export async function listStoreProjects(context: TenantContext, query: StoreProjectListInput) {
  const page = await backendSDK(context).listCreativeSets({ ...query, kind: 'store' })
  return {
    items: page.items.map((record) => {
      const summary = summarySchema.parse(record.document)
      return {
        projectId: summary.document.id,
        name: summary.name,
        slideCount: summary.document.slides.length,
        revision: record.revision,
        updatedAt: new Date(record.updatedAt),
      }
    }),
    nextCursor: page.nextCursor,
  }
}

/** A saved store project of this workspace, or null. */
export async function getStoreProject(context: TenantContext, projectId: string) {
  const record = await orNull(backendSDK(context).getCreativeSet(rowId(context, projectId)))
  if (record?.kind !== 'store') return null
  return {
    revision: record.revision,
    updatedAt: new Date(record.updatedAt),
    document: storeGroupSchema.parse(record.document),
  }
}

/** Save a local project to the workspace; a retried request returns the first save. */
export async function createStoreProject(context: TenantContext, input: StoreProjectCreateInput) {
  const document = storableGroup(input.projectId, input.document)
  const record = await backendSDK(context).createCreativeSet({
    id: rowId(context, input.projectId),
    document,
    name: document.name,
  })
  return { revision: record.revision }
}

/** Write a project's group based on `baseRevision`; a stale write fails with a 409. */
export async function updateStoreProjectDocument(
  context: TenantContext,
  input: StoreProjectDocumentInput
) {
  const document = storableGroup(input.projectId, input.document)
  return withDates(
    await backendSDK(context).updateCreativeSetDocument(rowId(context, input.projectId), {
      baseRevision: input.baseRevision,
      document,
    })
  )
}
