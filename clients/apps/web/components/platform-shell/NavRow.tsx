'use client'

import type { IconWeight } from '@phosphor-icons/react'
import type { ComponentType, ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { SidebarLink } from './SidebarLink'

export type NavIcon = ComponentType<{ className?: string; size?: number; weight?: IconWeight }>

/**
 * One sidebar row, shared by the main and settings navigation: the icon and
 * label, or in the compact rail the icon alone with its name in a tooltip.
 */
export function NavRow({
  active,
  badge,
  collapsed,
  href,
  icon: Icon,
  label,
  name = label,
  onNavigate,
  section = false,
  tourId,
}: {
  active: boolean
  /** Shown after the label in the expanded row, such as a plan badge. */
  badge?: ReactNode
  collapsed: boolean
  href: string
  icon: NavIcon
  label: string
  /** The accessible name when it says more than the label; it starts with the label. */
  name?: string
  onNavigate?: () => void
  /** Its pages are listed under it, so an active row marks the section and the page link is the current one. */
  section?: boolean
  /** Where a product tour step points (`data-tour-id`). */
  tourId?: string
}) {
  const link = (
    <SidebarLink
      data-platform-nav
      data-tour-id={tourId}
      aria-current={active ? (section ? 'true' : 'page') : undefined}
      aria-label={name}
      className={cn(
        'flex h-8 items-center gap-2.5 px-2.5',
        collapsed && 'mx-auto size-9 justify-center px-0'
      )}
      href={href}
      onClick={onNavigate}
    >
      <Icon
        aria-hidden="true"
        className="shrink-0"
        size={20}
        weight={active ? 'fill' : 'regular'}
      />
      {collapsed ? null : <span className="truncate">{label}</span>}
      {collapsed ? null : badge}
    </SidebarLink>
  )
  return collapsed ? (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{name}</TooltipContent>
    </Tooltip>
  ) : (
    link
  )
}
