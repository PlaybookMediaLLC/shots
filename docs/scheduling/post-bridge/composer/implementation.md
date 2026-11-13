# Shots composer implementation

Authorized 13 November 2026 as a scoped exception to the [RFC 042](../../../rfcs/042-scheduling-feature-priorities.md) deferral, as the [post management](../post-management/implementation.md) work was. No paid-customer evidence is recorded for it. The [Post Bridge analysis](post-bridge-new-post-technical-analysis.md) is reference material, not a specification: where they conflict, [media scheduling](../../../media-scheduling.md), [scheduling reliability](../../reliability.md) and the existing model win.

A row marked Slice N is accepted only when that slice has merged with its tests. Each slice ships as its own pull request into `develop`.

## Decisions

Recorded with the owner on 13 November 2026.

- Order: options on existing channels first, then Instagram Stories, then media, then new channels with Facebook Stories, then TikTok's app draft. Facebook Stories wait for the Facebook Pages channel.
- Provider apps: the owner reports a Meta app with Pages permissions, a Pinterest app, a Google Cloud project, and TikTok's `video.upload` scope. Their secret references are asked for when the slice that needs them starts; until they are set, each channel or import stays behind its availability check and is tested against the e2e social mock.
- Google Business and Senja are in scope.
- Nothing here creates accounts or provider apps, or publishes to a real network.

## Slices

| Slice | Scope | Owner |
| ----- | ----- | ----- |
| 1 | Instagram collaborators (3), tagged accounts (20), reel cover, grid choice and trial reels; YouTube tags (500 characters), custom thumbnail and synthetic-content disclosure; a failed thumbnail or first comment never fails the post (PB-03); the account switches' state and refusals reach a keyboard and a screen reader (UX-02) | `server/internal/postoptions`, `server/internal/product/content_draft_{options,media,documents}.go`, `server/internal/temporalpublishing/automation.go`, `components/write/composer/{instagram-options,video-options,platforms}.tsx` |
| 2 | Instagram Stories: one image or video, no caption, Meta destinations only; Instagram accounts connected through Facebook Login stay blocked | `server/internal/postoptions`, `components/write/composer/` |
| 3 | Manual crop in the composer; import from Google Drive and Senja; a searchable past-captions picker | `components/write/composer/media-tools.tsx`, `components/write/composer/media-import-dialog.tsx` |
| 4 | Facebook Pages, Pinterest and Google Business as draft channels, with their limits, behind each channel's availability check; Facebook Stories | the channel lists in `lib/tenant/social-oauth-callback.ts`, `lib/content-drafts/serialize.ts`, `components/drafts/channel-meta.tsx`, `server/internal/product/content_draft_schedule.go`, `server/internal/medialimits/limits.json` |
| 5 | Send a video to the TikTok app as a draft (PB-05), kept apart from a Shots draft | `server/internal/postoptions/video.go`, `server/internal/social/integrations/social/tiktok` |

## Data and authority boundaries

- One `content_draft` with one `scheduled_post` per destination stays the post model. Options live in the platform version (`draftdoc.VersionOptions`) and the post's snapshot (`postoptions.PublishOptions`); Go checks both, as it checks captions.
- An option belongs to the channel whose adapter sends it; scheduling refuses it anywhere else.
- A post's extras are follow-ups of the live post (`post_automation_run`): a first comment and a YouTube thumbnail each have their own receipt, and their failure is shown on the post without failing it.
- An Instagram reel's cover travels in the same request as the reel, because Instagram takes no cover afterwards. Shots checks it before scheduling (JPEG up to 8 MB), so the provider either takes the reel with its cover or refuses both.
- Instagram's trial-reel account rules (a public professional account, 1,000 followers, five a day) are shown beside the switch. Shots cannot read the daily count, so Instagram's refusal reaches the post as its failure reason.
- A cover or thumbnail is an uploaded asset of the workspace and stays in use while a draft or an unfinished post names it.
- A YouTube thumbnail missing when the video goes out never stops the video: its follow-up is recorded as skipped (`media_unavailable`). A missing Instagram cover cancels the reel, as a missing document cancels a LinkedIn post, because the cover is part of it.
- Instagram refuses the whole post for a private or misspelled collaborator, because collaborators travel with the media. The composer says so beside the field.
- A story is the Instagram version's `placement: "story"`. Its media follow the story rules in `limits.json` (`destinations.instagram.story`), not the feed's; it carries no caption, so the draft's text goes to its other platforms; and it takes no collaborators, tags, reel settings or first comment. Turning a story on clears those settings.

