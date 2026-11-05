# Write scheduling and composer: audit and implementation prompt

Audited 2026-11-02 on `develop` at
`2d83b4b749aea24bc9698522b42a0dcb1cf84ea6`.
The user confirmed that **editor means the Write/post composer**.
This deliverable is a source audit and an implementation prompt. It does not
certify the running product or a social provider.

## What already exists

Paths in this section are relative to the repository root.

| Capability | Current owner and evidence | Implication for the session |
| --- | --- | --- |
| Writing and editing | `clients/apps/web/components/write/composer/WriteComposer.tsx`, `useDraftDocument.ts`, `components/drafts/DraftEditor.tsx`, `clients/packages/platejs-editor` | Preserve rich text, threads, platform versions, media, previews, autosave, review, collaboration, backups, focus mode and mobile panels. Extend the existing composer. |
| Weekly posting schedule | `clients/apps/web/components/settings/social-sets/SchedulingPage.tsx`, `components/write/PostingTimes.tsx` | Social sets already own weekly slots and an IANA time zone. A recurring posting schedule is different from automatically repeating a post or generating recurring campaigns. |
| Review and scheduling | `clients/apps/web/components/write/composer/schedule.tsx` | Explicit time, next queue slot, natural timing, approval/account checks, replaced-destination disclosure and save-before-submit already exist. |
| Calendar and bulk operations | `clients/apps/web/components/plan/PlanWorkspace.tsx`, `components/write/bulk-schedule.tsx` | Planned drafts, scheduled posts, move/swap, undo and bulk scheduling already exist. Keep their meaning and results consistent with the composer. |
| Transport and validation | `clients/apps/web/lib/api/contracts/content-drafts.ts`, `lib/tenant/content-drafts.ts`, `lib/backend/sdk.ts` | The web builds publication payloads from the stored draft through the shared publication model and calls the Go SDK. It does not own the database. |
| Schedule persistence | `server/internal/product/content_draft_schedule.go` | The backend validates authority, versions, approval and targets; serializes concurrent schedules; checks the reviewed queue slot; creates destination-specific posts, revisions and audit/event records. |
| Durable delivery | `server/internal/temporalpublishing/workflow_v2.go`, `activities.go`, `recovery.go`; `server/internal/publishing`; `server/internal/social/tenantpublishing` | Timers, classified retries, uncertain delivery, receipts and recovery already have owners. Keep the canonical product post and existing Temporal workflows. |

The [reliability audit](reliability.md) records fixes for queue races, timing
intent, duplicate submissions, timezone storage, misleading states, approval
withdrawal, late publication and recovery. Current source contains the relevant
queue-slot, schedule-intent, transaction-lock and workflow safeguards. These are
regression obligations, not a list of features to build again.

## Findings that change the prompt

1. **Scheduling needs stronger placement in the composer.** In
   `WriteComposer.tsx`, Schedule is an outline button and is hidden below the
   `sm` breakpoint; mobile users find it in More draft actions. Publish remains
   visible and opens a review. For this goal, make scheduling easy to find on
   desktop and mobile while keeping immediate publication an explicit action.
2. **Draft conflict recovery needs examination.** In `useDraftDocument.ts`, a
   non-collaborative 409 reloads the latest server document and clears the
   pending local document. A toast says the last edit was not saved. Pending
   edits otherwise live in a module-level Map, which survives client navigation
   but not a full reload. This is a source-level risk to local work, not a
   browser-reproduced failure in this audit. Require a reproducer and a recovery
   path that preserves unsaved text without overwriting another person's work.
3. **Planning and publishing must remain visibly different.** A planned draft
   does not publish. Scheduling creates one immutable queued commitment per
   destination. Later editing does not silently replace that approved snapshot;
   rescheduling is explicit. Calendar moves affect one destination, while
   calendar unschedule can cancel all queued destinations of the draft. The
   current UI includes scope disclosures; preserve them during polish.
4. **Existing evidence does not establish current live delivery.**
   `typefully-calendar.spec.ts` seeds a published result for part of its UI
   coverage. `TestSchedulingThroughTemporal` requires both database and Temporal
   settings; `.github/workflows/ci.yml` supplies the database setting but not
   `PUBLISHING_TEST_TEMPORAL_ADDRESS`. The separate social gate covers a real
   stack with a fake destination. None alone proves a current social-network
   post. The [provider record](../social-publishing-verification.md) is historical
   and still lists required canaries; recheck live state before making claims.
