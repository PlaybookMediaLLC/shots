'use client'

import { MoonIcon, SunIcon } from '@phosphor-icons/react'
import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface DocsThemeToggleProps {
  className?: string
}

export function DocsThemeToggle({ className }: DocsThemeToggleProps) {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  const isDarkMode = mounted && resolvedTheme === 'dark'

  return (
    <Button
      aria-label={`Switch to ${isDarkMode ? 'light' : 'dark'} mode`}
      className={cn(
        'inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground',
        className
      )}
      onClick={() => setTheme(isDarkMode ? 'light' : 'dark')}
      size={null}
      type="button"
      variant="custom"
    >
      {mounted ? (
        isDarkMode ? (
          <SunIcon aria-hidden="true" className="size-4" />
        ) : (
          <MoonIcon aria-hidden="true" className="size-4" />
        )
      ) : (
        <span aria-hidden="true" className="size-4" />
      )}
    </Button>
  )
}
