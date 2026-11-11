// Ported from apps/desktop/src/resource-sharing/share-dialog.tsx; see dev/import-founder-hub-ui.mjs.
import { Button as UnstyledButton } from '@/components/ui/button'
import { Trans as _Trans } from '@lingui/react'
import { useLingui as _useLingui } from '@lingui/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { CircleNotch, ShareNetwork, Trash, UserPlus } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import {
  deleteSharedResource,
  grantSharedResourceAccess,
  isTeamSharingUpsellError,
  listSharedResourceGuests,
  revokeSharedResourceAccess,
  upsertSharedResource,
  type SharedResource,
  type SharedResourceType,
} from './client'
import { sharedResourcesQueryKey, useSharedResources } from './hooks'
import { useFounderHubUserId } from '../settings-context'
import { useBillingAccess } from '@/components/settings/founder-hub/billing-access'
import { useAvailableShareWorkspaces } from './hooks'
import { DialogContent as GlassDialogContent } from '@/components/ui/dialog'
import { useRouter } from '@/i18n/navigation'
export function ResourceShareButton(props: {
  resourceType: SharedResourceType
  sourceId: string
  title: string
  buildPayload: () => Record<string, unknown> | Promise<Record<string, unknown>>
}) {
  const accountUserId = useFounderHubUserId()
  if (!accountUserId) return null
  return <AuthenticatedResourceShareButton {...props} />
}
function AuthenticatedResourceShareButton({
  resourceType,
  sourceId,
  title,
  buildPayload,
}: {
  resourceType: SharedResourceType
  sourceId: string
  title: string
  buildPayload: () => Record<string, unknown> | Promise<Record<string, unknown>>
}) {
  const { _: _t } = _useLingui()
  const accountUserId = useFounderHubUserId()
  const billing = useBillingAccess()
  const queryClient = useQueryClient()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [workspaceDraft, setWorkspaceDraft] = useState<string | null>(null)
  const [teamUpsell, setTeamUpsell] = useState<'guest' | 'workspace' | null>(null)
  const resources = useSharedResources(resourceType)
  const owned = resources.data?.find(
    (resource) => resource.accessKind === 'owner' && resource.sourceId === sourceId
  )
  const workspacesQuery = useAvailableShareWorkspaces(accountUserId)
  const workspaces = workspacesQuery.data ?? []
  const selectedWorkspaceId = workspaceDraft ?? owned?.generalWorkspaceId ?? 'personal'
  const guests = useQuery({
    queryKey: ['shared-resource-guests', owned?.shareId ?? ''],
    enabled: Boolean(open && owned?.shareId),
    retry: false,
    queryFn: () => listSharedResourceGuests(owned!.shareId),
  })
  const publish = useMutation({
    mutationFn: async (generalWorkspaceId: string | null) =>
      upsertSharedResource({
        resourceType,
        sourceId,
        title,
        payload: await buildPayload(),
        generalWorkspaceId,
      }),
    onSuccess: () => {
      setTeamUpsell(null)
      return invalidateSharing(queryClient, accountUserId, resourceType)
    },
    onError: (error) => {
      if (isTeamSharingUpsellError(error)) setTeamUpsell('workspace')
    },
  })
  const invite = useMutation({
    mutationFn: async (inviteeEmail: string) => {
      const share = await upsertSharedResource({
        resourceType,
        sourceId,
        title,
        payload: await buildPayload(),
        generalWorkspaceId: selectedWorkspaceId === 'personal' ? null : selectedWorkspaceId,
      })
      await grantSharedResourceAccess(share.shareId, inviteeEmail)
      return share.shareId
    },
    onSuccess: async (shareId) => {
      setEmail('')
      setTeamUpsell(null)
      await Promise.all([
        invalidateSharing(queryClient, accountUserId, resourceType),
        queryClient.invalidateQueries({
          queryKey: ['shared-resource-guests', shareId],
        }),
      ])
    },
    onError: (error) => {
      setTeamUpsell(isTeamSharingUpsellError(error) ? 'guest' : null)
    },
  })
  const revoke = useMutation({
    mutationFn: (guestId: string) => revokeSharedResourceAccess(guestId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ['shared-resource-guests', owned?.shareId ?? ''],
      }),
  })
  const stopSharing = useMutation({
    mutationFn: () => deleteSharedResource(requireOwnedShare(owned).shareId),
    onSuccess: async () => {
      await invalidateSharing(queryClient, accountUserId, resourceType)
      setOpen(false)
    },
  })
  const signedIn = Boolean(accountUserId)
  const error =
    workspacesQuery.error ?? publish.error ?? invite.error ?? revoke.error ?? stopSharing.error
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="text-muted-foreground hover:text-foreground gap-1.5 rounded-full"
        aria-label={_t(
          /*i18n*/
          {
            id: 'Gr265q',
            message: 'Share {title}',
            values: {
              title: title,
            },
          }
        )}
        onClick={() => setOpen(true)}
      >
        <ShareNetwork className="size-4" />
        <_Trans
          {
            /*i18n*/
            ...{
              id: 'Z8lGw6',
              message: 'Share',
            }
          }
        />
      </Button>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (publish.isPending || invite.isPending) return
          setOpen(nextOpen)
          if (!nextOpen) {
            setEmail('')
            setWorkspaceDraft(null)
            setTeamUpsell(null)
            publish.reset()
            invite.reset()
          }
        }}
      >
        <GlassDialogContent className="max-w-[420px]">
          <DialogHeader className="gap-1">
            <DialogTitle className="text-base">
              <_Trans
                {
                  /*i18n*/
                  ...{
                    id: 'Gr265q',
                    message: 'Share {title}',
                    values: {
                      title: title,
                    },
                  }
                }
              />
            </DialogTitle>
            <DialogDescription>
              <_Trans
                {
                  /*i18n*/
                  ...{
                    id: 'VWk5ib',
                    message: 'Share one item with a guest, or add it to a Team for everyone.',
                  }
                }
              />
            </DialogDescription>
          </DialogHeader>

          {!signedIn ? (
            <ShareGate
              description={_t(
                /*i18n*/
                {
                  id: 'H4rmgl',
                  message: 'Sign in to share folders, templates, and automations.',
                }
              )}
              action={
                <Button
                  type="button"
                  size="sm"
                  onClick={() => router.push('/settings/founder-hub/account')}
                >
                  <_Trans
                    {
                      /*i18n*/
                      ...{
                        id: '5lWFkC',
                        message: 'Sign in',
                      }
                    }
                  />
                </Button>
              }
            />
          ) : !billing.isPro && !owned ? (
            <ShareGate
              description={_t(
                /*i18n*/
                {
                  id: 'WpXJEl',
                  message: 'Folder access controls and reusable sharing are included with Pro.',
                }
              )}
              action={
                <Button type="button" size="sm" onClick={billing.upgradeToPro}>
                  <_Trans
                    {
                      /*i18n*/
                      ...{
                        id: 'IelE1h',
                        message: 'Upgrade to Pro',
                      }
                    }
                  />
                </Button>
              }
            />
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <p className="text-sm font-medium">
                  <_Trans
                    {
                      /*i18n*/
                      ...{
                        id: '3IV_Pj',
                        message: 'Team library',
                      }
                    }
                  />
                </p>
                <div className="flex gap-2">
                  <Select value={selectedWorkspaceId} onValueChange={setWorkspaceDraft}>
                    <SelectTrigger className="min-w-0 flex-1 rounded-xl">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="personal">
                        <_Trans
                          {
                            /*i18n*/
                            ...{
                              id: 'kWYqSm',
                              message: 'Not shared with a Team',
                            }
                          }
                        />
                      </SelectItem>
                      {workspaces.map((workspace) => (
                        <SelectItem key={workspace.id} value={workspace.id}>
                          {workspace.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-xl"
                    disabled={publish.isPending || !billing.isPro}
                    onClick={() =>
                      publish.mutate(
                        selectedWorkspaceId === 'personal' ? null : selectedWorkspaceId
                      )
                    }
                  >
                    {publish.isPending ? (
                      <CircleNotch className="size-4 animate-spin" />
                    ) : owned ? (
                      <_Trans
                        {
                          /*i18n*/
                          ...{
                            id: 'EkH9pt',
                            message: 'Update',
                          }
                        }
                      />
                    ) : (
                      <_Trans
                        {
                          /*i18n*/
                          ...{
                            id: 'm16xKo',
                            message: 'Add',
                          }
                        }
                      />
                    )}
                  </Button>
                </div>
                {workspaces.length === 0 ? (
                  <UnstyledButton
                    variant="custom"
                    size={null}
                    type="button"
                    className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
                    onClick={() => {
                      setOpen(false)
                      router.push('/settings/founder-hub/teams')
                    }}
                  >
                    <_Trans
                      {
                        /*i18n*/
                        ...{
                          id: 'wlkbwf',
                          message: 'Create a Team to share a library',
                        }
                      }
                    />
                  </UnstyledButton>
                ) : null}
              </div>

              <div className="space-y-2">
                <p className="text-sm font-medium">
                  <_Trans
                    {
                      /*i18n*/
                      ...{
                        id: '3BJY6s',
                        message: 'Guest access',
                      }
                    }
                  />
                </p>
                <form
                  className="flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault()
                    const inviteeEmail = email.trim()
                    if (inviteeEmail) invite.mutate(inviteeEmail)
                  }}
                >
                  <Input
                    type="email"
                    value={email}
                    className="rounded-xl"
                    placeholder={_t(
                      /*i18n*/
                      {
                        id: '4BtvJ3',
                        message: 'guest@company.com',
                      }
                    )}
                    aria-label={_t(
                      /*i18n*/
                      {
                        id: '7MrxTW',
                        message: 'Guest email',
                      }
                    )}
                    disabled={invite.isPending || !billing.isPro}
                    onChange={(event) => {
                      setEmail(event.target.value)
                      setTeamUpsell(null)
                      invite.reset()
                    }}
                  />
                  <Button
                    type="submit"
                    className="rounded-xl"
                    disabled={!email.trim() || invite.isPending || !billing.isPro}
                  >
                    {invite.isPending ? (
                      <CircleNotch className="size-4 animate-spin" />
                    ) : (
                      <UserPlus className="size-4" />
                    )}
                    <_Trans
                      {
                        /*i18n*/
                        ...{
                          id: 'MFKlMB',
                          message: 'Invite',
                        }
                      }
                    />
                  </Button>
                </form>
                <p className="text-muted-foreground text-xs">
                  <_Trans
                    {
                      /*i18n*/
                      ...{
                        id: '1PsdIL',
                        message:
                          'A guest can access one shared item for free. Add them to your Team when they need more.',
                      }
                    }
                  />
                </p>
              </div>

              {teamUpsell ? (
                <div className="border-border bg-accent/45 space-y-2 rounded-2xl border p-3">
                  <p className="text-sm font-medium">
                    {teamUpsell === 'guest' ? (
                      <_Trans
                        {
                          /*i18n*/
                          ...{
                            id: '77QyHf',
                            message: 'This guest needs Team access',
                          }
                        }
                      />
                    ) : (
                      <_Trans
                        {
                          /*i18n*/
                          ...{
                            id: 'W4j9BJ',
                            message: 'Unlock the Team library',
                          }
                        }
                      />
                    )}
                  </p>
                  <p className="text-muted-foreground text-xs leading-5">
                    {teamUpsell === 'guest' ? (
                      <_Trans
                        {
                          /*i18n*/
                          ...{
                            id: 'Lj95Zh',
                            message:
                              'They already have another shared item. Invite them to your Team for folders, templates, and automations.',
                          }
                        }
                      />
                    ) : (
                      <_Trans
                        {
                          /*i18n*/
                          ...{
                            id: 'q9b00V',
                            message:
                              'Upgrade this workspace to share folders, templates, and automations with everyone on the Team.',
                          }
                        }
                      />
                    )}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      setOpen(false)
                      router.push('/settings/founder-hub/teams')
                    }}
                  >
                    <_Trans
                      {
                        /*i18n*/
                        ...{
                          id: '0ppfde',
                          message: 'Open Teams',
                        }
                      }
                    />
                  </Button>
                </div>
              ) : null}

              {owned ? (
                <div className="border-border/60 space-y-1 border-t pt-3">
                  {owned.generalWorkspaceId ? (
                    <AccessRow
                      label={
                        owned.workspaceName ? (
                          <_Trans
                            {
                              /*i18n*/
                              ...{
                                id: 'aC87LX',
                                message: 'Everyone in {0}',
                                values: {
                                  0: owned.workspaceName,
                                },
                              }
                            }
                          />
                        ) : (
                          <_Trans
                            {
                              /*i18n*/
                              ...{
                                id: 'opQs1W',
                                message: 'Everyone in the Team',
                              }
                            }
                          />
                        )
                      }
                    />
                  ) : null}
                  {guests.data?.map((guest) => (
                    <AccessRow
                      key={guest.guestId}
                      label={guest.email}
                      onRemove={() => revoke.mutate(guest.guestId)}
                    />
                  ))}
                </div>
              ) : null}

              {error && !teamUpsell ? (
                <p className="text-destructive text-xs">{error.message}</p>
              ) : null}

              <DialogFooter className="items-center sm:justify-between">
                {owned ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    disabled={stopSharing.isPending}
                    onClick={() => stopSharing.mutate()}
                  >
                    <Trash className="size-4" />
                    <_Trans
                      {
                        /*i18n*/
                        ...{
                          id: 'YRwdh4',
                          message: 'Stop sharing',
                        }
                      }
                    />
                  </Button>
                ) : (
                  <span />
                )}
                <Button variant="outline" type="button" onClick={() => setOpen(false)}>
                  <_Trans
                    {
                      /*i18n*/
                      ...{
                        id: 'DPfwMq',
                        message: 'Done',
                      }
                    }
                  />
                </Button>
              </DialogFooter>
            </div>
          )}
        </GlassDialogContent>
      </Dialog>
    </>
  )
}
function ShareGate({ description, action }: { description: string; action: React.ReactNode }) {
  return (
    <div className="bg-accent/45 flex items-center justify-between gap-3 rounded-2xl p-3">
      <p className="text-muted-foreground text-xs leading-5">{description}</p>
      <div className="shrink-0">{action}</div>
    </div>
  )
}
function AccessRow({ label, onRemove }: { label: React.ReactNode; onRemove?: () => void }) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-2 text-sm">
      <span className="min-w-0 truncate">{label}</span>
      {onRemove ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className={cn(['h-7 rounded-full px-2 text-xs'])}
          onClick={onRemove}
        >
          <_Trans
            {
              /*i18n*/
              ...{
                id: 't_YqKh',
                message: 'Remove',
              }
            }
          />
        </Button>
      ) : (
        <span className="text-muted-foreground text-xs">
          <_Trans
            {
              /*i18n*/
              ...{
                id: 'KM6m8p',
                message: 'Team',
              }
            }
          />
        </span>
      )}
    </div>
  )
}
function requireOwnedShare(resource: SharedResource | undefined): SharedResource {
  if (!resource) throw new Error('This item is not shared')
  return resource
}
async function invalidateSharing(
  queryClient: ReturnType<typeof useQueryClient>,
  userId: string | undefined,
  resourceType: SharedResourceType
) {
  await queryClient.invalidateQueries({
    queryKey: sharedResourcesQueryKey(userId, resourceType),
  })
}
