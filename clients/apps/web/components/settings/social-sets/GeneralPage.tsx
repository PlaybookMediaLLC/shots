'use client'

import Link from 'next/link'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { ChannelIcon } from '@/components/drafts/channel-meta'
import { Group, Pill, Row } from '@/components/platform-ui'
import { ConfirmDialog } from '@/components/settings/ConfirmDialog'
import { SaveStatus, useSaveState } from '@/components/settings/controls'
import { useUnsavedSettings } from '@/components/settings/useUnsavedSettings'
import { DeveloperId } from '@/components/settings/DeveloperId'
import {
  settingsHref,
  SETTINGS_SECTIONS,
  socialSetHref,
} from '@/components/workspace/settings-sections'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { socialSetRemovalSchema, socialSetSchema } from '@/lib/api/contracts/social-sets'
import { channelForPlatform } from '@/lib/content-drafts/serialize'
import { settingsErrorMessage } from '@/lib/settings/client'
import { socialSetKey, useSocialSetScope } from './scope'
import {
  hasDefaultProfileName,
  HEALTH_GUIDANCE,
  providerFor,
  type SocialSetRecord,
  useSaveSocialSet,
  useSocialSets,
  useStoreSocialSet,
} from './api'
import { SET_COLORS } from './colors'
import { ConnectionLauncher } from '@/components/social-connections/ConnectionLauncher'
import { socialConnectionProviderSchema } from 'screenshot-studio-backend-sdk'
import type { SetPermissions } from './SocialSetSettings'
import { MoveToWorkspace } from './MoveToWorkspace'

function NameAndColor({ canManage, set }: { canManage: boolean; set: SocialSetRecord }) {
  const save = useSaveSocialSet(set.id)
  const [name, setName] = useState(set.name)
  const [nameState, runName] = useSaveState()
  const [colorState, runColor] = useSaveState()
  const previousValue = useRef(JSON.stringify(set.name))
  useEffect(() => {
    const previous = previousValue.current
    previousValue.current = JSON.stringify(set.name)
    setName((current) => (JSON.stringify(current) === previous ? set.name : current))
  }, [set.name])
  const trimmed = name.trim()
  const dirty = name !== set.name
  useUnsavedSettings(dirty)
  // A new profile lands here from its first connection, so this is where it gets asked for a name.
  const unnamed = canManage && hasDefaultProfileName(set.name)
  return (
    <>
      {unnamed ? (
        <Alert className="border-0 rounded-none">
          <AlertTitle>Name this profile</AlertTitle>
          <AlertDescription>
            “{set.name}” is a placeholder. Use the person or company this profile posts as,
            so your team can tell it apart.
          </AlertDescription>
        </Alert>
      ) : null}
      <Row
        description="Choose a name that helps your team recognize this profile."
        label="Name"
      >
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (!dirty || !trimmed) return
            void runName(() => save({ name: trimmed })).then((saved) => {
              if (saved) setName(trimmed)
            })
          }}
        >
          <Input
            aria-label="Profile name"
            autoFocus={unnamed}
            className="w-64"
            disabled={!canManage || nameState === 'saving'}
            maxLength={80}
            // The name saves when you leave the field or press Enter, like the colour below.
            onBlur={(event) => event.currentTarget.form?.requestSubmit()}
            onChange={(event) => setName(event.target.value)}
            onFocus={(event) => {
              if (unnamed) event.currentTarget.select()
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setName(set.name)
            }}
            value={name}
          />
          <SaveStatus state={nameState} />
        </form>
      </Row>
      <Row label="Colour">
        <div className="flex flex-wrap items-center gap-2">
          <RadioGroup
            aria-label="Profile colour"
            className="flex flex-wrap items-center gap-2"
            disabled={!canManage}
            name={`color-${set.id}`}
            onValueChange={(color) => void runColor(() => save({ color }))}
            value={set.color}
          >
            {SET_COLORS.map((option) => (
              <RadioGroupItem
                aria-label={option.label}
                className="size-6 cursor-pointer border-0 shadow-none ring-2 ring-transparent ring-offset-2 ring-offset-background focus-visible:ring-2 focus-visible:ring-ring data-[state=checked]:ring-foreground [&_svg]:hidden"
                key={option.value}
                style={{ backgroundColor: option.value }}
                title={option.label}
                value={option.value}
              />
            ))}
          </RadioGroup>
          <SaveStatus state={colorState} />
        </div>
      </Row>
    </>
  )
}

