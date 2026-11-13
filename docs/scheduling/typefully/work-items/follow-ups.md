# Epic FOLLOW: Follow-up automation

Reconciled against `19390194` and the implementation in this working tree. The October 23 expansion deferral is reopened by this assignment. [Execution](execution.md) distinguishes observed local test results from external provider verification.

## WI-FOLLOW-1: Apply defaults and timed follow-ups

**Gap:** Partial at the audited baseline; source evidence and the implemented slice are recorded below.

**Priority:** Reopened expansion. **Size:** M; live provider activation remains separately gated.

**Source:** TF-011, TF-027, TF-064. [Source requirements](../changelog-features.md).

**Dependencies:** Set engagement defaults; canonical options; Temporal action receipts and verified provider rights.

**Affected code and current evidence:** `components/write/composer/automation.tsx`; `lib/write/automation.ts`; `server/internal/product/social_sets.go`; `server/internal/temporalpublishing/automation.go`; `server/internal/social/tenantpublishing/automation.go`.

### Implementation gap and disposition

Timed repost/unrepost, like-threshold plugs/reposts, native quotes and set defaults already exist in the current implementation. Verify defaults are copied into new drafts and do not rewrite existing scheduled snapshots.

### Acceptance criteria

Save set defaults with optimistic concurrency, create a draft and inspect copied values after reload. Support elapsed-time and supported engagement conditions. Start only after confirmed publication; revoke account/plan/approval authority before execution and prevent the action. Cancel pending actions and replay workers without duplicate confirmed extras.

### Failure behavior

Unknown delivery is not automatically retried. A failed extra cannot downgrade a successful main post. Threshold expiry remains visible; missing analytics cannot be substituted with zero likes.

### Verification

`server/internal/temporalpublishing/automation_test.go`; `server/internal/social/tenantpublishing/automation_test.go`; `server/internal/product/content_draft_schedule_integration_test.go`; `test/write-automation.test.ts`; `test/e2e/write.spec.ts`. Execute the relevant tests and record results in the coverage matrix; listed tests alone do not certify this item.

### Observability and activation

Persist action kind, due time, attempts, cancellation and confirmed/failed/unknown outcome. Native X quote access remains gated by verified API eligibility.

## WI-FOLLOW-2: Consent-bound direct-message delivery, disabled by default

**Source:** TF-043. **Classification:** Partial. **Priority:** Reopened. **Size:** M.

Current `develop` adds `server/internal/autodm` and the X direct-message adapter, superseding the earlier unimplemented status. The ledger tracks consent, opt-out, unique delivery attempts and uncertain outcomes. `20261102100000_platform_auto_dm.sql` is additive. Ordinary reply/repost grants confer no direct-message permission.

**Dependencies:** Accepted [consent and abuse policy](../write/auto-dm-policy.md) (approved 2026-11-13), verified X DM grants and explicit `PLATFORM_X_AUTO_DM_DELIVERY_ENABLED` activation. Live delivery remains disabled. No composer or agent action may implicitly enable the adapter.

**Acceptance and failure:** Default-off and missing-grant requests never mutate the provider. Consent and opt-outs govern recipient eligibility; duplicate events cannot send twice. A timeout/ambiguous response records an uncertain result and cannot automatically resend. Definite pre-send rejection stays distinct from a successful or unknown send.

**Verification:** `server/internal/autodm/autodm_test.go`, `ledger_integration_test.go` and `server/internal/social/integrations/social/x/direct_message_test.go` execute ledger, grant, native protocol and uncertain-delivery boundaries. Local HTTP fixtures do not certify live DM delivery, consent policy or provider approval. Existing ledger status and attempt records provide observability without exposing recipient message text in logs.
