'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { Group, Pill, Row } from '@/components/platform-ui'
import { useTRPCClient } from '@/lib/trpc/react'
import { SettingsSaveBar } from '@/components/settings/SettingsSaveBar'
import { useUnsavedSettings } from '@/components/settings/useUnsavedSettings'
import { WritingInheritance } from '@/components/settings/WritingInheritance'
import { SaveStatus, useSaveState } from '@/components/settings/controls'
import { ConfirmDialog } from '@/components/settings/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  deleteWritingSampleContract,
  listWritingSamplesContract,
  socialSetSchema,
  type styleGuideSchema,
  writingSampleSchema,
} from '@/lib/api/contracts/social-sets'
import { settingsErrorMessage } from '@/lib/settings/client'
import { socialSetKey, useSocialSetScope } from './scope'
import { type SocialSetRecord, useStoreSocialSet } from './api'

type StyleGuide = z.input<typeof styleGuideSchema>

const STATUS: Record<
  SocialSetRecord['writingAssistant']['status'],
  { label: string; text: string; tone: 'gray' | 'green' | 'purple' | 'yellow' }
> = {
  attention: {
    label: 'Needs attention',
    text: 'The assistant is set up, but AI is turned off for this workspace, so it cannot help. An owner or admin can turn AI on in General settings.',
    tone: 'yellow',
  },
  configured: {
    label: 'Ready',
    text: "AI help in this publishing brand's drafts writes with this style guide and these samples, on top of the workspace brand voice.",
    tone: 'green',
  },
  disabled: {
    label: 'Turned off',
    text: 'AI help uses only the workspace brand voice until you turn the assistant back on.',
    tone: 'gray',
  },
  in_progress: {
    label: 'Being set up',
    text: 'You have started a style guide or samples. Create the assistant to have AI help use them.',
    tone: 'purple',
  },
  not_configured: {
    label: 'Not set up',
    text: 'Add a few writing samples or a style guide, then create the assistant so AI help writes like this publishing brand.',
    tone: 'gray',
  },
}

/** The drafts of a set as the import menu needs them. */
const draftChoicesSchema = z.object({
  items: z.array(z.object({ id: z.string(), plainText: z.string(), title: z.string() })),
})

const lines = (value: string[]) => value.join('\n')
const list = (value: string) =>
  value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)

function Lifecycle({ canWrite, set }: { canWrite: boolean; set: SocialSetRecord }) {
  const scope = useSocialSetScope()
  const store = useStoreSocialSet()
  const assistant = set.writingAssistant
  const status = STATUS[assistant.status]
  const act = async (action: 'create' | 'disable' | 'enable') => {
    try {
      await store(
        await scope.request(
          `/api/v1/social-sets/${encodeURIComponent(set.id)}/writing-assistant`,
          socialSetSchema,
          {
            body: { action, baseVersion: set.version },
            method: 'PUT',
          }
        )
      )
      toast.success(action === 'disable' ? 'The assistant is off.' : 'The assistant is ready.')
    } catch (error) {
      toast.error(settingsErrorMessage(error))
    }
  }
  const ready = assistant.sampleCount > 0 || assistant.status === 'in_progress'
  return (
    <Row
      description={status.text}
      label={
        <span className="flex items-center gap-2">
          Writing Assistant <Pill tone={status.tone}>{status.label}</Pill>
        </span>
      }
    >
      <div className="grid gap-2">
        <p className="text-xs text-muted-foreground">
          Open or create a draft in this publishing brand, then use AI help in the composer.
        </p>
        <div className="flex flex-wrap gap-2">
          {assistant.status === 'not_configured' || assistant.status === 'in_progress' ? (
            <Button
              disabled={!canWrite || !ready}
              onClick={() => void act('create')}
              title={ready ? undefined : 'Add a writing sample or a style guide first.'}
              type="button"
            >
              Create assistant
            </Button>
          ) : null}
          {assistant.status === 'configured' || assistant.status === 'attention' ? (
            <Button
              disabled={!canWrite}
              onClick={() => void act('disable')}
              type="button"
              variant="outline"
            >
              Turn off
            </Button>
          ) : null}
          {assistant.status === 'disabled' ? (
            <Button
              disabled={!canWrite}
              onClick={() => void act('enable')}
              type="button"
              variant="outline"
            >
              Turn on
            </Button>
          ) : null}
          <Button asChild variant="outline">
            <Link href={`/publish?set=${encodeURIComponent(set.id)}`}>
              Create a draft to use Writing Assistant
            </Link>
          </Button>
        </div>
      </div>
    </Row>
  )
}

