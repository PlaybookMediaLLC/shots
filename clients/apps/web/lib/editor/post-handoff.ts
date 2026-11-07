'use client'

import type { TRPCClient } from '@trpc/client'
import { create } from 'zustand'
import { call } from '@/lib/content-drafts/client'
import type { DesignDocument } from '@/lib/design/document'
import { exportDesignDocument } from '@/lib/design/export'
import { renderDocument } from '@/lib/render/scene-renderer'
import type { AppRouter } from '@/lib/trpc/router'
import type { MediaFacts } from '@/lib/write/media-rules'
import { safeAssetFileName, saveExportToWorkspace } from '@/lib/workspace/save-export'

/**
 * The editor's half of turning a design into a post. The dialog that
 * prepares the post (`PrepareScreenshotPost`) is opened from the export
 * controls, the AI Captions and Variants panels, and batch export; this is
 * what they share:
 *
 * - which profile the post is for, so the captions are written in the voice
 *   of the account the dialog then posts from;
 * - the AI versions on offer, so one screenshot can become a draft per
 *   version;
 * - an upload-once, key-once session, so a retry after a failure replays
 *   the drafts already made instead of making them again.
 */

/** An AI version of the design, as the Variants panel previews it. */
export type PostVersion = { document: DesignDocument; title: string }

/** What the editor's publishing surfaces agree on. */
type PostHandoffState = {
  /** The profile chosen in any of them; null until someone chooses. */
  socialSetId: string | null
  /** The versions the Variants panel is showing now. */
  versions: PostVersion[]
  setSocialSetId: (id: string) => void
  setVersions: (versions: PostVersion[]) => void
}

/** Shared by every editor surface that prepares a post. */
export const usePostHandoff = create<PostHandoffState>()((set) => ({
  socialSetId: null,
  setSocialSetId: (socialSetId) => set({ socialSetId }),
  setVersions: (versions) => set({ versions }),
  versions: [],
}))

/**
 * The editor's default still export (`DEFAULT_EXPORT_SETTINGS`): a
 * high-quality JPEG at twice the canvas size, what people would have
 * downloaded and attached by hand, at a size every platform's limit takes.
 */
const OUTPUT = { format: 'jpeg', quality: 'high', scale: 2 } as const

/** What a rendered design is, for checking a platform's rules first. */
export const RENDERED_MEDIA_TYPE = 'image/jpeg'

/** A design rendered by the editor's own stage, without touching the open canvas. */
export async function renderDesign(document: DesignDocument): Promise<Blob> {
  return (await renderDocument(document, OUTPUT)).blob
}

/** The design open in the editor, rendered as the default still export. */
export function renderLiveDesign(): Promise<Blob> {
  return renderDesign(exportDesignDocument({ keepLocalSources: true }))
}

/**
 * A stored file name for an export: the design's own name, made safe for an
 * object key, with the extension its bytes actually have. A name with
 * nothing to keep falls back to a stamped one, as a plain export does.
 */
export function exportFileName(name: string, contentType: string): string {
  const extension = contentType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'
  const stem = safeAssetFileName(name).replace(/\.[^.]+$/, '')
  return `${stem || `shots-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`}.${extension}`
}

/** One design to post: how to make its bytes, and what to call and say about it. */
export type HandoffDesign = {
  /** Stable for the dialog's life: what the upload is remembered by. */
  key: string
  /** What the design is called: a version's title, a screenshot's file name. */
  name: string
  /** Its alt text, set on the asset; only a design the editor described has one. */
  altText?: string
  /** The stored file name. */
  fileName: (contentType: string) => string
  render: () => Promise<Blob>
}

/** A design saved as a workspace asset, with what the media rules read. */
export type StoredDesign = { assetId: string; facts: MediaFacts; mediaType: string }

/** An image's pixel size, read from its bytes; unknown for anything else. */
async function imageSize(blob: Blob): Promise<{ height?: number; width?: number }> {
  if (!blob.type.startsWith('image/') || blob.type === 'image/svg+xml') return {}
  try {
    const bitmap = await createImageBitmap(blob)
    try {
      return { height: bitmap.height, width: bitmap.width }
    } finally {
      bitmap.close()
    }
  } catch {
    return {}
  }
}

/**
 * One preparation's session. Each design is rendered and uploaded once, and
 * each distinct request is built once, with one key. The backend replays a
 * request whose key and content it has seen (`beginDraftCreation`, a batch
 * item's `importKey`), so retrying after a failure or a lost response
 * returns the drafts already made rather than making them twice.
 *
 * Replay needs byte-identical content, and a draft body is not: every build
 * gives its posts new random ids (`postBreak`). So a request is remembered by
 * what the person chose — the design, its asset, the caption, the accounts —
 * and its built input is reused as it is. A changed choice is a new post,
 * with a new key.
 */
export function postHandoff(trpcClient: TRPCClient<AppRouter>, projectId?: string) {
  const stored = new Map<string, Promise<StoredDesign>>()
  const requests = new Map<string, { input: unknown; key: string }>()

  async function save(design: HandoffDesign): Promise<StoredDesign> {
    const blob = await design.render()
    const { assetId } = await saveExportToWorkspace({
      blob,
      classification: 'export',
      fileName: design.fileName(blob.type),
      ...(projectId ? { projectId } : {}),
      trpcClient,
    })
    const alt = design.altText?.trim()
    if (alt && blob.type.startsWith('image/')) {
      await call(`/api/v1/assets/${encodeURIComponent(assetId)}/alt-text`, {
        body: { altText: alt },
        method: 'PUT',
      })
    }
    return {
      assetId,
      facts: { bytes: blob.size, mimeType: blob.type, ...(await imageSize(blob)) },
      mediaType: blob.type,
    }
  }

  return {
    /** The design as an asset, uploading it the first time only. */
    store(design: HandoffDesign): Promise<StoredDesign> {
      let pending = stored.get(design.key)
      if (!pending) {
        pending = save(design)
        stored.set(design.key, pending)
        // A failed upload is tried again next time rather than remembered.
        pending.catch(() => stored.delete(design.key))
      }
      return pending
    },
    /**
     * The request for `choices`, built by `build` the first time and the
     * same input and key on every retry of the same choices. `choices` must
     * hold everything the request depends on and nothing generated.
     */
    request<T>(choices: unknown, build: (key: string) => T): { input: T; key: string } {
      const signature = JSON.stringify(choices)
      let entry = requests.get(signature)
      if (!entry) {
        const key = crypto.randomUUID()
        entry = { input: build(key), key }
        requests.set(signature, entry)
      }
      return entry as { input: T; key: string }
    },
  }
}

/** One preparation's session, as {@link postHandoff} makes it. */
export type PostHandoff = ReturnType<typeof postHandoff>
