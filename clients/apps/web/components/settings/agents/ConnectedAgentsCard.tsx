'use client'

import { CalendarBlank, CaretDown, CaretRight, Robot } from '@phosphor-icons/react'
import { Fragment, useState } from 'react'
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
import { AgentBrandIcon } from './AgentIcons'
import { ScopeBadge } from './ScopeBadge'
import {
  type ConnectedAgentGroup,
  formatCredentialTimestamp,
} from './scope-summary'

type RevokeTarget =
  | { kind: 'session'; clientName: string; keyId: string }
  | { kind: 'group'; group: ConnectedAgentGroup }

/**
 * Connected agents card: OAuth-authorized AI agents grouped by client with
 * multi-session expansion, honest scope badges, last-active timestamps, and
 * immediate single-session or grouped bulk revocation.
 */
export function ConnectedAgentsCard({
  groups,
  isLoading = false,
  onRevokeGroup,
  onRevokeSession,
  pendingId,
}: {
  groups: readonly ConnectedAgentGroup[]
  isLoading?: boolean
  onRevokeGroup: (group: ConnectedAgentGroup) => Promise<string | null>
  onRevokeSession: (keyId: string) => Promise<string | null>
  pendingId: string | null
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [confirmTarget, setConfirmTarget] = useState<RevokeTarget | null>(null)

  function toggleGroup(groupKey: string): void {
    setExpanded((current) => ({ ...current, [groupKey]: !current[groupKey] }))
  }

  return (
    <Section
      description="Apps that signed in with your workspace over OAuth. No API key involved. Revoking signs the app out immediately; reconnect any time from the app."
      title="Connected agents"
    >
      <Group>
        <div className="flex items-center gap-2 px-5 pt-4 pb-2 text-xs font-medium text-muted-foreground">
          <Robot aria-hidden="true" className="size-4 text-foreground/70" />
          <span>OAuth connections</span>
        </div>
        {isLoading ? (
          <div className="px-5 py-6 text-sm text-muted-foreground">Loading connected agents…</div>
        ) : groups.length === 0 ? (
          <div className="px-5 py-6 text-sm text-muted-foreground">
            No AI agents have signed in with OAuth yet. Pick a client below to connect one.
          </div>
        ) : (
          <TooltipProvider>
            <div className="overflow-x-auto">
              <Table className="w-full min-w-[38rem] text-left">
                <TableCaption className="sr-only">Connected OAuth AI agents</TableCaption>
                <TableHeader>
                  <TableRow className="border-t border-border/70">
                    <TableHead className="pl-5 text-xs font-medium text-muted-foreground" scope="col">
                      Agent
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground" scope="col">
                      Access
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground" scope="col">
                      Last connected
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
                  {groups.map((group) => {
                    const isMulti = group.sessions.length > 1
                    const isOpen = Boolean(expanded[group.groupKey])
                    const singleSession = group.sessions[0]!
                    const busy =
                      pendingId === group.groupKey ||
                      group.sessions.some((session) => pendingId === session.id)

                    return (
                      <Fragment key={group.groupKey}>
                        <TableRow className="border-t border-border/70">
                          <TableCell className="py-3.5 pl-5">
                            <div className="flex items-center gap-2">
                              {isMulti ? (
                                <Button
                                  aria-expanded={isOpen}
                                  aria-label={`Toggle ${group.sessions.length} sessions for ${group.clientName}`}
                                  className="size-6 rounded-md p-0 text-muted-foreground hover:text-foreground"
                                  onClick={() => toggleGroup(group.groupKey)}
                                  size="sm"
                                  type="button"
                                  variant="ghost"
                                >
                                  {isOpen ? (
                                    <CaretDown aria-hidden="true" className="size-3.5" />
                                  ) : (
                                    <CaretRight aria-hidden="true" className="size-3.5" />
                                  )}
                                </Button>
                              ) : (
                                <span aria-hidden="true" className="inline-block w-6 shrink-0" />
                              )}
                              <AgentBrandIcon icon={group.icon} size={16} />
                              <span className="truncate text-sm font-medium text-foreground">
                                {group.clientName}
                              </span>
                              <Pill tone="gray">OAuth</Pill>
                              {isMulti ? (
                                <Pill tone="blue">{group.sessions.length} sessions</Pill>
                              ) : null}
                            </div>
                          </TableCell>
                          <TableCell className="py-3.5">
                            <ScopeBadge scopes={group.scopes} />
                          </TableCell>
                          <TableCell className="py-3.5 text-xs text-muted-foreground">
                            <span className="inline-flex items-center gap-1.5">
                              <CalendarBlank aria-hidden="true" className="size-3.5 opacity-70" />
                              {formatCredentialTimestamp(group.lastActivityAt)}
                            </span>
                          </TableCell>
                          <TableCell className="py-3.5 pr-5 text-right">
                            <Button
                              aria-label={
                                isMulti
                                  ? `Revoke all ${group.sessions.length} sessions for ${group.clientName}`
                                  : `Revoke ${group.clientName} session`
                              }
                              className="text-red-700 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                              disabled={busy}
                              onClick={() =>
                                setConfirmTarget(
                                  isMulti
                                    ? { group, kind: 'group' }
                                    : {
                                        clientName: group.clientName,
                                        keyId: singleSession.id,
                                        kind: 'session',
                                      }
                                )
                              }
                              size="sm"
                              type="button"
                              variant="ghost"
                            >
                              {isMulti ? 'Revoke all' : 'Revoke'}
                            </Button>
                          </TableCell>
                        </TableRow>

                        {isMulti && isOpen
                          ? group.sessions.map((session) => (
                              <TableRow
                                className="border-t border-border/50 bg-foreground/[0.02]"
                                key={session.id}
                              >
                                <TableCell className="py-2.5 pl-14">
                                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                    <span>session</span>
                                    {session.start ? (
                                      <span className="font-mono text-[11px] opacity-80">
                                        {session.start}…
                                      </span>
                                    ) : null}
                                    {session.expiresAt ? (
                                      <Pill tone="gray">
                                        Expires {new Date(session.expiresAt).toLocaleDateString()}
                                      </Pill>
                                    ) : null}
                                  </div>
                                </TableCell>
                                <TableCell className="py-2.5">
                                  <ScopeBadge scopes={session.scopes} />
                                </TableCell>
                                <TableCell className="py-2.5 text-xs text-muted-foreground">
                                  <span className="inline-flex items-center gap-1.5">
                                    <CalendarBlank aria-hidden="true" className="size-3.5 opacity-70" />
                                    {formatCredentialTimestamp(
                                      session.lastRequest ?? session.createdAt
                                    )}
                                  </span>
                                </TableCell>
                                <TableCell className="py-2.5 pr-5 text-right">
                                  <Button
                                    aria-label={`Revoke ${group.clientName} session ${session.start ?? session.id}`}
                                    className="text-red-700 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                                    disabled={pendingId === session.id || pendingId === group.groupKey}
                                    onClick={() =>
                                      setConfirmTarget({
                                        clientName: group.clientName,
                                        keyId: session.id,
                                        kind: 'session',
                                      })
                                    }
                                    size="sm"
                                    type="button"
                                    variant="ghost"
                                  >
                                    Revoke
                                  </Button>
                                </TableCell>
                              </TableRow>
                            ))
                          : null}
                      </Fragment>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          </TooltipProvider>
        )}
      </Group>

      <ConfirmDialog
        confirmLabel={confirmTarget?.kind === 'group' ? 'Revoke all sessions' : 'Revoke session'}
        description={
          confirmTarget?.kind === 'group'
            ? `Every active OAuth session (${confirmTarget.group.sessions.length}) for ${confirmTarget.group.clientName} will stop working immediately. Reconnect any time from the app.`
            : `This OAuth session for ${confirmTarget?.clientName ?? 'this agent'} will stop working on its next call.`
        }
        destructive
        onConfirm={async () => {
          if (!confirmTarget) return null
          return confirmTarget.kind === 'group'
            ? onRevokeGroup(confirmTarget.group)
            : onRevokeSession(confirmTarget.keyId)
        }}
        onOpenChange={(open) => {
          if (!open) setConfirmTarget(null)
        }}
        open={confirmTarget !== null}
        title={
          confirmTarget?.kind === 'group'
            ? `Revoke all ${confirmTarget.group.clientName} sessions?`
            : `Revoke ${confirmTarget?.clientName ?? 'agent'} session?`
        }
      />
    </Section>
  )
}
