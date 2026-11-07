'use client'

import * as React from 'react'
import dynamic from 'next/dynamic'
import { PaperPlaneTiltIcon } from '@phosphor-icons/react/dist/ssr/PaperPlaneTilt'
import { Button } from '@/components/ui/button'
import { useCanStartPost } from '@/lib/platform/can-start-post'
import { cn } from '@/lib/utils'

/**
 * The editor's Publish action, beside Share and Export.
 *
 * The dialog carries the export pipeline, the social set list and the draft
 * API, so it is loaded when it is asked for and unmounted when it closes:
 * opening the editor costs nothing, and a large rendered blob is never held
 * between openings.
 */
const PublishDialog = dynamic(
  () => import('./PublishDialog').then((module) => module.PublishDialog),
  { ssr: false }
)

export function PublishButton({ compact = false, disabled }: { compact?: boolean; disabled: boolean }) {
  const canStartPost = useCanStartPost()
  const [open, setOpen] = React.useState(false)
  if (!canStartPost) return null
  return (
    <>
      <Button
        aria-label="Publish"
        className={cn(
          'inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-foreground/[0.08] text-[13px] font-medium text-foreground',
          'transition-colors duration-150 hover:bg-foreground/[0.06] disabled:pointer-events-none disabled:opacity-35',
          compact ? 'px-2' : 'px-3'
        )}
        disabled={disabled}
        onClick={() => setOpen(true)}
        size={null}
        type="button"
        variant="custom"
      >
        <PaperPlaneTiltIcon size={15} />
        {!compact ? <span>Publish</span> : null}
      </Button>
      {open ? <PublishDialog onOpenChange={setOpen} open /> : null}
    </>
  )
}