function StyleGuideForm({ canWrite, set }: { canWrite: boolean; set: SocialSetRecord }) {
  const scope = useSocialSetScope()
  const store = useStoreSocialSet()
  const [state, run] = useSaveState()
  const client = useTRPCClient()
  const defaults = useQuery({
    enabled: scope.ready,
    queryKey: [...socialSetKey(scope, set.id), 'writing-defaults'],
    queryFn: async ({ signal }) => {
      scope.assertCurrent()
      const result = await client.brandProfile.defaults.query(
        { userId: scope.userId, workspaceId: scope.workspaceId },
        { signal }
      )
      scope.assertCurrent()
      return result
    },
  })
  const [guide, setGuide] = useState<StyleGuide>(set.writingAssistant.styleGuide)
  const previousGuide = useRef(JSON.stringify(set.writingAssistant.styleGuide))
  useEffect(() => {
    const previous = previousGuide.current
    previousGuide.current = JSON.stringify(set.writingAssistant.styleGuide)
    setGuide((current) =>
      JSON.stringify(current) === previous ? set.writingAssistant.styleGuide : current
    )
  }, [set.writingAssistant.styleGuide])
  const dirty = JSON.stringify(guide) !== JSON.stringify(set.writingAssistant.styleGuide)
  useUnsavedSettings(dirty)
  const inherited = (key: 'audience' | 'tone' | 'formatting') =>
    key === 'formatting'
      ? 'No extra formatting rules'
      : defaults.isPending
        ? 'Loading…'
        : defaults.isError
          ? 'Could not load workspace default'
          : defaults.data?.[key] || 'Not set'
  const reset = (key: keyof StyleGuide, value: unknown) => (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      disabled={!canWrite || state === 'saving'}
      onClick={() => setGuide({ ...guide, [key]: value })}
    >
      Reset to workspace default
    </Button>
  )
  const field = (key: 'audience' | 'formatting' | 'tone', label: string, placeholder: string) => (
    <div className="grid gap-1 text-sm">
      <Label htmlFor={`style-${set.id}-${key}`} className="font-medium text-foreground">
        {label}
      </Label>
      <Input
        id={`style-${set.id}-${key}`}
        disabled={!canWrite || state === 'saving'}
        onChange={(event) => setGuide({ ...guide, [key]: event.target.value })}
        placeholder={placeholder}
        value={guide[key]}
      />
      <span className="text-xs text-muted-foreground">
        Workspace default: {inherited(key)}. {guide[key] ? 'Override entered' : 'Inherited'}.
      </span>
      {reset(key, '')}
    </div>
  )
  const area = (
    key: 'endings' | 'openings' | 'prohibitedPhrases' | 'terminology',
    label: string,
    hint: string
  ) => (
    <div className="grid gap-1 text-sm">
      <Label htmlFor={`style-${set.id}-${key}`} className="font-medium text-foreground">
        {label}
      </Label>
      <span className="text-xs text-muted-foreground">{hint}</span>
      <Textarea
        id={`style-${set.id}-${key}`}
        disabled={!canWrite || state === 'saving'}
        onChange={(event) => setGuide({ ...guide, [key]: list(event.target.value) })}
        rows={3}
        value={lines(guide[key])}
      />
      <span className="text-xs text-muted-foreground">
        Workspace default:{' '}
        {key === 'prohibitedPhrases'
          ? defaults.isPending
            ? 'Loading…'
            : defaults.isError
              ? 'Could not load workspace rules'
              : defaults.data?.prohibitedPhrases.join(', ') || 'No terms set'
          : 'No additional instructions'}
        . {key === 'prohibitedPhrases' ? 'Workspace rules always remain in effect.' : ''}
      </span>
      {reset(key, [])}
    </div>
  )
  return (
    <Row
      description="Refines the workspace brand voice for this publishing brand. The brand voice's prohibited terms always apply; phrases you add here are avoided as well."
      label={
        <span className="flex items-center gap-2">
          Style guide <SaveStatus state={state} />
        </span>
      }
      layout="stacked"
    >
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          void run(async () => {
            try {
              const next = await scope.request(
                `/api/v1/social-sets/${encodeURIComponent(set.id)}/writing-assistant`,
                socialSetSchema,
                {
                  body: { baseVersion: set.version, styleGuide: guide },
                  method: 'PUT',
                }
              )
              setGuide(next.writingAssistant.styleGuide)
              await store(next)
              return { ok: true }
            } catch (error) {
              return { error: settingsErrorMessage(error), ok: false }
            }
          })
        }}
      >
        <div className="grid gap-4 md:grid-cols-2">
          {field('tone', 'Tone', 'Warm, direct, a little dry')}
          {field('audience', 'Audience', 'Founders of small SaaS teams')}
        </div>
        {field('formatting', 'Formatting', 'Short lines, no hashtags, one emoji at most')}
        <div className="grid gap-4 md:grid-cols-2">
          {area(
            'terminology',
            'Preferred terms',
            'One per line, such as "workspace" rather than "account".'
          )}
          {area('prohibitedPhrases', 'Phrases to avoid', 'One per line.')}
          {area('openings', 'Example openings', 'One per line.')}
          {area('endings', 'Example endings', 'One per line.')}
        </div>
        <fieldset className="grid gap-2" disabled={!canWrite || state === 'saving'}>
          <legend className="text-ui-lg font-medium text-foreground">Platform guidance</legend>
          {(['x', 'linkedin', 'threads', 'bluesky', 'mastodon', 'instagram'] as const).map(
            (platform) => (
              <div className="grid gap-1 text-sm" key={platform}>
                <Label
                  htmlFor={`style-${set.id}-${platform}`}
                  className="text-xs text-muted-foreground"
                >
                  {platform}
                </Label>
                <Input
                  id={`style-${set.id}-${platform}`}
                  disabled={!canWrite}
                  onChange={(event) =>
                    setGuide({
                      ...guide,
                      platformGuidance: {
                        ...guide.platformGuidance,
                        [platform]: event.target.value,
                      },
                    })
                  }
                  value={guide.platformGuidance[platform] ?? ''}
                />
                <span className="text-xs text-muted-foreground">
                  Workspace default: no platform-specific instructions.
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setGuide({
                      ...guide,
                      platformGuidance: { ...guide.platformGuidance, [platform]: '' },
                    })
                  }
                >
                  Reset to workspace default
                </Button>
              </div>
            )
          )}
        </fieldset>
        <SettingsSaveBar
          dirty={dirty}
          busy={state === 'saving'}
          disabled={!canWrite}
          label="Save style guide"
          onDiscard={() => setGuide(set.writingAssistant.styleGuide)}
        />
      </form>
    </Row>
  )
}

