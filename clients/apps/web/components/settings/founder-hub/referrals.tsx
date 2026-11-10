'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { settingsRequest, settingsErrorMessage } from '@/lib/settings/client'
import {
  getFounderHubReferralsContract,
  claimFounderHubReferralContract,
} from '@/lib/api/contracts/founder-hub'
import { useFounderHubUserId } from './settings-context'
import { SettingsPageTitle } from './page-title'

export function SettingsReferrals() {
  const userId = useFounderHubUserId()
  const client = useQueryClient()
  const [claimResult, setClaimResult] = useState<boolean>()
  const summary = useQuery({
    queryKey: ['founder-hub-referrals', userId],
    queryFn: ({ signal }) =>
      settingsRequest(getFounderHubReferralsContract.path, getFounderHubReferralsContract.output, {
        signal,
      }),
  })
  const claim = useMutation({
    mutationFn: (code: string) =>
      settingsRequest(
        claimFounderHubReferralContract.path,
        claimFounderHubReferralContract.output,
        { method: 'POST', body: { code } }
      ),
    onSuccess: async (result) => {
      setClaimResult(result.claimed)
      await client.invalidateQueries({ queryKey: ['founder-hub-referrals', userId] })
    },
  })
  const [copyError, setCopyError] = useState<string>()
  const copy = async () => {
    if (!summary.data?.code) return
    try {
      await navigator.clipboard.writeText(summary.data.code)
      setCopyError(undefined)
    } catch {
      setCopyError('Could not copy the referral code. Select and copy it manually.')
    }
  }
  return (
    <div className="flex flex-col gap-6">
      <SettingsPageTitle title="Referrals" />
      {summary.isPending ? (
        <p role="status">Loading referral details…</p>
      ) : summary.error ? (
        <p role="alert">{settingsErrorMessage(summary.error)}</p>
      ) : (
        <>
          {summary.data?.enabled ? (
            <>
              <p className="text-sm text-muted-foreground">
                Invite friends and track referral rewards for your Shots account.
              </p>
              {summary.data.code && (
                <div className="flex gap-2">
                  <Input readOnly aria-label="Your referral code" value={summary.data.code} />
                  <Button type="button" variant="outline" onClick={() => void copy()}>
                    Copy code
                  </Button>
                </div>
              )}
              {copyError && (
                <p role="alert" className="text-sm text-destructive">
                  {copyError}
                </p>
              )}
              <p className="text-sm">
                {summary.data.accepted} accepted · {summary.data.remaining} invitations remaining ·{' '}
                {summary.data.months_earned} months earned
              </p>
              <ul className="flex flex-col gap-2 text-sm">
                {summary.data.invites.map((invite) => (
                  <li key={invite.id} className="rounded-md border p-3">
                    Invitation {invite.slot}: {invite.status}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Referral claims are checked by Shots. Enter a code to see whether it can be claimed.
            </p>
          )}
          <ReferralClaim
            onClaim={(code) => {
              setClaimResult(undefined)
              claim.mutate(code)
            }}
            pending={claim.isPending}
            error={claim.error ? settingsErrorMessage(claim.error) : undefined}
            result={claimResult}
          />
        </>
      )}
    </div>
  )
}

function ReferralClaim({
  onClaim,
  pending,
  error,
  result,
}: {
  onClaim: (code: string) => void
  pending: boolean
  error?: string
  result?: boolean
}) {
  const [code, setCode] = useState('')
  return (
    <div className="flex max-w-lg flex-col gap-2">
      <Label htmlFor="referral-claim-code" className="text-sm font-medium">
        Claim a referral code
      </Label>
      <div className="flex gap-2">
        <Input
          id="referral-claim-code"
          value={code}
          onChange={(event) => {
            setCode(event.target.value)
          }}
          placeholder="24 character code"
        />
        <Button
          type="button"
          disabled={pending || !/^[a-f0-9]{24}$/.test(code)}
          onClick={() => onClaim(code)}
        >
          Claim
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {result === true && (
        <p role="status" className="text-sm">
          Referral code claimed.
        </p>
      )}
      {result === false && (
        <p role="alert" className="text-sm text-destructive">
          This referral code cannot be claimed by this account.
        </p>
      )}
    </div>
  )
}
