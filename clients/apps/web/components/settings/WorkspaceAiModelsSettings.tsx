'use client'

import { useRouter } from 'next/navigation'
import { type FormEvent, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { setAssistantModelOverride } from '@/components/assistant/assistant-store'
import { CheckoutButton } from '@/components/platform-landing/CheckoutButton'
import { checkoutPathSchema } from '@/components/platform-landing/primitives'
import { SidebarLink } from '@/components/platform-shell/SidebarLink'
import { Group, Pill, Row, Section } from '@/components/platform-ui'
import { UsageMeterRow } from '@/components/settings/SegmentedMeter'
import { SettingsSaveBar } from '@/components/settings/SettingsSaveBar'
import { useUnsavedSettings } from '@/components/settings/useUnsavedSettings'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { getErrorMessage } from '@/components/workspace/settings-client'
import {
  AI_EFFORT_LABELS,
  AI_MODEL_TIER_LIST,
  AI_MODEL_TIERS,
  AI_SURFACE_SLOTS,
  aiEffortSchema,
  type AiEffort,
  type AiModelDefaults,
  type AiModelTier,
  type AiSurfaceSlot,
  parseWorkspaceAiDefaults,
  resolveEffectivePreference,
  tierRequiresApiKey,
} from '@/lib/ai/models/tiers'
import { useTRPC, useTRPCClient } from '@/lib/trpc/react'

type WorkspaceAiModelsSettingsProps = {
  canManage: boolean
  canManageBilling: boolean
  organization: {
    workspaceSettings?: {
      aiAgentEnabled: boolean
      aiModelDefaults?: Record<string, unknown> | null
      aiProviderKeyHint?: string | null
      hasAiProviderKey?: boolean
    } | null
  }
}

const INHERIT_VALUE = '__inherit__'

function normalizeDefaults(defaults: AiModelDefaults): AiModelDefaults {
  const clean: AiModelDefaults = {}
  for (const slot of AI_SURFACE_SLOTS) {
    const pref = defaults[slot.id]
    if (pref) clean[slot.id] = { effort: pref.effort, tier: pref.tier }
  }
  return clean
}

/**
 * Settings → AI & Agents → Models & usage:
 * Workspace-wide AI toggle, per-surface default model tier & reasoning effort
 * with explicit inheritance badges, and segmented monthly credit gauges.
 */
export function WorkspaceAiModelsSettings({
  canManage,
  canManageBilling,
  organization,
}: WorkspaceAiModelsSettingsProps) {
  const router = useRouter()
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const queryClient = useQueryClient()
  const [saved, setSaved] = useState(() => ({
    aiAgentEnabled: organization.workspaceSettings?.aiAgentEnabled ?? true,
    aiModelDefaults: normalizeDefaults(
      parseWorkspaceAiDefaults(organization.workspaceSettings?.aiModelDefaults)
    ),
  }))
  const [values, setValues] = useState(saved)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasAiProviderKey, setHasAiProviderKey] = useState(
    Boolean(organization.workspaceSettings?.hasAiProviderKey)
  )
  const [aiProviderKeyHint, setAiProviderKeyHint] = useState<string | null>(
    organization.workspaceSettings?.aiProviderKeyHint ?? null
  )
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [keyBusy, setKeyBusy] = useState(false)
  const [keyError, setKeyError] = useState<string | null>(null)

  const dirty = JSON.stringify(values) !== JSON.stringify(saved)
  useUnsavedSettings(dirty)

  const summaryQuery = useQuery(
    trpc.billing.summary.queryOptions(undefined, {
      refetchOnWindowFocus: false,
      staleTime: 60_000,
    })
  )
  const summary = summaryQuery.data ?? null

  const workspaceDefault = resolveEffectivePreference(values.aiModelDefaults, 'default')

  function setSlotTier(slot: AiSurfaceSlot, rawTier: string) {
    setError(null)
    if (rawTier !== INHERIT_VALUE && tierRequiresApiKey(rawTier as AiModelTier) && !hasAiProviderKey) {
      setError('Add your OpenRouter API key below to use Claude Sonnet 5.5 or Claude Opus 5.5.')
      return
    }
    setValues((current) => {
      const next = { ...current.aiModelDefaults }
      if (rawTier === INHERIT_VALUE && slot !== 'default') {
        delete next[slot]
      } else {
        const tier = rawTier as AiModelTier
        const existingEffort =
          next[slot]?.effort ?? resolveEffectivePreference(current.aiModelDefaults, slot).effort
        next[slot] = { effort: existingEffort, tier }
      }
      return { ...current, aiModelDefaults: normalizeDefaults(next) }
    })
  }

  function setSlotEffort(slot: AiSurfaceSlot, effort: AiEffort) {
    setError(null)
    setValues((current) => {
      const effective = resolveEffectivePreference(current.aiModelDefaults, slot)
      const nextTier = current.aiModelDefaults[slot]?.tier ?? effective.tier
      const safeTier: AiModelTier =
        !hasAiProviderKey && tierRequiresApiKey(nextTier) ? 'fast' : nextTier
      const next: AiModelDefaults = {
        ...current.aiModelDefaults,
        [slot]: { effort, tier: safeTier },
      }
      return { ...current, aiModelDefaults: normalizeDefaults(next) }
    })
  }

  async function handleSaveKey(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const trimmed = apiKeyInput.trim()
    if (!canManage || keyBusy || isSaving || trimmed.length < 16) return
    if (!/^[\x21-\x7e]{16,512}$/.test(trimmed)) {
      setKeyError('Enter a valid OpenRouter API key (16–512 characters, no spaces).')
      return
    }
    setKeyBusy(true)
    setKeyError(null)
    try {
      const updated = await trpcClient.workspace.updateAiSettings.mutate({
        aiProviderApiKey: trimmed,
      })
      setHasAiProviderKey(Boolean(updated.settings.hasAiProviderKey))
      setAiProviderKeyHint(updated.settings.aiProviderKeyHint ?? null)
      setApiKeyInput('')
      void queryClient.invalidateQueries({ queryKey: trpc.workspace.readiness.queryKey() })
      router.refresh()
      toast.success('OpenRouter API key saved. Sonnet and Opus are now unlocked.')
    } catch (requestError) {
      setKeyError(getErrorMessage(requestError))
    } finally {
      setKeyBusy(false)
    }
  }

  async function handleRemoveKey(): Promise<void> {
    if (!canManage || keyBusy || isSaving || !hasAiProviderKey) return
    setKeyBusy(true)
    setKeyError(null)
    try {
      const updated = await trpcClient.workspace.updateAiSettings.mutate({
        aiProviderApiKey: null,
      })
      const nextDefaults = normalizeDefaults(
        parseWorkspaceAiDefaults(updated.settings.aiModelDefaults)
      )
      setHasAiProviderKey(Boolean(updated.settings.hasAiProviderKey))
      setAiProviderKeyHint(updated.settings.aiProviderKeyHint ?? null)
      setSaved((current) => ({ ...current, aiModelDefaults: nextDefaults }))
      setValues((current) => ({ ...current, aiModelDefaults: nextDefaults }))
      setAssistantModelOverride(null, null)
      void queryClient.invalidateQueries({ queryKey: trpc.workspace.readiness.queryKey() })
      router.refresh()
      toast.success('OpenRouter API key removed. Defaults reset to Claude Haiku 5.5.')
    } catch (requestError) {
      setKeyError(getErrorMessage(requestError))
    } finally {
      setKeyBusy(false)
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!canManage || isSaving || keyBusy || !dirty) return
    setIsSaving(true)
    setError(null)
    try {
      const updated = await trpcClient.workspace.updateAiSettings.mutate({
        aiAgentEnabled: values.aiAgentEnabled,
        aiModelDefaults: values.aiModelDefaults,
      })
      const nextSaved = {
        aiAgentEnabled: updated.settings.aiAgentEnabled,
        aiModelDefaults: normalizeDefaults(
          parseWorkspaceAiDefaults(updated.settings.aiModelDefaults)
        ),
      }
      setSaved(nextSaved)
      setValues(nextSaved)
      void queryClient.invalidateQueries({ queryKey: trpc.workspace.readiness.queryKey() })
      void queryClient.invalidateQueries({ queryKey: ['editor-ai', 'status'] })
      router.refresh()
      toast.success('AI model defaults saved.')
    } catch (requestError) {
      setError(getErrorMessage(requestError))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-10">
      <form className="flex flex-col gap-10" onSubmit={handleSubmit}>
        <Section
          description="Claude Haiku 5.5 is included out of the box for every surface. Connect your own OpenRouter API key below to unlock Claude Sonnet 5.5 and Claude Opus 5.5."
          title="Default models"
        >
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <Group>
            <Row
              description="Allow workspace members to use Ask AI, editor copilots, caption writing, and AI campaign drafting."
              label="Workspace AI"
              layout="inline"
            >
              <div className="flex items-center gap-2.5">
                <Pill tone={values.aiAgentEnabled ? 'green' : 'gray'}>
                  {values.aiAgentEnabled ? 'Enabled' : 'Paused'}
                </Pill>
                <Switch
                  aria-label="Enable Workspace AI"
                  checked={values.aiAgentEnabled}
                  disabled={!canManage}
                  onCheckedChange={(checked) =>
                    setValues((current) => ({ ...current, aiAgentEnabled: checked }))
                  }
                />
              </div>
            </Row>

            {AI_SURFACE_SLOTS.map((slot) => {
              const effective = resolveEffectivePreference(values.aiModelDefaults, slot.id)
              const hasExplicit = Boolean(values.aiModelDefaults[slot.id])
              const tierSelectValue =
                slot.id !== 'default' && !hasExplicit ? INHERIT_VALUE : effective.tier
              const inheritedLabel =
                slot.id !== 'default' && !hasExplicit
                  ? effective.inheritedFrom === 'workspace'
                    ? 'Workspace'
                    : 'Default'
                  : null

              return (
                <Row
                  description={slot.description}
                  key={slot.id}
                  label={slot.label}
                  layout="split"
                >
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {inheritedLabel ? <Pill tone="gray">{inheritedLabel}</Pill> : null}
                    <Select
                      disabled={!canManage || !values.aiAgentEnabled}
                      onValueChange={(next) => setSlotTier(slot.id, next)}
                      value={tierSelectValue}
                    >
                      <SelectTrigger
                        aria-label={`${slot.label} model tier`}
                        className="h-8 w-[17rem] rounded-lg text-xs"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent align="end">
                        {slot.id !== 'default' ? (
                          <SelectItem value={INHERIT_VALUE}>
                            Inherit ({AI_MODEL_TIERS[workspaceDefault.tier].modelName})
                          </SelectItem>
                        ) : null}
                        {AI_MODEL_TIER_LIST.map((tier) => {
                          const locked = tier.requiresApiKey && !hasAiProviderKey
                          return (
                            <SelectItem disabled={locked} key={tier.id} value={tier.id}>
                              <span className="flex items-center gap-2">
                                <span>
                                  {tier.label} · {tier.modelName}
                                </span>
                                <span className="text-[0.6875rem] text-muted-foreground tabular-nums">
                                  {locked
                                    ? 'API key required'
                                    : tier.requiresApiKey
                                      ? 'BYOK'
                                      : 'Included'}
                                </span>
                              </span>
                            </SelectItem>
                          )
                        })}
                      </SelectContent>
                    </Select>

                    <Select
                      disabled={!canManage || !values.aiAgentEnabled}
                      onValueChange={(next) => setSlotEffort(slot.id, next as AiEffort)}
                      value={effective.effort}
                    >
                      <SelectTrigger
                        aria-label={`${slot.label} reasoning effort`}
                        className="h-8 w-[6.5rem] rounded-lg text-xs"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent align="end">
                        {aiEffortSchema.options.map((level) => (
                          <SelectItem key={level} value={level}>
                            {AI_EFFORT_LABELS[level].label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </Row>
              )
            })}
          </Group>

          {canManage ? (
            <SettingsSaveBar
              busy={isSaving || keyBusy}
              dirty={dirty}
              onDiscard={() => {
                setValues(saved)
                setError(null)
              }}
            />
          ) : (
            <p className="text-xs text-muted-foreground">
              Only workspace owners and admins can change default AI models.
            </p>
          )}
        </Section>
      </form>

      <Section
        description="Claude Haiku 5.5 runs out of the box on managed Shots credits. Connect your own OpenRouter API key to unlock Claude Sonnet 5.5 and Claude Opus 5.5 — billed directly to your OpenRouter account with zero data retention."
        title="Your API key"
      >
        {keyError ? (
          <Alert variant="destructive">
            <AlertDescription>{keyError}</AlertDescription>
          </Alert>
        ) : null}

        <Group>
          <Row
            description={
              hasAiProviderKey
                ? 'Balanced (Sonnet 5.5) and Deep (Opus 5.5) tiers are unlocked for all workspace members and bypass Shots credit billing.'
                : 'Required only for Claude Sonnet 5.5 and Claude Opus 5.5. Claude Haiku 5.5 works with no key.'
            }
            label="OpenRouter API key"
            layout="inline"
          >
            <div className="flex flex-wrap items-center justify-end gap-2">
              {hasAiProviderKey ? (
                <>
                  <Pill tone="green">Connected</Pill>
                  {aiProviderKeyHint ? (
                    <span className="rounded-md border border-border bg-muted/50 px-2 py-0.5 font-mono text-xs text-muted-foreground">
                      {aiProviderKeyHint}
                    </span>
                  ) : null}
                  {canManage ? (
                    <Button
                      disabled={keyBusy || isSaving}
                      onClick={() => void handleRemoveKey()}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      Remove key
                    </Button>
                  ) : null}
                </>
              ) : (
                <Pill tone="gray">Not connected</Pill>
              )}
            </div>
          </Row>

          {canManage ? (
            <Row
              description="Encrypted at rest with AES-256-GCM and never shown again after saving."
              label={hasAiProviderKey ? 'Replace API key' : 'Connect OpenRouter key'}
              layout="split"
            >
              <form
                className="flex w-full flex-wrap items-center justify-end gap-2"
                onSubmit={handleSaveKey}
              >
                <Input
                  aria-label="OpenRouter API key"
                  autoComplete="off"
                  className="h-8 w-full max-w-[16rem] rounded-lg font-mono text-xs"
                  disabled={keyBusy || isSaving}
                  maxLength={512}
                  onChange={(event) => {
                    setKeyError(null)
                    setApiKeyInput(event.target.value)
                  }}
                  placeholder="sk-or-v1-…"
                  spellCheck={false}
                  type="password"
                  value={apiKeyInput}
                />
                <Button
                  disabled={keyBusy || isSaving || apiKeyInput.trim().length < 16}
                  size="sm"
                  type="submit"
                >
                  {keyBusy ? 'Saving…' : hasAiProviderKey ? 'Update key' : 'Save key'}
                </Button>
              </form>
            </Row>
          ) : (
            <Row>
              <p className="text-xs text-muted-foreground">
                Only workspace owners and admins can connect or remove the workspace OpenRouter API
                key.
              </p>
            </Row>
          )}
        </Group>
      </Section>

      <Section
        description="Managed Shots credits cover Claude Haiku 5.5 out of the box with zero data retention. One credit equals one cent of AI cost."
        title="Credits & usage"
      >
        <Group>
          {summary === null ? (
            <Row>
              <p className="text-sm text-muted-foreground">
                {summaryQuery.error ? getErrorMessage(summaryQuery.error) : 'Loading credit usage…'}
              </p>
            </Row>
          ) : !summary.paid ? (
            <Row
              description="Choose a Pro or Business plan to unlock monthly AI credits and workspace assistants."
              label="No active plan"
              layout="inline"
            >
              <SidebarLink
                className="text-sm font-medium text-foreground underline underline-offset-4"
                href="/settings/billing"
              >
                View plans
              </SidebarLink>
            </Row>
          ) : (
            <>
              <UsageMeterRow
                allowance={summary.credits}
                description={`Resets ${new Date(summary.usagePeriod.resetsAt).toLocaleDateString(
                  undefined,
                  { dateStyle: 'medium', timeZone: 'UTC' }
                )} at 00:00 UTC.`}
                label="Monthly AI credits"
              />

              <Row
                description="Rollover credits spent automatically after your monthly allowance. Never expire."
                label="Extra launch credits"
                layout="split"
              >
                <div className="flex flex-wrap items-center justify-end gap-3">
                  <span className="text-sm font-medium text-foreground tabular-nums">
                    {summary.creditBalance.toLocaleString('en-US')} left
                  </span>
                  {canManageBilling ? (
                    <CheckoutButton
                      choices={[{ body: { pack: 'launch' }, label: 'Buy 500 credits ($12)' }]}
                      className="w-auto"
                      location="ai_models_extra_launch"
                      path={checkoutPathSchema.enum['/api/billing/credits']}
                      surface="app"
                    />
                  ) : null}
                </div>
              </Row>

              <UsageMeterRow
                allowance={summary.posts}
                description="Scheduled social posts left this month."
                label="Scheduled posts"
              />

              <UsageMeterRow
                allowance={summary.emails}
                description="Release emails left this month, counted per recipient."
                label="Release emails"
              />

              <Row
                description="Manage your subscription, payment method, and invoices."
                label="Billing & plan"
                layout="inline"
              >
                <SidebarLink
                  className="text-sm font-medium text-foreground underline underline-offset-4"
                  href="/settings/billing"
                >
                  Open billing
                </SidebarLink>
              </Row>
            </>
          )}
        </Group>
      </Section>
    </div>
  )
}
