# RFC execution order

**Updated:** 2026-10-24. All 52 RFCs are renumbered in priority order, following the [release-readiness codebase audit](../release-readiness-audit-2026-10-23.md).

**Assignment amendment (2026-10-24):** The Typefully backlog implementation explicitly
reopens RFC 039 expansion and the scoped draft integrations in RFC 038. This amendment
does not replace release readiness or authorize API-key draft publishing/autonomous
approval. [Work-item coverage](../scheduling/typefully/work-items/coverage.md) tracks
implementation, verification and provider gates separately.

This is the authoritative order for new product work toward the
[Shots north star](../vision.md): meaningful releases become accurate,
approved communications that reach and are used by their intended audiences.
The [company brief](../company.md) defines the customer and commercial
hypotheses. Filenames and RFC numbers now follow the priority order below.

**Start here:** RFC 001 runs the paid-pilot program; RFC 002 is the first
engineering target. Continue through 003, 004, 005 and 006 as each exit gate
passes. RFCs 007–008 are conditional. RFCs 009–035 document existing
capabilities to reuse and maintain; they are not a second implementation queue.
RFCs 036–045 are deferred expansion, and 046–052 are historical designs.
Security, access control and existing-customer reliability remain obligations
at every priority.

The [old-to-new mapping](renumbering-2026-10-24.md) resolves references made
before this renumbering. [catalog.json](catalog.json) records each canonical
ID, filename, previous ID and category; the verifier checks the catalog against
this index and every RFC title. New dependencies and reused capabilities are
separate in the active RFC headers. Historical dependency lists remain context
for earlier designs, not instructions to rebuild superseded architecture.

**Scoped authorization (2026-10-24):** The [Plan and Analyze implementation](../scheduling/typefully/plan-and-analyze/implementation.md) is an explicit exception to the social scheduling/analytics deferral. Its [acceptance matrix](../scheduling/typefully/plan-and-analyze/implementation-matrix.md) records the implemented scope and provider verification dependencies. Other deferred expansions remain deferred.

**Scoped authorization (2026-11-04):** [Code Studio](../code-studio.md) turns code into images, carousels and videos and hands them to Publish. The owner authorized it as a product line beside release readiness; it reuses creative sets, the editor's export pipeline, share links and Publish rather than adding an engine. Its [source-code policy](../code-studio.md#source-code-policy) amends RFC 016's non-goal for explicit member imports only.

**Scoped authorization (2026-11-04):** The [post management implementation](../scheduling/post-bridge/post-management/implementation.md) is a second explicit exception to the same deferral, limited to a month day cap and date notes, library filters and the account allowance. It adds no channels, no client connect links and no second post model. No paid-customer evidence is recorded for it, so its outcome metric decides whether it stays.

**Scoped authorization (2026-11-11):** [Voice capture](../plans/voice-capture-and-evidence-plan.md) records a private voice note on iPhone, transcribes it on the device, syncs it, and turns it into a draft or, after a confirming tap, a scheduled post. It reuses content drafts, approval, `ScheduleContentDraft`, the private media store and the Go model client rather than adding a schema, editor or scheduler; [its implementation plan](../plans/voice-capture-implementation.md) records the owner decisions taken. Its outcome metric is weekly active recorders in pilot workspaces and the drafts and scheduled posts made from their notes. Capture hardening, staying signed in and capture at scale (sections 5.5–5.7 of the plan) stay conditional under RFC 007.

**Scoped authorization (2026-11-13):** [Delete a published post](../scheduling/post-delete/implementation.md) removes what Shots published, from every adapter whose network has a delete call, through the REST API, the web app and MCP. It amends RFC 030, which had no unpublish. It reuses the scheduled post, its receipts, the publish permission and the Temporal worker, and adds one receipt table. Each delete is audited, and an API key needs the new `post:delete` scope.

## Build order and exit gates

**Scoped authorization (2026-11-14):** The [managed AI capture and sign-in recovery
addendum](authenticated-capture-runtime-and-recovery.md) authorizes completing
Verifier capture-to-draft validation and correcting sign-in diagnostics and
same-session live-view recovery under RFC 007. It evaluates managed AI agents
first; provider adoption and self-hosted browser infrastructure remain subject
to their explicit evidence gates.

Each milestone produces usable customer value. Begin assisted pilots now;
advance automation based on the observed bottlenecks and acceptance evidence,
not completion of every historical RFC. Existing access control, approval,
billing and reliability obligations remain prerequisites throughout.

