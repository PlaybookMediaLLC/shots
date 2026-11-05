# RFC 007: Authenticated Product Capture

**Priority:** 007 — Conditional work
**Previous ID:** 048 ([renumbering map](renumbering-2026-10-24.md))
**Status:** Proposed — conditional supporting track
**Date:** 2026-10-23
**Owners:** Platform Engineering
**Depends on:** RFC 003
**Reuses:** RFC 009, RFC 011, RFC 018, RFC 029
**Execution:** Conditional after verified evidence; not a prerequisite for manual pilot kits

## Decision

Add controlled capture of customer-approved private product screens only when
pilot evidence shows repeated uploads are a material bottleneck. A reviewed
upload remains a supported evidence source. This fills the explicit missing
authenticated-capture design in RFC 029 without creating a separate demo product.

## Provider evaluation and security review

The [Cloudflare capture design and two-pass security review](authenticated-release-capture-review.md)
records a managed-browser candidate, tested defects in existing capture/intake
paths, and remaining integration gates against its stated source baseline.
Resolve those defects and prove the same isolation, egress, secret-lifecycle,
and human-review requirements before adopting that provider. This companion
does not change this RFC's conditional priority or pilot limits. The tested defects
are fixed, and capture is implemented behind configuration on that provider with this
RFC's limits. The signed-in stage on the real provider and the pilot evidence remain
open ([implementation status](authenticated-release-capture-review.md#10-implementation-status)).

## Existing foundation

The [Go capture client](../../server/internal/capture/capture.go) captures
public URLs. [Surface history](../../server/internal/product/surfaces.go)
records assets and capture origins; the
[deployment flow](../../server/internal/product/github_events.go) captures
registered surfaces. Reuse storage, lineage, rendering and Temporal. Do not
pass session secrets through the current public screenshot-provider API.

## Proposed design

Use an isolated browser worker for one workspace and capture run. A customer
administrator connects a dedicated, least-privilege demo/test account through
an explicit browser-session flow. Keep encrypted session material in
backend-controlled secret storage, referenced by an opaque credential ID.
Never put cookies, passwords or tokens in prompts, run summaries or artifacts.

Version each capture recipe with allowed product origins, exact navigation
steps, target screen, viewport, expected UI marker, permitted data set and
redaction requirements. Approving a recipe does not verify every future image.
Restrict workers to reviewed navigation and non-mutating UI actions. Do not
accept arbitrary agent-authored browser scripts. SSO/MFA completion, account
selection and reauthentication remain explicit human actions.

A job pins recipe, credential reference and source release/deployment identity.
Check current authorization at start and before storing results. Enforce public
network destination/redirect policies and block metadata/private-network
access by default; private-network capture requires a separately reviewed
network design. Isolate storage and browser state between runs and tenants.

Store capture time, environment, viewport, product revision when known, recipe
version, result asset hash and failure reason. Never infer a product commit
from time alone. Expired sessions, login screens and missing expected UI
markers fail explicitly; do not label a login-page image a successful feature
capture. Review redactions and content before admitting the image as evidence.

## Incremental delivery

1. Improve manual upload provenance and review using RFC 003.
2. Pilot one allowed origin and a dedicated demo account, on-demand only.
3. Add expiration, revocation, reauthentication and run cancellation.
4. Enable deployment-triggered recapture only for approved recipes after
   isolated-worker and live-provider checks pass in the pilot environment.

## Technical design: isolated capture execution

Follow the [shared backend/job contracts](../release-readiness-technical-contracts.md).
The first implementation uses a dedicated, isolated Chromium worker pool with
one ephemeral browser/container per capture run. Reuse Temporal for scheduling
and existing asset storage; do not add authenticated cookies to the current
public URL capture client. A managed browser vendor may replace the pool only
after passing the same isolation, egress and secret-lifecycle tests.

### Persisted records and secret lifecycle

| Proposed table | Fields | Invariants |
| --- | --- | --- |
| platform_capture_credential | Org, opaque credential ID, environment, allowed origins, envelope key ID, encrypted secret reference, expiry, revoked time, generation | No plaintext session data in row/DTO; generation increments on renewal/revocation. |
| platform_capture_recipe_version | Surface, version, credential ID, origins, typed steps, viewport, expected markers, data classification, redaction policy, approving human/time, hash | Immutable approved recipe; same-org credential/surface; unique org/recipe/version. |
| platform_capture_run | Release, recipe version/hash, credential generation, source/deployment identity, state, deadline, cancellation, logical workflow ID, result reference | Unique org/idempotency key; expected credential generation pinned at dispatch. |
| platform_capture_step_receipt | Run, step index, attempt, state, start/end time, bounded error code, quarantined object hash/reference | Unique org/run/step/attempt; one promoted result per run. |
| platform_capture_review | Run, candidate asset hash, derived/redacted asset hash, review decision, reviewer, reason | Human session required; exact bytes pinned; source evidence created only on acceptance. |

Session material is a browser storage-state bundle scoped to reviewed origins.
Store it in backend-controlled secret storage using envelope encryption:
AES-256-GCM, a random 96-bit nonce, authenticated associated data containing
organization/credential/generation, and a key identifier for rotation. Wrap
data keys with the deployment's secret-management facility. Separate the
browser-capture key namespace from general provider OAuth credentials. A
worker obtains a single-run lease, resolves the secret inside its isolated
runtime and never returns it to Temporal history or application logs.

The interactive connection session expires after 10 minutes; discard unfinished
state. Persist successful state for at most 24 hours in the first pilot, or
less if the provider cookie expiry requires it. The human reauthenticates
after expiry. No password retention, automated MFA or credential copying from
the user's everyday browser profile. Revocation marks the credential unusable
before deleting the encrypted state; queued runs fail on generation mismatch,
active runs receive cancellation and fail again at promotion if cancellation
arrives after capture. Destroy temporary browser disk and process memory on
exit. Do not reuse a warm authenticated browser between runs.

### Typed recipe contract

No arbitrary JavaScript, eval, shell command or agent-generated Playwright
program is accepted. The initial recipe language has bounded navigation,
waiting and screenshots; add interactions only as separately reviewed steps.

```json
{
  "schemaVersion": 1,
  "allowedOrigins": ["https://demo.customer.example"],
  "viewport": { "width": 1440, "height": 900, "deviceScaleFactor": 1 },
  "steps": [
    { "kind": "NAVIGATE", "path": "/reports/demo", "timeoutMs": 15000 },
    { "kind": "WAIT_FOR", "testId": "report-ready", "timeoutMs": 10000 },
    { "kind": "CAPTURE", "testId": "report-panel" }
  ],
  "expectedMarkers": ["report-ready"],
  "redactions": [{ "testId": "account-email", "required": true }]
}
```

Maximum 10 steps, three approved origins including explicit static-resource
origins, 90 seconds wall time, viewport up to 1920×1080 at scale 1, 20 MiB
output and one active capture per organization initially. These are proposed
pilot defaults, centrally configured within existing concurrency/storage
quotas. Heartbeat every 5 seconds; activity deadline 120 seconds allows cleanup.
Stop on a missing required redaction selector, login redirect, unexpected
origin, failed expected marker, permission dialog or download attempt.

Navigation itself can change state in poorly designed applications. Do not
claim browser capture makes any arbitrary product read-only. Require a
dedicated demo account/data set and customer-approved paths; deny mutating
HTTP methods after the interactive login phase and disable form submissions,
downloads, clipboard and arbitrary UI clicks. If the target screen needs POST
data queries, add exact reviewed endpoint/method allowlists with no request
body recording; keep this disabled until the customer confirms their effect.

### Network and result boundaries

Enforce egress outside the browser, not only by checking the first URL. The
network proxy validates every destination, DNS resolution and redirect,
including frames, images, service workers and WebSockets. Deny private,
loopback, link-local, metadata and reserved addresses for IPv4/IPv6; pin allowed
resolved addresses to the connection to resist rebinding. Block non-HTTPS,
unapproved ports, local-file access and direct sockets bypassing the proxy.
Disable service workers and WebSockets for the first recipe language; a later
exception must retain proxy enforcement. Never log query strings or headers
that may contain secrets. SSO login origins are approved separately for the
interactive connection phase and do not become unrestricted capture origins.

Raw screenshots go to a private quarantine object prefix with no public share
capability. Apply deterministic masks server-side and store derived bytes plus
mask coordinates/hash. Raw candidates have a 24-hour cleanup deadline; failed
or cancelled captures are deleted sooner when possible. Quarantine deletion
is a durable cleanup job. A human reviews the exact derived image before its
promotion into an evidence version; automated PII detection can flag risk but
cannot mark redaction complete. RFC 003 still requires claim support review.

### APIs, transitions and recovery

| Proposed endpoint under /api/v1 | Behavior |
| --- | --- |
| POST /capture-sessions | Admin starts a short-lived, one-use connection session; returns UI session handle, never cookies. |
| POST /capture-recipes/{id}/versions | Saves validated recipe for human approval; requires expected recipe revision. |
| POST /capture-recipes/{id}/decisions | Approves the exact recipe hash with session authority. |
| POST /releases/{id}/captures | Pins approved recipe and credential generation; 202 with run ID; no arbitrary URL override. |
| GET /captures/{id} | State, safe errors, provenance and authorized quarantine preview. |
| POST /captures/{id}/cancel | Idempotent cancellation request; result promotion prohibited. |
| POST /captures/{id}/reviews | Human accepts/rejects exact redacted image; accepted result becomes RFC 003 evidence. |
| DELETE /capture-credentials/{id} | Revoke first, cancel pending runs, enqueue encrypted-state deletion. |

Run transitions are QUEUED → RUNNING → AWAITING_REVIEW → PROMOTED or REJECTED.
QUEUED/RUNNING may terminate as FAILED, CANCELLED or REAUTH_REQUIRED. Promotion
checks current credential generation, actor membership, recipe approval,
release state and result hash in one transaction; losing any check fails
closed. A rejected image is not a failed provider call and is not retried.

Only transport/browser-start failures before capture may retry automatically,
at most twice with 5s/15s backoff under the same run. Authentication, policy,
marker and redaction failures are non-retryable until human repair. An ambiguous
worker failure after upload first reconciles the step receipt/object hash;
it must not replace a reviewed surface image. A new customer-requested capture
is a new run. Promotion appends capture history through the existing surface
operation and writes evidence/outbox records once.

### Implementation and failure tests

| Gate | Required fixture |
| --- | --- |
| Isolation | Alternating tenants, concurrent runs and worker crashes cannot recover another run's cookies, local storage or quarantine bytes. |
| Egress | Redirect to metadata, IPv6 private address, DNS rebinding, cross-origin iframe, WebSocket and service-worker escape are blocked at the network layer. |
| Secret lifecycle | Wrong org/generation AAD, rotated key, expired session and revocation during upload all fail without secret-bearing logs. |
| Product correctness | Login page with 200 response, missing marker, wrong environment and absent redaction target never yield promotable evidence. |
| Recovery | Lost upload acknowledgment, duplicate workflow dispatch, crash before promotion and double review create one history/evidence entry. |
| Cost/fallback | Step/output/time/concurrency bounds are enforced server-side; a reviewed manual upload completes the same kit with capture disabled. |

## Acceptance criteria

1. A pilot kit can still be completed using a reviewed upload when this track
   is disabled, unavailable or not economically justified.
2. One authorized private screen can be captured with pinned provenance and
   reviewed redactions; a login screen or missing UI marker is rejected.
3. Cross-tenant browser/session reuse, secret disclosure and redirect escapes
   are rejected in tests against controlled fixtures.
4. Credential revocation or workspace removal stops pending work and prevents
   new artifacts from being delivered; expired sessions request human renewal.
5. A failed retry does not overwrite the last reviewed image or its history;
   repeated successful attempts deduplicate by run/step receipt.
6. Non-approved origins or mutating actions are refused, and costs/timeouts
   are bounded independently of model output.

## Observability

Reviewed usable captures per attempted authorized capture is the primary
metric. Separate expired-session, wrong-screen, redaction and provider failures;
track operator time and cost against the upload baseline.

## Rollout and rollback

Enable one customer and origin at a time behind backend configuration. Disable
triggers and revoke session references to roll back; retain approved artifacts
under existing retention rules. No customer credential is required to approve
this design. Validate the isolated Chromium worker against the pilot's actual
login flow and cost; an external provider must pass the same technical gates
before replacing that execution boundary.
