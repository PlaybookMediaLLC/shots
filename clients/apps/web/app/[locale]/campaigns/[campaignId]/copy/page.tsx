import { PostIcon as Note01Icon } from '@/components/platform-shell/icons'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { z } from 'zod'
import { CopyBoard, type CopyChannel, type CopyPost } from '@/components/launch/copy/CopyBoard'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { EmptyState, Section } from '@/components/platform-ui'
import { isCampaignStudioConfigured } from '@/lib/ai/agents/campaign-studio'
import { accessAllows } from '@/lib/auth/permissions'
import { backendSDK } from '@/lib/backend/sdk'
import { visualChoices } from '@/lib/launch/schedule'
import {
  claimsMeanTheSame,
  LAUNCH_CHANNEL_LABELS,
  LAUNCH_CHANNELS,
  type LaunchChannel,
  PLAN_PHASE_LABELS,
  PLAN_PHASES,
  type PlanPhase,
  type ReleaseSpecContent,
  resolveClaimRef,
} from '@/lib/launch/spec-schema'
import { getCampaignPlans, getReleaseSpecs, getSpecById } from '@/lib/launch/store'
import { getCampaign } from '@/lib/tenant/campaigns'
import { listCampaignDesigns } from '@/lib/tenant/designs'
import { requireCampaignPageAccess } from '../../page-access'

export const metadata: Metadata = { title: 'Campaign copy' }

type CampaignCopyPageProps = {
  params: Promise<{ campaignId: string; locale: string }>
}

const claimsSchema = z.array(z.object({ ref: z.string(), text: z.string() })).catch([])

function phaseRank(phase: string | null): number {
  const index = PLAN_PHASES.indexOf(phase as PlanPhase)
  return index === -1 ? PLAN_PHASES.length : index
}

/** "G2" → 2; posts without an angle go last. */
function angleRank(key: string | null): number {
  return Number(key?.slice(1)) || 99
}

