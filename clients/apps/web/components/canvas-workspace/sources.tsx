'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTRPCClient } from '@/lib/trpc/react'
import type { ReleaseEvidence } from '@/lib/canvas/recipes'
import { releaseEvidence } from '@/lib/canvas/plan'
import { cn } from '@/lib/utils'

/**
 * Pickers for the records a canvas can start from. Each lists what the
 * workspace already has; nothing here writes.
 */

type Loaded<T> = { items: T[]; error: string | null; loading: boolean }

function useLoaded<T>(load: () => Promise<T[]>, deps: readonly unknown[]): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ items: [], error: null, loading: true })
  useEffect(() => {
    let active = true
    setState((previous) => ({ ...previous, loading: true }))
    load().then(
      (items) => {
        if (active) setState({ items, error: null, loading: false })
      },
      (error: unknown) => {
        if (active)
          setState({
            items: [],
            error: error instanceof Error ? error.message : 'Could not load this list.',
            loading: false,
          })
      }
    )
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return state
}

function List<T extends { id: string }>({
  state,
  empty,
  label,
  render,
  onPick,
  disabled,
}: {
  state: Loaded<T>
  empty: string
  label: string
  render: (item: T) => { title: string; detail?: string }
  onPick: (item: T) => void
  disabled?: boolean
}) {
  if (state.loading) return <p className="text-sm text-muted-foreground">Loading…</p>
  if (state.error)
    return (
      <p role="alert" className="text-sm text-destructive">
        {state.error}
      </p>
    )
  if (!state.items.length) return <p className="text-sm text-muted-foreground">{empty}</p>
  return (
    <ul aria-label={label} className="grid max-h-80 gap-1 overflow-y-auto pr-1">
      {state.items.map((item) => {
        const { title, detail } = render(item)
        return (
          <li key={item.id}>
            <Button
              variant="custom"
              size={null}
              type="button"
              disabled={disabled}
              onClick={() => onPick(item)}
              className="w-full rounded-lg border border-transparent px-3 py-2 text-left text-sm hover:border-foreground/10 hover:bg-foreground/[0.04] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring disabled:opacity-50"
            >
              <span className="block truncate font-medium">{title}</span>
              {detail ? (
                <span className="block truncate text-xs text-muted-foreground">{detail}</span>
              ) : null}
            </Button>
          </li>
        )
      })}
    </ul>
  )
}

/** Cloud projects from the screenshot editor. */
export function ProjectPicker({
  onPick,
  disabled,
}: {
  onPick: (id: string) => void
  disabled?: boolean
}) {
  const client = useTRPCClient()
  const state = useLoaded(
    () => client.project.list.query({ limit: 100 }).then((page) => page.items),
    [client]
  )
  return (
    <List
      state={state}
      label="Projects"
      empty="No cloud projects yet. Save one from the screenshot editor."
      render={(project) => ({ title: project.name, detail: `Revision ${project.revision}` })}
      onPick={(project) => onPick(project.id)}
      disabled={disabled}
    />
  )
}

/** Saved Story Sets; their native outputs copy onto the canvas. */
export function StorySetPicker({
  onPick,
  disabled,
}: {
  onPick: (id: string) => void
  disabled?: boolean
}) {
  const client = useTRPCClient()
  const state = useLoaded(
    () => client.creativeSet.list.query({ limit: 100 }).then((page) => page.items),
    [client]
  )
  return (
    <List
      state={state}
      label="Story Sets"
      empty="No Story Sets in this workspace."
      render={(set) => ({
        title: set.name,
        detail: set.document
          ? `${set.document.outputs.length} formats · revision ${set.revision}`
          : `Revision ${set.revision}`,
      })}
      onPick={(set) => onPick(set.id)}
      disabled={disabled}
    />
  )
}

/** A campaign's designs, including ones the launch pipeline generated. */
export function CampaignDesignPicker({
  onPick,
  disabled,
}: {
  onPick: (id: string) => void
  disabled?: boolean
}) {
  const client = useTRPCClient()
  const [campaignId, setCampaignId] = useState<string | null>(null)
  const campaigns = useLoaded(
    () => client.campaign.list.query().then((result) => result.campaigns),
    [client]
  )
  const designs = useLoaded(
    () =>
      campaignId
        ? client.design.listForCampaign.query({ campaignId }).then((result) => result.designs)
        : Promise.resolve([]),
    [client, campaignId]
  )
  if (!campaignId)
    return (
      <List
        state={campaigns}
        label="Campaigns"
        empty="No campaigns yet."
        render={(campaign) => ({ title: campaign.name, detail: campaign.status })}
        onPick={(campaign) => setCampaignId(campaign.id)}
        disabled={disabled}
      />
    )
  return (
    <div className="grid gap-2">
      <Button
        variant="link"
        size="sm"
        className="justify-self-start px-0"
        onClick={() => setCampaignId(null)}
      >
        ← All campaigns
      </Button>
      <List
        state={designs}
        label="Campaign designs"
        empty="This campaign has no designs yet."
        render={(design) => ({
          title: design.name,
          detail: [
            design.variantLabel,
            design.generated ? 'Generated' : null,
            design.approved ? 'Approved · copying keeps the approval unchanged' : null,
          ]
            .filter(Boolean)
            .join(' · '),
        })}
        onPick={(design) => onPick(design.id)}
        disabled={disabled}
      />
    </div>
  )
}

/** A chosen release, feature and screenshots, quoted exactly as the workspace recorded them. */
export type ReleaseChoice = {
  release: ReleaseEvidence
  featureIndex?: number
  screenshotAssetIds: string[]
}

/** Shipped releases and their features, for grounded announcements. */
export function ReleasePicker({
  onPick,
  disabled,
}: {
  onPick: (choice: ReleaseChoice) => void
  disabled?: boolean
}) {
  const client = useTRPCClient()
  const releases = useLoaded(
    () =>
      client.release.list
        .query({ limit: 100 })
        .then((result) => result.releases.filter((release) => release.status === 'READY')),
    [client]
  )
  const [releaseId, setReleaseId] = useState<string | null>(null)
  const release = releases.items.find((item) => item.id === releaseId)
  if (!release)
    return (
      <List
        state={releases}
        label="Releases"
        empty="No ready releases yet. Mark a shipped release ready to quote its features."
        render={(item) => ({
          title: item.title,
          detail: `${item.status.toLowerCase()} · ${item.features?.length ?? 0} features · ${item.screenshotAssetIds?.length ?? 0} screenshots`,
        })}
        onPick={(item) => setReleaseId(item.id)}
        disabled={disabled}
      />
    )
  const evidence = releaseEvidence(release)
  const screenshots = release.screenshotAssetIds ?? []
  return (
    <div className="grid gap-3">
      <Button
        variant="link"
        size="sm"
        className="justify-self-start px-0"
        onClick={() => setReleaseId(null)}
      >
        ← All releases
      </Button>
      <p className="text-ui-lg font-medium">{release.title}</p>
      {release.benefitStatement ? (
        <p className="text-xs text-muted-foreground">{release.benefitStatement}</p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {screenshots.length
          ? `${screenshots.length} recorded screenshots will be used.`
          : 'No recorded screenshots; you can add one after.'}
      </p>
      <div className="grid gap-1" role="group" aria-label="Release features">
        <Button
          variant="custom"
          size={null}
          type="button"
          disabled={disabled}
          onClick={() => onPick({ release: evidence, screenshotAssetIds: screenshots })}
          className={cn('rounded-lg border px-3 py-2 text-left text-sm hover:bg-foreground/[0.04]')}
        >
          Announce the whole release
        </Button>
        {evidence.features.map((feature, index) => (
          <Button
            variant="custom"
            size={null}
            key={`${index}:${feature.title}`}
            type="button"
            disabled={disabled}
            onClick={() =>
              onPick({ release: evidence, featureIndex: index, screenshotAssetIds: screenshots })
            }
            className="rounded-lg border px-3 py-2 text-left text-sm hover:bg-foreground/[0.04]"
          >
            {feature.title}
          </Button>
        ))}
      </div>
    </div>
  )
}
