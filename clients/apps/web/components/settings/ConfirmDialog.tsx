'use client'

import { type ReactNode, useId, useState } from 'react'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * A confirmation for a sensitive or destructive action. It stays open while
 * the action runs and closes only when it succeeds; a failure shows in the
 * dialog. With `confirmText`, the action unlocks once that text is typed.
 */
export function ConfirmDialog({
  children,
  confirmLabel,
  confirmText,
  description,
  destructive,
  disabled,
  onConfirm,
  onOpenChange,
  open: controlledOpen,
  title,
  triggerLabel,
}: {
  children?: ReactNode
  confirmLabel: string
  /** Text the person types to unlock the action, such as a name. */
  confirmText?: string
  description: ReactNode
  destructive?: boolean
  /** Disables the trigger and the confirm button, such as while the action cannot run. */
  disabled?: boolean
  /** Resolves to an error message, or null when it succeeded. */
  onConfirm: (typed: string) => Promise<string | null>
  /** With `open`, the caller opens the dialog, such as from a menu, and no trigger renders. */
  onOpenChange?: (open: boolean) => void
  open?: boolean
  title: string
  triggerLabel?: string
}) {
  const id = useId()
  const [ownOpen, setOwnOpen] = useState(false)
  const open = controlledOpen ?? ownOpen
  const setOpen = (next: boolean) => {
    setOwnOpen(next)
    onOpenChange?.(next)
  }
  const [typed, setTyped] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const locked = confirmText !== undefined && typed.trim() !== confirmText

  const confirm = async () => {
    setRunning(true)
    setError(null)
    const failure = await onConfirm(typed.trim())
    setRunning(false)
    if (failure) {
      setError(failure)
      return
    }
    setOpen(false)
    setTyped('')
  }

  return (
    <AlertDialog
      onOpenChange={(next) => {
        if (running) return
        setOpen(next)
        if (!next) {
          setError(null)
          setTyped('')
        }
      }}
      open={open}
    >
      {triggerLabel ? (
        <AlertDialogTrigger asChild>
          <Button disabled={disabled} type="button" variant={destructive ? 'destructive' : 'outline'}>
            {triggerLabel}
          </Button>
        </AlertDialogTrigger>
      ) : null}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="grid gap-2 text-sm text-muted-foreground">{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        {confirmText !== undefined ? (
          <Label className="grid gap-1 text-sm" htmlFor={`${id}-confirm`}>
            <span className="text-foreground">
              Type <strong className="font-medium">{confirmText}</strong> to confirm
            </span>
            <Input autoComplete="off" id={`${id}-confirm`} onChange={(event) => setTyped(event.target.value)} value={typed} />
          </Label>
        ) : null}
        {error ? (
          <p className="text-sm text-red-700 dark:text-red-300" role="alert">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={running}>Cancel</AlertDialogCancel>
          <Button
            disabled={disabled || locked || running}
            onClick={() => void confirm()}
            type="button"
            variant={destructive ? 'destructive' : 'default'}
          >
            {running ? 'Working…' : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
