'use client'

import { useQuery } from '@tanstack/react-query'
import { recentWorkQuery } from '@/components/platform-hub/work'
import { useHydratedSession } from '@/lib/auth/client'
import { useTRPCClient } from '@/lib/trpc/react'
import { CanvasIcon, ImageIcon } from './icons'
import { SidebarLink } from './SidebarLink'

/**
 * The sidebar's Recents, as a document hub keeps them: the workspace's last
 * few screenshots and canvases, a click from any page. It reads Home's
 * recent-work query, so the two share one cached read. Posts stay in
 * Publish. Shown only when expanded and when there is something to show.
 */
export function SidebarRecents({
  campaignsEnabled,
  draftsEnabled,
  onNavigate,
  paidPlan,
}: {
  campaignsEnabled: boolean
  draftsEnabled: boolean
  onNavigate?: () => void
  paidPlan: boolean
}) {
  const client = useTRPCClient()
  const workspaceId = useHydratedSession().data?.session.activeOrganizationId ?? ''
  const query = useQuery({
    ...recentWorkQuery(client, workspaceId, draftsEnabled, paidPlan, campaignsEnabled),
    enabled: Boolean(workspaceId) && paidPlan,
  })
  const items = (query.data?.items ?? [])
    .filter((item) => item.type === 'Screenshot' || item.type === 'Canvas')
    .slice(0, 5)
  if (!items.length) return null
  return (
    <section aria-labelledby="sidebar-recents" className="grid gap-0.5">
      <h2
        id="sidebar-recents"
        className="px-2.5 pt-2 pb-1.5 text-[0.78125rem] text-muted-foreground"
      >
        Recents
      </h2>
      <ul className="grid gap-0.5">
        {items.map((item) => {
          const Icon = item.type === 'Canvas' ? CanvasIcon : ImageIcon
          return (
            <li key={`${item.type}-${item.id}`}>
              <SidebarLink
                href={item.href}
                onClick={onNavigate}
                title={`${item.title} · ${item.type}`}
                className="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[0.84375rem] text-foreground/85 transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
              >
                <Icon size={15} aria-hidden="true" className="shrink-0 text-muted-foreground" />
                <span className="truncate">{item.title}</span>
              </SidebarLink>
            </li>
          )
        })}
      </ul>
      <SidebarLink
        href="/library"
        onClick={onNavigate}
        className="px-2.5 pt-2 text-[0.78125rem] text-muted-foreground hover:text-foreground"
      >
        Show more
      </SidebarLink>
    </section>
  )
}
