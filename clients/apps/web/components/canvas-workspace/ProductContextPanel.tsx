'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useTRPCClient } from '@/lib/trpc/react'
import type { Artboard, ClaimStatus } from '@/lib/canvas/document'
import { buildRecipe } from '@/lib/canvas/recipes'
import { screenshotFromAsset } from '@/lib/canvas/create'
import { cn } from '@/lib/utils'
import { ReleasePicker, type ReleaseChoice } from './sources'
import type { PanelProps } from './CanvasPanels'

const STATUS: Record<ClaimStatus, { label: string; tone: string }> = {
  verified: { label: 'Verified', tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  suggested: {
    label: 'Suggested · confirm',
    tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  },
  confirmed: { label: 'Confirmed', tone: 'bg-sky-500/15 text-sky-700 dark:text-sky-300' },
}

type Release = Awaited<
  ReturnType<ReturnType<typeof useTRPCClient>['release']['get']['query']>
>['release']

/**
 * What an artboard (or the whole canvas) explains, and how far its words can
 * be trusted: each generated layer shows whether it quotes a product record,
 * is template language awaiting confirmation, or was edited since.
 */
export function ProductContextPanel({
  state,
  actions,
  canEdit,
  artboard,
}: PanelProps & { artboard: Artboard | null }) {
  const client = useTRPCClient()
  const context = artboard ? (artboard.context ?? {}) : state.document.context
  const [release, setRelease] = useState<Release | null>(null)
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    if (!context.releaseId) {
      setRelease(null)
      return
    }
    client.release.get.query({ releaseId: context.releaseId }).then(
      (found) => {
        if (active) setRelease(found.release)
      },
      () => {
        if (active) setRelease(null)
      }
    )
    return () => {
      active = false
    }
  }, [client, context.releaseId])

  function link(choice: ReleaseChoice) {
    const next = {
      ...context,
      releaseId: choice.release.id,
      feature:
        choice.featureIndex !== undefined
          ? choice.release.features[choice.featureIndex]?.title
          : undefined,
    }
    actions.run(
      artboard
        ? { type: 'set-artboard-context', id: artboard.id, context: next }
        : { type: 'set-context', context: next }
    )
    setPicking(false)
  }

  async function announce(choice: ReleaseChoice) {
    setBusy(true)
    try {
      const shots = []
      for (const [index, assetId] of choice.screenshotAssetIds.slice(0, 1).entries())
        shots.push(
          await screenshotFromAsset(client, assetId, `${choice.release.title} ${index + 1}`)
        )
      actions.addArtboards(
        buildRecipe('feature-announcement', {
          release: choice.release,
          featureIndex: choice.featureIndex,
          screenshots: shots,
        })
      )
      setPicking(false)
    } finally {
      setBusy(false)
    }
  }

  const claims = artboard?.provenance ?? []
  const textOf = (layerId: string) => artboard?.document.texts.find((text) => text.id === layerId)
  return (
    <section aria-label="Product context" className="space-y-3 border-b px-4 py-4">
      <h2 className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
        Product context{artboard ? ' · this artboard' : ''}
      </h2>
      {release ? (
        <div className="space-y-1 rounded-md border p-2">
          <p className="text-ui-lg font-medium">{release.title}</p>
          <p className="text-[11px] text-muted-foreground">
            Release · {release.status.toLowerCase()}
            {context.feature ? ` · ${context.feature}` : ''}
          </p>
          {release.features?.length ? (
            <ul className="list-disc pl-4 text-xs text-muted-foreground">
              {release.features.slice(0, 5).map((feature, index) => (
                <li key={`${index}:${feature.title}`}>{feature.title}</li>
              ))}
            </ul>
          ) : null}
          {release.sourceUrls?.[0] ? (
            <a
              className="block truncate text-[11px] underline"
              href={release.sourceUrls[0]}
              target="_blank"
              rel="noreferrer"
            >
              {release.sourceUrls[0]}
            </a>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {context.releaseId
            ? 'The linked release is not available.'
            : 'Not linked to a release yet.'}
        </p>
      )}
      {context.campaignId ? (
        <Link className="block text-xs underline" href={`/campaigns/${context.campaignId}`}>
          Open the linked campaign
        </Link>
      ) : null}
      {canEdit ? (
        <Button size="sm" variant="outline" onClick={() => setPicking(true)}>
          {context.releaseId ? 'Change release…' : 'Link a shipped release…'}
        </Button>
      ) : null}
      {artboard?.origin ? <Lineage artboard={artboard} /> : null}
      {claims.length ? (
        <div className="space-y-1.5">
          <h3 className="text-[11px] text-muted-foreground">Generated copy</h3>
          <ul className="space-y-1.5">
            {claims.map((claim) => {
              const layer = textOf(claim.layerId)
              const edited = layer && layer.text !== claim.generated
              return (
                <li key={claim.layerId} className="rounded-md border p-2 text-xs">
                  <p className="line-clamp-2">{layer?.text ?? claim.generated}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <span
                      className={cn('rounded px-1.5 py-0.5 text-[10px]', STATUS[claim.status].tone)}
                    >
                      {STATUS[claim.status].label}
                    </span>
                    {edited ? (
                      <span className="rounded bg-foreground/[0.06] px-1.5 py-0.5 text-[10px]">
                        Edited since generated
                      </span>
                    ) : null}
                    {!layer ? (
                      <span className="rounded bg-foreground/[0.06] px-1.5 py-0.5 text-[10px]">
                        Layer removed
                      </span>
                    ) : null}
                    {claim.reference ? (
                      <span className="truncate text-[10px] text-muted-foreground">
                        from {claim.reference.label}
                      </span>
                    ) : null}
                    {canEdit && claim.status === 'suggested' && layer ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ml-auto h-6 px-2 text-[11px]"
                        onClick={() =>
                          actions.run({
                            type: 'set-claim-status',
                            id: artboard!.id,
                            layerId: claim.layerId,
                            status: 'confirmed',
                          })
                        }
                      >
                        Confirm
                      </Button>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
          {claims.some((claim) => claim.status === 'suggested') ? (
            <p className="text-[11px] text-muted-foreground">
              Suggested lines are template wording. Confirm or rewrite them before they ship.
            </p>
          ) : null}
        </div>
      ) : null}
      {picking ? (
        <Dialog open onOpenChange={(open) => setPicking(open)}>
          <DialogContent className="max-w-lg">
            <DialogTitle>Shipped releases</DialogTitle>
            <DialogDescription>
              Link a release so this {artboard ? 'artboard' : 'canvas'} explains a real change, or
              create a grounded announcement from it.
            </DialogDescription>
            <PickRelease
              disabled={busy}
              onLink={link}
              onAnnounce={(choice) => void announce(choice)}
            />
          </DialogContent>
        </Dialog>
      ) : null}
    </section>
  )
}

function PickRelease({
  onLink,
  onAnnounce,
  disabled,
}: {
  onLink: (choice: ReleaseChoice) => void
  onAnnounce: (choice: ReleaseChoice) => void
  disabled: boolean
}) {
  const [choice, setChoice] = useState<ReleaseChoice | null>(null)
  if (!choice) return <ReleasePicker onPick={setChoice} disabled={disabled} />
  const feature =
    choice.featureIndex !== undefined
      ? choice.release.features[choice.featureIndex]?.title
      : undefined
  return (
    <div className="grid gap-2">
      <p className="text-sm">
        {choice.release.title}
        {feature ? ` · ${feature}` : ''}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={disabled} onClick={() => onLink(choice)}>
          Link only
        </Button>
        <Button variant="outline" disabled={disabled} onClick={() => onAnnounce(choice)}>
          Add an announcement artboard
        </Button>
        <Button variant="ghost" onClick={() => setChoice(null)}>
          Back
        </Button>
      </div>
    </div>
  )
}

function Lineage({ artboard }: { artboard: Artboard }) {
  const origin = artboard.origin!
  const when = 'copiedAt' in origin ? new Date(origin.copiedAt).toLocaleString() : null
  const text =
    origin.kind === 'project'
      ? `Copied from a project at revision ${origin.revision}`
      : origin.kind === 'story-set'
        ? `Copied from a Story Set at revision ${origin.revision}`
        : origin.kind === 'design'
          ? 'Copied from a campaign design; the original and its approval are unchanged'
          : `Started from the ${origin.id.replaceAll('-', ' ')} template`
  const href =
    origin.kind === 'story-set'
      ? `/creative-sets/${origin.id}`
      : origin.kind === 'design' && origin.campaignId
        ? `/campaigns/${origin.campaignId}/assets`
        : origin.kind === 'project'
          ? `/editor?project=${origin.id}`
          : null
  return (
    <div
      className="rounded-md bg-foreground/[0.03] p-2 text-[11px] text-muted-foreground"
      data-testid="artboard-lineage"
    >
      <p>{text}</p>
      {when ? <p>{when}</p> : null}
      {'documentHash' in origin ? (
        <p className="font-mono">sha256 {origin.documentHash.slice(0, 12)}…</p>
      ) : null}
      {href ? (
        <Link className="underline" href={href}>
          Open the source
        </Link>
      ) : null}
    </div>
  )
}
