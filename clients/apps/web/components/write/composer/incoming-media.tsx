'use client'

import * as React from 'react'
import type { PlateEditor } from '@shots/platejs-editor/platejs/react'
import type { TElement } from '@shots/platejs-editor/platejs'
import { Button } from '@/components/ui/button'
import { postRanges } from '@/components/drafts/thread'
import {
  dismissIncomingMedia,
  retryIncomingMedia,
  takeIncomingMedia,
  useIncomingMedia,
} from '@/lib/platform/incoming-media'
import { insertArrivedAttachments } from '@/lib/write/media-operations'

/**
 * Exports on their way from the screenshot editor into this draft.
 *
 * Each shows its progress while the editor renders and stores it. Once
 * stored, its attachments go to the end of the first post through this
 * composer's own editor, so they save, sync and undo like any attachment.
 * `editor` is the main version's editor, or null while another version is
 * open: arrivals then wait until the main version is back, rather than
 * landing in a platform's own text.
 */
export function IncomingMedia({
  draftId,
  editor,
}: {
  draftId: string
  editor: PlateEditor | null
}) {
  const jobs = useIncomingMedia(draftId)
  React.useEffect(() => {
    if (!editor) return
    const nodes = takeIncomingMedia(draftId)
    if (nodes.length === 0) return
    const [first] = postRanges(editor.children)
    insertArrivedAttachments(editor, first?.[1] ?? editor.children.length, nodes as TElement[])
  }, [draftId, editor, jobs])
  const shown = jobs.filter((job) => job.state !== 'ready' || !job.taken)
  if (shown.length === 0) return null
  return (
    <ul aria-label="Exports from the editor" className="grid gap-1.5" data-testid="incoming-media">
      {shown.map((job) => (
        <li
          className="grid gap-1.5 rounded-md border border-border px-3 py-2 text-xs"
          data-state={job.state}
          key={job.id}
        >
          <div className="flex items-center gap-2">
            <span className="font-medium text-foreground">{job.label}</span>
            <span className="text-muted-foreground" role="status">
              {job.state === 'working'
                ? `Exporting from the editor… ${job.progress}%`
                : job.state === 'failed'
                  ? (job.error ?? 'The export failed.')
                  : 'Ready. It joins the main version’s first post when that version is open.'}
            </span>
            <span className="ml-auto flex gap-1">
              {job.state === 'failed' ? (
                <Button
                  onClick={() => retryIncomingMedia(draftId, job.id)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Try again
                </Button>
              ) : null}
              {job.state !== 'working' ? (
                <Button
                  onClick={() => dismissIncomingMedia(draftId, job.id)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Dismiss
                </Button>
              ) : null}
            </span>
          </div>
          {job.state === 'working' ? (
            <div
              aria-label={`${job.label} export progress`}
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={job.progress}
              className="h-1 overflow-hidden rounded-full bg-foreground/[0.08]"
              role="progressbar"
            >
              <div
                className="h-full rounded-full bg-foreground transition-[width] duration-200"
                style={{ width: `${job.progress}%` }}
              />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