| Order | Work | Reuse | Exit gate |
| --- | --- | --- | --- |
| 0 | [001 — Paid pilots and measurement](001-release-readiness-pilots.md) | Release intake, specs, editing, human approval, exports and billing | A reviewable assisted kit for a real release, explicit facts/approval checklist, actual handoff/use evidence or recorded unknowns, baseline effort/cost and commercial commitment. Start the 90-day validation targets; do not claim them as results. |
| 1a | [002 — Qualified releases](002-release-qualification.md) | 015/011 intake, 016 source changes and existing workflow relevance checks | An owner can qualify, defer or decline a change; grouped/replayed signals preserve one release identity and explicit rollout facts. |
| 1b | [003 — Claim evidence and verification](003-claim-evidence-and-verification.md) | Versioned specs, source collection, 017 product context, 012 human decisions | Material claims have stable IDs, pinned supporting evidence and human decisions. Unsupported/conflicting facts stay unresolved. |
| 2 | [004 — Role-specific kits and readiness](004-release-kits-and-readiness.md) | 020/019 rendering and brand, 013 drafts, existing specs/assets/review | One complete kit can be reviewed and exported; exact-version gates reject unverified facts, unsafe materials and stale approvals. |
| 3 | [005 — Handoffs and adoption](005-release-kit-handoffs-and-adoption.md) | Existing exports, Slack/Notion connections, outbox, Temporal and API contracts | Delivery receipts distinguish accepted, failed and uncertain outcomes; intended-audience use is recorded; repeated release cycles use the same measurement contract. |
| 4 | [006 — Evidence-based freshness](006-evidence-based-material-freshness.md) | 018 capture history, 029 deployment signals and revision proposals | A second release identifies affected claims/images/kits/destinations; humans review and approve corrections without rewriting history. |

The new-work dependency chain is **001 → 002 → 003 → 004 → 005 → 006**.
RFC 001's customer discovery, effort measurement and commercial validation
continue across every stage. A milestone passing local tests does not establish
production readiness or paid repeat adoption.

### Conditional supporting work

[007 — Authenticated product capture](007-authenticated-product-capture.md)
follows verified evidence when private-screen uploads are a demonstrated
bottleneck. It reuses 018/029 and depends on 003's evidence contract. It is
**not** a prerequisite for 004, 005 or 006: reviewed uploads and public capture
support those milestones. The first slice is one isolated, authorized demo
account and origin, followed by revocation and controlled recapture.

Live-provider verification from 008 is required when a pilot actually relies
on those store/Figma flows; it does not justify expanding store features.
Maintain reliability for existing publishing and creative workflows without
making their unused features prerequisites for release readiness.

## Architecture and compatibility rules

- RFCs 001–007 include proposed schemas, commands, state transitions,
  failure handling and implementation test gates. Their
  [shared technical contracts](../release-readiness-technical-contracts.md)
  define tenant keys, authorization, transaction/lock order, version hashes,
  API errors, outbox dispatch and migration rules. These are implementation
  designs, not claims that the new workflows have shipped.
- Reuse Next.js/React, the backend SDK, Go/Ent, PostgreSQL, object storage and
  Temporal. The web never owns database access. New API contracts use the
  existing Zod/route boundary; agent and UI operations share backend authority.
- Add release qualification, claim/evidence, kit and delivery relations around
  existing specs, drafts and assets. Avoid another editor, renderer, job system,
  scheduler or generic autonomous agent framework.
- Preserve existing releases, campaigns and approvals. New verification and
  kit-readiness guarantees require explicit review; migration cannot invent it.
- A new RFC's dependency means the **specific reusable slice** described in its
  design, not every original acceptance criterion of an older partial RFC.
- Older bodies may retain Prisma, Trigger.dev and prior hosting assumptions.
  They are historical where they conflict with the audited architecture. Use
  [Playbook Core](../playbook-core.md), [local development](../local-development.md),
  [deployment](../deployment.md) and the backend implementation for current work.

## Complete RFC inventory

Every numbered document appears exactly once below, in ascending priority order.
“Implementation present” means code was identified, not that all original
criteria or live-provider behavior were verified.

### 001–006: Active delivery

Implement in this order; pilot measurement continues through every stage.

| RFC | Current state | Disposition |
| --- | --- | --- |
| [001 — Release-readiness pilots](001-release-readiness-pilots.md) | Proposed; validation unperformed | Start first; program and outcome definitions continue throughout. |
| [002 — Release qualification](002-release-qualification.md) | Proposed; intake/classification primitives exist | Milestone 1a: accountable intake and rollout facts. |
| [003 — Claim evidence](003-claim-evidence-and-verification.md) | Proposed; citation/spec primitives exist | Milestone 1b: supporting evidence and human verification. |
| [004 — Release kits and readiness](004-release-kits-and-readiness.md) | Proposed; editing/approval primitives exist | Milestone 2: audience materials, manifest, gates and export. |
| [005 — Handoffs and adoption](005-release-kit-handoffs-and-adoption.md) | Proposed; design-delivery adapters exist | Milestone 3: role handoffs, receipts and use evidence. |
| [006 — Evidence-based freshness](006-evidence-based-material-freshness.md) | Proposed; age labels/revision proposals exist | Milestone 4 after repeat use: affected-material review. |

