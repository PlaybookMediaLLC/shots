'use client'

import {
  ArrowUpRightIcon,
  CaretDownIcon,
  ListIcon,
  MagnifyingGlassIcon,
  XIcon,
} from '@phosphor-icons/react'
import { useSearchContext } from 'fumadocs-ui/contexts/search'
import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { publicImageUrl } from '@/lib/assets/public-image'
import type { DocsPageEntry, DocsSidebarSection } from '@/lib/docs/source'
import { withoutLocale } from '@/lib/settings/appearance'
import { cn } from '@/lib/utils'
import { DocsMobileSection } from './docs-mobile-section'
import { DocsThemeToggle } from './docs-theme-toggle'

const NAVIGATION_TABS = [
  { href: '/landing', label: 'Overview' },
  { href: '/docs', label: 'Docs' },
  { href: '/api-reference', label: 'API Reference' },
  { href: '/pricing', label: 'Pricing' },
] as const

const PRODUCT_ITEMS = [
  { href: '/product', label: 'Platform overview' },
  { href: '/product/launch-intelligence', label: 'Launch intelligence' },
  { href: '/product/creative-engine', label: 'Creative engine' },
  { href: '/product/approvals', label: 'Approvals' },
  { href: '/product/publishing', label: 'Publishing' },
] as const

const RESOURCE_ITEMS = [
  { href: '/developers', label: 'Developer portal' },
  { href: '/changelog', label: 'Changelog' },
  { href: '/guides', label: 'Guides' },
  { href: '/security', label: 'Security' },
  { href: '/contact', label: 'Contact' },
] as const

type DropdownId = 'product' | 'resources' | null

interface DocsShellNavProps {
  homePage?: DocsPageEntry
  sections: DocsSidebarSection[]
}

function DocsBrandMark() {
  return (
    <Link
      className="flex min-w-0 items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      href="/landing"
    >
      <Image
        alt=""
        className="size-6 shrink-0 rounded-md"
        height={24}
        src={publicImageUrl('/logo-mark.png')}
        width={24}
      />
      <span className="truncate text-[0.9375rem] font-medium text-foreground">Shots</span>
      <span className="rounded-md border border-border bg-card px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
        Docs
      </span>
    </Link>
  )
}