### Known limit

A thumbnail deleted in the moments between the video going live and its follow-up is recorded as a failed follow-up; the video is unaffected.

## Acceptance

| Behavior | Slice |
| --- | --- |
| Collaborators over 3, tagged accounts over 20, invalid or repeated handles and a graduation without a trial are refused in Go and never stored | 1 |
| A cover, grid choice or trial on anything but one video is refused before scheduling, in the composer and in Go, with the same words | 1 |
| Tags reach the reel without positions, and the first photo of a carousel with positions | 1 |
| YouTube tags count as YouTube counts them; over 500 characters is refused in the composer and in Go | 1 |
| Tags and the synthetic-content disclosure reach the YouTube upload | 1 |
| A YouTube thumbnail is set after the video is live; a refusal leaves the video published and the post shows the failed thumbnail | 1 |
| A cover or thumbnail in a format or size its destination does not take is refused before scheduling | 1 |
| A cover or thumbnail named by a draft or an unfinished post cannot be deleted | 1 |
| The account switches toggle from the keyboard, the active tab reports `aria-pressed`, and a switch that is off says why | 1 |
| A story takes one image or video and no caption; a second file or a caption is refused | 2 |
| A story publishes with `media_type=STORIES` to Instagram Login accounts only | 2 |
| A crop is kept as its own asset, and the original stays | 3 |
| Drive and Senja imports show their unavailable state until their keys exist, and imported files are workspace assets | 3 |
| Past captions search the workspace's own drafts only | 3 |
| Each new channel connects behind its availability check, schedules against the e2e social mock, and refuses a caption or media over its limit in the composer and in Go with the same numbers | 4 |
| A TikTok app draft is sent with `video.upload`, never counts as published, and says the person finishes it in TikTok | 5 |

## Outcome metric

Weekly scheduled posts that use an Instagram or YouTube option, and the share of thumbnails that fail, read beside release-kit adoption. If neither moves in a quarter, remove the options rather than extend them.

## Rollback

- Slice 1 rolls forward only. Deploy the migration, then the API and worker together, then the web. The previous code ignores the new options rather than refusing them: an older worker would publish a scheduled trial reel, or a reel kept off the grid, as an ordinary reel, and a YouTube video without its tags, disclosure or thumbnail; the previous web cannot read a post with a `thumbnail` follow-up. Before any redeploy of older code, hold the queued posts that set them (`"publishOptions" ? 'instagram'`, or `"publishOptions"->'youtube' ?| array['tags','containsSyntheticMedia','thumbnailAssetId']`). The migration's constraint and function can stay; the old constraint cannot be restored while `thumbnail` rows exist.
- Slice 2 has no migration. It rolls forward only for the same reason as Slice 1: older code ignores `placement` and would publish a queued story as a feed post. Before redeploying older code, hold the queued posts with `"publishOptions"->'instagram'->>'placement' = 'story'`.
- Later slices: redeploy the previous web and API; each records its own migration order here when it has one.

## Verification

```bash
python3 dev/verify-rfcs.py
(cd clients && npm run quality:check)
make -C server check
make e2e
./dev/social-gate
```

`test/e2e/composer-options.spec.ts` covers the composer journeys; `test/e2e/social-gate.spec.ts` covers a refused thumbnail through the worker.

## Check mapping

