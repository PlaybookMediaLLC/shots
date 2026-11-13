'use client'

import * as React from 'react'
import { UploadIcon } from '@/components/platform-shell/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/** A button that opens the file chooser; the input stays labelled for assistive tech and tests. */
export function FilePicker({
  accept,
  children,
  directory,
  disabled,
  label,
  multiple,
  onFiles,
}: {
  accept: string
  children?: React.ReactNode
  /** Choose a folder; each file keeps its path inside it. */
  directory?: boolean
  disabled?: boolean
  label: string
  multiple?: boolean
  onFiles: (files: File[]) => void
}) {
  const input = React.useRef<HTMLInputElement>(null)
  return (
    <>
      <Input
        ref={input}
        aria-label={label}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        disabled={disabled}
        {...(directory ? { webkitdirectory: '' } : {})}
        onChange={(event) => {
          onFiles(Array.from(event.target.files ?? []))
          event.target.value = ''
        }}
      />
      <Button
        disabled={disabled}
        type="button"
        variant="outline"
        size="sm"
        onClick={() => input.current?.click()}
      >
        <UploadIcon />
        {children ?? label}
      </Button>
    </>
  )
}
