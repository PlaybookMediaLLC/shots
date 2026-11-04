'use client'

import { useCallback, useEffect, useState } from 'react'
import { z } from 'zod'
import { recipientInvitationSchema, type RecipientInvitation } from 'screenshot-studio-backend-sdk'
import { Button } from '@/components/ui/button'
import { announceSessionChange, authClient } from '@/lib/auth/client'
import { roleLabels, roleSummaries } from '@/lib/auth/role-descriptions'
import { isSupportedOrganizationRole, normalizeOrganizationRole } from '@/lib/auth/permissions'
import { getAuthErrorMessage } from './error-message'

// Better Auth's browser client revives wire timestamps to Date objects.
const clientInvitation = recipientInvitationSchema.extend({
  createdAt: z.coerce.date().transform((date) => date.toISOString()),
  expiresAt: z.coerce.date().transform((date) => date.toISOString()),
})

const statusMessage = {
  accepted: 'This invitation has already been accepted.',
  rejected: 'This invitation has been declined.',
  canceled: 'This invitation has been revoked. Ask an administrator for a new invitation.',
  expired: 'This invitation has expired. Ask an administrator for a new invitation.',
}

/** Recipient-owned acceptance and decline, with explicit reconciliation after a lost response. */
export function AcceptInvitation({ invitationId }: { invitationId: string }) {
  const [invitation, setInvitation] = useState<RecipientInvitation | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)
  const [needsRefresh, setNeedsRefresh] = useState(false)

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      const result = await authClient.organization.getInvitation({ query: { id: invitationId } })
      if (result.error) throw new Error(result.error.message || 'Could not load this invitation.')
      const parsed = clientInvitation.safeParse(result.data)
      if (!parsed.success)
        throw new Error('Could not read this invitation. Refresh its status to try again.')
      setInvitation(parsed.data)
      setNeedsRefresh(false)
      setError(null)
    } catch (failure) {
      setError(getAuthErrorMessage(failure, 'Could not load this invitation.'))
    } finally {
      setBusy(false)
    }
  }, [invitationId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function respond(action: 'accept' | 'reject') {
    setBusy(true)
    setError(null)
    try {
      const result =
        action === 'accept'
          ? await authClient.organization.acceptInvitation({ invitationId })
          : await authClient.organization.rejectInvitation({ invitationId })
      if (result.error)
        throw new Error(result.error.message || 'The invitation result was not confirmed.')
      if (action === 'accept') {
        // Accepting makes the new workspace active for every tab.
        announceSessionChange()
        window.location.assign('/settings')
      } else await refresh()
    } catch (failure) {
      setError(getAuthErrorMessage(failure, 'The invitation result was not confirmed.'))
      setNeedsRefresh(true)
    } finally {
      setBusy(false)
    }
  }

  async function openWorkspace() {
    if (!invitation) return
    setBusy(true)
    try {
      const result = await authClient.organization.setActive({
        organizationId: invitation.organizationId,
      })
      if (result.error)
        throw new Error(result.error.message || 'You no longer have access to this workspace.')
      announceSessionChange()
      window.location.assign('/settings')
    } catch (failure) {
      setError(getAuthErrorMessage(failure, 'Could not open this workspace.'))
      setBusy(false)
    }
  }

  const role = invitation?.role
  const displayRole =
    role && isSupportedOrganizationRole(role) ? normalizeOrganizationRole(role) : null
  return (
    <div className="grid w-full gap-5 rounded-lg border border-foreground/10 bg-card p-6">
      <div>
        <h1 className="text-xl font-semibold">
          {invitation ? `Join ${invitation.organizationName}` : 'Workspace invitation'}
        </h1>
        {invitation ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Invited as {displayRole ? roleLabels[displayRole] : (role ?? 'a member')} for{' '}
            {invitation.email}.{displayRole ? ` ${roleSummaries[displayRole]}` : ''}
          </p>
        ) : busy ? (
          <p role="status">Loading invitation…</p>
        ) : null}
      </div>
      {error ? (
        <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {needsRefresh ? (
        <p className="text-sm text-muted-foreground">
          Refresh the invitation status to check the saved result before trying again.
        </p>
      ) : null}
      {invitation && invitation.status !== 'pending' ? (
        <p role="status">{statusMessage[invitation.status]}</p>
      ) : null}
      {invitation?.status === 'pending' ? (
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || needsRefresh} onClick={() => void respond('accept')}>
            Accept invitation
          </Button>
          <Button
            disabled={busy || needsRefresh}
            variant="outline"
            onClick={() => void respond('reject')}
          >
            Decline invitation
          </Button>
        </div>
      ) : null}
      {invitation?.status === 'accepted' ? (
        <Button disabled={busy} onClick={() => void openWorkspace()}>
          Open workspace
        </Button>
      ) : null}
      <Button variant="ghost" disabled={busy} onClick={() => void refresh()}>
        Refresh invitation status
      </Button>
    </div>
  )
}
