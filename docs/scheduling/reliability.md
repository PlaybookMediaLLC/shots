# Scheduling reliability

Audit and implementation: 28 October 2026. This document covers scheduling
supported content from the composer, the Plan calendar and the batch dialog
through the Go backend, PostgreSQL, the Temporal post workflow and the
provider adapters. It records what was found, what changed, the failure
model the code now implements, and how to verify it. It is not a
live-provider certification; see [what was verified](#verification).

## The path

| Step | Owner | What it guarantees |
| --- | --- | --- |
| Review | `components/write/composer/schedule.tsx` (Plan's "Review and schedule…" opens it), `components/write/bulk-schedule.tsx` | Content, destinations, the instant in its zone and offset, problems (including unsaved or conflicting edits), and which queued posts a confirmation replaces |
| Contract | `lib/api/contracts/content-drafts.ts`, `lib/tenant/content-drafts.ts`, backend SDK | Each destination's payload is built from the stored draft at the confirmed version |
| Commit | `server/internal/product/content_draft_schedule.go` | One transaction: approval, eligibility, quota, one `scheduled_post` per destination, revision, audit and event |
| Durable work | `server/internal/temporalpublishing` | `PostWorkflowV2` per post (`post_<id>`), started on commit and by the once-a-minute dispatcher |
| Provider | `server/internal/social/tenantpublishing` | Media signed at send time; one provider mutation per attempt |
| Receipt | `publishing.Repository.Complete` | `PUBLISHED` only with the provider's post ID on a succeeded `publication_attempt` |

## States

| State a person sees | Stored as | Meaning |
| --- | --- | --- |
| Draft | `content_draft` without `plannedFor` or posts | Nothing will publish |
| Planned | `content_draft.plannedFor` | A calendar position only. No `scheduled_post` exists, so nothing publishes when the time passes |
| Scheduled | `scheduled_post.status = SCHEDULED` | A durable publication job at `scheduledFor` |
| Overdue | `SCHEDULED`, more than 5 minutes past `scheduledFor` | Its worker is behind; it still publishes if it starts within the late window |
| Publishing | `PROCESSING` | A workflow claimed it; the provider call may be in flight |
| Published | `PUBLISHED` with `remotePostId` and `publishedAt` | The provider confirmed it |
| Failed | `FAILED` with `failureCode` | Definitively not published by this attempt; a person may retry |
| Needs check | `UNKNOWN_DELIVERY` | The provider may have published it. Never retried until a person reconciles it |
| Cancelled | `CANCELLED`, with `failureCode` when the worker cancelled it | Will not publish |

Each destination is its own `scheduled_post` with its own state, attempts
and receipt. A success on one destination never marks another.

## Findings

Each lead was reproduced with a failing test before it was fixed.

| Finding | Evidence before the fix | Impact | Fix |
| --- | --- | --- | --- |
| The composer showed a client-guessed queue slot but sent only `queue: true` | `schedule.tsx` computed the slot from `upcomingSlots` and never sent `expectedQueueSlot` | The committed time could differ from the reviewed one with no warning | The dialog shows the backend's next free slot and sends it. The backend reserves exactly that slot or answers 409 `queue_slot_taken` with `nextQueueSlot`; the dialog shows the new slot and asks again |
| A refused batch row moved every later queue row | The backend required the expected slot to equal the *next* free slot; with row 10 refused, row 11 conflicted, and so on | One failure blocked the rest of a 50-draft batch | The expected slot must be free and a real slot; it no longer has to be the first free one |
| A retry at the same version with a different time replayed the old schedule | `replayDraftSchedule` matched only draft, destination and version | The person was told "Already scheduled" for a time they did not choose | Each post stores `scheduleIntent`, a fingerprint of the request's timing. A changed retry is a 409; the same retry replays. Posts queued before the column replay as before |
| Concurrent identical submits failed | Two submits raced to the unique key; the loser got `publishing resource already exists` | A double click looked like a failure | Scheduling a draft takes a transaction advisory lock on it; the second submit waits, then replays |
| The stored zone was always the set's | `SetScheduleTimeZone(set.TimeZone)` | A time chosen in another zone was shown in the wrong one | The zone the time was read in is stored |
| The calendar placed a natural-time post at its slot and said nothing else | Cards and the detail used `slotAt ?? scheduledFor`; the detail called the slot the "publication instant" | The actual instant, up to four minutes off, was invisible | Cards keep their slot position and add "publishes 9:02:37"; the detail shows slot, instant and zone |
| Calendar Unschedule cancelled every destination from one card | `MutateCalendar` cancels all of the draft's queued posts; the button said "Unschedule" | Cancelling one card silently cancelled other networks | The button names the scope ("Unschedule all 3 destinations") and the sheet lists them; per-destination cancel stays in the editor. Move already changed one destination and now says so |
| Rescheduling replaced all queued destinations without saying so | `cancelLiveDraftPosts` cancels every queued post; the dialog did not list them | A destination switched off was cancelled unannounced | Schedule and Publish now list each queued post they replace and mark those that will be cancelled |
| The calendar collapsed states | `PROCESSING` and `SCHEDULED` showed "Scheduled"; `UNKNOWN_DELIVERY` showed "Failed" | A post that may be live looked retryable | Planned, Scheduled, Overdue, Publishing, Published, Failed and Needs check. The status filter keeps its four saved groups (Overdue and Publishing count as Scheduled, Needs check as Failed), so no saved filter hides a post. The Write queue labels the same states and keeps overdue and unconfirmed posts from the last two days |
| A draft sent back by a reviewer still published | The worker never re-checked draft review state; only Publish now did | Content a reviewer rejected after scheduling went out at its time | In a workspace that approves drafts, the worker cancels the queued posts of a draft whose reviewer asked for changes (`CHANGES_REQUESTED`). Editing the draft, asking for review or approving a newer version leaves the approved snapshot queued |
| Missing media cancelled a post with a generic reason | `CancelIneligible` with "workspace, connection, or approval…" | Not actionable | `FAILED` with `MEDIA_UNAVAILABLE`, nothing sent |
| No late-publication policy | A post whose worker was down for days published when it came back | Stale posts could appear far from their moment | See [late publication](#late-publication) |
| A receipt write could fail permanently | `Complete` had 3 attempts two minutes apart; then the workflow failed and the post stayed `PROCESSING` forever | A live post looked unpublished and nothing reconciled it | Outcome writes retry for 24 hours; the provider ID is logged first; a stalled post is settled (below) |
| Nothing recovered a post stuck in `PROCESSING` | Recovery listed only `SCHEDULED` posts | A lost workflow left a permanent "Publishing" | The dispatcher settles posts whose workflow run has closed |
| A failed workflow wakeup read as a failed schedule | The handler answered 503 "could not start publishing workflow" after committing | People thought the schedule was lost | It still answers 503, but says the schedule is saved and starts within a minute; the dispatcher starts the due post and a retry replays |

## Write and Plan journey (2 November 2026)

A second audit followed the journey through the browser at 1440, 1024 and
390 pixels in both themes (before and after captures in
`docs/product/qa-evidence/2026-11-02/`). Each behavior fix has a test that
failed before it.

| Finding | Evidence before the fix | Impact | Fix |
| --- | --- | --- | --- |
| A save that met a newer version dropped the writer's edit | `useDraftDocument` reloaded the server copy on 409 with a toast "your last edit was not saved" | Lost work with no way back | The edit is kept (also across navigation) beside the newer version: Use my version (without live collaboration), Copy my text, Discard. Review is blocked until the writer chooses |
| Review did not show an unsaved draft | Schedule and Publish failed only at confirm, as a toast | The person did not know why, and the toast vanished | A failed or offline save is a blocking problem with Retry save; a failed confirm stays in the dialog |
| Plan scheduled without review | The detail sheet and picker called `schedule` directly with natural time forced off and no destination review | Wrong destinations or timing could be committed unseen | Both open the composer's schedule review at the chosen time in the brand's zone ("Review and schedule…") |
| A day drop moved a post's own clock | A Month/Flex drop kept the display zone's clock time | Across a daylight-saving change the post moved by an hour in its own zone | `movedToDay` keeps the post's own clock; a Week drop keeps the hour picked |
| Times in the wrong zone | The repeated-hour choice and the draft's post list used the browser's zone | "3:00 PM" beside "10:00 AM EST" for the same post | Both use the scheduling zone and name it; the confirmation names instant, zone, offset and moved slot |
| One state, several words | The post list said "Outcome unknown"; the header said "Posted" when any destination published | A failure hid behind a success | `postState` words and `POST_STATE_TONE` colours everywhere; the header shows the state that needs attention first (`draftPostsState`) |
| Edits after scheduling were invisible | Queued posts are snapshots; nothing said so | People assumed later edits would publish | A changed queued post says so, with "Replace queued posts with this version…" (the reschedule review) |
| Ambiguous actions | The dialog was "Schedule" when rescheduling; the queue confirm read "Confirm: next free slot"; one-click per-destination Cancel | Unclear what a click commits | Schedule or Reschedule; Confirm schedule, Confirm reschedule, Add to queue, Reschedule to next free slot; a named confirmation before cancelling one destination |
| A taken slot was announced out of view | The "slot was just taken" notice sat by the chips at the top of a scrolled dialog | The new slot changed beside the button with no visible reason | The notice sits with the summary, above the confirm button |
| Phone layout | The schedule and queue dialogs were wider than a 390 px screen; Schedule was hidden while Publish stayed | Clipped controls; immediate publishing was the easy path | Dialogs fit the screen; Schedule is the primary action at every width and Publish now is outline (in ⋯ on a phone) |
| Posting-times settings | Unticking a time's last weekday removed its row; no 50-slot limit; Remove clipped in the drawer | Lost rows and saves that failed after the fact | Rows stay until removed, "N of 50" with the limit enforced, a Pro note when the plan has no queue slots, the next slots with zone and offset |



- A post's idempotency key is `content-draft:<draft>:<connection>:v<version>`;
  scheduling bumps the draft version, so a deliberate new schedule names the
  new version and replaces the queued posts. Publish now and Reschedule are
  separate, explicit actions.
- Before posting the same text and media to an account that already has it
  queued, publishing, published or unconfirmed within a day, a member is
  asked to confirm (409 `duplicate_content` with the posts; the composer, the
  schedule dialog, Publish now and the batch dialog offer "Schedule anyway",
  which sends `confirmDuplicate`). API keys, `createPost` and batch runs skip
  the question: their callers own their retries.
- `POST /api/v1/scheduled-posts` and MCP `createScheduledPost` without an
  `Idempotency-Key` name the request by its content (source, connection,
  caption, time), so an identical retry returns the first post. A caller's
  own key returns its first post to any retry, even one that recomputed the
  time. A content key whose post was cancelled or failed is a 409.
- A retry of the same version and the same timing replays the original posts
  and charges nothing. The same version with other timing is a 409. A
  request whose keys match only some existing posts is a 409.
- Queue reservations hold the set's advisory lock for the transaction. Two
  requests for one reviewed slot: one wins, the other gets 409 with the next
  free slot. Nothing is moved silently. When rescheduling, the preview still
  counts the draft's own queued slots as taken; the 409 after a conflict
  does not, since the reschedule frees them. Either way the person confirms
  the slot that is committed.
- Quota is charged inside the scheduling transaction and refunded if it does
  not commit. A replay charges nothing. Calendar moves never charge.
  Rescheduling at a new version charges for the new posts, as before.
- Calendar mutations keep their durable receipts, version checks and Undo.

## Time zones

The backend resolves a local time in its IANA zone, refuses a time the
clocks skip and asks which of a repeated hour (`earlier` or `later`). Each
post stores the UTC instant, the zone it was chosen in, its slot and its
natural offset. Changing the calendar's display zone changes presentation
only. A natural offset is derived from the draft, version and slot, so a
retry or recovery lands on the same instant.

## Failure model

| Failure | Behavior | Test |
| --- | --- | --- |
| Validation fails | 4xx before any write; nothing scheduled or charged | `TestContentDraftScheduling`, batch case in `TestContentDraftScheduleReliability` |
| Commit succeeds, workflow start fails | 503 saying the schedule is saved; the once-a-minute dispatcher starts the due post (`DispatchDue`, `ListRecoverablePosts`); a retry replays | `TestScheduleContentDraftReportsSavedScheduleWhenWorkflowWakeupFails`, `TestRecoverablePostsAreDueScheduledPostsInsideTheWindow` |
| Worker stops before the provider call | The post is `PROCESSING` without an open attempt. Once its run has closed, the sweep queues it again and it publishes once | `TestSchedulingThroughTemporal` "vanished before sending" |
| Provider refuses (4xx, 5xx without ambiguity) | `FAILED` with the provider's status; no automatic retry | `TestSchedulingThroughTemporal` "refusal" |
| Provider rate-limits (429) | A refused write returns a typed rate limit (`temporalx.RateLimited`) after the client's short retries, carrying the provider's retry-after (`Retry-After` or X's `x-rate-limit-reset`). The workflow retries durably after the longer of `PUBLISHING_RETRY_DELAY` and that guidance, capped at an hour, up to `PUBLISHING_MAX_ATTEMPTS`; a limit that does not clear ends `FAILED` with code `429`. A read that follows a committed write (a permalink, a later story) stays ambiguous | `TestSchedulingThroughTemporal` "rate limit", `TestPostWorkflowV2WaitsForTheProviderRetryGuidance`, `TestFetch*` in `social/integrations` |
| Daily posting cap (Instagram 2207042, X's spent 24-hour allowance) | `FAILED` with `PROVIDER_DAILY_LIMIT`; nothing was sent; the member reschedules | `TestFetchDoesNotRetryADailyLimit`, `TestRateLimitsAndDailyCapsAreDefiniteOutcomes` |
| Server error (500) on a write | `UNKNOWN_DELIVERY` after one request; never resent. Writes that stay invisible until a later publish call (Instagram and Threads containers, LinkedIn uploads, Mastodon media), Mastodon statuses sent with an `Idempotency-Key`, and reads sent as POST are marked `Retryable` and keep their retries | `TestFetchNeverResendsAWriteAfterAServerError`, `TestStreamedPostIsNotResentAfterAServerError` |
| Provider refuses the token, or it lapsed with nothing to renew it | `FAILED` with `ACCOUNT_RECONNECT`; the channel is flagged `refreshNeeded`, so the workspace gets `integration.reconnect_required`. After reconnecting, the member retries the post from the draft. A lapsed token with a refresh token stays the maintenance refresh's to renew | `TestRefusedOrLapsedCredentialsAskTheWorkspaceToReconnect` |
| X refuses a request because Shots' own app keys are bad (OAuth 1.0a signs with both) | Before flagging, the publisher checks the app keys with X's app-only token endpoint. Refused or uncheckable keys: `FAILED` with `PUBLISHER_UNAVAILABLE`, no channel flagged. Good keys: the account's token is at fault and is flagged as above | `TestRefusedOrLapsedCredentialsAskTheWorkspaceToReconnect`, `TestAppCredentialsAreCheckedWithAppOnlyAuth` |
| Response lost after the provider may have accepted | `UNKNOWN_DELIVERY`; retry refused until a person reconciles it as live (with its URL, clearing the code) or not live (`NOT_LIVE`, retryable) | `TestSchedulingThroughTemporal` "lost response", `TestWritePublishing` |
| Provider accepted, receipt write fails | The write retries for 24 hours; the provider ID is in the worker log. If the run still closes, the sweep marks the post `UNKNOWN_DELIVERY`. It is never sent again | `TestSchedulingThroughTemporal` "receipt" |
| Destination or approval becomes ineligible | `CANCELLED` with `ACCOUNT_UNAVAILABLE`, `CHANGES_REQUESTED` (draft), `APPROVAL_REQUIRED` (campaign variant) or `WORKSPACE_INACTIVE`, checked before media; nothing sent | `TestSchedulingThroughTemporal` "withdrawn approval" and "an account revoked after scheduling", `TestContentDraftScheduleReliability`, `TestPrepareSendsOnlyEligibleOnTimePosts` |
| Media unavailable at send time | `FAILED` with `MEDIA_UNAVAILABLE`; nothing sent. A signing failure fails with 503, also before sending | `TestSchedulingThroughTemporal` "missing media" |
| Worker down past the time | Overdue after 5 minutes; published late within the window; `MISSED_WINDOW` after it | `TestSchedulingThroughTemporal` "late window", `TestPrepareSendsOnlyEligibleOnTimePosts` |
| Cancel races the provider call | The calendar refuses: "Publication has started or needs reconciliation"; the post finishes with its real result | `TestSchedulingThroughTemporal` "cancellation racing" |
| Thread stops after its root | The root stays `PUBLISHED` with its receipt and thread progress; "Post the rest" continues from the last live reply | Existing `a stopped thread resumes` case |

`PUBLISHED` always means a provider receipt. Shots does not promise
exactly-once delivery: a provider that accepted a post and lost the response
can leave a duplicate risk, which is why such posts wait for a person.

### Late publication

A post publishes late if its workflow starts it within one hour of
`scheduledFor` (`temporalpublishing.LatePublicationWindow`). After that it
is not sent: it fails as `MISSED_WINDOW` and the person publishes it now
(Retry) or reschedules it. A 429 retry moves `scheduledFor`, so the window
counts from the retry time. The card shows Overdue from five minutes late.

### Stalled publications

The `scheduled-posts` maintenance job first settles posts that have been
`PROCESSING` for 15 minutes without progress and whose workflow run is no
longer running in Temporal (a run ID Temporal never issued counts as not
running). An open attempt means the provider may have been called, so the
post becomes `UNKNOWN_DELIVERY` and operators are notified; no open attempt
means nothing was sent, so it is queued again. The run that takes it over
numbers its attempts after the earlier ones, so their outcomes are kept and
an unknown result closes the right attempt. The sweep samples stalled posts
at random, so ones whose workflow still runs cannot starve the rest. A sweep
failure fails the job but never stops due posts from starting.

## Batch scheduling

The batch dialog takes up to 50 drafts from one profile. It
previews queue or Spread times, validates every draft without writing, shows
each row's time and destinations, and asks before skipping blocked rows.
Rows are scheduled one at a time with their previewed slot. A refused row
stays blocked with its reason and can be previewed again without touching
scheduled rows; Spread keeps each row's place in the sequence. A row without
an answer is retried with the same request, which replays, and the dialog
offers no new preview until every such row has an answer. All destinations of a draft share its time; per-destination
times are not offered.

## Data and rollout

`20261111090000_publication_attempt_receipt.sql` adds `providerMessage`
(the provider's explanation, redacted of query strings and credentials, for
support; members see the code's message) and `remoteUrl` to
`publication_attempt`. Old attempts keep `NULL`. Deploy the migration and Go
services before the web: the new web sends an empty key when the caller gave
none, which an older Go handler refuses.

`20261102130000_scheduled_post_intent.sql` adds two nullable columns to
`scheduled_post`: `scheduleIntent` and `failureCode`. Existing posts keep
`NULL`, replay by key and keep their reasons on their attempts. No backfill.

Deploy order: migration, then the API and worker together, then the web.
An old web without `expectedQueueSlot` keeps the previous queue behavior.
`PostWorkflowV2` histories recorded before this change replay on the new
code (`TestPostWorkflowV2ReplaysHistoriesFromBeforeRecordRetries`); only
activity options changed, which replay does not compare.

Rollback: redeploy the previous API, worker and web. The two columns are
ignored by older code and can stay. Posts that the new worker failed as
`MISSED_WINDOW` or cancelled as `CHANGES_REQUESTED` stay so; retry them by
hand if wanted.

Behavior changes to announce: in a workspace that approves drafts, a
reviewer asking for changes now stops that draft's queued posts; a post more
than an hour late is no longer sent automatically.

## Operations

The worker logs, without credentials, signed URLs or post text:
`publication starting` (post, platform, `lateSeconds`), `provider accepted
publication` (post, platform, `remotePostId`), `publication missed its
window`, `publication failed before sending`, `publication cancelled as
ineligible`, and `stalled publication released`. `UNKNOWN_DELIVERY` emits
the existing `post.publish_recovery_required` notification.

Suggested targets to adopt after observing production, not current
promises: 99% of due posts start within 2 minutes; zero posts `PROCESSING`
for over 30 minutes; every `UNKNOWN_DELIVERY` reconciled within a day.

## Verification

Run from `server/` with disposable services (the native stack's Temporal
dev server works):

```bash
export PUBLISHING_TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:55432/shared_cutover_test?sslmode=disable'
export PUBLISHING_TEST_TEMPORAL_ADDRESS=127.0.0.1:7233
go test -count=1 ./internal/product -run 'TestContentDraftScheduleReliability|TestContentDraftScheduling|TestContentDraftPlatform|TestWritePublishing'
go test -count=1 ./internal/temporalpublishing ./internal/httpapi ./internal/publishing
```

The interface was checked in the running app (`dev/native-stack`) with
seeded posts in every state: calendar states and the natural-time instant,
the unschedule scope, the composer's reviewed slot and replaced posts, the
per-destination reasons, and a live conflict in which a second request took
the reviewed slot and the dialog showed the next one. The native stack runs
no publishing worker, so worker outcomes there were seeded in the database;
the worker itself is covered by the Temporal test below.

On 2 November 2026 the same commands ran against the native stack's
PostgreSQL 16 (a migrated `shots_test` database) and Temporal dev server:
`TestSchedulingThroughTemporal` passed all 13 subtests, including the new
"an account revoked after scheduling stops its post before sending", and
`TestContentDraftScheduleReliability`, `TestContentDraftScheduling`,
`TestContentDraftPlatform`, `TestWritePublishing` and
`TestPlanAnalyzeDatabase` passed. The social gate's browser spec
(`social-gate.spec.ts`) also passed natively, without Docker: the web, the
Go API and worker built with the `e2e` tag, the fake provider and an
in-memory S3 store. Both of its flows passed, so due posts and draft media
went through real Temporal timers to one provider request each with a
receipt. The composer cannot select the gate's fake destination, so that
path is driven through the API; the browser states (a competing slot, a
failed save, seeded unconfirmed and reviewer-cancelled posts) were checked
against the e2e social mock, with captures in
`docs/product/qa-evidence/2026-11-02/write-scheduling/`.

`TestSchedulingThroughTemporal` drives product scheduling, real PostgreSQL,
`PostWorkflowV2` on a real Temporal server and an in-process fake provider.
It needs `PUBLISHING_TEST_TEMPORAL_ADDRESS`, which CI does not set, so CI
skips it. It proves application behavior, not provider delivery: no request
reaches a social network, and it does not hold a post for 24 real hours.
Live canaries remain as listed in
[social publishing verification](../social-publishing-verification.md).