export function DocsShellNav({ homePage, sections }: DocsShellNavProps) {
  const rawPathname = usePathname() ?? '/docs'
  const pathname = withoutLocale(rawPathname)
  const { setOpenSearch } = useSearchContext()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [openDropdown, setOpenDropdown] = useState<DropdownId>(null)
  const closeTimeoutRef = useRef<number | null>(null)
  const desktopNavRef = useRef<HTMLElement>(null)

  const clearPendingClose = useCallback(() => {
    if (closeTimeoutRef.current !== null) {
      window.clearTimeout(closeTimeoutRef.current)
      closeTimeoutRef.current = null
    }
  }, [])

  const openMenu = useCallback(
    (id: Exclude<DropdownId, null>) => {
      clearPendingClose()
      setOpenDropdown(id)
    },
    [clearPendingClose]
  )

  const scheduleClose = useCallback(() => {
    clearPendingClose()
    closeTimeoutRef.current = window.setTimeout(() => {
      closeTimeoutRef.current = null
      setOpenDropdown(null)
    }, 120)
  }, [clearPendingClose])

  const toggleMenu = useCallback(
    (id: Exclude<DropdownId, null>) => {
      clearPendingClose()
      setOpenDropdown((current) => (current === id ? null : id))
    },
    [clearPendingClose]
  )

  useEffect(() => clearPendingClose, [clearPendingClose])

  useEffect(() => {
    setMobileMenuOpen(false)
    setOpenDropdown(null)
  }, [pathname])

  useEffect(() => {
    if (!openDropdown && !mobileMenuOpen) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        clearPendingClose()
        setOpenDropdown(null)
        setMobileMenuOpen(false)
      }
    }

    const onPointerDown = (event: PointerEvent) => {
      if (
        openDropdown &&
        desktopNavRef.current &&
        !desktopNavRef.current.contains(event.target as Node)
      ) {
        clearPendingClose()
        setOpenDropdown(null)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerdown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerdown', onPointerDown)
    }
  }, [clearPendingClose, mobileMenuOpen, openDropdown])

  return (
    <>
      <header className="pointer-events-none fixed top-0 right-0 left-0 z-[99] flex items-center bg-background">
        <div className="pointer-events-auto hidden h-[3.25rem] w-[16.75rem] shrink-0 items-center px-4 lg:flex">
          <DocsBrandMark />
        </div>

        <nav
          aria-label="Documentation top navigation"
          className="pointer-events-auto hidden h-[3.25rem] min-w-0 flex-1 items-center gap-1 pr-3 lg:flex"
          ref={desktopNavRef}
        >
          {NAVIGATION_TABS.map((item) => {
            const active = item.href === '/docs'
            return (
              <Link
                className={cn(
                  'inline-flex h-8 items-center rounded-lg border px-3 text-ui font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'border-border bg-card text-foreground shadow-[0_1px_2px_rgb(0_0_0_/_5%)]'
                    : 'border-transparent text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground'
                )}
                href={item.href}
                key={item.href}
              >
                {item.label}
              </Link>
            )
          })}

          <NavDropdown
            items={PRODUCT_ITEMS}
            label="Product"
            onClose={() => {
              clearPendingClose()
              setOpenDropdown(null)
            }}
            onMouseEnter={() => openMenu('product')}
            onMouseLeave={scheduleClose}
            onToggle={() => toggleMenu('product')}
            open={openDropdown === 'product'}
          />

          <NavDropdown
            items={RESOURCE_ITEMS}
            label="Resources"
            onClose={() => {
              clearPendingClose()
              setOpenDropdown(null)
            }}
            onMouseEnter={() => openMenu('resources')}
            onMouseLeave={scheduleClose}
            onToggle={() => toggleMenu('resources')}
            open={openDropdown === 'resources'}
          />

          <div className="ms-auto flex shrink-0 items-center gap-2">
            <Link
              className="inline-flex h-8 items-center gap-1.5 rounded-full bg-primary px-3.5 text-ui font-medium text-primary-foreground transition-opacity duration-150 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              href="/sign-in"
            >
              <span>Sign in</span>
              <ArrowUpRightIcon aria-hidden="true" className="size-3.5 opacity-75" />
            </Link>
          </div>
        </nav>

        <div className="pointer-events-auto flex h-[3.25rem] w-full items-center justify-between border-b border-border bg-background px-4 lg:hidden">
          <DocsBrandMark />
          <div className="flex items-center gap-1">
            <Button
              aria-label="Search documentation"
              className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
              onClick={() => {
                setMobileMenuOpen(false)
                setOpenSearch(true)
              }}
              size={null}
              type="button"
              variant="custom"
            >
              <MagnifyingGlassIcon aria-hidden="true" className="size-4" />
            </Button>
            <DocsThemeToggle />
            <Button
              aria-expanded={mobileMenuOpen}
              aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
              className="inline-flex size-8 items-center justify-center rounded-lg text-foreground/80 transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
              onClick={() => setMobileMenuOpen((current) => !current)}
              size={null}
              type="button"
              variant="custom"
            >
              {mobileMenuOpen ? (
                <XIcon aria-hidden="true" className="size-[18px]" />
              ) : (
                <ListIcon aria-hidden="true" className="size-[18px]" />
              )}
            </Button>
          </div>
        </div>
      </header>

      {mobileMenuOpen ? (
        <div
          aria-label="Documentation navigation"
          aria-modal="true"
          className="pointer-events-auto fixed inset-0 z-[98] bg-background/95 pt-[3.25rem] backdrop-blur-sm lg:hidden"
          role="dialog"
        >
          <div className="flex h-full flex-col overflow-y-auto overscroll-contain px-3 py-3">
            <p className="px-2.5 pb-2 text-caption font-medium text-[var(--fg-tertiary)]">
              Documentation
            </p>
            {homePage ? (
              <MobileMenuLink
                active={pathname === homePage.url}
                href={homePage.url}
                onNavigate={() => setMobileMenuOpen(false)}
              >
                Overview
              </MobileMenuLink>
            ) : null}
            <div className="mt-1 flex flex-col gap-0.5">
              {sections.map((section) => (
                <DocsMobileSection
                  key={section.id}
                  onNavigate={() => setMobileMenuOpen(false)}
                  pathname={pathname}
                  section={section}
                />
              ))}
            </div>
            <div className="mt-auto border-t border-border pt-3">
              <div className="flex flex-col gap-0.5">
                {NAVIGATION_TABS.filter((item) => item.href !== '/docs').map((item) => (
                  <MobileMenuLink
                    active={false}
                    href={item.href}
                    key={item.href}
                    onNavigate={() => setMobileMenuOpen(false)}
                  >
                    {item.label}
                  </MobileMenuLink>
                ))}
              </div>
              <div className="mt-3 border-t border-border pt-3">
                <p className="px-2.5 pb-1.5 text-caption font-medium text-[var(--fg-tertiary)]">
                  Product
                </p>
                <div className="flex flex-col gap-0.5">
                  {PRODUCT_ITEMS.map((item) => (
                    <MobileMenuLink
                      active={false}
                      href={item.href}
                      key={item.href}
                      onNavigate={() => setMobileMenuOpen(false)}
                    >
                      {item.label}
                    </MobileMenuLink>
                  ))}
                </div>
              </div>
              <div className="mt-3 border-t border-border pt-3">
                <p className="px-2.5 pb-1.5 text-caption font-medium text-[var(--fg-tertiary)]">
                  Resources
                </p>
                <div className="flex flex-col gap-0.5">
                  {RESOURCE_ITEMS.map((item) => (
                    <MobileMenuLink
                      active={false}
                      href={item.href}
                      key={item.href}
                      onNavigate={() => setMobileMenuOpen(false)}
                    >
                      {item.label}
                    </MobileMenuLink>
                  ))}
                </div>
              </div>
              <div className="pt-4 pb-3">
                <Link
                  className="flex h-10 w-full items-center justify-center gap-1.5 rounded-full bg-primary text-ui font-medium text-primary-foreground transition-opacity hover:opacity-90"
                  href="/sign-in"
                  onClick={() => setMobileMenuOpen(false)}
                >
                  <span>Sign in</span>
                  <ArrowUpRightIcon aria-hidden="true" className="size-3.5 opacity-75" />
                </Link>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}

function NavDropdown({
  items,
  label,
  onClose,
  onMouseEnter,
  onMouseLeave,
  onToggle,
  open,
}: {
  items: readonly { href: string; label: string }[]
  label: string
  onClose: () => void
  onMouseEnter: () => void
  onMouseLeave: () => void
  onToggle: () => void
  open: boolean
}) {
  return (
    <div className="relative" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <Button
        aria-expanded={open}
        aria-haspopup="true"
        className={cn(
          'inline-flex h-8 items-center gap-1 rounded-lg border border-transparent px-3 text-ui font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          open
            ? 'bg-foreground/[0.05] text-foreground'
            : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground'
        )}
        onClick={onToggle}
        size={null}
        type="button"
        variant="custom"
      >
        <span>{label}</span>
        <CaretDownIcon
          aria-hidden="true"
          className={cn(
            'size-3 text-muted-foreground transition-transform duration-150',
            open ? 'rotate-180' : ''
          )}
        />
      </Button>
      {open ? (
        <div className="absolute top-full left-0 z-50 mt-1.5 min-w-[200px] rounded-xl border border-border bg-popover p-1 shadow-[var(--shadow-popover)]">
          {items.map((item) => (
            <Link
              className="flex items-center rounded-md px-2.5 py-1.5 text-ui text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
              href={item.href}
              key={item.href}
              onClick={onClose}
            >
              {item.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function MobileMenuLink({
  active,
  children,
  href,
  onNavigate,
}: {
  active: boolean
  children: string
  href: string
  onNavigate: () => void
}) {
  return (
    <Link
      className={cn(
        'flex items-center gap-2 rounded-lg border px-2.5 py-2 text-ui font-medium transition-colors',
        active
          ? 'border-border bg-card text-foreground shadow-[0_1px_2px_rgb(0_0_0_/_5%)]'
          : 'border-transparent text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground'
      )}
      href={href}
      onClick={onNavigate}
    >
      {children}
    </Link>
  )
}