### 007–008: Conditional work

Start only when the stated pilot need or provider flow applies. These do not block the main kit sequence.

| RFC | Current state | Trigger |
| --- | --- | --- |
| [007 — Authenticated capture](007-authenticated-product-capture.md) | Proposed | Repeated private-screen capture pain with paid pilot demand; uploads remain supported. |
| [008 — Store-provider verification](008-store-provider-e2e-verification.md) | Accepted testing design; live-provider result not revalidated | Maintain tests for used flows; run the relevant live gate before relying on a provider. |

### 009–035: Reusable foundations

Reuse and maintain these existing capabilities as the active slices need them. Lower placement does not reduce their security or reliability requirements.

| RFC | Audited starting point | Disposition |
| --- | --- | --- |
| [009 — Auth, enterprise and audit](009-better-auth-enterprise-audit.md) | Auth/RBAC/audit implementation present; full acceptance not re-certified | Foundation: human decisions, membership and access revocation. |
| [010 — Tenant data and media lineage](010-planetscale-tenant-data-model.md) | Go/Ent data model and migrations present; deployment verification separate | Foundation: tenant isolation, additive migrations and lineage. |
| [011 — Release inputs and artifact pipeline](011-release-inputs-and-artifact-pipeline.md) | Releases, notes, uploaded media and assets present | Foundation: preserve original source and artifact lineage. |
| [012 — Approval workflow](012-approval-workflow.md) | Backend human decisions and post transitions present | Preserve authority; extend exact-version kit readiness in 004. |
| [013 — Workspaces and content drafts](013-workspaces-and-content-drafts.md) | npm workspaces, Plate editor, drafts and collaboration present | Reuse document editing and revisions for role artifacts. |
| [014 — REST and Scalar](014-rest-api-scalar-reference.md) | Versioned API, OpenAPI and client present | Extend existing contracts for new resources. |
| [015 — Repository/webhook/provider integrations](015-repository-webhook-scheduler-integrations.md) | Source intake and integrations present | Reuse for 002 and 005; add only pilot-required adapters. |
| [016 — GitHub integration](016-github-integration.md) | PR/release intake and workflow relevance checks present | Reuse for 002; classification is not human qualification. |
| [017 — Product intelligence](017-product-intelligence.md) | Product profile, field provenance and human locks present | Reuse context; add release claim verification in 003. |
| [018 — Product asset map](018-product-asset-map.md) | Surface matching, capture binding/history and age labels present | Reuse in 003/007/006; age is not semantic freshness. |
| [019 — Brand context](019-brand-profile.md) | Brand kit/profile and copy-rule enforcement present | Reuse visual identity and voice for kit artifacts. |
| [020 — Creative engine](020-programmable-creative-engine.md) | Shared design/render/export implementation present | Reuse branded screenshots; no renderer rewrite. |
| [021 — Structured marketing objects](021-structured-marketing-objects.md) | Campaigns, creative links, spec/plan revisions and provenance present | Preserve compatibility; add kit relationships in 004. |
| [022 — Campaign workspace](022-campaign-workspace.md) | Campaign/review UI present | Reuse review components; prioritize kit and facts workflow. |
| [023 — Pricing and unit economics](023-pricing-and-unit-economics.md) | Paid subscription gates and metering present | Maintain pricing; validate pilot packaging and service cost in 001. |
| [024 — Settings and social sets](024-settings-platform.md) | Implementation present with coverage matrix | Maintain workspace/connection controls; unrelated expansion deferred. |
| [025 — Write workspace](025-write-workspace.md) | Draft/write/publish implementation present with coverage matrix | Reuse authoring; social feature parity deferred. |
| [026 — MCP and agents](026-mcp-and-agent-integrations.md) | Go MCP server, tools and OAuth implementation present | Keep parity with backend authority; expose kit operations only as needed. |
| [027 — AI tools](027-ai-sdk-marketing-tools.md) | Typed campaign tool layer and guarded runs present | Reuse bounded draft assistance; no AI factual approval. |
| [028 — Conversational creation](028-conversational-campaign-creation.md) | Campaign copilot implementation present | Optional input surface; manual workflow stays complete. |
| [029 — Deployment screenshots](029-deployment-screenshot-automation.md) | Public capture and workflow rendering present | Reuse history/signals; authenticated extension is 007. |
| [030 — Social publishing](030-social-publishing.md) | Scheduling/publishing lifecycle present; live reliability separate | Maintain existing delivery; optional kit variants only. |
| [031 — Story Sets](031-story-sets.md) | Revisioned composition and delivery implementation present; pilot validation pending | Reuse visuals; broader creative expansion deferred. |
| [032 — Creative Canvas](032-creative-canvas.md) | Implementation present; earlier RFC reports local-only validation | Maintain existing surface; no new canvas scope on the critical path. |
| [033 — Canvas layers and automation](033-canvas-layers-and-automation.md) | Implementation present; earlier RFC reports local-only validation | Reuse existing capabilities; additional canvas work deferred. |
| [034 — Onboarding agent](034-background-onboarding-agent.md) | Go onboarding/profile pipeline present behind configuration | Reuse optional context; URL onboarding is not required for a manual kit. |
| [035 — RPC product surface](035-mvp-rpc-product-surface.md) | tRPC surface present; original single-service architecture superseded | Reuse contracts; Go backend remains data owner. |

