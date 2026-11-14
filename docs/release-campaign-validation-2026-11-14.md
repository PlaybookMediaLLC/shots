# Capture recovery and Verifier validation — 2026-11-14

Scope: finish the existing Verifier capture-to-draft test, correct sign-in
diagnostics and stale-view recovery, and document managed AI capture choices.
This continues [the release workflow ledger](release-campaign-validation-2026-11-13.md).
The user deferred computer-use validation while using Chrome; code and release
work continue. No social post was published or scheduled.

## Architecture and design

The [RFC 007 addendum](rfcs/authenticated-capture-runtime-and-recovery.md)
documents the actual owners, managed-agent alternatives, authentication
boundaries, evidence contracts, rollout gates, cost assumptions and tests.
Browser Use's hosted Agent API is the first evaluation candidate. Browser-only
hosting is separate from AI action selection; customers should supply objectives,
not scripts. No new provider, subscription, queue, schema or dependency was added.

Existing path retained:

```text
Shots connection UI → tRPC → backend SDK → Go HTTP adapter
  → tenant-scoped product connection domain → existing Cloudflare adapter
  → existing Temporal completion → encrypted session state

Release intake → existing durable capture job → browser navigation
  → original screenshot and provenance → campaign → editable draft
```

## Defect ledger

| ID | Severity / subsystem | Reproduction and root cause | Correction | Evidence boundary |
| --- | --- | --- | --- | --- |
| RC-013 | P2 / sign-in diagnostics | Finish before login completes, or restore a nonportable session. Completion treated missing live identity and failed fresh restore as the same authentication error. Unknown errors also defaulted to authentication. | Prove live account before export; distinguish `sign_in_incomplete`, `session_restore_failed`, wrong account and infrastructure errors. Closed tabs mean incomplete sign-in. Preserve fresh-browser verification. | Local Chrome and persisted database cases pass; production UI retest pending. |
| RC-014 | P2 / viewer recovery | Reload Shots during an open handoff, or let the five-minute viewer grant expire before the ten-minute sign-in intent. The link existed only in component state; reconnect replaced the browser. | Resume or refresh the existing viewer, retaining session, intent and deadline. Only the original connecting administrator may obtain the grant; recheck expiry/replacement/revocation after the provider call. | Real Cloudflare retained page/state across two viewer grants. Database race/tenant cases and production-image UI tests pass. New production button still needs retest. |
| RC-013-R1 | P2 / review regression | Completed login lands on a page without the configured account marker. The first patch checked only current tabs. | Fall back to a guarded temporary tab at the configured protected path within the same browser context; wait for account hydration and close that tab. Keep the original tab and later independent restoration check. | Real Chrome regression passes, including original-tab preservation and blocked POST, external host and WebSocket requests. Independent structure re-review: Ship. |

## Changed owners

- `server/internal/capture/browser/{state,run}.go`: live identity proof and shared
  guarded page setup, reused by isolated capture and same-session verification.
- `server/internal/product/capture_connections.go`: stage-specific errors and
  same-actor, tenant-scoped viewer refresh with audit and race checks.
- `server/internal/httpapi/capture.go`, backend SDK and capture tRPC router:
  existing response contract, private/no-store viewer response, new refresh route.
- `CaptureConnections.tsx`, `CaptureSignInPanel.tsx` and `surface-freshness.ts`:
  Resume sign-in, Refresh sign-in window, Start over, and actionable diagnostics.
- Existing browser, product integration, HTTP, SDK, error-copy and signed-in
  browser journey tests were extended. No independent automation pipeline exists.

## Local validation and review

- Full `make -C server check` passed before review, with PostgreSQL integrations,
  real local Chrome, race packages, vet and generated-code/dependency drift gates.
- Focused product/browser/HTTP checks and the final full Go check passed after
  the review correction, including race, vet, generated code and module checks.
  The corrected backend production image also rebuilt successfully.
- Full `npm run quality:check` passed: format, lint, workspace type checks,
  1,758 web tests, 26 editor tests and 38 server-module tests. Collaboration tests:
  12 passed, one existing optional service-backed test skipped.
- Production web and backend Docker images built. Initial backend build captured
  Ent generation in progress and failed; rebuilding after generation passed.
  No generated code change is part of the patch.
- Local production-image `/api/health` returned `{"status":"ok"}`.
- `signed-in-capture.spec.ts --workers=4 --repeat-each=2`: two passes, 7.6 seconds,
  using actual auth and PostgreSQL. The existing lane has no capture provider;
  it proves recovery visibility, failure handling and persistence, not provider UI.
- RFC validator: 18/18. Whitespace check passed before the final Go generation.
- Real provider probe: two Cloudflare viewer grants retained the same application
  page and a harmless storage marker; browser closed on exit. 2.30 seconds. No
  credentials, viewer links, cookies or application content were printed.
- A second provider check loaded the existing, unexpired, tenant-bound encrypted
  Verifier session through read-only persistence access. The corrected code
  restored it, proved live identity, exported the session and verified the same
  account in a separate Cloudflare browser. Passed in 6.42 seconds; both browsers
  were closed and no production row was written. This is adapter verification,
  not a captured campaign or UI acceptance.
- Independent structure, perf, chaos, QA and lean reviews completed. Structure's
  protected-path blocker was fixed and independently retested with Chrome. Chaos's
  closed-tabs classification was corrected within the requested diagnostic scope.
  No extra dependency or speculative abstraction was identified. Go and TypeScript
  specialists also returned Ship with no confirmed findings. Final verdict is
  Ship for the scoped fixes, subject to terminal validation and deployment;
  product-level capture-to-draft acceptance remains incomplete.

## Production evidence and remaining acceptance

Before these changes, the active DigitalOcean deployment was
`3bf81926-f9c3-4306-98ef-b30c7ea6000f`, application
`c525b0ba-b92a-4174-ae91-4ab4d7c92fd2`, with component image revision
`cc37ede934503e266ce6f79b53a94ce5c034443c`.

The existing Verifier connection `cmwfhd2jz00030a021gf9dvvc` showed Ready;
read-only persistence inspection agreed. It is a staging connection in the
existing test workspace, with no repository association. The product page
`cmwg2ycjd0003092v5wqrb0zp` (Verifier analytics validation) was created through
the production UI and confirmed after reopening the page. Its configured URL
is `https://verifier.playbookmedia.io/app/analytics` and it still says Never captured.

The planned capture targets the real analytics panel, with the account control
masked and a read-only AI navigation objective. This is current-state validation,
not evidence of a new product release. No new screenshot, campaign or draft ID
has been accepted in this cycle.

Browser actions repeatedly lost focus to another Chrome tab; direct browser
access reported `The browser access host is unavailable`. On November 14 the
user selected **Continue code and release work meanwhile**. Production UI
capture, screenshot editing, draft save/reload and a second full run remain
deferred. This is not an authentication failure or end-to-end acceptance.

Verifier release ingestion separately still needs organization-owner access to
add `paperless-check-if-email-exists` to GitHub App installation `178812766` in
Oppulence-Engineering. A manual capture does not prove webhook intake.

## Delivery record

Implementation and local validation are separate from merge, deployment and
production verification. PRs, immutable revisions and terminal deployment results
will be recorded here as each step completes.
