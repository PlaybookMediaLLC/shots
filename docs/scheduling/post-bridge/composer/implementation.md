# Shots composer implementation

Authorized 13 November 2026 as a scoped exception to the [RFC 042](../../../rfcs/042-scheduling-feature-priorities.md) deferral, as the [post management](../post-management/implementation.md) work was. No paid-customer evidence is recorded for it. The [Post Bridge analysis](post-bridge-new-post-technical-analysis.md) is reference material, not a specification: where they conflict, [media scheduling](../../../media-scheduling.md), [scheduling reliability](../../reliability.md) and the existing model win.

A row marked Slice N is accepted only when that slice has merged with its tests. Each slice ships as its own pull request into `develop`.

## Decisions

Recorded with the owner on 13 November 2026.

- Order: options on existing channels first, then Instagram Stories, then media, then new channels with Facebook Stories, then TikTok's app draft. Facebook Stories wait for the Facebook Pages channel.
- Provider apps: the owner reports a Meta app with Pages permissions, a Pinterest app, a Google Cloud project, and TikTok's `video.upload` scope. Their secret references are asked for when the slice that needs them starts; until they are set, each channel or import stays behind its availability check and is tested against the e2e social mock.
- Google Business and Senja are in scope.
- Nothing here creates accounts or provider apps, or publishes to a real network.
- Slice 3's imports ship apart: Google Drive (3b) runs in the browser under Shots' Google Picker keys; Senja (3c) uses each workspace's own Senja API key, pasted by an admin, since Senja has no OAuth app.
- Slice 4 ships in two parts: Facebook Pages and Pinterest first (4a), then Google Business and Facebook Stories (4b).

## Slices

| Slice | Scope | Owner |
| ----- | ----- | ----- |
| 1 | Instagram collaborators (3), tagged accounts (20), reel cover, grid choice and trial reels; YouTube tags (500 characters), custom thumbnail and synthetic-content disclosure; a failed thumbnail or first comment never fails the post (PB-03); the account switches' state and refusals reach a keyboard and a screen reader (UX-02) | `server/internal/postoptions`, `server/internal/product/content_draft_{options,media,documents}.go`, `server/internal/temporalpublishing/automation.go`, `components/write/composer/{instagram-options,video-options,platforms}.tsx` |
| 2 | Instagram Stories: one image or video, no caption, Meta destinations only; Instagram accounts connected through Facebook Login stay blocked | `server/internal/postoptions`, `components/write/composer/` |
| 3a | Manual crop in the composer; a searchable past-captions picker | `components/write/composer/{media-crop,media-tools,past-captions}.tsx`, `lib/write/grid-layout.ts` (`coverCrop`) |
| 3b | Import images and videos from Google Drive, behind Shots' Google Picker keys | `lib/write/google-drive.ts`, `lib/content-drafts/google-drive.ts`, `components/write/composer/google-drive.tsx` |
| 3c | Import a video testimonial from Senja with the workspace's own Senja API key | `lib/content-drafts/senja.ts`, `app/api/v1/{integrations,content-drafts}/senja/route.ts`, `components/workspace/SenjaKey.tsx`, `components/write/composer/senja-import.tsx`, `lib/tenant/assets.ts` (`storeFetchedAsset`) |
| 4a | Facebook Pages and Pinterest as draft channels, with their limits, behind each channel's availability check: a Page post with a first comment; a pin with its board, title and link | the channel lists in `lib/write/document.ts`, `lib/content-drafts/serialize.ts`, `components/drafts/channel-meta.tsx`, `server/internal/product/content_draft_schedule.go`, `server/internal/medialimits/limits.json`; `server/internal/postoptions/pinterest.go`, `server/internal/product/social_boards.go`, `components/write/composer/pinterest-options.tsx` |
| 4b | Google Business as a draft channel, posting text or one image to a chosen location; Facebook Page stories | the same channel lists; `server/internal/postoptions/facebook.go`, `components/write/composer/{facebook-options,story-toggle}.tsx` |
| 5 | Send a video to the TikTok app as a draft (PB-05), kept apart from a Shots draft | `server/internal/postoptions/video.go`, `server/internal/publishing/repository.go` (`SENT_TO_APP`), `server/internal/social/tenantpublishing/{options,provider}.go`, `components/write/composer/video-options.tsx`, `lib/content-drafts/post-status.ts` |

