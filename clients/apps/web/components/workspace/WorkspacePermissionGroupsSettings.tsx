'use client'

import { useRouter } from 'next/navigation'
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import type { z } from 'zod'
import { Group, Pill, Row, Section } from '@/components/platform-ui'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { listPermissionGroupsContract } from '@/lib/api/contracts/permission-groups'
import { permissions } from '@/lib/auth/permissions'
import { useTRPCClient } from '@/lib/trpc/react'
import { getErrorMessage, requestJson } from './settings-client'

const groupsSchema = listPermissionGroupsContract.output
type PermissionGroup = z.infer<typeof groupsSchema>['groups'][number]
type Member = { email: string; id: string; name: string; role: string }

const BASE_PATH = '/api/enterprise/permission-groups'

/**
 * Named groups that subtract permissions from their members' roles. Owners are
 * never restricted, so no group can lock the workspace out.
 */
export function WorkspacePermissionGroupsSettings({
  canManage,
  organizationId,
}: {
  canManage: boolean
  organizationId: string
}) {
  const router = useRouter()
  const trpcClient = useTRPCClient()
  const [groups, setGroups] = useState<PermissionGroup[] | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const query = new URLSearchParams({ organizationId })
    const [groupList, memberList] = await Promise.all([
      requestJson(`${BASE_PATH}?${query}`, groupsSchema),
      trpcClient.workspace.listMembers.query(),
    ])
    setGroups(groupList.groups)
    setMembers(
      memberList.members.map((member) => ({
        email: member.user.email,
        id: member.id,
        name: member.user.name,
        role: member.role,
      }))
    )
  }, [organizationId, trpcClient])

  useEffect(() => {
    load().catch((requestError: unknown) => setError(getErrorMessage(requestError)))
  }, [load])

  async function run(action: () => Promise<unknown>): Promise<void> {
    setPending(true)
    setError(null)
    try {
      await action()
      await load()
      // A change to the viewer's own group changes what the shell offers them.
      router.refresh()
    } catch (requestError) {
      setError(getErrorMessage(requestError))
    } finally {
      setPending(false)
    }
  }

  function saveGroup(event: FormEvent<HTMLFormElement>, group?: PermissionGroup): void {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const body = {
      deniedPermissions: data.getAll('deniedPermissions'),
      isDefault: data.get('isDefault') === 'on',
      name: data.get('name'),
      organizationId,
    }
    const form = event.currentTarget
    void run(async () => {
      if (!group) {
        await requestJson(BASE_PATH, groupsSchema.shape.groups.element, { body, method: 'POST' })
        form.reset()
        return
      }
      const path = `${BASE_PATH}/${encodeURIComponent(group.id)}`
      await requestJson(path, groupsSchema.shape.groups.element, { body, method: 'PUT' })
      await requestJson(`${path}/members`, groupsSchema.shape.groups.element, {
        body: { memberIds: data.getAll('memberIds'), organizationId },
        method: 'PUT',
      })
    })
  }

  function deleteGroup(group: PermissionGroup): void {
    const query = new URLSearchParams({ organizationId })
    void run(async () => {
      const response = await fetch(`${BASE_PATH}/${encodeURIComponent(group.id)}?${query}`, {
        method: 'DELETE',
      })
      if (!response.ok) throw new Error('The group could not be deleted.')
    })
  }

  return (
    <Section
      description="Each group removes permissions from its members' roles, on the Enterprise plan. A default group covers everyone not in another group. Owners are never restricted. Changes require a recent sign-in and two-factor authentication."
      title="Permission groups"
    >
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {groups?.map((group) => (
        <GroupForm
          canManage={canManage}
          group={group}
          key={`${group.id}:${group.updatedAt}:${group.memberIds.join()}`}
          members={members}
          onDelete={() => deleteGroup(group)}
          onSubmit={(event) => saveGroup(event, group)}
          pending={pending}
        />
      ))}
      {canManage && groups ? (
        <GroupForm
          canManage
          members={members}
          onSubmit={(event) => saveGroup(event)}
          pending={pending}
        />
      ) : null}
    </Section>
  )
}

function GroupForm({
  canManage,
  group,
  members,
  onDelete,
  onSubmit,
  pending,
}: {
  canManage: boolean
  group?: PermissionGroup
  members: Member[]
  onDelete?: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  pending: boolean
}) {
  const prefix = group?.id ?? 'new'
  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit}>
      <Group>
        <Row
          label={
            <Label htmlFor={`${prefix}-name`}>{group ? 'Group name' : 'New group name'}</Label>
          }
        >
          <Input
            className="h-10 rounded-lg md:w-72"
            defaultValue={group?.name}
            disabled={!canManage}
            id={`${prefix}-name`}
            maxLength={100}
            name="name"
            required
          />
        </Row>
        <Row
          description="Covers every member not assigned to another group."
          label={<Label htmlFor={`${prefix}-default`}>Default group</Label>}
          layout="inline"
        >
          <Checkbox
            defaultChecked={group?.isDefault}
            disabled={!canManage}
            id={`${prefix}-default`}
            name="isDefault"
          />
        </Row>
        <Row label="Denied permissions" layout="stacked">
          <div className="grid gap-2 sm:grid-cols-2">
            {permissions.map((permission) => (
              <div className="flex items-center gap-2" key={permission}>
                <Checkbox
                  defaultChecked={group?.deniedPermissions.includes(permission)}
                  disabled={!canManage}
                  id={`${prefix}-${permission}`}
                  name="deniedPermissions"
                  value={permission}
                />
                <Label className="font-mono text-xs" htmlFor={`${prefix}-${permission}`}>
                  {permission}
                </Label>
              </div>
            ))}
          </div>
        </Row>
        {group ? (
          <Row label="Members" layout="stacked">
            <div className="grid gap-2 sm:grid-cols-2">
              {members.map((member) => (
                <div className="flex items-center gap-2" key={member.id}>
                  <Checkbox
                    defaultChecked={group.memberIds.includes(member.id)}
                    disabled={!canManage}
                    id={`${prefix}-${member.id}`}
                    name="memberIds"
                    value={member.id}
                  />
                  <Label className="text-sm" htmlFor={`${prefix}-${member.id}`}>
                    {member.name || member.email}
                  </Label>
                  {member.role === 'owner' ? <Pill>Never restricted</Pill> : null}
                </div>
              ))}
            </div>
          </Row>
        ) : null}
      </Group>
      {canManage ? (
        <div className="flex justify-end gap-2">
          {onDelete ? (
            <Button
              className="rounded-lg"
              disabled={pending}
              onClick={onDelete}
              type="button"
              variant="outline"
            >
              Delete group
            </Button>
          ) : null}
          <Button className="rounded-lg" disabled={pending} type="submit">
            {group ? 'Save group' : 'Create group'}
          </Button>
        </div>
      ) : null}
    </form>
  )
}
