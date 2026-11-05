# GitHub production evidence

## Audit before implementation

The App facade verifies a SHA-256 HMAC, resolves installation/repository access,
and calls `AcceptGitHubEvent`. Intake locks each source, pins workflow versions,
and commits tenant events, runs, audits and outbox intents together. Temporal
executes the existing versioned graph; preview uses the pure evaluator.

Confirmed gaps in the original implementation:

- The web allowlist ignores workflow runs and jobs.
- `NormalizeGitHub` drops every non-success deployment status and retains no
  status ID. Its semantic key identifies the deployment, not the observation.
- `productionDeployment` accepts the production flag OR the name `production`,
  even when those disagree. There is no repository production policy.
- The web permits 32 MiB, but the internal JSON decoder and normalizer permit
  only 1 MiB. Larger supported deliveries fail at an undocumented boundary.
- Recovery documentation tells operators to redeliver manually; it implements
  no provider-delivery checkpoint or visible history gap.
- Installation repository pagination silently returns the first 1,000 entries.
- A successful capture readiness HTTP response does not verify a revision.

The repository's `web-image.yml` and `social-backend-image.yml` contain manual
build-only dispatches and deployment jobs that succeed after skipping an older
revision. Neither a workflow conclusion nor a job conclusion proves a new change.

Existing release, PR, tag, milestone, graph-version and capture code is reused.
New observation records are necessary because a failed status or an Actions
completion is not a `deployment.succeeded` release event.

## Provider references checked

- [Webhook payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads):
  deployment statuses can include `workflow`, `workflow_run`, and `check_run`;
  these associations are optional. Inactive statuses do not emit webhooks.
- [Failed deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries):
  GitHub does not automatically retry failed deliveries.
