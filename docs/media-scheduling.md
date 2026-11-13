# Media scheduling

Status: implemented on `claude/charming-bohr-rb186p`, 2026-10-28. This note
describes how photos, videos, PDFs and their captions travel from a browser
to a provider for one post, one post with several attachments, and a bulk
batch of separate posts. It covers ownership, state, schema changes,
recovery, provider capabilities, rollout, and what is and is not verified.
Storage details are in [tenant storage](tenant-storage.md); provider evidence
in [social publishing verification](social-publishing-verification.md).

## What works

| Workflow | Where | What it does |
| --- | --- | --- |
| One photo or video with a caption | Write composer | Upload or pick an asset, write a Unicode caption, set per-platform text and options in platform versions, preview, and schedule to one or more accounts at a local time in an IANA zone or in the next queue slot. Reschedule, cancel, or add accounts to a scheduled draft. |
| One post with several attachments | Write composer, Manage media | Attach up to each destination's limit, reorder, move between thread posts. The order in the body is the order the provider receives. |
| A PDF to LinkedIn | Composer document option, bulk batch | Sent as the post's LinkedIn document; refused on every other destination. |
| Many separate posts | Publish → Bulk tools (`/publish/batches`) | A durable batch of up to 100 items, each one post with its own media, caption, accounts and time. Files, folders and a CSV are matched and previewed before anything is added; uploads run three at a time; items become drafts, can wait for review, are checked per item and account, and the person schedules the selections they choose. |
| Grid videos | Publish → Bulk tools → Grid videos | Captions and content items assemble into concepts of four labelled images, filled by upload or AI, rendered to MP4 in the browser. Each video is then an ordinary post of the batch. See [bulk tools](#bulk-tools). |

Every check that refuses media at scheduling time is shown in the composer
and the batch before the person submits: the rules live in one JSON file
that Go and the web both read (below).

## Data flow

```text
 Browser ──(tRPC / REST, zod contracts)──▶ Next.js web ──(backend SDK)──▶ Go product API ──▶ PostgreSQL
    │                                        no DB, no storage credentials        │  asset, content_draft,
    │                                                                              │  content_batch(_item),
    │   signed PUT (≤16 MiB) or signed part PUTs (larger), 2–15 min                │  scheduled_post,
    └──────────────────────────────────────────────▶ R2 (private bucket) ◀────────┤  publication_attempt
                                                       ▲                           │
                                                       │ GET, signed 24 h          ▼
 Provider ◀── provider adapter ◀── publish activity ───┘           Temporal PostWorkflowV2
 (X, LinkedIn, Instagram, Threads, Bluesky, Mastodon)    (Prepare → Begin → Submit → Complete/Fail/MarkUnknown)
```

1. The browser reserves an upload. Go checks role, plan feature and size,
   takes a per-workspace advisory lock, counts stored bytes, inserts a
   `PENDING` asset and signs a write-once PUT, or, for a file over 16 MiB,
   starts a multipart upload after the reservation commits.
2. The browser sends bytes straight to R2. Completion makes Go stream the
   object back once: length, SHA-256 (whole file, or per part), content
   signature, image decode or MP4/MOV container probe. Only then is the asset
   `UPLOADED`, with width, height, duration and codecs recorded.
3. A draft references assets by ID. Scheduling builds one target per account
   in the web (`buildPublication`), and Go re-checks every target against the
   destination rules, approval, set membership and capabilities inside one
   transaction that locks the draft row and the media rows.
4. Each target becomes a `scheduled_post` keyed
   `content-draft:<draft>:<connection>:v<version>`. Temporal starts
   `PostWorkflowV2` at the resolved instant.
5. When due, the publish activity reloads the post and its draft, refuses it
   if the workspace, destination, assets or approval changed, signs each
   private object for 24 hours, and calls the adapter. Only a confirmed
   provider receipt makes the post `PUBLISHED`; an unanswered submission is
   `UNKNOWN_DELIVERY` and is not retried.

Workflow payloads carry IDs only. Signed URLs are created inside the publish
activity and never persisted, logged, or put in workflow history.

## Ownership

| Concern | Owner |
| --- | --- |
| Destination media rules | `server/internal/medialimits/limits.json` (`destinations`), read by Go and by `clients/apps/web/lib/write/media-rules.ts` |
| Upload reservation, quota, completion checks, multipart | `server/internal/product/assets_media.go`, `asset_bytes.go`; `server/internal/media/s3.go` |
| Video facts | `server/internal/mediavideo` (`Probe`) |
| Draft media checks at scheduling | `server/internal/product/content_draft_media.go`, `content_draft_schedule.go` |
| Bulk batches | `server/internal/product/content_batch.go`, `server/internal/httpapi/content_batches.go`; web `lib/tenant/content-batches.ts`, `lib/api/contracts/content-batches.ts`, `components/write/batch/` |
| Background batch schedule | `server/internal/product/content_batch_run.go`, `server/internal/temporalbatches` |
| Bulk tools logic | `lib/write/bulk-intake.ts`, `lib/write/bulk-import.ts`, `lib/write/spintax.ts`, `lib/write/batch.ts`, `lib/write/grid-concepts.ts`, `lib/write/grid-layout.ts`, `lib/write/grid-render.ts` |
| Browser uploads | `clients/apps/web/lib/workspace/save-export.ts` |
| Publish-time checks | `server/internal/publishing/repository.go` (`LoadPublishJob`) |
| Provider requests | `server/internal/social/integrations/social/<provider>` |
| Cleanup and retention | `server/internal/maintenance/assets.go`, SQL `platform_asset_in_use_v1` |

## State

```text
asset:           PENDING ──complete──▶ UPLOADED ──delete (not in use)──▶ DELETED ──outbox──▶ object deleted
                    │  └─bytes refused──▶ FAILED ──1 h──▶ DELETED            (parts of an unfinished
                    └──────────── 24 h, never completed ────▶ DELETED         multipart upload aborted)

batch item:      staged (media: file name + size, then uploadAssetId, then assetId) ──save──▶ drafted (draftId)
                 A drafted item's content lives in its draft; the item keeps its timing and order.

scheduled_post:  SCHEDULED ──due──▶ PROCESSING ──receipt──▶ PUBLISHED
                     │                   ├──provider refused──▶ FAILED
                     │                   └──no answer──▶ UNKNOWN_DELIVERY (check the account; never retried)
                     └──cancel, approval withdrawn, changes requested──▶ CANCELLED
```

Batch item media status is the referenced asset's status, so a reload shows
whether an upload finished, is still pending, or was refused.

## Schema changes

All additive; each has its Ent schema and a reviewed SQL migration in
`server/platformmigrations/sql`. No media bytes are stored in PostgreSQL and
no queue table is added: Temporal stays the only scheduler.

| Migration | Change |
| --- | --- |
| `20261103090000_asset_video_facts.sql` | `asset."durationMs"` (≥ 0) and `asset.codecs`, read from the container at completion. Existing videos stay NULL and are probed on demand before scheduling. |
| `20261103091000_content_batch.sql` | `content_batch` and `content_batch_item`: per item an import key (unique per batch), a fingerprint of its input, position, caption, media list, accounts, timing (`mode`, `localTime`, `timeZone`, `disambiguation`, `expectedQueueSlot`) and the draft it became (unique, `ON DELETE SET NULL`). |
| `20261103092000_asset_retention.sql` | `platform_asset_in_use_v1(org, asset, history)`: whether an unarchived draft, an unfinished post (or, with history, a published one) or an open batch item references the asset. Deletion and cleanup both use it. |
| `20261103093000_asset_multipart_upload.sql` | `asset."uploadId"`: the multipart upload a `PENDING` asset waits on, cleared at completion. |
| `20261104100000_content_batch_source_key.sql` | `content_batch_item."sourceKey"`: the file or folder name an item came from, as the person knows it. |
| `20261104101000_content_batch_grid.sql` | `content_batch_item.grid` for grid video concepts, and `platform_asset_in_use_v1` also counts a concept's images and music. |
| `20261104102000_content_batch_run.sql` | `content_batch_run`: one schedule or render of a batch, what it froze and each item's outcome. |

Why tables for batches: a batch must survive a reload, another device and a
second editor, and an item must exist before its files finish uploading and
before it has a draft. Drafts alone could not hold staged items, and browser
storage is per device and can be lost. Items still become ordinary drafts, so
review, approval, history and scheduling work as they do for one draft.

## Uploads

| File | Path | Integrity |
| --- | --- | --- |
| Up to 16 MiB | One PUT signed for 2 minutes with `If-None-Match: *` | Browser SHA-256 of the whole file, checked by Go |
| Over 16 MiB (up to the 512 MiB video ceiling) | 16 MiB parts, each PUT signed for 15 minutes with its exact length | Browser SHA-256 of each part (one part in memory at a time), checked by Go against the joined object; Go records the whole-file digest it read |

R2's S3 API (compatibility page updated 2026-10-14) supports `Content-MD5`
on `UploadPart` but no SHA-256 checksum headers, and no conditional headers on
`CompleteMultipartUpload`. So Go lists the stored parts itself (the browser
never reads an `ETag`, and CORS needs no exposed headers), completes the
upload only when every part has its exact size, and verifies content after
joining. Write-once intent rests on a unique key per asset and on
completion being server-only and running once, under the `PENDING` →
`UPLOADED` transition. Re-sending a part before completion replaces it, which
is how a failed part is retried (twice, with a fresh URL). A part that
differs from what the browser read fails the asset; the person uploads again.

The browser uploads three batch files at a time. The public API keeps its
single write-once PUT.

## Recovery

| Failure | What happens |
| --- | --- |
| Page closed during a single PUT | The batch item keeps `uploadAssetId`. After reload the page tries completion; with no bytes it is refused, the item says its file must be selected again, and a new upload starts. The abandoned reservation is deleted after 24 hours. |
| Page closed during a multipart upload | Selecting the same file again (same name and size) resumes: the server lists the parts storage holds and the browser sends only the rest. |
| Upload finished but the save after it was lost | Completion is idempotent: reload recovery or Try again completes the reserved asset and records it, without uploading again. |
| R2 object without a row | Cannot happen: the browser receives an upload URL only after the reservation row commits, and a multipart upload starts only after it. |
| Row without an object | Completion fails (`ErrObjectMissing`); cleanup retires the `PENDING` row after 24 hours. |
| Bytes that are not what they claim | The asset becomes `FAILED` with the reason; cleanup retires it after an hour. |
| Concurrent uploads near the quota | Reservations serialize on a per-workspace advisory lock; exactly one of several that fit only one is admitted. |
| Abandoned multipart upload | Cleanup deletes the reservation and aborts its parts; R2 also aborts unfinished uploads after 7 days by default. |
| Deleting media something still needs | Refused (`AssetInUse`) while a draft, an unfinished post, or an open batch references it. Cleanup never retires such media. |
| A draft request whose response was lost | The batch item's import key makes the retry return the same draft. |
| One item of a batch fails to schedule | The others stay scheduled; the failed one shows its reason and can be corrected and sent again with `add`, which schedules only the accounts without a live post. |
| Provider gives no answer | `UNKNOWN_DELIVERY`; never retried automatically. |

## Bulk tools

Built from the [Bulk Tools analysis](scheduling/post-bridge/bulk-tools/post-bridge-bulk-tools-technical-analysis.md)
on top of batches, so review, validation, idempotency, retention and tenancy
are the batch's. These are the rules that analysis left open.

**Folders.** A folder that directly holds images is one post, so a parent folder
makes one post per folder at any depth. Images sort by name with numbers in
order. Hidden files, other types and empty files are listed in the preview and
left out. A file is stored under its path (`Trip-Beach-1.png`), which keeps two
folders' `1.png` apart and lets selecting the folder again resume an upload.
"One post per image" ignores folders. A post takes 20 attachments, the most any
destination takes.

**Caption variations.** `{a|b}` is a group; each post gets one alternative of each
group at random, so captions may repeat. Braces without a `|` are literal, a
backslash escapes `{`, `}`, `|` or `\`, and nested groups are refused. The expansion
is stored when applied and never re-rolled.

**Caption CSV.** Two columns are `filename, caption`; one column assigns captions to
posts in order; a header is optional and recognized by name. Names match without
case, with the extension optional, against the original file or folder name
(`sourceKey`) and the stored file name. A name matching two posts, or two rows
naming one post, is a problem shown in the preview: nothing is guessed. Only posts
not yet saved as drafts change.

**Caption limits.** Variations and CSV rows go through one check: the longest
expansion must fit every account the post goes to, counted the way each channel
counts. A refused bulk change leaves every caption as it was
(`PATCH /v1/content-batches/{id}/items` is one transaction).

**Spread.** A day's posts may run past midnight, up to `postsPerDay × spacing ≤ 24h`,
which is what keeps one day's last post before the next day's first. The random
shift moves a post later by 0 to 55 minutes in 5-minute steps and is seeded, so a
retry lands on the same time. A clock change on any post still refuses the plan and
names it.

**Quota.** Checking a batch reads the posts left this month and warns before
scheduling past them. Go's charge decides: posts past the limit are refused with a
reason, and the rest stay scheduled.

**YouTube and TikTok.** Options chosen for the batch go into each draft's platform
version when it is saved; one post's options are then edited in Write. An empty
YouTube title uses the post's first caption line, then its file name.

**Grid videos.** A concept is a batch item with a `grid` column: a headline of up
to 60 characters, four labelled slots and optional music. It survives a reload or
another device. Images and music are workspace assets, checked for tenancy, and
kept from cleanup while the batch is open (`platform_asset_in_use_v1`).

| Step | Behavior |
| --- | --- |
| Images | Upload per slot, upload many (fills empty slots in order, naming leftovers), or AI (`editorAi.generateGridSlotImage`, two at a time). The page estimates credits before generating; a failed slot keeps its error and can be tried again |
| Last grid cell | Sets the label or image of slot 4 on every video. It is a cell of the grid, not an extra slide |
| Music | The person's own file, played from its start, or none. There is no built-in catalog: add one only with licensed tracks |
| Render | In the browser, one at a time: the frame is composed once and encoded as 1080×1920, 30 fps, 6 s, H.264 with AAC when there is music. `WebCodecsVideoEncoder` where the browser can encode both, otherwise `FFmpegVideoEncoder`, which holds one still with no fade |
| Recovery | Each video uploads and is recorded on its item when done. Closing the tab loses only the one in progress; reopening renders what is left |
| Changes | Changing a concept drops its video, in Go, so a stale video cannot be scheduled. A concept with no video cannot become a draft |
| Handoff | A finished video is the item's media, so captions, times, drafts, review and scheduling apply. Download one, or several as a ZIP |

The analysis's remaining checks ([verification matrix](scheduling/post-bridge/bulk-tools/bulk-tools-verification-matrix.csv)) are covered here:

| Matrix | Where Shots proves it |
| --- | --- |
| BULK-009, 010, 054: folders and file limits | `test/write-bulk-intake.test.ts` |
| BULK-018 to 022: variations and overflow | `test/write-spintax.test.ts`, `test/write-batch.test.ts` |
| BULK-023, 055: CSV matching | `test/write-bulk-import.test.ts` |
| BULK-025 to 030: schedule | `TestSpreadTimes`, `test/write-batch.test.ts` |
| BULK-035 to 041: concepts | `test/write-grid-concepts.test.ts`, `TestContentBatches` |
| BULK-046 to 052: recovery, render, handoff | `test/e2e/bulk-tools.spec.ts`, `test/write-grid-layout.test.ts` |
| BULK-056, 057: submission, retry, partial success | `TestContentBatches`, `TestContentDraftScheduleReliability` |

The analysis's suggested endpoints map onto the batch's own routes, under
`/api/v1/content-batches`, so there is one batch model:

| Suggested | Route | What it does |
| --- | --- | --- |
| `POST /batches`, `GET /batches/{id}` | `POST /`, `GET /{id}` | The durable batch, with its latest `submission` and `render` |
| `POST /batches/validate` | `POST /{id}/validate` | Each item and account, without charging or reserving |
| `POST /batches/{id}/submit` | `POST /{id}/submit` | Freezes each item's schedule and starts a workflow; the same `requestKey` replays |
| `POST /render-batches` | `POST /{id}/renders` | Freezes concepts for this browser to render, and retires any earlier render |
| `GET /render-batches/{id}` | `GET /{id}/runs/{runId}` | Per-item outcomes of a schedule or a render |
| (recording a video) | `POST /{id}/renders/{runId}/items/{itemId}` | Attaches a video to its item, or records why it failed |

**Background submit.** The web builds each post once with the composer's builder,
and `content_batch_run` holds the frozen requests; workflow history carries only
IDs. `temporalbatches.Workflow` applies them one at a time through
`ScheduleContentDraft`, so approval, quota and idempotency are not repeated. A
definite refusal is that item's outcome and the rest carry on. A failure to get an
answer is retried, which replays rather than duplicates, and after its retries the
item is `UNCONFIRMED` and the run moves on. The page can close at any point, and
reopening it shows the progress. Only a person with a real session can start a run.
It then acts as that person: each item reads their account, membership and role again,
so a banned account, a lost role or a lost membership refuses the rest with a reason,
and what was already scheduled stays. It does not read their session or active
workspace, so signing out, an expired session or switching workspace does not stop
it, as none of those stops a post already queued. The cost is that revoking a stolen
session does not stop a run it started; removing the person from the workspace does.
Only the worker's step has this exemption (`publishing.ForStartedRun`): ordinary
requests still need the session and the active workspace. Scheduling here
must judge an account as the API does, so the worker's store has the API's media,
account standing and quota meter.

**Render runs.** Rendering stays in the browser. The server's part is the record: a
run freezes each concept, and a video attaches only if the concept is still what was
frozen and the run has not been replaced by a newer one. A failure stays visible
after a reload. A browser closed mid-render leaves its items `PENDING`; rendering
again starts a new run.

**Regenerating.** On a concept, "New caption" asks AI for a headline in the spirit of
the batch's others. "Regenerate video" also redraws its four items from the batch's
content items, in a new order, and clears its images, keeping its music; it asks
first, and keeps the headline if AI gives nothing back. Either drops a rendered video.

Deliberately not built from the analysis: global format and length caps and a
120-day horizon (destination rules decide), and an hourly AI image cap (AI credits
decide).

## Scheduling semantics

- **Idempotency.** A retry of the same draft version, accounts and time
  returns the existing posts. The same version at a different time is a
  conflict ("already scheduled for another time"). Adding accounts uses
  `add: true` and charges only the new posts. Concurrent submits of one draft
  serialize on the draft row: exactly one creates posts. A new post for an
  account that already has one is refused; reschedule it instead.
- **Time.** A local time is resolved in its IANA zone and stored with it. A
  time the clocks skip is refused; a time that happens twice needs an
  explicit earlier or later choice. Queue slots are previews: the client
  sends the slot it showed, and a slot taken meanwhile is refused, not moved.
- **Edits.** Editing a scheduled draft never changes the queued posts' time or
  publishes them early. Approval given for the scheduled version carries to
  the version scheduling writes.
- **Publish-time rechecks.** The worker refuses a post whose workspace,
  destination, assets or approval changed, including changes requested after
  it was scheduled.

## Capabilities

Evidence levels: **Uploadable** (accepted and verified at upload),
**Convertible** (Shots converts it and says so before scheduling),
**Implemented** (the adapter sends it), **Test-verified** (automated test
against the adapter's request shape or the worker), **Live-verified** (a real
provider post on the current architecture), **Blocked**. Provider documents
were read on 2026-10-28 (X on 2026-11-13); links are in `limits.json` (`docs`,
`verifiedOn`). X's per-tier video limits are in `x.video.accounts`; stored X
account snapshots must match them, so changing them sends every connected X
account back through reconnect.

| Destination | Content | Uploadable | Convertible | Implemented | Test-verified | Live-verified |
| --- | --- | --- | --- | --- | --- | --- |
| X | 1–4 images (JPEG, PNG, WebP) | Yes | Larger than 5 MB → resized derivative | Yes | Adapter (`TestMediaUploadsOriginalBytesAndCategory`), worker | Yes: scheduled image on `@yoanyombax`, 2026-11-03; receipt and public native post verified, then deleted. |
| X | GIF, alone, ≤ 15 MB | Yes | — | Yes | Adapter (`TestGIFFullAnimationLimits`) | No |
| X | Photos and a video in one post | — | — | No | Refused before scheduling, with the reason (`write-media-rules.test.ts`, `TestDraftMediaFollowsEachDestination`) | Blocked: the X API takes 4 photos, 1 GIF or 1 video (read 2026-11-13) |
| X | MP4 video, alone, ≥ 0.5 s, within the account's verified length (20 min standard, 125 min Premium; 1080p sent unchanged) | Yes | — | Yes | Adapter (`TestPendingMediaNeedsFactsAndCurrentVideoAllowance`, `TestTenMinute1080pSourcePreservedWithoutPremium`), worker | Yes: scheduled 8-second video on `@yoanyombax`, 2026-11-03; native receipt and playback verified, then deleted. |
| LinkedIn | 1–20 images (JPEG, PNG; WebP) | Yes | WebP → PNG | Yes | Adapter (`TestPostImage`, `TestPostPendingCarousel`) | Yes: image on `yoanyomba`, 2026-11-03; receipt and deletion recorded |
| LinkedIn | MP4 video, alone, 3 s–30 min, ≤ 500 MB | Yes | — | Yes | Adapter (`TestVideoUpload`), worker | Yes: 8-second video on `yoanyomba`, 2026-11-03; playback and deletion verified |
| LinkedIn | PDF document, alone, ≤ 100 MB, ≤ 300 pages | Yes | — | Yes | Upload checks; publish via the document option | No |
| LinkedIn | GIF ≤ 20 MB | Yes | — | Yes | Adapter (`TestLinkedInRejectsIncompatibleGIFBeforeProviderMutation`) | No |
| Instagram (Instagram Login) | Image, aspect 4:5–1.91:1, width ≥ 320 | Yes | PNG/WebP → JPEG, transparency to white | Yes | Adapter (`TestCarouselPendingFlow`), `TestJPEGOnlyProfileFlattensTransparency` | Yes: feed image on `@get.eigenn`, 2026-11-03; receipt and deletion recorded |
| Instagram | Reel: MP4 or MOV, 3 s–15 min, ≤ 300 MB | Yes | — | Yes | Adapter (`TestSingleReelQuery`, QuickTime case), worker | Yes: 8-second Reel on `@get.eigenn`, 2026-11-03; playback and deletion verified |
| Instagram | Carousel of up to 20, images and videos mixed | Yes | As above | Yes | Adapter, worker (order and mixed MOV) | No |
| Instagram | GIF | Yes | — | No | — | Blocked: no animated GIF in the API |
| Instagram (Facebook Login) | Any | Yes | — | Adapter exists | — | Blocked: refused at scheduling until the account reconnects with Instagram Login |
| Threads | Up to 20, images and videos mixed; video MP4/MOV ≤ 5 min, ≤ 1 GB | Yes (uploads stop at 512 MiB) | WebP → PNG | Yes | Adapter (`TestCarouselFlow`, `TestMixedCarouselSendsVideoByType`) | No |
| Bluesky | 1–4 images | Yes | Larger than 2 MB → resized derivative | Yes | Adapter (`TestImagesPreserveOriginalAndResizeToVerifiedLimit`) | No |
| Bluesky | MP4 video, alone, ≤ 300 MB, account allowance | Yes | — | Yes | Adapter (`TestVideoPendingFlow`, `TestVideoAllowanceAndContentCheckedBeforeUpload`) | No. Length limit not taken from official docs (unreachable); the live upload-limits call decides. |
| Mastodon | 1–4 images ≤ 16 MiB | Yes | — | Yes | Adapter (`TestDynamicPostWaitsForMediaThenPublishes`) | No |
| Mastodon | Video (MP4, MOV, WebM) or GIF, alone, ≤ 99 MiB | Yes | — | Yes (generic media upload) | Rules only; no adapter video test | No. Server-specific limits beyond mastodon.social defaults are not read per instance. |
| Any | Audio, or a file other than a PDF, as an attachment | Uploadable for design timelines | — | No | Refused before scheduling, with the reason | Blocked |
| TikTok | One MP4, ≤ 512 MiB; current creator duration and interaction limits | Yes | — | Direct publishing, explicit privacy, consent and disclosures | Adapter, options, worker and social gate | Yes: private scheduled video on `@the_dark_lightskin`, 2026-11-03; native URL/playback verified and manually reconciled because private API IDs are withheld. Deleted and original public account restored. Public automatic receipts still require an audited app. |
| YouTube | One MP4, ≤ 512 MiB; explicit title, privacy and audience | Yes | — | Resumable upload with processing confirmation | Adapter, options, worker and social gate | No: @getconduitt private video scheduled for 2026-11-04 00:20 UTC; receipt and playback pending |
| Pinterest, Facebook Pages | — | — | — | Not in the direct publishing path | — | Blocked for drafts |

Nothing is silently dropped. Content a destination cannot take is refused
before scheduling with the reason and the fix; conversions are listed per
account before the person submits ("Instagram takes JPEG only: Shots sends
PNG images as JPEG, and transparent areas become white").

## Rollout and rollback

1. Apply the four migrations (additive; old code ignores the new columns and
   tables).
2. Deploy the Go API and worker together. The worker needs the retention
   function for the `asset-cleanup` schedule, which runs hourly.
3. Publish `screenshot-studio-backend-sdk` 0.1.43, then deploy the web.
4. Confirm the R2 bucket keeps its default rule that aborts unfinished
   multipart uploads after 7 days (`wrangler r2 bucket lifecycle list`). CORS
   needs no change: part PUTs carry only `Content-Type`.
5. Run one harmless canary per enabled provider for a photo, a video and a
   multi-image post on a dedicated test account, as listed in
   [social publishing verification](social-publishing-verification.md).

Rollback: deploy the previous web and Go builds; leave the schema. Posts
already scheduled keep publishing (their workflows are unchanged). Batches
stay in their tables, unreachable until the feature returns; their drafts
remain ordinary drafts. A multipart upload in flight during a rollback cannot
complete on old code; cleanup retires its reservation and R2 aborts its parts.
To remove the feature entirely, drop the two batch tables, the function and
the two asset columns in a new reviewed migration.

## Tradeoffs

- **One draft per batch item** keeps review, approval and history identical to
  single drafts, at the cost of one draft row per post.
- **Rules in a shared JSON file** keep Go and the browser in agreement and are
  conservative where providers are vague: Instagram receives JPEG only, and
  transparency becomes white rather than risking a rejected post.
- **Per-part digests checked after joining** work on R2 without checksum
  headers but cannot repair a bad part; the file is uploaded again. This trades
  one rare re-upload for no new client dependency (MD5) and no extra storage.
- **16 MiB parts** keep browser memory bounded and need 32 parts for the
  largest video; larger parts would mean fewer requests but more to resend.
- **Validation is provisional**: checks before scheduling are repeated inside
  the scheduling transaction and again at publish time.

## Evidence

Bulk tools, 4 November 2026. `make -C server check` passed with the four CI
databases, and `npm run format:check`, lint, typecheck and the web unit suite passed.
Docker's storage failed when the development machine's disk filled, so the browser
checks ran in CI. `test/e2e/bulk-tools.spec.ts` passed there, covering a folder upload
to drafts, caption CSVs and variations, reload, and a grid video with music, read back
as H.264 and AAC. `social-gate.spec.ts` passed with its grid case: a video rendered in
the browser and scheduled by the worker with no page open, then delivered once with
matching bytes. Pull requests into `develop` run only `@smoke` browser tests, so these
journeys were tagged for one pull request and otherwise run in the full suite.
Screens at 1440, 1024 and 390 pixels in both themes are in
`docs/product/qa-evidence/2026-11-04/bulk-tools/`; they come from `next dev`, so its
badge shows. `make tenant-isolation` was not run, and neither was a real provider or
R2. Tenancy of runs and grid assets is covered in `TestContentBatches`. A full batch of
100 was not timed in a browser. At 390 pixels a post's account table clips its Result
column.

Run on this branch, against local PostgreSQL (Docker was unavailable). The
full Go suite and its race set pass except
`TestFetcherRefusesWhatOnboardingNeverReads`, which fails the same way on
`develop` in this sandbox; the platform migrations apply to a fresh database,
re-apply idempotently and pass their upgrade tests.

- Go: `TestMediaScheduling`, `TestContentBatches` (50 photos, 50 videos and a
  mixed batch into 100 posts each; reload and retry; partial scheduling and
  correction; tenant and private-set isolation), `TestLargeUploadsGoInParts`
  (real S3 client against gofakes3), `TestMultipartUploadThroughSignedParts`,
  `TestConcurrentUploadsCannotExceedStorage`,
  `TestDeletingAnAssetKeepsMediaThatIsStillNeeded`,
  `TestAssetCleanupRetiresOnlyUnneededMedia`, `TestDraftMediaFollowsEachDestination`,
  `TestProbeReadsDurationDisplaySizeAndCodecs`, and
  `TestScheduledMediaReachesTheProviderThroughTheWorker`, which runs the real
  publish activities in the Temporal test environment against a private
  signed-URL bucket and a test provider: photo, video, ordered carousel with
  MOV, separate posts, `UNKNOWN_DELIVERY` without retry, and a withdrawn
  approval that never reaches the provider. Its due times are moved in the
  database: that proves scheduling behavior, not a real elapsed delay.
- Web unit tests: media rules mirroring the Go cases, CSV parsing and
  matching, batch timing and status, the uploader's parts, retry and resume.
- A smoke run of `/write/batches` on a local stack without Docker (Go API and
  worker, Temporal dev server, in-memory S3, Next.js dev): import with a
  mapping preview, MP4/MOV/PNG uploads with probed facts, reload persistence,
  drafts and review requests. It found the lost-save bug fixed above. It could
  not schedule: no social account can be connected locally.
- A Chromium run on the same stack uploaded a 40 MiB MP4 from the batch page
  in three parts with part 3 failing: the browser sent parts 1 and 2, tried
  part 3 three times, and reported the failure. After a reload and selecting
  the file again it sent only part 3, and the server joined, checked and
  probed the video (3 s, 320×180). The in-memory S3 does not verify
  signatures, so R2's handling of the signed part URLs is not proven.

In CI, `./dev/social-gate` also schedules content drafts through the full
stack to its fake destination: a photo with a Unicode caption, an MP4 and an
ordered set of three images, each received once with its caption, content
types and digests in order ([social publishing verification](social-publishing-verification.md)).

Not run locally (no Docker): the Playwright suite (four specs were rewritten
for the batch page), `make tenant-isolation` and `./dev/social-gate`; CI runs
them. Not verified anywhere: real R2 multipart uploads, a 24-hour real delay,
and any live provider post. No post was published to a real account.
