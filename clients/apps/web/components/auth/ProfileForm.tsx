'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { z } from 'zod'
import { Group, Row } from '@/components/platform-ui'
import { SaveStatus, useSaveState } from '@/components/settings/controls'
import { useUnsavedSettings } from '@/components/settings/useUnsavedSettings'
import { Input } from '@/components/ui/input'
import { authClient } from '@/lib/auth/client'
import { getAuthErrorMessage } from './error-message'
import { Label } from '@/components/ui/label'

const profileSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name.').max(100),
})

type ProfileFormProps = {
  email: string
  name: string
}

export function ProfileForm({ email, name }: ProfileFormProps) {
  const router = useRouter()
  const [savedName, setSavedName] = useState(name)
  const [draftName, setDraftName] = useState(name)
  const dirty = draftName !== savedName
  useUnsavedSettings(dirty)
  const [state, run] = useSaveState()

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!dirty || state === 'saving') return
    const input = profileSchema.safeParse(Object.fromEntries(new FormData(event.currentTarget)))
    const saved = await run(async () => {
      if (!input.success)
        return { error: input.error.issues[0]?.message ?? 'Check the form values.', ok: false }
      try {
        const result = await authClient.updateUser(input.data)
        if (result.error) throw new Error(result.error.message || 'Could not update your profile.')
        return { ok: true }
      } catch (requestError) {
        return {
          error: getAuthErrorMessage(requestError, 'Could not update your profile.'),
          ok: false,
        }
      }
    })
    if (!saved || !input.success) return
    setSavedName(input.data.name)
    setDraftName(input.data.name)
    router.refresh()
  }

  return (
    <Group>
      <Row
        description="Shown to your teammates across the workspace."
        label={
          <span className="flex items-center gap-2">
            <Label htmlFor="profile-name">Name</Label> <SaveStatus state={state} />
          </span>
        }
      >
        {/* The form holds only the name, so Enter submits it. noValidate: zod reports an
            empty name, where the browser's check would pull focus back on blur. */}
        <form noValidate onSubmit={handleSubmit}>
          <Input
            autoComplete="name"
            className="h-10 rounded-lg md:w-72"
            value={draftName}
            // The name saves when you leave the field or press Enter, like the time zone below.
            onBlur={(event) => event.currentTarget.form?.requestSubmit()}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setDraftName(savedName)
            }}
            disabled={state === 'saving'}
            maxLength={100}
            id="profile-name"
            name="name"
            required
          />
        </form>
      </Row>
      <Row
        description="Used to sign in and receive notifications. Use Change email below to update it."
        label={<Label htmlFor="profile-email">Email</Label>}
      >
        <Input
          className="h-10 cursor-not-allowed rounded-lg text-muted-foreground md:w-72"
          defaultValue={email}
          disabled
          id="profile-email"
          type="email"
        />
      </Row>
    </Group>
  )
}
