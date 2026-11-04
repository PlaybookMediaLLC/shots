'use client'

import { type FormEvent, useState } from 'react'
import { Group, Row, Section } from '@/components/platform-ui'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTRPCClient } from '@/lib/trpc/react'
import { getErrorMessage } from './settings-client'

export function WorkspaceDeletionSettings({
  canDelete,
  workspaceName,
}: {
  canDelete: boolean
  workspaceName: string
}) {
  const trpcClient = useTRPCClient()
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  if (!canDelete) return null

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const confirmation = String(new FormData(event.currentTarget).get('confirmation') ?? '')
    setError(null)
    setIsSubmitting(true)
    try {
      await trpcClient.workspace.requestDeletion.mutate({ confirmation })
      window.location.reload()
    } catch (requestError) {
      setError(getErrorMessage(requestError))
      setIsSubmitting(false)
    }
  }

  return (
    <Section description="Irreversible after the 14-day restore window." title="Danger zone">
      <Group>
        <Row
          description="Access stops immediately. You can restore this workspace for 14 days before its data is purged. Two-factor authentication and a fresh sign-in are required."
          label="Delete workspace"
          layout="stacked"
        >
          <form className="flex w-full flex-col gap-3 sm:flex-row" onSubmit={handleSubmit}>
            <Input
              aria-label={`Type ${workspaceName} to confirm`}
              className="h-10 rounded-lg sm:max-w-xs"
              name="confirmation"
              placeholder={workspaceName}
              required
            />
            <Button
              className="rounded-lg"
              disabled={isSubmitting}
              type="submit"
              variant="destructive"
            >
              {isSubmitting ? 'Scheduling deletion…' : 'Schedule deletion'}
            </Button>
          </form>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </Row>
      </Group>
    </Section>
  )
}

export function WorkspaceDeletionRecovery({
  canRestore,
  scheduledFor,
}: {
  canRestore: boolean
  scheduledFor: Date
}) {
  const trpcClient = useTRPCClient()
  const [error, setError] = useState<string | null>(null)
  const [isRestoring, setIsRestoring] = useState(false)

  async function restore(): Promise<void> {
    setError(null)
    setIsRestoring(true)
    try {
      await trpcClient.workspace.cancelDeletion.mutate()
      window.location.assign('/settings')
    } catch (requestError) {
      setError(getErrorMessage(requestError))
      setIsRestoring(false)
    }
  }

  return (
    <section className="mx-auto mt-16 max-w-xl rounded-lg border border-destructive/30 bg-card p-6">
      <h1 className="text-xl font-semibold">Workspace deletion is scheduled</h1>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        Workspace access is suspended until you restore it. Data will be purged after{' '}
        {new Date(scheduledFor).toLocaleString()}.
      </p>
      {error ? (
        <Alert className="mt-4" variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {canRestore ? (
        <Button
          className="mt-5"
          disabled={isRestoring}
          onClick={() => void restore()}
          type="button"
        >
          {isRestoring ? 'Restoring…' : 'Restore workspace'}
        </Button>
      ) : (
        <p className="mt-5 text-sm text-muted-foreground">
          Only the owner who scheduled this deletion can restore the workspace.
        </p>
      )}
    </section>
  )
}
