'use client'

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AtIcon } from '@phosphor-icons/react/dist/ssr/At'
import { CaretDownIcon } from '@phosphor-icons/react/dist/ssr/CaretDown'
import { CheckIcon } from '@phosphor-icons/react/dist/ssr/Check'
import { LockSimpleIcon } from '@phosphor-icons/react/dist/ssr/LockSimple'
import { SparkleIcon } from '@phosphor-icons/react/dist/ssr/Sparkle'
import { WarningCircleIcon } from '@phosphor-icons/react/dist/ssr/WarningCircle'
import { XIcon } from '@phosphor-icons/react/dist/ssr/X'
import { SidebarLink } from '@/components/platform-shell/SidebarLink'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  AI_EFFORT_LABELS,
  AI_MODEL_TIER_LIST,
  AI_MODEL_TIERS,
  aiEffortSchema,
  type AiEffort,
  type AiModelTier,
  resolveEffectivePreference,
  surfaceToAiSlot,
  tierRequiresApiKey,
} from '@/lib/ai/models/tiers'
import type { AssistantContextRef } from '@/lib/api/contracts/ai'
import type { AssistantSurfaceKind } from '@/lib/assistant/page-context'
import { useTRPC } from '@/lib/trpc/react'
import { cn } from '@/lib/utils'
import {
  setAssistantModelOverride,
  toggleAssistantContextRef,
  useAssistantStore,
} from './assistant-store'

const KIND_LABELS: Record<AssistantContextRef['kind'], string> = {
  'brand-kit': 'Brand kit',
  campaign: 'Campaign',
  surface: 'Page',
}

/**
 * Compact above-composer ribbon combining explicit `@` workspace context pins
 * (Brand Kits, Product Pages, Campaigns), the inline `Model · Effort ▾` picker
 * with BYOK gating for Sonnet & Opus, and a low-credit badge when monthly
 * credits dip below 20%.
 */
