# Social publishing verification

The Go product backend owns `scheduled_post` and `publication_attempt` in the
product PostgreSQL database's `public` schema. Its Temporal worker calls the
Go provider adapters directly. The web calls the workspace
`screenshot-studio-backend-sdk`; it has no social API key, database connection,
or provider client. Private media remains in R2 and is signed when a publish
activity runs. A confirmed remote receipt is required for `PUBLISHED`.

## Local implementation and verification (2026-11-03, in progress)

The current uncommitted implementation adds LinkedIn Page selection, TikTok
Direct Post and YouTube video publishing to the existing composer, canonical
post/attempt records and Temporal worker. It adds no scheduler or table.
TikTok and YouTube each accept one MP4. Required provider settings are saved
in the scheduled snapshot; current TikTok creator restrictions are checked at
scheduling and send time. YouTube processing must finish before `PUBLISHED`.
Safe native receipts survive uncertain processing; uncertain mutations are
never resubmitted automatically. Outcome recording retries independently of
publication, including when the database is briefly unavailable.

This run uses local Compose and HTTPS tunnels only. Credentials are stored in
Infisical project **Desktop App Backend**
(`04ebc1cf-0ec5-4e9e-8ab9-4c6da4252574`), environment **dev**, folder
**/screenshot-studio**. This explicitly replaces the initially supplied
Playbook Infrastructure project. Ten required credential keys are present for X, LinkedIn, Instagram Login,
TikTok and YouTube. TikTok uses a dedicated development sandbox.
No production or staging credential environment was imported.

