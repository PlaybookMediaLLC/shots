'use client'

import { useState, type ReactNode } from 'react'
import { Label } from '@/components/ui/label'
import { getErrorMessage } from '@/components/workspace/settings-client'

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
