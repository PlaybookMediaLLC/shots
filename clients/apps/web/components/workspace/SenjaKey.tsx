'use client'

import { useCallback, useEffect, useState } from 'react'
import { Group, Pill, Row, Section } from '@/components/platform-ui'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  removeSenjaKeyContract,
  saveSenjaKeyContract,
  senjaStatusContract,
} from '@/lib/api/contracts/senja'
import { call } from '@/lib/content-drafts/client'

type Status = { configured: boolean; sealable: boolean }

/**
 * The workspace's own Senja API key, for importing video testimonials into
 * drafts. Senja has no OAuth app, so an owner or admin pastes the project's
 * key; Shots checks it with Senja, seals it, and never shows it again.
 */
export function SenjaKey({ canManage }: { canManage: boolean }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => {
    setError(null)
    call(senjaStatusContract.path)
      .then((body) => setStatus(senjaStatusContract.output.parse(body)))
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : 'Senja’s status could not be read.')
      )
  }, [])
  useEffect(load, [load])
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      setStatus(senjaStatusContract.output.parse(await action()))
      setKey('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Senja could not be updated.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section
      description="Import approved video testimonials from your Senja project into drafts. Paste the project’s API key from Senja’s Integrations page; Shots checks it with Senja and never shows it again."
      title="Senja"
    >
      <Group>
        {error ? (
          <Row>
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </Row>
        ) : null}
        <Row>
          {!status ? (
            error ? (
              <Button onClick={load} size="sm" variant="outline">
                Try again
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">Loading…</p>
            )
          ) : (
            <div className="grid w-full gap-3">
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm text-foreground">
                  {status.configured ? 'API key saved' : 'No API key yet'}
                </span>
                {status.configured ? <Pill tone="green">Connected</Pill> : null}
              </div>
              {!canManage ? (
                <p className="text-sm text-muted-foreground">
                  {status.configured
                    ? 'Owners and admins manage the key.'
                    : 'Ask an owner or admin to add the Senja API key.'}
                </p>
              ) : !status.sealable ? (
                <p className="text-sm text-muted-foreground">
                  This deployment cannot store keys until INTEGRATION_ENCRYPTION_KEY is set.
                </p>
              ) : (
                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void run(() =>
                      call(saveSenjaKeyContract.path, {
                        body: { apiKey: key },
                        method: 'PUT',
                      })
                    )
                  }}
                >
                  <div className="grid min-w-64 flex-1 gap-1">
                    <Label htmlFor="senja-key">
                      {status.configured ? 'Replace the API key' : 'Senja API key'}
                    </Label>
                    <Input
                      autoComplete="off"
                      id="senja-key"
                      onChange={(event) => setKey(event.target.value)}
                      type="password"
                      value={key}
                    />
                  </div>
                  <Button disabled={busy || key.trim().length < 8} size="sm" type="submit">
                    Save key
                  </Button>
                  {status.configured ? (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void run(() => call(removeSenjaKeyContract.path, { method: 'DELETE' }))
                      }
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      Remove
                    </Button>
                  ) : null}
                </form>
              )}
            </div>
          )}
        </Row>
      </Group>
    </Section>
  )
}
