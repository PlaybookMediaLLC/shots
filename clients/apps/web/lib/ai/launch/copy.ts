import 'server-only'

import { z } from 'zod'
import type { TenantContext } from '@/lib/auth/access'
import { allowedHostsFrom, checkLaunchPost, type GuardContext } from '@/lib/launch/guards'
import { formatTeamPreferences, type PreferenceExamples } from '@/lib/launch/preferences-format'
import { type LaunchChannel, type LaunchPost, launchPostSchema } from '@/lib/launch/spec-schema'
import {
  type ActiveBrand,
  type LaunchCampaign,
  releaseSourceUrls,
  saveLaunchPosts,
  type StoredPlan,
  type StoredSpec,
} from '@/lib/launch/store'
import { getProductProfile } from '@/lib/tenant/product-profile'
import {
  formatPlanForStages,
  formatProductProfile,
  formatSpecForStages,
  prohibitedTermsOf,
} from './context'
import { COPY_INSTRUCTIONS } from './prompts'
import { runSubmitStage } from './run'
import { voiceInstructions } from '@/lib/write/voice'

const copySchema = z.object({ posts: z.array(launchPostSchema).min(1).max(8) })

export function copyGuardContext(
  campaign: LaunchCampaign,
  spec: StoredSpec,
  brand: ActiveBrand
): GuardContext {
  return {
    allowedHosts: allowedHostsFrom([campaign.productSurface?.url, ...releaseSourceUrls(campaign)]),
    prohibitedTerms: prohibitedTermsOf(brand),
    spec: spec.content,
  }
}

/** Problems with one post: its guards, plus whether its angle and channel are in the plan. */
export function checkPostInPlan(
  post: LaunchPost,
  plan: StoredPlan,
  context: GuardContext
): string[] {
  const issues = checkLaunchPost(post, context)
  if (!plan.content.angles.some((angle) => angle.key === post.angleKey)) {
    issues.push(`${post.channel} post uses unknown angle ${post.angleKey}.`)
  }
  if (!plan.content.channels.some((channel) => channel.channel === post.channel)) {
    issues.push(`${post.channel} is not a channel in the plan.`)
  }
  return issues
}

const CHANNEL_CONCURRENCY = 3

/**
 * Write channel copy for the plan in the brand voice, guarded before it is
 * saved. One call per channel: outputs stay well under the model's output
 * cap, and a guard failure on one channel is retried for that channel only.
 */
export async function writeLaunchCopy(
  tenant: TenantContext,
  input: {
    brand: ActiveBrand
    campaign: LaunchCampaign
    examples: PreferenceExamples
    plan: StoredPlan
    /** Stops the model when the launch run is cancelled. */
    signal?: AbortSignal
    spec: StoredSpec
  }
) {
  const context = copyGuardContext(input.campaign, input.spec, input.brand)
  const product = await getProductProfile(tenant).catch(() => null)
  const shared = [
    formatSpecForStages(input.spec.content, input.spec.version),
    formatPlanForStages(input.plan.content, input.plan.version),
    formatProductProfile(product),
    voiceInstructions(input.brand.voice),
    `Links may only use these hosts: ${[...context.allowedHosts].join(', ') || 'none (do not include links)'}.`,
    formatTeamPreferences(input.examples),
  ]
    .filter(Boolean)
    .join('\n\n')
  const channels = input.plan.content.channels.map((entry) => entry.channel)

  const writeChannel = async (channel: LaunchChannel) => {
    const items = input.plan.content.timeline.filter((item) => item.channel === channel)
    const run = await runSubmitStage({
      abortSignal: input.signal,
      description:
        `Save the ${channel} posts. Each post lists the spec claims it relies on. ` +
        'Returns the problems to fix if any post breaks a channel rule or the brand voice.',
      maxSteps: 5,
      prompt: [
        shared,
        `Write the ${channel} posts: one for each ${channel} item in the plan timeline (${items.length || 1}), using its angle and phase.`,
      ].join('\n\n'),
      role: 'drafting',
      schema: copySchema,
      system: COPY_INSTRUCTIONS,
      toolName: 'saveLaunchCopy',
      validate: ({ posts }) => [
        ...posts.flatMap((post) => checkPostInPlan(post, input.plan, context)),
        ...posts
          .filter((post) => post.channel !== channel)
          .map((post) => `Only write ${channel} posts here, not ${post.channel}.`),
      ],
    })
    const attempt = copySchema.safeParse(run.value ?? run.lastAttempt)
    // On a failed run, keep the posts that pass on their own rather than losing the channel.
    const posts = attempt.success
      ? attempt.data.posts.filter(
          (post) =>
            post.channel === channel && checkPostInPlan(post, input.plan, context).length === 0
        )
      : []
    return { posts, run }
  }

  const results: Array<Awaited<ReturnType<typeof writeChannel>>> = []
  for (let index = 0; index < channels.length; index += CHANNEL_CONCURRENCY) {
    results.push(
      ...(await Promise.all(channels.slice(index, index + CHANNEL_CONCURRENCY).map(writeChannel)))
    )
  }
  const posts = results.flatMap((result) => result.posts)
  if (posts.length === 0) return { angleCount: 0, postCount: 0 }
  const sum = (key: 'inputTokens' | 'outputTokens') =>
    results.reduce((total, result) => total + (result.run.usage[key] ?? 0), 0)
  return saveLaunchPosts(tenant, {
    angles: input.plan.content.angles,
    campaignId: input.campaign.id,
    metadata: {
      channelsWritten: results.filter((result) => result.posts.length > 0).length,
      inputUsage: sum('inputTokens'),
      modelId: results[0]?.run.modelId,
      outputUsage: sum('outputTokens'),
      planVersion: input.plan.version,
    },
    planVersion: input.plan.version,
    posts,
    specVersion: input.spec.version,
  })
}
