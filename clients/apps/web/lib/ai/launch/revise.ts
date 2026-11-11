import 'server-only'

import type { ModelMessage } from 'ai'
import type { BackendCampaignPost } from 'screenshot-studio-backend-sdk'
import sharp from 'sharp'
import { z } from 'zod'
import type { TenantContext } from '@/lib/auth/access'
import { backendSDK } from '@/lib/backend/sdk'
import {
  definedChanges,
  parseDesignDocument,
  patchDesignDocument,
  stillDesignChangesSchema,
} from '@/lib/design/document'
import { findCitationIssues } from '@/lib/launch/citations'
import { checkLaunchPost } from '@/lib/launch/guards'
import { formatTeamPreferences } from '@/lib/launch/preferences-format'
import { defuseMarkup, fenceSource } from '@/lib/launch/sanitize'
import {
  claimRefSection,
  claimsMeanTheSame,
  LAUNCH_CHANNEL_LABELS,
  type LaunchChannel,
  LAUNCH_CHANNELS,
  type LaunchPost,
  PLAN_PHASES,
  type PostRevision,
  postRevisionSchema,
  type ReleaseSpecContent,
  type RevisionChange,
  SPEC_SECTION_LABELS,
  type SpecSectionKey,
  specSectionSchemas,
  validatePlanReferences,
  campaignPlanSchema,
} from '@/lib/launch/spec-schema'
import {
  createRevision,
  getActiveBrand,
  getCampaignPlans,
  getReleaseSpecs,
  getSpecById,
  getWorkingSpec,
  LaunchError,
  loadLaunchCampaign,
  loadPreferenceExamples,
  releaseSourceUrls,
  type StoredRevision,
  type StoredSpec,
} from '@/lib/launch/store'
import { readTenantObject } from '@/lib/storage/client'
import { captureUrlsFor, formatBrandKit, formatPlanForStages, formatSpecForStages } from './context'
import { copyGuardContext } from './copy'
import { REVISE_INSTRUCTIONS } from './prompts'
import { runSubmitStage } from './run'
import { voiceInstructions } from '@/lib/write/voice'

export type RevisionTargetInput =
  | { planId: string; type: 'plan' }
  | { postId: string; type: 'post' }
  | { designId: string; type: 'design' }
  | { section: SpecSectionKey; specId: string; type: 'spec_section' }

const summarySchema = z.string().trim().min(1).max(300)

type PostRow = BackendCampaignPost

function postBefore(post: PostRow): PostRevision {
  const claims = Array.isArray(post.claims) ? (post.claims as PostRevision['claims']) : []
  return {
    callToAction: post.callToAction ?? '',
    claims,
    copy: post.copy,
    title: post.title ?? '',
  }
}

function asLaunchPost(post: PostRow, revision: PostRevision): LaunchPost {
  const channel = (LAUNCH_CHANNELS as readonly string[]).includes(post.channel)
    ? (post.channel as LaunchChannel)
    : 'linkedin'
  const phase = (PLAN_PHASES as readonly string[]).includes(post.phase ?? '')
    ? (post.phase as LaunchPost['phase'])
    : 'launch'
  return { ...revision, angleKey: post.planItemKey ?? 'G1', channel, phase }
}

const channelLabel = (channel: string) => LAUNCH_CHANNEL_LABELS[channel as LaunchChannel] ?? channel

function reviewerBlock(comment: string): string {
  return `<reviewer_comment>\n${defuseMarkup(comment)}\n</reviewer_comment>`
}

/** Spec for a post's claims: the version it was written from, else the working spec. */
async function specForPost(tenant: TenantContext, releaseId: string, version: number | null) {
  const { versions } = await getReleaseSpecs(tenant, releaseId)
  const match = version ? versions.find((entry) => entry.version === version) : null
  return match ? getSpecById(tenant, match.id) : getWorkingSpec(tenant, releaseId)
}

function sourcesFor(spec: StoredSpec): string {
  return spec.sources
    .filter((source) => source.status === 'ok')
    .map((source) =>
      fenceSource({
        flagged: source.flagged,
        id: source.id,
        kind: source.kind,
        text: source.excerpt,
        title: source.title,
        url: source.url,
      })
    )
    .join('\n\n')
}

