import 'server-only'

import type { BackendCreativeSet } from 'screenshot-studio-backend-sdk'
import type { TenantContext } from '@/lib/auth/access'
import { backendSDK, orNull, withDates } from '@/lib/backend/sdk'
import { type CreativeSetDocument, creativeSetDocumentSchema } from '@/lib/creative-sets/document'
import { getLocalDesignSources } from '@/lib/design/document'
import type { CreativeSetListInput } from '@/lib/creative-sets/schema'
import { storeGroupStored } from '@/lib/creative-sets/store-schema'
import { DesignError } from './designs'

/**
 * Cloud creativeSets for a workspace. The backend scopes every query to the
 * workspace, checks roles and asset ownership, and refuses a document write
 * based on an older revision with a 409 (tRPC `CONFLICT`); this layer
 * validates documents in both directions.
 */

/** A document ready to store: valid, and every image uploaded to the workspace. */
function storableDocument(raw: unknown): CreativeSetDocument {
  const document = creativeSetDocumentSchema.parse(raw)
  if (document.outputs.some((output) => getLocalDesignSources(output.document).length > 0)) {
    throw new DesignError('Upload local images before saving the creativeSet.', 400)
  }
  if (!document.storeGroups.every(storeGroupStored))
    throw new DesignError('Copy every store asset to workspace storage before saving.', 400)
  return document
}

/** A stored creativeSet with its document read through the current schema. */
function readCreativeSet(creativeSet: BackendCreativeSet) {
  return {
    ...withDates(creativeSet),
    document: creativeSetDocumentSchema.parse(creativeSet.document),
  }
}

/** A document this version cannot read (from a newer editor) lists without a preview. */
function listedDocument(raw: unknown): CreativeSetDocument | null {
  try {
    return creativeSetDocumentSchema.parse(raw)
  } catch {
    return null
  }
}

/** One page of the workspace's creativeSets, optionally filtered by name. */
export async function listCreativeSets(context: TenantContext, query: CreativeSetListInput) {
  const page = await backendSDK(context).listCreativeSets(query)
  return {
    items: page.items.map((creativeSet) => ({
      ...withDates(creativeSet),
      document: listedDocument(creativeSet.document),
    })),
    nextCursor: page.nextCursor,
  }
}

/** Create a creativeSet from a stored-form document (no local images). */
export async function createCreativeSet(
  context: TenantContext,
  input: { id: string; document: unknown; name: string }
) {
  const document = storableDocument(input.document)
  return readCreativeSet(
    await backendSDK(context).createCreativeSet({ id: input.id, document, name: input.name })
  )
}

/** A Story Set of this workspace, or null. A canvas (RFC 032) or code project (RFC 053) is not a Story Set. */
export async function getCreativeSet(context: TenantContext, creativeSetId: string) {
  const creativeSet = await orNull(backendSDK(context).getCreativeSet(creativeSetId))
  return creativeSet?.kind === 'story-set' ? readCreativeSet(creativeSet) : null
}

/** Rename a creativeSet; null when it is not in this workspace. */
export async function renameCreativeSet(
  context: TenantContext,
  creativeSetId: string,
  name: string
) {
  const creativeSet = await orNull(backendSDK(context).renameCreativeSet(creativeSetId, name))
  return creativeSet ? readCreativeSet(creativeSet) : null
}

/** Write a document based on `baseRevision`; a stale write fails with a 409. */
export async function updateCreativeSetDocument(
  context: TenantContext,
  creativeSetId: string,
  input: { baseRevision: number; document: unknown }
) {
  const document = storableDocument(input.document)
  return withDates(
    await backendSDK(context).updateCreativeSetDocument(creativeSetId, {
      baseRevision: input.baseRevision,
      document,
    })
  )
}

/** Copy a creativeSet, with its current document, as a new creativeSet. */
export async function duplicateCreativeSet(
  context: TenantContext,
  creativeSetId: string,
  name?: string
) {
  const creativeSet = await orNull(backendSDK(context).duplicateCreativeSet(creativeSetId, name))
  return creativeSet ? readCreativeSet(creativeSet) : null
}

/** Archive a Story Set, retaining its history; false when it is not in this workspace. */
export async function archiveCreativeSet(context: TenantContext, creativeSetId: string) {
  return (await orNull(backendSDK(context).archiveCreativeSet(creativeSetId))) !== null
}

/** A creativeSet's versions, newest first, without documents; null when it is not here. */
export async function listCreativeSetVersions(context: TenantContext, creativeSetId: string) {
  const result = await orNull(backendSDK(context).listCreativeSetVersions(creativeSetId))
  return result?.versions.map(({ document: _document, ...version }) => withDates(version)) ?? null
}

/** One version with its document, or null. */
export async function getCreativeSetVersion(
  context: TenantContext,
  creativeSetId: string,
  versionId: string
) {
  const version = await orNull(backendSDK(context).getCreativeSetVersion(creativeSetId, versionId))
  return version
    ? { ...withDates(version), document: creativeSetDocumentSchema.parse(version.document) }
    : null
}

/** Name the creativeSet's current document as a version; null when it is not here. */
export async function createCreativeSetVersion(
  context: TenantContext,
  creativeSetId: string,
  name: string,
  baseRevision?: number
) {
  const version = await orNull(
    backendSDK(context).createCreativeSetVersion(creativeSetId, name, baseRevision)
  )
  return version ? withDates(version) : null
}

/** Make a version the creativeSet's document, based on `baseRevision`; stale fails with a 409. */
export async function restoreCreativeSetVersion(
  context: TenantContext,
  creativeSetId: string,
  versionId: string,
  baseRevision: number
) {
  const creativeSet = await orNull(
    backendSDK(context).restoreCreativeSetVersion(creativeSetId, versionId, baseRevision)
  )
  return creativeSet ? readCreativeSet(creativeSet) : null
}

/** The backend creates an immutable campaign candidate and never rewrites an earlier approval. */
export async function attachCreativeSetDelivery(
  context: TenantContext,
  input: import('zod').z.infer<typeof import('@/lib/creative-sets/schema').creativeSetHandoffSchema>
) {
  const { creativeSetId, ...handoff } = input
  return backendSDK(context).attachCreativeSetDelivery(creativeSetId, handoff)
}

/** A workspace-scoped presence credential for the signed-in set member. */
export async function createCreativeSetCollabToken(context: TenantContext, id: string) {
  return backendSDK(context).createCreativeSetCollabToken(id)
}
