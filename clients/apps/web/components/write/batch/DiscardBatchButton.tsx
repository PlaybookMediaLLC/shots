'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { call } from '@/lib/content-drafts/client'

/**
 * Close a batch that holds no posts. Starting a batch creates it before any
 * file or row is added, so an abandoned start would otherwise sit in the list
 * for good; this is the one step that clears it. A batch with posts is closed
 * from inside the batch, where its drafts are in view.
 */
export function DiscardBatchButton({ id, title }: { id: string; title: string }) {
  const router = useRouter()
  const [busy, setBusy] = React.useState(false)
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          aria-label={`Discard the empty batch ${title}`}
          disabled={busy}
          size="sm"
          variant="ghost"
        >
          Discard
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard “{title}”?</AlertDialogTitle>
          <AlertDialogDescription>
            It holds no posts, so nothing is lost. It leaves this list; start another batch
            whenever you need one.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              setBusy(true)
              void call<{ archived: true }>(
                `/api/v1/content-batches/${encodeURIComponent(id)}/archive`,
                { method: 'POST', body: {} }
              )
                .then(() => router.refresh())
                .catch((error: unknown) => {
                  toast.error(
                    error instanceof Error ? error.message : 'The batch could not be discarded.'
                  )
                  setBusy(false)
                })
            }}
          >
            Discard it
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
