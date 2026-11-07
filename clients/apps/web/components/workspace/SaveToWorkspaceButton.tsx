'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useProjectSession } from '@/lib/projects/session'
import { toast } from 'sonner'
import dynamic from 'next/dynamic'
import { Button } from '@/components/ui/button'
import { startPostWithAssets } from '@/components/write/pending-draft'
import { useHydratedSession } from '@/lib/auth/client'
import { renderLiveDesign } from '@/lib/editor/post-handoff'
import { draftAttachHref, readEditorReturn } from '@/lib/platform/editor-handoff'
import { useTRPCClient } from '@/lib/trpc/react'
import {
  buildExportFileName,
  saveExportToWorkspace,
  WorkspaceSaveError,
} from '@/lib/workspace/save-export'

/**
 * Saves the current export into the signed-in user's workspace.
 *
 * The editor requires sign-in, so the session is normally present. Saving
 * is additive to downloading: exports still download as before, and this
 * control adds a copy to the workspace.
 */

export interface SaveToWorkspaceButtonProps {
  /** Produces the bytes to save. Called only when the user asks to save,
   * because rendering an export is expensive. */
  createExport: () => Promise<Blob>
  disabled?: boolean
  /** A descriptive filename for exports with a known source. */
  fileName?: string
}

// The preparation dialog reaches Publish's profiles, batches and campaign
// copy; the editor loads none of that until someone asks for a post.
const PrepareScreenshotPost = dynamic(
  () =>
    import('@/components/workspace/PrepareScreenshotPost').then(
      (module) => module.PrepareScreenshotPost
    ),
  { ssr: false }
)

type SaveState = 'idle' | 'saving' | 'saved'

/** The draft this editor was opened from, when a person came to frame its media. */
function draftFromUrl(): string | null {
  return readEditorReturn(window.location.search).draftId ?? null
}

/**
 * Distinguish what the user can act on from what they cannot. An unsupported
 * format or an oversized export is fixable in the editor; anything else is
 * not, and saying so avoids implying the user did something wrong.
 */
function saveFailure(error: unknown): string {
  return error instanceof WorkspaceSaveError
    ? error.message
    : 'The export could not be saved. Your work is unchanged.'
}

/** Props of {@link UseInPostButton}. */
export type UseInPostButtonProps = {
  /**
   * Renders the design with the export panel's settings. Without one (the
   * AI panels), it is rendered as the editor's default still export.
   */
  createExport?: () => Promise<Blob>
  disabled?: boolean
  fileName?: string
  /** The button's words, where the surface says what it posts. */
  label?: string
  /** The type `createExport` produces, for checking each platform's rules first. */
  mediaType?: string
  /** Open with one post per AI version. */
  startWithVersions?: boolean
  variant?: React.ComponentProps<typeof Button>['variant']
}

/**
 * Export the design and take it into Publish, with no Library steps in
 * between. Framing an existing attachment returns to the draft it came from;
 * anything else opens the preparation dialog, which writes the caption,
 * thread, follow-ups and destination before the draft or batch item exists.
 * The export controls and the AI Captions and Variants panels all open the
 * same dialog through here.
 */
export function UseInPostButton({
  createExport,
  disabled,
  fileName,
  label = 'Use in post',
  mediaType,
  startWithVersions,
  variant,
}: UseInPostButtonProps) {
  const router = useRouter()
  const trpcClient = useTRPCClient()
  const [busy, setBusy] = React.useState(false)
  const [preparing, setPreparing] = React.useState(false)

  async function returnToDraft(draft: string): Promise<void> {
    setBusy(true)
    try {
      const blob = await (createExport ?? renderLiveDesign)()
      const { assetId } = await saveExportToWorkspace({
        blob,
        classification: 'export',
        projectId: useProjectSession.getState().projectId ?? undefined,
        fileName: fileName ?? buildExportFileName(blob.type),
        trpcClient,
      })
      // Only an image replaces the attachment being framed; a video export
      // belongs to a post of its own, as it did before.
      if (blob.type.startsWith('image/')) router.push(draftAttachHref(draft, assetId))
      else
        await startPostWithAssets([{ id: assetId, mediaType: blob.type }], (id) =>
          router.push(`/publish/${encodeURIComponent(id)}`)
        )
    } catch (error) {
      toast.error('Could not start the post', { description: saveFailure(error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button
        disabled={disabled || busy}
        onClick={() => {
          // Versions are new posts; only the design itself replaces an attachment.
          const draft = startWithVersions ? null : draftFromUrl()
          if (draft) void returnToDraft(draft)
          else setPreparing(true)
        }}
        type="button"
        {...(variant ? { variant } : {})}
      >
        {busy ? 'Preparing…' : label}
      </Button>
      {preparing ? (
        <PrepareScreenshotPost
          {...(createExport ? { createExport } : {})}
          {...(fileName ? { fileName } : {})}
          {...(mediaType ? { mediaType } : {})}
          onOpenChange={setPreparing}
          open
          {...(startWithVersions ? { startWithVersions } : {})}
        />
      ) : null}
    </>
  )
}

export function SaveToWorkspaceButton({
  createExport,
  disabled,
  fileName,
}: SaveToWorkspaceButtonProps) {
  const trpcClient = useTRPCClient()
  const { data: session, isPending } = useHydratedSession()
  const [draftExport, setDraftExport] = React.useState<{ draft: string; assetId: string } | null>(
    null
  )
  const [state, setState] = React.useState<SaveState>('idle')

  // Render nothing while the session loads or if it has lapsed; the
  // sign-in gate in front of the editor owns that flow.
  if (isPending || !session) {
    return null
  }

  async function handleSave(): Promise<void> {
    setState('saving')
    try {
      const blob = await createExport()
      const { assetId } = await saveExportToWorkspace({
        blob,
        classification: 'export',
        projectId: useProjectSession.getState().projectId ?? undefined,
        fileName: fileName ?? buildExportFileName(blob.type),
        trpcClient,
      })

      setState('saved')
      const draft = draftFromUrl()
      if (draft && blob.type.startsWith('image/')) setDraftExport({ draft, assetId })
      toast.success('Saved to workspace', {
        action: {
          label: 'View assets',
          onClick: () => window.open('/library?view=assets', '_blank', 'noopener,noreferrer'),
        },
        description: 'This export is now available to your team.',
      })
      // Reset so a further edit can be saved without reloading.
      window.setTimeout(() => setState('idle'), 2_000)
      return void assetId
    } catch (error) {
      setState('idle')

      toast.error('Could not save to workspace', { description: saveFailure(error) })
    }
  }

  return (
    <>
      <Button
        disabled={disabled || state === 'saving'}
        onClick={handleSave}
        type="button"
        variant="outline"
      >
        {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : 'Save to workspace'}
      </Button>
      {draftExport && (
        <a
          className="text-sm underline"
          href={draftAttachHref(draftExport.draft, draftExport.assetId)}
        >
          Review export in draft
        </a>
      )}
    </>
  )
}