- [App delivery API](https://docs.github.com/en/rest/apps/webhooks): delivery
  inspection and redelivery use the App JWT, not an installation token.
- [Redelivery window](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks):
  GitHub.com exposes the past three days; absence outside that window is unknown.
- [GitHub’s OpenAPI schema](https://github.com/github/rest-api-description): the
  deployment-status webhook defines optional reporting-App identities and direct
  workflow/run/check-run associations; missing optional fields remain unknown.
- [Job attempts](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt):
  job reads require Actions read and must identify the particular attempt.

Local fixtures are not proof of live delivery or production deployment.

## What qualifies, and what it means

A version 1 policy belongs to one workspace's connected repository. A qualifying
observation must have the configured installation, repository, successful signal,
explicit production environment, optional exact ref, and all configured workflow,
job and reporting-App requirements. Conditions return `matched`, `not_matched`, or
`needs_attention`. A contradictory value is a non-match; absent or conflicting
required evidence needs attention. Execution checks can independently require review
(for example, revoked access or an older status).

Environment names and aliases are exact and authoritative. GitHub's production
flag cannot add environments to the policy. A matching environment with an explicit
false flag, or different deployment/status environments, requires attention.
Missing environment evidence never becomes production through the flag alone.

There are three explicitly different evidence strengths:

| Evidence | Meaning | Limits |
| --- | --- | --- |
| Reported deployment | Signed GitHub deployment-status success in an explicitly configured environment; optionally restricted to reporting App IDs | A report can describe a no-op; it does not verify a changed or live revision |
| Trusted change receipt (new policy UI default) | Both the deployment receipt's creator and successful status reporter are configured trusted Apps; receipt says the intended SHA changed | This trusts the reporter's assertion, not an independent observation of customer availability |
| Explicitly trusted Actions outcome | An administrator explicitly binds a selected workflow/job success to one environment | GitHub Actions may only have built an image or skipped deployment; this strength does **not** assert a new deployment change |

The receipt protocol is opt-in and deliberately small. A trusted deployment
reporter creates a GitHub deployment with `task: "shots-deploy-v1"`, its actual
revision in `sha`, an explicit `environment`, and this object in `payload`:

```json
{"schemaVersion":1,"changed":true,"revision":"<the deployment SHA>"}
```

The successful status must also come from a configured trusted App.
`changed:false` is a non-match. Missing receipt, unknown creator, or a different
revision needs attention. Shots does not parse logs, arbitrary workflow outputs,
or HTTP 200 responses to invent a receipt. Existing repository workflows are not
modified to emit an assertion they cannot substantiate.

Merged PRs, tags and published releases retain their existing event families.
Actions observations remain Actions observations. Only policy-qualified evidence
creates a `deployment.succeeded` business event; its additive `production` metadata
records the observation, policy ID/revision and strength. The original provider
production flag remains separate. No evidence strength approves claims, proves
general availability, or bypasses the existing review/publishing controls.

## Selecting workflows and previewing a rule

Open **Automate → Repositories → Production policy and event history** for a watched GitHub repository.
Members can inspect evidence; workspace owners/admins with a session can save
policies and request recovery. Go rechecks membership, source ownership,
installation linkage and repository access. Web routes use the existing auth,
contract, tenant and backend-SDK path.

1. Refresh access to inspect repository access, Actions/Deployments permissions,
   and known event subscriptions.
2. Choose the evidence type, environment aliases, exact refs, and reporting Apps.
3. Select GitHub workflows by stable numeric ID with name and path. A renamed,
   moved, disabled, deleted or inaccessible selection needs review. Recreated
   same-name workflows do not inherit trust. Explicitly remove/reselect a changed
   workflow to accept its new identity details.
4. Where needed, enter a run ID and **exact attempt** to list deployment jobs.
   Select an exact display name scoped to the selected workflow. Job instance IDs
   are retained in observations, since they change on reruns. Matrix names must
   be configured explicitly.
5. Separately select an active **Shots workflow** with the deployment event family.
   This is the release-automation graph, not a GitHub Actions workflow.
6. Save an enabled policy explicitly. Optimistic revision checks reject stale edits.

Deployment webhooks can carry provider-supported workflow/run/check-run
associations. Those are used only when present. Workflow-job webhooks are enriched
through the specific run-attempt and jobs APIs; the job ID/name, run ID, attempt,
workflow ID and repository must agree. No association is inferred from a SHA,
workflow name or nearby time. Missing association is inspectable attention.

Preview evaluates stored normalized evidence (including already-recorded
enrichment) or an API-supplied example. It performs no provider calls, writes,
activation, release creation, credit use or messaging. It explains policy conditions;
it is not a prediction that current permissions, dispatch or execution will succeed.
Use the access panel and recorded processing result for those checks.

The evidence page displays observation status, condition explanations, provider
occurrence time, receipt time, processing time, duplicates, origin, pinned versions,
policy JSON history, normalized evidence and a link to the resulting workflow run. Public URL
projections remove query/fragment credentials and reject user-info URLs, including
older run-history snapshots; immutable stored history is not rewritten.
The run page retains the existing release, node, credit and failure inspection.

## Acceptance, identities, ordering and durable execution

The facade verifies HMAC SHA-256 over the original valid UTF-8 body. Decoding retains
a BOM and rejects invalid UTF-8 instead of replacing bytes before verification.
The web body and normalizer budget is 25 MiB; Go allows a further 1 MiB for the
internal transport envelope. Oversize facade requests return 413; malformed
requests return 400 and invalid signatures 401. The Helm chart leaves ingress
controller annotations and external edge limits to the operator; verify that
they permit at least 25 MiB on this endpoint and retain provider-visible rejection
status codes. Next.js Proxy excludes API paths, so its body-clone limit does not
truncate this webhook. Provider delivery inspection
makes rejected deliveries visible without retaining raw payloads or credentials.

A supported, eligible delivery receives 200 only after all workspace observations
and outbox intents commit together. Duplicates, unsupported event types, and
verified events with no active authorized watcher return 202 without new work.
Database failure rolls the whole fan-out back and returns an error. The backend
acceptance transaction is bounded to six seconds; slow GitHub reads and execution
happen after acceptance. Invalid/missing identity cannot be acknowledged as a
persisted event. GitHub itself does not emit an inactive deployment-status webhook.

| Identity | Use |
| --- | --- |
| `X-GitHub-Delivery` | Transport receipt and recovery GUID; redeliveries can reuse it |
| Repository + deployment ID | Deployment operation; never deduplicated by SHA |
| Deployment ID + status ID | Immutable status observation, including non-success states |
| Repository + run ID + attempt + lifecycle action/state | Actions run observation; reruns stay distinct |
| Repository + job instance ID + lifecycle action/state | Actions job observation; exact attempt retained |
| Observation + pinned policy revision | Immutable decision context |
| Qualified operation key | At most one business event and workflow run for that operation |

Source locks and unique constraints serialize concurrent acceptance and processing.
Duplicate observations increment a counter. Status history is append-only; later
receipts do not replace earlier facts. An older observation cannot start automation
if a newer provider occurrence for that operation is already known. Relational
ordering compares stored PostgreSQL timestamps at the migration’s millisecond precision, avoiding nanosecond rounding bugs.
Contradictory states at the same stored timestamp require review, including
distinct provider timestamps that round to one millisecond. Status IDs and arrival
order do not establish provider ordering. Matching success statuses still deduplicate.
Qualified deployment events preserve the existing graph's repository, actor,
deployment and action fields, plus the default branch and sanitized provider URL.
Missing optional metadata remains missing when downstream conditions evaluate it.
A later failure does not erase a previously observed success or undo an existing run.

One policy selects one canonical signal. Multiple status successes for one deployment
create one business event. The deduplication lookup also recognizes legacy success
keys and pre-existing capture records, so adopting a policy cannot retrigger an
already-recorded deployment. Other signal types remain visible non-matches. If a policy
edit changes the canonical signal, a supported shared run ID/attempt with an already
qualified different signal requires review instead of a second dispatch. This does
not claim that all jobs/deployments in a run are identical. Uncorrelatable signals
are retained separately; no SHA-based merge is attempted. Distinct deployment IDs,
job instances and run attempts remain distinct even for the same SHA, including
web/backend operations, rollbacks and intentional redeployments.

The policy revision and selected active Shots graph version are pinned **at receipt**.
Later policy/graph edits do not reinterpret that receipt. Events predating the saved
policy, or first received more than 15 minutes after provider occurrence, are
historical/review-only even if the policy has been active for months. They remain
previewable. This age fence is evaluated at receipt; it does not discard queued work. Existing graph checkpoints still stop disconnected,
disabled or otherwise ineligible work. Qualification, business event, run, audit and
dispatch intent commit atomically through the existing outbox and Temporal path.

Transient provider/network/rate-limit failures retain a pending observation and safe
reason, with eight bounded outbox attempts. Retry eligibility uses exponential offsets
from receipt (1, 2, 4, 8, 16, 32, 64 minutes after the initial attempt); restarts do not
reset the budget. Missing permissions/subscriptions, invalid identities and incomplete
API pages require attention. The page exposes pending/retrying/failed dispatch state.
An operator must inspect exhausted work; policy edits never implicitly replay it.

Workflow/job pagination validates `total_count` and unique identities, up to 1,000
items. Partial pages or cap overflow fail closed. Installation/repository listing
also fails explicitly instead of silently truncating at its cap. Configure narrower
repository selection if an installation exceeds the supported list budget.

## Delivery recovery and gaps

The UI's **Check for missed events** reads one App-delivery page (100 entries) per
request, persisting a source-scoped cursor, lease, history window and status. Continue
with **Check the next page**. **Recover missed events for review** additionally
requests at most five due redeliveries, at most three attempts per provider GUID,
with 1/2/4-minute backoff. This is an administrator-operated mechanism; no automatic
background scan or customer GitHub settings changes are enabled by this migration.

The provider API uses the App JWT held only by Go. Returned Link URLs are validated
against the configured GitHub API origin/path; only their bounded cursor is used.
An invalid/expired cursor records a gap and restarts the next scan. Rate limits and
inspection failures remain visible, with a one-minute scan backoff. Delivery attempts
and scan checkpoints survive process restarts. A successful redelivery request is
not proof of receipt; the next inspection reports the provider's delivery result.

Before asking GitHub to redeliver, Shots persists a global GUID suppression marker.
A single GitHub delivery can fan out across workspaces, so suppression applies to
all of them. GitHub supplies no authenticated redelivery header; use this recovery path for
guaranteed suppression. A direct GitHub-UI redelivery with an unseen GUID inside
the 15-minute live window is indistinguishable from a first live delivery.
Recovered evidence is review-only even if another workspace has an
enabled policy. Historical release/PR/tag imports also retain their existing
non-executing behavior. Recovery never replays an already-processed business event.

GitHub.com's delivery window is three days. Older known failures become `history_gap`
without a retry. Initial unknown coverage, expired cursors and intervals beyond
retention remain gaps; this implementation deliberately never claims complete event
history, even after inspecting every currently available delivery. Events GitHub
never generated cannot be recovered by this API. Reconcile with the repository owner
using GitHub deployments/releases and exact Actions attempts. Preserve that review
as evidence; do not promote it into a live event by editing its timestamp.

## GitHub App setup

Keep existing Contents, Pull requests and Metadata permissions/subscriptions used
by release, PR, tag and milestone ingestion. Add **Deployments: read** for deployment
statuses and **Actions: read** for Actions discovery/enrichment. Subscribe to
`deployment_status`, and to `workflow_run`/`workflow_job` when those signals are needed.
The App owner changes App configuration; installation owners approve added permissions.
Existing event types continue while new permissions are awaiting approval. The access
panel reports missing permissions or unknown/disabled subscriptions. Shots does not
change the App or installation settings automatically.

## Schema, API, rollout and rollback

The additive SQL migration `20261103090000_github_production_evidence.sql` and matching
Ent schemas add immutable policy revisions, normalized observations, App delivery
recovery records and per-source scan checkpoints. Policy/observation/scan records
are tenant-scoped and included in workspace purge order. App-delivery recovery
markers are platform-level metadata like GitHub installations, contain no raw bodies,
and must survive removal of one workspace to protect other watchers from replay.

Existing GitHub sources get a migration-only schema-0 marker. It preserves the
flag-OR-name legacy behavior, original graph selection and production-capture path.
It is visibly labelled legacy and does not claim version-1 qualification. New sources
have no marker and keep deployment/Actions evidence review-only until explicitly
configured. Saving a schema-1 policy replaces legacy deployment handling only for
future observations. No historical events, approved content, versions or queued runs
are rewritten; registered Temporal workflow versions remain unchanged.

New session APIs are rooted at `/api/v1/github/sources/{sourceId}` in the facade
(and `/v1/github/sources/{id}` in Go): GET/PUT `production`, POST `production-preview`,
GET `production-catalog`, GET/POST `delivery-recovery`. The shared SDK schemas own
runtime validation; OpenAPI and the typed public client are regenerated. Graph
schema versions are unchanged; qualification metadata is additive.

Roll out the database migration first, then the Go API and workers together, then
the web facade. Check the worker heartbeat/outbox processing before enabling a
policy on a test repository. The migration activates no new trigger. Pause a policy
to stop new qualification, and use existing run cancellation for already-queued work.
For rollback, pause new policies and drain/cancel their observation/dispatch work
before reverting the binaries; retain all new tables, records and suppression
markers. Reverting to older binaries resumes their legacy heuristic for future
webhooks, so suspend intake or disconnect the affected test source if that behavior
is unacceptable. Do not drop evidence or modify queued immutable snapshots as a rollback.

## Validation and live verification

Automated coverage includes policy condition matrices, realistic deployment/run/job
payloads, no-op receipts, the repository's manual-build/skip-deploy workflow definitions,
payload bounds, exact-attempt API reads, incomplete pagination, App-JWT delivery
pagination/redelivery, concurrent PostgreSQL acceptance, duplicate/restart behavior,
atomic fan-out failure, independent tenant policies, revocation, transient failures,
rule/version pinning, history gaps and suppression of recovery side effects.

The browser journey added to `release-automation.spec.ts` uses actual sessions,
PostgreSQL, the signed web endpoint, fake GitHub and a real Temporal worker. Run it
with the isolated stack documented in [release-automation-fixture.md](release-automation-fixture.md):

```sh
node test/e2e/framework/release-automation-stack.mjs test --grep 'qualifies GitHub'
```

Live verification still requires an App owner and a non-customer test repository:

1. Deploy the additive migration, API, worker and facade; check worker health.
2. Configure the test App webhook URL/secret and the permissions/subscriptions above;
   approve the installation update and verify the access panel's reported values.
3. Connect the repository; create a Shots workflow with only `create_release`, with
   no AI, messages, campaigns or publishing; explicitly enable its policy.
4. Inspect live signed GitHub delivery records for a build-only manual dispatch,
   skipped/no-op deploy, staging deploy, successful production receipt, failed status,
   rerun, same-SHA redeployment and rollback. Compare provider IDs, attempts and times
   to the observation page and pinned run; only the intended receipt should qualify.
5. Rename/disable the selected workflow and remove Actions access in this test App;
   confirm attention without selecting a same-name replacement or breaking release/PR intake.
6. Cause one controlled test-webhook failure, restore the endpoint, inspect/redeliver
   it through recovery, and confirm review-only evidence with zero new live runs.
   Inspect the history-gap warning; do not describe the retained window as exhaustive.
7. Repeat with two test workspaces watching the repository and different policies;
   verify isolated decisions, previews and run links, then pause/disconnect test sources.

Do not perform these steps on customer installations without separate authorization.
No live GitHub settings, deployments, customer messages or publications are needed
for the local test suite, and none were used for this implementation's verification.


## Implementation verification results

- The additive migration applied to isolated PostgreSQL 16 databases, including
  the browser fixture database. No production database was used.
- `npm run quality:check` passed: formatting, zero-warning lint, workspace
  typechecks, 1,140 web tests, 22 editor tests, and 9 collaboration tests. One
  existing Redis-dependent collaboration test was skipped by its opt-in gate.
- `npm run build:sdk` and `npm run api:generate` passed. Generated Ent files were
  hashed before/after a second generation; there was no drift.
- `make -C server check` passed on the latest `develop` base, including
  generation, unit tests, the race suite, vet, and the generated-code drift check.
- PostgreSQL product/HTTP/provider/policy/maintenance regression suites passed,
  as did the expanded production-policy integration tests. Final changes were
  rechecked with the applicable Go tests and vet. Production integration tests also
  passed under the Go race detector, including concurrent receipt processing.
- The signed deployment browser journey and existing GitHub-release-to-AI-drafted-
  campaign journey passed together using real sessions, PostgreSQL, Temporal,
  local object storage and the fake GitHub/model APIs. Browser assertions cover
  invalid signatures/JSON, a valid 2 MiB signed payload, oversize rejection, duplicate delivery, policy/run
  versions, both Actions event types, preview, recovery visibility and tenant denial.

The initial local Temporal CLI 1.8.2 container failed its own startup when bound to
`0.0.0.0`. Verification used the available CLI 1.5.1 / server 1.29.1 on host loopback;
its workflow execution completed successfully. This is local fixture evidence,
not validation of the deployed Temporal cluster or live GitHub delivery.