Every check from the [verification matrix](post-bridge-verification-matrix.csv), against Shots. "Exists" was established by reading the code on 13 November 2026 unless a test is named.

| Check | Disposition |
| --- | --- |
| UI-01 | Exists: one composer for text, images and video. Stories are Slice 2. |
| UI-02 | Exists: a social set holds one active account per platform. |
| UI-03 | Exists: platform tabs, each with its own version and options (`components/write/composer/platforms.tsx`). |
| UI-04 | Skip: a set lists at most one account per platform, so there is nothing to search. |
| UI-05 | Exists: each tab counts its own limit, X Premium from the account's verified capabilities. |
| UI-06 | Exists with a stricter rule: a version over its limit blocks scheduling and is marked; Shots never truncates. |
| UI-07 | Exists: a manual version per platform, and resync to the main text. |
| UI-08 | Exists with a stricter rule: an empty post is refused ("Write something to post"). |
| UI-09, UI-10 | Exists: the schedule dialog requires a time and shows it in the chosen zone. |
| UI-11 | Exists: with no free slot the dialog says so and offers no queue confirm. |
| UI-12, UI-13 | Exists: per-destination formats and counts in `limits.json`. HEIC, HEIF and AVIF uploads are not offered. |
| UI-14, UI-15 | Slice 2: one image or video, and the help says so. |
| UI-16, UI-17 | Slice 3: imports offer what the destination takes; Drive and Senja show their unavailable state until configured. |
| UI-18 | Slice 1: reel cover, grid choice, trial rules and graduation. |
| UI-19 | Skip: Shots asks for an explicit YouTube title rather than taking the caption's first 100 characters. |
| UI-20 | Exists: a first comment is a follow-up with its own receipt; account health asks for a reconnect when a permission is missing. |
| UP-01 | Exists for JPEG, PNG, WebP and GIF, with conversions listed before scheduling ([media scheduling](../../../media-scheduling.md#capabilities)). HEIC, HEIF and AVIF are skipped. |
| UP-02 | Exists: each destination's media count, checked in the composer and in Go (`TestDraftMediaFollowsEachDestination`). |
| UP-03 | Exists for reorder, replace and remove (`components/write/composer/media-tools.tsx`); crop is Slice 3. |
| UP-04 | Exists: video length and format bounds from `limits.json`, checked in Go. |
| UP-05 | Exists: resumable uploads and recovery ([media scheduling](../../../media-scheduling.md#recovery)). |
| UP-06 | Slice 2. |
| UP-07 | Slice 1: Instagram reel cover and YouTube thumbnail, with Shorts and unverified channels explained. |
| DA-01 | Exists: drafts autosave, and a draft never publishes. |
| DA-02 | Exists: synced and manual versions; a manual version keeps its text until resynced. |
| DA-03 | Exists: each provider's counting rules (`lib/write/caption-counting.ts`). |
| SC-01 | Exists: zoned times and daylight-saving gaps ([scheduling reliability](../../reliability.md)). |
| SC-02 | Exists: an update keeps the stored time (RFC 042 lesson 3). |
| SC-03 | Exists: reviewed queue slots ([scheduling reliability](../../reliability.md)). |
| PB-01 | Exists: an idempotency key per draft, channel and version; an ambiguous publish is `UNKNOWN_DELIVERY` and never retried automatically. |
| PB-02 | Exists: one `scheduled_post` per destination; a failed one is retried alone. |
| PB-03 | Slice 1: first comments already ran as follow-ups; the YouTube thumbnail moves out of the upload into its own follow-up. |
| PB-04 | Slice 2 for Instagram, Slice 4 for Facebook. |
| PB-05 | Slice 5. |
| PB-06 | Exists: duplicating a draft copies its references, and retention keeps media a draft or post still names. |
| UX-01 | Skip: accounts come from the draft's social set; there is no remembered selection to leak between workspaces. |
| UX-02 | Slice 1. |
