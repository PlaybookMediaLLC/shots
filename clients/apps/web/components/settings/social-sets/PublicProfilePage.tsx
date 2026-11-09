'use client'

import { useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { toast } from 'sonner'
import { ChannelIcon } from '@/components/drafts/channel-meta'
import { Group, Row } from '@/components/platform-ui'
import { SaveStatus, useSaveState } from '@/components/settings/controls'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { channelForPlatform } from '@/lib/content-drafts/serialize'
import { type SocialSetRecord, useSaveSocialSet } from './api'

/**
 * A set's public profile (RFC 024). Off by default; when on, its page shows
 * the set's name, colour and its accounts' public names and handles. Drafts,
 * members and credentials are never on it, and turning it off takes the page
 * down on the next request.
 */
export function PublicProfilePage({
  canManage,
  set,
}: {
  canManage: boolean
  set: SocialSetRecord
}) {
  const save = useSaveSocialSet(set.id)
  const [state, run] = useSaveState()
  const [copyError, setCopyError] = useState(false)
  const addressRef = useRef<HTMLInputElement>(null)
  const url =
    typeof window === 'undefined'
      ? `/p/${set.publicSlug}`
      : `${window.location.origin}/p/${set.publicSlug}`
  const accounts = set.accounts.filter((account) => account.health !== 'removed')
  return (
    <div className="grid gap-6">
      <Group>
        <Row
          description="Every profile has its own public page. Making it public shows only the identity below; your drafts stay private."
          label="Make profile public"
        >
          <div className="flex items-center gap-3">
            <SaveStatus state={state} />
            <Switch
              aria-label="Make profile public"
              checked={set.publicProfile}
              disabled={!canManage}
              onCheckedChange={(publicProfile) => void run(() => save({ publicProfile }))}
            />
          </div>
        </Row>
        {set.publicProfile ? (
          <Row description="Anyone with this address can see the profile." label="Public address">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label="Public profile address"
                readOnly
                value={url}
                ref={addressRef}
                onFocus={(event) => event.target.select()}
              />
              <Button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(url)
                    setCopyError(false)
                    toast.success('Address copied.')
                  } catch {
                    setCopyError(true)
                    addressRef.current?.focus()
                    addressRef.current?.select()
                  }
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                Copy
              </Button>
              {copyError ? (
                <p className="text-xs text-destructive" role="alert">
                  Clipboard access failed. Select the address and copy it manually.
                </p>
              ) : null}
              <Button asChild size="sm" variant="outline">
                <a href={url} rel="noreferrer" target="_blank">
                  Open
                </a>
              </Button>
            </div>
          </Row>
        ) : null}
      </Group>
      <section
        aria-label="Public profile preview"
        className="grid gap-3 rounded-2xl border border-border p-5"
      >
        <p className="text-xs font-medium text-muted-foreground">
          Preview{set.publicProfile ? '' : ' (not public)'}
        </p>
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="size-10 rounded-full"
            style={{ backgroundColor: set.color }}
          />
          <p className="text-lg font-medium text-foreground">{set.name}</p>
        </div>
        {accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No accounts to show yet.</p>
        ) : (
          <ul className="grid gap-2">
            {accounts.map((account) => {
              const channel = channelForPlatform(account.platform)
              return (
                <li className="flex items-center gap-2 text-sm" key={account.id}>
                  {channel ? <ChannelIcon channel={channel} className="size-4" /> : null}
                  <span className="text-foreground">{account.displayName ?? account.platform}</span>
                  {account.handle ? (
                    <span className="text-muted-foreground">@{account.handle}</span>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
