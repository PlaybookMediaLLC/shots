'use client'

import { z } from 'zod'
import { listedStatus } from '@/lib/content-drafts/post-status'
import { draftHref, draftName } from '@/lib/write/library'
import type { DesignDocument } from '@/lib/design/document'
import type { useTRPCClient } from '@/lib/trpc/react'

const draftItem = z.object({
  assetIds: z.array(z.string()).default([]),
  id: z.string(),
  title: z.string(),
  plainText: z.string().catch(''),
  socialSetId: z.string().nullable(),
  updatedAt: z.coerce.date(),
  status: z.string().default('draft'),
  attentionPosts: z.number().default(0),
  checkPosts: z.number().default(0),
  publishedPosts: z.number().default(0),
  queuedPosts: z.number().default(0),
})
/** One page of the content draft list, as search reads it. */
export const draftPage = z.object({ items: z.array(draftItem), pinned: z.array(draftItem) })

/** A draft found by searching. */
export type DraftSearchItem = z.infer<typeof draftItem>

/** A piece of the workspace's work, as Home and search list it. */
export type WorkItem = {
  id: string
  href: string
  title: string
  type: 'Screenshot' | 'Canvas' | 'Post'
  scope: string
  updatedAt: Date
  /** A visual's first design, drawn as its thumbnail. */
  document?: DesignDocument | null
  /** A post's opening text, shown in place of a thumbnail. */
  excerpt?: string
  /** A post's state, in the words the drafts list uses. */
  status?: string
}

/**
 * The workspace's most recently updated work, or the work matching `search`,
 * read from each collection's own tenant-authorized list with a small limit.
 * Screenshots and canvases are a paid feature, so only posts are read without
 * one. A collection that fails leaves `partial` set instead of looking empty.
 */
export async function loadWork(
  client: ReturnType<typeof useTRPCClient>,
  {
    draftsEnabled,
    limit,
    paidPlan,
    search,
    signal,
  }: {
    draftsEnabled: boolean
    limit: number
    paidPlan: boolean
    search?: string
    signal?: AbortSignal
  }
): Promise<{ items: WorkItem[]; partial: boolean }> {
  const visuals = () => [
    client.project.list
      .query({ limit, search, sort: 'updated' }, { signal })
      .then(({ items }): WorkItem[] =>
        items.map((item) => ({
          id: item.id,
          href: `/editor?project=${encodeURIComponent(item.id)}`,
          title: item.name,
          type: 'Screenshot',
          scope: 'Workspace',
          updatedAt: new Date(item.updatedAt),
          document: item.document,
        }))
      ),
    client.canvas.list
      .query({ limit, search, sort: 'updated' }, { signal })
      .then(({ items }): WorkItem[] =>
        items.map((item) => ({
          id: item.id,
          href: `/canvas/${item.id}`,
          title: item.name,
          type: 'Canvas',
          scope: 'Workspace',
          updatedAt: new Date(item.updatedAt),
          document: item.document?.artboards[0]?.document ?? null,
        }))
      ),
  ]
  const posts = async (): Promise<WorkItem[]> => {
    const query = new URLSearchParams({ limit: String(limit), sort: 'updated_desc' })
    if (search) query.set('search', search)
    const response = await fetch(`/api/v1/content-drafts?${query}`, { signal })
    if (!response.ok) throw new Error('Drafts could not load.')
    const page = draftPage.parse(await response.json())
    return [...page.pinned, ...page.items].slice(0, limit).map((item) => ({
      id: item.id,
      href: draftHref(item.id, item.socialSetId),
      // An untitled draft is named by its opening words, so drafts can be told apart.
      title: draftName({
        excerpt: item.plainText,
        media: item.assetIds.length ? 'media' : null,
        title: item.title,
      }),
      type: 'Post',
      scope: 'Profile',
      updatedAt: item.updatedAt,
      excerpt: item.plainText,
      status: listedStatus(item),
    }))
  }
  const results = await Promise.allSettled([
    ...(paidPlan ? visuals() : []),
    draftsEnabled ? posts() : Promise.resolve([]),
  ])
  return {
    partial: results.some((result) => result.status === 'rejected'),
    items: results
      .flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()),
  }
}

/** Home's recent work, shared with search so opening search after Home reads nothing again. */
export function recentWorkQuery(
  client: ReturnType<typeof useTRPCClient>,
  organizationId: string,
  draftsEnabled: boolean,
  paidPlan: boolean
) {
  return {
    queryKey: ['platform', 'recent-work', organizationId, draftsEnabled, paidPlan],
    staleTime: 30_000,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const work = await loadWork(client, { draftsEnabled, limit: 5, paidPlan, signal })
      return { ...work, items: work.items.slice(0, 8) }
    },
  }
}
