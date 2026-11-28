'use client'

import { type FormEvent, useState } from 'react'
import { KeyExpiry } from '@/components/settings/KeyExpiry'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  apiKeyScopeDescriptions,
  apiKeyScopes,
  defaultAgentScopes,
  type ApiKeyScope,
} from '@/lib/auth/api-key-scopes'

const fieldLabel = 'text-xs font-medium text-foreground/65'

export type CreateApiKeyPayload = {
  expiresInDays?: number
  name: string
  scopes: ApiKeyScope[]
}

/**
 * Modal dialog for creating a scoped workspace API key for the REST API, CLI,
 * or non-OAuth agents. High-trust scopes (`post:publish`, `post:delete`) are
 * never pre-selected unless chosen via explicit checkbox or preset.
 */
export function CreateApiKeyDialog({
  isSubmitting,
  onCreate,
  onOpenChange,
  open,
}: {
  isSubmitting: boolean
  onCreate: (payload: CreateApiKeyPayload) => Promise<boolean>
  onOpenChange: (open: boolean) => void
  open: boolean
}) {
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<ApiKeyScope[]>([...defaultAgentScopes])

  function resetForm(): void {
    setName('')
    setScopes([...defaultAgentScopes])
  }

  function handleOpenChange(next: boolean): void {
    if (!next && isSubmitting) return
    if (!next) resetForm()
    onOpenChange(next)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (isSubmitting || name.trim().length < 2 || scopes.length === 0) return
    const data = new FormData(event.currentTarget)
    const rawExpiry = data.get('expiresInDays')
    const expiresInDays =
      rawExpiry && rawExpiry !== 'never' ? Number(rawExpiry) : undefined
    const created = await onCreate({
      expiresInDays,
      name: name.trim(),
      scopes,
    })
    if (created) {
      handleOpenChange(false)
    }
  }

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create API key</DialogTitle>
          <DialogDescription>
            API keys authenticate the REST API, CLI, and clients without OAuth. Pick only the
            scopes this integration needs; keys are shown once.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-5" onSubmit={(event) => void handleSubmit(event)}>
          <div className="grid gap-3 sm:grid-cols-[1fr_11rem]">
            <div className="flex flex-col gap-1.5">
              <Label className={fieldLabel} htmlFor="create-api-key-name">
                Key name
              </Label>
              <Input
                autoFocus
                className="h-10 rounded-lg"
                id="create-api-key-name"
                maxLength={32}
                minLength={2}
                name="name"
                onChange={(event) => setName(event.target.value)}
                placeholder="CLI / CI publishing"
                required
                value={name}
              />
            </div>
            <KeyExpiry id="create-api-key-expires" />
          </div>

          <fieldset className="flex flex-col gap-3">
            <legend className={`mb-1 ${fieldLabel}`}>Scopes</legend>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => setScopes(['artifact:read'])}
                size="sm"
                type="button"
                variant="outline"
              >
                Read only
              </Button>
              <Button
                onClick={() => setScopes([...defaultAgentScopes])}
                size="sm"
                type="button"
                variant="outline"
              >
                Draft &amp; assets
              </Button>
              <Button
                onClick={() => setScopes(['artifact:read', 'post:schedule'])}
                size="sm"
                type="button"
                variant="outline"
              >
                Approved scheduling
              </Button>
              <Button
                onClick={() =>
                  setScopes([
                    'artifact:read',
                    'asset:write',
                    'draft:write',
                    'post:publish',
                    'post:schedule',
                    'upload:sign',
                  ])
                }
                size="sm"
                type="button"
                variant="outline"
              >
                Direct posting
              </Button>
            </div>
            <div className="grid gap-2.5 sm:grid-cols-2">
              {apiKeyScopes.map((scope) => (
                <div
                  className="flex min-w-0 items-start gap-2 rounded-lg border border-border/60 bg-foreground/[0.015] p-2.5"
                  key={scope}
                >
                  <Checkbox
                    checked={scopes.includes(scope)}
                    className="mt-0.5"
                    id={`dialog-scope-${scope}`}
                    name="scopes"
                    onCheckedChange={(checked) =>
                      setScopes((current) =>
                        checked === true
                          ? [...new Set([...current, scope])]
                          : current.filter((item) => item !== scope)
                      )
                    }
                    value={scope}
                  />
                  <Label
                    className="flex min-w-0 flex-col items-start gap-0.5 text-xs"
                    htmlFor={`dialog-scope-${scope}`}
                  >
                    <span className="font-mono font-medium text-foreground">{scope}</span>
                    <span className="font-normal leading-snug text-muted-foreground">
                      {apiKeyScopeDescriptions[scope]}
                    </span>
                  </Label>
                </div>
              ))}
            </div>
          </fieldset>

          <DialogFooter>
            <Button
              disabled={isSubmitting}
              onClick={() => handleOpenChange(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={isSubmitting || name.trim().length < 2 || scopes.length === 0}
              type="submit"
            >
              {isSubmitting ? 'Creating…' : 'Create API key'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
