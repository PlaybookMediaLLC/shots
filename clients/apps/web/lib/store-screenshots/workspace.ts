'use client'

import { TRPCClientError, type TRPCClient } from '@trpc/client'
import { z } from 'zod'
import type { AppRouter } from '@/lib/trpc/router'
import { loadStoreAsset, uploadStoreGroupAssets } from '@/lib/creative-sets/store-assets'
import type { StoreGroup } from '@/lib/creative-sets/store-schema'
import { resolvedDocumentHash } from '@/lib/design/document-hash'
import type { StoreDocument } from '@/lib/store-screenshots/document/schema'
import { getAssetBlob, getMeta, putAsset, setMeta } from '@/lib/store-screenshots/persistence/projects'

/**
 * A store project saved to the workspace. This browser keeps the project and
 * its images in IndexedDB; the workspace keeps a copy every device can open.
 * The link records the workspace revision this browser last wrote or read, so
 * a newer save from another device is found instead of overwritten.
 */

const linkSchema = z.object({
  revision: z.number().int().min(1),
  /** The local document that revision holds, to tell unsaved local edits apart. */
  hash: z.string(),
  assetMap: z.record(z.string(), z.string()),
})
/** Where this browser's copy stands against the workspace copy. */
export type WorkspaceLink = z.infer<typeof linkSchema>

const linkKey = (organizationId: string, projectId: string) =>
  `workspace:${organizationId}:${projectId}`

/** The link for a project in this workspace, or null when it was never saved there from this browser. */
export async function readWorkspaceLink(
  organizationId: string,
  projectId: string
): Promise<WorkspaceLink | null> {
  const parsed = linkSchema.safeParse(await getMeta(linkKey(organizationId, projectId)))
  return parsed.success ? parsed.data : null
}

/** Record the link, or forget it with null. */
export function writeWorkspaceLink(
  organizationId: string,
  projectId: string,
  link: WorkspaceLink | null
): Promise<void> {
  return setMeta(linkKey(organizationId, projectId), link)
}

/** The document's content, ignoring the local save counter. */
export function documentHash(document: StoreDocument): Promise<string> {
  return resolvedDocumentHash({ ...document, revision: 0 })
}

/** The project as a store group, reusing the uploads of its last workspace save. */
function storeProjectGroup(document: StoreDocument, assetMap: Record<string, string>): StoreGroup {
  return {
    id: document.id,
    kind: 'store',
    name: document.name,
    document: structuredClone(document),
    assetMap: Object.fromEntries(Object.entries(assetMap).filter(([id]) => id in document.assets)),
    bindings: [],
    review: { source: false, wording: false },
  }
}

/** Upload new images and write the project: the first save creates it, later ones build on `link`. */
export async function pushStoreProject(
  client: TRPCClient<AppRouter>,
  document: StoreDocument,
  link: WorkspaceLink | null,
  uploads: Map<string, string>
): Promise<WorkspaceLink> {
  const group = await uploadStoreGroupAssets(
    client,
    storeProjectGroup(document, link?.assetMap ?? {}),
    uploads
  )
  const { revision } = link
    ? await client.storeProject.updateDocument.mutate({
        projectId: document.id,
        baseRevision: link.revision,
        document: group,
      })
    : await client.storeProject.create.mutate({ projectId: document.id, document: group })
  return { revision, hash: await documentHash(document), assetMap: group.assetMap }
}

/** Read the workspace copy and put its images on this browser; the caller stores the document. */
export async function pullStoreProject(
  client: TRPCClient<AppRouter>,
  projectId: string
): Promise<{ document: StoreDocument; link: WorkspaceLink }> {
  const remote = await client.storeProject.get.query({ projectId })
  const group = remote.document
  for (const [id, asset] of Object.entries(group.document.assets)) {
    if (await getAssetBlob(id)) continue
    const blob = await loadStoreAsset(client, group, id)
    if (!blob) throw new Error(`The workspace copy is missing ${asset.name}.`)
    await putAsset(id, blob)
  }
  return {
    document: group.document,
    link: {
      revision: remote.revision,
      hash: await documentHash(group.document),
      assetMap: group.assetMap,
    },
  }
}

/** Delete the workspace copy and forget this browser's link to it. One already gone counts as deleted. */
export async function deleteWorkspaceCopy(
  client: TRPCClient<AppRouter>,
  organizationId: string,
  projectId: string
): Promise<void> {
  try {
    await client.storeProject.delete.mutate({ projectId })
  } catch (cause) {
    if (!(cause instanceof TRPCClientError && cause.data?.code === 'NOT_FOUND')) throw cause
  }
  await writeWorkspaceLink(organizationId, projectId, null)
}