| Destination | Status | Evidence and remaining acceptance |
| --- | --- | --- |
| X `@yoanyombax` | Live-verified | App 33604797 (Shots Local Schedule 20261103) authorized after explicit user confirmation. Image and silent 8-second video scheduled through Write at 21:59 and 22:01 UTC; both PUBLISHED with one successful attempt and completed workflow. Public audience, native media and playback verified. Both posts deleted, removal verified, profile returned to its baseline 27 posts with no visible canaries, and uploaded assets deleted. The approved one-time $5 credit is funded; no further purchase or auto-recharge enabled. |
| LinkedIn member `yoanyomba` | Live-verified | Scheduled image and 8-second video reached the correct member, with canonical `PUBLISHED`, successful attempts and completed workflows. Public audience and video playback verified; both posts deleted and removal verified. |
| LinkedIn Page `106498803` | Ready, blocked externally | Dedicated app 266682906 (Shots Local Page Publishing) is verified under Solomon AI, Page 106498803. The user completed and submitted the Community Management Development Tier application; its confirmation page shows 100% completion. LinkedIn business review and possible Microsoft Vetting Services email verification are pending. The refreshed developer Products page now explicitly shows Review in progress; no organization grant is approved. No review/vetting email was visible in the connected mailbox at this check. Original member credentials remain installed; Page delivery remains unverified. At 2026-11-04 00:04 UTC the Products page still showed Review in progress. Code is ready for the separate app: `PLATFORM_LINKEDIN_PAGE_CLIENT_ID`/`_SECRET` select it, and the Page connection uses `r_basicprofile` instead of OpenID, which a Community Management-only app cannot hold. After approval: install the pair, add the `/integrations/social/linkedin-page` redirect URL on app 266682906, connect the Page and run the image and video canaries. |
| Instagram Login `@get.eigenn` | Live-verified | Scheduled feed image and 8-second Reel reached the correct account, with canonical `PUBLISHED`, successful attempts and completed workflows. Public-account setting and Reel playback verified; both posts deleted and profile returned to zero posts. |
| TikTok `@the_dark_lightskin` | Live-verified | The 21:20 UTC scheduled private video reached the correct account, with native ID 7704057968177761550, expected caption, 8-second playback, and no duplicate. TikTok withholds API post IDs for private posts: bounded confirmation settled as UNKNOWN_DELIVERY, then the existing manual recovery control recorded the observed native URL and PUBLISHED state. The original attempt retains its honest UNKNOWN_DELIVERY result. Video deleted, removal verified, original public-account and Everyone-comment settings restored by 21:37:56 UTC. Automatic private receipt confirmation remains unavailable. |
| YouTube `@getconduitt` | Live-verified | Connected channel `UCxLu7ug1TidhIuR_mNh584w`; automatic token renewal verified. The Write-scheduled post `cmw1ci1dn000201pj8uvf8z5x` (due 00:20 UTC, private, not made for kids) settled as UNKNOWN_DELIVERY without an upload: the adapter sized the media with HEAD, and the GET-signed delivery URL answers HEAD with 403. The channel showed zero uploads, so the existing recovery control reconciled it as not live, and the YouTube adapter now uses the shared `MediaSize` ranged GET. The retry, post `cmw1dmsuz000101k16e1pztw5`, published `lNZBbVsTZ1E` with one successful attempt: correct channel, private, processed, 8 s HD, one upload. Playback was not observed in a signed-in browser (the channel's Chrome profile was not reachable); processing status and duration come from the YouTube Data API. Video deleted and removal verified; draft archived and asset deleted. |

All seven delivered canaries were scheduled through Write 5–10 minutes ahead.
The YouTube canary was scheduled through Write about 25 minutes ahead; the
existing retry control delivered it after the media-size fix.
The six X/LinkedIn/Instagram posts each have one successful publication attempt.
TikTok has one attempted mutation, an UNKNOWN_DELIVERY attempt, and an audited
manual reconciliation after signed-in native-video confirmation. LinkedIn's recent Posts feed had
no matching canary after deletion; Instagram showed exactly two intended
canaries before deletion and zero posts afterward. Screenshots and safe JSON
records are retained under `.context/`: `canary-receipts.json`,
`canary-workflows.json`, `canary-cleanup.json` and `local-canary-cleanup.json`.

| Canary | Scheduled UTC | Canonical post / attempt | Native receipt and original URL | Cleanup |
| --- | --- | --- | --- | --- |
| LinkedIn image | 2026-11-03 20:36 | `cmw1559gg000q01lkol13aozr` / `cmw15dy94000401ph59nttfs2` | `urn:li:share:7523483230369632256`; [post](https://www.linkedin.com/feed/update/urn:li:share:7523483230369632256/) | Removal verified by 20:38:06 UTC; `linkedin-image-live.jpg`, `linkedin-image-public-audience.jpg`, `linkedin-image-deleted.jpg`. |
| LinkedIn video | 2026-11-03 20:38 | `cmw156j1x001401lkbgx7azkd` / `cmw15givb000701phu9o8t85d` | `urn:li:ugcPost:7523483737280581632`; [post](https://www.linkedin.com/feed/update/urn:li:ugcPost:7523483737280581632/) | Removal verified by 20:45:43 UTC; `linkedin-video-live.jpg`, `linkedin-video-public-audience.jpg`, `linkedin-video-deleted.jpg`. |
| Instagram image | 2026-11-03 20:39 | `cmw157xtt001j01lk4ie3kcad` / `cmw15ht5d000a01ph239308w4` | `18015743240970174`; [post](https://www.instagram.com/p/DfSwnNBGYEi/) | Removal verified by 20:45:43 UTC; `instagram-image-live.jpg`, `instagram-image-deleted.jpg`. |
| Instagram Reel | 2026-11-03 20:40 | `cmw15a3jj001w01lk4l2ybtk2` / `cmw15j3fs000d01phbxfvelp1` | `18141570223621169`; [Reel](https://www.instagram.com/get.eigenn/reel/DfSwuoyD3j9/) | Removal verified by 20:45:43 UTC; `instagram-reel-live.jpg`, `instagram-profile-cleaned.jpg`, `instagram-public-account.jpg`. |
| TikTok video (private, manually reconciled) | 2026-11-03 21:20 | `cmw16q1xr000o01qnfobr6q2a` / `cmw16yjaq000401s2ihz4hlqy` | `7704057968177761550`; [video](https://www.tiktok.com/@the_dark_lightskin/video/7704057968177761550) | Deleted and original public account restored by 21:37:56 UTC; `tiktok-private-video-live.jpg`, `tiktok-reconciled-published.jpg`, `tiktok-deleted-url.jpg`, `tiktok-public-restored.jpg`. |
| X image | 2026-11-03 21:59 | `cmw184ixm000p01mcz0d1pirl` / `cmw18cov9000101pbh2rbfd6m` | `2117738344759050285`; [post](https://x.com/yoanyombax/status/2117738344759050285) | Removal verified by 22:00:02 UTC; `x-image-live.jpg`, `x-image-deleted.jpg`, `x-public-audience.jpg`. |
| X video | 2026-11-03 22:01 | `cmw185m45001201mcujn05z7i` / `cmw18f9fp000401pbtbz3cpxk` | `2117738932251041793`; [post](https://x.com/yoanyombax/status/2117738932251041793) | Playback verified (7.999999 s, playing); removal verified by 22:02:11 UTC; `x-video-live.jpg`, `x-video-deleted.jpg`, `x-profile-cleaned.jpg`. |
| YouTube video (private; recovery retry) | 2026-11-04 00:20, retried 00:26:49 | `cmw1dmsuz000101k16e1pztw5` / `cmw1dmsvt000201nwqqsuvtbi` (first post `cmw1ci1dn000201pj8uvf8z5x` reconciled NOT_LIVE) | `lNZBbVsTZ1E`; [video](https://www.youtube.com/watch?v=lNZBbVsTZ1E) | Deleted at 00:27:38 UTC (HTTP 204); channel back to zero uploads by 00:28:07 UTC; asset deleted 00:31:06 UTC; `youtube-canary-live.json`, `youtube-canary-retry-receipt.json`, `youtube-canary-removal-verified.json`, `youtube-canary-asset-cleanup.json`. |

Each workflow ID is `post_<canonical post ID>`; run IDs and exact completion
times are in `canary-workflows.json`. Original post URLs stop resolving after
cleanup. Deletion timestamps above are observation bounds, not provider audit
timestamps. Seven completed drafts and one empty accidental draft were archived; eight associated uploaded
assets (including Instagram's JPEG derivative) were deleted using normal
reference-aware controls. Their DELETED states are recorded in
`asset-cleanup-verification.json`. All four disposable local source media files
were removed. One earlier incomplete PENDING upload is not offered by the
asset UI and remains for the existing expiration cleanup; no reference or
state checks were bypassed. The TikTok domain-ownership proof remains as
provider configuration, separate from canary media.

Checks passed: `make check`, `make -C server check` (including the reconciliation
fix), `./dev/social-gate`, touched scheduling browser flows, tenant isolation,
SDK build and API generation. The feature-flow review team found no remaining
blocking code finding after the recovery fix; full live acceptance remains incomplete. Gauntlet is
not configured. TikTok creator reads under scheduling locks remain a reported
performance follow-up.

A Go-generated signed video URL returned HTTP 200 with exact bytes through
the public media tunnel; its probe was deleted. `R2_DELIVERY_ENDPOINT` allows
that public signing origin while `R2_ENDPOINT` keeps server reads internal.
Local account 2FA is enabled with explicit user authorization; recovery
material remains in ignored owner-only files. The media bucket stays private
except for the single public TikTok ownership proof file.

Cleanup is authorized only for these disposable canaries after confirmed
publication and saved evidence. Record deletion time and verify removal;
retain the receipt, original URL and screenshot even when the URL stops
resolving. Leave uncertain deliveries for reconciliation. Delete uploaded
assets through existing reference-aware controls only after no draft or
unfinished post references them. A failed deletion remains a cleanup blocker.

Production, the 24-hour signing test, Facebook Pages, Pinterest and TikTok
photos are excluded. No SDK release, commit, push, PR or deployment is part of
this run.


### Private-video reconciliation evidence

[TikTok’s status documentation](https://developers.tiktok.com/docs/en/content-posting-api-reference-get-video-status)
limits native post IDs to public viewership. The private video was verified
in signed-in Chrome before recovery. Recovery now validates exact TikTok or
YouTube post URLs, stores native IDs and canonical URLs in the existing
publication receipt, and preserves scheduled privacy and other thread data.
TikTok handles must match the connection when present. LinkedIn Pages reuse
the member URN parser. No provider mutation or new scheduled post occurs.
The existing real-database `TestWritePublishing` covers these outcomes,
malformed/foreign URLs, permissions, and duplicate prevention.

## Historical evidence (2026-10-15)

| Provider | Local live evidence | Production evidence | Readiness |
| --- | --- | --- | --- |
| LinkedIn | A scheduled image reached the owner's account before the backend cutover; the test image was later removed. | None on the cutover architecture. | Needs new canary. |
| X | Test account and developer app exist; API credit for live publishing is unavailable. | None. | Disabled. |
| Instagram Login | A scheduled feed image and Reel reached `@get.eigenn` before the backend cutover; the test media was later removed. | None on the cutover architecture. | Needs new canaries. |
| Instagram with Facebook Login | Mock callback and Page selection tests only. | None. | Unverified. |
| Other providers | Provider-specific unit coverage varies. | None. | Unverified. |

The backend cutover is deployed to the production host (verified with
`doctl apps get` on 2026-10-16), but no live canary has run on it yet. Earlier
live posts prove the social accounts and provider integrations worked under
the previous publish path; they do not prove the new canonical worker path.
The previously queued 25-hour Instagram canary has no verified final receipt
in this cutover record and is not counted as passing.

## Automated local gate

Run `./dev/social-gate`. It creates an isolated Compose project with the real
web app, built workspace SDK, Go product API and worker, one
PostgreSQL database, Redis, Temporal, private RustFS, and a fake social API.
The Playwright flow signs up, creates an approved variant, connects a test
destination, and schedules through the web. It verifies:

1. Duplicate schedules converge on one canonical post and one remote post.
2. The worker signs private media at publish time; the fake API fetches the
   expected bytes and caption. The database retains a stable unsigned key.
3. The confirmed remote ID appears on one successful `publication_attempt`;
   the legacy social `Post` table gets no customer row.
4. A cancelled post makes no provider request.
5. HTTP 429 and 500 responses retry into one remote post each.
6. An expired provider credential fails without publishing.
7. Content drafts publish their media through the same worker. A second flow
   uploads a PNG, an MP4 and two more images through the signed-upload flow,
   then schedules three drafts to the fake destination, which takes drafts
   under X's rules only in the gate (`PLATFORM_E2E_DRAFT_PLATFORM`): a photo
   with a Unicode caption, a video, and three images in an order that is not
   their upload order. The fake receives each post once with its caption, and
   each item's content type, SHA-256 in order, and a 24-hour
   (`X-Amz-Expires=86400`) signature; each `scheduled_post` is `PUBLISHED`
   with one successful `publication_attempt`.

In-process, `TestScheduledMediaReachesTheProviderThroughTheWorker` runs the
real publish activities in the Temporal test environment against a private
signed-URL bucket and a test provider. It adds a mixed carousel with a MOV,
separate posts, an unanswered submission and a withdrawn approval; see
[media scheduling](media-scheduling.md) for the capability matrix.

`test/e2e/social-scheduling.spec.ts` checks the web callback and scheduling facade
with a mock social API, including cross-workspace isolation, X, LinkedIn, and
both Instagram login variants. Go tests cover ambiguous delivery, retry and
workflow behavior. A gate result belongs to its exact commit and SDK version;
rerun it after changing those paths.

## Remaining release gates

- Inject malformed replies and wrong-tenant access through the isolated full
  stack. Lost responses, missing media, a worker that vanished before
  sending, a lost receipt write, approval revocation, the late window and a
  cancel racing the provider call are covered against real PostgreSQL and
  Temporal with an in-process fake provider (`TestSchedulingThroughTemporal`,
  see [scheduling reliability](scheduling/reliability.md)); repeat them
  through `./dev/social-gate` with the web and the published SDK.
- Hold a post for more than 24 real hours, then verify the worker signs its
  private media only when it publishes. Moving a future timestamp forward in
  a test proves scheduling behavior, but not elapsed URL expiry.
- Run new harmless LinkedIn and Instagram feed/Reel canaries through the
  cutover customer UI. Record the canonical post and attempt IDs, remote ID
  and URL, visible caption/media, and absence of duplicates. X image and video
  canaries require API credit. Facebook Login needs a linked Page and its own
  canaries.
- Deploy the backend migration, Go services, worker, and web SDK build to the
  production host in that order. Repeat one canary per enabled provider on a
  dedicated test destination before customer traffic.

Keep the bucket private. TikTok photo publishing needs its own media design
because the provider requires a verified fetch domain or URL prefix.
