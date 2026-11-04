'use client'

import * as React from 'react'
import { useProjectSession } from '@/lib/projects/session'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useHydratedSession } from '@/lib/auth/client'
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

type SaveState = 'idle' | 'saving' | 'saved'

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
      const draft = new URLSearchParams(window.location.search).get('fromDraft')
      if (draft && /^[a-z0-9_-]{1,128}$/i.test(draft) && blob.type.startsWith('image/'))
        setDraftExport({ draft, assetId })
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

      // Distinguish what the user can act on from what they cannot. An
      // unsupported format or an oversized export is fixable in the
      // editor; anything else is not, and saying so avoids implying the
      // user did something wrong.
      const description =
        error instanceof WorkspaceSaveError
          ? error.message
          : 'The export could not be saved. Your work is unchanged.'
      toast.error('Could not save to workspace', { description })
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
          href={`/publish/${encodeURIComponent(draftExport.draft)}?attach=${encodeURIComponent(draftExport.assetId)}`}
        >
          Review export in draft
        </a>
      )}
    </>
  )
}
