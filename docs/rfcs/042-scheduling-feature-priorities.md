# RFC 042: Scheduling Feature Priorities

**Priority:** 042 — Deferred expansion
**Previous ID:** 039 ([renumbering map](renumbering-2026-10-24.md))
> **Roadmap disposition (2026-10-23):** Deferred expansion; the priority order below is superseded by release readiness. Maintain existing scheduling behavior.
> See the [current execution order](README.md). Older decision text is
> historical wherever it conflicts with that order or the audited architecture.

**Status:** Deferred; original priority order superseded
**Status note (2026-10-23):** Broader network parity, bulk social scheduling and social analytics are deferred. Maintain the existing Write and settings implementation; prioritize approved release kits.
**Scope update (2026-10-28):** A specific assignment authorizes completing the reliability of the existing scheduling path: reviewed queue slots, scheduling identity, batch partial submission, failure recovery and visibility. See [scheduling reliability](../scheduling/reliability.md). It adds no channels or bulk import.
**Scope update (2026-11-04):** A specific assignment authorizes the gaps the [Post Bridge post management study](../scheduling/post-bridge/post-management/implementation.md) found in existing surfaces: calendar controls and date notes, library filters, and a connections overview. It adds no channels, data model for posts or client connect links. No paid-customer evidence is recorded for it.
**Scope update (2026-10-24):** A specific assignment authorizes the [Plan calendar and Analyze workspace](../scheduling/typefully/plan-and-analyze/implementation.md), including their [80 acceptance criteria](../scheduling/typefully/plan-and-analyze/implementation-matrix.md). This exception implements calendar filtering, placement/lifecycle interactions and account analytics. It does not reactivate the entire bulk-scheduling or network-expansion roadmap.
**Scope update (2026-10-28):** A specific assignment authorizes media scheduling: one photo or video with its caption, one post with several attachments, and Priority 2's bulk batches of up to 50 separate posts, with large-file uploads in parts. The design, capability matrix and evidence are in [media scheduling](../media-scheduling.md). Network expansion and social dashboards stay deferred.

**Date:** 2026-10-19  
**Owners:** Product Engineering  
**Historical dependencies:** RFC 049, RFC 030, RFC 039, RFC 023, RFC 013

## Decision

Build the next scheduling features in this order:

1. **More channels, with their options.** Add LinkedIn pages, Facebook pages,
   YouTube, TikTok, and Pinterest to drafts. Add the settings each channel
   needs: first comment, title, thumbnail, privacy, and disclosures.
2. **Bulk scheduling.** Turn many images, videos, or CSV rows into many queued
   posts in one step.
3. **An analytics dashboard.** Store channel and post metrics over time, and
   show them per channel.
4. **Review and failure notifications.** Tell approvers, authors, and
   publishers when a draft or a post needs them.
5. **A month calendar with filters.**

