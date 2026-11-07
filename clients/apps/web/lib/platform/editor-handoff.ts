// The id rule's own module: the full draft contract pulls the backend SDK and
// the OpenAPI helpers, and this runs in the editor's bundle.
import { contentDraftIdSchema } from '@/lib/api/contracts/content-draft-list'

/**
 * The screenshot editor's round trip. Every surface that sends work into the
 * editor (a draft's attachment, a campaign visual, a library asset) builds
 * its link here, and the export controls read the way back from the same
 * keys. Keeping both halves in one place is what lets an export return to
 * the thing it was opened from instead of becoming a loose asset.
 */

/** The editor's canonical route; `/` still redirects to it with its query. */
export const EDITOR_PATH = '/editor'

/** What the editor should open: a flat image asset, or a saved design. */
export type EditorSource = { assetId: string } | { designId: string }

/** Where an export made in the editor belongs when the editor is left. */
export type EditorReturn = {
  /** The draft whose attachment is being framed; the export replaces it. */
  draftId?: string
  /** The campaign whose visual is being edited; its copy seeds the post. */
  campaignId?: string
}

const id = (value: string | null): string | undefined =>
  value && contentDraftIdSchema.safeParse(value).success ? value : undefined

/**
 * The return target carried in an editor URL. Unrecognized or malformed ids
 * are dropped rather than trusted: the value reaches a route and an API call.
 */
export function readEditorReturn(search: string): EditorReturn {
  const params = new URLSearchParams(search)
  const draftId = id(params.get('fromDraft'))
  const campaignId = id(params.get('fromCampaign'))
  return { ...(draftId ? { draftId } : {}), ...(campaignId ? { campaignId } : {}) }
}

/** Open the editor on a source, remembering where its export belongs. */
export function editorHref(source: EditorSource, from: EditorReturn = {}): string {
  const query = new URLSearchParams(
    'assetId' in source ? { asset: source.assetId } : { design: source.designId }
  )
  if (from.draftId) query.set('fromDraft', from.draftId)
  if (from.campaignId) query.set('fromCampaign', from.campaignId)
  return `${EDITOR_PATH}?${query}`
}

/**
 * The draft, opened with a freshly exported asset waiting to be attached. The
 * composer attaches it only when the person says so. A known media type
 * travels with it so the composer can check each destination's formats at
 * once; the backend validates the asset and its type again when the draft is
 * scheduled.
 */
export function draftAttachHref(draftId: string, assetId: string, mediaType?: string): string {
  const query = new URLSearchParams({ attach: assetId })
  if (mediaType) query.set('attachType', mediaType)
  return `/publish/${encodeURIComponent(draftId)}?${query}`
}