function Accounts({ canManage, set }: { canManage: boolean; set: SocialSetRecord }) {
  return (
    <Row
      description="One account per platform. Drafts in this profile publish to these accounts."
      label={<span id="accounts">Connected accounts</span>}
      layout="stacked"
    >
      {set.accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No accounts yet. Connect one below.</p>
      ) : null}
      <ul className="grid gap-2">
        {set.accounts.map((account) => {
          const channel = channelForPlatform(account.platform)
          const provider = socialConnectionProviderSchema.safeParse(providerFor(account.platform))
          const healthy = account.health === 'connected'
          const name = account.displayName ?? account.handle ?? account.platform
          return (
            <li
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
              key={account.id}
            >
              <span className="flex min-w-0 items-center gap-2">
                {channel ? (
                  <ChannelIcon channel={channel} className="size-4 text-foreground/80" />
                ) : null}
                <span className="min-w-0">
                  <span className="block truncate text-ui-lg font-medium text-foreground">
                    {name}
                    {account.handle ? (
                      <span className="font-normal text-muted-foreground"> @{account.handle}</span>
                    ) : null}
                  </span>
                  <span
                    className={
                      healthy
                        ? 'text-xs text-muted-foreground'
                        : 'text-xs text-amber-700 dark:text-amber-300'
                    }
                  >
                    {HEALTH_GUIDANCE[account.health]}
                  </span>
                </span>
                <Pill tone={healthy ? 'green' : 'yellow'}>
                  {account.health.replaceAll('_', ' ')}
                </Pill>
                <DeveloperId id={account.id} label="Account" />
              </span>
              {canManage ? (
                <span className="flex flex-wrap gap-2">
                  <MoveAccount account={account} set={set} />
                  {provider.success ? (
                    <ConnectionLauncher
                      intent={{
                        operation: 'RECONNECT',
                        socialSetId: set.id,
                        expectedConnectionId: account.id,
                        returnPath: socialSetHref(set.id),
                      }}
                      initialProvider={provider.data}
                      target={set}
                    >
                      <Button size="sm" variant="outline">
                        Reconnect
                      </Button>
                    </ConnectionLauncher>
                  ) : null}
                </span>
              ) : null}
            </li>
          )
        })}
      </ul>
      {canManage ? (
        <div className="grid gap-2">
          <p className="text-xs text-muted-foreground">
            Add a social account. You sign in with the platform, then come back here.
          </p>
          <ConnectionLauncher
            intent={{
              operation: 'ADD_ACCOUNT',
              socialSetId: set.id,
              returnPath: socialSetHref(set.id),
            }}
            target={set}
          >
            <Button className="w-fit" size="sm" variant="outline">
              Add social account
            </Button>
          </ConnectionLauncher>
          <p className="text-xs text-muted-foreground">
            <Link className="underline" href={`/settings/channels?brand=${encodeURIComponent(set.id)}`}>
              Manage in Channels
            </Link>{' '}
            to refresh or remove accounts.{' '}
            <Link className="underline" href={socialSetHref(set.id, 'new-draft')}>
              Choose default platforms for new drafts
            </Link>
            .
          </p>
        </div>
      ) : null}
    </Row>
  )
}