export function AssistantContextRibbon({
  disabled,
  mode,
  surface,
}: {
  disabled?: boolean
  mode: 'bar' | 'dock'
  surface?: AssistantSurfaceKind
}) {
  const trpc = useTRPC()
  const [contextOpen, setContextOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)

  const contextRefs = useAssistantStore((state) => state.contextRefs)
  const modelTierOverride = useAssistantStore((state) => state.modelTierOverride)
  const effortOverride = useAssistantStore((state) => state.effortOverride)

  const readiness = useQuery(
    trpc.workspace.readiness.queryOptions(undefined, {
      refetchOnWindowFocus: false,
      staleTime: 5 * 60_000,
    })
  )
  const billing = useQuery(
    trpc.billing.summary.queryOptions(undefined, {
      refetchOnWindowFocus: false,
      staleTime: 5 * 60_000,
    })
  )

  const slot = surfaceToAiSlot(surface)
  const hasAiProviderKey = Boolean(readiness.data?.hasAiProviderKey)
  const slotDefault = resolveEffectivePreference(readiness.data?.aiModelDefaults, slot)
  const rawActiveTier: AiModelTier = modelTierOverride ?? slotDefault.tier
  const activeTier: AiModelTier =
    !hasAiProviderKey && tierRequiresApiKey(rawActiveTier) ? 'fast' : rawActiveTier
  const activeEffort: AiEffort = effortOverride ?? slotDefault.effort

  useEffect(() => {
    if (readiness.data && !hasAiProviderKey && modelTierOverride && tierRequiresApiKey(modelTierOverride)) {
      setAssistantModelOverride(null, effortOverride)
    }
  }, [effortOverride, hasAiProviderKey, modelTierOverride, readiness.data])
  const tierMeta = AI_MODEL_TIERS[activeTier]
  const isOverridden = modelTierOverride !== null || effortOverride !== null

  const credits = billing.data?.paid ? billing.data.credits : null
  const creditPercent =
    credits && credits.included > 0 ? Math.round((credits.left / credits.included) * 100) : null
  const lowCredits = creditPercent !== null && creditPercent < 20

  const hasContextOptions = Boolean(
    readiness.data &&
      (readiness.data.brandKits.length > 0 ||
        readiness.data.surfaces.length > 0 ||
        readiness.data.campaigns.length > 0)
  )

  function isPinned(kind: AssistantContextRef['kind'], id: string): boolean {
    return contextRefs.some((item) => item.kind === kind && item.id === id)
  }

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-1.5 px-1 text-[0.71875rem]',
        mode === 'bar' && 'justify-between'
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <Popover onOpenChange={setContextOpen} open={contextOpen}>
          <PopoverTrigger asChild>
            <Button
              aria-label="Pin workspace context"
              className="inline-flex h-6 items-center gap-1 rounded-full border border-foreground/12 bg-card px-2 text-[0.71875rem] text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground"
              disabled={disabled}
              size={null}
              title="Pin a brand kit, product page, or campaign to this chat"
              type="button"
              variant="custom"
            >
              <AtIcon aria-hidden="true" className="size-3 shrink-0" />
              <span>Context</span>
              {contextRefs.length > 0 ? (
                <span className="rounded-full bg-foreground/10 px-1 text-[0.625rem] font-medium text-foreground tabular-nums">
                  {contextRefs.length}
                </span>
              ) : null}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 p-2" side="top">
            <div className="mb-1.5 flex items-center justify-between px-1.5">
              <span className="text-xs font-medium text-foreground">Pin workspace context</span>
              {contextRefs.length > 0 ? (
                <Button
                  className="h-5 px-1.5 text-[0.6875rem] text-muted-foreground"
                  onClick={() => useAssistantStore.setState({ contextRefs: [] })}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Clear
                </Button>
              ) : null}
            </div>
            {readiness.isLoading ? (
              <p className="px-1.5 py-3 text-xs text-muted-foreground">Loading workspace items…</p>
            ) : readiness.isError ? (
              <div className="flex items-center justify-between gap-2 px-1.5 py-2.5 text-xs text-muted-foreground">
                <span>Could not load workspace items.</span>
                <Button
                  className="h-6 px-2 text-xs"
                  onClick={() => void readiness.refetch()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Retry
                </Button>
              </div>
            ) : !hasContextOptions ? (
              <p className="px-1.5 py-3 text-xs text-muted-foreground">
                Add a brand kit, product page, or campaign to pin it directly to a thread.
              </p>
            ) : (
              <div className="max-h-64 space-y-2 overflow-y-auto">
                {readiness.data?.brandKits.length ? (
                  <ContextSection
                    isPinned={(id) => isPinned('brand-kit', id)}
                    items={readiness.data.brandKits}
                    onToggle={(item) =>
                      toggleAssistantContextRef({
                        id: item.id,
                        kind: 'brand-kit',
                        label: item.name.trim().slice(0, 120) || 'Brand kit',
                      })
                    }
                    title="Brand kits"
                  />
                ) : null}
                {readiness.data?.surfaces.length ? (
                  <ContextSection
                    isPinned={(id) => isPinned('surface', id)}
                    items={readiness.data.surfaces}
                    onToggle={(item) =>
                      toggleAssistantContextRef({
                        id: item.id,
                        kind: 'surface',
                        label: item.name.trim().slice(0, 120) || 'Product page',
                      })
                    }
                    title="Product pages"
                  />
                ) : null}
                {readiness.data?.campaigns.length ? (
                  <ContextSection
                    isPinned={(id) => isPinned('campaign', id)}
                    items={readiness.data.campaigns}
                    onToggle={(item) =>
                      toggleAssistantContextRef({
                        id: item.id,
                        kind: 'campaign',
                        label: item.name.trim().slice(0, 120) || 'Campaign',
                      })
                    }
                    title="Campaigns"
                  />
                ) : null}
              </div>
            )}
          </PopoverContent>
        </Popover>

        {contextRefs.map((ref) => (
          <span
            className="inline-flex max-w-36 items-center gap-1 rounded-full border border-foreground/15 bg-foreground/[0.04] px-2 py-0.5 text-foreground/85"
            key={`${ref.kind}:${ref.id}`}
            title={`${KIND_LABELS[ref.kind]}: ${ref.label}`}
          >
            <span className="truncate">{ref.label}</span>
            <Button
              aria-label={`Remove ${ref.label} from context`}
              className="grid size-3.5 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
              onClick={() => toggleAssistantContextRef(ref)}
              size={null}
              type="button"
              variant="custom"
            >
              <XIcon aria-hidden="true" className="size-2.5" />
            </Button>
          </span>
        ))}
      </div>

      <div className="ms-auto flex items-center gap-1.5">
        {lowCredits ? (
          <SidebarLink
            className={cn(
              'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[0.6875rem] font-medium tabular-nums transition-colors',
              creditPercent <= 5
                ? 'border-red-500/30 bg-red-500/10 text-red-700 hover:bg-red-500/15 dark:text-red-300'
                : 'border-amber-500/30 bg-amber-500/10 text-amber-800 hover:bg-amber-500/15 dark:text-amber-300'
            )}
            href="/settings/ai-models"
            title="Monthly AI credits running low — manage models & usage"
          >
            <WarningCircleIcon aria-hidden="true" className="size-3 shrink-0" />
            <span>{creditPercent}% left</span>
          </SidebarLink>
        ) : null}

        <Popover onOpenChange={setModelOpen} open={modelOpen}>
          <PopoverTrigger asChild>
            <Button
              aria-label={`Model ${tierMeta.modelName}, ${AI_EFFORT_LABELS[activeEffort].label} effort`}
              className={cn(
                'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[0.71875rem] transition-colors',
                isOverridden
                  ? 'border-foreground/25 bg-foreground/[0.06] text-foreground'
                  : 'border-foreground/12 bg-card text-muted-foreground hover:border-foreground/25 hover:text-foreground'
              )}
              disabled={disabled}
              size={null}
              title="Choose model tier and reasoning effort for this chat"
              type="button"
              variant="custom"
            >
              <SparkleIcon aria-hidden="true" className="size-3 shrink-0 opacity-75" />
              <span className="max-w-[9.5rem] truncate">
                {tierMeta.label} · {AI_EFFORT_LABELS[activeEffort].short}
              </span>
              <CaretDownIcon aria-hidden="true" className="size-2.5 shrink-0 opacity-65" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-2.5" side="top">
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="text-xs font-medium text-foreground">Model &amp; reasoning</span>
              {isOverridden ? (
                <Button
                  className="h-5 px-1.5 text-[0.6875rem] text-muted-foreground"
                  onClick={() => setAssistantModelOverride(null, null)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Use default
                </Button>
              ) : null}
            </div>

            <div className="space-y-1">
              {AI_MODEL_TIER_LIST.map((tier) => {
                const selected = tier.id === activeTier
                const locked = tier.requiresApiKey && !hasAiProviderKey
                return (
                  <Button
                    className={cn(
                      'flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors',
                      locked
                        ? 'cursor-not-allowed text-muted-foreground opacity-65'
                        : selected
                          ? 'bg-foreground/[0.07] text-foreground'
                          : 'text-foreground/85 hover:bg-foreground/[0.04]'
                    )}
                    disabled={locked}
                    key={tier.id}
                    onClick={() => setAssistantModelOverride(tier.id, activeEffort)}
                    size={null}
                    title={
                      locked
                        ? 'Connect your OpenRouter API key in Settings → Models & usage to unlock'
                        : undefined
                    }
                    type="button"
                    variant="custom"
                  >
                    <span className="mt-0.5 grid size-3.5 shrink-0 place-items-center">
                      {locked ? (
                        <LockSimpleIcon aria-hidden="true" className="size-3" />
                      ) : selected ? (
                        <CheckIcon aria-hidden="true" className="size-3" />
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2 text-xs font-medium">
                        <span>
                          {tier.label} · {tier.modelName}
                        </span>
                        <span className="text-[0.6875rem] font-normal text-muted-foreground tabular-nums">
                          {locked ? 'API key' : tier.requiresApiKey ? 'BYOK' : 'Included'}
                        </span>
                      </span>
                      <span className="mt-0.5 block text-[0.6875rem] leading-snug text-muted-foreground">
                        {tier.description}
                      </span>
                    </span>
                  </Button>
                )
              })}
            </div>

            <div className="mt-2.5 border-t border-border pt-2.5">
              <div className="flex items-center justify-between gap-2 px-1">
                <span className="text-[0.71875rem] font-medium text-muted-foreground">
                  Reasoning effort
                </span>
                <div className="inline-flex rounded-lg border border-border p-0.5">
                  {aiEffortSchema.options.map((level) => (
                    <Button
                      className={cn(
                        'rounded-md px-2 py-0.5 text-[0.6875rem] transition-colors',
                        activeEffort === level
                          ? 'bg-foreground text-background'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                      key={level}
                      onClick={() => setAssistantModelOverride(activeTier, level)}
                      size={null}
                      type="button"
                      variant="custom"
                    >
                      {AI_EFFORT_LABELS[level].label}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="mt-2 flex items-center justify-between px-1 text-[0.6875rem] text-muted-foreground">
                <span>{hasAiProviderKey ? 'BYOK connected' : 'Haiku included'}</span>
                <SidebarLink
                  className="underline underline-offset-2 hover:text-foreground"
                  href="/settings/ai-models"
                  onNavigate={() => setModelOpen(false)}
                >
                  {hasAiProviderKey ? 'Workspace defaults' : 'Add API key'}
                </SidebarLink>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}

function ContextSection({
  isPinned,
  items,
  onToggle,
  title,
}: {
  isPinned: (id: string) => boolean
  items: readonly { id: string; name: string }[]
  onToggle: (item: { id: string; name: string }) => void
  title: string
}) {
  return (
    <div>
      <p className="px-1.5 pb-1 text-[0.6875rem] font-medium text-muted-foreground">{title}</p>
      <div className="space-y-0.5">
        {items.map((item) => {
          const checked = isPinned(item.id)
          return (
            <Button
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs transition-colors',
                checked
                  ? 'bg-foreground/[0.07] text-foreground'
                  : 'text-foreground/85 hover:bg-foreground/[0.04]'
              )}
              key={item.id}
              onClick={() => onToggle(item)}
              size={null}
              type="button"
              variant="custom"
            >
              <span className="grid size-3.5 shrink-0 place-items-center">
                {checked ? <CheckIcon aria-hidden="true" className="size-3" /> : null}
              </span>
              <span className="truncate">{item.name}</span>
            </Button>
          )
        })}
      </div>
    </div>
  )
}
