'use client'

import {
  BookBookmarkIcon,
  BookOpenTextIcon,
  CaretDownIcon,
  CodeIcon,
  MagnifyingGlassIcon,
  RocketLaunchIcon,
  StackIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react'
import { useSearchContext } from 'fumadocs-ui/contexts/search'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState, type ComponentType } from 'react'
import { Button } from '@/components/ui/button'
import { sectionContainsPath } from '@/lib/docs/navigation-groups'
import type { DocsPageEntry, DocsSectionId, DocsSidebarSection } from '@/lib/docs/source'
import { withoutLocale } from '@/lib/settings/appearance'
import { cn } from '@/lib/utils'
import { DocsThemeToggle } from './docs-theme-toggle'

const SECTION_ICONS: Record<DocsSectionId, ComponentType<{ className?: string }>> = {
  api: CodeIcon,
  features: StackIcon,
  'getting-started': RocketLaunchIcon,
  guides: BookOpenTextIcon,
  reference: BookBookmarkIcon,
}

const NAV_FADE =
  'linear-gradient(to bottom, transparent, white 0.75rem, white calc(100% - 1.5rem), transparent 100%)'

interface DocsSidebarProps {
  homePage?: DocsPageEntry
  sections: DocsSidebarSection[]
}

export function DocsSidebar({ homePage, sections }: DocsSidebarProps) {
  const rawPathname = usePathname() ?? '/docs'
  const pathname = withoutLocale(rawPathname)
  const { setOpenSearch } = useSearchContext()
  const navRef = useRef<HTMLElement>(null)
  const [openIndex, setOpenIndex] = useState(() => {
    const index = sections.findIndex((section) => sectionContainsPath(section, pathname))
    return index === -1 ? 0 : index
  })

  useEffect(() => {
    const index = sections.findIndex((section) => sectionContainsPath(section, pathname))
    if (index !== -1) {
      setOpenIndex(index)
    }
  }, [pathname, sections])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const nav = navRef.current
      const active = nav?.querySelector<HTMLElement>("[data-active='true']")
      if (!nav || !active) return
      const navRect = nav.getBoundingClientRect()
      const activeRect = active.getBoundingClientRect()
      if (activeRect.top < navRect.top || activeRect.bottom > navRect.bottom) {
        active.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    }, 380)
    return () => window.clearTimeout(timer)
  }, [])

  return (
    <aside
      aria-label="Documentation sidebar"
      className="fixed top-[52px] bottom-0 left-0 z-30 hidden w-[268px] flex-col bg-background px-3 pb-3 lg:flex"
    >
      <div className="pt-1 pb-3">
        <Button
          className="flex h-9 w-full items-center gap-2 rounded-lg border border-border bg-card px-3 text-left text-ui text-muted-foreground shadow-[0_1px_2px_rgb(0_0_0_/_3%)] transition-colors hover:border-foreground/20 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setOpenSearch(true)}
          size={null}
          type="button"
          variant="custom"
        >
          <MagnifyingGlassIcon aria-hidden="true" className="size-4 shrink-0" />
          <span className="truncate">Search</span>
          <kbd className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-[var(--fg-tertiary)]">
            <span aria-hidden="true">⌘</span>K
          </kbd>
        </Button>
      </div>

      <nav
        className="flex-1 overflow-x-hidden overflow-y-auto pt-1 pb-3"
        ref={navRef}
        style={{ maskImage: NAV_FADE }}
      >
        <div className="flex flex-col gap-0.5">
          {homePage ? (
            <SidebarLink active={pathname === homePage.url} href={homePage.url} label="Overview" />
          ) : null}

          {sections.map((section, index) => {
            const Icon = SECTION_ICONS[section.id]
            const open = openIndex === index
            return (
              <div className="mt-1" key={section.id}>
                <Button
                  aria-controls={`docs-sidebar-section-${section.id}`}
                  aria-expanded={open}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-ui font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    open
                      ? 'text-foreground'
                      : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground'
                  )}
                  onClick={() => setOpenIndex((current) => (current === index ? -1 : index))}
                  size={null}
                  type="button"
                  variant="custom"
                >
                  <Icon aria-hidden="true" className="size-4 shrink-0" />
                  <span className="grow truncate">{section.title}</span>
                  <CaretDownIcon
                    aria-hidden="true"
                    className={cn(
                      'size-3.5 shrink-0 text-[var(--fg-tertiary)] transition-transform duration-150',
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
                  id={`docs-sidebar-section-${section.id}`}
                  inert={!open}
                >
                  <div className="overflow-hidden">
                    <div className="mt-0.5 flex flex-col gap-0.5 pb-1.5 pl-2">
                      {section.url ? (
                        <SidebarLink
                          active={pathname === section.url}
                          href={section.url}
                          label="Overview"
                        />
                      ) : null}
                      {section.groups.map((group) => (
                        <div className="flex flex-col gap-0.5" key={group.title}>
                          <p className="px-2.5 pt-2.5 pb-1 text-caption font-medium text-[var(--fg-tertiary)]">
                            {group.title}
                          </p>
                          {group.items.map((item) => (
                            <SidebarLink
                              active={pathname === item.url}
                              href={item.url}
                              key={item.url}
                              label={item.title}
                            />
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </nav>

      <div className="flex items-center gap-1 border-t border-border pt-2 text-muted-foreground">
        <Link
          aria-label="Interactive API Reference"
          className="inline-flex size-8 items-center justify-center rounded-lg transition-colors hover:bg-foreground/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          href="/api-reference"
          title="Interactive API Reference"
        >
          <TerminalWindowIcon aria-hidden="true" className="size-4" />
        </Link>
        <div className="ms-auto">
          <DocsThemeToggle />
        </div>
      </div>
    </aside>
  )
}

function SidebarLink({
  active,
  href,
  label,
}: {
  active: boolean
  href: string
  label: string
}) {
  return (
    <Link
      className={cn(
        'relative flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-ui transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'border-border bg-card font-medium text-foreground shadow-[0_1px_2px_rgb(0_0_0_/_5%)]'
          : 'border-transparent text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground'
      )}
      data-active={active || undefined}
      href={href}
    >
      <span className="grow truncate">{label}</span>
    </Link>
  )
}
