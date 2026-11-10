# Shots: audited plan for voice capture and evidence capture

**Status:** Proposed. Voice capture is not authorized in the [RFC index](../rfcs/README.md); owner decision 1 in section 8 comes first.
**Version:** 0.3 · 2026-11-10
**Replaces:** an external v0.1 architecture proposal (a 23-section design with schema appendices), which is not in this repository. Section references such as "v0.1 §7" point to it.
**Checked against:** the repository `PlaybookMediaLLC/shots` at `329d1630`, with the approval and scheduling findings re-checked against `develop` at `5285a789` (#497).

Section 9 lists what was verified and how. Nothing here has been built or run.

---

## 1. Audit verdict

v0.1 is careful about distributed-systems detail, but it was written from a chat transcript and without the repository. It designs a new product. Shots is already in production, and most of v0.1 duplicates it. Six findings change the plan:

1. **It rebuilds what exists.** v0.1 proposes a new `shots` schema with 28 tables, new roles, a new REST API, a new editor, a new approval model and a new publishing state machine. The repository already has all of these on Go, Ent, PostgreSQL, Temporal Cloud and private R2 (section 2). The RFC index forbids "another editor, renderer, job system, scheduler or generic autonomous agent framework".
2. **Its largest stated risk is already resolved, a different way.** v0.1 makes "does Stagehand run on Cloudflare's browser transport" the first gate. The repository already runs authenticated capture on Cloudflare Browser Run using `go-rod` in Go, proven on the real provider on 2026-11-04. A TypeScript Stagehand worker would be a second capture system and a second runtime.
3. **Its runtime AI navigation loop contradicts a standing decision.** RFC 007 says "Do not accept arbitrary agent-authored browser scripts" and restricts workers to reviewed recipes.
4. **It ignores the execution order.** The RFC index is authoritative: RFCs 001–006 are the active queue, and authenticated capture (007) is conditional on pilot evidence. Voice capture and a mobile app appear in no RFC. They need an owner authorization of the kind Code Studio received on 2026-11-04.
5. **The parts that are new have real defects.** The mobile audio and sync design would fail in specific, checkable ways (section 5 and Appendix A): segment-per-part multipart uploads below R2's minimum part size, `.m4a` files that are unplayable after a crash, file protection that blocks recording on a locked phone, and a deletion ledger stored inside the database it is supposed to survive.
6. **Its targets contradict each other.** 99.9% monthly availability allows 43 minutes of downtime; the same document sets a 4-hour recovery time. A 10-minute p95 for a release cannot hold with three 4-minute attempts inside a 15-minute task budget.

The audience for v0.1 was a reviewer of a new system. The useful plan is narrower: add voice capture to the existing product, harden capture only when its trigger is met, and check the existing systems against the edge cases v0.1 raised.

---

## 2. What v0.1 proposes against what exists

| v0.1 proposal | Already in the repository | Disposition |
|---|---|---|
| New `shots` schema, UUID keys, `workspace_id` | Ent models in the `public` schema, string IDs, `organizationId`; reviewed SQL in `server/platformmigrations/sql` | **Cut.** New tables follow the existing conventions. |
| `capture_plans`, `capture_tasks`, `capture_attempts`, leases, fencing | `CaptureRecipe` (immutable versions), `CaptureJob` (with `fencing_token`, idempotency key, `NEEDS_AUTH` phase), `CaptureAttempt`, `PlatformAppConnection` | **Reuse.** |
| TypeScript Stagehand browser worker | `server/internal/capture/browser` on `go-rod` over Cloudflare Browser Run; limits: one active capture per workspace, 90-second run, 10 steps, 24-hour session state | **Cut.** |
| Egress policy, SSRF controls | `server/internal/publicnet` transport, checked on the dialed address and every redirect hop | **Reuse.** |
| Deployment ingestion, outbox, release runs | Signed GitHub intake, `releaseautomation` interpreter on Temporal, outbox with `attempts`, `last_error`, `dead_lettered_at` | **Reuse.** |
| Content items and revisions | `content_draft`, `content_draft_revision`, campaigns | **Reuse.** |
| Approvals with subject hash | `approval` model, version-based draft approval, a per-workspace "Require approval" setting, `campaignPostTransitions` as the single owner of campaign approval state. Approval policies (RFC 043) are not started | **Reuse; fix the gaps in 6.5.** |
| Publications, reconciliation, "first provider to be chosen" | `ScheduledPost`, `PublicationAttempt`, `PostWorkflowV2`, about 35 provider adapters, `UNKNOWN_DELIVERY`, `MISSED_WINDOW`, stalled-post recovery, single-attempt submit | **Reuse; fix the gaps in 6.5.** |
| Four roles plus `can_publish` | Roles including creator, publisher, approver, admin, owner and `writer_publisher`; one authorization path in `web/lib/auth/access.ts` | **Reuse.** |
| "Identity provider to be chosen" | Better Auth 1.6.33 with organization, two-factor, SSO and API-key plugins | **Reuse; extend for mobile.** |
| REST `/v1` with hand-written OpenAPI | Zod contracts → generated OpenAPI → `shots-api-client`; Go product API; MCP server | **Reuse.** |
| Image editor and recipe renderer | Upstream editor, creative engine, per-platform sizing, Code Studio | **Cut.** |
| Cost ledger, budget reservations | `workspaceplan`, `quota`, credits, Stripe | **Reuse.** |
| Five separately deployed components, "Temporal Cloud if procurement permits" | One combined backend container on DigitalOcean App Platform; Temporal Cloud namespace already in use | **Keep as is.** |
| PostgreSQL row-level security on every table | Application-level tenancy through Ent, with `make tenant-isolation` | **Out of scope** (decision 9). |
| Mobile app, voice notes, transcripts, sync | Nothing | **New.** This is the plan. |

---

## 3. Decisions

Each decision replaces the v0.1 position named in brackets.

1. **Extend the existing codebase.** No new schema, service, queue, editor or API style. [v0.1 §4, §11, §14, §20]
2. **No Stagehand and no TypeScript worker.** Capture stays on the existing Go path. [§7, §21]
3. **No AI navigation at capture time.** If recipe authoring proves slow, a model may draft a recipe in test mode against the connected demo account; a person reviews and activates it like any other recipe version. That is a later, separate proposal. [§7]
4. **Capture work stays conditional under RFC 007.** It starts when pilots show uploads are the bottleneck. [§22 gate 1]
5. **Voice capture is the new work, and it needs owner authorization first.** Recorded in `docs/rfcs/README.md` as a scoped authorization with an outcome metric. [§22]
6. **Voice notes are private to their owner.** A note becomes visible to the workspace only when its owner attaches a transcript revision to a draft. v0.1 never said who can see a note, while syncing them through a workspace-wide feed. [§10]
7. **Audio is one append-only file per uninterrupted run, uploaded with a single request.** No 10–30-second segments, no multipart upload, no server-side reassembly of segments into parts. [§9, §10]
8. **Sync is a list comparison, not a change feed.** The phone fetches each note's ID, revision and deleted flag, compares locally, and fetches what differs. This removes cursors, cursor expiry, the workspace row lock and the skipped-commit problem. Ceiling: a few thousand notes per person; a change feed can replace it then. [§10, Appendix A]
9. **Row-level security is not adopted here.** v0.1's version would break the outbox relay, the publication scheduler, the retention sweeper and webhook installation lookup, all of which read across workspaces before a workspace is known (Appendix A, item 1). It is a separate decision with its own migration plan.
10. **On-device transcription is the default; anything that leaves the phone is opt-in and named.** Creating a draft from a transcript sends text to a model provider, so it is disclosed as remote processing even when audio never left the device. v0.1 covered audio upload and remote transcription but not this. [§9, §10]
11. **Targets are corrected** (section 7).
12. **Nothing in this plan changes sign-in or publishing flows while Meta App Review is open** (submitted 2026-11-06).

---

## 4. Scope

**In scope**

- An iOS app that records a voice note, survives interruption, transcribes on device, and syncs.
- A server voice domain: notes, transcript revisions, audio assets, deletion.
- A voice inbox on the web: read, play, edit the transcript, delete, turn into a draft.
- Voice to draft, using the existing draft, review and approval flow.

**Conditional (RFC 007 trigger)**

- Capture hardening (5.5), staying signed in (5.6) and capture at scale (5.7).

**Fixes to existing code**

- The gaps found in the existing release, capture, approval and publishing code (section 7a).

**Out of scope**

- Android, until iOS passes its device matrix. The server contract and the React Native layer stay portable.
- WhisperKit or any downloaded model, speaker labels, live collaborative transcript editing, native-app screenshots, autonomous browsing, a second editor.
- The animated Skia orb as a launch requirement. A plain level meter ships first; the orb is polish on top of the same meter events.

---

## 5. The plan

### 5.1 Mobile recording (new)

**Stack.** React Native with an Expo development build; one Swift module owns the microphone for the whole recording and feeds both the file writer and the speech engine. JavaScript sends intent and receives batched state events carrying the note ID and a sequence number.

**File format.** A container that is playable up to the last second after a crash. Plain `.m4a` is not: its index is written when the file closes, so a kill mid-recording leaves an unplayable file. Use CAF or ADTS AAC; the choice is made by the Gate 0 device test (kill the app mid-recording, confirm playback to within about one second). The server converts to a web-playable format.

**Runs.** A recording is one or more runs. A new run starts after every interruption or input-format change. Each run is its own file with its own sample rate, recorded in the note's manifest with its start offset on the note timeline. This handles Bluetooth headsets switching the input to 16 kHz mid-recording, which v0.1's single fixed `sample_rate_hz` could not represent.

**Two state fields, not one.** v0.1 put recording and sync in one enum, so a synced note with a new transcript edit had no valid state.

- Recording: `idle → starting → recording ⇄ interrupted → finalizing → saved`, with `start_failed` and `damaged` as outcomes.
- Sync: `local_only | pending | uploading | synced | blocked(reason)`.

**Storage.**

- Audio and SQLite live in the app's documents area with the file-protection class that stays writable after first unlock. The strictest class makes files unwritable when the phone locks, which stops a background recording.
- No app-level encryption of audio. A device-bound key would make audio restored from a device backup undecryptable. iOS file protection is the control; the settings screen says so.
- Tokens go in the keychain. The keychain survives uninstall and SQLite does not, so first launch clears stale keychain entries.
- Local rows are keyed by account and workspace. The queue never sends one account's work under another's session.

**Limits (configurable).** Maximum note length 30 minutes with a warning at 25. Refuse to start below 200 MB free. Stop and save when free space falls below 50 MB. Discard recordings under one second.

**Transcription.**

- Default engine: Apple's on-device long-form speech API on OS versions that have it; the older recognizer with on-device mode required as the fallback; none when neither supports the locale. Capability is queried per locale at start.
- The older recognizer is restarted about once a minute. Words can be lost at each restart, so segment offsets are recorded per recognition task and the transcript is labelled approximate at those boundaries.
- The workspace's brand terms are passed as custom vocabulary where the engine accepts them. The review screen highlights numbers and names, which are the errors that turn into false claims.
- Partial results are display-only. A final machine transcript is saved as one immutable revision when recording stops.
- A denied speech permission leaves a playable note with no transcript.

**Accessibility.** Start, stop and cancel are ordinary labelled controls. State changes are announced once. Meter values are never announced. Reduced-motion shows a static indicator.

### 5.2 Server voice domain and sync (new)

**Tables** (Ent schema plus reviewed SQL, existing conventions):

| Table | Holds | Key rules |
|---|---|---|
| `voice_note` | Owner, organization, client note ID, title, optional project, consent flags, revision counter, deleted marker | Unique on (organization, owner, client note ID), kept forever including after deletion |
| `voice_transcript_revision` | Note, parent, origin (`on_device`, `remote`, `user_edit`), locale, engine, text, segments, redacted marker | Insert-only. ID is server-assigned; the client's ID is a unique idempotency column |
| `voice_audio_run` | Note, run index, start offset, duration as decoded by the server, checksum, existing `asset` reference | Unique on (note, run index) |

Audio objects reuse the existing private-asset storage and signing. No new bucket layout.

**Operations.** Each is idempotent by its own key, so no generic operation table is needed:

| Operation | Idempotent on | Conflict rule |
|---|---|---|
| Create note | Client note ID | Same ID with different content returns the stored note |
| Add transcript revision | Client revision ID | Never overwrites; two devices produce two revisions and the note shows both |
| Rename, set project | Expected revision | Last writer wins; these are labels |
| Delete | Note ID | Always wins over any older operation; replays return success |
| Upload run | (note, run index) and checksum | Same index with a different checksum is rejected |

**Upload.** The server issues a signed upload URL per run with the content length and checksum signed into it, so the URL cannot be used for a larger or different file. After upload the server checks the stored object's size and checksum, decodes it to confirm it is audio and to measure duration, and only then marks the run available. A bucket lifecycle rule removes objects that never reach that state.

**Sync.** The phone sends its pending operations, then fetches the list of (note ID, revision, deleted) for its owner, and pulls any note whose revision differs. Push notifications are hints to run this; missing one loses nothing. Local audio is evicted only after the server confirms the run and the user's retention setting allows it.

**Web voice inbox.** Lists the signed-in member's own notes. Playback through the existing authenticated asset path. Transcript edits create `user_edit` revisions.

### 5.3 Voice to draft (new, on existing drafts)

- The owner picks a transcript revision, an intent (launch post, documentation outline, onboarding explanation, saved idea) and optionally existing captures or assets.
- The first use shows that the transcript text is sent to the model provider; the choice is stored per workspace member.
- Output is an existing content draft with the transcript revision recorded as a source. Statements not backed by an attached capture are marked as the speaker's claim.
- Transcript text is untrusted input. On its own it cannot schedule, approve or publish; a spoken scheduling command needs the confirmation in 5.4. Publication follows the workspace's existing approval policy, including for API keys with `post:publish`.

### 5.4 Voice commands (new, on existing scheduling)

Example: "Shots, post the following tweet at 10 am tomorrow: entrepreneurship is hard."

**Rule.** The spoken words propose; a tap confirms. A language model works out what was meant. Ordinary code decides whether it is allowed and exactly when. Only a confirmed proposal reaches the scheduler. This keeps the rule in 5.3 intact for everything that is not confirmed.

**Flow**

| Step | Where | What happens |
|---|---|---|
| 1. Transcribe | Phone | On-device transcript saved with the recording time and the phone's time zone at that moment |
| 2. Sync | Phone → server | Transcript revision posted. If the member has voice commands turned on (which carries the remote-text disclosure), the server parses that revision inline and returns the proposal in the same response (6.10) |
| 3. Understand | Server, one model call | The transcript, recording time and zone, and the member's connected accounts go to the model, which must answer in a fixed JSON schema |
| 4. Check | Server, plain code | Every field is validated and resolved (below) |
| 5. Propose | Server | A proposal is stored against the note and the transcript revision it was parsed from |
| 6. Confirm | Phone | A card shows the post text (editable), the account, and the full date, time and zone. Guessed or flagged fields are shown as questions |
| 7. Schedule | Server | Confirm re-runs every check in step 4, creates a content draft from the confirmed text, and schedules it through `ScheduleContentDraft` as the signed-in member. That path enforces "Require approval"; the older `CreateScheduledPost` path does not (6.5, P0) and must not be used here |
| 8. Send | Existing Temporal post workflow | Unchanged |

**Model output (step 3)**

```json
{
  "action": "schedule_post",
  "platform": "x",
  "text": "Entrepreneurship is hard.",
  "local_time": "2026-11-10T10:00",
  "guessed": []
}
```

- `action` is `schedule_post`, `create_draft` or `none`. The schema cannot express anything else.
- `local_time` is a wall-clock time, never an instant. The model interprets "tomorrow at 10"; it does not do time-zone arithmetic.
- `guessed` names each field the model had to assume.
- The call uses the existing Go model client (`server/internal/platformai`, `Structured`, role `nano`), which already enforces the schema and returns a typed error when the reply does not match. Estimated cost at the current model is under one hundredth of a cent per command.
- **Required fix first:** the web's model calls send `data_collection: "deny"` so prompts are not routed to providers that store or train on them. The Go client's request does not send it. Add the same provider preference, plus `require_parameters: true`, to the Go client before any transcript text goes through it.

**Checks in plain code (step 4, repeated at step 7)**

| Check | On failure |
|---|---|
| The post text is contained in the transcript, word for word in order, ignoring case and punctuation | Field flagged as guessed; the card highlights the words the model added |
| `local_time` in the phone's zone converts to exactly one instant | Card asks for the time |
| The instant is in the future, and not more than the scheduler's maximum ahead | Card asks for the time |
| `platform` matches exactly one connected account the member may post to | Card asks which account, or the proposal becomes a draft |
| Text is within the platform's limit | Confirm disabled until edited |
| The member's role allows scheduling | Proposal becomes a draft |
| The proposal's transcript revision is still the note's current one | Proposal is withdrawn and re-parsed |

**Storage.** One `voice_command` row per note: transcript revision, parsed fields, flags, status (`proposed`, `confirmed`, `expired`, `withdrawn`, `failed`), the resulting scheduled-post ID. Unique on the note. Confirm is idempotent on the note ID: the row holds the draft it created, and the existing schedule key (draft, connection, version) makes a retried confirm return the same post. Confirm writes the existing audit log entry with the note as the source.

**Limits.** One proposal per note. Transcripts over 2,000 characters are not parsed. Parses are rate-limited per member. Text only at launch: no media, threads, recurrence, edits or deletions of existing posts.

**Controls.** A per-workspace setting turns voice commands on. A server-side switch disables parsing or confirming for everyone without an app release.

Hands-free scheduling with no tap is a separate owner decision (section 8, decision 8).

### 5.5 Capture hardening (conditional, existing capture system)

Only when RFC 007's trigger is met. Each item is a change to the existing recipe runner, not new architecture.

| Gap | Change |
|---|---|
| A privacy mask selector that matches nothing leaves data visible | A required mask with zero matches fails the capture as `mask_not_applied` |
| Cookie banners, chat widgets, product tours and skeleton loaders in the image | Recipe-level "dismiss" and "wait until gone" steps; capture fails rather than shooting a loading state |
| Feature not visible because a flag is off or rollout is partial | Distinct failure code, separate from "selector not found" |
| Old bundle served from CDN or service worker after deploy | Identity check reads the build marker from the loaded page, not only a build endpoint |
| Staging behind IP allowlist, basic auth or preview protection | Per-connection bypass header stored as a secret; managed browsers have no fixed egress address, so IP allowlisting is documented as unsupported |
| Wrong credentials retried until the demo account locks | One sign-in attempt per job; failure parks the job as `NEEDS_AUTH` |
| Full-page capture of a very long page | Pixel-area cap; over the cap captures the viewport and says so |
| Missing fonts on the provider | A font check on the test page before a connection is marked ready |
| JavaScript dialogs, permission prompts, downloads, new windows | Dialogs dismissed, prompts denied, downloads blocked, new windows closed; each recorded on the attempt |
| DNS rebinding cannot be observed on Cloudflare (already recorded in the capture review) | Stated as residual risk. The browser runs on the provider's network, so it cannot reach Shots' internal addresses |

### 5.6 Signed-in capture: staying signed in

Signed-in capture exists today (section 2). A person signs in once through a live remote browser; Shots stores the encrypted cookies and local storage, never a password; each capture restores that session in a fresh browser.

**Gap.** The stored session is kept 24 hours by default, set by one platform-wide setting. A team that deploys twice a week is asked to sign in again before almost every capture.

**Change, in order of preference**

| # | Mechanism | How it works | When to use |
|---|---|---|---|
| 1 | Per-connection retention | Retention becomes a setting on each app connection, chosen by the person connecting, from 1 to 30 days, default 14. The platform setting stays as the upper bound | Default for everyone |
| 2 | Refresh on use | After every successful capture the refreshed session is saved again and its expiry is extended, so an app that is captured regularly stays connected | Always on |
| 3 | Keep-alive visit | For a connection with no capture in the last half of its retention period, a short scheduled visit restores the session, confirms the account, saves the refreshed state and closes. One visit per connection per period, counted against the workspace's capture allowance | Opt-in per connection |
| 4 | App-provided sign-in | The customer's app exposes an endpoint that, on a request signed by Shots, returns a one-time sign-in link for the demo account. Shots opens it in the remote browser when the stored session is missing or expired | Customers who want fully unattended capture |
| — | Stored passwords | Not adopted. Shots would hold customer credentials and still could not pass two-factor | — |

A person is told before a session lapses: a notice 48 hours ahead, and again when a job parks for sign-in.

**Edge cases**

| # | Case | Required behaviour |
|---|---|---|
| L1 | The app ends the session on its side before Shots' retention does | The capture finds the sign-in page, the job parks as needing sign-in, and the connection is marked accordingly. Retention is an upper bound, not a promise |
| L2 | The restored session is signed in as a different account | Refused, as today; the connection needs sign-in |
| L3 | The demo account's password is changed or the account is disabled | Same as L1 |
| L4 | The app allows one session per account | Captures for a connection run one at a time (already enforced by the connection lease). The keep-alive visit takes the same lease |
| L5 | A keep-alive visit triggers "new sign-in" emails in the customer's app | Stated in the connect screen; keep-alive is opt-in |
| L6 | The connection is revoked | Stored state is deleted at once, as today, including any keep-alive schedule |
| L7 | The sign-in endpoint is slow, down, or returns a link to a host not on the connection's login hosts | The link is refused or the job parks for sign-in; the endpoint is never retried in a tight loop |
| L8 | A replayed or forged request to the customer's sign-in endpoint | Requests carry a timestamp and a signature over the body with a per-connection secret; the customer's side rejects old or unsigned requests. The link is single-use and short-lived |
| L9 | The encryption key for stored sessions is rotated | A previous-key setting already exists so old sessions stay readable; confirm that a session is re-encrypted with the new key when it is next saved |
| L10 | A longer retention period makes a leaked session more valuable | State stays encrypted at rest, is bound to one connection and its approved hosts, and is only ever loaded into the provider's browser. The connect screen shows the chosen period |

### 5.7 Capture at scale

**How capture runs today (read from the code)**

| Aspect | Today | Consequence at volume |
|---|---|---|
| Unit of work | One job per recipe (one screen). Each job opens its own browser, restores the session and proves the build | A deployment with 10 screens opens 10 browsers, one after another |
| Worker | The capture worker runs inside the single backend container with a fixed limit of 3 browser runs at once | About 120 single-screen captures an hour for the whole platform |
| Per workspace | One running capture; a busy job polls again after 15 seconds to 2 minutes | Polling costs a workflow step and a database transaction each time, and the winner is arbitrary |
| Deadline | 30 minutes from admission, including time spent waiting for a slot | Under load, jobs fail without ever running |
| Dispatch | Through the outbox, which runs once a minute and handles 100 rows per run across all event types | Up to a minute before a capture starts; a hard ceiling of 100 starts a minute shared with everything else |
| Provider ceiling | Not tracked. Cloudflare's documented limits for paid accounts are 120 browsers at once and one new browser a second | Past that, launches fail and are retried blindly |

**Changes, in the order to make them**

| # | Change | Detail |
|---|---|---|
| S1 | One browser session per deployment and connection | The runner claims every queued job for the same connection and deployment, opens one browser, restores the session and proves the build once, then runs each recipe in turn. Each recipe keeps its own step and time budget, its own result and its own failure; one failing does not stop the rest. Jobs, attempts and fencing stay per recipe |
| S2 | Deadline counts running time | The 30-minute deadline starts when a job first gets a slot. Waiting has its own, longer limit (default 6 hours), after which the job ends as "not started" with the reason |
| S3 | Start immediately, keep the outbox as the guarantee | After the admitting transaction commits, the workflow is started directly. The outbox row remains and its later delivery is a no-op, because the workflow ID is already taken |
| S4 | Capture workers as their own component | The repository already builds the worker as a separate binary and can exclude queues per process. Run a component that serves only the capture queue, with the per-process limit as a setting instead of the fixed 3. Browser runs are mostly waiting on the network, so one small instance can hold tens of sessions |
| S5 | Platform-wide admission | A claim succeeds only if three counts allow it, checked in one transaction: the connection (1), the workspace (by plan, default 1), and the platform (a setting kept below the provider's limit, default 80% of it). New browser launches pass through a shared one-per-second limiter |
| S6 | Fair waiting instead of polling | Waiting jobs are ordered by workspace turn, then age, so one workspace with 200 jobs cannot starve the rest. A job waits for a "slot granted" signal; a slow fallback timer covers a lost signal |
| S7 | Provider back-pressure | A launch refused for rate or capacity reasons pauses new launches platform-wide for a short, growing interval and is not counted against the job's attempts |
| S8 | A second browser provider | The provider interface already exists. Add a second implementation and route by connection when one account's ceiling is reached or a customer needs a fixed egress address |
| S9 | Metering and retention | Browser seconds are recorded per attempt and counted against the workspace's plan. Attempt rows older than a retention period are deleted |

Fixes F3 (no capture for redeploys) and F4 (cancel superseded jobs) in section 7a remove work before it is queued and belong with S1–S3.

**Capacity by stage.** Assumes a deployment's session takes about two minutes with S1.

| Stage | Changes | Rough ceiling |
|---|---|---|
| Today | — | 120 screens an hour |
| 1 | S1, S2, S3, and the worker limit raised to 20 | 600 deployments an hour |
| 2 | S4, S5, S6, S7 at 96 browsers | 2,900 deployments an hour, about 69,000 a day |
| 3 | S8, or higher limits agreed with the provider | Multiples of stage 2 per provider account |

The launch limit of one browser a second is 3,600 sessions an hour, which is close to what 120 two-minute sessions can hold, so the two provider limits bind at about the same point. These figures are arithmetic, not measurements.

**When to move to the next stage.** Stage 1 when signed-in capture is turned on for the first pilot. Stage 2 when the 95th-percentile wait for a slot passes five minutes, or peak use passes half the platform limit. Stage 3 when peak use passes 80% of the provider's limit for a week.

**Edge cases**

| # | Case | Required behaviour |
|---|---|---|
| Q1 | A browser crashes halfway through a session of 10 recipes | Finished recipes keep their results; the rest return to the queue and run in a new session |
| Q2 | The build changes while a session is running | The build is checked again before each recipe; remaining recipes end as superseded (F4) |
| Q3 | One recipe hangs | Its own time budget ends it; the session continues with the next |
| Q4 | A worker instance is stopped during a deploy of Shots itself | Heartbeats stop, Temporal retries on another instance, the stale attempt is fenced out, and the orphaned browser is closed by the existing cleanup loop |
| Q5 | Slots are counted as used by a session that no longer exists | Counts come from attempts with a live lease, so they free themselves when the lease expires |
| Q6 | A slot-granted signal is lost | The fallback timer makes the job ask again |
| Q7 | One workspace queues hundreds of jobs | Its jobs take turns with other workspaces; its own plan limit bounds how many run at once |
| Q8 | The provider is down | New launches pause, waiting jobs keep their place, running time is not consumed, and the waiting limit in S2 eventually ends them with a clear reason |
| Q9 | Two worker instances claim the same job | Already prevented by the workflow ID and the fencing token |
| Q10 | The same stored session restored in several browsers at once | Not done: one connection runs one session at a time, which S1 makes sufficient |
| Q11 | Public (not signed-in) captures | They use a separate screenshot service and are outside these limits today; they stay separate, with their own rate limit |
| Q12 | A plan allows several captures at once but the demo account allows one session | The connection limit of 1 still applies; more parallelism needs more connections |

**What this depends on.** S1 changes two of RFC 007's stated limits (a 90-second run and 10 steps) from per browser to per recipe within a browser. That needs the owner's agreement (decision 13).

---

## 6. Edge-case register

Sections 6.1–6.3a, 6.6 and 6.7 state required behaviour for new work. Sections 6.4 and 6.5 report what the existing code does.

### 6.1 Recording

| # | Case | Required behaviour |
|---|---|---|
| R1 | App killed or crashes mid-recording | On next launch the note is recovered with audio to within about one second, marked interrupted, never shown as complete |
| R2 | Phone call, Siri or alarm interrupts | Current run is finalized. If the app is in the foreground when the interruption ends, a new run may start; if it was in the background, the note is saved and a notification says recording stopped |
| R3 | Headset connects or disconnects, input format changes | New run with its own format; no dropped or pitch-shifted audio |
| R4 | Another app or a call holds the microphone at start | `start_failed` with the reason; no empty note created |
| R5 | Audio system resets | Engine rebuilt; current run finalized; note saved |
| R6 | Storage runs out while recording | Stop, finalize what exists, tell the user |
| R7 | Microphone permission revoked in Settings during recording | The OS ends the app; handled as R1 |
| R8 | Microphone restricted by device management | Explained as restricted, not as a prompt that can never be granted |
| R9 | Phone locks during recording | Recording continues; files stay writable (storage class in 5.1) |
| R10 | Recording left running | Warning at 25 minutes, stop and save at 30 |
| R11 | Accidental tap, silent or pocket recording | Under one second is discarded; a silent note is kept and labelled as having no detected speech |
| R12 | JavaScript thread stalls | Native writing continues; the UI catches up from the sequence number |
| R13 | Callback from a previous recording arrives late | Dropped by note ID and sequence check |
| R14 | Over-the-air JavaScript update against an older native module | Version handshake at start; recording is disabled with an update prompt if they do not match |
| R15 | Speech unavailable for the locale, or the model is not downloaded | Audio-only note; no silent switch to a network recognizer |
| R16 | Speaker mixes languages | Transcript is in the chosen locale and editable; no auto-detection is promised |
| R17 | No device passcode set | File protection gives nothing; the app says so once in settings |
| R18 | Device restored from backup onto a new phone | Notes and audio return, tokens do not; after sign-in as the same user the notes sync; as a different user they stay local and unsent |

### 6.2 Sync and upload

| # | Case | Required behaviour |
|---|---|---|
| S1 | Same create sent twice, or resent after a lost response | One note |
| S2 | Upload interrupted | Run is re-sent whole; runs are small enough that resume is unnecessary |
| S3 | Signed URL expires before upload | New URL for the same run; note ID unchanged |
| S4 | Client says upload complete but the object is missing, truncated or not audio | Run stays unavailable; client is told to resend |
| S5 | Signed URL used for a different or larger file | Rejected by the signed length and checksum |
| S6 | Two devices edit the same transcript offline | Two revisions; neither lost; the note shows that a choice is needed |
| S7 | Note deleted on one device, edited offline on another | Delete wins; the edit is discarded with a visible notice; the note is not recreated |
| S8 | Device offline for months | Same as S7; deletion markers never expire |
| S9 | Remote transcription finishes after the user edited | New `remote` revision alongside; the user's edit stays current |
| S10 | Member removed from the workspace with unsent notes | Server refuses; notes stay on the phone as `blocked(no_access)` with export and delete |
| S11 | Session expired while offline | Notes are kept; sign-in as the same user resumes sync |
| S12 | Sign-out with unsent notes | The user chooses keep on device, export or delete before sign-out completes |
| S13 | User belongs to several workspaces | Records into the last-used workspace, shown on the record screen; moving a note before first sync is a local change, after sync it is delete and recreate |
| S14 | Phone clock is wrong | Server stores its own receive time and the client's claimed time separately; lists order by server time |
| S15 | Consent to upload audio withdrawn after upload | Queued remote transcription is cancelled; the user is asked whether to delete the server copy |
| S16 | Workspace admin disables remote transcription | Workspace setting overrides the member's; pending jobs are cancelled |
| S17 | Old app version after a contract change | Minimum-version response; recording still works locally |
| S18 | Quota exhausted | Recording and on-device transcription are never blocked; remote transcription and draft generation are refused with the reason |
| S19 | Client-reported duration differs from decoded duration | Server value is used for display and metering |

### 6.3 Voice to draft

| # | Case | Required behaviour |
|---|---|---|
| V1 | Transcript contains instructions ("publish this now") | Never acted on directly. A recognized scheduling command becomes a confirmation card (5.4); anything else is text |
| V2 | Speaker describes a feature that has not shipped | Marked as the speaker's claim; never presented as verified |
| V3 | Number or product name mis-transcribed | Highlighted for review before a draft is accepted |
| V4 | Model returns invalid output, refuses or times out | Bounded retries; the note and transcript are untouched; the failure is shown |
| V5 | Transcript revision deleted after a draft used it | The draft keeps its text; the source link shows "source removed" |
| V6 | Member wants local-only | Draft generation is unavailable until they accept remote text processing; nothing is sent implicitly |

### 6.3a Voice commands

| # | Case | Required behaviour |
|---|---|---|
| K1 | Recorded offline at 11:50 pm, synced the next morning | "Tomorrow" is resolved from the recording time, not the sync time |
| K2 | The resolved time has already passed when the card appears | The card asks for a new time; nothing is sent late |
| K3 | Phone time zone differs from the workspace's | The phone's zone at recording is used and shown on the card |
| K4 | "10" with no am or pm; a time that does not exist or occurs twice on a clock-change day | The card asks; no guess is scheduled |
| K5 | Several X accounts connected, or none | Several: the card asks which. None: saved as a draft with a prompt to connect |
| K6 | Post text is over the platform's limit | The card shows the count and blocks Confirm until edited |
| K7 | Where the post text ends is unclear ("…is hard, um, and also remind me…") | The card shows the parsed text for editing; the full transcript is one tap away |
| K8 | Mis-transcribed words, missing punctuation or capitals | Same card; the user corrects before confirming |
| K9 | Someone else's voice or played-back audio says "Shots, post…" | Produces a card at most; nothing happens without the tap |
| K10 | The member cannot publish, or the workspace requires approval | Cannot publish: saved as a draft. Approval required: submitted for approval |
| K11 | Confirm tapped twice, or resent after a lost response | One scheduled post |
| K12 | The parser is unavailable or returns nothing usable | The note is kept as an ordinary note with a "could not understand the command" notice |
| K13 | The command names something unsupported ("delete my last tweet", "DM this to…") | Ordinary note; only scheduling and drafting are recognized |
| K14 | The card is never confirmed | It expires at the proposed time and the note remains |
| K15 | The note is deleted after the post is scheduled | The post stays scheduled; its source link shows "source removed" |
| K16 | "Tomorrow" said between midnight and 4 am | `local_time` is flagged as guessed; the card shows both candidate dates |
| K17 | The model adds words the speaker did not say | Caught by the containment check; added words are highlighted on the card |
| K18 | The transcript is edited after the proposal was made | The proposal is withdrawn and the new revision is parsed |
| K19 | Two commands in one note | One proposal for the first; the card says a second request was heard and not acted on |
| K20 | "…with my latest screenshot", "as a thread", "every Monday" | Text-only proposal with the unsupported part named on the card, or a draft |
| K21 | The account is disconnected, or the member's role changes, between card and tap | Confirm re-checks and fails with the reason; nothing is scheduled |
| K22 | The phone edits the card to a past time or an account it does not own | Server-side checks at confirm reject it; the card is never trusted |
| K23 | Proposal ready while the app is closed | Push notification; expiry at the proposed time sends a second notice that nothing was posted |
| K24 | The user travels between recording and confirming | The zone at recording is used and named on the card |
| K25 | The model provider is down or slow | The note syncs normally; the parse retries with backoff, then the note is left as an ordinary note with a notice |

### 6.4 Releases and capture (existing systems, checked against the code)

Status is from a read of the code on 2026-11-09, with file references in section 9. "Gap" means the code does not do this today.

| # | Case | What the code does today | Status | Fix |
|---|---|---|---|---|
| C1 | Release event arrives before its deployment | Waits for the deployment; never records the old UI | Covered | — |
| C2 | Deployments complete out of order | An older deployment's capture never replaces a newer one | Covered | — |
| C3 | Same SHA redeployed, or a rollback to an older SHA | Deployments are deduplicated by GitHub deployment ID, not by commit. A redeploy or rollback creates a new event, new capture jobs and a new automation run, and the rollback's screenshot becomes the surface's current image. The Vercel/Netlify path sets a rollback flag that only changes the alert type | **Gap** | Compare the SHA with the last deployed one per source and environment: same SHA is a no-op, an older SHA is a rollback that recaptures but never starts a campaign |
| C4 | Many deployments in a short time | Every deployment gets its own jobs and run. Nothing cancels older ones. An old job that checks the version sees the newer SHA and retries for its full 30-minute deadline, opening a browser each time | **Gap** | When a newer deployment is admitted for the same source and environment, cancel pending jobs for older ones. Treat "newer SHA is live" as final, not retryable |
| C5 | Monorepo: one commit, several deployed apps | Jobs go to every connection whose source and environment match. The workflow `capture_product` action checks the connection's source but not its environment | **Partial** | Add the environment check to `capture_product` |
| C6 | Repository renamed or transferred; installation suspended or removed | Rename is harmless (sources use the numeric repository ID). Removal archives sources and cancels runs. Suspension cancels runs but does not stop capture jobs. A transfer to an owner with a different installation appears to drop events silently (inferred, not tested) | **Partial** | Stop capture jobs on suspension. Handle the `repository` transferred event by marking the source as needing reconnection |
| C7 | Webhook secret rotation | One secret, raw-body HMAC, constant-time compare. No second secret is accepted, so rotation rejects deliveries until both sides are updated | **Gap** | Accept a previous secret during rotation, as `CAPTURE_STATE_KEY_PREVIOUS` already does for capture state |
| C8 | Change reverted after its announcement was published | Not a capture concern | By design | RFC 006 |
| C9 | Job parked waiting for a person | 30-minute deadline at admission; `NEEDS_AUTH` extends to 7 days and holds no browser; a cleanup loop fails anything past its deadline. Resume rechecks the deployment row and source, and the SHA only for recipes with a version check. It does not check whether a newer deployment superseded the job | **Mostly covered** | Closed by the C4 fix |
| C10 | Session expired, multi-factor prompt, CAPTCHA | Parks as `NEEDS_AUTH`; reconnect resumes the same job | Covered (challenges simulated) | — |
| C11 | One active capture per workspace | Enforced at claim across all job kinds, plus a per-connection lease. Only the connection row is locked, so two jobs on different connections may both pass at once (inferred; the test is sequential). Public captures and sign-in validation skip the limit | **Partial** | Take a workspace-level lock in the claim; add a concurrent test |
| C12 | Worker dies after allocation, upload or commit | One result; stale attempt rejected by fencing | Covered | — |
| C13 | Late duplicate dispatch | Workflow IDs include the resume count, with reject-duplicate and use-existing policies. After Temporal retention expires, a re-run's claim returns done for finished jobs | Covered | — |
| C14 | Outbox growth | Rows that keep failing are dead-lettered after 8 attempts with an audit record. Delivered rows are never deleted except with the workspace | **Gap** | A maintenance job that deletes delivered rows after a retention period |
| C15 | Replayed or out-of-order webhook deliveries | Deduplicated on semantic keys with unique indexes; late or conflicting observations go to review | Covered | — |

### 6.5 Approval and publishing (existing systems, checked against the code)

| # | Case | What the code does today | Status | Fix |
|---|---|---|---|---|
| P0 | Scheduling a content draft through the scheduled-posts endpoint in a workspace that requires approval | `CreateScheduledPost` accepts a content draft ID and a caption from a signed-in publisher and never calls `requireDraftApproval`; its own comment says "a content draft has no approval step". At send time only a "changes requested" status stops the post. Unreviewed text can therefore be scheduled where approval is required | **Gap, most serious** | Call `requireDraftApproval` in `CreateScheduledPost` for content drafts, or refuse content drafts on that endpoint; add a test |
| P1 | Content edited after approval | Drafts: approval is tied to a version number; an edit bumps it and scheduling refuses until re-approved. Since #497 on `develop`, a review decision must name the version the reviewer saw and fails if the draft moved, and review and scheduling take a shared lock. Campaign posts: editing an approved post returns it to draft. There is no content hash | Covered on `develop` | — |
| P2 | One approver approves, another rejects | No quorum; one decision governs. Campaign post copy: first decision wins. Variants and drafts: a later "changes requested" cancels queued posts; since #497 this happens at the moment of the decision, not only at send time | **Works, undocumented** | Document the rule |
| P3 | Approver loses the role before the send | Not rechecked. The send-time check looks at workspace deletion, connection status and review status. `scheduled_post` does not record who scheduled or approved it | **Gap** | Record the scheduler and approver on the post. Decide whether a removed approver's approvals stand (owner decision 9) |
| P4 | Author approves their own content | Allowed for any owner, admin or approver. No setting; RFC 043 is not started | **Gap by omission** | Owner decision 10 |
| P5 | Provider accepts the post but the response is lost | `UNKNOWN_DELIVERY`; no automatic retry | Covered | — |
| P6 | Thread or carousel partly published | Threads: a failed reply stops the thread; progress and receipts are recorded; "Post the rest" resumes from the last live reply. Carousels: one provider call; any failure is `UNKNOWN_DELIVERY` with no per-item record | Covered (threads); acceptable (carousels) | — |
| P7 | Concurrent refresh of a rotating OAuth token | Publishing never refreshes; an expired token fails as "reconnect". Refresh runs in one maintenance job under an advisory lock, with a version-checked write. The analytics refresh may still race it (inferred) | **Mostly covered** | Route the analytics refresh through the same lock |
| P8 | Provider fetches media after the signed URL expires | Signed at send time, valid 24 hours; the send step times out at 30 minutes | Covered | — |
| P9 | Worker dies in `PROCESSING` | Stalled-post recovery settles it | Covered | — |
| P10 | Outage past the scheduled time | `MISSED_WINDOW` after one hour | Covered | — |
| P11 | Rate limits and daily caps | The shared HTTP client retries a 429 three times, 5 seconds apart, then returns a generic error, which the publisher records as `UNKNOWN_DELIVERY`. Instagram's daily cap takes the same route. The durable 429 retry described in the reliability doc is only reachable from the test provider. A resend after a plain 500 may also be possible (inferred) | **Gap** | Return a typed rate-limit error from the HTTP client so the workflow's durable retry applies; classify daily caps as a definite failure with the reason, not as unknown |
| P12 | Cancel requested while the request is in flight | Outcome may still be published | By design | — |
| P13 | Workspace deletion or downgrade with scheduled posts | Deletion: posts are cancelled as `WORKSPACE_INACTIVE` when due, and publish normally if the deletion is withdrawn within the 14-day grace. Downgrade: nothing is cancelled and the plan is not checked at send time | **Partial** | Owner decision 11 on downgrade |
| P14 | Database restored to an earlier point | See D4 | **Gap** | D4 |

### 6.6 Data, deletion and recovery

| # | Case | Required behaviour |
|---|---|---|
| D1 | Delete audio, keep transcript; delete transcript, keep draft | Each is separate. Audio: object purged, run row keeps a marker. Transcript: text replaced by a redaction marker on the insert-only row through an audited purge path |
| D2 | Account deletion | Reuses the existing account-deletion request flow; extends it to voice tables and audio assets |
| D3 | Deletion recorded, then the database is restored to before it | Deletions are also appended to a ledger object in R2, outside the database. Restore procedure replays the ledger before the app is reopened |
| D4 | Restore leaves Temporal ahead of the database | Publishing schedules are paused before restore. Posts are reconciled from Temporal history and provider receipts before resuming, so a post the database has "forgotten" is not sent again |
| D5 | Upload succeeds, database write fails | Object has no row; lifecycle rule removes it |
| D6 | Row written, object missing | Run stays unavailable; client resends |
| D7 | Member removed: their private notes | Owner decision 6 in section 8; default is deletion after 30 days with notice |
| D8 | Transcript or audio sent to a remote provider | Provider retention setting is part of the provider checklist; no provider is added without it |

### 6.7 Platform and compliance

| # | Case | Required behaviour |
|---|---|---|
| A1 | App Store sign-in rule: the app offers Google and GitHub sign-in | Add Sign in with Apple, or an equivalent the guideline accepts, before submission |
| A2 | App Store payments rule | The app has no purchase or upgrade screens; it is for existing accounts |
| A3 | App Store account-deletion rule | Deletion is reachable in the app |
| A4 | Background audio entitlement | Justified in review notes by user-started recording with a visible indicator |
| A5 | Privacy labels and permission strings | Microphone and speech strings state on-device by default and name what is uploaded |
| A6 | Recording other people | The app does not claim legal compliance; recording state is always visible; no speaker identification |
| A7 | Lost phone | Sessions are revocable from the web; local audio is protected only by the device passcode |

---

### 6.8 When a dependency is down

| Dependency down | Recording | Sync | Voice commands | Publishing |
|---|---|---|---|---|
| Network | Works | Queued on the phone | Card appears after reconnect; K2 applies if the time passed | n/a |
| Shots API or database | Works | Queued; retried with backoff | No proposals; none are lost | Existing behaviour: nothing new is admitted |
| R2 | Works | Transcripts sync; audio waits | Unaffected (text only) | Existing behaviour |
| Model provider | Works | Works | K25 | Unaffected |
| Apple speech | Audio-only note | Works | No transcript, so no command; the note says why | Unaffected |
| Temporal | Works | Works | Confirm fails cleanly and can be retried; no half-created post | Existing recovery (`missing-post-workflow`) |
| Push notifications | Works | Next app open | Card appears on next app open | Unaffected |

Recording never depends on anything outside the phone.

### 6.9 Rollout and what is measured

- **Flags.** Voice notes, audio upload, draft generation and voice commands are separate per-workspace settings, all off by default, each with a server-side switch.
- **Order.** Internal workspace, then pilot workspaces, then general availability. Voice commands follow voice notes by at least one release.
- **App versions.** The server states the minimum supported app version. An older app keeps recording locally and is told to update before it can sync.
- **Measured from day one:** recordings started, recovered after interruption, and lost; sync failures by reason; transcript availability by locale; proposals made, confirmed, edited before confirm, expired; fields flagged as guessed; posts scheduled from voice and their final status. Transcript text and audio never go into logs or metrics.

### 6.10 Queueing and scale

| Work | How it is queued |
|---|---|
| Recording and transcription | Not queued; on the phone |
| Unsent notes and uploads | A queue in the phone's SQLite, retried with backoff |
| Audio bytes | Uploaded from the phone straight to R2; never through the backend |
| Audio check (format, duration) | A Temporal activity on the existing worker |
| Voice command parse | Inline in the sync request with a 5-second limit; on failure the note is marked waiting and a maintenance sweep retries it |
| Scheduled post | The existing per-post Temporal workflow |

The parse does not go through the outbox. The outbox is dispatched about once a minute, 100 rows per run, which would delay the confirmation card by up to a minute and share that budget with all other events.

**Load.** 1,000 notes a day is one every 86 seconds; 100,000 a day averages about 1.2 a second. Each is a small write and one model call that mostly waits on the network.

**What runs out first, and the lever for each**

| Limit | Lever |
|---|---|
| Model provider rate limit | The per-member parse limit; the sweep absorbs bursts |
| Backend instances (the API and worker share one container in production) | More instances, or run the API and worker as the separate binaries the repository already builds. Whether the combined container is safe to run as several copies is not checked |
| Database connections (sessions are checked on every request) | Connection pooling |
| Temporal worker concurrency for audio checks | Existing concurrency settings, or a separate task queue for voice so audio checks cannot delay publishing |

None of this has been load-tested.

---

## 7. Corrected targets

| v0.1 target | Problem | v0.2 |
|---|---|---|
| 99.9% monthly availability for metadata APIs | One recovery at the stated 4-hour RTO is 99.45% | Voice endpoints inherit the existing API's measured availability. No new number until there is a baseline |
| Release with 8 tasks reviewable in 10 minutes at p95 | Three attempts of 4 minutes in a 15-minute task budget, two at a time, exceeds it | Not adopted. Existing capture limits stand (90-second run, one per workspace) |
| 20 concurrent browser sessions from a 4× burst on a 24-hour average | Releases cluster in working hours, so the peak is higher; provider account limits were not checked | Not needed while capture is one per workspace. Size from provider limits when RFC 007 starts |
| Recording visible within 500 ms | Fine | Kept; measured on the oldest supported phone |
| RPO 15 minutes, RTO 4 hours | Covers the database only | Kept for the database. Restore procedure adds D3 and D4 |

Voice storage arithmetic in v0.1 is correct: 1,000 three-minute notes a day at 64 kbit/s is 1.44 GB a day and 43.2 GB over 30 days.

---

## 7a. Fixes to existing code

These came out of checking sections 6.4 and 6.5 against the code. Each fix below names the problem as it is in the code today, the change, the behaviour afterwards, the edge cases, and the test that proves it. All follow the repository's rules: Ent schema plus reviewed SQL for table changes, additive migrations, a regression test beside the code.

| Order | Fix | Cases | Size |
|---|---|---|---|
| F1 | Approval cannot be skipped through the scheduled-posts endpoint | P0 | Small |
| F2 | Rate limits retry durably; daily caps fail with a reason; no resend after a server error | P11 | Medium |
| F3 | Redeploys and rollbacks are not new releases | C3 | Medium |
| F4 | Superseded capture jobs are cancelled | C4, C9 | Medium |
| F5 | The Go model client sends the same provider rules as the web | 5.4 | Small |
| F6 | Webhook secrets can be rotated without dropping deliveries | C7 | Small |
| F7 | Scheduled posts record who scheduled and approved; optional rule against self-approval | P3, P4 | Small |
| F8 | Restore procedure and deletion ledger | D3, D4, P14 | Medium |
| F9 | Contained fixes: outbox retention, capture lock, environment check, suspension, repository transfer, analytics token refresh | C14, C11, C5, C6, P7 | Small each |

F1, F5 and F7 are prerequisites for voice commands (Gate 3b). F1 and F2 change publishing internals, not the screens Meta is reviewing; ship them with their tests and re-run `./dev/social-gate` before release.

### F1. Approval cannot be skipped through the scheduled-posts endpoint

**Today.** `CreateScheduledPost` (`server/internal/product/scheduled_posts.go`) accepts a content draft ID and a caller-supplied caption from a signed-in publisher. It never calls `requireDraftApproval`, and `isEligible` returns true for any content draft with an active connection. Two problems follow: an unapproved draft can be scheduled, and even for an approved draft the caption is whatever the caller sends, not the approved text.

**Change.**

1. List the callers of this endpoint that pass a content draft. The versioned path (`ScheduleContentDraft`) is the intended one for drafts.
2. If nothing in the product still needs it, `CreateScheduledPost` refuses content drafts outright and points to the draft scheduling path. If something does, it refuses them whenever the workspace has "Require approval" on.
3. Correct the comment that says a content draft has no approval step.
4. Check the reported behaviour that `scheduleContentDraft` takes captions from the request (`content_draft_schedule.go`, near line 857). If confirmed, build captions on the server from the stored draft version so the Go layer does not depend on the web layer to send approved text.

**After.** In a workspace that requires approval, every route to a scheduled content-draft post goes through `requireDraftApproval` and carries the stored draft's text.

**Edge cases.**

- Posts already scheduled through the old route: a one-off query lists posts in `SCHEDULED` state whose draft is not approved at its current version in workspaces that require approval. The owner of each workspace is told; nothing is cancelled automatically.
- Approved variants scheduled by API keys are unaffected; that path already checks the variant's approval.
- A workspace that turns "Require approval" on while posts are queued: queued posts keep the rule they were scheduled under, as today.

**Test.** With approval required and a draft pending review, a publisher's request to the scheduled-posts endpoint returns a conflict and creates no post. With approval off, existing behaviour is unchanged.

### F2. Rate limits, daily caps and server errors

**Today.** The shared provider HTTP client (`server/internal/social/integrations/base.go`, `fetch`) retries a 429, and also a 500 with no recognised error body, three times at a fixed delay, then returns a generic error. `publicationOutcome` turns every error that is not "rejected" or "reconnect" into "outcome unknown". Three consequences:

- A lasting 429 becomes `UNKNOWN_DELIVERY` and waits for a person, although the provider accepted nothing.
- Instagram's daily cap (error 2207042, and "Page request limit reached") is tagged as a generic bad request and also becomes `UNKNOWN_DELIVERY`.
- A publishing request that got a 500 is sent again. The provider may have accepted the first one, so this can create a duplicate post. It contradicts the repository's own rule against retrying provider mutations.

The durable 429 retry in the publishing activity exists but is unreachable, because it needs a 429 error that is not marked unknown, and the real publisher never produces one.

**Change.**

1. `fetch` retries a 500 only for read requests. For a publishing request, a 500 returns immediately as "outcome unknown".
2. After its short 429 retries, `fetch` returns a new typed failure, rate limited, carrying the provider's retry-after value when present.
3. Provider error tables gain a `limit` type for daily caps (Instagram 2207042 and the page limit first; others as found).
4. `publicationOutcome` maps rate limited to a 429 that is not unknown, which is exactly what the existing activity branch retries through Temporal. It maps `limit` to a definite failure with a new failure code, `PROVIDER_DAILY_LIMIT`.

**After.**

| Provider response | Outcome |
|---|---|
| 429, clears within the retry budget | Published once, after a durable wait |
| 429, does not clear | `FAILED` with a rate-limit reason; the user can reschedule |
| Daily cap | `FAILED` with `PROVIDER_DAILY_LIMIT` and the provider's message |
| 500 on a publishing request | `UNKNOWN_DELIVERY` after one request |

**Edge cases.**

- A retry wait that would pass the one-hour late window ends as `MISSED_WINDOW`, as today.
- A 429 in the middle of a thread: posted replies and progress are kept, as today; the remaining replies wait.
- A provider that sends 429 for a cap that will not clear until tomorrow: bounded by the activity's maximum attempts, then fails with the reason.
- Providers whose "rate limit" text arrives with a 200 or 400 status: still recognised by the existing text match, now returning the typed failure.

**Test.** Against a local HTTP stub: 429 then success publishes exactly once; persistent 429 ends `FAILED`, not `UNKNOWN_DELIVERY`; 2207042 ends `FAILED` with `PROVIDER_DAILY_LIMIT`; a 500 on a publishing request results in exactly one request and `UNKNOWN_DELIVERY`.

### F3. Redeploys and rollbacks are not new releases

**Today.** Deployments are unique on the provider's deployment ID per source. Redeploying the same commit, or rolling back to an older one, creates a new deployment event, new capture jobs and a new automation run. The Vercel and Netlify path sets a rollback flag that changes only the alert type.

**Change.** When a deployment event is admitted, compare its commit with earlier successful deployments for the same source and environment, and store the result on the event as `kind`:

| Kind | Rule | Automation run | Capture |
|---|---|---|---|
| `new` | Commit never deployed here before | Starts | Runs |
| `redeploy` | Same commit as the current live deployment | Does not start | Runs only for surfaces with no capture for this commit |
| `rollback` | Commit was deployed here before and is not the current one | Does not start | Runs, recorded as a rollback |

The workflow evaluator reads `kind`, so both the GitHub path and the Vercel and Netlify path stop starting campaigns for rollbacks.

**Edge cases.**

- A rollback to a commit Shots never saw deployed is classified `new`. This is the known limit of comparing against Shots' own history; the upgrade is to ask GitHub whether the commit is an ancestor of the previous one.
- A revert commit is a new commit and is treated as `new`. Whether it deserves communication is a qualification question (RFC 002), and the opt-in change receipt already covers "nothing changed".
- A rollback capture replaces the current image, which is correct: the live product is the old UI again. RFC 006 freshness can use the `rollback` record to flag published material.
- Two environments from one repository are compared separately.

**Test.** Deploy A, deploy B, deploy A again: the third event is `rollback`, starts no automation run, and its capture is recorded as a rollback. Deploy B twice: the second is `redeploy` and opens no browser when captures for B exist.

### F4. Superseded capture jobs are cancelled

**Today.** Every deployment gets its own capture jobs. Nothing cancels older ones. An older job with a version check sees the newer commit, is told to wait for its deployment, and retries with backoff until its 30-minute deadline, opening a browser each time and holding the workspace's single capture slot.

**Change.**

1. When deployment jobs are admitted (`admitDeploymentCaptures`), the same transaction cancels queued and waiting deployment jobs for the same recipe that belong to an older deployment, with failure code `superseded`. Running attempts are left to finish; the existing out-of-order rule already stops their image replacing a newer one.
2. When an attempt reports "a different revision is live" and a newer deployment event exists for that source and environment, the job ends as `superseded` instead of retrying.
3. "Older" is decided by the provider's deployment time, not by arrival order, so a late-arriving old deployment is admitted already superseded.
4. An automation run waiting on a superseded job receives that outcome and ends as superseded.

**Edge cases.**

- Thirty deployments in an hour produce at most one waiting job per recipe plus whatever is already running.
- Test, manual and agent jobs are never superseded by deployments.
- A job parked for sign-in whose deployment is superseded is cancelled; the newer deployment's job parks in its place, so the person reconnects once.

**Test.** Admit deployments A then B for one recipe: A's queued job is cancelled as `superseded` and no browser opens for it. An attempt for A that finds B live ends `superseded` with one attempt.

### F5. The Go model client sends the web's provider rules

**Today.** The web sends `data_collection: "deny"` with every model call, which backs the public "no training on your content" promise. The Go client (`server/internal/platformai/platformai.go`, `Structured`) sends no provider preferences.

**Change.** Add `provider: { data_collection: "deny", require_parameters: true }` to the Go request body, with a comment pointing to the web's constant as the counterpart.

**Edge cases.** If no provider satisfies the rules for the configured model, the call fails as a non-retryable provider error and callers degrade as they already do when no key is set.

**Test.** The existing client test asserts the request body contains both settings.

### F6. Webhook secret rotation

**Today.** GitHub App deliveries are verified against one secret (`GITHUB_APP_WEBHOOK_SECRET`). Changing it rejects deliveries until GitHub and the environment agree. Per-source secrets derive from one platform key with the same limitation, noted in the code.

**Change.** Accept an optional previous secret (`GITHUB_APP_WEBHOOK_SECRET_PREVIOUS`, and the equivalent for the platform key), the same pattern `CAPTURE_STATE_KEY_PREVIOUS` already uses. Verification tries the current secret, then the previous, both in constant time.

**Procedure.** Set the previous variable to the old secret and the main one to the new secret; deploy; change the secret in GitHub; remove the previous variable a day later.

**Test.** A delivery signed with either secret is accepted while both are set; one signed with the old secret is rejected once the previous variable is removed.

### F7. Who scheduled, who approved, and which version

**Today.** `scheduled_post` records neither the person who scheduled it nor the approver. Nothing prevents approving one's own draft, and there is no setting for it. (Approving against the version the reviewer saw was added in #497 and is no longer part of this fix.)

**Change.**

1. `scheduled_post` gains nullable `scheduled_by_user_id`, `approved_by_user_id` and `approved_version`, filled at scheduling from the actor and the draft's review fields. Existing rows stay null.
2. Draft settings gain `allow_self_approval`, default on. When off, approval is refused if the approver is the draft's last editor.

**After.** Every scheduled post can answer "who put this out and who signed it off".

**Edge cases.**

- Posts from API keys record the key's identity as the scheduler.
- A removed approver's approvals still stand (owner decision 9); the record makes it possible to change that rule later without guessing.
- A one-person workspace keeps working because self-approval defaults to allowed.

**Test.** With self-approval off, the last editor cannot approve. A scheduled post created after approval carries all three fields.

### F8. Restore procedure and deletion ledger

**Today.** Production is PlanetScale Postgres with point-in-time recovery to a new branch, up to five minutes ago, over a two-day default window. The documented use is undoing a bad migration. Two things are not covered: Temporal keeps running ahead of a restored database, and deletions made after the restore point come back.

**Change.**

1. **Publishing pause.** A server setting checked at the start of the publishing activity. While set, no provider call is made and the post is held. It is set before any restore.
2. **Deletion ledger.** The existing outbox handler for deletions also appends a small record (what was deleted, when, by which request) to R2 under a dated prefix. R2 is outside the database's backup, so the ledger survives a restore. The record is written within the outbox's normal delay of about a minute.
3. **Runbook**, added to the deployment guide:
   1. Set the publishing pause and pause the Temporal maintenance schedules.
   2. Restore the database to the chosen time.
   3. Reconcile posts: list post workflows active since the restore time using the existing typed search attributes. For each with a provider receipt in its history, write the published state and receipt. For each that had begun sending with no receipt, set `UNKNOWN_DELIVERY`. For workflows whose post no longer exists in the database, terminate them and report the list to the workspace owner.
   4. Replay the deletion ledger from the restore time: mark those records deleted again.
   5. Clear the pause and resume schedules.
4. **Drill.** Run the procedure once against staging before voice launch, and after any change to publishing.

**Edge cases.**

- Posts held by the pause for more than an hour end as `MISSED_WINDOW` under the existing rule. That is the intended behaviour; nothing is sent late.
- A deletion made in the last minute before the restore point may be missing from the ledger if the outbox had not run. The object is still present in that case, so nothing is inconsistent; the user's deletion request is lost and must be repeated. The runbook says so.
- Objects deleted from R2 whose rows come back are caught by the ledger replay.

**Test.** On staging: publish a post, delete an asset, restore to before both. After the runbook, the post shows as published and is not sent again, and the asset is deleted.

### F9. Contained fixes

| Fix | Today | Change | Test |
|---|---|---|---|
| Outbox retention (C14) | Delivered rows are kept until the workspace is deleted | A maintenance job deletes delivered rows older than 30 days in batches; dead-lettered rows are kept. The audit log already records each dispatch | Rows older than the window are removed; undelivered rows are untouched |
| Workspace capture lock (C11) | The claim locks only the connection row, so two jobs on different connections can both pass the one-per-workspace count | Take a transaction-level advisory lock on the workspace before counting running attempts | Two concurrent claims on different connections: one proceeds, one waits |
| Environment check (C5) | The workflow's `capture_product` action checks the connection's source but not its environment | Refuse when the connection's environment differs from the deployment's | A staging connection is not used for a production deployment event |
| Suspension (C6) | A suspended installation cancels automation runs but not capture jobs; manual, test and agent jobs never check the source | On suspension, cancel queued and waiting deployment capture jobs for its sources; the eligibility check refuses jobs for a suspended installation | A suspended installation opens no browser |
| Repository transfer (C6) | The repository event is not handled; after a transfer to a different installation, events appear to be dropped silently | Handle the transferred action: mark the source as needing reconnection, write an audit record, notify the workspace | A transfer event leaves the source visibly needing reconnection |
| Analytics token refresh (P7) | The scheduled refresh job is serialized; the analytics path may refresh the same rotating token at the same time | Route the analytics refresh through the same lock and version-checked write | Two concurrent refreshes produce one stored token |

---

## 8. Delivery sequence

| Gate | Work | Exit condition |
|---|---|---|
| 0 | Owner authorization and the decisions below. Two short tests: (a) kill the app mid-recording on a real phone in each candidate format; (b) a signed-in mobile session against Better Auth, including Sign in with Apple | Authorization recorded in the RFC index. A format chosen from test (a). Mobile sign-in works end to end |
| 1 | Local recorder on iOS: record, recover, play, on-device transcript, delete. No server | R1–R18 pass on physical devices, including one at the oldest supported OS version |
| 2 | Server voice domain, upload, sync, web voice inbox | S1–S19 and D1–D6 pass; `make tenant-isolation` extended to voice notes and passes; another member cannot read a private note |
| 3 | Voice to draft | V1–V6 pass; a draft from a voice note goes through the existing approval policy unchanged |
| 3b | Voice commands, 5.4 | K1–K25 pass; the spoken example schedules one X post at the right instant after one tap, and waits for approval in a workspace that requires it |
| 4 (conditional) | Capture hardening (5.5), staying signed in (5.6), and stage 1 of capture at scale (5.7: S1–S3) | RFC 007 trigger met; each row has a regression test in the existing capture suite; L1–L10 and Q1–Q12 pass; a 10-screen deployment opens one browser |
| 5 (by measurement) | Stages 2 and 3 of capture at scale (5.7: S4–S9) | Entered on the thresholds in 5.7; a load test on staging holds the platform limit without failed launches and with no workspace starved |
| Parallel | Fixes F1–F9 in section 7a | F1 first and on its own. F1, F5 and F7 merged before Gate 3b. F8's drill done before voice launch. Each fix has its regression test |

**Stop conditions.** If test (a) finds no format that survives a kill, recording design is reopened before Gate 1. If pilots do not use voice notes by the metric set at Gate 0, the work stops at the gate it is on.

### Decisions the owner must make

| # | Decision | Recommendation |
|---|---|---|
| 1 | Authorize voice capture as a product line beside release readiness, with an outcome metric | Required before any build |
| 2 | Remote transcription provider, or none at launch | None at launch; on-device only |
| 3 | Audio upload default | Off; transcript-only sync by default |
| 4 | Oldest supported iOS version | iOS 26, the first with the on-device long-form speech API, to avoid the restart path |
| 5 | Maximum note length | 30 minutes |
| 6 | A removed member's private notes | Delete after 30 days with notice |
| 7 | Sign in with Apple | Add it; it is the simplest way through the App Store rule |
| 8 | Whether a spoken command may schedule with no confirming tap | No at launch. If wanted later: a per-member opt-in, with the app reading the post and time back aloud and waiting for a spoken "confirm" |
| 12 | Default period a signed-in capture session is kept | 14 days, chosen per connection up to 30 |
| 13 | Run all of a deployment's screens in one browser session, making the run and step limits per screen | Yes; it is the largest single gain in capacity and cost |
| 14 | How many captures a workspace may run at once | 1 by default, more by plan |
| 9 | Whether approvals by a member who is later removed still authorize a send | Yes, but record the approver on the post so it can be audited and changed later |
| 10 | Whether authors may approve their own content | A per-workspace setting, default allowed, since small teams have one person |
| 11 | Scheduled posts when a workspace downgrades | Keep already-scheduled posts; block new scheduling over the plan's allowance |

---

## 9. What was verified, and how

**Read directly in the repository (`329d1630`):** `AGENTS.md`, `server/README.md`, `docs/rfcs/README.md`, RFC 007 and the capture review's implementation status, `docs/deployment.md`, `docs/release-automation.md`, `docs/vision.md`, the capture and outbox Ent schemas, `server/go.mod`, `server/internal/platformai/platformai.go`, the web model catalog, pricing and provider settings, and the Better Auth server configuration.

**Confirmed by reading the code directly:** the capture pipeline facts in 5.7 (one job per recipe, the fixed worker limit of 3, the per-workspace limit and polling, the 30-minute deadline, dispatch through the once-a-minute outbox). Also P0 and the three parts of F2 (the 500 retry in `fetch`, the mapping of every other error to "unknown", and the daily-cap error type), the capture admission and retry behaviour behind F4, the single webhook secret behind F6, the missing provider preferences behind F5, and the outbox having no retention. For P0: `CreateScheduledPost` in `server/internal/product/scheduled_posts.go` and `server/internal/publishing/repository.go` has no approval check for content drafts, and `requireDraftApproval` is called only from the draft schedule, batch and publish-now paths. It was not exercised with a live request.

**The other rows in 6.4 and 6.5 come from two delegated code reads on 2026-11-09**, each returning file and line references and test names. They were not re-read line by line. Items marked "inferred" in the tables had no test or direct statement behind them. The main references:

- Releases and capture: `server/internal/product/capture_jobs.go`, `github_events.go`, `github_installations.go`, `release_automation_intake.go`, `release_automation_capture.go`, `surfaces.go`; `server/internal/releaseautomation/production.go`; `server/internal/temporalcapture/workflow.go`; `server/internal/maintenance/outbox.go`; `clients/apps/web/lib/tenant/github.ts`.
- Approval and publishing: `server/internal/product/campaign_transitions.go`, `content_draft_platform.go`, `content_draft_schedule.go`, `content_draft_post.go`, `scheduled_posts.go`, `deletion.go`; `server/internal/publishing/repository.go`; `server/internal/temporalpublishing/activities.go`; `server/internal/social/tenantpublishing/provider.go`, `refresh.go`; `server/internal/social/integrations/base.go`.

**External facts**

| Fact | Status | Source |
|---|---|---|
| R2 multipart parts must be at least 5 MiB and, except the last, equal in size | Confirmed | [Cloudflare R2 multipart documentation](https://developers.cloudflare.com/r2/objects/multipart-objects) |
| Apple's long-form on-device speech API (SpeechAnalyzer, SpeechTranscriber) requires iOS 26 | Reported consistently by secondary sources; locale list not confirmed | [Apple SpeechTranscriber reference](https://developer.apple.com/documentation/speech/speechtranscriber.md), [Callstack overview](https://www.callstack.com/blog/on-device-speech-transcription-with-apple-speechanalyzer) |
| The older recognizer's one-minute limit | Not confirmed from an Apple source | Moot if decision 4 sets iOS 26 as the minimum |
| An app offering third-party sign-in must offer another sign-in with stated privacy features; Shots offers Google and GitHub and has no Apple sign-in configured | Confirmed in substance; Google and GitHub confirmed in `clients/apps/web/lib/auth/server.ts` | [Apple guideline update](https://developer.apple.com/news/?id=7j1f99yf), [Expo authentication guide](https://docs.expo.dev/develop/authentication.md) |
| Apps that create accounts must offer in-app account deletion | Confirmed | [Apple: offering account deletion](https://developer.apple.com/support/offering-account-deletion-in-your-app) |
| Rules on linking to web purchase from the app | Not confirmed | Check the current guideline text before submission; A2 avoids the question by having no purchase screens |
| Better Auth has an Expo integration that stores the session in the device's secure store and accepts a native Apple ID token | Confirmed for version 1.6, which the repo uses. A reported issue with secure-store key names should be checked at Gate 0 | [Better Auth Expo integration, v1.6](https://better-auth.com/docs/1.6/integrations/expo), [issue 5426](https://github.com/better-auth/better-auth/issues/5426) |
| Cloudflare Browser Run allows 120 browsers at once and one new browser a second on paid accounts (raised in April 2026) | Confirmed from the vendor's documentation; the REST request limit was not found | [Browser Run limits](https://developers.cloudflare.com/browser-run/limits/index.md), [changelog](https://developers.cloudflare.com/changelog/post/2026-04-15-br-rename/index.md) |
| Prices of cheaper OpenRouter models | Third-party trackers only | Not relied on; the plan uses the model already configured |

**Not done**

- No code was written and no test was run.
- The JSON Schema and OpenAPI files v0.1 refers to were not available. The PDF's text extraction scrambles token order inside the SQL, so column-level findings in Appendix A are limited to those that are unambiguous.
- The existing session behaviour was read (sessions are checked against the database on every request, so a removed member loses access immediately), but a mobile session has not been tried.

---

## Appendix A. Defects in the v0.1 reference design

Recorded so they are not carried forward if any of v0.1 is reused.

**Schema and policies**

1. Forced row-level security on every table with `workspace_id` blocks every cross-workspace reader: the outbox relay (`outbox_pending` index scans all workspaces), the publication scheduler (`publications_due`), the retention sweeper, and webhook handling, which must look up an installation before it knows the workspace.
2. `UNIQUE (provider, provider_installation_id)` allows one workspace per installation. The product lets one GitHub installation serve several workspaces. It also blocks reconnecting after a revoke and blocks the same social account in two workspaces.
3. `evidence.attempt_id` is `NOT NULL` and `artifacts.kind` has no manual-upload value, so a manual screenshot cannot become evidence, although §2, §8 and §12 say it does.
4. §4 says workers may write only "the relevant attempt prefix"; §12 defines keys as `workspaces/{id}/artifacts/{id}/…` with no attempt in the path. `artifacts` also has no link to the attempt that created it, so the sweeper cannot tell whose pending object it is.
5. §12 lists storage state, processing state and encryption key reference as tracked metadata; the table has none of them. §13 says approvals record a permission snapshot reference; the table has no such column.
6. Insert-only revision tables with `NOT NULL` text have no redaction marker, so the privacy purge in §15 cannot run without breaking the immutability rule in Appendix A of the PDF.
7. `approvals.actor_id` and `voice_notes.owner_id` reference `memberships`, so an API key or agent cannot be an actor, and a member row can never be removed.
8. Approvals are append-only with `approved`, `rejected` and `revoked`, and a publication points at one approval row. Nothing says which decision governs when several exist, or invalidates a publication when a later revoke is appended.
9. The approval hash includes the destination but §13 allows rescheduling "within an already approved scheduling policy", which is not modelled anywhere.
10. `publications.provider_post_id` is a single value; threads and carousels produce several, and partial success has no representation.
11. `outbox_events` has no attempt count, error or dead-letter marker, and neither it nor `consumer_receipts` has a retention rule.
12. `idempotency_records` has a `pending` state with no rule for a request that dies while pending.
13. Client-generated transcript revision IDs are primary keys shared across the workspace, so one client can collide with another member's ID.
14. Approval hashes over canonical JSON include editor recipes with floating-point coordinates; float serialization across Go, TypeScript and Swift is a known source of hash mismatches.

**State machines**

15. Release run: no terminal state for "nothing to capture", no `processing → failed`, no state for a run blocked on sign-in, no timeout on `awaiting_plan_review`, and no identity recheck after a long review.
16. Capture task: the result transaction requires state `processing` with a live lease, but the lease belongs to the browser worker and processing is done by the media worker; nothing owns the lease in between.
17. Publication: the diagram and the table disagree (`failed` is only in the table); `needs_reconciliation` and `unknown` have no exit to "confirmed not sent"; `scheduled → invalidated` is missing; there is no late-window rule.
18. Mobile: one enum for recording and sync; no `start_failed`; no path from `sync_failed`, `interrupted` or `syncing` to `deleted`.

**Mobile and sync**

19. `recording_segments` maps 10–30-second segments (roughly 80–240 KB at 64 kbit/s) to multipart part numbers. R2 parts have a 5 MiB minimum, so the upload fails; and concatenated `.m4a` files are not a valid `.m4a`.
20. A whole three-minute note is about 1.4 MB, so multipart and resumable upload solve a problem typical notes do not have.
21. `.m4a` segments lose the active segment entirely on a crash, up to 30 seconds, while §3 requires audio to be saved "as recording proceeds".
22. The manifest has one `sample_rate_hz` for the note; a route change mid-recording changes it.
23. "Protected application storage" plus background recording is contradictory at the strictest protection class.
24. Notes sync through a per-workspace feed, but who may read a note is never stated.
25. The workspace row lock serializes every synced write in a workspace to solve a cursor problem that a list comparison avoids.
26. Operations replayed after their idempotency record expires return a conflict for a change the client already made.
27. Consent covers audio upload and remote transcription but not sending transcript text to a model for draft generation.

**Operations**

28. The deletion ledger is stored in the database being restored, so deletions after the restore point are lost with it.
29. Restoring the database leaves Temporal histories ahead of it; a published post the database no longer records can be sent again. §16 does not address this.
30. Stable workflow IDs do not prevent a second run after the first completes unless the reuse policy rejects duplicates, and not at all after namespace retention expires.
31. §7 requires DNS-rebinding protection "on the actual connection path", which Shots does not control on a managed browser.
32. Availability, recovery-time and release-latency targets are mutually inconsistent (section 7).

**Arithmetic checked and correct:** 4,800 tasks a day, 432,000 browser-seconds, 120 browser-hours, average concurrency 5; 1.44 GB a day and 43.2 GB a month of audio.
