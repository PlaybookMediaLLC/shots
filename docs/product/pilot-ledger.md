# Private pilot ledger and reproducible reports

This implements the offline measurement tooling for RFC 001 slices A and B. It does not establish a paid pilot, collect customer data, authenticate an export, or create native qualification, approval or readiness state. The operator must obtain a customer-approved export and verify workspace membership and source ownership through Shots before recording it. The command only checks the supplied ledger's structure and references. Its report labels that evidence boundary.

The owner is `clients/apps/web/lib/pilot/`: Zod owns the versioned event format; a pure report function owns cohort rules. `scripts/pilot-report.ts` reads a local file and writes JSON to stdout. It makes no network calls and emits no analytics. The social Analyze report is unsuitable here because impressions and clicks are not audience use. No dependency, package, database migration or web endpoint is added.

## Create a private ledger

Run npm from `clients/`. Keep all paths below outside the repository in a customer-approved private location. Limit file permissions with `umask 077`. The blank template is deliberately an empty JSONL file; it contains no fictional customer outcome.

```sh
umask 077
npm run --silent -w screenshot-studio pilot:report -- --schema > /private/pilot-event-v1.schema.json
npm run --silent -w screenshot-studio pilot:report -- --template > /private/pilot.jsonl
```

Each nonblank line is one JSON object validated by the generated schema, identified by `urn:shots:pilot-event:1`. All records have schema version 1, stable UUID `eventId`, organization ID, nullable release ID, observation and recording timestamps in UTC, recording actor, provenance and a private evidence reference. Null means unknown or inapplicable; do not replace it with a guessed zero. Use opaque private references, not conversation content or signed URLs.

The JSON Schema enforces per-kind release scope, required human/source/receipt/verification fields, baseline references, and correction target/reason pairing. The report also checks relationships that JSON Schema cannot express: timestamp ordering, duplicate audience identifiers, cross-record identity and correction graphs, registration/alias integrity, and complete approval/handoff/use chains. Passing schema validation alone is not a valid cohort report or proof that private evidence is authentic. Always run the report's semantic checks before using its results.

Append records in the sequence below. The report does not depend on file order. For synthetic examples, use the fixtures in `test/pilot-report.test.ts`; never turn them into claimed customer results.

| Record                 | Record what was observed                                                                                                                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PARTICIPATION`        | Paid-pilot/subscription agreement and effective interval; release ID is null. This is evidence of participation, not payment collection.                                                                                           |
| `RELEASE_REGISTERED`   | Existing release and canonical release ID, buyer, launch owner, fact reviewer, intake time, nullable owner-confirmed ready time, authorized export reference. Register a canonical release before referencing it through an alias. |
| `QUALIFIED`            | Human decision and required audiences/materials. The first eligible human qualification fixes the cohort and denominator.                                                                                                          |
| `REQUIREMENTS_REVISED` | Explicit reason and replacement audience/material list. Only a change observed and recorded before first confirmed delivery changes the denominator; later changes are reported as prospective exceptions.                         |
| `WITHDRAWN`            | Withdrawal reason; the release remains in its qualified cohort.                                                                                                                                                                    |
| `KIT_APPROVED`         | Exact revision, manifest hash, materials by audience, human reviewer, checklist reference and assisted/manual versus native provenance. Merely generating a document is not approval.                                              |
| `HANDOFF_RECORDED`     | Exact revision/hash and audience, destination, confirmed/failed/unknown outcome and receipt. Downloading an export is not a confirmed handoff.                                                                                     |
| `USE_CONFIRMED`        | Exact revision and audience, named owner confirmation or verifiable publication, verified/pending/retracted status, verification actor and time. Clicks are not admissible use evidence.                                           |
| `FACT_CORRECTION`      | Delivered revision, factual/style classification, severity, affected claims when known, resolution revision when known.                                                                                                            |
| `EFFORT_RECORDED`      | Customer/operator, task, current/baseline, measured/estimated minutes or null, and a comparable prior release for baseline entries. Record explicit zero only when observed.                                                       |
| `COST_RECORDED`        | Unique provider/invoice line, category, quantity, integer micros as a decimal string, currency, estimated/settled status.                                                                                                          |
| `PAYMENT_RECORDED`     | Unique payment line, agreement, currency and integer micros; committed, authorized, failed, collected and refunded remain separate. Use a different line ID for each partial collection or refund.                                 |
| `RENEWAL_RECORDED`     | Agreement and explicit intent, paid renewal or declined outcome; release ID is null. Keep supporting commercial evidence private.                                                                                                  |
| `EVIDENCE_REMOVED`     | Minimal source-reference tombstone and reason; release ID is null. Referencing chains become unavailable, not verified.                                                                                                            |

Correct a record by appending a replacement of the same kind and organization/release, with a new event ID, `supersedesEventId`, and `correctionReason`. Keep the original record. An identical duplicate event is deduplicated; a changed duplicate, forked replacement, correction cycle, missing registration, foreign canonical reference or alias cycle fails. Late evidence restates the original qualified cohort. Eligibility corrections remain visible and do not silently delete qualified releases.

## Produce and reproduce a report

```sh
npm run --silent -w screenshot-studio pilot:report -- \
  --input /private/pilot.jsonl \
  --metric-version 1 \
  --cohort-month 2026-10 \
  --as-of 2026-12-01T00:00:00Z \
  --followup-days 30 > /private/pilot-report.json