/** The copy board: posts by channel with their provenance and review actions. */
export default async function CampaignCopyPage({ params }: CampaignCopyPageProps) {
  const { campaignId, locale } = await params
  const access = await requireCampaignPageAccess(locale)
  // Scoped to the active workspace: another workspace's id is a 404.
  const campaign = await getCampaign(access.tenant, campaignId)
  if (!campaign) notFound()

  const [plans, specs, designs, members] = await Promise.all([
    getCampaignPlans(access.tenant, campaign.id),
    campaign.release ? getReleaseSpecs(access.tenant, campaign.release.id) : null,
    listCampaignDesigns(access.tenant, campaign.id),
    campaign.posts.some((post) => post.approvedByUserId)
      ? backendSDK(access.tenant).listWorkspaceMembers()
      : { members: [] },
  ])
  if (campaign.posts.length === 0) {
    const next = !specs?.latest
      ? { tab: 'spec', label: 'Draft the spec' }
      : !plans.latest
        ? { tab: 'plan', label: 'Plan the campaign' }
        : { tab: 'assets', label: 'Produce the campaign' }
    return (
      <EmptyState
        action={
          <ButtonLink href={`/campaigns/${campaign.id}/${next.tab}`} variant="outline">
            {next.label}
          </ButtonLink>
        }
        description="Complete the next step to create posts for review."
        icon={Note01Icon}
        title="No copy yet"
      />
    )
  }
  const workingPlan = plans.approved ?? plans.latest
  const plan = workingPlan?.content
  const workingSpec = specs?.approved ?? specs?.latest
  const spec = workingSpec?.content
  // Claim refs are positions in the spec version a post was written from, so
  // each post's claims are compared against that version.
  const postSpecs = new Map<number, ReleaseSpecContent>()
  if (specs && workingSpec) {
    for (const version of new Set(campaign.posts.map((post) => post.specVersion))) {
      const match = specs.versions.find((entry) => entry.version === version)
      if (version === null || !match) continue
      postSpecs.set(
        version,
        version === workingSpec.version
          ? workingSpec.content
          : (await getSpecById(access.tenant, match.id)).content
      )
    }
  }
  const planAngles = new Map(plan?.angles.map((angle) => [angle.key, angle.title]))
  // Posts from before the plan carry a content angle instead.
  const contentAngles = new Map(campaign.angles.map((angle) => [angle.id, angle.title]))
  const memberNames = new Map(
    members.members.map((member) => [member.user.id, member.user.name || member.user.email])
  )
  // Newest first, so the latest approved render of an asset leads the picker.
  const approvedVisuals = [...designs]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .flatMap((design) =>
      design.approvedVariant
        ? [
            {
              id: design.approvedVariant.id,
              label: [
                design.planAssetKey,
                design.name,
                design.variantLabel ? `Variant ${design.variantLabel}` : null,
              ]
                .filter(Boolean)
                .join(' · '),
              planAssetKey: design.planAssetKey,
            },
          ]
        : []
    )

  const posts = [...campaign.posts]
    .sort(
      (a, b) =>
        phaseRank(a.phase) - phaseRank(b.phase) ||
        angleRank(a.planItemKey) - angleRank(b.planItemKey) ||
        // Each production run adds posts; the newest draft comes first.
        b.createdAt.getTime() - a.createdAt.getTime()
    )
    .map((post): CopyPost => {
      const angleTitle = post.planItemKey ? planAngles.get(post.planItemKey) : undefined
      return {
        angle: angleTitle
          ? `${post.planItemKey} · ${angleTitle}`
          : ((post.angleId && contentAngles.get(post.angleId)) ?? post.planItemKey),
        approval: post.approvedAt && {
          at: post.approvedAt.toISOString(),
          by: (post.approvedByUserId && memberNames.get(post.approvedByUserId)) ?? null,
        },
        callToAction: post.callToAction,
        channel: post.channel,
        claims: claimsSchema.parse(post.claims).map((claim) => {
          const from = post.specVersion === null ? undefined : postSpecs.get(post.specVersion)
          return {
            ...claim,
            // Without a spec there is nothing to check against. A claim is
            // current while it says the same thing in the working spec.
            current:
              !spec ||
              (from
                ? claimsMeanTheSame([claim.ref], from, spec)
                : resolveClaimRef(spec, claim.ref) !== null),
          }
        }),
        copy: post.copy,
        creativeVariantId: post.creativeVariantId,
        fromEarlierPlan:
          workingPlan !== null &&
          post.planVersion !== null &&
          post.planVersion !== workingPlan.version,
        id: post.id,
        phase: PLAN_PHASE_LABELS[post.phase as PlanPhase] ?? null,
        reviewNote: post.reviewNote,
        scheduledAt: post.scheduledAt?.toISOString() ?? null,
        scheduledPostId: post.scheduledPostId,
        scheduledPostStatus: post.scheduledPostStatus,
        status: post.status,
        title: post.title,
        visuals: visualChoices(post, plan, approvedVisuals).map(({ id, label }) => ({
          id,
          label,
        })),
      }
    })

  const planChannels = new Map(plan?.channels.map((channel) => [channel.channel, channel.role]))
  const channels = [
    ...new Set([
      ...LAUNCH_CHANNELS.filter(
        (channel) => planChannels.has(channel) || posts.some((post) => post.channel === channel)
      ),
      // Channels outside the launch set, from earlier generations.
      ...posts.map((post) => post.channel),
    ]),
  ].map((channel): CopyChannel => ({
    label:
      LAUNCH_CHANNEL_LABELS[channel as LaunchChannel] ??
      channel.charAt(0).toUpperCase() + channel.slice(1),
    role: planChannels.get(channel as LaunchChannel) ?? null,
    value: channel,
  }))

  return (
    <Section
      description={`${posts.length} ${posts.length === 1 ? 'post' : 'posts'} across ${channels.length} ${channels.length === 1 ? 'channel' : 'channels'}. Each lists the spec claims it relies on.`}
      title="Copy"
    >
      <CopyBoard
        channels={channels}
        permissions={{
          aiConfigured: isCampaignStudioConfigured(),
          campaignId: campaign.id,
          canApprove:
            campaign.status !== 'ARCHIVED' && accessAllows(access, 'release:approve'),
          canEdit: campaign.status !== 'ARCHIVED' && accessAllows(access, 'release:create'),
          canSchedule:
            campaign.status !== 'ARCHIVED' && accessAllows(access, 'publish:manage'),
        }}
        posts={posts}
      />
    </Section>
  )
}
