import { LibraryIcon as Album02Icon } from '@/components/platform-shell/icons'
import { ChevronDownIcon as ArrowDown01Icon } from '@/components/platform-shell/icons'
import type { ReactNode } from 'react'
import { RevisePanel } from '@/components/launch/RevisePanel'
import { ApproveVisualButton } from '@/components/launch/assets/ApproveVisualButton'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { EmptyState, Pill, type PillTone, Section } from '@/components/platform-ui'
import type { CampaignPlanContent } from '@/lib/launch/spec-schema'
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion'

/**
 * The campaign's visuals, grouped by the plan asset each one realizes (A1,
 * A2…): editor designs with their render review, and product shots as the
 * fallback. A server component; only the approve and revise controls are
 * interactive.
 */

export type Critique = {
  brand: number
  issues: string[]
  legibility: number
  specFidelity: number
  verdict: 'fix' | 'pass'
}

export type BoardImage = { height: number | null; url: string | null; width: number | null }

export type BoardVisual = {
  /**
   * Whether this visual can be approved for the campaign's own posts.
   * Defaults to true; an export published through Publish is a record of
   * what went out, not a candidate the campaign publishes again.
   */
  approvable?: boolean
  /** The approved render of a design; null until a render is approved. */
  approvedVariant: { id: string; sourceAssetId: string } | null
  caption: string | null
  createdAt: number
  critique: Critique | null
  /** Editor designs can be revised; product shots have no design. */
  designId: string | null
  editHref: string
  /**
   * Made by producing an earlier plan version. Undefined for visuals made
   * before plan versions were recorded; those fall back to timestamps.
   */
  fromEarlierPlan?: boolean
  id: string
  /** Null until the design is rendered. */
  image: BoardImage | null
  name: string
  planAssetKey: string | null
  /** The design's current render; a re-render makes a new asset. */
  renderedAssetId: string | null
  variantLabel: string | null
}

export type BoardCapture = BoardImage & {
  caption: string | null
  device: 'Desktop' | 'Mobile'
  id: string
}

type PlanAsset = CampaignPlanContent['assets'][number]

type CardOptions = {
  aiConfigured: boolean
  campaignId: string
  canApprove: boolean
  canEdit: boolean
}

/** "feature_shot" → "Feature shot". */
function kindLabel(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1).replaceAll('_', ' ')
}

function scoreTone(score: number): PillTone {
  return score >= 4 ? 'green' : score === 3 ? 'yellow' : 'red'
}

function newestFirst(visuals: BoardVisual[]): BoardVisual[] {
  return [...visuals].sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * Every production run adds visuals. A visual's generation is how many newer
 * ones share its variant (A, B, or unlabeled): generation 0 is current, the
 * rest are earlier versions. Sorting by generation, then label, keeps each
 * A/B pair side by side.
 */
function splitVersions(visuals: BoardVisual[]) {
  const counts = new Map<string | null, number>()
  const ranked = newestFirst(visuals)
    .map((visual) => {
      const generation = counts.get(visual.variantLabel) ?? 0
      counts.set(visual.variantLabel, generation + 1)
      return { generation, visual }
    })
    .sort(
      (a, b) =>
        a.generation - b.generation ||
        (a.visual.variantLabel ?? '~').localeCompare(b.visual.variantLabel ?? '~')
    )
  return {
    current: ranked.filter((entry) => entry.generation === 0).map((entry) => entry.visual),
    earlier: ranked.filter((entry) => entry.generation > 0).map((entry) => entry.visual),
  }
}

function CritiqueSummary({ critique }: { critique: Critique }) {
  const scores = [
    ['Spec', critique.specFidelity],
    ['Brand', critique.brand],
    ['Legibility', critique.legibility],
  ] as const
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        <Pill tone={critique.verdict === 'pass' ? 'green' : 'yellow'}>
          {critique.verdict === 'pass' ? 'Passed review' : 'Needs a fix'}
        </Pill>
        {scores.map(([label, score]) => (
          <Pill key={label} tone={scoreTone(score)}>
            {label} {score}/5
          </Pill>
        ))}
      </div>
      {critique.issues.length > 0 ? (
        <Accordion type="single" collapsible>
          <AccordionItem value="details" className="group/issues text-xs">
            <AccordionTrigger className="[&>svg:last-child]:hidden flex w-fit cursor-pointer list-none items-center gap-1 text-foreground/65 transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
              {critique.issues.length} {critique.issues.length === 1 ? 'issue' : 'issues'} from
              review
              <ArrowDown01Icon
                className="transition-transform group-data-[state=open]/issues:rotate-180"
                size={14}
              />
            </AccordionTrigger>
            <AccordionContent className="p-0">
              <ul className="mt-2 list-disc space-y-1.5 pl-4 leading-5 text-foreground/65">
                {critique.issues.map((issue, index) => (
                  <li key={index}>{issue}</li>
                ))}
              </ul>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      ) : null}
    </div>
  )
}

