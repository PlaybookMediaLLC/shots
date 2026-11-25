'use client'

import { CaretDownIcon } from '@phosphor-icons/react'
import Link from 'next/link'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { sectionContainsPath } from '@/lib/docs/navigation-groups'
import type { DocsSidebarSection } from '@/lib/docs/source'
import { cn } from '@/lib/utils'

interface DocsMobileSectionProps {
  onNavigate: () => void
  pathname: string
  section: DocsSidebarSection
}

export function DocsMobileSection({ onNavigate, pathname, section }: DocsMobileSectionProps) {
  const [open, setOpen] = useState(() => sectionContainsPath(section, pathname))

  return (
    <div>
      <Button
        aria-expanded={open}
        className={cn(
          'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-ui font-medium transition-colors',
          open
            ? 'text-foreground'
            : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground'
        )}
        onClick={() => setOpen((current) => !current)}
        size={null}
        type="button"
        variant="custom"
      >
        <span className="grow">{section.title}</span>
        <CaretDownIcon
          aria-hidden="true"
          className={cn(
            'size-3.5 text-[var(--fg-tertiary)] transition-transform duration-150',
            open ? 'rotate-180' : ''
          )}
        />
      </Button>
      <div
        aria-hidden={!open}
        className={cn(
          'grid overflow-hidden transition-[grid-template-rows,opacity] duration-150',
          open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        )}
        inert={!open}
      >
        <div className="flex flex-col gap-0.5 overflow-hidden pb-1.5 pl-2">
          {section.url ? (
            <MobileLink
              active={pathname === section.url}
              href={section.url}
              label="Overview"
              onNavigate={onNavigate}
            />
          ) : null}
          {section.groups.map((group) => (
            <div className="flex flex-col gap-0.5" key={group.title}>
              <p className="px-2.5 pt-2.5 pb-1 text-caption font-medium text-[var(--fg-tertiary)]">
                {group.title}
              </p>
              {group.items.map((item) => (
                <MobileLink
                  active={pathname === item.url}
                  href={item.url}
                  key={item.url}
                  label={item.title}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function MobileLink({
  active,
  href,
  label,
  onNavigate,
}: {
  active: boolean
  href: string
  label: string
  onNavigate: () => void
}) {
  return (
    <Link
      className={cn(
        'flex items-center gap-2 rounded-lg border px-2.5 py-2 text-ui transition-colors',
        active
          ? 'border-border bg-card font-medium text-foreground shadow-[0_1px_2px_rgb(0_0_0_/_5%)]'
          : 'border-transparent text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground'
      )}
      href={href}
      onClick={onNavigate}
    >
      {label}
    </Link>
  )
}
