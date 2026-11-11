# Platform follow-up fixes — 2026-11-09

Implemented against `329d163014fc2ef59c1dd9121fff014543764985` on
`fix/platform-follow-up-audit`.

| Finding | Repair |
| --- | --- |
| PLAT-01 | Review rejection cancels queued posts in the review transaction, preserving a cancellation reason. Review and scheduling share the existing scheduling advisory lock. A worker that already claimed a post causes a conflict rather than a false stop confirmation. Requesting review or approving later content cannot revive a cancelled snapshot. |
| PLAT-02 | Review requests include the inspected version, checked under the draft lock before mutations or replay. Browser, batch, tenant and backend SDK callers carry it. Separate writer/reviewer permissions remain enforced. |
| PLAT-03 | Clean metadata responses adopt their document and version together. Dirty or in-flight documents retain their write version, so newer metadata cannot authorize overwriting unseen content. Older responses cannot replace newer known server state. |
| PLAT-04 | Live-conflict retries compare non-live fields with the saved baseline, adopt independent remote edits and preserve overlapping local edits for an explicit choice. Typing while a conflict reload is pending is included in the preserved copy. |
| PLAT-05 | Backup content and recovery require the loaded revision ID to match the selection. Pending loads hide old content and disable recovery; failed loads offer retry, and stale completions are ignored. |
| PLAT-06 | Code Studio's bounded diff moved to `lib/line-diff.ts`; backup and refinement comparisons reuse it. Backup rendering groups adjacent rows to avoid creating tens of thousands of spans. |
| PLAT-07 | Scheduling, queueing and Publish now capture the flushed version before rendering, flush again to detect pending edits, and reject changed versions. The request sends the captured version with its images. Scheduling no longer mutates the autosave version ref directly. |

No dependencies, schema changes, migrations, or alternative persistence/publishing
layers were added. `npm run api:generate` was run; the review endpoint is
session-only and excluded from the public generated API, so generated output
did not change. Session review callers must now supply `version`.

## Ownership and callers

- Reused the product review/scheduling transaction and cancellation helper, the
  existing autosave hook, publication owner, and Code Studio's bounded diff.
- Added only `lib/line-diff.ts` as a shared algorithm owner: Code Studio's
  line-number result and the backup dialog's text result need thin adapters.
  No second persistence or publishing implementation was introduced.
- Updated review callers in browser controls, batch requests, tenant methods,
  backend SDK and integration fixtures. The shared diff also reaches refinement
  previews. Both schedule/queue and Publish now use the publication preparation
  helper.

## Verification

- `npm run quality:check` passed: formatting, lint with zero warnings,
  workspace type checks and tests, including all 1,527 web tests. The existing
  optional collaboration-backend test was skipped by its configured prerequisite;
  real collaboration transport is exercised by the native browser checks.
- Focused client regression tests cover clean/dirty/in-flight metadata responses,
  independent and overlapping live edits, delayed conflict reloads, captured image
  versions, and 40,000-line comparisons.
- PostgreSQL integration tests cover stale reviews with separate writer/reviewer
  roles; cancellation across re-request, approval and explicit rescheduling;
  worker-claim races; same-note rejection; and a first-schedule/rejection race
  paused after the approval read but before the revision insert.
- The actual provider-worker test asserts no provider call after rejection and
  another request for review. The Temporal scheduling integration suite passed
  against local PostgreSQL and Temporal.
- `make -C server check` passed, including generation, unit tests, race tests,
  vet, and generated-code cleanliness. Its browser fixture used an external
  launcher that removes this environment's proxy variables; no repository test
  was skipped or weakened for that adjustment.
- Authenticated member-comment and team-role browser flows passed on the native
  development stack, including a stale approval followed by successful re-review.
  The writing journey passed its delayed/failed backup load, rapid navigation,
  retry, and displayed-revision/recovered-body assertions.
  The table/math publishing journey passed with real collaboration and storage:
  a peer edit during upload blocked both scheduling and Publish now, with no
  scheduling request or queued post; a no-edit retry successfully scheduled both
  rendered images. The delayed-upload assertions use the dialog's actual error
  text and inspect the editor hidden behind the modal.
  This is development-server coverage, not production-build parity.
- The standard Docker social gate was attempted but its image build failed:
  `go mod download` could not verify the dependency proxy's certificate. Native
  provider-worker/Temporal tests do not replace that gate.

## Independent review

Separate structure, performance, chaos, QA and lean reviewers ran. Confirmed
findings were fixed: first-schedule serialization, preservation of edits made
during conflict reload, repeated rejection after optional-review scheduling,
missing version arguments in integration callers, and redundant document parsing
on each render. QA reviewed strengthened backup-identity and actual
schedule/Publish-now delayed-upload browser coverage.

Full cross-browser/mobile checks, a production-build browser run and live-provider
delivery were not performed. Non-live-field merge and overlapping-conflict
assertions run against the actual hook with controlled API responses; the browser
upload race exercises shared-body updates through the live collaboration service.

Implementation-handoff verdict: **No-ship pending the production-stack social
gate.** The code fixes and confirmed reviewer findings are resolved, but the
native checks do not establish production-build parity. This report records
local verification before opening the PR; its CI runs provide the subsequent
production-stack gate results. No production publication or deployment was
performed.
