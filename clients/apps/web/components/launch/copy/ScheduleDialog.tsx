'use client'

import type { ChannelConnection } from 'screenshot-studio-backend-sdk'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { type FormEvent, useEffect, useId, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { DatePicker } from '@/components/ui/date-picker'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { getErrorMessage } from '@/components/workspace/settings-client'
import { connectionsForChannel } from '@/lib/launch/schedule'
import { useTRPCClient } from '@/lib/trpc/react'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'

/** An approved visual a post can publish with; `id` is its creative variant. */
export type ScheduleVisual = { id: string; label: string }

const fieldClass =
  'h-10 w-full rounded-lg border border-foreground/10 bg-transparent px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-foreground/20'

/** The link check's refusal; the user can schedule anyway on purpose. */
const LINK_CHECK_PREFIX = 'Not scheduled: a link'

/** Cancelling is a sensitive action: it needs a fresh sign-in with two-factor authentication. */
function cancelErrorMessage(error: unknown): string {
  const message = getErrorMessage(error)
  if (/fresh sign-in|two-factor/i.test(message)) {
    return 'Cancelling a scheduled post needs two-factor authentication and a sign-in from the last 15 minutes. Turn on two-factor in Settings → Security, or sign out and back in, then try again.'
  }
  return message
}

/** Cancels a scheduled post that has not been published yet. */
export function CancelScheduleButton({ scheduledPostId }: { scheduledPostId: string }) {
  const trpcClient = useTRPCClient()
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function cancel() {
    setBusy(true)
    try {
      await trpcClient.scheduledPost.cancel.mutate({ scheduledPostId })
      toast.success('Scheduled post cancelled')
      router.refresh()
    } catch (error) {
      toast.error('The post could not be cancelled', { description: cancelErrorMessage(error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button
      className="h-8 rounded-lg text-xs"
      disabled={busy}
      onClick={() => void cancel()}
      size="sm"
      type="button"
      variant="outline"
    >
      {busy ? 'Cancelling…' : 'Cancel schedule'}
    </Button>
  )
}

/**
 * Schedules an approved post, or reschedules one whose scheduled post was
 * cancelled or failed: pick the visual, the connected account, and the time.
 * An empty time publishes at the workspace's next default publish time.
 */
export function ScheduleDialog({
  campaignId,
  channelLabel,
  post,
  reschedule,
}: {
  campaignId: string
  channelLabel: string
  post: { channel: string; creativeVariantId: string | null; id: string; visuals: ScheduleVisual[] }
  reschedule: boolean
}) {
  const trpcClient = useTRPCClient()
  const router = useRouter()
  const ids = { channel: useId(), time: useId(), visual: useId() }
  const [open, setOpen] = useState(false)
  const [connections, setConnections] = useState<ChannelConnection[] | null>(null)
  const [connectionId, setConnectionId] = useState('')
  // Empty keeps the visual already attached to the post.
  const [variantId, setVariantId] = useState(
    post.visuals.some((visual) => visual.id === post.creativeVariantId)
      ? (post.creativeVariantId ?? '')
      : (post.visuals[0]?.id ?? '')
  )
  const [day, setDay] = useState('')
  const [clock, setClock] = useState('')
  // A datetime-local value, empty until both halves are set.
  const time = day && clock ? `${day}T${clock}` : ''
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const usable = connections ? (connectionsForChannel(post.channel, connections) ?? []) : null
  const hasVisual = variantId !== '' || post.creativeVariantId !== null

  useEffect(() => {
    if (!open || connections) return
    trpcClient.channelConnection.list
      .query()
      .then((result) => {
        setConnections(result.connections)
        setConnectionId(connectionsForChannel(post.channel, result.connections)?.[0]?.id ?? '')
      })
      .catch((loadError: unknown) => setError(getErrorMessage(loadError)))
  }, [connections, open, post.channel, trpcClient])

  async function schedule(skipLinkCheck: boolean) {
    setBusy(true)
    setError(null)
    try {
      await trpcClient.campaign.schedulePost.mutate({
        campaignId,
        channelConnectionId: connectionId,
        ...(variantId ? { creativeVariantId: variantId } : {}),
        postId: post.id,
        ...(time ? { scheduledAt: new Date(time).toISOString() } : {}),
        skipLinkCheck,
      })
      toast.success(reschedule ? 'Post rescheduled' : 'Post scheduled')
      setOpen(false)
      router.refresh()
    } catch (scheduleError) {
      setError(getErrorMessage(scheduleError))
    } finally {
      setBusy(false)
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void schedule(false)
  }

  return (
    <>
      <Button
        className="h-8 rounded-lg text-xs"
        onClick={() => setOpen(true)}
        size="sm"
        type="button"
      >
        {reschedule ? 'Reschedule' : 'Schedule'}
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{reschedule ? 'Reschedule post' : 'Schedule post'}</DialogTitle>
            <DialogDescription>
              The {channelLabel} post publishes with the visual you pick, to the account you pick.
            </DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs font-medium text-foreground/65" htmlFor={ids.visual}>
                Visual
              </Label>
              {post.visuals.length === 0 && !post.creativeVariantId ? (
                <p className="text-sm text-muted-foreground">
                  No approved visuals yet.{' '}
                  <Link
                    className="font-medium text-foreground underline-offset-4 hover:underline"
                    href={`/campaigns/${campaignId}/assets`}
                  >
                    Approve one on the asset board
                  </Link>
                </p>
              ) : (
                <Select
                  onValueChange={(nextValue) =>
                    setVariantId(nextValue === '__empty_option__' ? '' : nextValue)
                  }
                  value={String(variantId) || '__empty_option__'}
                >
                  <SelectTrigger className={fieldClass} id={ids.visual}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {post.creativeVariantId &&
                    !post.visuals.some((visual) => visual.id === post.creativeVariantId) ? (
                      <SelectItem value={'__empty_option__'}>Keep the current visual</SelectItem>
                    ) : null}
                    {post.visuals.map((visual) => (
                      <SelectItem key={visual.id} value={visual.id}>
                        {visual.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs font-medium text-foreground/65" htmlFor={ids.channel}>
                Account
              </Label>
              {usable === null ? (
                <p className="text-sm text-muted-foreground">Loading connected accounts…</p>
              ) : usable.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No {channelLabel} account is connected.{' '}
                  <Link
                    className="font-medium text-foreground underline-offset-4 hover:underline"
                    href="/settings/channels"
                  >
                    Connect one in Channels
                  </Link>
                </p>
              ) : (
                <Select
                  onValueChange={(nextValue) => setConnectionId(nextValue)}
                  value={connectionId}
                >
                  <SelectTrigger className={fieldClass} id={ids.channel}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {usable.map((connection) => (
                      <SelectItem key={connection.id} value={connection.id}>
                        {connection.externalAccountId} ({connection.platform})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs font-medium text-foreground/65" htmlFor={ids.time}>
                Publish at
              </Label>
              <div className="grid grid-cols-[1fr_8rem] gap-2">
                <DatePicker
                  aria-label="Publish day"
                  className="h-10 w-full rounded-lg"
                  id={ids.time}
                  onChange={setDay}
                  value={day}
                />
                <Input
                  aria-label="Publish time"
                  className={fieldClass}
                  onChange={(event) => setClock(event.target.value)}
                  type="time"
                  value={clock}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Leave empty to publish at the workspace&apos;s next default publish time.
              </p>
            </div>
            {error ? (
              <div
                className="flex flex-col gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
                role="alert"
              >
                {error}
                {error.startsWith(LINK_CHECK_PREFIX) ? (
                  <Button
                    className="w-fit rounded-lg"
                    disabled={busy}
                    onClick={() => void schedule(true)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Schedule without the link check
                  </Button>
                ) : null}
              </div>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                className="rounded-lg"
                onClick={() => setOpen(false)}
                size="sm"
                type="button"
                variant="ghost"
              >
                Close
              </Button>
              <Button
                className="rounded-lg"
                disabled={busy || !connectionId || !hasVisual}
                size="sm"
                type="submit"
              >
                {busy ? 'Scheduling…' : reschedule ? 'Reschedule' : 'Schedule'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
