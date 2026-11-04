'use client'

import { UploadSimpleIcon } from '@phosphor-icons/react/dist/ssr/UploadSimple'
import type { ReactNode } from 'react'
import { type Accept, ErrorCode, type FileRejection, useDropzone } from 'react-dropzone'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** Why a dropped file was turned away, in words. */
function rejectionMessage(rejections: readonly FileRejection[], maxSize?: number): string | null {
  const code = rejections[0]?.errors[0]?.code
  if (!code) return null
  if (code === ErrorCode.FileTooLarge && maxSize)
    return `That file is larger than ${Math.round(maxSize / 1024 / 1024)} MB.`
  if (code === ErrorCode.FileInvalidType) return 'That file type is not accepted here.'
  if (code === ErrorCode.TooManyFiles) return 'Choose fewer files.'
  return 'That file could not be used.'
}

/**
 * Drop a file here or browse for one. Shows the accepted types and size
 * limit, says why a dropped file was turned away, and once something is
 * chosen shows its `preview` with Replace and Remove. The callers keep their
 * own checks: `onFiles` gets only files that passed `accept` and `maxSize`.
 */
export function FileDropZone({
  accept,
  busy,
  className,
  disabled,
  hint,
  id,
  label,
  maxSize,
  multiple,
  onFiles,
  onRemove,
  preview,
}: {
  /** MIME types to the extensions they cover, as react-dropzone reads them. */
  accept: Accept
  /** An upload is running: the zone says so and takes no new file. */
  busy?: boolean
  className?: string
  disabled?: boolean
  /** The accepted types and size limit, as people read them. */
  hint: ReactNode
  id?: string
  /** The field's name, for its hidden input and the browse button. */
  label: string
  maxSize?: number
  multiple?: boolean
  onFiles: (files: File[]) => void
  onRemove?: () => void
  /** What is chosen now; with it the zone offers Replace and Remove. */
  preview?: ReactNode
}) {
  const { fileRejections, getInputProps, getRootProps, isDragActive, open } = useDropzone({
    accept,
    disabled: disabled || busy,
    maxSize,
    multiple,
    noClick: true,
    noKeyboard: true,
    onDropAccepted: onFiles,
  })
  const rejected = rejectionMessage(fileRejections, maxSize)

  return (
    <div className={cn('grid gap-1.5', className)}>
      <div
        {...getRootProps({
          className: cn(
            'flex min-w-0 flex-wrap items-center gap-3 rounded-md border border-dashed border-muted-foreground/40 px-4 py-3 text-sm transition-colors',
            isDragActive && 'border-ring bg-accent',
            (disabled || busy) && 'opacity-60'
          ),
        })}
      >
        <input {...getInputProps({ 'aria-label': label, id })} />
        {preview ? (
          <>
            <div className="flex min-w-0 flex-1 items-center gap-3">{preview}</div>
            <div className="flex gap-2">
              <Button disabled={disabled || busy} onClick={open} size="sm" type="button" variant="outline">
                Replace
              </Button>
              {onRemove ? (
                <Button disabled={disabled || busy} onClick={onRemove} size="sm" type="button" variant="ghost">
                  Remove
                </Button>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <UploadSimpleIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
            <div className="grid min-w-0 flex-1 gap-0.5">
              <span className="text-foreground">
                {busy ? (
                  'Uploading…'
                ) : isDragActive ? (
                  'Drop to add'
                ) : (
                  <>
                    Drop {multiple ? 'files' : 'a file'} or{' '}
                    <Button
                      className="h-auto p-0 align-baseline"
                      disabled={disabled}
                      onClick={open}
                      type="button"
                      variant="link"
                    >
                      browse
                    </Button>
                  </>
                )}
              </span>
              <span className="text-xs text-muted-foreground">{hint}</span>
            </div>
          </>
        )}
      </div>
      {rejected ? (
        <p className="text-xs text-destructive" role="alert">
          {rejected}
        </p>
      ) : null}
    </div>
  )
}