5. **Visual quality needs rendered evidence.** The composer already has a sticky
   header, responsive panels, compact and focus modes, status labels and shared
   controls. This audit inspected their source, not a current rendered session.
   Judge spacing, density, contrast, overflow and focus behavior in the running
   app. The Write coverage matrix explicitly leaves nested-dialog focus without
   an automated test; recheck current coverage before treating that gap as open.

## Copy-ready implementation prompt

> Improve the existing Shots Write/post composer and scheduling journey. By the
> end of this session, a workspace member with publishing permission must be able
> to create and edit a post, choose its destinations, schedule it for an explicit
> time or the next slot in the brand's weekly posting schedule, see the saved
> commitment in the calendar, and receive a truthful delivery result. The Write
> composer must feel clean, polished and modern, with a calm writing area and
> clear, accessible actions on desktop and mobile.
>
> Work through implementation and verification. Start from the current code,
> identify the actual gaps, then fix them. Existing features and old green tests
> are starting evidence, not proof that this session's outcome is complete.
>
> **Scope and reuse**
>
> Follow the root and web AGENTS.md, feature-flow and the repository's reuse
> rules. Read `docs/scheduling/reliability.md`, the Write and Plan implementation
> matrices, `docs/media-scheduling.md`, `docs/social-publishing-verification.md`,
> `server/README.md` and the active RFC index. Revalidate historical claims.
> Name the owner and callers before changing shared behavior. Use the code graph
> when available and focused source inspection otherwise.
>
> Extend WriteComposer, useDraftDocument, ScheduleDialog/PublishReview,
> SchedulingPage, PlanWorkspace and the existing publication/status helpers.
> Preserve the Plate editor package boundary, shared UI primitives, Zod
> contracts, backend SDK, Go/Ent domain and canonical Temporal publishing path.
> Keep registered workflow versions replayable. The screenshot/design editor,
> new providers, analytics expansion, recurring content generation and automatic
> reposting are outside this task. A weekly queue uses the existing social-set
> posting slots; it does not require a second scheduler.
>
> **First establish the baseline**
>
> Trace create/edit → save → destination preview → review → schedule commit →
> Temporal timer → provider attempt → persisted receipt → calendar/editor state.
> Reproduce reported or suspected failures before changing their behavior.
> Inspect the rendered composer, schedule dialog, posting-time settings and
> calendar in light and dark modes at desktop, tablet and phone widths. Keep
> before/after evidence. Prioritize lost work, wrong destinations/times,
> duplicates and false success before visual refinement.
>
> **Reliable scheduling**
>
> - Configure weekly slots and an IANA time zone, persist them, and use them
>   consistently in queue preview, confirmation, storage and calendar display.
> - Support an explicit date/time and the backend's next free slot. Show the
>   date, time, zone and UTC offset before confirmation. Keep natural timing
>   optional and disclose the actual committed instant and its queue slot.
> - Reject past or nonexistent local times. Require a clear choice for a
>   repeated daylight-saving hour. A display-zone change must not move a post.
> - Flush the latest edits before review is committed. Validate destinations,
>   account health, text/media capabilities, quota, permissions and required
>   approval on the server. Show actionable reasons without losing the draft.
> - Preserve concurrent-submit idempotency and schedule-intent checks. A taken
>   queue slot must trigger a new review, never a silent change of time.
> - Make Plan, Schedule, Add to queue, Reschedule and Publish now unambiguous.
>   Planning alone never sends content. Name every existing destination a
>   reschedule will replace or cancel. Keep later edits separate from queued
>   approved snapshots until the user explicitly replaces them.
> - Make reload, calendar move/swap/undo, per-destination cancel and bulk results
>   reflect the persisted commitment. Keep partial successes and failures
>   separate; retries must not duplicate already scheduled or published posts.
> - Preserve Draft, Planned, Scheduled, Overdue, Publishing, Published, Failed,
>   Needs check and Cancelled distinctions. Published requires a confirmed
>   provider receipt. UNKNOWN_DELIVERY must require reconciliation before a
>   retry; never retry an ambiguous provider mutation automatically.
> - Verify recovery after a saved schedule's workflow wakeup fails, worker
>   interruption and receipt-write failure. Recheck approval, connection and
>   media eligibility at send time. Preserve the one-hour missed-window policy
>   and show a useful reason when nothing is sent.
>
> **Composer polish and editing safety**
>
> - Give the writing area the strongest visual focus. Use consistent typography,
>   spacing, alignment, borders and existing theme tokens. Reduce header/tool
>   clutter with the existing panels and menus; keep essential actions obvious.
> - Make Schedule/Add to queue easy to find at every supported width. Keep the
>   selected brand/accounts, save state and scheduling state clear. Immediate
>   publication must remain explicit and reviewed.
> - Keep advanced post options available without competing with normal writing.
>   Preserve rich text, threads, media ordering/alt text, platform-specific
>   versions, previews, collaboration, comments, approvals and backups.
> - Show editing, saving, saved, offline and failed-save states truthfully. A
>   save conflict must not discard local work without a usable recovery path.
>   Test fast navigation, failed save, reconnect and another user's update;
>   block scheduling when the latest content has not saved.
> - Check caret/focus stability, paste, undo/redo, keyboard shortcuts and nested
>   dialogs. Ensure keyboard access, visible focus, accessible names, adequate
>   contrast and touch targets. Verify focus restoration and reduced motion.
> - Verify 1440px, 1024px and 390px layouts: no page-level horizontal overflow,
>   clipped controls, unreachable confirmation buttons or panels that make the
>   writing column unusable. Include empty, loading, validation, permission and
>   network-error states in the visual review.
>
> **Proof and completion**
>
> Extend the existing autosave, publication, timezone, calendar and preview unit
> tests; Go scheduling/recovery/Temporal tests; and authenticated Write/Plan
> browser journeys. Assert persisted outcomes and provider-call counts where
> duplication is possible. Do not mock authentication, authorization, tenancy or
> database constraints. Use an isolated environment and approved test content.
>
> Run `npm run quality:check` from `clients/` for client changes and
> `make -C server check` for Go changes. Regenerate contracts/clients or Ent and
> migrations when their sources change. Run applicable `make e2e`,
> `make tenant-isolation` and `./dev/social-gate` checks. Run the real
> `TestSchedulingThroughTemporal` integration with its required services; a
> skipped test is not a pass. Follow feature-flow's final review and fix verified
> blocking findings.
>
> Demonstrate the primary journey through the UI: create a draft, attach
> supported media, select destinations, save, schedule an explicit time, reload
> the calendar, reschedule/cancel, then schedule another draft into the next
> weekly slot. Verify an actual elapsed timer and a persisted delivery receipt
> in the controlled full stack. Show that a competing slot request, failed save,
> withdrawn approval and uncertain delivery produce safe, understandable states.
>
> Keep four evidence levels separate: source implementation, automated tests,
> browser behavior and live-provider delivery. A fake provider or seeded
> Published row proves only its covered boundary. If live posting is authorized
> to a named test account, record the scheduled instant, actual send time,
> canonical post/attempt IDs, remote ID/URL and visible content, with no duplicate.
> Otherwise prepare that exact canary for approval and report live verification
> as outstanding. Do not claim elapsed 24-hour media validity from a fast-forwarded
> clock or move a future timestamp to simulate that proof.
>
> Finish with the user-visible result, reused/new/affected code, before/after UI
> evidence, exact check results and skips, and any remaining environment or
> provider blocker. Separate local completion from deployment and live delivery.
> Do not commit, push, deploy or post externally without the relevant authorization.

