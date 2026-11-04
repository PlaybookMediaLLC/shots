'use client'

import { usePathname, useSearchParams } from 'next/navigation'
import { Suspense, type ComponentProps } from 'react'
import { CaretDownIcon as ArrowDown01Icon } from '@phosphor-icons/react/dist/ssr/CaretDown'
import { ImageIcon as Image02Icon } from '@phosphor-icons/react/dist/ssr/Image'
import { PaletteIcon as PaintBoardIcon } from '@phosphor-icons/react/dist/ssr/Palette'
import { DeviceMobileIcon as SmartPhone01Icon } from '@phosphor-icons/react/dist/ssr/DeviceMobile'
import { Collapsible } from 'radix-ui'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { surface } from './shell-config'
import { cn } from '@/lib/utils'
import { SidebarLink } from './SidebarLink'

type EditorSection = 'image' | 'app-store'

/** Change editor sections without replacing either editor's mounted session. */
export function EditorSectionLink({
  section,
  ...props
}: Omit<ComponentProps<typeof SidebarLink>, 'href'> & { section: EditorSection }) {
  return (
    <SidebarLink
      {...props}
      data-keep-selection
      href={section === 'app-store' ? '/?editor=app-store' : '/'}
      onNavigate={(event) => {
        const url = new URL(window.location.href)
        if ((url.pathname.replace(/^\/[a-z]{2}(?:-[A-Z]{2})?(?=\/|$)/, '') || '/') !== '/') return
        event.preventDefault()
        if (section === 'app-store') url.searchParams.set('editor', section)
        else url.searchParams.delete('editor')
        window.history.pushState(null, '', url)
      }}
    />
  )
}

function EditorNavigationContent({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean
  onNavigate?: () => void
}) {
  const pathname = usePathname().replace(/^\/[a-z]{2}(?:-[A-Z]{2})?(?=\/|$)/, '') || '/'
  const search = useSearchParams()
  const active =
    pathname === '/' ? (search.get('editor') === 'app-store' ? 'app-store' : 'image') : null
  const sections = [
    { id: 'image', label: 'Screenshot editor', icon: Image02Icon },
    { id: 'app-store', label: 'App Store Screenshots', icon: SmartPhone01Icon },
  ] as const
  const trigger = (
    <Collapsible.Trigger asChild>
      <Button
        variant="custom"
        size={null}
        type="button"
        aria-label="Editor"
        data-keep-selection
        className={cn(
          'group flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-lg border px-2 text-ui-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          active
            ? cn(surface.panel, surface.border, 'text-foreground shadow-xs')
            : 'border-transparent text-muted-foreground hover:text-foreground',
          collapsed && 'size-8 justify-center px-0'
        )}
      >
        <PaintBoardIcon className="shrink-0" size={16} />
        {collapsed ? null : (
          <>
            <span className="truncate">Editor</span>
            <ArrowDown01Icon
              size={14}
              className="ml-auto shrink-0 transition-transform group-data-[state=closed]:-rotate-90"
            />
          </>
        )}
      </Button>
    </Collapsible.Trigger>
  )
  return (
    <Collapsible.Root defaultOpen key={pathname}>
      {collapsed ? (
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent side="right">Editor</TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}
      <Collapsible.Content>
        <nav
          aria-label="Editor sections"
          className={
            collapsed
              ? 'mt-1 grid gap-0.5 border-y border-foreground/[0.06] py-1'
              : 'my-1.5 ml-[17px] flex flex-col gap-0.5 border-l border-foreground/[0.08] pl-3'
          }
        >
          {sections.map(({ id, label, icon: Icon }) => {
            const link = (
              <EditorSectionLink
                section={id}
                aria-label={collapsed ? label : undefined}
                aria-current={active === id ? 'page' : undefined}
                onClick={onNavigate}
                className={cn(
                  'rounded-md text-ui-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  collapsed
                    ? cn(
                        'grid size-8 place-items-center rounded-lg border',
                        active === id
                          ? cn(surface.panel, surface.border, 'text-foreground shadow-xs')
                          : 'border-transparent text-muted-foreground hover:text-foreground'
                      )
                    : cn(
                        'block py-1',
                        active === id
                          ? 'text-foreground'
                          : 'text-muted-foreground hover:text-foreground'
                      )
                )}
              >
                {collapsed ? <Icon className="shrink-0" size={14} /> : label}
              </EditorSectionLink>
            )
            return collapsed ? (
              <Tooltip key={id}>
                <TooltipTrigger asChild>{link}</TooltipTrigger>
                <TooltipContent side="right">{label}</TooltipContent>
              </Tooltip>
            ) : (
              <div key={id}>{link}</div>
            )
          })}
        </nav>
      </Collapsible.Content>
    </Collapsible.Root>
  )
}

/** Shared editor navigation for the workspace rail and mobile drawer. */
export function EditorNavigation(props: { collapsed: boolean; onNavigate?: () => void }) {
  return (
    <Suspense
      fallback={
        <SidebarLink href="/" aria-label="Editor">
          <PaintBoardIcon size={16} />
        </SidebarLink>
      }
    >
      <EditorNavigationContent {...props} />
    </Suspense>
  )
}
