'use client'

import { useState, type ReactNode } from 'react'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { Label } from '@/components/ui/label'
import { getErrorMessage } from '@/components/workspace/settings-client'
import { editorHref } from '@/lib/platform/editor-handoff'

/** Runs one request at a time and keeps its failure for the person to read. */
export function useCaptureAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (failure) {
      setError(getErrorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

/** A form control with its label and one line of help. */
export function CaptureField({
  children,
  hint,
  label,
}: {
  children: ReactNode
  hint?: string
  label: string
}) {
  return (
    <Label className="grid content-start gap-1 text-sm">
      {label}
      {children}
      {hint ? (
        <span className="text-xs leading-5 font-normal text-muted-foreground">{hint}</span>
      ) : null}
    </Label>
  )
}

/** A failed request's message, when there is one. */
export function CaptureError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <p className="text-sm text-destructive" role="alert">
      {message}
    </p>
  )
}

/** Ordered thumbnails and editor handoff links for a single or multi-shot capture job. */
export function CaptureFrameList({
  compact = false,
  frames,
  name,
}: {
  compact?: boolean
  frames: string[]
  name: string
}) {
  if (frames.length === 0) return null
  return (
    <div
      className={
        compact
          ? 'flex flex-wrap items-start gap-3 pt-1'
          : frames.length > 1
            ? 'grid gap-3 sm:grid-cols-2 lg:grid-cols-3'
            : 'space-y-2'
      }
    >
      {frames.map((assetId, index) => {
        const label =
          frames.length > 1
            ? index === frames.length - 1
              ? `Final (${index + 1}/${frames.length})`
              : `Step ${index + 1} of ${frames.length}`
            : name
        return (
          <div className="space-y-1.5" key={assetId}>
            {frames.length > 1 ? (
              <p className="text-xs font-medium text-muted-foreground">{label}</p>
            ) : null}
            <a
              aria-label={`Open capture of ${label} at full size`}
              className={
                compact
                  ? 'block w-40 overflow-hidden rounded-lg ring-1 ring-foreground/[0.08] focus-visible:ring-2'
                  : 'block w-full max-w-md overflow-hidden rounded-lg ring-1 ring-foreground/[0.08] focus-visible:ring-2'
              }
              href={`/api/v1/assets/${encodeURIComponent(assetId)}/content`}
              rel="noopener noreferrer"
              target="_blank"
            >
              <img
                alt={`Capture of ${label}`}
                className={compact ? 'aspect-[16/10] w-full object-cover object-top' : 'w-full'}
                loading="lazy"
                src={`/api/v1/assets/${encodeURIComponent(assetId)}/content?variant=thumbnail`}
              />
            </a>
            <ButtonLink href={editorHref({ assetId })} size="sm" variant="outline">
              Open in editor
            </ButtonLink>
          </div>
        )
      })}
    </div>
  )
}