## Data and authority boundaries

- One `content_draft` with one `scheduled_post` per destination stays the post model. Options live in the platform version (`draftdoc.VersionOptions`) and the post's snapshot (`postoptions.PublishOptions`); Go checks both, as it checks captions.
- An option belongs to the channel whose adapter sends it; scheduling refuses it anywhere else.
- A post's extras are follow-ups of the live post (`post_automation_run`): a first comment and a YouTube thumbnail each have their own receipt, and their failure is shown on the post without failing it.
- An Instagram reel's cover travels in the same request as the reel, because Instagram takes no cover afterwards. Shots checks it before scheduling (JPEG up to 8 MB), so the provider either takes the reel with its cover or refuses both.
- Instagram's trial-reel account rules (a public professional account, 1,000 followers, five a day) are shown beside the switch. Shots cannot read the daily count, so Instagram's refusal reaches the post as its failure reason.
- A cover or thumbnail is an uploaded asset of the workspace and stays in use while a draft or an unfinished post names it.
- A crop, like a frame, saves a new image from the attachment's original (`sourceAssetId`) and keeps its shape and position on the attachment (`cropSettings`), so cropping again starts from the original. Cropping replaces a frame, and framing starts from the original too. The original stays in the library.
- Past captions use the drafts list's own `search`, within the draft's social set, so they read only what the person may already read (`server/internal/product/content_drafts_integration_test.go`: a stranger lists nothing). Each caption is written as the edited channel posts it, so LinkedIn's mention annotation never reaches another channel.
- A crop decodes and encodes through `lib/image-tools` (EXIF orientation, the source's format where a canvas can write it), and saves at most 4096 pixels on its long side; each destination's own size still comes from its derivative. Crop and frame share one save step (`components/write/composer/derived-image.ts`).
- A YouTube thumbnail missing when the video goes out never stops the video: its follow-up is recorded as skipped (`media_unavailable`). A missing Instagram cover cancels the reel, as a missing document cancels a LinkedIn post, because the cover is part of it.
- Instagram refuses the whole post for a private or misspelled collaborator, because collaborators travel with the media. The composer says so beside the field.
- A story is the Instagram version's `placement: "story"`. Its media follow the story rules in `limits.json` (`destinations.instagram.story`), not the feed's, and a story image keeps up to 1,920 pixels on its long edge (`imageProfiles.instagram-standalone-story`); it carries no caption, so the draft's text goes to its other platforms; and it takes no collaborators, tags, reel settings or first comment. Turning a story on clears those settings.
- A Facebook Page post is text, up to 10 photos, or one MP4, as the Graph API's feed and video endpoints take them; a first comment is a follow-up, as on LinkedIn and Instagram. A Page is chosen after Facebook Login, as a LinkedIn page or a YouTube channel is; the page's token never leaves Go.
- A pin is one image, and needs a board. The board is one of the account's own, listed through Go with the account's authorization (`GET /api/v1/social-sets/{id}/pinterest-boards`); the composer shows the list, a loading state, an error with Try again, no boards, or a saved board that is gone, and never an empty picker. Go refuses a scheduled pin without a board, a title over 100 characters and a link that is not an http or https address of up to 2,048 characters, and the publisher refuses it again before Pinterest sees it.
- A video pin needs a separate cover image, which Shots does not send yet, so Pinterest takes images only and the composer says "Pinterest needs an image". Pinterest tokens renew with the others before they expire; a throttled or failing Pinterest is retried on the next run rather than asking for a reconnect, and a Pinterest error answer is never read as an empty board list.
- A link being typed saves with the draft; the whole address is checked when the pin is scheduled. The public `POST /api/v1/posts` takes a pin's board, title and link as `platforms.pinterest.options.pinterest`.
- A Facebook account with no Page it can post as is refused at connection, before anything is saved. A Page token, minted from a long-lived user token, is stored without an expiry.
- Google Drive import runs in the browser: Google Picker opens under Shots' Google Cloud project with the person's `drive.file` token, which reads only the files they pick and never leaves the browser. The picked files download from Drive and go through the composer's own upload, as a dropped file does, so the upload checks, quota and video probing all apply. Google's sign-in opens from a button in the import dialog, inside the click, so no browser blocks its popup. It takes up to 20 images and videos at a time (the composer's upload types), refuses before downloading anything larger than Shots uploads for its type, uploads the files that arrive and names those that did not, and cancels the downloads if the dialog closes. It stays unavailable, with a "Not set up" command that explains why, until `GOOGLE_PICKER_CLIENT_ID`, `GOOGLE_PICKER_API_KEY` and `GOOGLE_PICKER_APP_ID` are deployed. A half setup stays unavailable and logs why.
- Senja import uses the workspace's own Senja API key: Senja has no OAuth app. An owner or admin pastes the project's key under Settings, Integrations; Shots checks it with Senja, seals it like other integration credentials (`INTEGRATION_ENCRYPTION_KEY`) and stores it as the workspace's one `SENJA` integration, which the delivery integrations list leaves out. The key is never returned. A member who can edit drafts lists the project's newest 100 approved video testimonials and imports one: the server re-reads it from Senja by id, fetches its MP4 through the SSRF-guarded fetch, bounded by the upload's own video limit, and stores it through the same reservation, signed upload and Go completion checks as a browser upload, in parts above 16 MB. Without a key, the command reads "Not set up" and says where an admin adds it, and the list and import answer 409 without asking Senja.
- A Facebook Page story is the Facebook version's `placement: "story"`, as an Instagram story is Instagram's. Both go through one check (`PublishOptions.Story`): one image or MP4 of 3 to 60 seconds (`destinations.facebook.story` in `limits.json`), no text and no first comment. A Page story is left out of post analytics, as an Instagram story is.
- A Google Business post is a standard "What's new" post of text, up to 1,500 characters, with at most one image (JPEG or PNG, at least 250 pixels wide), to the location chosen after Google sign-in. Events, offers and call-to-action buttons are not offered. Google Business needs its own keys (`GOOGLE_GMB_CLIENT_ID`/`SECRET`); the adapter would borrow YouTube's, but the Business Profile API needs its own approval, so availability waits for its keys. Its tokens renew with YouTube's and TikTok's, reading only the chosen location, and a throttled or failing Google retries on the next run. Local posts have no per-post metrics, so post analytics read as unsupported for it.

- A TikTok app draft is the TikTok version's `sendToApp`. It goes out with the Content Posting API's `UPLOAD` (TikTok's `video.upload` scope, which every TikTok connection grants), carrying the video and caption alone: TikTok ignores privacy, interactions, disclosures and the AI label then, so Go refuses them beside `sendToApp`, and neither privacy nor consent is asked for. The account's maximum video length still applies.
- An app draft that reaches the person's TikTok inbox is `SENT_TO_APP`, a post state of its own: delivered, never published. It has no `publishedAt`, stays out of post analytics and the `draft.published` webhook, and records `post.sent_to_app` instead of `post.published`. Its remote id is TikTok's inbox publish id. The drafts list counts it apart (`sentToAppPosts`) and lists it with the posted drafts; every post surface reads it as "Sent to app" and says to finish it in TikTok. The composer treats its account as done, as for a live post, so scheduling again never sends it twice. It is not a Shots draft, which never leaves Shots. A scheduled TikTok post TikTok answers with an inbox receipt, or an app draft TikTok answers with a live one, is of unknown delivery.

### Known gaps (Slice 3c)

- Only the newest 100 approved video testimonials are offered; older ones are not paged to.
- A testimonial's video is held whole in the web server's memory while it is stored, up to the upload's video limit.
- Senja's video addresses are not documented, so the fetch accepts any public HTTPS host that passes the SSRF guard, rather than a list of Senja's hosts.
- An imported video gets no poster frame; lists fall back to the browser's first frame, as for any video without one.
- The browser journey covers the unavailable state; the import itself is covered against a stand-in Senja at the server tier, since the e2e web cannot reach Senja.

### Known gaps (Slice 3b)

- Google's real Picker and sign-in run only once Shots' keys are deployed. The browser journey replaces both scripts and Drive's download, so the first live import is the check that the OAuth client, API key and project number belong together.
- Files on shared drives are not offered: the Picker lists the person's own Drive.
- A picked video downloads whole into the browser before its upload starts, so a large file waits on both.
- Picker asks for Drive access each time it opens; Shots keeps no Drive token.

### Known gaps (Slice 5)

- Shots does not learn when the person posts an app draft in TikTok, or whether TikTok discarded it, so a sent app draft stays "Sent to app" and its post is never imported into analytics.
- The activity event `post.sent_to_app` has no per-social-set notification setting; members choose it once for the workspace.
- An app draft of unknown delivery (TikTok's answer was lost, or did not match an inbox receipt) can be reconciled only as live, which needs a TikTok video URL, or as not there and retried, which uploads it to the inbox again. TikTok holds at most five pending inbox drafts a day. Recording "it reached the app" needs the post's options on the web's post rows, which they do not carry yet.

### Known gaps (Slice 4b)

- Shots checks a Google Business image's width (250 px) but not its height or its 10 KB floor, and checks the original, not the derivative a tall image becomes. Google refuses such an image at publish, so the post fails with nothing created.
- A Facebook video story's shape (9:16, at least 540×960) is not checked before scheduling; Facebook refuses another shape after the upload, and Shots records the post as of unknown delivery, as for any failure after the upload starts.
- Google Business treats a post Google is still processing as published; one Google rejects later stays published in Shots.
- Facebook's deauthorize and data deletion callbacks name a Facebook user, not the Page Shots stores, so they are not wired for Facebook Pages, as they are not for Instagram's Facebook Login.
- A story is left out of post analytics: Instagram keeps a story's insights for a day and offers none of a feed post's counts. Its link stops working after 24 hours, so a story of unknown delivery has to be checked on the account within that day.

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
| A crop is kept as its own asset, and the original stays | 3a |
| Past captions search the workspace's own drafts only | 3a |
| Drive import shows its unavailable state until Shots' Picker keys exist, and a picked file is a workspace asset, uploaded as a dropped file is | 3b |
| Senja import shows its unavailable state until the workspace saves its key, and an imported testimonial is a workspace asset | 3c |
| A Senja key is checked with Senja before it is saved, is never returned, and only owners and admins save or remove it | 3c |
| Facebook Pages and Pinterest connect behind their availability checks, schedule against the e2e social mock, and refuse a caption or media over their limits in the composer and in Go with the same numbers | 4a |
| A pin publishes to the board chosen in the composer, with its title and link; a pin without a board is refused in the composer, in Go and in the publisher | 4a |
| A Facebook Page post's first comment is its own follow-up | 4a |
| Google Business connects behind its availability check, a location is chosen after sign-in, and a post of text and one image schedules against the e2e social mock | 4b |
| A Facebook story takes one image or MP4 and no caption or first comment, in the composer and in Go; it publishes with `post_type=story` | 4b |
| A TikTok app draft is sent with `video.upload`, never counts as published, and says the person finishes it in TikTok | 5 |
| An app draft asks for no privacy or consent, and Go refuses the settings TikTok would ignore beside it | 5 |

## Outcome metric

Weekly scheduled posts that use an Instagram or YouTube option, and the share of thumbnails that fail, read beside release-kit adoption. If neither moves in a quarter, remove the options rather than extend them.

## Rollback

- Slice 1 rolls forward only. Deploy the migration, then the API and worker together, then the web. The previous code ignores the new options rather than refusing them: an older worker would publish a scheduled trial reel, or a reel kept off the grid, as an ordinary reel, and a YouTube video without its tags, disclosure or thumbnail; the previous web cannot read a post with a `thumbnail` follow-up. Before any redeploy of older code, hold the queued posts that set them (`"publishOptions" ? 'instagram'`, or `"publishOptions"->'youtube' ?| array['tags','containsSyntheticMedia','thumbnailAssetId']`). The migration's constraint and function can stay; the old constraint cannot be restored while `thumbnail` rows exist.
- Slice 2 has no migration. It rolls forward only, for the same reasons as Slice 1: an older worker ignores `placement` and would publish a queued photo story as a feed post with no caption and a video story as a public Reel, and the older web cannot read a draft or post that holds `placement`. Before redeploying older code, hold the queued posts with `"publishOptions"->'instagram'->>'placement' = 'story'`.
- Slice 3a is web only and additive: redeploy the previous web to roll back. Crops already saved stay ordinary images on their attachments.
- Slice 3b is web only and additive: unset the Picker keys to turn Drive import off, or redeploy the previous web. Imported files stay ordinary workspace assets.
- Slice 3c widens `integration_connection`'s provider check to `SENJA` (`20261113120000_senja_integration.sql`). Deploy the migration, then the API, then the web. To roll back, delete the `SENJA` rows first (`DELETE FROM integration_connection WHERE provider = 'SENJA'`): the previous web cannot read a workspace's integrations while one exists. Then redeploy the previous web. Imported videos stay ordinary assets.
- Slice 4b has no migration and rolls forward only, as Slice 4a does: the previous web cannot read a draft with a Google Business version or a Facebook `placement`, and an older worker would publish a queued Facebook story as a feed post. Before redeploying older code, hold queued posts to `gmb`, and those with `"publishOptions"->'facebook'->>'placement' = 'story'`.
- Slice 5 adds the `SENT_TO_APP` post status (`20261113110000_sent_to_app_status.sql`) and rolls forward only: deploy the migration, then the API and worker together, then the web. An enum value cannot be removed, and the previous code cannot read a post in that state. An older worker ignores `sendToApp` and would publish a queued app draft directly, without privacy or consent, which Go's check refuses at publish, so the post fails. Before redeploying older code, hold the queued posts with `"publishOptions"->'tiktok'->>'sendToApp' = 'true'`.
- Slice 4a has no migration. It rolls forward only: the previous web cannot read a draft with a Facebook or Pinterest version, and the previous API and worker refuse both platforms, so a queued post to them fails rather than publishing. Before redeploying older code, hold the queued posts whose connection's platform is `facebook` or `pinterest`. Listing a channel in `HIDDEN_PROVIDERS` stops new connections only: accounts already connected keep scheduling and publishing.
- Later slices: redeploy the previous web and API; each records its own migration order here when it has one.

## Verification

```bash
python3 dev/verify-rfcs.py
(cd clients && npm run quality:check)
make -C server check
make e2e
./dev/social-gate
```

`test/e2e/composer-options.spec.ts` covers the composer journeys; `test/e2e/social-gate.spec.ts` covers a refused thumbnail through the worker, a pin whose board is chosen in the composer and a Facebook Page post with its first comment, and a TikTok app draft chosen in the composer that ends sent to the app and never published, through Go to the e2e social mock.

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
| UI-16, UI-17 | Slice 3b: Drive imports the images and videos a post takes, up to 20 at a time, and says when it is not set up. Slice 3c: Senja. |
| UI-18 | Slice 1: reel cover, grid choice, trial rules and graduation. |
| UI-19 | Skip: Shots asks for an explicit YouTube title rather than taking the caption's first 100 characters. |
| UI-20 | Exists: a first comment is a follow-up with its own receipt; account health asks for a reconnect when a permission is missing. |
| UP-01 | Exists for JPEG, PNG, WebP and GIF, with conversions listed before scheduling ([media scheduling](../../../media-scheduling.md#capabilities)). HEIC, HEIF and AVIF are skipped. |
| UP-02 | Exists: each destination's media count, checked in the composer and in Go (`TestDraftMediaFollowsEachDestination`). |
| UP-03 | Exists for reorder, replace and remove (`components/write/composer/media-tools.tsx`); crop is Slice 3a. |
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
| PB-04 | Slice 2 for Instagram, Slice 4b for Facebook: one image or video, no caption, no first comment. |
| PB-05 | Slice 5: a TikTok app draft is `SENT_TO_APP`, apart from a Shots draft and never published. |
| PB-06 | Exists: duplicating a draft copies its references, and retention keeps media a draft or post still names. |
| UX-01 | Skip: accounts come from the draft's social set; there is no remembered selection to leak between workspaces. |
| UX-02 | Slice 1. |