function WritingSamples({ canWrite, set }: { canWrite: boolean; set: SocialSetRecord }) {
  const scope = useSocialSetScope()
  const queryClient = useQueryClient()
  const store = useStoreSocialSet()
  const key = [...socialSetKey(scope, set.id), 'samples'] as const
  const samples = useQuery({
    enabled: scope.ready,
    queryFn: ({ signal }) =>
      scope.request(
        `/api/v1/social-sets/${encodeURIComponent(set.id)}/writing-samples`,
        listWritingSamplesContract.output,
        { signal }
      ),
    queryKey: key,
  })
  const drafts = useQuery({
    enabled: scope.ready,
    queryFn: ({ signal }) =>
      scope.request(
        `/api/v1/content-drafts?socialSetId=${encodeURIComponent(set.id)}&limit=50`,
        draftChoicesSchema,
        { signal }
      ),
    queryKey: [...socialSetKey(scope, set.id), 'drafts'],
  })
  const [text, setText] = useState('')
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: key })
    await store(
      await scope.request(`/api/v1/social-sets/${encodeURIComponent(set.id)}`, socialSetSchema)
    )
  }
  const add = async (body: { draftId: string } | { text: string }) => {
    try {
      await scope.request(
        `/api/v1/social-sets/${encodeURIComponent(set.id)}/writing-samples`,
        writingSampleSchema,
        { body, method: 'POST' }
      )
      await refresh()
      setText('')
      toast.success('Sample added.')
    } catch (error) {
      toast.error(settingsErrorMessage(error))
    }
  }
  const items = samples.isError ? [] : (samples.data?.items ?? [])
  return (
    <Row
      description="Posts that sound like this publishing brand. Write one here or import a draft of this publishing brand; drafts of other publishing brands are never read. The assistant treats samples as examples of style, not as instructions."
      label={`Writing samples (${items.length} of 20)`}
      layout="stacked"
    >
      {samples.isError ? (
        <p className="text-sm text-red-700 dark:text-red-300">
          {settingsErrorMessage(samples.error)}
        </p>
      ) : null}
      <ul className="grid gap-2">
        {items.map((sample) => (
          <li className="rounded-lg border border-border px-3 py-2" key={sample.id}>
            <details>
              <summary className="cursor-pointer text-sm text-foreground">
                {sample.text.slice(0, 90)}
                {sample.text.length > 90 ? '…' : ''}
                <span className="ml-2 text-xs text-muted-foreground">
                  {sample.source === 'draft' ? 'From a draft' : 'Written here'} ·{' '}
                  {new Date(sample.createdAt).toLocaleDateString()}
                </span>
              </summary>
              <p className="mt-2 whitespace-pre-wrap text-sm text-foreground/80">{sample.text}</p>
              {canWrite ? (
                <div className="mt-2">
                  <ConfirmDialog
                    confirmLabel="Remove sample"
                    description="The assistant stops learning from it. The draft it came from, if any, is not changed."
                    destructive
                    onConfirm={async () => {
                      try {
                        await scope.request(
                          `/api/v1/social-sets/${encodeURIComponent(set.id)}/writing-samples/${encodeURIComponent(sample.id)}`,
                          deleteWritingSampleContract.output,
                          { method: 'DELETE' }
                        )
                        await refresh()
                        return null
                      } catch (error) {
                        return settingsErrorMessage(error)
                      }
                    }}
                    title="Remove this sample?"
                    triggerLabel="Remove"
                  />
                </div>
              ) : null}
            </details>
          </li>
        ))}
      </ul>
      {canWrite ? (
        <div className="grid gap-3">
          <form
            className="grid gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (text.trim()) void add({ text: text.trim() })
            }}
          >
            <Textarea
              aria-label="New writing sample"
              maxLength={5000}
              onChange={(event) => setText(event.target.value)}
              placeholder="Paste a post that sounds like this publishing brand"
              rows={3}
              value={text}
            />
            <div>
              <Button disabled={!text.trim() || items.length >= 20} type="submit" variant="outline">
                Add sample
              </Button>
            </div>
          </form>
          <Label className="grid gap-1 text-sm">
            <span className="text-xs text-muted-foreground">
              Import a draft of this publishing brand
            </span>
            <Select
              disabled={items.length >= 20}
              onValueChange={(draftId) => void add({ draftId })}
              value=""
            >
              <SelectTrigger
                aria-label="Import a draft of this publishing brand"
                className="w-full bg-card"
              >
                <SelectValue placeholder="Choose a draft…" />
              </SelectTrigger>
              <SelectContent>
                {(drafts.isError ? [] : (drafts.data?.items ?? []))
                  .filter((draft) => draft.plainText.trim())
                  .map((draft) => (
                    <SelectItem key={draft.id} value={draft.id}>
                      {draft.title}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </Label>
        </div>
      ) : null}
    </Row>
  )
}

/** A set's Writing Assistant: its state, style guide and samples. */
export function WritingAssistantPage({
  canWrite,
  set,
}: {
  canWrite: boolean
  set: SocialSetRecord
}) {
  return (
    <div className="grid gap-6">
      <WritingInheritance />
      <Group>
        <Lifecycle canWrite={canWrite} set={set} />
      </Group>
      <Group>
        <StyleGuideForm canWrite={canWrite} set={set} />
      </Group>
      <Group>
        <WritingSamples canWrite={canWrite} set={set} />
      </Group>
    </div>
  )
}