function MoveAccount({ account, set }: { account: SocialSetRecord['accounts'][number]; set: SocialSetRecord }) {
  const { data } = useSocialSets()
  const scope = useSocialSetScope()
  const store = useStoreSocialSet()
  const cache = useQueryClient()
  const [destinationId, setDestinationId] = useState('')
  const destinations = (data?.items ?? []).filter(
    (candidate) => candidate.id !== set.id && candidate.visibility === set.visibility &&
      !candidate.accounts.some((existing) =>
        (channelForPlatform(existing.platform) ?? existing.platform) ===
        (channelForPlatform(account.platform) ?? account.platform)
      )
  )
  const destination = destinations.find((candidate) => candidate.id === destinationId)
  const name = account.handle ?? account.displayName ?? account.platform
  if (destinations.length === 0) return null
  return (
    <>
      <Select value="" onValueChange={setDestinationId}>
        <SelectTrigger aria-label={`Move ${name} to another profile`} className="w-44" size="sm">
          <SelectValue placeholder="Move to profile…" />
        </SelectTrigger>
        <SelectContent>
          {destinations.map((candidate) => (
            <SelectItem key={candidate.id} value={candidate.id}>{candidate.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <ConfirmDialog
        confirmLabel="Move account"
        description={<>
          <p>{name} stays connected and becomes available for drafts in {destination?.name}.</p>
          <p>Existing drafts and publishing history stay in {set.name}. Finish or cancel queued posts and follow-ups before moving.</p>
        </>}
        disabled={!destination}
        onConfirm={async () => {
          try {
            const saved = await scope.request(
              `/api/v1/social-sets/${encodeURIComponent(set.id)}/accounts/${encodeURIComponent(account.id)}/move`,
              socialSetSchema,
              { method: 'POST', body: { destinationSocialSetId: destinationId } }
            )
            await store(saved)
            await cache.invalidateQueries({ queryKey: socialSetKey(scope, set.id) })
            scope.assertCurrent()
            return null
          } catch (error) {
            return settingsErrorMessage(error)
          }
        }}
        onOpenChange={(open) => { if (!open) setDestinationId('') }}
        open={Boolean(destinationId)}
        title={`Move ${name} to ${destination?.name ?? 'another profile'}?`}
      />
    </>
  )
}

function Ownership({ canManage, set }: { canManage: boolean; set: SocialSetRecord }) {
  const scope = useSocialSetScope()
  const store = useStoreSocialSet()
  if (set.visibility === 'WORKSPACE') {
    return (
      <Row
        description="Everyone in this workspace can use this profile under their role: viewers read, creators write, publishers schedule."
        label="Ownership and sharing"
      >
        <Pill>Shared with workspace</Pill>
      </Row>
    )
  }
  return (
    <Row
      description="Only you can see this profile, its accounts and its drafts. Moving it to the team shares all of them with the workspace under each member's role. This cannot be undone here."
      label="Ownership and sharing"
    >
      {set.isOwner && canManage ? (
        <ConfirmDialog
          confirmLabel="Share with workspace"
          description={
            <>
              <p>
                {set.accounts.length} account{set.accounts.length === 1 ? '' : 's'} and every draft
                in {set.name} become visible to the workspace.
              </p>
              <p>Members can then write, schedule and publish with it according to their role.</p>
            </>
          }
          onConfirm={async () => {
            try {
              await store(
                await scope.request(
                  `/api/v1/social-sets/${encodeURIComponent(set.id)}/share`,
                  socialSetSchema,
                  { method: 'POST' }
                )
              )
              return null
            } catch (error) {
              return settingsErrorMessage(error)
            }
          }}
          title={`Move ${set.name} to the team?`}
          triggerLabel="Move to team"
        />
      ) : (
        <Pill tone="purple">Private</Pill>
      )}
    </Row>
  )
}

function DangerZone({ permissions, set }: { permissions: SetPermissions; set: SocialSetRecord }) {
  const scope = useSocialSetScope()
  const allowed = set.visibility === 'PRIVATE' ? set.isOwner : permissions.isAdmin
  const list = SETTINGS_SECTIONS.find((section) => section.id === 'social-sets')!
  return (
    <Group className="ring-red-500/30">
      <MoveToWorkspace allowed={allowed} set={set} />
      <Row
        description="Its accounts are disabled so nothing more publishes through them, its drafts are archived, and its published posts keep their history. A set with queued or publishing posts cannot be deleted; cancel them first."
        label="Delete profile"
      >
        <ConfirmDialog
          confirmLabel="Delete profile"
          confirmText={set.name}
          description={<p>This removes {set.name} for everyone who can see it.</p>}
          destructive
          disabled={!allowed}
          onConfirm={async (typed) => {
            try {
              await scope.request(
                `/api/v1/social-sets/${encodeURIComponent(set.id)}`,
                socialSetRemovalSchema,
                {
                  body: { confirmation: typed },
                  method: 'DELETE',
                }
              )
              window.location.assign(settingsHref(list))
              return null
            } catch (error) {
              return settingsErrorMessage(error)
            }
          }}
          title={`Delete ${set.name}?`}
          triggerLabel="Delete profile"
        />
      </Row>
    </Group>
  )
}

/** A set's identity, accounts, sharing and deletion. */
export function GeneralPage({
  permissions,
  set,
}: {
  permissions: SetPermissions
  set: SocialSetRecord
}) {
  return (
    <div className="grid gap-6">
      <Group>
        <NameAndColor canManage={permissions.canManage} set={set} />
      </Group>
      <Group>
        <Accounts canManage={permissions.canManage} set={set} />
      </Group>
      <Group>
        <Ownership canManage={permissions.canManage} set={set} />
      </Group>
      <h3 className="text-ui-lg font-medium text-red-700 dark:text-red-300">Danger zone</h3>
      <DangerZone permissions={permissions} set={set} />
    </div>
  )
}
