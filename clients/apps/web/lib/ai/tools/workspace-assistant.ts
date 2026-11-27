import 'server-only'

import { z } from 'zod'
import { INTERNAL_HREF_MAX, internalHref } from '@/lib/assistant/page-context'
import { EDITOR_ASK_MAX, editorAskHref, withAsk } from '@/lib/ai/editor-ask'
import { ASSISTANT_POST_MAX, ASSISTANT_POSTS_MAX } from '@/lib/api/contracts/ai'
import { CAMPAIGN_SHIP_MAX, campaignShipHref } from '@/lib/campaigns/ship-ask'
import { defineTool, type ToolRun } from '@/lib/ai/tools/executor'
import { marketingTools } from '@/lib/ai/tools/marketing'
import { marketingServices } from '@/lib/ai/tools/marketing-services'
import { accessAllows } from '@/lib/auth/permissions'
import { brandKitLibrary } from '@/lib/brand/kit'
import { CANVAS_RECIPES, canvasRecipeSchema } from '@/lib/canvas/recipes'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'
import { WorkspaceEntitlementError, requireWorkspaceFeature } from '@/lib/tenant/entitlements'
import { PLATFORM_DESTINATIONS } from '@/lib/platform/navigation'
import { listAssets } from '@/lib/tenant/assets'
import { listCampaigns } from '@/lib/tenant/campaigns'
import { listCanvases } from '@/lib/tenant/canvases'
import { listBrandKits } from '@/lib/tenant/configuration'
import { listContentDraftPostsBetween, listContentDrafts } from '@/lib/tenant/content-drafts'
import { getIdealCustomerProfile } from '@/lib/tenant/ideal-customer-profile'
import { listProjects } from '@/lib/tenant/projects'
import { getWorkspaceReadiness } from '@/lib/workspace/service'
import { getRelease } from '@/lib/tenant/releases'
import { backendSDK } from '@/lib/backend/sdk'
import { draftHref, draftName } from '@/lib/write/library'
import { listedStatus, postState } from '@/lib/content-drafts/post-status'
import { palettePages, searchPages } from '@/components/platform-shell/palette-pages'

/**
 * The workspace assistant's tools: read-only looks at the workspace (its
 * work, campaigns, product and brand, and the app's pages), `offerLink`,
 * which puts a button to a page under the reply, and `startWork`, a button
 * that opens a new visual or canvas already set up from the request. Every
 * tool goes through the RFC 027 executor, so permissions, call caps and
 * timeouts hold and each call is audited. Nothing here changes the
 * workspace: new work is made only when the person clicks, and abilities
 * that edit something run where that thing is open (the canvas, the editor).
 */

/** What one turn's tools share. */
export type AssistantTurnState = {
  /** Addresses this turn's lookups returned: the only ones `offerLink` may offer. */
  known: Set<string>
  /** The links to show under the reply. */
  links: { href: string; label: string }[]
  /** Posts written this turn, each offered to open as a draft. */
  posts: { text: string }[]
}

/** Post states the assistant leads with when asked what needs attention. */
const ATTENTION_STATES = new Set(['Failed', 'Needs check', 'Overdue'])

/** Most links one reply offers. */
const MAX_LINKS = 4

const WORK_KINDS = ['screenshot', 'canvas', 'post'] as const

/** startWork's description: the same every turn, with each canvas recipe the model may pick. */
const START_WORK_DESCRIPTION =
  'Put a button under your reply that starts new work, set up from the request; nothing is ' +
  'made until the person clicks it. kind "visual" opens a new screenshot with the editor ' +
  'assistant holding `ask` (the visual to make, in the person\'s words). kind "campaign" ' +
  'opens a new launch campaign with `shipped` (what they shipped, in one or two sentences) ' +
  'ready to send to the campaign agent. kind "edit" opens existing work (`href`: a ' +
  'screenshot or canvas address listRecentWork returned this turn) with its AI holding `ask` ' +
  '(the change, in their words). kind "canvas" opens a new multi-artboard canvas ' +
  'from a recipe: ' +
  Object.entries(CANVAS_RECIPES)
    .map(([id, recipe]) => `${id} (${recipe.name}: ${recipe.description})`)
    .join('; ') +
  '.'