### 036–045: Deferred expansion

Reopen with repeated paid-customer evidence and an explicit decision that the work improves release-kit adoption, correctness, effort or retention. Existing functionality still receives necessary fixes.

| RFC | Current state or limit | Why deferred |
| --- | --- | --- |
| [036 — Demo video generation](036-demo-video-generation.md) | Video editing exists; captured-workflow demo product not established | Static evidence and usable kits first; no separate interactive-demo product. |
| [037 — Content pillars/calendar](037-content-pillars.md) | Dedicated pillar-planning proposal not established | Weekly marketing volume is outside the initial job. |
| [038 — External research](038-external-research-tools.md) | Some onboarding enrichment exists; broad research toolset is not the milestone | Prioritize the customer's own release evidence. |
| [039 — Social analytics](039-analytics-ingestion.md) | Plan/Analyze account reports and snapshot ingestion implemented by scoped authorization; wider matched-age/learning loop remains planned | Measure adopted kits in 001/005; impressions are secondary. |
| [040 — Feedback-driven generation](040-feedback-driven-generation.md) | Proposed performance-weight feedback loop | First learn from corrections and audience use. |
| [041 — Recurring campaigns](041-recurring-campaign-generation.md) | Proposed weekly planner; event workflows are a distinct existing capability | No weekly post quota or autonomous calendar commitment. |
| [042 — Scheduling priorities](042-scheduling-feature-priorities.md) | Plan calendar and account analytics, and [media and bulk scheduling](../media-scheduling.md), implemented by scoped authorization; network expansion remains deferred | Network parity and social dashboards are not the current critical path. |
| [043 — Approval policies](043-approval-policies.md) | Generic automatic-approval proposal | New release facts and kit delivery retain explicit human decisions. |
| [044 — Autonomy modes](044-autonomy-modes.md) | Generic autopilot proposal | Automate evidence preparation and bounded handoffs first. |
| [045 — Cloudflare data plane](045-cloudflare-native-data-pipeline.md) | Original Workers/queue proposal not established; R2/rendering already used | No data-plane rewrite is required for the kit workflow; old Trigger.dev premise is obsolete. |

### 046–052: Historical or superseded

Retain these decisions for context. Their original build sequences do not override the active roadmap.

| RFC | Disposition |
| --- | --- |
| [046 — Guided release kit](046-guided-release-kit.md) | Original architecture superseded; retain the release-kit insight. Current kit scope and readiness are defined in 001/004. |
| [047 — Feature-launch recipe](047-feature-launch-recipe.md) | Superseded by the current launch pipeline; reuse bounded stages where useful. |
| [048 — Three core workflows](048-core-workflows.md) | Seven-post chargeable milestone superseded by approved, adopted release kits. Existing workflows remain compatible. |
| [049 — Marketing platform thesis](049-marketing-platform-thesis.md) | Product direction superseded by 001 and the vision; retain reusable implemented primitives. |
| [050 — Trigger.dev jobs](050-trigger-dev-background-jobs.md) | Superseded by existing Go/Temporal execution. |
| [051 — Workspace migration](051-workspace-migration.md) | Superseded by 013; npm workspaces already exist. |
| [052 — Detail audit](052-detail-audit-2026-08-26.md) | Historical design-completeness audit; retain its checks, use the October audit for the current product baseline. |

## Completion evidence

Each new RFC includes a bounded first slice, data/authority boundaries,
acceptance criteria, an outcome metric and rollback behavior. Mark implementation,
local validation, deployed validation and paid customer use separately when
updating status. Do not mark an RFC complete because files exist or its model
produced valid JSON. Run the repository RFC checks and verify the affected
workflow before promoting a milestone.
