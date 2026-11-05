'use client'

import type { ReactNode } from 'react'
import { InfoIcon } from '@/components/platform-shell/icons'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

/** The ⓘ behind which Analyze keeps a number's fine print. */
export function InfoTip({
  children,
  className,
  label,
}: {
  children: ReactNode
  className?: string
  label: string
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button aria-label={label} className={className} size="icon-sm" variant="ghost">
          <InfoIcon aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="text-xs">{children}</PopoverContent>
    </Popover>
  )
}