export function workspaceAssistantTools(run: ToolRun, state: AssistantTurnState) {
  const access = run.access
  const { getBrand, getProduct, listProductSurfaces } = marketingTools(run, {
    services: marketingServices,
  })

  type Feature = 'campaign:workflow' | 'content:drafts' | 'workspace:paid'
  // One backend read per feature per turn, however many calls ask.
  const decisions = new Map<Feature, Promise<boolean>>()
  /** Whether the workspace's plan includes `feature`; a backend failure still fails the call. */
  function allowed(feature: Feature): Promise<boolean> {
    const known = decisions.get(feature)
    if (known) return known
    const decision = requireWorkspaceFeature(access, feature).then(
      () => true,
      (error: unknown) => {
        // A failed read is not a refusal: forget it, and fail this call.
        decisions.delete(feature)
        if (error instanceof WorkspaceEntitlementError) return false
        throw error
      }
    )
    decisions.set(feature, decision)
    return decision
  }

  const listRecentWork = defineTool(run, {
    description:
      "List the workspace's most recently updated screenshots, canvases and posts, newest " +
      'first, each with the address that opens it. Filter by kind or by words in the name.',
    effect: 'read',
    execute: async ({ kind, search }) => {
      const want = (value: (typeof WORK_KINDS)[number]) => !kind || kind === value
      const query = { limit: 8, search: search || undefined }
      // A collection this workspace cannot read (a plan without it) drops out, not the rest.
      const settled = await Promise.allSettled([
        want('screenshot') ? listProjects(access, { ...query, sort: 'updated' }) : null,
        want('canvas') ? listCanvases(access, { ...query, sort: 'updated' }) : null,
        want('post') && contentDraftsEnabled()
          ? listContentDrafts(access, { ...query, sort: 'updated_desc' })
          : null,
      ])
      const read = <T>(result: PromiseSettledResult<T>) =>
        result.status === 'fulfilled' ? result.value : null
      const projects = read(settled[0])
      const canvases = read(settled[1])
      const drafts = read(settled[2])
      const items = [
        ...(projects?.items ?? []).map((item) => ({
          href: `/editor?project=${encodeURIComponent(item.id)}`,
          kind: 'screenshot',
          name: item.name,
          updatedAt: new Date(item.updatedAt).toISOString(),
        })),
        ...(canvases?.items ?? []).map((item) => ({
          href: `/canvas/${encodeURIComponent(item.id)}`,
          kind: 'canvas',
          name: item.name,
          updatedAt: new Date(item.updatedAt).toISOString(),
        })),
        ...(drafts?.items ?? []).map((item) => ({
          href: draftHref(item.id, item.socialSetId),
          kind: 'post',
          name: draftName({
            excerpt: item.plainText,
            media: item.assetIds.length ? 'media' : null,
            title: item.title,
          }),
          status: listedStatus(item),
          updatedAt: new Date(item.updatedAt).toISOString(),
        })),
      ]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 12)
      for (const item of items) state.known.add(item.href)
      const unread = settled.some((result) => result.status === 'rejected')
      return {
        items,
        ok: true as const,
        ...(unread ? { note: 'Some kinds of work could not be read.' } : {}),
      }
    },
    inputSchema: z.object({
      kind: z.enum(WORK_KINDS).optional(),
      search: z.string().trim().max(120).optional(),
    }),
    maxCallsPerRun: 4,
    name: 'listRecentWork',
    permission: 'artifact:read',
    timeoutMs: 15_000,
  })

  const listScheduledPosts = defineTool(run, {
    description:
      "List the workspace's social posts in a window: what is scheduled or publishing next, " +
      "or what went out (or failed) lately, with each post's time, platform, status and " +
      'the address that opens it; posts needing attention (Failed, Needs check, Overdue) ' +
      'come first. `window`: "next" (the coming `days`) or "last" (the past `days`). Times ' +
      'are UTC; `now` is the current time.',
    effect: 'read',
    execute: async ({ days, window }) => {
      if (!contentDraftsEnabled() || !(await allowed('content:drafts')))
        return { error: 'Posts are not on for this workspace.', ok: false as const }
      const now = Date.now()
      const span = days * 86_400_000
      const posts = await listContentDraftPostsBetween(
        access,
        new Date(window === 'next' ? now : now - span),
        new Date(window === 'next' ? now + span : now)
      )
      const items = posts
        // As the calendar shows it: a late post is Overdue, an unknown outcome Needs check.
        .map((post) => ({ post, state: postState(post.status, post.scheduledFor, now) }))
        // What needs attention first, so the cap below never drops it; then by time.
        .sort(
          (a, b) =>
            Number(ATTENTION_STATES.has(b.state)) - Number(ATTENTION_STATES.has(a.state)) ||
            (window === 'next' ? 1 : -1) *
              (a.post.scheduledFor.getTime() - b.post.scheduledFor.getTime())
        )
        .slice(0, 20)
        .map(({ post, state: status }) => ({
          caption: Array.from(post.caption).slice(0, 160).join(''),
          // A campaign's post (no draft of its own) opens on its campaign, as in the calendar.
          href: post.campaignId
            ? `/campaigns/${encodeURIComponent(post.campaignId)}`
            : draftHref(post.draftId, post.socialSetId),
          platform: post.platform,
          status,
          title: post.draftTitle || null,
          when: post.scheduledFor.toISOString(),
        }))
      for (const item of items) state.known.add(item.href)
      return {
        now: new Date(now).toISOString(),
        ok: true as const,
        posts: items,
        total: posts.length,
      }
    },
    inputSchema: z.object({
      days: z.number().int().min(1).max(31).default(7),
      window: z.enum(['next', 'last']).default('next'),
    }),
    maxCallsPerRun: 3,
    name: 'listScheduledPosts',
    permission: 'artifact:read',
    timeoutMs: 15_000,
  })

  const listWorkspaceCampaigns = defineTool(run, {
    description:
      "List the workspace's launch campaigns with their status and the address that opens each.",
    effect: 'read',
    execute: async () => {
      const campaigns = (await listCampaigns(access)).slice(0, 20).map((campaign) => ({
        feature: campaign.feature,
        href: `/campaigns/${encodeURIComponent(campaign.id)}`,
        name: campaign.name,
        status: campaign.status,
      }))
      for (const campaign of campaigns) state.known.add(campaign.href)
      return { campaigns, ok: true as const }
    },
    inputSchema: z.object({}),
    maxCallsPerRun: 2,
    name: 'listCampaigns',
    permission: 'workspace:read',
    timeoutMs: 15_000,
  })

  const findPages = defineTool(run, {
    description:
      'Find pages of this app by what they are for ("brand colours", "scheduled posts", ' +
      '"connect GitHub"). Returns page names and addresses; with no words, every page.',
    effect: 'read',
    execute: async ({ query }) => {
      const campaignsEnabled = await allowed('campaign:workflow')
      const pages = palettePages({
        campaignsEnabled,
        canManage: accessAllows(access, 'workspace:update'),
        draftsEnabled: contentDraftsEnabled(),
        sectionLabel: (key) => PLATFORM_DESTINATIONS.find((item) => item.key === key)?.label ?? key,
      })
      const found = (query ? searchPages(pages, query) : pages).slice(0, 15)
      for (const page of found) state.known.add(page.href)
      return {
        ok: true as const,
        pages: found.map((page) => ({
          href: page.href,
          name: page.section ? `${page.label} · ${page.section}` : page.label,
        })),
      }
    },
    inputSchema: z.object({ query: z.string().trim().max(80).optional() }),
    maxCallsPerRun: 4,
    name: 'findPages',
    permission: 'workspace:read',
    timeoutMs: 10_000,
  })

  const getWorkspaceIcp = defineTool(run, {
    description:
      "Read the workspace's ideal customer profile (audience, roles, pains, buying criteria and objections) so copy and visuals speak to the right buyers.",
    effect: 'read',
    execute: async () => {
      const profile = await getIdealCustomerProfile(access)
      if (!profile) {
        return {
          idealCustomerProfile: null,
          note: 'No ideal customer profile has been saved for this workspace yet.',
          ok: true as const,
        }
      }
      return { idealCustomerProfile: profile, ok: true as const }
    },
    inputSchema: z.object({}),
    maxCallsPerRun: 2,
    name: 'getIdealCustomerProfile',
    permission: 'workspace:read',
    timeoutMs: 10_000,
  })

  const listWorkspaceBrandKits = defineTool(run, {
    description:
      "List the workspace's active visual brand kits (id, name, colors, accent, fonts, logo count) so you can inspect or apply them to a design.",
    effect: 'read',
    execute: async () => {
      const stored = await listBrandKits(access)
      const kits = brandKitLibrary(stored).map((kit) => ({
        accent: kit.accent,
        colors: kit.colors,
        id: kit.id,
        logoCount: kit.logos.length,
        name: kit.name,
        primaryFont: kit.primaryFont,
        secondaryFont: kit.secondaryFont,
        version: kit.version,
      }))
      return { brandKits: kits, ok: true as const }
    },
    inputSchema: z.object({}),
    maxCallsPerRun: 2,
    name: 'listBrandKits',
    permission: 'workspace:read',
    timeoutMs: 10_000,
  })

  const searchWorkspaceAssets = defineTool(run, {
    description:
      "Search the workspace's asset library for images or media (screenshots, logos, exports, uploads) by filename or classification so you can reference or insert them.",
    effect: 'read',
    execute: async ({ search, type }) => {
      const { assets } = await listAssets(access, {
        search: search || undefined,
        sort: 'newest',
        take: 10,
        type: type ?? 'image',
      })
      state.known.add('/library')
      return {
        assets: assets.map((asset) => ({
          classification: asset.classification ?? null,
          fileName: asset.fileName ?? null,
          height: asset.height ?? null,
          id: asset.id,
          mediaType: asset.mediaType,
          projectName: asset.projectName ?? null,
          width: asset.width ?? null,
        })),
        ok: true as const,
      }
    },
    inputSchema: z.object({
      search: z.string().trim().max(120).optional(),
      type: z.enum(['all', 'image', 'video']).optional(),
    }),
    maxCallsPerRun: 4,
    name: 'searchWorkspaceAssets',
    permission: 'artifact:read',
    timeoutMs: 15_000,
  })

  const getReleaseDetails = defineTool(run, {
    description:
      'Read one release: its title, status, summary and sources. The open release id is in the page context. This is guidance only; it never decides whether a release is ready.',
    effect: 'read',
    execute: async ({ releaseId }) => {
      const release = await getRelease(access, releaseId)
      if (!release) return { error: 'No such release in this workspace.', ok: false as const }
      state.known.add(`/releases/${release.id}`)
      return {
        note: 'Summarise only these facts. Readiness and approval are decided by people.',
        ok: true as const,
        release,
      }
    },
    inputSchema: z.object({ releaseId: z.uuid() }),
    maxCallsPerRun: 2,
    name: 'getReleaseDetails',
    permission: 'artifact:read',
    timeoutMs: 10_000,
  })

  const getSocialAnalyticsSummary = defineTool(run, {
    description:
      'Read stored social metrics of one publishing profile (social set) for the past days. Without a socialSetId, lists the profiles.',
    effect: 'read',
    execute: async ({ days, socialSetId }) => {
      if (!(await allowed('content:drafts')))
        return { error: 'Posts are not on for this workspace.', ok: false as const }
      const backend = backendSDK(access)
      if (!socialSetId) {
        const { items } = await backend.listSocialSets()
        return { ok: true as const, socialSets: items.map(({ id, name }) => ({ id, name })) }
      }
      const to = new Date()
      const { items } = await backend.listSocialAnalytics({
        from: new Date(to.getTime() - days * 86_400_000).toISOString(),
        socialSetId,
        to: to.toISOString(),
      })
      state.known.add('/publish/analyze')
      return { observations: items.slice(0, 40), ok: true as const, total: items.length }
    },
    inputSchema: z.object({
      days: z.number().int().min(1).max(90).default(28),
      socialSetId: z.string().max(80).optional(),
    }),
    maxCallsPerRun: 3,
    name: 'getSocialAnalyticsSummary',
    permission: 'artifact:read',
    timeoutMs: 15_000,
  })

  const proposeCaptureRecipe = defineTool(run, {
    description:
      'Draft a signed-in capture recipe from plain words, for the person to review on the capture page. Nothing is saved or run. Without ids, lists the connections to choose from.',
    effect: 'read',
    execute: async ({ connectionId, prompt, surfaceId }) => {
      const backend = backendSDK(access)
      state.known.add('/workflows/connections')
      if (!connectionId || !surfaceId || !prompt) {
        const { connections } = await backend.captureOverview()
        return {
          connections,
          note: 'Surface ids come from listProductSurfaces.',
          ok: true as const,
        }
      }
      const { proposal } = await backend.proposeCaptureRecipe({ connectionId, prompt, surfaceId })
      return { ok: true as const, proposal }
    },
    inputSchema: z.object({
      connectionId: z.string().max(80).optional(),
      prompt: z.string().trim().max(500).optional(),
      surfaceId: z.string().max(80).optional(),
    }),
    maxCallsPerRun: 2,
    name: 'proposeCaptureRecipe',
    permission: 'artifact:edit',
    timeoutMs: 60_000,
  })

  const draftPost = defineTool(run, {
    description:
      'Write a social post for the person and offer it under your reply, to open as a draft ' +
      'in the post editor. Nothing is saved until they click. Write the finished post, ' +
      'grounded in what your tools returned (the product, the work, the campaign); never ' +
      'invent features, numbers or links. Keep it to one short post (under 280 characters) ' +
      'unless they ask for longer. At most two per reply.',
    effect: 'read',
    execute: async ({ text }, { signal }) => {
      if (state.posts.length >= ASSISTANT_POSTS_MAX)
        return { error: 'Two posts is the most.', ok: false as const }
      if (!contentDraftsEnabled() || !(await allowed('content:drafts')))
        return { error: 'Posts are not on for this workspace.', ok: false as const }
      // Checked again after the wait: calls in one step run at once, and a timed-out call adds nothing.
      if (signal.aborted || state.posts.length >= ASSISTANT_POSTS_MAX)
        return { error: 'Two posts is the most.', ok: false as const }
      state.posts.push({ text })
      return { offered: true, ok: true as const }
    },
    inputSchema: z.object({ text: z.string().trim().min(1).max(ASSISTANT_POST_MAX) }),
    maxCallsPerRun: ASSISTANT_POSTS_MAX,
    name: 'draftPost',
    permission: 'artifact:edit',
    timeoutMs: 15_000,
  })

  const startWork = defineTool(run, {
    description: START_WORK_DESCRIPTION,
    effect: 'read',
    execute: async (input, { signal }) => {
      if (state.links.length >= MAX_LINKS)
        return { error: 'Four buttons is the most.', ok: false as const }
      // A button the plan does not open would land on the upgrade page without its request.
      if (input.kind === 'canvas' && !(await allowed('workspace:paid')))
        return {
          error: 'Canvases need a paid plan here; start a visual instead.',
          ok: false as const,
        }
      if (input.kind === 'campaign' && !(await allowed('campaign:workflow')))
        return { error: 'Campaigns are not on for this workspace.', ok: false as const }
      // Existing work only where a lookup found it, and only work an AI there can edit.
      if (
        input.kind === 'edit' &&
        !(state.known.has(input.href) && /^\/(editor\?project=|canvas\/)/.test(input.href))
      )
        return {
          error: 'Edit only a screenshot or canvas that listRecentWork returned this turn.',
          ok: false as const,
        }
      const href =
        input.kind === 'visual'
          ? editorAskHref(input.ask)
          : input.kind === 'edit'
            ? withAsk(input.href, input.ask)
            : input.kind === 'campaign'
              ? campaignShipHref(input.shipped)
              : `/canvas/new?${new URLSearchParams({ recipe: input.recipe })}`
      // The contract caps addresses; never offer one the reply could not carry.
      if (!internalHref(href))
        return { error: 'That request is too long for a button; shorten it.', ok: false as const }
      const label =
        input.kind === 'visual'
          ? 'Start this visual'
          : input.kind === 'edit'
            ? 'Edit with AI'
            : input.kind === 'campaign'
              ? 'Start this campaign'
              : `Start a ${CANVAS_RECIPES[input.recipe].name} canvas`
      if (signal.aborted || state.links.length >= MAX_LINKS)
        return { error: 'Four buttons is the most.', ok: false as const }
      if (!state.links.some((link) => link.href === href)) state.links.push({ href, label })
      return { offered: true, ok: true as const }
    },
    inputSchema: z.discriminatedUnion('kind', [
      z.object({ ask: z.string().trim().min(1).max(EDITOR_ASK_MAX), kind: z.literal('visual') }),
      z.object({ kind: z.literal('canvas'), recipe: canvasRecipeSchema }),
      z.object({
        ask: z.string().trim().min(1).max(EDITOR_ASK_MAX),
        href: z.string().trim().min(1).max(300),
        kind: z.literal('edit'),
      }),
      z.object({
        kind: z.literal('campaign'),
        shipped: z.string().trim().min(1).max(CAMPAIGN_SHIP_MAX),
      }),
    ]),
    maxCallsPerRun: 3,
    name: 'startWork',
    permission: 'artifact:edit',
    timeoutMs: 15_000,
  })

  const offerLink = defineTool(run, {
    description:
      'Offer the person a button that opens a page of this app, under your reply. Only an ' +
      'address a tool returned this turn, or the current page. Up to four per reply.',
    effect: 'read',
    execute: ({ href, label }) => {
      const safe = internalHref(href)
      // Names of work are data a teammate wrote; only addresses a lookup returned are offered.
      if (!safe || !state.known.has(safe))
        return { error: 'Offer only an address a tool returned this turn.', ok: false as const }
      if (state.links.length >= MAX_LINKS)
        return { error: 'Four links is the most.', ok: false as const }
      if (!state.links.some((link) => link.href === safe)) state.links.push({ href: safe, label })
      return { offered: true, ok: true as const }
    },
    inputSchema: z.object({
      href: z.string().trim().min(1).max(INTERNAL_HREF_MAX),
      label: z.string().trim().min(1).max(60),
    }),
    maxCallsPerRun: MAX_LINKS + 2,
    name: 'offerLink',
    permission: 'workspace:read',
    timeoutMs: 2_000,
  })

  const inspectWorkspaceSetup = defineTool(run, {
    description:
      'Inspect what is configured and what is still missing in this workspace (product profile, brand voice, visual brand kits, product pages to capture, AI model defaults, and connected agents/campaigns) so you can guide setup step by step and offer direct links.',
    effect: 'read',
    execute: async () => {
      const readiness = await getWorkspaceReadiness(access)
      for (const step of readiness.steps) state.known.add(step.href)
      state.known.add('/settings/ai-models')
      state.known.add('/settings/ai-instructions')
      return {
        aiAgentEnabled: readiness.aiAgentEnabled,
        completed: readiness.completed,
        hasCustomInstructions: readiness.hasCustomInstructions,
        ok: true as const,
        steps: readiness.steps,
        total: readiness.total,
      }
    },
    inputSchema: z.object({}),
    maxCallsPerRun: 2,
    name: 'inspectWorkspaceSetup',
    permission: 'workspace:read',
    timeoutMs: 10_000,
  })

  return {
    draftPost,
    findPages,
    getBrand,
    getIdealCustomerProfile: getWorkspaceIcp,
    getProduct,
    getReleaseDetails,
    getSocialAnalyticsSummary,
    inspectWorkspaceSetup,
    proposeCaptureRecipe,
    listBrandKits: listWorkspaceBrandKits,
    listCampaigns: listWorkspaceCampaigns,
    listProductSurfaces,
    listRecentWork,
    listScheduledPosts,
    offerLink,
    searchWorkspaceAssets,
    startWork,
  }
}
