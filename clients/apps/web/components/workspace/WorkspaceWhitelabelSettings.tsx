'use client'

import { useRouter } from 'next/navigation'
import { type FormEvent, useEffect, useState } from 'react'
import { Group, Row, Section } from '@/components/platform-ui'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { whitelabelSettingsSchema, type WhitelabelSettings } from '@/lib/whitelabeling'
import { getErrorMessage, requestJson } from './settings-client'

const FIELDS = [
  {
    description: 'Shown in place of Shots in the app. Up to 64 characters.',
    label: 'Brand name',
    name: 'brandName',
    placeholder: 'Acme',
  },
  {
    description: 'An https image link, shown square beside the name.',
    label: 'Logo URL',
    name: 'logoUrl',
    placeholder: 'https://cdn.acme.com/logo.png',
  },
  {
    description: 'An https image link for the browser tab.',
    label: 'Favicon URL',
    name: 'faviconUrl',
    placeholder: 'https://cdn.acme.com/favicon.png',
  },
  {
    description: 'Buttons and focus rings, as #rrggbb.',
    label: 'Primary color',
    name: 'primaryColor',
    placeholder: '#0A66FF',
  },
  {
    description: 'Hover and selected surfaces, as #rrggbb.',
    label: 'Accent color',
    name: 'accentColor',
    placeholder: '#33C482',
  },
] as const

export function WorkspaceWhitelabelSettings({
  canManage,
  organizationId,
}: {
  canManage: boolean
  organizationId: string
}) {
  const router = useRouter()
  const [settings, setSettings] = useState<WhitelabelSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    let current = true
    const query = new URLSearchParams({ organizationId })
    requestJson(`/api/enterprise/whitelabel?${query}`, whitelabelSettingsSchema)
      .then((loaded) => {
        if (current) setSettings(loaded)
      })
      .catch((requestError: unknown) => {
        if (current) setError(getErrorMessage(requestError))
      })
    return () => {
      current = false
    }
  }, [organizationId])

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setIsSaving(true)
    setError(null)
    try {
      const data = new FormData(event.currentTarget)
      const values = Object.fromEntries(FIELDS.map(({ name }) => [name, data.get(name)]))
      const saved = await requestJson('/api/enterprise/whitelabel', whitelabelSettingsSchema, {
        body: { ...values, organizationId },
        method: 'PUT',
      })
      setSettings(saved)
      // The shell reads the branding on the server.
      router.refresh()
    } catch (requestError) {
      setError(getErrorMessage(requestError))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Section
      description="Your name, logo and colors in the signed-in app, on the Enterprise plan. Changing them requires a recent sign-in and two-factor authentication."
      title="White label"
    >
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {settings ? (
        <form
          className="flex flex-col gap-4"
          key={JSON.stringify(settings)}
          onSubmit={(event) => void save(event)}
        >
          <Group>
            {FIELDS.map((field) => (
              <Row
                description={field.description}
                key={field.name}
                label={<Label htmlFor={`whitelabel-${field.name}`}>{field.label}</Label>}
              >
                <Input
                  className="h-10 rounded-lg md:w-72"
                  defaultValue={settings[field.name] ?? ''}
                  disabled={!canManage}
                  id={`whitelabel-${field.name}`}
                  name={field.name}
                  placeholder={field.placeholder}
                />
              </Row>
            ))}
          </Group>
          {canManage ? (
            <div className="flex justify-end">
              <Button className="rounded-lg" disabled={isSaving} type="submit">
                {isSaving ? 'Saving…' : 'Save branding'}
              </Button>
            </div>
          ) : null}
        </form>
      ) : null}
    </Section>
  )
}
