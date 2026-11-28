'use client'

import { CalendarBlank, Copy, Key, Trash } from '@phosphor-icons/react'
import { useState } from 'react'
import { Group, Pill, Section } from '@/components/platform-ui'
import { ConfirmDialog } from '@/components/settings/ConfirmDialog'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { TooltipProvider } from '@/components/ui/tooltip'
import { copyToClipboard, ScopeBadge } from './ScopeBadge'
import { formatCredentialTimestamp, type WorkspaceCredential } from './scope-summary'

function keyStatus(key: WorkspaceCredential): { label: string; tone: 'gray' | 'green' | 'yellow' } {
  if (!key.enabled) return { label: 'disabled', tone: 'gray' }
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now()) {
    return { label: 'expired', tone: 'yellow' }
  }
  return { label: 'active', tone: 'green' }
}

/**
 * REST and CLI API keys table (strictly excluding OAuth-connected agents,
 * which live in ConnectedAgentsCard above).
 */
export function ApiKeysCard({
  isLoading = false,
  keys,
  newKey,
  onCreateClick,
  onDismissNewKey,
  onRevoke,
  pendingId,
}: {
  isLoading?: boolean
  keys: readonly WorkspaceCredential[]
  newKey: string | null
  onCreateClick: () => void
  onDismissNewKey: () => void
  onRevoke: (keyId: string) => Promise<string | null>
  pendingId: string | null
}) {
  const [revokeTarget, setRevokeTarget] = useState<WorkspaceCredential | null>(null)

  return (
    <Section
      description="API keys are for the REST API, CLI, and clients without OAuth. Keys are shown once when created."
      title="API keys"
    >
      {newKey ? (
        <div
          className="flex flex-col gap-3 rounded-2xl bg-emerald-500/5 p-5 ring-1 ring-emerald-500/25"
          role="status"
        >
          <p className="text-sm font-medium text-foreground">
            Copy this key now. It cannot be shown again; API-key snippets below include it until
            you leave this page.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-foreground/[0.06] px-3 py-2 font-mono text-xs text-foreground">
              {newKey}
            </code>
            <Button
              onClick={() => copyToClipboard(newKey, 'API key')}
              size="sm"
              type="button"
            >
              <Copy aria-hidden="true" className="mr-1.5 size-3.5" />
              Copy key
            </Button>
            <Button onClick={onDismissNewKey} size="sm" type="button" variant="ghost">
              Done
            </Button>
          </div>
        </div>
      ) : null}

      <Group>
        {isLoading ? (
          <div className="px-5 py-6 text-sm text-muted-foreground">Loading API keys…</div>
        ) : keys.length === 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-6">
            <p className="text-sm text-muted-foreground">
              No API keys yet. Create one when connecting the REST API, CLI, or Muse.
            </p>
            <Button onClick={onCreateClick} size="sm" type="button" variant="outline">
              Create API key
            </Button>
          </div>
        ) : (
          <TooltipProvider>
            <div className="overflow-x-auto">
              <Table className="w-full min-w-[40rem] text-left">
                <TableCaption className="sr-only">Workspace REST and CLI API keys</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5 text-xs font-medium text-muted-foreground" scope="col">
                      Name
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground" scope="col">
                      Key
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground" scope="col">
                      Access
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground" scope="col">
                      Created
                    </TableHead>
                    <TableHead
                      className="pr-5 text-right text-xs font-medium text-muted-foreground"
                      scope="col"
                    >
                      Actions
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {keys.map((key) => {
                    const status = keyStatus(key)
                    const masked = `${key.start ?? key.prefix ?? 'ss_'}****`
                    return (
                      <TableRow className="border-t border-border/70" key={key.id}>
                        <TableCell className="py-3.5 pl-5">
                          <div className="flex items-center gap-2">
                            <Key
                              aria-hidden="true"
                              className="size-3.5 shrink-0 text-muted-foreground"
                            />
                            <span className="truncate text-sm font-medium text-foreground">
                              {key.name ?? 'Untitled key'}
                            </span>
                            {status.label !== 'active' ? (
                              <Pill tone={status.tone}>{status.label}</Pill>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className="py-3.5">
                          <code className="rounded-md bg-foreground/[0.06] px-2 py-1 font-mono text-xs text-foreground/85">
                            {masked}
                          </code>
                        </TableCell>
                        <TableCell className="py-3.5">
                          <ScopeBadge scopes={key.scopes} />
                        </TableCell>
                        <TableCell className="py-3.5 text-xs text-muted-foreground">
                          <span className="inline-flex items-center gap-1.5">
                            <CalendarBlank aria-hidden="true" className="size-3.5 opacity-70" />
                            {formatCredentialTimestamp(key.createdAt)}
                          </span>
                        </TableCell>
                        <TableCell className="py-3.5 pr-5 text-right">
                          <Button
                            aria-label={`Revoke ${key.name ?? 'API key'}`}
                            className="text-red-700 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                            disabled={pendingId === key.id}
                            onClick={() => setRevokeTarget(key)}
                            size="sm"
                            type="button"
                            variant="ghost"
                          >
                            <Trash aria-hidden="true" className="size-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          </TooltipProvider>
        )}
      </Group>

      <ConfirmDialog
        confirmLabel="Revoke key"
        description="Anything using this API key stops working at once. This cannot be undone; create a new key to replace it."
        destructive
        onConfirm={async () => {
          if (!revokeTarget) return null
          return onRevoke(revokeTarget.id)
        }}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null)
        }}
        open={revokeTarget !== null}
        title={`Revoke ${revokeTarget?.name ?? 'this API key'}?`}
      />
    </Section>
  )
}
