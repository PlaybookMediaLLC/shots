'use client'

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { toast } from 'sonner'
import { ChannelIcon } from '@/components/drafts/channel-meta'
import { EmptyState, Group, Pill, PlanRequired, Row } from '@/components/platform-ui'
import { ConfirmDialog } from '@/components/settings/ConfirmDialog'
import { DeveloperId } from '@/components/settings/DeveloperId'
import { socialSetHref } from '@/components/workspace/settings-sections'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  copyableSocialSetSchema,
  socialSetRemovalSchema,
  socialSetSchema,
} from '@/lib/api/contracts/social-sets'
import { channelForPlatform } from '@/lib/content-drafts/serialize'
import { isPlanRefusal } from '@/lib/api/platform-errors'
import { settingsErrorMessage } from '@/lib/settings/client'
import { useSocialSetScope } from './scope'
import { z } from 'zod'
import { CanvasIcon as Layers } from '@/components/platform-shell/icons'
import { hasDefaultProfileName, type SocialSetRecord, useSocialSets, useStoreSocialSet } from './api'
import { ConnectionLauncher } from '@/components/social-connections/ConnectionLauncher'

function Platforms({ set }: { set: SocialSetRecord }) {
  if (set.accounts.length === 0)
    return <span className="text-xs text-muted-foreground">No accounts yet</span>
  return (
    <span
      className="flex items-center gap-1.5"
      aria-label={`Accounts: ${set.accounts.map((account) => account.platform).join(', ')}`}
    >
      {set.accounts.map((account) => {
        const channel = channelForPlatform(account.platform)
        return channel ? (
          <ChannelIcon channel={channel} className="size-3.5 text-foreground/80" key={account.id} />
        ) : (
          <span className="text-xs" key={account.id}>
            {account.platform}
          </span>
        )
      })}
    </span>
  )
}

function SetRow({ set, canManage }: { set: SocialSetRecord; canManage: boolean }) {
  return (
    <Row
      description={
        <span className="flex flex-wrap items-center gap-2">
          <Platforms set={set} />
          <span>· {set.weeklySlotCount} weekly slots</span>
          <span>· {set.timeZone}</span>
          <DeveloperId id={set.id} label="Profile" />
        </span>
      }
      label={
        <span className="flex flex-wrap items-center gap-2">
          <span
            aria-hidden
            className="size-3 rounded-full"
            style={{ backgroundColor: set.color }}
          />
          {set.name}
          <Pill tone={set.visibility === 'PRIVATE' ? 'purple' : 'gray'}>
            {set.visibility === 'PRIVATE' ? 'Private to you' : 'Shared with workspace'}
          </Pill>
          {set.needsAttention ? <Pill tone="yellow">Some accounts need attention</Pill> : null}
          {canManage && hasDefaultProfileName(set.name) ? (
            <Pill tone="yellow">Needs a name</Pill>
          ) : null}
        </span>
      }
    >
      <div className="flex flex-wrap gap-2">
        {set.needsAttention ? (
          <Button asChild size="sm" variant="outline">
            <Link href={socialSetHref(set.id)}>Manage platforms</Link>
          </Button>
        ) : null}
        {canManage ? (
          <ConnectionLauncher
            intent={{
              operation: 'ADD_ACCOUNT',
              socialSetId: set.id,
              returnPath: socialSetHref(set.id),
            }}
            target={set}
          >
            <Button aria-label={`Add a platform to ${set.name}`} size="sm" variant="outline">
              Add platform
            </Button>
          </ConnectionLauncher>
        ) : null}
        <Button asChild size="sm">
          <Link aria-label={`Settings for ${set.name}`} href={socialSetHref(set.id)}>
            Settings
          </Link>
        </Button>
      </div>
    </Row>
  )
}

function CreateSet({ canManage }: { canManage: boolean }) {
  if (!canManage) return null
  return (
    <Group>
      <Row
        description="Start with a connected account, then add the platforms this person or company posts from."
        label="New profile"
        layout="stacked"
      >
        <div className="flex flex-wrap gap-2">
          <ConnectionLauncher intent={{ operation: 'CREATE_SET', creationVisibility: 'PRIVATE' }}>
            <Button aria-label="Add profile to your personal workspace">
              New private profile
            </Button>
          </ConnectionLauncher>
          <ConnectionLauncher intent={{ operation: 'CREATE_SET', creationVisibility: 'WORKSPACE' }}>
            <Button variant="outline">New workspace profile</Button>
          </ConnectionLauncher>
        </div>
      </Row>
    </Group>
  )
}

