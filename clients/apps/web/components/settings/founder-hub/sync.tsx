'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { founderHubCloudsyncStatusSchema } from 'screenshot-studio-backend-sdk'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Link } from '@/i18n/navigation'
import { SettingsPageTitle } from './page-title'
import { BooleanSetting } from './general/app'
import { useFounderHubDevices, useNativeSettingsAction, useSelectedDevice } from './device-context'
import { useConfigValue } from './settings-context'
import { useBillingAccess } from './billing-access'
import { createCloudsyncLogRequest, createCloudsyncRecoveryRequest } from './private-action'

/** Account-owned sync preference and registered desktop state from Shots. */
export function SettingsSync() {
  const queryClient = useQueryClient()
  const device = useSelectedDevice()
  const devices = useFounderHubDevices()
  const syncEnabled = useConfigValue('cloud_sync_enabled')
  const { isPro } = useBillingAccess()
  const action = useNativeSettingsAction()
  const syncStatus = readSyncStatus(
    action.kind === 'cloudsync-status' && action.deviceId === device?.deviceId ? action.result : ''
  )
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const [recoveryInput, setRecoveryInput] = useState('')
  const [recoveryError, setRecoveryError] = useState<string | null>(null)
  const [recoveryRequest, setRecoveryRequest] = useState<{
    userId: string
    deviceId: string
    request: Awaited<ReturnType<typeof createCloudsyncRecoveryRequest>>
  }>()
  const [logRequest, setLogRequest] = useState<{
    userId: string
    deviceId: string
    request: Awaited<ReturnType<typeof createCloudsyncLogRequest>>
  }>()
  const [recoveryStateUserId, setRecoveryStateUserId] = useState(action.userId)
  if (recoveryStateUserId !== action.userId) {
    setRecoveryStateUserId(action.userId)
    setRecoveryOpen(false)
    setRecoveryInput('')
    setRecoveryError(null)
    setRecoveryRequest(undefined)
    setLogRequest(undefined)
  }
  const requestRecovery = useMutation({
    mutationFn: async (
      input:
        | { operation: 'status' | 'create' | 'confirm' }
        | { operation: 'import'; recoveryKey: string }
    ) => {
      if (!device?.report.autoFormatKey)
        throw new Error('Secure recovery key access is unavailable.')
      return {
        userId: action.userId,
        deviceId: device.deviceId,
        request: await createCloudsyncRecoveryRequest(device.report.autoFormatKey, input),
      }
    },
    onSuccess: ({ userId, deviceId, request }) => {
      setRecoveryRequest({ userId, deviceId, request })
      action.run({ kind: 'cloudsync-recovery', argument: request.argument, expectedUserId: userId })
    },
  })
  const recoveryResult = useQuery({
    queryKey: ['founder-hub-cloudsync-recovery', action.userId, device?.deviceId, action.commandId],
    enabled:
      recoveryOpen &&
      action.kind === 'cloudsync-recovery' &&
      Boolean(
        recoveryRequest &&
        recoveryRequest.userId === action.userId &&
        recoveryRequest.deviceId === device?.deviceId &&
        action.commandId &&
        action.result
      ),
    queryFn: () => recoveryRequest!.request.readResult(action.result),
    staleTime: Infinity,
    gcTime: 0,
  })
  const requestLog = useMutation({
    mutationFn: async () => {
      if (!device?.report.autoFormatKey) throw new Error('Secure log access is unavailable.')
      return {
        userId: action.userId,
        deviceId: device.deviceId,
        request: await createCloudsyncLogRequest(device.report.autoFormatKey),
      }
    },
    onSuccess: ({ userId, deviceId, request }) => {
      setLogRequest({ userId, deviceId, request })
      action.run({ kind: 'cloudsync-log', argument: request.argument, expectedUserId: userId })
    },
  })
  const syncLog = useQuery({
    queryKey: ['founder-hub-sync-log', action.userId, device?.deviceId, action.commandId],
    enabled:
      action.kind === 'cloudsync-log' &&
      Boolean(
        logRequest &&
        logRequest.userId === action.userId &&
        logRequest.deviceId === device?.deviceId &&
        action.commandId &&
        action.result
      ),
    queryFn: () => logRequest!.request.readResult(action.result),
    staleTime: Infinity,
    gcTime: 0,
  })
  return (
    <div className="flex flex-col gap-8">
      <SettingsPageTitle title="Sync" />
      {isPro ? (
        <>
          <p className="text-muted-foreground text-sm">
            Manage the account sync preference here and inspect or trigger local database sync on a
            connected desktop.
          </p>
          <BooleanSetting
            name="cloud_sync_enabled"
            title="Enable cloud sync"
            description="Keep supported Founder Hub preferences synchronized through your Shots account."
          />
          <section className="grid gap-3">
            <div>
              <h3 className="text-sm font-medium">Device sync status</h3>
              <p className="text-xs text-muted-foreground">
                Status is read from the selected desktop. Recovery keys and note contents are never
                readable to Shots.
              </p>
            </div>
            {device && !device.report.supportsCloudsyncSettings && (
              <p role="status" className="text-sm text-muted-foreground">
                Update Founder Hub on this computer to manage its sync status here.
              </p>
            )}
            {syncStatus ? (
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <SyncValue label="State" value={syncState(syncStatus)} />
                <SyncValue
                  label="Last synced"
                  value={
                    syncStatus.last_sync_at_ms === null
                      ? 'Not synced yet'
                      : new Date(syncStatus.last_sync_at_ms).toLocaleString()
                  }
                />
                <SyncValue
                  label="Pending local changes"
                  value={
                    syncStatus.has_unsent_changes === null
                      ? 'Unknown'
                      : syncStatus.has_unsent_changes
                        ? 'Yes'
                        : 'No'
                  }
                />
                <SyncValue
                  label="Consecutive failures"
                  value={String(syncStatus.consecutive_failures)}
                />
                {syncStatus.recovery_pending && (
                  <SyncValue
                    label="Recovery"
                    value={syncStatus.recovery_delayed ? 'Delayed; retrying' : 'In progress'}
                  />
                )}
              </dl>
            ) : (
              <p role="status" className="text-sm text-muted-foreground">
                {device
                  ? 'Check the selected desktop to load its sync status.'
                  : 'Connect a desktop to inspect device sync status.'}
              </p>
            )}
            {syncStatus &&
              (syncStatus.conflicted_notes > 0 ||
                syncStatus.pending_update_records > 0 ||
                syncStatus.too_large_records > 0) && (
                <section className="grid gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
                  <h4 className="text-sm font-medium">Sync health</h4>
                  <ul className="grid gap-1 text-sm text-muted-foreground">
                    {syncStatus.conflicted_notes > 0 && (
                      <li>{syncStatus.conflicted_notes} note versions need review.</li>
                    )}
                    {syncStatus.pending_update_records > 0 && (
                      <li>{syncStatus.pending_update_records} records need an app update.</li>
                    )}
                    {syncStatus.too_large_records > 0 && (
                      <li>{syncStatus.too_large_records} records are too large to apply.</li>
                    )}
                  </ul>
                </section>
              )}
            {action.error && (
              <p role="alert" className="text-sm text-destructive">
                {action.error}
              </p>
            )}
            {action.kind === 'cloudsync-status' && action.result && !syncStatus && (
              <p role="alert" className="text-sm text-destructive">
                The desktop returned an invalid sync status. Retry the request.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={!device || !device.report.supportsCloudsyncSettings || action.isPending}
                onClick={() => action.run({ kind: 'cloudsync-status', argument: '' })}
              >
                {action.isPending ? 'Checking…' : 'Check status'}
              </Button>
              <Button
                disabled={
                  !device ||
                  !device.report.supportsCloudsyncSettings ||
                  !syncEnabled ||
                  action.isPending ||
                  !syncStatus?.cloudsync_enabled ||
                  !syncStatus.configured ||
                  !syncStatus.running ||
                  syncStatus.activity_paused ||
                  syncStatus.recovery_pending
                }
                onClick={() => action.run({ kind: 'cloudsync-now', argument: '' })}
              >
                Sync now
              </Button>
            </div>
          </section>
          <section className="grid gap-3">
            <div>
              <h3 className="text-sm font-medium">Recovery key</h3>
              <p className="text-xs text-muted-foreground">
                The key encrypts synced data on your desktop. It is encrypted while being sent here
                and never stored in readable form by Shots.
              </p>
            </div>
            {device && !device.report.supportsCloudsyncSettings && (
              <p role="status" className="text-sm text-muted-foreground">
                Update Founder Hub on this computer to manage its recovery key here.
              </p>
            )}
            <Button
              variant="outline"
              className="w-fit"
              disabled={
                !device?.report.supportsCloudsyncRecovery ||
                !device?.report.autoFormatKey ||
                action.isPending ||
                requestRecovery.isPending
              }
              onClick={() => {
                setRecoveryOpen(true)
                requestRecovery.mutate({ operation: 'status' })
              }}
            >
              Manage recovery key
            </Button>
          </section>
          <section className="grid gap-3">
            <div>
              <h3 className="text-sm font-medium">Sync log</h3>
              <p className="text-xs text-muted-foreground">
                Recent local sync entries are encrypted on the desktop and decrypted only in this
                browser.
              </p>
            </div>
            {syncLog.isError && (
              <p role="alert" className="text-sm text-destructive">
                The encrypted sync log could not be loaded. Try again from the selected desktop.
              </p>
            )}
            {requestLog.error && (
              <p role="alert" className="text-sm text-destructive">
                {requestLog.error.message}
              </p>
            )}
            {action.kind === 'cloudsync-log' && action.isPending && (
              <p role="status" className="text-sm text-muted-foreground">
                Waiting for the desktop…
              </p>
            )}
            {syncLog.data !== undefined && (
              <pre className="max-h-64 overflow-auto rounded-md border p-3 font-mono text-xs whitespace-pre-wrap">
                {syncLog.data || 'No sync activity yet.'}
              </pre>
            )}
            <Button
              variant="outline"
              disabled={
                !device ||
                !device.report.supportsCloudsyncSettings ||
                !device.report.autoFormatKey ||
                action.isPending ||
                requestLog.isPending
              }
              onClick={() => requestLog.mutate()}
            >
              {requestLog.isPending || (action.kind === 'cloudsync-log' && action.isPending)
                ? 'Loading…'
                : 'View sync log'}
            </Button>
          </section>
          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-medium">Connected computers</h3>
            {devices.map((item) => (
              <div
                key={item.deviceId}
                className="flex items-center justify-between gap-4 rounded-lg border px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {item.name || 'Unnamed computer'}
                    {item.deviceId === device?.deviceId ? ' · This computer' : ''}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {item.report.platform} · Founder Hub {item.report.version}
                  </p>
                </div>
              </div>
            ))}
            {!devices.length && (
              <p className="text-muted-foreground text-sm">
                Sign in to Founder Hub on a desktop to connect it to Shots.
              </p>
            )}
          </section>
          <Dialog
            open={recoveryOpen}
            onOpenChange={(open) => {
              if (!open && (action.isPending || requestRecovery.isPending)) return
              setRecoveryOpen(open)
              if (!open) {
                setRecoveryInput('')
                setRecoveryError(null)
                setRecoveryRequest(undefined)
                requestRecovery.reset()
                queryClient.setQueryData(
                  [
                    'founder-hub-cloudsync-recovery',
                    action.userId,
                    device?.deviceId,
                    action.commandId,
                  ],
                  recoveryResult.data ? { configured: recoveryResult.data.configured } : undefined
                )
              }
            }}
          >
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Sync recovery key</DialogTitle>
                <DialogDescription>
                  The recovery key is encrypted while it travels between Founder Hub and your
                  desktop. Shots never receives it in readable form.
                </DialogDescription>
              </DialogHeader>
              {action.kind === 'cloudsync-recovery' && action.isPending && (
                <p role="status" className="text-sm text-muted-foreground">
                  Waiting for the desktop…
                </p>
              )}
              {recoveryResult.data?.configured && (
                <p role="status" className="text-sm">
                  A recovery key is configured on this desktop. Existing keys cannot be displayed
                  again.
                </p>
              )}
              {recoveryResult.data &&
                !recoveryResult.data.configured &&
                !recoveryResult.data.recoveryKey && (
                  <div className="grid gap-3">
                    <Button
                      disabled={action.isPending || requestRecovery.isPending}
                      onClick={() => requestRecovery.mutate({ operation: 'create' })}
                    >
                      Create a recovery key
                    </Button>
                    <div className="grid gap-2">
                      <Label htmlFor="founder-hub-recovery-key" className="text-sm font-medium">
                        Use an existing key
                      </Label>
                      <Input
                        id="founder-hub-recovery-key"
                        value={recoveryInput}
                        onChange={(event) => setRecoveryInput(event.target.value)}
                        placeholder="anarlog-e2ee-v1:…"
                        autoComplete="off"
                        spellCheck={false}
                        className="font-mono"
                      />
                      <Button
                        variant="outline"
                        disabled={
                          !recoveryInput.trim() || action.isPending || requestRecovery.isPending
                        }
                        onClick={() =>
                          requestRecovery.mutate({
                            operation: 'import',
                            recoveryKey: recoveryInput.trim(),
                          })
                        }
                      >
                        Import recovery key
                      </Button>
                    </div>
                  </div>
                )}
              {recoveryResult.data?.recoveryKey && (
                <div className="grid gap-3">
                  <code className="max-h-32 overflow-auto rounded-md border p-3 font-mono text-xs break-all select-all">
                    {recoveryResult.data.recoveryKey}
                  </code>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      onClick={async () => {
                        const key = recoveryResult.data?.recoveryKey
                        if (!key) return
                        try {
                          await copyRecoveryKey(key)
                        } catch {
                          setRecoveryError('Could not copy the recovery key.')
                        }
                      }}
                    >
                      Copy recovery key
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => downloadRecoveryKey(recoveryResult.data!.recoveryKey!)}
                    >
                      Download key
                    </Button>
                  </div>
                  <Button
                    disabled={action.isPending || requestRecovery.isPending}
                    onClick={() => requestRecovery.mutate({ operation: 'confirm' })}
                  >
                    I saved it
                  </Button>
                </div>
              )}
              {(action.error || requestRecovery.error || recoveryResult.error || recoveryError) && (
                <p role="alert" className="text-sm text-destructive">
                  {recoveryError ??
                    action.error ??
                    requestRecovery.error?.message ??
                    'The recovery key operation failed.'}
                </p>
              )}
              <DialogFooter>
                <Button
                  variant="outline"
                  disabled={action.isPending || requestRecovery.isPending}
                  onClick={() => setRecoveryOpen(false)}
                >
                  Close
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      ) : (
        <section className="grid justify-items-start gap-3">
          <p className="text-sm text-muted-foreground">
            Encrypted Cloud Sync and its recovery controls require Founder Hub Pro.
          </p>
          <Button asChild>
            <Link href="/settings/billing">View plans</Link>
          </Button>
        </section>
      )}
    </div>
  )
}

function readSyncStatus(result: string) {
  if (!result) return undefined
  try {
    const parsed = founderHubCloudsyncStatusSchema.safeParse(JSON.parse(result))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

function downloadRecoveryKey(value: string) {
  const url = URL.createObjectURL(new Blob([`${value}\n`], { type: 'text/plain' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `shots-recovery-key_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

let recoveryClipboardTimer: number | null = null
async function copyRecoveryKey(value: string) {
  await navigator.clipboard.writeText(value)
  if (recoveryClipboardTimer !== null) window.clearTimeout(recoveryClipboardTimer)
  recoveryClipboardTimer = window.setTimeout(() => {
    recoveryClipboardTimer = null
    void navigator.clipboard
      .readText()
      .then((current) => {
        if (current === value) return navigator.clipboard.writeText('')
      })
      .catch(() => {})
  }, 60_000)
}

function syncState(status: ReturnType<typeof founderHubCloudsyncStatusSchema.parse>) {
  if (!status.cloudsync_enabled) return 'Paused'
  if (status.recovery_pending) return status.recovery_delayed ? 'Recovery delayed' : 'Recovering'
  if (status.last_error_kind || status.consecutive_failures > 0) return 'Needs attention'
  if (status.activity_paused)
    return status.deferred_for_capture
      ? 'Waiting for capture to finish'
      : 'Waiting for current activity'
  if (!status.configured || !status.running) return 'Connecting'
  if (status.has_unsent_changes || status.last_sync_at_ms === null) return 'Syncing'
  return 'Synced'
}

function SyncValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-medium">{value}</dd>
    </div>
  )
}
