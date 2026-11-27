'use client'

import { useRouter } from 'next/navigation'
import { type FormEvent, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { SidebarLink } from '@/components/platform-shell/SidebarLink'
import { Group, Pill, Row, Section } from '@/components/platform-ui'
import { SettingsSaveBar } from '@/components/settings/SettingsSaveBar'
import { useUnsavedSettings } from '@/components/settings/useUnsavedSettings'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { getErrorMessage } from '@/components/workspace/settings-client'
import { AI_INSTRUCTIONS_MAX } from '@/lib/ai/models/tiers'
import { useTRPC, useTRPCClient } from '@/lib/trpc/react'

type WorkspaceAiInstructionsSettingsProps = {
  canManage: boolean
  organization: {
    workspaceSettings?: {
      aiInstructions?: string | null
    } | null
  }
}

const STARTER_RULES: readonly { label: string; text: string }[] = [
  {
    label: 'Cite PR numbers',
    text: '- Reference GitHub PR numbers or release tags when summarizing shipped features.',
  },
  {
    label: 'Concise B2B tone',
    text: '- Keep copy direct, technical, and scannable. Lead with the concrete user outcome.',
  },
  {
    label: 'Dark 16:9 default visuals',
    text: '- Default to dark high-contrast backgrounds and 16:9 aspect ratio for product announcement visuals unless asked otherwise.',
  },
  {
    label: 'Avoid hype words',
    text: '- Never use filler superlatives ("game-changing", "revolutionary", "seamless", "elevate").',
  },
]

/**
 * Settings → AI & Agents → Instructions:
 * Workspace-wide standing rules layered underneath Brand Voice & Prohibited Terms
 * across Ask AI and visual editor copilots.
 */
export function WorkspaceAiInstructionsSettings({
  canManage,
  organization,
}: WorkspaceAiInstructionsSettingsProps) {
  const router = useRouter()
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const queryClient = useQueryClient()
  const [saved, setSaved] = useState(organization.workspaceSettings?.aiInstructions ?? '')
  const [value, setValue] = useState(saved)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trimmed = value.trim()
  const dirty = trimmed !== saved.trim()
  useUnsavedSettings(dirty)

  function appendStarter(rule: string) {
    setValue((current) => {
      const next = current.trim() ? `${current.trimEnd()}\n${rule}` : rule
      return next.slice(0, AI_INSTRUCTIONS_MAX)
    })
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!canManage || isSaving || !dirty) return
    setIsSaving(true)
    setError(null)
    try {
      const updated = await trpcClient.workspace.updateAiSettings.mutate({
        aiInstructions: trimmed ? trimmed : null,
      })
      const persisted = updated.settings.aiInstructions ?? ''
      setSaved(persisted)
      setValue(persisted)
      void queryClient.invalidateQueries({ queryKey: trpc.workspace.readiness.queryKey() })
      router.refresh()
      toast.success('Workspace AI instructions saved.')
    } catch (requestError) {
      setError(getErrorMessage(requestError))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <form className="flex flex-col gap-10" onSubmit={handleSubmit}>
      <Section
        description="Standing instructions apply automatically across Ask AI and in-editor copilots."
        title="Rule precedence"
      >
        <Group>
          <Row
            description="Prohibited claims, banned phrases, and required brand voice always win. Instructions below never override them."
            label="1. Brand voice & prohibited terms"
            layout="inline"
          >
            <div className="flex items-center gap-2">
              <Pill tone="green">Locked</Pill>
              <SidebarLink
                className="text-xs font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
                href="/settings/brand-kit"
              >
                Edit brand voice
              </SidebarLink>
            </div>
          </Row>
          <Row
            description="Applies to every workspace member across unified Ask AI surfaces."
            label="2. Workspace instructions"
            layout="inline"
          >
            <Pill tone="blue">Below</Pill>
          </Row>
          <Row
            description="Per-profile tone overrides when drafting for a specific publishing identity."
            label="3. Publishing profile style"
            layout="inline"
          >
            <SidebarLink
              className="text-xs font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
              href="/settings/publishing-brands"
            >
              Manage profiles
            </SidebarLink>
          </Row>
        </Group>
      </Section>

      <Section
        description="Describe formatting conventions, visual defaults, terminology, or workflow habits Shots AI should follow."
        title="Workspace instructions"
      >
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <Group>
          <Row>
            <div className="flex flex-col gap-3">
              <Textarea
                aria-label="Workspace AI instructions"
                className="min-h-[11rem] resize-y rounded-lg font-sans text-sm leading-relaxed"
                disabled={!canManage}
                maxLength={AI_INSTRUCTIONS_MAX}
                onChange={(event) => setValue(event.target.value)}
                placeholder="Example: Always write in US English, cite PR numbers for release summaries, and default announcement screenshots to dark 16:9 frames."
                value={value}
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                {canManage ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">Add rule:</span>
                    {STARTER_RULES.map((rule) => (
                      <Button
                        className="h-6 rounded-full px-2.5 text-xs"
                        key={rule.label}
                        onClick={() => appendStarter(rule.text)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        + {rule.label}
                      </Button>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Only workspace owners and admins can edit workspace instructions.
                  </p>
                )}
                <span className="ms-auto text-xs text-muted-foreground tabular-nums">
                  {value.length.toLocaleString('en-US')} /{' '}
                  {AI_INSTRUCTIONS_MAX.toLocaleString('en-US')}
                </span>
              </div>
            </div>
          </Row>
        </Group>

        {canManage ? (
          <SettingsSaveBar
            busy={isSaving}
            dirty={dirty}
            onDiscard={() => {
              setValue(saved)
              setError(null)
            }}
          />
        ) : null}
      </Section>
    </form>
  )
}
