# Voice capture and evidence: implementation plan

**Implements:** [the audited voice capture and evidence plan](voice-capture-and-evidence-plan.md) (v0.3), "the plan" below.
**Delivery:** the server, web, the Founder Hub voice routes and fixes F1–F9 in one pull request into `develop` (PlaybookMediaLLC/shots#500); the Founder Hub auth it builds on (PlaybookMediaLLC/shots#499) is merged. The phone is the existing Founder Hub app (PlaybookMediaLLC/shots-founder-hub), so its part is a pull request in that repository, on its `develop` after its Shots sign-in pull request (#3) merged. A pull request cannot span two repositories.
**Execution:** a foundation commit, then up to 9 implementation subagents in parallel, then one integration and verification pass, then a review wave. At most 10 agents run at once.

---

## 1. What this pull request builds

| Plan section | Built here | Not built here, and why |
|---|---|---|
| 5.1 Mobile recording | In the Founder Hub app, which already records crash-safe WAV per session with recovery: "Send to Shots" sync, Apple on-device transcription (a small Swift module), the confirmation card and settings | Gate 0 and Gate 1 device tests and App Store submission need physical iPhones; they are owner follow-ups. The Swift code cannot be compiled in this Linux environment |
| 5.2 Server voice domain and sync | Ent tables, idempotent operations, signed whole-run upload with server checks, list-comparison sync, web voice inbox | Remote transcription (decision 2: none at launch) |
| 5.3 Voice to draft | Endpoint, consent, claim marking, draft source link | — |
| 5.4 Voice commands | Inline parse, plain-code checks, proposal, confirm through `ScheduleContentDraft`, sweep for retries and expiry | Push notifications (K23): no APNs setup exists; the phone fetches proposals on sync. Hands-free scheduling (decision 8: no) |
| 5.5–5.7 Capture hardening, staying signed in, capture at scale | — | Conditional on RFC 007's trigger and owner decisions 12–14 (plan section 8, Gates 4–5) |
| 6.4, 6.5 and 7a Fixes F1–F9 | All nine, each with its regression test. F1 step 4: a scheduled draft post carries the stored draft's text. The draft schedule route takes no text: the web server builds every caption, reply, poll and follow-up from the stored draft with the composer's serializer, and Go schedules only the version it finds current (a version only grows), checks its approval, and admits only the web server. The last caller-supplied text, a legacy per-account `options` field (an auto-reply and quote text that replaced the draft's, and a poll when the draft had none), is removed. `CreatePost` and voice confirm build their draft from the text they schedule. Test: `test/content-draft-schedule.server.ts` | A Go serializer or a caption snapshot taken at approval: the web serializer stays the one source, and a snapshot would not match once an account's standing, the chosen accounts or the rendered table images change. Table and math blocks still post as images the browser renders and uploads; Go checks they are the workspace's uploads, not that they show the approved table. F8's staging drill needs staging; the runbook and code ship, the drill is an owner follow-up |
| 6.9 Rollout | Per-workspace settings, all off; server-side switches; minimum app version | Measurement dashboards: counters are logged as structured events, no new dashboard |

## 2. Owner decisions taken as the plan recommends

Asking for this implementation is taken as owner decision 1. The other decisions take the plan's recommendation and are recorded in the [RFC index](../rfcs/README.md) as a scoped authorization dated 2026-11-11. The owner confirms or changes them in review of this pull request.

| # | Decision | Taken |
|---|---|---|
| 1 | Authorize voice capture | Yes, scoped. Outcome metric: weekly active recorders in pilot workspaces, and drafts or scheduled posts made from voice notes |
| 2 | Remote transcription | None at launch |
| 3 | Audio upload default | Off; transcript-only sync by default |
| 4 | Oldest iOS | iOS 26 (the long-form on-device speech API); the older recognizer is the fallback when a locale lacks it |
| 5 | Maximum note length | 30 minutes, warning at 25 |
| 6 | A removed member's notes | Deleted after 30 days |
| 7 | Sign in with Apple | Not changed here: the phone signs in through Shots as an OAuth provider (shots#499, shots-founder-hub#3), and Apple sign-in belongs to that work. Nothing in this pull request changes sign-in (decision 12 in the plan) |
| 8 | Hands-free scheduling | No |
| 9 | Removed approver's approvals | Stand; the approver is recorded on the post (F7) |
| 10 | Self-approval | Per-workspace setting, default allowed (F7) |
| 11 | Downgrade with scheduled posts | Not changed here (no code in this plan depends on it) |
| 12–14 | Capture retention, one session per deployment, captures per workspace | Not taken: their work is conditional |

**Choices made in this plan** (each is the smallest option that meets the plan):

- **Audio format: PCM WAV (`audio/wav`) only**, what the Founder Hub recorder already writes, with its existing crash recovery. Browsers play it without server conversion.
- **Audio is not stored as `asset` rows.** Assets have no owner and appear in the workspace library; voice audio is private. `voice_audio_run` keeps its own object key under a `voice/` prefix and reuses the media store's signing (`internal/media`).
- **The audio check runs in the upload-complete request**, as `CompleteAssetUpload` already verifies asset bytes in its request. The plan's Temporal activity is a later upgrade if notes grow (`shortcut:` comment in the code).
- **The minimum app version is enforced by the app** from the settings response before each sync (S17). Recording never depends on it.
- **Voice routes are session-only.** An API key carries no member identity, and notes are private to a member.

## 3. Foundation commit (done before fan-out)

So that parallel work compiles against one base:

- `server/ent/schema/voice.go`, `voice_command.go`: `voice_note`, `voice_transcript_revision`, `voice_audio_run`, `voice_settings`, `voice_member_settings`, `voice_command`; `content_draft.sourceVoiceRevisionId`.
- `server/platformmigrations/sql/20261111090000_voice_capture.sql`, with `make generate` output.
- `server/internal/product/voice.go`: view types, `ownedVoiceNote` (the only way to load a note), `voiceSettings`, server-side switches.
- `server/internal/product/voice_commands.go`: `VoiceCommand` view type; stubs `proposeVoiceCommand` and `voiceCommandFor`.
- `server/internal/httpapi/voice.go`, `voice_commands.go`: empty `VoiceStore` and `VoiceCommandStore` interfaces and route registration, already wired into `server.go`.
- This document and the RFC index entry.

## 4. Voice API contract

The Go product API serves `/v1/voice/...` behind `authenticateProduct`. The web serves the same paths under `/api/v1/voice/...` with session authentication only, adapting each onto the SDK. The phone calls the web paths with its Better Auth session. JSON is camelCase; times are RFC 3339.

**Status codes.** 400 invalid input. 403 not allowed: an API key, a feature or switch off, consent missing. 404 not found, including another member's note (never 403, so a note's existence does not leak). 409 conflict: the note is deleted (create, transcript, patch, upload), or a run index was already uploaded with a different checksum. Errors use the existing `userError` helpers and `platform-errors.ts`.

**Shapes.** `VoiceNote`, `VoiceNoteDetail`, `VoiceTranscriptRevision`, `VoiceAudioRun`, `VoiceCommand` are the Go structs in `internal/product/voice.go` and `voice_commands.go`, field for field.

| # | Method and path | Body | Returns | Rules |
|---|---|---|---|---|
| 1 | `GET /v1/voice/settings` | — | `{ workspace: VoiceWorkspaceFlags, member: VoiceMemberChoices, canManage, minAppVersion, limits: { maxNoteMs, warnAtMs, minNoteMs, maxTranscriptChars, maxCommandChars }, switches: { notes, audioUpload, drafts, parse, confirm } }` | Any member (session). `switches` is true when a feature is available server-side |
| 2 | `PUT /v1/voice/settings/workspace` | partial `VoiceWorkspaceFlags` | as 1 | Owner or admin. Audit log entry |
| 3 | `PUT /v1/voice/settings/member` | `{ remoteTextConsent?: boolean, voiceCommands?: boolean }` | as 1 | `voiceCommands: true` requires consent; withdrawing consent turns commands off |
| 4 | `GET /v1/voice/notes/index` | — | `{ notes: [{ id, clientNoteId, revision, deleted }] }` | The owner's notes in this workspace, tombstones included (sync list comparison) |
| 5 | `GET /v1/voice/notes?limit=&cursor=` | — | `{ notes: (VoiceNote & { excerpt: string })[], nextCursor }` | Inbox: the owner's live notes, newest by `receivedAt` |
| 6 | `POST /v1/voice/notes` | `{ clientNoteId, title?, projectId?, recordedAt, recordedTimeZone, locale?, durationMs?, audioUploadConsent? }` | `VoiceNoteDetail` (201 new, 200 replay) | Idempotent on `clientNoteId`; a replay with different content returns the stored note. A tombstone returns 409 (S7) |
| 7 | `GET /v1/voice/notes/{id}` | — | `VoiceNoteDetail` | Owner only |
| 8 | `PATCH /v1/voice/notes/{id}` | `{ expectedRevision, title?, projectId? }` | `VoiceNoteDetail` | Labels: last writer wins. A replay whose values already match changes nothing |
| 9 | `DELETE /v1/voice/notes/{id}` | — | 204 | Always succeeds for the owner, including replays. Purges audio objects, redacts transcripts, keeps the tombstone, bumps the revision, withdraws a pending command |
| 10 | `POST /v1/voice/notes/{id}/transcripts` | `{ clientRevisionId, parentId?, origin, locale?, engine?, text, segments }` | `{ revision, note, command }` | Idempotent on `clientRevisionId`. Never overwrites. Current revision rule: a `user_edit` becomes current; `on_device` becomes current only when nothing is; `remote` never replaces a user edit (S9). Two revisions with the same parent set `transcriptConflict` (S6). When the workspace and member have commands on, parses inline with a 5-second bound and returns the proposal |
| 11 | `POST /v1/voice/notes/{id}/transcripts/{revisionId}/redact` | — | `VoiceTranscriptRevision` | Clears text and segments, sets `redactedAt`; audit log entry (D1) |
| 12 | `POST /v1/voice/notes/{id}/runs/{runIndex}/upload` | `{ contentType, bytes, sha256, startOffsetMs, durationMs?, sampleRateHz? }` | `{ url, method: "PUT", headers, expiresAt }` | Needs workspace audio upload, the note's consent and the switch. Length and checksum are signed into the URL (S5). A new URL for the same run on expiry (S3). 409 when the index exists with a different checksum |
| 13 | `POST /v1/voice/notes/{id}/runs/{runIndex}/complete` | — | `VoiceAudioRun` | Reads the object: size, SHA-256, valid PCM WAV audio, decoded duration and sample rate. Only then `available` (S4, S19). A missing or bad object answers 400 and the phone resends |
| 14 | `GET /v1/voice/notes/{id}/runs/{runIndex}/audio` | — | `{ url, expiresAt }` | Signed read of an available run, owner only |
| 15 | `DELETE /v1/voice/notes/{id}/audio` | — | 204 | Purges every run's object; rows become `deleted`; transcripts stay (D1) |
| 16 | `POST /v1/voice/notes/{id}/draft` | `{ transcriptRevisionId, intent, assetIds? }` | `{ contentDraftId }` | `intent`: `launch_post`, `documentation_outline`, `onboarding_explanation`, `saved_idea`. Needs draft generation, the member's consent (V6), draft write permission and quota (S18). The draft records `sourceVoiceRevisionId`; unbacked statements are marked as the speaker's claim (V2); numbers and names are listed for review (V3) |
| 17 | `POST /v1/voice/notes/{id}/command/confirm` | `{ text, channelConnectionId, localTime, timeZone }` | `{ command, outcome: "scheduled" \| "pending_approval" \| "draft", contentDraftId, scheduledPostId }` | Re-runs every check. Creates a draft from the confirmed text and schedules it through `ScheduleContentDraft` as the member. Idempotent on the note (K11). Audit log entry with the note as source |

## 5. Mobile contract

The phone app is Founder Hub, an Anarlog-based Expo app with a Rust gateway. Its Shots sign-in comes from PlaybookMediaLLC/shots-founder-hub#3 and PlaybookMediaLLC/shots#499: Shots is the OAuth provider, and the app holds a Shots access token.

- **Path.** The phone calls `<apiUrl>/cloud/voice/<suffix>`, where `<suffix>` is the section-4 path after `/v1/voice/`. It sends `Authorization: Bearer <token>` and `X-Shots-Organization-Id`. The Founder Hub gateway forwards to Shots `/api/founder-hub/voice/<suffix>` with its service credential. Shots verifies the token, builds the member actor for that workspace, and runs the same handlers as `/api/v1/voice`. Audio bytes go straight to the signed storage URL, never through the gateway.
- **Recording** stays on Founder Hub's existing session recorder (WAV per session, recovery). No second recorder.
- **Transcription** for notes sent to Shots is Apple's on-device speech API by default (decision 10). The app's cloud providers stay a named, disclosed opt-in.
- **Sync state** is app-local and outside the canonical SQLite schema, which Founder Hub shares with its desktop app.

## 6. Workstreams

Each agent owns the files listed; no two agents edit the same file. Go agents work in their own git worktree on a branch cut from the foundation commit; the web agent works in the main checkout, where `node_modules` is installed. New migrations use the timestamp assigned below so their order is fixed.

| Agent | Scope | Owns | Plan cases |
|---|---|---|---|
| **A1 voice-core** (Go) | Voice notes domain, sync, upload and verification, deletion, settings, sweeps | `internal/product/voice.go`, `voice_notes.go`, `voice_sync.go`, `voice_audio.go`, `voice_settings.go`, their tests; `internal/httpapi/voice.go`; `ent/schema/voice.go`; maintenance sweep for unverified uploads and removed members; account deletion extension. Migration slot `20261111095000` | 5.2; S1–S19 server side; D1, D2, D5–D7 |
| **A2 voice-commands** (Go) | Voice to draft and voice commands | `internal/product/voice_commands.go`, `voice_drafts.go`, `voice_command_checks.go`, their tests; `internal/httpapi/voice_commands.go`; `ent/schema/voice_command.go`; maintenance sweep for waiting parses and expiry. Slot `20261111096000` | 5.3, 5.4; V1–V6; K1–K25 server side |
| **A3 web** (TypeScript) | Web contracts, routes, SDK, voice inbox, voice settings, OpenAPI regeneration | `clients/apps/web/lib/api/contracts/voice*.ts`, `app/api/v1/voice/**`, SDK voice methods, the inbox and settings screens, generated API files, tests | 5.2 inbox; 5.3 consent UI; 6.9 settings |
| **M1 phone** (Founder Hub, TypeScript) | "Send to Shots" sync, confirmation card, Shots voice settings | `apps/mobile/src/` Shots voice feature | 5.1, 5.2 client, 5.4 card; S1–S19 client side; K-cases on the card |
| **M2 on-device speech** (Founder Hub, Swift) | Apple on-device transcription of saved recordings | `apps/mobile/modules/on-device-speech/`, `apps/mobile/src/data/on-device-transcription.ts` | 5.1 Transcription; R15, R16 |
| **M3 gateway** (Founder Hub, Rust) | `/cloud/voice/*` proxy to Shots | `apps/api/src/shots.rs`, `crates/api-auth` | Section 5 path |
| **M4 Founder Hub routes** (Shots, in #500 after #499 merged) | `/api/founder-hub/voice/*` with Founder Hub token auth | `clients/apps/web/app/api/founder-hub/voice/**` | Section 5 path |
| **A6 approval** (Go) | F1, F7 | `internal/product/scheduled_posts.go`, `content_draft_schedule.go`, `content_draft_platform.go` (approval), `scheduledpost` and `content_draft_settings` schemas. Slot `20261111091000` | P0, P3, P4 |
| **A7 provider** (Go) | F2, F5, F9 analytics token refresh | `internal/social/integrations/base.go` and provider error tables, publication outcome mapping, `internal/platformai`, `internal/social/tenantpublishing/refresh.go` and the analytics refresh path | P11, 5.4 prerequisite, P7 |
| **A8 release-capture** (Go) | F3, F4, F9 environment check, capture lock, suspension, repository transfer | `internal/product/github_events.go`, `github_installations.go`, `capture_jobs.go`, `release_automation_*.go`, `internal/releaseautomation`, `internal/temporalcapture`, deployment and capture schemas. Slot `20261111092000` | C3, C4, C5, C6, C9, C11 |
| **A9 ops** (Go and docs) | F6, F8, F9 outbox retention | GitHub webhook verification, the publishing pause in the publishing activity, the deletion ledger in the outbox deletion handler, `internal/maintenance/outbox.go`, the restore runbook in `docs/deployment.md`. Slot `20261111093000` | C7, C14, D3, D4, P14 |
| **A10 e2e** (after merge) | Whole-stack checks | `make tenant-isolation` extended to voice notes; a Playwright flow for the voice inbox | Gate 2 exit |

Shared rules for every agent: read `AGENTS.md`, the nearest `AGENTS.md` and its guide first; reuse before writing; no edits outside the owned files (ask the parent instead); no edits to `server/README.md` or other shared docs (report environment variables and doc changes in the handoff); run the checks for the owned area; commit on the agent's own branch; end with the handoff format in `AGENTS.md`.

## 7. Integration

1. Merge the branches in this order: A6, A7, A9, A8, A1, A2; A3 is already on the branch. The Founder Hub branches (M1–M3) merge into their own pull request.
2. Conflicts in generated Ent code are resolved by taking either side and re-running `make generate`. Conflicts in schema or domain files are resolved by hand.
3. Rebuild the test database from all migrations; run `make -C server check` with the integration databases set.
4. `npm run api:generate` once more if any Go-facing contract moved; `npm run quality:check` in `clients/`; the mobile app's typecheck and tests; `python3 dev/verify-rfcs.py`.
5. A10 runs the whole-stack checks it can start in this environment; anything that cannot run here is reported, not claimed.
6. Update `server/README.md` (voice routes and environment variables), the plan's status line, and `docs/rfcs/README.md` if review changes a decision.

## 8. Review

After verification, five reviewers run in parallel on the full diff, as `AGENTS.md` requires: structure, perf, chaos, qa, lean. Two specialists are added: an iOS and Swift reviewer (the native code is not compiled here) and a tenancy and privacy reviewer for voice notes. Confirmed blockers are fixed and checks re-run before the pull request is marked ready.

## 9. Owner follow-ups that cannot happen in this environment

- Gate 0 (a): kill Founder Hub mid-recording on a real iPhone; confirm the recovered WAV plays to within about one second.
- Gate 0 (b): Founder Hub sign-in through Shots end to end on a device (shots-founder-hub#3 and shots#499).
- On-device transcription on iOS 26 and on the fallback recognizer.
- Gate 1: R1–R18 on physical devices, including one on iOS 26.0.
- F8 drill on staging before voice launch.
- Re-run `./dev/social-gate` before release (F1 and F2 change publishing internals).
- App Store submission items A1–A5.