Other features wait. [Later](#later) gives the reason for each.

The order follows the promise in RFC 049: a founder gets seven good posts from
real product screenshots, approves them, and schedules them. Steps 1 and 2 put
those posts on the networks that reward visuals, all in one step. Step 3 shows
whether the posts worked.

## Evidence

The research is in [docs/scheduling](../scheduling/README.md). It is a
functional reverse engineering of two products, inspected on 13 October 2026:

- [Post Bridge](../scheduling/post-bridge/README.md): the composer, Content
  Studio, Bulk Tools, and post management with Connections.
- [Typefully](../scheduling/typefully/README.md): Write, Plan, Analyze, social
  sets, teams, Inbox and Activity, and Settings.

The Shots column below was checked against the code on 2026-10-19.

## What Shots supports today

| Feature set | Research source | Shots today | Status |
| --- | --- | --- | --- |
| Composer | Typefully Write; Post Bridge composer | Drafts with threads, per-channel text, AI rewrite, previews, polls, one video per post, approvals, share links, revision history, and live co-editing (RFC 013) | Strong |
| Draft lists | Typefully Write; Post Bridge post management | Drafts, Queue, Posted, and Archived tabs | Strong |
| Workspaces and teams | Typefully social sets and teams | A workspace owns its channels, drafts, and settings; roles, SSO, and SCIM | Strong |
| Queue and best times | Typefully Plan and Settings | Weekly posting slots, Add to queue, and best times from engagement | Strong |
| Channels | Post Bridge composer | Drafts publish to X, LinkedIn, Instagram, Threads, Bluesky, and Mastodon | Partial |
| Per-channel options | Post Bridge composer | X follow-ups only: repost, reply, and quote | Missing |
| Bulk scheduling | Post Bridge Bulk Tools | Editor batch export and campaign scheduling; no bulk path into the queue | Missing |
| Analytics | Typefully Analyze | Engagement per post on demand, and best times; no stored history and no dashboard | Partial |
| Notifications | Typefully Inbox and Activity | Campaign reviews send mail; draft reviews, guest comments, and failed posts send nothing | Partial |
| Calendar | Typefully Plan; Post Bridge calendar | A week view with drag to move | Partial |
| Short-video templates | Post Bridge Content Studio | The editor has motion, audio, captions, grids, and MP4 export, but no one-click templates | Partial |

## Priority 1: channels and their options

### What exists

The social API has 36 provider adapters in
`server/internal/social/integrations/social`. The five channels in this step
have adapters: `linkedinpage`, `facebook`, `youtube`, `tiktok` and
`tiktokbusiness`, and `pinterest`. The drafts path does not use them yet.

Three lists name the draft channels, and each holds the same six: the OAuth
providers in `lib/tenant/social-oauth-callback.ts`, the caption limits
`DRAFT_CHANNEL_LIMITS` in `lib/content-drafts/serialize.ts`, and the labels in
`components/drafts/channel-meta.tsx`.

The Go side keeps `draftChannelLimits` and `draftChannelImageLimits` in
`server/internal/product/content_draft_schedule.go`.

### Work

1. Add each channel to the three lists and to the two Go maps, with its caption
   and media limits.
2. Connect each channel through OAuth. Each needs a provider app and the
   provider's app review. Start the reviews first, because TikTok, Meta, and
   Google reviews take weeks.
3. Add typed options per channel to the scheduled post. Validate them in Go, as
   captions are validated today:
   - First comment: X, LinkedIn, LinkedIn pages, Instagram, and Facebook.
   - YouTube: title (100 characters), tags, thumbnail, and visibility.
   - TikTok: privacy level and the commercial-content disclosures that its
     posting rules require before a post can go out.
   - Pinterest: board, title, and link.
   - Instagram: collaborators.
4. Record a failed option apart from the main post. A first comment or a
   thumbnail that fails does not fail the post.

Order inside this step: LinkedIn pages and Facebook pages first, because the
LinkedIn and Meta apps already exist. YouTube is next, then TikTok, then
Pinterest.

### Not in this step

Instagram and Facebook Stories, Instagram trial reels, and TikTok's
hand-off-to-app draft mode.

## Priority 2: bulk scheduling

### What exists

`NextQueueSlot` and the weekly slots in `content_draft_settings` already find
free times. Scheduling a draft creates one scheduled post per channel, with an
idempotency key per draft, channel, and version (RFC 013).

### Work

1. Accept a batch of up to 50 items, the same size as the editor's batch
   export. An item is an image, a video, a design export, or a CSV row with a
   caption, an asset, and channels.
2. Create one draft per item. The draft's history and approvals then work as
   they do for one draft.
3. Offer two ways to set times:
   - **Fill the queue:** each item takes the next free slot.
   - **Spread:** a start time, posts per day (1 to 24), the spacing between
     posts, and an optional random shift of up to 55 minutes in 5-minute
     steps.
4. Show every computed time before anything is scheduled. Validate all items
   first. Schedule the valid items and report each failed row.
5. When the workspace needs approval, the batch creates drafts that wait for
   review.

### Not in this step

Bulk video generation, such as Post Bridge's 2×2 grid videos.

## Priority 3: an analytics dashboard

This step builds the ingestion that RFC 039 describes, starting from what
exists.

### What exists

The social API serves account analytics at `/analytics/:integration` and post
analytics at `/analytics/post/:postId`. Twelve adapters implement analytics,
including X, LinkedIn pages, Instagram, Facebook, Threads, YouTube, TikTok, and
Pinterest. Drafts read one post's engagement on demand, and `BestPostingTimes`
scores live posts by engagement.

### Work

1. A maintenance job stores a daily snapshot per channel connection (followers,
   impressions, and engagement), and the metrics of each post from its first 30
   days.
2. A dashboard per channel shows summary cards, a time series, a post table
   sorted by engagement, and a time-of-day chart.
3. A channel without analytics support shows that state, not zeros. Typefully
   shows "LinkedIn analytics are coming" for this case.
4. Export the post table as CSV.

### Not in this step

Posting goals, public share pages for analytics, and reports that compare
workspaces.

## Priority 4: review and failure notifications

### What exists

Campaign reviews send mail through `notifyReview` in
`server/internal/product/review_mail.go`. A draft review writes the audit
record `product.content_draft_review` and nothing else.

### Work

1. Mail the approvers when a writer requests a review of a draft.
2. Mail the author when a reviewer approves the draft or asks for changes.
3. Mail the author when a guest comments through a share link.
4. Mail the publisher when a post fails, or when a thread stops partway.
5. Let each person turn each kind of mail off.

### Not in this step

An in-app inbox. Mail comes first because the approval flow is unusable when
nobody knows a draft waits for review.

## Priority 5: a month calendar with filters

### What exists

`components/plan/PlanWorkspace.tsx` shows a flex, month or week grid.
`ListContentDraftPostsBetween` already reads any date range.

### Work

1. Add a month view.
2. Filter by channel and by status.
3. Show posted history beside scheduled posts.
4. Keep the time-zone menu above the calendar grid. Post Bridge's grid covers
   its own time-zone menu.

## Later

| Feature | Why it waits |
| --- | --- |
| Instagram and Facebook Stories | They need the Meta channels from Priority 1 first. |
| One-click short-video templates | The editor already makes these videos by hand. Templates only save time. |
| Draft tags and pinning | They help large teams. They do not help the first seven posts. |
| X auto-DM | It needs X permissions that the other follow-ups do not need. |
| Scheduling a draft with an API key | Scheduling a draft needs a signed-in publisher, by design (RFC 013). Campaign posts already accept a key that holds `post:schedule` (RFC 026). Drafts follow only after a product decision. |
| AI UGC avatar videos | They are a separate product line. |

## Lessons from the research

1. **Do not move large media through browser storage.** Post Bridge's Content
   Studio fails to hand a 4 MB video to the composer: the browser's storage
   quota stops it. Pass the asset ID of an uploaded file.
2. **Keep the workspace in every link.** A link on Post Bridge's team
   posted-result page opens the main workspace instead.
3. **Never publish at once by accident.** Post Bridge's public API documents
   that an update of a scheduled post without its time can publish the post at
   once. An update must keep the stored time unless it sets a new one.
4. **Keep extras apart from the post.** A failed first comment or thumbnail
   must not fail the post, and must not hide a successful one.
5. **Show unsupported states.** A channel without a feature shows that state,
   not empty data.

## Acceptance criteria

1. A workspace connects a LinkedIn page, a Facebook page, a YouTube channel, a
   TikTok account, and a Pinterest account, and schedules a draft to each.
2. Each channel rejects a caption or media over its limit, in the composer and
   in Go, with the same numbers.
3. A failed first comment or thumbnail leaves the main post published, and the
   post shows the failed extra.
4. A batch of 50 items fills the queue's next 50 free slots, and a second
   submit of the same batch creates no new posts.
5. A batch in Spread mode shows each computed time before scheduling, and the
   scheduled times match it.
6. The dashboard shows 30 days of stored metrics for each supported channel,
   and an unsupported channel shows that it has no analytics.
7. A review request on a draft mails each approver once, and a failed post
   mails its publisher once.
8. The month view shows scheduled and posted items for the selected channels.

## Observability

Publish success rate per channel is the metric that matters: of the posts due
in a period, how many went live. New channels and bulk batches add many posts,
and a channel that silently fails is the worst result of this RFC.

- Posts scheduled per batch, and rows rejected per batch.
- Failed extras (first comment, thumbnail) per channel.
- Time from a review request to the decision.
- Analytics snapshots that fail per provider.

## Open questions

1. Which channel apps already exist in Meta, Google, TikTok, and Pinterest, and
   which reviews are already done?
2. Does bulk scheduling charge one scheduled post per item, as RFC 023 meters
   posts today?
3. Does the analytics job read providers through the social API, or through
   the direct publisher?