function VisualCard({
  format,
  options,
  stale,
  visual,
}: {
  format: string | null
  options: CardOptions
  /** Made before the current plan version, which may use its key for something else. */
  stale: boolean
  visual: BoardVisual
}) {
  const approved = visual.approvedVariant !== null
  const changed = approved && visual.approvedVariant?.sourceAssetId !== visual.renderedAssetId
  return (
    <li className="flex flex-col overflow-hidden rounded-xl bg-foreground/[0.02] ring-1 ring-foreground/[0.08]">
      <div className="grid place-items-center bg-[radial-gradient(circle_at_center,#1a1a1a,#0c0c0c)] p-3">
        {visual.image?.url ? (
          // Signed, short-lived tenant URLs: next/image would cache them past expiry.
          <img
            alt={visual.caption ?? visual.name}
            className="h-auto max-h-96 w-auto max-w-full rounded-md"
            height={visual.image.height ?? undefined}
            loading="lazy"
            src={visual.image.url}
            width={visual.image.width ?? undefined}
          />
        ) : (
          <div
            className="grid max-h-96 w-full place-items-center rounded-md border border-dashed border-foreground/10 text-xs text-muted-foreground"
            style={{ aspectRatio: (format ?? '16:9').replace(':', ' / ') }}
          >
            {visual.image ? 'Preview unavailable' : 'Not rendered yet'}
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-3 border-t border-foreground/[0.06] p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-ui-lg font-medium text-foreground">{visual.name}</p>
            {visual.caption ? (
              <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{visual.caption}</p>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
            {changed ? (
              <Pill tone="yellow">Changed since approval</Pill>
            ) : approved ? (
              <Pill tone="green">Approved</Pill>
            ) : null}
            {stale ? <Pill>From an earlier plan</Pill> : null}
            {visual.variantLabel ? <Pill tone="purple">Variant {visual.variantLabel}</Pill> : null}
          </div>
        </div>
        {visual.critique ? (
          <CritiqueSummary critique={visual.critique} />
        ) : (
          <p className="text-xs text-muted-foreground">
            No automated review is available. Check this visual before approving.
          </p>
        )}
        {/* An open revise panel is a div and takes the full row. */}
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-1 [&>div]:basis-full">
          {options.canEdit ? (
            <ButtonLink
              className="h-8 rounded-lg text-xs"
              href={visual.editHref}
              size="sm"
              variant="outline"
            >
              Open in editor
            </ButtonLink>
          ) : null}
          {options.canEdit && visual.designId ? (
            <ButtonLink
              className="h-8 rounded-lg text-xs"
              href={`/canvas/new?design=${visual.designId}`}
              size="sm"
              variant="outline"
            >
              Edit in Canvas
            </ButtonLink>
          ) : null}
          {options.canApprove &&
          visual.approvable !== false &&
          visual.renderedAssetId &&
          (changed || !approved) ? (
            <ApproveVisualButton
              campaignId={options.campaignId}
              designId={visual.designId ?? undefined}
              assetId={!visual.designId ? visual.renderedAssetId : undefined}
              label={changed ? 'Approve new render' : 'Approve visual'}
            />
          ) : null}
          {options.canEdit && visual.designId ? (
            <RevisePanel
              campaignId={options.campaignId}
              disabled={!options.aiConfigured}
              placeholder="For example: make the headline larger and higher contrast"
              target={{ designId: visual.designId, type: 'design' }}
              triggerLabel="Revise with AI"
            />
          ) : null}
        </div>
      </div>
    </li>
  )
}

function VisualGrid({
  format = null,
  options,
  planCreatedAt = null,
  visuals,
}: {
  format?: string | null
  options: CardOptions
  planCreatedAt?: number | null
  visuals: BoardVisual[]
}) {
  return (
    <ul className="grid gap-4 sm:grid-cols-2">
      {visuals.map((visual) => (
        <VisualCard
          format={format}
          key={visual.id}
          options={options}
          stale={
            visual.fromEarlierPlan ?? (planCreatedAt !== null && visual.createdAt < planCreatedAt)
          }
          visual={visual}
        />
      ))}
    </ul>
  )
}

/** The current visuals for a plan asset, with earlier versions folded away. */
function PlanAssetVisuals({
  format,
  options,
  planCreatedAt,
  visuals,
}: {
  format: string
  options: CardOptions
  planCreatedAt: number | null
  visuals: BoardVisual[]
}) {
  if (visuals.length === 0) {
    return (
      <p className="rounded-xl bg-foreground/[0.015] px-5 py-6 text-center text-sm text-muted-foreground ring-1 ring-foreground/[0.06]">
        Nothing made for this asset yet.
      </p>
    )
  }
  const { current, earlier } = splitVersions(visuals)
  return (
    <>
      <VisualGrid
        format={format}
        options={options}
        planCreatedAt={planCreatedAt}
        visuals={current}
      />
      {earlier.length > 0 ? (
        <Accordion type="single" collapsible>
          <AccordionItem value="details" className="group/earlier">
            <AccordionTrigger className="[&>svg:last-child]:hidden flex w-fit cursor-pointer list-none items-center gap-1 text-xs font-medium text-foreground/65 transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
              {earlier.length} earlier {earlier.length === 1 ? 'version' : 'versions'}
              <ArrowDown01Icon
                className="transition-transform group-data-[state=open]/earlier:rotate-180"
                size={14}
              />
            </AccordionTrigger>
            <AccordionContent className="p-0">
              <div className="mt-4">
                <VisualGrid
                  format={format}
                  options={{ ...options, canApprove: false, canEdit: false }}
                  planCreatedAt={planCreatedAt}
                  visuals={earlier}
                />
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      ) : null}
    </>
  )
}

function PlanAssetGroup({
  angle,
  asset,
  children,
}: {
  angle: string | undefined
  asset: PlanAsset
  children: ReactNode
}) {
  const headingId = `plan-asset-${asset.key}`
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <h3 className="text-base font-medium text-balance text-foreground" id={headingId}>
          <span className="mr-1 font-mono text-sm text-muted-foreground">{asset.key}</span>{' '}
          {asset.headline}
        </h3>
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill>{kindLabel(asset.kind)}</Pill>
          <Pill>{asset.format}</Pill>
          {asset.variants === 2 ? <Pill tone="purple">A/B pair</Pill> : null}
          <Pill tone="blue">
            {asset.angleKey}
            {angle ? ` · ${angle}` : ''}
          </Pill>
        </div>
        <p className="text-xs text-muted-foreground">
          <span className="text-muted-foreground/75">Shows</span> {asset.capability}
        </p>
      </div>
      {children}
    </section>
  )
}

function Captures({ captures }: { captures: BoardCapture[] }) {
  return (
    <Accordion type="single" collapsible>
      <AccordionItem
        value="details"
        className="group/captures rounded-2xl bg-foreground/[0.015] ring-1 ring-foreground/[0.08]"
      >
        <AccordionTrigger className="[&>svg:last-child]:hidden flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 [&::-webkit-details-marker]:hidden">
          <span className="min-w-0">
            <span className="block text-ui-lg font-medium text-foreground">Captures</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {captures.length} live {captures.length === 1 ? 'capture' : 'captures'} of the product
              the visuals were built from.
            </span>
          </span>
          <ArrowDown01Icon
            className="shrink-0 text-muted-foreground transition-transform group-data-[state=open]/captures:rotate-180"
            size={16}
          />
        </AccordionTrigger>
        <AccordionContent className="p-0">
          <ul className="grid gap-4 border-t border-foreground/[0.06] p-5 sm:grid-cols-2 lg:grid-cols-3">
            {captures.map((capture) => (
              <li className="flex min-w-0 flex-col gap-2" key={capture.id}>
                {capture.url ? (
                  <a
                    className="block overflow-hidden rounded-lg ring-1 ring-foreground/[0.08] transition hover:ring-foreground/[0.2]"
                    href={capture.url}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <img
                      alt={`${capture.device} capture of ${capture.caption ?? 'the product'}`}
                      className="aspect-[4/3] w-full bg-card object-cover object-top"
                      loading="lazy"
                      src={capture.url}
                    />
                  </a>
                ) : (
                  <div className="grid aspect-[4/3] place-items-center rounded-lg text-xs text-muted-foreground ring-1 ring-foreground/[0.08]">
                    Preview unavailable
                  </div>
                )}
                <p className="flex min-w-0 items-center gap-2 text-xs">
                  <Pill>{capture.device}</Pill>
                  <span className="truncate text-muted-foreground">{capture.caption}</span>
                </p>
              </li>
            ))}
          </ul>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  )
}

export function AssetBoard({
  captures,
  options,
  plan,
  planCreatedAt,
  visuals,
}: {
  captures: BoardCapture[]
  options: CardOptions
  plan: CampaignPlanContent | null
  planCreatedAt: number | null
  visuals: BoardVisual[]
}) {
  if (visuals.length === 0 && captures.length === 0) {
    return (
      <EmptyState
        description="Produce the campaign to capture the product, then design and review each visual in the plan."
        icon={Album02Icon}
        title="Nothing produced yet"
      />
    )
  }
  const planKeys = new Set(plan?.assets.map((asset) => asset.key))
  const angles = new Map(plan?.angles.map((angle) => [angle.key, angle.title]))
  const others = visuals.filter(
    (visual) => !visual.planAssetKey || !planKeys.has(visual.planAssetKey)
  )
  return (
    <>
      {plan ? (
        <Section
          description="Each asset in the plan with the visuals made for it. Every design is reviewed against the spec, the brand kit, and legibility."
          title="Visuals"
        >
          <div className="flex flex-col gap-12">
            {plan.assets.map((asset) => (
              <PlanAssetGroup angle={angles.get(asset.angleKey)} asset={asset} key={asset.key}>
                <PlanAssetVisuals
                  format={asset.format}
                  options={options}
                  planCreatedAt={planCreatedAt}
                  visuals={visuals.filter((visual) => visual.planAssetKey === asset.key)}
                />
              </PlanAssetGroup>
            ))}
          </div>
        </Section>
      ) : null}
      {others.length > 0 ? (
        <Section
          description={plan ? 'Made before the plan, or for assets no longer in it.' : undefined}
          title={plan ? 'Other visuals' : 'Visuals'}
        >
          <VisualGrid options={options} visuals={newestFirst(others)} />
        </Section>
      ) : null}
      {captures.length > 0 ? <Captures captures={captures} /> : null}
    </>
  )
}
