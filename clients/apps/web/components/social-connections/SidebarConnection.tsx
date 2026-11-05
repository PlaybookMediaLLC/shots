'use client'

import { PlusIcon as Plus } from '@phosphor-icons/react/dist/ssr/Plus'
import { authClient, useHydratedSession } from '@/lib/auth/client'
import { hasPermission } from '@/lib/auth/permissions'
import { Button } from '@/components/ui/button'
import { ConnectionLauncher } from './ConnectionLauncher'

/** Match the member to the hydrated session before showing a workspace management action. */
export function SidebarConnection({ collapsed }: { collapsed: boolean }) {
  const session = useHydratedSession()
  const member = authClient.useActiveMember()
  if (
    session.isPending ||
    member.isPending ||
    member.error ||
    !member.data ||
    member.data.userId !== session.data?.user.id ||
    member.data.organizationId !== session.data?.session.activeOrganizationId ||
    !hasPermission(member.data.role, 'workspace:update')
  )
    return null
  return (
    <ConnectionLauncher intent={{ operation: 'CREATE_SET', creationVisibility: 'PRIVATE' }}>
      <Button
        aria-label="Add profile"
        title="Add profile"
        variant="ghost"
        size={collapsed ? 'icon' : 'sm'}
        className={
          collapsed
            ? 'size-8 text-muted-foreground'
            : 'h-8 justify-start px-2 text-muted-foreground'
        }
      >
        <Plus className="size-4 shrink-0" aria-hidden />
        {collapsed ? null : 'Add profile'}
      </Button>
    </ConnectionLauncher>
  )
}
