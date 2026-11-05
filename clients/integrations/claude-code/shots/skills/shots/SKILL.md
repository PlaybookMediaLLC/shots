---
name: shots
description: Use when the user wants to draft, review, plan, or inspect social content in Shots; prepare a release campaign; add draft comments; or schedule an approved campaign post.
---

# Shots

The existing Shots MCP server acts in one workspace with the scopes its API key or OAuth consent granted. Tools absent from discovery are unavailable to that credential. The REST reference and generated schemas are the authority for field names and limits.

## Content drafts

1. Read `listSocialSets` and `getSocialSet` before selecting destinations. API keys see workspace sets only; a person's private sets require their session in Shots.
2. Search with `listContentDrafts` and read `getContentDraft` before editing. To create a draft, call `createContentDraft` with the selected `socialSetId`, writing, and valid destination IDs. Keep and reuse an `importKey` of 16–128 characters for retries of one creation request. Never replace that receipt after an uncertain response. A changed payload needs a new request.
3. Edit with `updateContentDraft` using the last `baseVersion`. A 409 means another writer committed first: reload and reconcile. Do not overwrite their work by blindly incrementing the version. `duplicateContentDraft` makes a new copy; `updateContentDraftProperties` changes permitted organization fields; `deleteContentDraft` removes an authorized unscheduled draft.
4. `listCalendarPosts`, `bestPostingTimes`, and `listContentDraftPosts` show availability and actual delivery states. `planContentDraft` places a tentative time on the calendar. A plan never publishes, even when its time passes.
5. Link the draft for human review at `<Shots origin>/publish/<id>`. This server has no tool to approve or schedule a content draft. Do not use campaign tools or direct posts to bypass that boundary.
6. `listContentDraftActivity` shows changes. A successful schedule is not proof of publication; distinguish scheduled, processing, published, failed, and unknown outcomes.
7. `updateSocialSetQueue` requires the separate `queue:write` scope and current set `baseVersion`. It changes only future posting-slot suggestions, time zone and natural-time defaults. It never moves existing scheduled posts. `lookupSocialSetMentions` resolves permitted accounts through the selected set; use its returned identity rather than inventing provider IDs.

## Comments

`artifact:read` permits `listDraftComments`, filtered by `status` (`open`, `resolved`, `all`) and `platform`. Writing comments requires the separate `draft:comment` scope. `draft:write` alone does not grant it.

Use `mutateDraftComment` with a current `baseVersion`:

- `add`: provide a stable `commentId` and text. Add `threadId` to reply. A new thread may include `anchor: {platform, postId, quote?}`. Read the post's `post_break.id` from the current body. Omit `quote` for the whole post; otherwise quote a span appearing exactly once in that post. Never invent an anchor.
- `edit` or `delete`: provide the thread and comment IDs. A key edits or deletes its own comments only.
- `resolve`: provide `threadId` and `resolved: true` (or false to reopen).
- `delete_thread`: provide `threadId`. A key can delete its own thread only when all its replies also belong to that key. Preserve other reviewers' contributions.

Authors and timestamps are server-owned. Comments appear as the API key, never as a teammate. Comment-only writes preserve approved publication content. After a timeout, read the threads to reconcile the stable comment ID before attempting a new action. Replays and stale versions return 409.

## Release campaigns

1. Read `listReleases`, `listCampaigns`, and `listApprovals` to avoid duplicate work.
2. `createRelease` describes the user benefit and source links. Use an `idempotencyKey` derived from the release or change.
3. `createCampaign` drafts a name, objective, angles, and channel posts. Do not invent metrics, customers, prices, or unsupported product claims.
4. Capture a public product page with `captureScreenshot`, or use `createAssetUploadUrl`, upload to the returned URL with the declared `Content-Type` and `If-None-Match: *`, and call `completeAssetUpload`.
5. `requestCampaignReview` sends the campaign through the existing human review process.
6. Only after human approval, and when the user's request authorizes scheduling, use `scheduleCampaignPost` with `post:schedule`. Check links using the REST link-preview endpoint before setting `skipLinkCheck: true`. `listScheduledPosts` and the publishing receipts show subsequent outcomes.

## Failures and restrictions

No tool approves content. No key may enter a private social set, change approval policy, bypass publisher permissions, or infer a provider grant from the presence of a UI control. Unsupported or unverified provider features must stay disabled.

`workspace_feature_not_entitled` means the workspace lacks the plan feature; `forbidden` means authority is missing; rate and quota failures carry retry information. An unknown publishing outcome must be reconciled before retrying, since the provider might have accepted the first request.

This plugin supports manual installation and MCP connection. A listing in Claude's public connector directory requires separate vendor approval and is not implied by this source package.