```

Keep the exact input bytes with the report. Its manifest includes their SHA-256 and all explicit parameters. A second reviewer runs the same command, compares the hash and parameters, and checks the per-release rows against source evidence before relying on totals. JSON serialization and ordering are deterministic for the same input and parameters. Changed whitespace changes the input hash, even if metrics do not change.

Reports include every eligible canonical release in the monthly cohort whose organization participated at first qualification. They retain zero outcomes, withdrawals, evidence loss and missing timestamps. All required audiences need an approval → confirmed handoff → verified use chain for the same revision. Each audience can use a different approved revision. Retries, revisions and aliases never add releases.

The observation cutoff is the earlier of `asOf` and first qualification plus the chosen number of elapsed 24-hour days. Unmatured releases are censored; compare `matured` summaries at the same age. Approval durations retain negative values under `preReleaseApproval`; medians/p90 use observed samples and include missing counts. Customer effort, operator effort and combined effort stay separate. Labor saved is limited to recorded customer tasks with comparable baselines; missing or incomplete observations remain null.

Economics stay separated by currency. Integer micros are decimal strings; cost-per-kit is an exact numerator (`totalMicros`) and denominator (`kits`), or null when there is no denominator. Organization-level money stays under `unallocated`, with no implicit spreading across releases. The initial allocation rule is an explicit release link only. Unallocated money is reported for cohort organizations in the selected calendar month; allocated money follows each release's observation cutoff. Authorized or committed money never contributes to collected revenue. Empty currency arrays mean no money records, not proof of zero economic activity.

Repeat use counts cohort organizations with an adopted release and another later qualified adopted release known by `asOf`, each evaluated at the same follow-up age. Paid renewal and renewal intent are separate as-of observations, not conversion rates. Factual corrections count affected delivered releases once; claim counts are separate. No report claims customer comprehension, causal revenue uplift, or native readiness verification.

## Verification and rollout boundary

`npm test` includes the synthetic ledger cases and CLI reproduction test. `npm run quality:check` remains the repository gate. No browser flow is added for a command that has no UI, authentication path or network effects. The existing usability browser tests cover the product journeys separately.

Rollback removes the offline command and documentation without changing application data. Keep private ledgers and reports for review; do not delete evidence as part of rollback. Native import remains RFC 005 work, with authorization, atomic receipts, original attribution and reconciliation required before adoption. This tool does not bypass that work.