export async function proposeCampaignRevision(
  tenant: TenantContext,
  input: {
    campaignId: string
    comment: string
    /** Stops the model when the launch run is cancelled. */
    signal?: AbortSignal
    target: RevisionTargetInput
  }
): Promise<StoredRevision> {
  const campaign = await loadLaunchCampaign(tenant, input.campaignId)
  const release = campaign.release
  if (!release) throw new LaunchError('Link a release brief first.', 409)
  const [brand, examples] = await Promise.all([
    getActiveBrand(tenant),
    loadPreferenceExamples(tenant),
  ])
  const campaignPosts = async () => (await backendSDK(tenant).getCampaign(campaign.id)).posts
  const preferences = formatTeamPreferences(examples)
  const voice = voiceInstructions(brand.voice)
  const comment = input.comment.trim()
  const target = input.target

  let primary: RevisionChange
  let related: RevisionChange[] = []
  let summary: string
  let modelId: string

  if (target.type === 'post') {
    const post = (await campaignPosts()).find((entry) => entry.id === target.postId)
    if (!post) throw new LaunchError('Post not found.', 404)
    const spec = await specForPost(tenant, release.id, post.specVersion)
    if (!spec) throw new LaunchError('Draft the spec first.', 409)
    const guard = copyGuardContext(campaign, spec, brand)
    const before = postBefore(post)
    const run = await runSubmitStage({
      abortSignal: input.signal,
      description: 'Propose the revised post.',
      prompt: [
        formatSpecForStages(spec.content, spec.version),
        voice,
        preferences,
        `<post channel="${post.channel}" phase="${post.phase ?? 'launch'}">\n${JSON.stringify(before, null, 1)}\n</post>`,
        reviewerBlock(comment),
        `Revise the ${channelLabel(post.channel)} post as the reviewer asks.`,
      ]
        .filter(Boolean)
        .join('\n\n'),
      role: 'drafting',
      schema: z.object({ after: postRevisionSchema, summary: summarySchema }),
      system: REVISE_INSTRUCTIONS,
      toolName: 'proposeRevision',
      validate: ({ after }) => checkLaunchPost(asLaunchPost(post, after), guard),
    })
    if (!run.value)
      throw new LaunchError('The revision could not be drafted. Try rephrasing it.', 503)
    modelId = run.modelId
    summary = run.value.summary
    primary = {
      after: run.value.after,
      before,
      label: `${channelLabel(post.channel)} post`,
      reason: comment,
      targetId: post.id,
      targetType: 'post',
    }
  } else if (target.type === 'spec_section') {
    const spec = await getSpecById(tenant, target.specId)
    if (spec.releaseId !== release.id) throw new LaunchError('Spec not found.', 404)
    const { latest, versions } = await getReleaseSpecs(tenant, release.id)
    if (latest && latest.id !== spec.id)
      throw new LaunchError('Revise the latest spec version.', 409)
    const section = target.section
    const known = new Set(
      spec.sources.filter((source) => source.status === 'ok').map((source) => source.id)
    )
    const posts = await campaignPosts()
    const refsOf = (post: (typeof posts)[number]) =>
      (Array.isArray(post.claims) ? (post.claims as Array<{ ref?: unknown }>) : [])
        .map((claim) => claim.ref)
        .filter((ref): ref is string => typeof ref === 'string')
    // Posts written from this version, or from an earlier one whose claims say
    // the same thing here (a redraft that kept them): their refs mean what
    // this version says.
    const earlier = new Map<number, ReleaseSpecContent>()
    for (const version of new Set(posts.map((post) => post.specVersion))) {
      const match = versions.find((entry) => entry.version === version)
      if (version === null || version === spec.version || !match) continue
      earlier.set(version, (await getSpecById(tenant, match.id)).content)
    }
    const agrees = (post: (typeof posts)[number]) => {
      if (post.specVersion === spec.version) return true
      const from = post.specVersion === null ? undefined : earlier.get(post.specVersion)
      return from !== undefined && claimsMeanTheSame(refsOf(post), from, spec.content)
    }
    const dependents = posts.filter(
      (post) => agrees(post) && refsOf(post).some((ref) => claimRefSection(ref) === section)
    )
    const dependentIds = new Set(dependents.map((post) => post.id))
    const guardFor = (content: ReleaseSpecContent) =>
      copyGuardContext(campaign, { ...spec, content }, brand)
    const schema = z.object({
      after: specSectionSchemas[section],
      relatedPosts: z
        .array(
          z.object({
            after: postRevisionSchema,
            postId: z.string(),
            reason: z.string().trim().min(1).max(300),
          })
        )
        .max(12),
      summary: summarySchema,
    })
    const run = await runSubmitStage({
      abortSignal: input.signal,
      description:
        'Propose the revised spec section, plus updates for dependent posts that would otherwise contradict it.',
      maxSteps: 6,
      prompt: [
        formatSpecForStages(spec.content, spec.version),
        `<sources>\n${sourcesFor(spec)}\n</sources>`,
        `<section key="${section}">\n${JSON.stringify(spec.content[section], null, 1)}\n</section>`,
        dependents.length
          ? `<dependent_posts>\n${JSON.stringify(
              dependents.map((post) => ({
                channel: post.channel,
                postId: post.id,
                ...postBefore(post),
              })),
              null,
              1
            )}\n</dependent_posts>`
          : 'No posts cite this section.',
        voice,
        preferences,
        reviewerBlock(comment),
        `Revise the ${SPEC_SECTION_LABELS[section].toLowerCase()} section as the reviewer asks. You may cite: brief${known.size ? `, ${[...known].join(', ')}` : ''}.`,
      ]
        .filter(Boolean)
        .join('\n\n'),
      role: 'deep',
      schema,
      system: REVISE_INSTRUCTIONS,
      toolName: 'proposeRevision',
      validate: ({ after, relatedPosts }) => {
        const next = { ...spec.content, [section]: after } as ReleaseSpecContent
        const issues = findCitationIssues(next, known)
        for (const update of relatedPosts) {
          const post = dependents.find((entry) => entry.id === update.postId)
          if (!post || !dependentIds.has(update.postId)) {
            issues.push(`Post ${update.postId} is not a dependent post.`)
            continue
          }
          issues.push(...checkLaunchPost(asLaunchPost(post, update.after), guardFor(next)))
        }
        return issues
      },
    })
    if (!run.value)
      throw new LaunchError('The revision could not be drafted. Try rephrasing it.', 503)
    modelId = run.modelId
    summary = run.value.summary
    primary = {
      after: run.value.after,
      before: spec.content[section],
      label: SPEC_SECTION_LABELS[section],
      reason: comment,
      targetId: spec.id,
      targetKey: section,
      targetType: 'spec_section',
    }
    related = run.value.relatedPosts.map((update) => {
      const post = dependents.find((entry) => entry.id === update.postId)!
      return {
        after: update.after,
        before: postBefore(post),
        label: `${channelLabel(post.channel)} post`,
        reason: update.reason,
        targetId: post.id,
        targetType: 'post' as const,
      }
    })
  } else if (target.type === 'design') {
    const design = (await backendSDK(tenant).listCampaignDesigns(campaign.id)).designs.find(
      (entry) => entry.id === target.designId
    )
    if (!design) throw new LaunchError('Design not found.', 404)
    const document = parseDesignDocument(design.document)
    const spec = await getWorkingSpec(tenant, release.id)
    const content: ModelMessage['content'] = [
      {
        text: [
          spec ? formatSpecForStages(spec.content, spec.version) : null,
          formatBrandKit(brand.kit),
          // Text on the image is public copy too.
          voice,
          `<design name="${defuseMarkup(design.name).replace(/"/g, '')}">\n${JSON.stringify(document)}\n</design>`,
          design.critique
            ? `<last_review>\n${JSON.stringify(design.critique)}\n</last_review>`
            : null,
          reviewerBlock(comment),
          'Propose the design changes the reviewer asks for. Keep everything else.',
        ]
          .filter(Boolean)
          .join('\n\n'),
        type: 'text',
      },
    ]
    if (design.renderedAsset) {
      try {
        const bytes = await readTenantObject({
          assetId: design.renderedAsset.id,
          tenant,
        })
        const preview = await sharp(bytes)
          .resize({ width: 960, withoutEnlargement: true })
          .jpeg({ quality: 70 })
          .toBuffer()
        content.push({ data: preview.toString('base64'), mediaType: 'image/jpeg', type: 'file' })
      } catch {
        // The revision still works from the document alone.
      }
    }
    const run = await runSubmitStage({
      abortSignal: input.signal,
      description: 'Propose the design changes.',
      messages: [{ content, role: 'user' } as ModelMessage],
      role: 'deep',
      // Launch visuals are stills, so a revision never needs the motion sections.
      schema: z.object({ changes: stillDesignChangesSchema, summary: summarySchema }),
      system: REVISE_INSTRUCTIONS,
      toolName: 'proposeRevision',
      validate: ({ changes }) => {
        try {
          patchDesignDocument(document, definedChanges(changes))
          return []
        } catch (error) {
          return [
            `Invalid change: ${error instanceof Error ? error.message.slice(0, 300) : 'invalid'}`,
          ]
        }
      },
    })
    if (!run.value)
      throw new LaunchError('The revision could not be drafted. Try rephrasing it.', 503)
    const patched = patchDesignDocument(document, definedChanges(run.value.changes))
    modelId = run.modelId
    summary = run.value.summary
    primary = {
      after: {
        background: patched.background ?? null,
        changes: run.value.changes,
        texts: patched.texts.map((text) => text.text),
      },
      before: {
        background: document.background ?? null,
        texts: document.texts.map((text) => text.text),
        updatedAt: new Date(design.updatedAt).toISOString(),
      },
      label: design.name,
      reason: comment,
      targetId: design.id,
      targetType: 'design',
    }
  } else {
    const { latest, versions } = await getCampaignPlans(tenant, campaign.id)
    const plan = latest && versions.some((entry) => entry.id === target.planId) ? latest : null
    if (!plan) throw new LaunchError('Plan not found.', 404)
    if (plan.id !== target.planId) throw new LaunchError('Revise the latest plan version.', 409)
    const spec = plan.specId
      ? await getSpecById(tenant, plan.specId)
      : await getWorkingSpec(tenant, release.id)
    if (!spec) throw new LaunchError('Draft the spec first.', 409)
    const captureUrls = captureUrlsFor([
      campaign.productSurface?.url,
      ...releaseSourceUrls(campaign),
    ])
    const run = await runSubmitStage({
      abortSignal: input.signal,
      description: 'Propose the revised campaign plan.',
      maxSteps: 6,
      prompt: [
        formatSpecForStages(spec.content, spec.version),
        formatPlanForStages(plan.content, plan.version),
        `<capture_urls>\n${captureUrls.join('\n') || 'None.'}\n</capture_urls>`,
        voice,
        preferences,
        reviewerBlock(comment),
        'Revise the plan as the reviewer asks.',
      ]
        .filter(Boolean)
        .join('\n\n'),
      role: 'deep',
      schema: z.object({ after: campaignPlanSchema, summary: summarySchema }),
      system: REVISE_INSTRUCTIONS,
      toolName: 'proposeRevision',
      validate: ({ after }) => validatePlanReferences(after, spec.content, captureUrls),
    })
    if (!run.value)
      throw new LaunchError('The revision could not be drafted. Try rephrasing it.', 503)
    modelId = run.modelId
    summary = run.value.summary
    primary = {
      after: run.value.after,
      before: plan.content,
      label: `Plan v${plan.version}`,
      reason: comment,
      targetId: plan.id,
      targetType: 'plan',
    }
  }

  return createRevision(tenant, {
    campaignId: campaign.id,
    comment,
    modelId,
    proposal: { primary, related, summary },
  })
}
