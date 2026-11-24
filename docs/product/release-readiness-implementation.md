# Release readiness implementation

This ledger distinguishes implemented behavior from later delivery phases and pilot evidence.
RFCs 003–006 share the release aggregate, workspace opt-in and session-based authority.

## Phase 003: claims and retained evidence

The Go product domain owns immutable claim/evidence versions, selected support sets,
exact human decisions, access clearance and irreversible erasure. The web uses the
backend SDK and registered API contracts. Existing qualification, membership,
permission, command-receipt, audit, notification and asset-deletion owners are reused.

The release page supports retained text, named authored attestations, uploaded images
and existing provider observations. Reviewers select exact UTF-8 passages or image
regions; the backend validates hashes, bounds, source sequences, provenance and live
reviewer authority. AI content cannot attest to itself. Private source content is
redacted from API-key reads. Review forms preserve unsaved work on conflicts and
retry uncertain requests with the same command key.

Stable claim references travel with new spec versions. Historical section/index
references retain their immutable spec mapping. Legacy imports create unverified
coverage without editing historical approvals. Batches process at most five specs
inside the bounded command transaction and commit a durable cursor and counts of
imported, previously mapped and invalid records. Invalid records roll back to a
savepoint; backfill emits no approval, delivery or notification event.

Provider content changes and confirmed access changes fence retained evidence in
the same database transaction. Unchanged observations do not invalidate support.
The evidence sequence is separate from the provider event count. Asset deletion
first hides and tombstones evidence, then uses the existing retryable storage cleanup.
A deleted confidential passage is not copied into audit data.

Go owns the readiness canonicalizer because approval identity is computed at the
authoritative database transaction. Shared Go/TypeScript fixtures verify its safe
integer manifest subset against the existing client canonical JSON utility. Original
native document bytes will be snapshotted by the kit phase; they are not implicitly
converted to that subset.

Validation includes real PostgreSQL command races, tenant constraints, source
revocation, immutable history, legacy reorder and duplicate text, bounded backfill,
102-claim pagination, source deletion, and an authenticated MCP denial. Fresh and
representative-upgrade migration fixtures preserve historical records. Browser
coverage exercises exact retry after a lost response, human review, API-key denial,
private-read redaction and immediate invalidation after evidence changes.

Run the focused browser flow with:

```sh
E2E_BASE_URL=http://localhost:3011 STUDIO_WEB_PORT=3011 E2E_MANAGE_SCREENSHOT_MOCK=false \
  ./dev/studio e2e-file test/e2e/release-qualification.spec.ts --workers=4 --repeat-each=2
```

Client validation uses `npm run quality:check` in `clients/`; Go release integration
tests require `PUBLISHING_TEST_DATABASE_URL`. The migration fixture requires an empty
disposable database in `PLATFORM_RELEASE_QUALIFICATION_TEST_DATABASE_URL`.

## Remaining phases and evidence boundaries

RFC 004 owns kit assembly, immutable output preparation, separate coverage/final
approval and approved ZIP exports. RFC 005 owns manual and Slack handoff receipts,
unknown-outcome reconciliation and use tracking. RFC 006 owns bounded impact fanout,
manual findings and explicit human revalidation. These phases must pass their own
checks before the final independent review and PR.

Optional model assistance remains disabled until a pilot shows lower reviewer effort
without more factual corrections. Local fixtures do not establish a customer pilot,
production deployment, real-provider delivery or improved adoption metrics.
