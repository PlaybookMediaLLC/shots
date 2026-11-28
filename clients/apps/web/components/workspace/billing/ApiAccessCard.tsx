'use client'

import Link from 'next/link'
import { AutomateIcon } from '@/components/platform-shell/icons'
import { Pill } from '@/components/platform-ui'

/**
 * Surfaces REST API, CLI, and MCP access inclusion with direct links to the
 * workspace's AI agents and Developer API settings pages.
 */
export function ApiAccessCard({ included }: { included: boolean }) {
  return (
    <div className="flex flex-col gap-3 rounded-[14.4px] border border-border bg-[var(--platform-group,var(--card))] p-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <AutomateIcon className="shrink-0 text-muted-foreground" size={16} />
          <span>API Access</span>
        </div>
        <p className="mt-2 text-sm font-medium text-foreground">
          {included ? 'Included in your plan' : 'Available on paid plans'}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          REST API, CLI and MCP access come with your plan. Create keys on the{' '}
          <Link
            className="font-medium text-foreground underline underline-offset-4 hover:text-foreground/80"
            href="/settings/ai-agents"
          >
            AI agents
          </Link>{' '}
          or{' '}
          <Link
            className="font-medium text-foreground underline underline-offset-4 hover:text-foreground/80"
            href="/settings/developers"
          >
            Developer API
          </Link>{' '}
          page.
        </p>
      </div>
      <div className="shrink-0">
        <Pill tone={included ? 'green' : 'gray'}>
          {included ? 'Included' : 'Upgrade required'}
        </Pill>
      </div>
    </div>
  )
}