## Verification of this audit

- The working tree was clean before this documentation-only addition.
- Source, callers, contracts, tests and relevant CI configuration were inspected.
  Code-graph tools were unavailable.
- The web baseline command targeted `write-zoned-time`, `write-calendar`,
  `write-autosave`, `write-publication`, `write-preview` and `workspace-schedule`.
  It could not start: npm selected Homebrew Node 26, which failed with
  `Library not loaded: /opt/homebrew/opt/simdutf/lib/libsimdutf.36.dylib` (exit 134).
  A Node 22 PATH override still reached the same failing runtime. This checkout
  also has no workspace `node_modules/.bin/tsx`. No web test pass is claimed.
- `PUBLISHING_TEST_DATABASE_URL` and `PUBLISHING_TEST_TEMPORAL_ADDRESS` are unset.
  No database/Temporal-service integration pass is claimed.
- `go test ./internal/temporalpublishing -count=1` passed from `server/`
  (`ok`, package execution 0.216s). The service-dependent integration tests
  skip when those settings are absent; this is local workflow/unit evidence.
- Current rendered UI, full quality checks, browser journeys, social gate,
  deployment and live-provider delivery have not been verified by this audit.
  Historical screenshots and results were not counted as current proof.
- Feature-flow's documentation-only exception applies: its structure,
  performance, failure-mode, QA and minimal-scope lenses are applied directly
  to this brief, without spawning a review team. No blocking brief issues remain.
  The relative documentation links and whitespace were checked. Only this brief
  was added; application code was not changed.
