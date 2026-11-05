'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { ChannelIcon } from '@/components/drafts/channel-meta'
import { Group, Pill, Row } from '@/components/platform-ui'
import { SaveStatus, useSaveState } from '@/components/settings/controls'
import { useUnsavedSettings } from '@/components/settings/useUnsavedSettings'
import { socialSetHref } from '@/components/workspace/settings-sections'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { draftPlatformSchema } from '@/lib/api/contracts/social-sets'
import { channelForPlatform } from '@/lib/content-drafts/serialize'
import { type SocialSetRecord, useSaveSocialSet } from './api'

type Engagement = SocialSetRecord['engagementDefaults']

function DefaultPlatforms({ canManage, set }: { canManage: boolean; set: SocialSetRecord }) {
  const save = useSaveSocialSet(set.id)
  const [state, run] = useSaveState()
  const connected = set.accounts
    .filter((account) => account.health !== 'removed')
    .flatMap((account) => {
      const platform = channelForPlatform(account.platform)
      return platform ? [{ ...account, platform }] : []
    })
  const enabled = set.defaultPlatforms.filter((platform) =>
    connected.some((account) => account.platform === platform)
  )
  const others = connected.filter((account) => !enabled.includes(account.platform))
  const primary =
    set.primaryPlatform && enabled.includes(set.primaryPlatform)
      ? set.primaryPlatform
      : (enabled[0] ?? null)

  const commit = (platforms: string[], nextPrimary: string | null = primary) =>
    run(() =>
      save({
        defaultPlatforms: platforms.map((platform) => draftPlatformSchema.parse(platform)),
        primaryPlatform:
          nextPrimary && platforms.includes(nextPrimary)
            ? draftPlatformSchema.parse(nextPrimary)
            : platforms[0]
              ? draftPlatformSchema.parse(platforms[0])
              : '',
      })
    )
  const move = (index: number, by: number) => {
    const next = [...enabled]
    const [item] = next.splice(index, 1)
    next.splice(index + by, 0, item!)
    void commit(next)
  }
  const label = (platform: string) => {
    const account = connected.find((candidate) => candidate.platform === platform)
    return account?.displayName ?? account?.handle ?? platform
  }

  return (
    <Row
      description="New drafts in this profile start with these platforms, in this order. The primary platform's text is the draft; each other platform follows it until you edit that platform's text, and from then on keeps its own."
      label={
        <span className="flex items-center gap-2">
          Default platforms <SaveStatus state={state} />
        </span>
      }
      layout="stacked"
    >
      {connected.length === 0 ? (
        <p className="text-sm text-muted-foreground">Connect an account to choose defaults.</p>
      ) : (
        <ol aria-label="Default platforms in order" className="grid gap-2">
          {enabled.map((platform, index) => {
            const channel = channelForPlatform(platform)
            return (
              <li
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
                key={platform}
              >
                <span className="flex items-center gap-2 text-sm">
                  <span className="w-5 text-xs text-muted-foreground">{index + 1}.</span>
                  {channel ? <ChannelIcon channel={channel} className="size-4" /> : null}
                  <span className="font-medium text-foreground">{label(platform)}</span>
                  <span className="text-muted-foreground">{platform}</span>
                  {platform === primary ? <Pill tone="blue">Primary</Pill> : null}
                </span>
                <span className="flex flex-wrap gap-1">
                  <Button
                    aria-label={`Move ${platform} up`}
                    disabled={!canManage || index === 0}
                    onClick={() => move(index, -1)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    ↑
                  </Button>
                  <Button
                    aria-label={`Move ${platform} down`}
                    disabled={!canManage || index === enabled.length - 1}
                    onClick={() => move(index, 1)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    ↓
                  </Button>
                  {platform === primary ? null : (
                    <Button
                      disabled={!canManage}
                      onClick={() => void commit(enabled, platform)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      Make primary
                    </Button>
                  )}
                  <Button
                    disabled={!canManage}
                    onClick={() => void commit(enabled.filter((item) => item !== platform))}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Turn off
                  </Button>
                </span>
              </li>
            )
          })}
          {others.map((account) => (
            <li
              className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-border px-3 py-2"
              key={account.id}
            >
              <span className="text-sm text-muted-foreground">
                {account.displayName ?? account.handle ?? account.platform} · {account.platform} ·
                off for new drafts
              </span>
              <Button
                disabled={!canManage}
                onClick={() => void commit([...enabled, account.platform])}
                size="sm"
                type="button"
                variant="outline"
              >
                Turn on
              </Button>
            </li>
          ))}
        </ol>
      )}
      <Link className="w-fit text-sm underline" href={`${socialSetHref(set.id)}#accounts`}>
        Connect more accounts
      </Link>
    </Row>
  )
}

function EngagementDefaults({ canManage, set }: { canManage: boolean; set: SocialSetRecord }) {
  const save = useSaveSocialSet(set.id)
  const [state, run] = useSaveState()
  const [draft, setDraft] = useState<Engagement>(set.engagementDefaults)
  const previousValue = useRef(JSON.stringify(set.engagementDefaults))
  useEffect(() => {
    const previous = previousValue.current
    previousValue.current = JSON.stringify(set.engagementDefaults)
    setDraft((current) => (JSON.stringify(current) === previous ? set.engagementDefaults : current))
  }, [set.engagementDefaults])
  const dirty = JSON.stringify(draft) !== JSON.stringify(set.engagementDefaults)
  useUnsavedSettings(dirty)
  const hasX = set.accounts.some(
    (account) => account.platform === 'x' && account.health === 'connected'
  )
  const isValid = (value: Engagement) =>
    (!value.autoRepost.enabled || value.autoRepost.atLikes >= 1) &&
    (!value.autoPlug.enabled ||
      (value.autoPlug.atLikes >= 1 && (value.autoPlug.text ?? '').trim().length > 0))
  // Saves on change once the defaults are complete; useSaveSocialSet runs saves in order.
  // While a save is pending, set.engagementDefaults is stale, so a change back to it still saves.
  const commit = (next: Engagement) => {
    setDraft(next)
    const changed =
      state === 'saving' || JSON.stringify(next) !== JSON.stringify(set.engagementDefaults)
    if (isValid(next) && changed) void run(() => save({ engagementDefaults: next }))
  }
  const disabled = !canManage || !hasX

  return (
    <Row
      description={
        hasX
          ? 'New X posts from this profile start with these follow-ups. Nothing reaches X until a draft is scheduled, and posts already out are not changed.'
          : 'These follow-ups are for X. Connect an X account to this profile to use them.'
      }
      label={
        <span className="flex items-center gap-2">
          X engagement defaults <SaveStatus state={state} />
        </span>
      }
      layout="stacked"
    >
      <div className="grid gap-4">
        <fieldset className="grid gap-2" disabled={disabled}>
          <legend className="sr-only">Auto-Retweet</legend>
          <Label className="flex items-center gap-3 text-sm">
            <Switch
              aria-label="Auto-Retweet"
              checked={draft.autoRepost.enabled}
              disabled={disabled}
              onCheckedChange={(enabled) =>
                commit({
                  ...draft,
                  autoRepost: {
                    ...draft.autoRepost,
                    atLikes: draft.autoRepost.atLikes || 50,
                    enabled,
                  },
                })
              }
            />
            <span className="font-medium text-foreground">Auto-Retweet</span>
            <span className="text-muted-foreground">Repost once a post has</span>
            <Input
              aria-label="Auto-Retweet likes"
              className="w-24"
              min={1}
              onBlur={() => commit(draft)}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  autoRepost: { ...draft.autoRepost, atLikes: Number(event.target.value) },
                })
              }
              type="number"
              value={draft.autoRepost.atLikes || ''}
            />
            <span className="text-muted-foreground">likes</span>
          </Label>
        </fieldset>
        <fieldset className="grid gap-2" disabled={disabled}>
          <legend className="sr-only">Auto-Plug</legend>
          <Label className="flex flex-wrap items-center gap-3 text-sm">
            <Switch
              aria-label="Auto-Plug"
              checked={draft.autoPlug.enabled}
              disabled={disabled}
              onCheckedChange={(enabled) =>
                commit({
                  ...draft,
                  autoPlug: { ...draft.autoPlug, atLikes: draft.autoPlug.atLikes || 50, enabled },
                })
              }
            />
            <span className="font-medium text-foreground">Auto-Plug</span>
            <span className="text-muted-foreground">Reply once a post has</span>
            <Input
              aria-label="Auto-Plug likes"
              className="w-24"
              min={1}
              onBlur={() => commit(draft)}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  autoPlug: { ...draft.autoPlug, atLikes: Number(event.target.value) },
                })
              }
              type="number"
              value={draft.autoPlug.atLikes || ''}
            />
            <span className="text-muted-foreground">likes, with</span>
          </Label>
          <Input
            aria-label="Auto-Plug reply text"
            maxLength={280}
            onBlur={() => commit(draft)}
            onChange={(event) =>
              setDraft({ ...draft, autoPlug: { ...draft.autoPlug, text: event.target.value } })
            }
            placeholder="The reply, such as a link to your newsletter"
            value={draft.autoPlug.text ?? ''}
          />
        </fieldset>
        {dirty && !isValid(draft) ? (
          <p className="text-xs text-muted-foreground">
            Not saved yet: each follow-up needs at least 1 like, and Auto-Plug needs its reply text.
          </p>
        ) : null}
      </div>
    </Row>
  )
}

/** What a new draft in the set starts with. Existing drafts keep their own. */
export function NewDraftPage({ canManage, set }: { canManage: boolean; set: SocialSetRecord }) {
  return (
    <div className="grid gap-6">
      <Group>
        <DefaultPlatforms canManage={canManage} set={set} />
      </Group>
      <Group>
        <EngagementDefaults canManage={canManage} set={set} />
      </Group>
      <p className="text-xs text-muted-foreground">
        Defaults are copied into each new draft when it is created. Changing them later does not
        change drafts that already exist.
      </p>
    </div>
  )
}