function Unassigned({ canManage, sets }: { canManage: boolean; sets: SocialSetRecord[] }) {
  const scope = useSocialSetScope()
  const store = useStoreSocialSet()
  const { data, refetch } = useSocialSets()
  const accounts = data?.unassigned ?? []
  if (accounts.length === 0) return null
  return (
    <Group>
      <Row
        description="These accounts belong to the workspace but to no set yet. Drafts can publish to an account only through its set."
        label="Accounts in no set"
        layout="stacked"
      >
        <ul className="grid gap-2">
          {accounts.map((account) => (
            <li
              className="flex flex-wrap items-center justify-between gap-2 text-sm"
              key={account.id}
            >
              <span>
                {account.displayName ?? account.handle ?? account.platform}{' '}
                <span className="text-muted-foreground">· {account.platform}</span>
              </span>
              {canManage ? (
                <Select
                  onValueChange={async (target) => {
                    try {
                      await store(
                        await scope.request(
                          `/api/v1/social-sets/${encodeURIComponent(target)}/accounts/${encodeURIComponent(account.id)}`,
                          socialSetSchema,
                          { method: 'POST' }
                        )
                      )
                      await refetch()
                      toast.success('Account added to the set.')
                    } catch (error) {
                      toast.error(settingsErrorMessage(error))
                    }
                  }}
                  value=""
                >
                  <SelectTrigger
                    aria-label={`Add ${account.displayName ?? account.platform} to a set`}
                    className="bg-card"
                    size="sm"
                  >
                    <SelectValue placeholder="Add to a set…" />
                  </SelectTrigger>
                  <SelectContent>
                    {sets.map((set) => (
                      <SelectItem key={set.id} value={set.id}>
                        {set.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
            </li>
          ))}
        </ul>
      </Row>
    </Group>
  )
}

function Orphaned() {
  const scope = useSocialSetScope()
  const { data, refetch } = useSocialSets()
  const orphaned = data?.orphaned ?? []
  if (orphaned.length === 0) return null
  return (
    <Group>
      <Row
        description="Private sets whose owners left the workspace. Their accounts still count toward your plan; delete a set to disable its accounts."
        label="Private sets without an owner"
        layout="stacked"
      >
        <ul className="grid gap-2">
          {orphaned.map((set) => (
            <li className="flex flex-wrap items-center justify-between gap-2 text-sm" key={set.id}>
              <span>
                {set.name}{' '}
                <span className="text-muted-foreground">· {set.accountCount} accounts</span>
              </span>
              <ConfirmDialog
                confirmLabel="Delete set"
                confirmText={set.name}
                description="Its accounts are disabled and its drafts archived. Published posts and their history stay."
                destructive
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
                    await refetch()
                    return null
                  } catch (error) {
                    return settingsErrorMessage(error)
                  }
                }}
                title={`Delete ${set.name}?`}
                triggerLabel="Delete"
              />
            </li>
          ))}
        </ul>
      </Row>
    </Group>
  )
}

function CopyFromWorkspace({ canManage }: { canManage: boolean }) {
  const scope = useSocialSetScope()
  const store = useStoreSocialSet()
  const copyable = useQuery({
    enabled: canManage && scope.ready,
    queryFn: ({ signal }) =>
      scope.request(
        '/api/v1/social-sets/copyable',
        z.object({ items: z.array(copyableSocialSetSchema) }),
        { signal }
      ),
    queryKey: [...scope.key, 'copyable'],
  })
  const items = copyable.isError ? [] : (copyable.data?.items ?? [])
  if (!canManage || items.length === 0) return null
  return (
    <Group>
      <Row
        description="Copies a set's name, colour, schedule, defaults and style guide from another of your workspaces. Accounts are not copied: their access stays with their own workspace, so you connect them again here. The copy starts private to you."
        label="Copy from another workspace"
      >
        <Select
          onValueChange={async (value) => {
            const choice = items.find((item) => `${item.workspaceId}/${item.id}` === value)
            if (!choice) return
            try {
              const copied = await scope.request('/api/v1/social-sets/copy', socialSetSchema, {
                body: { socialSetId: choice.id, workspaceId: choice.workspaceId },
                method: 'POST',
              })
              await store(copied)
              window.location.assign(`${socialSetHref(copied.id)}#accounts`)
            } catch (error) {
              toast.error(settingsErrorMessage(error))
            }
          }}
          value=""
        >
          <SelectTrigger
            aria-label="Copy a profile from another workspace"
            className="bg-card"
          >
            <SelectValue placeholder="Choose a profile…" />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem
                key={`${item.workspaceId}/${item.id}`}
                value={`${item.workspaceId}/${item.id}`}
              >
                {item.name} · {item.workspaceName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
    </Group>
  )
}

/**
 * Profiles (RFC 024): the people and companies this workspace posts as. Each
 * row is one set by ID; two sets can share a name and stay apart.
 */
export function SocialSetList({ canManage }: { canManage: boolean }) {
  const list = useSocialSets()
  if (list.isPending)
    return <p className="text-sm text-muted-foreground">Loading profiles…</p>
  if (isPlanRefusal(list.error)) {
    return (
      <PlanRequired from="/settings/publishing-brands">
        Profiles, and the accounts and schedules they post with, need Pro.
      </PlanRequired>
    )
  }
  if (list.isError) {
    return (
      <p className="text-sm text-red-700 dark:text-red-300" role="alert">
        {settingsErrorMessage(list.error)}
      </p>
    )
  }
  const sets = list.data.items
  return (
    <div className="grid gap-6">
      {sets.length === 0 ? (
        <EmptyState
          description="Create a profile for each person or company you post as."
          icon={Layers}
          title="No profiles yet"
        />
      ) : (
        <Group>
          {sets.map((set) => (
            <SetRow canManage={canManage} key={set.id} set={set} />
          ))}
        </Group>
      )}
      <CreateSet canManage={canManage} />
      <Unassigned canManage={canManage} sets={sets} />
      <CopyFromWorkspace canManage={canManage} />
      <Orphaned />
    </div>
  )
}
