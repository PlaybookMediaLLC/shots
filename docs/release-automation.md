# Workflows (GitHub release automation)

**Workflows** in the workspace sidebar connects the existing GitHub App,
watches repositories, and authors versioned workflows that turn shipped
changes into reviewable campaigns. This implementation uses the Go product
backend, Ent/Postgres, the tenant outbox, and one Temporal interpreter.
Browser state is never execution authority.

| Route                  | Purpose                                                                  |
| ---------------------- | ------------------------------------------------------------------------ |
| `/workflows`           | Summary counts, definitions, recent runs and campaigns, event sources    |
| `/workflows/new`       | Executable templates, the manual campaign entry point, planned templates |
| `/workflows/[id]`      | The canvas editor; read-only for members                                 |
| `/workflows/runs`      | Run history filtered by workflow, event, repository, status, and date    |
| `/workflows/runs/[id]` | One run: evidence, pinned graph and path, receipts, outputs, recovery    |

`/settings/release-automation` (and the old `/workspace/release-automation`) redirects to `/workflows` with its query
string, and GitHub connection callbacks return to `/workflows`.

## Capability inventory

| Capability                    | State                                                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Triggers                      | Published release, merged PR, successful deployment; v2 adds new tag pushed and milestone closed. No branch push or schedule. |
| Conditions                    | The Go evaluator's operators below, nested `ALL`/`ANY`/`NOT`, explicit evidence states, numeric comparisons (v2).             |
| What counts as a release      | Trigger + qualification + version level, PR size, head branch, milestone counts, and release contents (below).                |
| AI relevance check            | Executable (v2) `classify` node: admin criteria, confidence threshold, budget; verdict recorded once.                         |
| Create release                | Executable (v1). v2 adds contents: what the event references, or everything merged since the last release.                    |
| Create campaign drafts        | Executable (v1). Source text, brand kit and version, audience, destinations, CTA.                                             |
| Generate channel copy (AI)    | Executable (v2). Paid, budgeted, once per run. Needs a worker with a model provider and credit meter.                         |
| Submit for human review       | Executable (v1). Ends the run; approval stays with a person.                                                                  |
| Notify workspace              | Automatic on every selected run's outcome through workspace activity; not a graph node.                                       |
| Campaign context              | Folded into generation: brand profile voice, audience, CTA conventions, prohibited terms, product text.                       |
| Product screenshots           | Production deployments keep the existing capture pipeline in automation mode. Not a graph node.                               |
| Render creatives              | Executable (v2): fills 1–3 design templates with the latest product capture through the web renderer.                         |
| Create a canvas               | Executable (v2): lays out a canvas from the release with 1–3 canvas templates through the web's canvas builder.               |
| Hand off approved content     | Not exposed: no trigger exists for "approved", and scheduling stays in the human flow.                                        |
| Manual campaign               | Linked: `/campaigns/new` builds a campaign by hand under the same review rules.                                               |
| Recurring campaigns (RFC 041) | Planned, shown disabled. Nothing in RFC 041 is built.                                                                         |

## Customer flow

1. An owner or administrator connects an accessible GitHub installation and
   chooses repositories under **Event sources**. One installation may serve
   several workspaces. Each watched repository has a watched branch for merged
   pull requests (the default branch when empty).
2. Create a definition from a template, a blank workflow, or an unsaved duplicate, for one independent
   event family: published release, merged pull request, or successful
   deployment. Set qualification and priority.
3. Edit the graph with the canvas or labeled node/connection controls. Save an
   incomplete draft to retain work; validation errors block activation.
4. Test an example or a recorded event from this workspace. Preview uses the same
   Go validator and evaluator and performs no enrichment, generation, or writes.
5. Activate a saved revision. A compatible worker must have a current capability
   lease. New events pin immutable versions and their priority ordering.
6. Inspect the run history, selected definition and revision, node decisions,
   attempts, failure reasons, credits, and links to the resulting release and
   campaign drafts, including the campaign's own review state.

Owners and admins can archive a workflow after confirmation and restore it from the
Archived filter. Archiving disables the definition and requests cancellation of
pending runs; immutable versions, run history, and completed outputs remain.
Restoring leaves it inactive. Apply `20261102090000_workflow_archive.sql` before
deploying the updated backend and web.

Dashboard run counts cover automation-mode events; legacy intake is counted and
linked separately. Run-history filters include the intake mode. Date pickers use
local midnight and an inclusive To day (the backend receives the next local
midnight as the exclusive upper bound). Filters and page cursors stay in the URL,
and run details link back to that filtered page.

Templates build ordinary drafts; every condition and action stays editable
before activation. `lib/workflows/templates.ts` generates them and the shared
fixture `server/internal/releaseautomation/testdata/workflow-templates.json`
proves the Go validator accepts each one as written.

| Template                       | Graph                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Product launch from a release  | tag `v*` (optionally major/minor only) → not a prerelease → release → campaign drafts → … → review      |
| Launch from a version tag      | tag `v*` (optionally major/minor only) → not a prerelease → release of every unreleased PR → … → review |
| Release a closed milestone     | at least one closed item → nothing left open → release of the milestone's PRs → … → review              |
| Feature announcement from a PR | base branch and human author → `feature`/`marketing`/`release` label or `feat` title → … → review       |
| Deployment-driven marketing    | `production` environment → production deployment → … → review                                           |

Every template can swap its rule check for an AI relevance check and add AI
copy and rendered creatives; "…" is campaign drafts, then the chosen AI copy and
render steps. Every saved graph uses language version 2.

The editor opens a full-window canvas with a side inspector. **Node** edits the
selected step and its connections; **Workflow** sets qualification, priority,
and description; **Test** selects evidence and shows each predicted step. Click
a preview step to inspect its node. True and false branches have distinct labels
and colors, and a preview highlights the path it would take.

Save, Test, and Activate stay visible while the inspector scrolls. Press Enter
to select a focused canvas node, then use arrow keys to move it. Connection
selectors also support keyboard editing. ⌘Z/⇧⌘Z (Ctrl on other systems) undo
and redo graph and layout edits, ⌘D duplicates the selected node without its
connections, and Delete removes it. The trigger inspector lists every field
conditions can test with values from the latest recorded event. **Versions**
lists activated revisions, links each to its runs, and can load one into the
draft. Members open the same editor read-only. Closing with unsaved changes asks
whether to keep editing or discard them; leaving the page also warns you.

Saving edits, including priority and layout, does not change active execution.
Concurrent saves/activations use revision checks; refresh after a conflict.
Lower active priority wins; definition ID breaks ties. The first matching
definition wins for a source and event family. An unresolved earlier definition
stops evaluation instead of granting a later definition permission to act.

The actions are **create release**, **create campaign drafts**, **generate
channel copy**, and **submit for human review**. `lib/workflows/actions.ts`
registers each one's input and output, language version, entitlement,
integrations, retry policy, cost, and approval facts; the overview reports
whether the backend can execute it now and why not. Campaigns use the source
text, selected brand and brand version, workspace audience, configured
destination platforms, and CTA. Generation rewrites those drafts in place; it
never renders creatives. Destination account selection and scheduling remain in
the human campaign flow; this feature does not create a schedule.

### Release contents

`create_release` takes evidence only. A merged PR release takes that PR; a
published release or tag takes the PRs its notes or commit message reference; a
milestone release takes the PRs GitHub lists for the milestone (the issues API,
at most 500, failing closed above that). With **Plus every merged PR since the
last release** (`include: "unreleased"`, v2), it also takes every collected
merged PR of the repository that is not yet in a release and merged before the
event. That needs the source to collect unmatched merged PRs (the default).
Changes collected after the release are not added later.

### AI relevance check

A `classify` node (v2) has true and false branches like a condition. Its
criteria are the administrator's own words and are trusted; the event's title,
notes, labels, size, branches, version, and any recorded changed paths are
fenced as untrusted evidence. One small model call returns a verdict, a
confidence, and a rationale; the true branch needs a "worth marketing" verdict
at or above the threshold (0.5–0.99). The node needs a 1–50 credit limit and the
remaining credits to cover it. A graph holds at most two.

The verdict is stored on the node receipt before the charge flag, so retries
and replays reuse it and never charge twice; the workflow branches on the
recorded verdict. If no model is available, the activity retries and the run
fails as retryable; missing credits stop the run as `needs_attention`. An AI
check never silently chooses the false branch for missing evidence. Previews
never call the model: **AI checks in this preview** assumes one verdict and
labels the step as assumed.

### Rendered creatives

`render_creatives` (v2) takes a campaign output and 1–3 design templates from
the web's catalog (`layout-*` templates that place a headline). The worker
picks the current capture of the chosen product page, or the most recently
captured page, and asks the web over `POST /api/internal/workflow-renders`,
signed with HMAC-SHA256 over `<timestamp>.<body>` and rejected after five
minutes. The web fills each template with the capture, the event title as
headline, and the first line of its notes as subheadline, applies the campaign's
brand kit, renders it with the existing design renderer and render cache, and
links each image to the campaign as a design render. A retry reuses the designs
this node already made, and identical renders hit the cache. No current capture
stops the run as `needs_attention` / `capture_missing`. Designs stay drafts; an
approver must approve a visual before it can be scheduled with a post.

### Paid copy generation

`generate_copy` (graph language v2) takes a campaign output and an explicit
AI credit limit of 1–500. A graph holds at most two. Before calling a model the
activity requires the workspace's remaining allowance plus purchased credits to
cover the whole limit, and fails as `needs_attention` / `insufficient_credits`
otherwise. One schema-constrained call writes every post of the run. The system
prompt is fixed; the workspace's product description and brand voice are
trusted context; the release or PR title and notes are fenced as untrusted
evidence and the model is told never to follow instructions in them. Posts over
their channel limit are dropped, and copy with a prohibited term keeps its
source-grounded draft.

The node receipt makes retries safe. The model output is stored on the receipt
before anything is applied, then a `charged` flag is set before credits are
drawn, then posts are updated idempotently. A retried activity reuses the stored
output and never charges again. A crash between flag and charge under-bills; no
path double-bills. The charge is the call's actual cost rounded up to credits,
at least 1 and never above the limit, and is reported per node and per run.

**Submit for review ends execution.** There is no automatic approval, approval
wait/resume, autonomous publishing, or scheduling action. A successful run means
the chosen draft/review operations completed, not that content was published.
RFC 043 policies and RFC 044 autonomy remain proposals.

## Modes and compatibility

Unconfigured sources retain legacy behavior: merged PRs become collected
changes, published releases are ingested, and successful production deployments
retain the existing capture pipeline. Existing source branch, author, bot, and
prerelease filters apply before any definition.

Activating a definition puts its source in **automation mode**. Disabling every
definition leaves that mode enabled: it never silently resumes legacy release
creation. An administrator can explicitly select legacy intake. Mode changes
cancel previously admitted work. Automation mode has a separate, explicit policy
to collect or skip unmatched merged PRs. Accepted events retain that policy.
Production deployment capture is preserved even when no definition matches.

Disabling a definition, stopping repository watching, disconnecting a workspace
installation link, or receiving suspension/deletion/repository-removal events
requests cancellation. Every mutating activity checks workspace eligibility,
source mode, installation/link access, definition authorization, entitlements,
and referenced resource ownership again. GitHub repository access is checked
before graph actions. Work already in flight may finish; cancellation preserves
its outputs. Reconnecting/re-enabling never restarts cancelled runs.

Connections show unconfigured deployment, no connection, requested organization
approval, connected, suspended, deleted/disconnected, and removed repository
access. GitHub errors surface as attention states with recovery links. Stopping
watching or disconnecting one workspace never uninstalls the shared App.

## Event and graph contracts

`server/internal/releaseautomation` owns the graph language (versions 1 and
2). The SDK and Zod contracts mirror the transport; the Go validator authorizes
execution.

| GitHub event        | Accepted operation             | Semantic identity                                    |
| ------------------- | ------------------------------ | ---------------------------------------------------- |
| `release`           | `action=published`             | `release:<repository-id>:<release-id>`               |
| `pull_request`      | `action=closed`, `merged=true` | `pr:<repository-id>:<pr-number>`                     |
| `deployment_status` | `state=success`                | `deployment:<repository-id>:<deployment-id>:success` |
| `push` (v2)         | `ref=refs/tags/*`, `created`   | `tag:<repository-id>:<tag-name>`                     |
| `milestone` (v2)    | `action=closed`                | `milestone:<repository-id>:<milestone-id>`           |

Release edits, unmerged closures, failed deployments, branch pushes, deleted
tags, and forced moves of an existing tag do not execute this feature. A tag
name is one release: re-pushing it after deletion is a duplicate. A tag push's
notes are its head commit message, and its time is GitHub's push time. Tag and
milestone events are recorded only for sources in automation mode; a legacy
source has no behavior for them.
`target_commitish` is not exposed as a branch. Deployment commit identity and
provider object IDs remain in the event snapshot and release lineage.

Fields per family come from the Go catalog (`FieldKinds`): every family has
`repository.id`, `repository.name`, `event.family`, `event.action`, and
`actor.login`; releases add tag, title, and prerelease; merged PRs add base,
head branch, number, title, labels, author, bot, changed paths, and the numbers
`pr.additions`, `pr.deletions`, `pr.changed_files`, and `pr.commits`;
deployments add environment, state, SHA, and production; tag pushes add
`tag.name`; milestones add title and the numbers `milestone.closed_items` and
`milestone.open_items`. Releases, tags, and milestone titles add version
semantics: `version.major`, `version.minor`, and `version.patch` (numbers),
`version.prerelease`, and `version.level` (`major` for x.0.0, `minor` for
x.y.0, `patch`, or `prerelease`). Short forms such as `v2` and `v2.3` count;
a name that is not a version reports every version field `not_applicable`, so
a version rule asks for attention instead of choosing a branch. Bodies and
timestamps are not condition fields. Events recorded before a field existed
report it as missing.

Number fields take `eq`, `ne`, `in`, `not_in`, and the v2 comparisons `gt`,
`gte`, `lt`, and `lte`; they compare by value, so `2` equals `2.0`.

A graph has one trigger, typed conditions, registered actions, and explicit end
nodes. It is sequential, acyclic, reachable, and bounded to 64 nodes, 128 edges,
32 KiB, condition depth 8, and 128 predicates per condition. Language version 1
holds the three draft/review actions and the original fields and operators;
version 2 adds the `classify` node, `generate_copy`, `render_creatives`, release
contents, the tag and milestone triggers, the new fields, and numeric
comparisons. Version 2 keeps every version 1 meaning, and the editor saves every
graph as version 2. Branch merges require
input-producing actions to dominate the consumer on every incoming path.
Layout is stored separately from the semantic graph/hash. Incomplete drafts can
be stored, but they cannot exceed hard size/depth limits.

| Condition                  | Semantics                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `ALL`, `ANY`, `NOT`        | Nested groups; NOT has exactly one child. Unresolved evidence propagates through all groups.                 |
| `eq`, `ne`, `in`, `not_in` | Exact, case-sensitive strings; membership takes up to 50 values.                                             |
| `contains`, `not_contains` | Substring for a scalar; exact item membership for a collection.                                              |
| `starts_with`              | Case-sensitive prefix, including on collection items.                                                        |
| `glob`                     | Go `path.Match`: `*`, `?`, `[ranges]`, escaping; wildcards do not cross `/`. No `**` or regular expressions. |
| `exists`, `not_exists`     | Observed empty strings/lists exist. A missing field can be tested explicitly.                                |
| `is_true`, `is_false`      | Boolean fields only.                                                                                         |

Positive collection predicates match any item. Negative predicates require all
items to fail the positive predicate, so an observed empty collection satisfies
the negative predicate. Empty strings are values, not missing evidence.

Evidence states are `available`, `missing`, `not_applicable`, `pending`, and
`unavailable`; invalid conditions are distinct. Except explicit existence tests,
unresolved evidence cannot select the false branch. PR paths start as pending.
The activity paginates all paths, verifies GitHub's reported changed-file count,
and rejects incomplete, duplicate, truncated, or over-3,000-file results. The
bounded result is persisted before evaluation. No repository file contents or
diffs are read. Two paths read code, and neither runs without a person's
consent: Code Studio imports a member starts by pasting a link, and the
**Render a code visual** action, which a workflow owner must allow to read the
merged pull request's diff. See [Code Studio](code-studio.md#source-code-policy). Recorded-event previews use only recorded evidence and clearly
report pending enrichment; examples are labeled as examples. Predicted actions
describe their outputs but never fabricate product IDs or approval.

## Identities, association, and durability

Delivery IDs correlate requests. The tenant/source/semantic-event unique key
deduplicates same-ID and different-ID redeliveries, including after rule edits.
Each accepted event has one logical run; immutable candidate versions are pinned
inside the acceptance transaction. All tenant fan-out receipts and outbox intents
commit atomically. A persistence failure rolls back the entire fan-out, allowing
safe redelivery without partially executing another tenant.

Workflow ID is `release-automation-<run-id>`. Temporal uses USE_EXISTING and
REJECT_DUPLICATE; lost dispatch acknowledgement recovers an existing open or
closed execution. Eligible recovery adds `-recovery-<attempt>` to the execution
ID while retaining the logical run, pinned version, and every action key.
`automation:<run-id>:<node-id>` is stored under tenant/run uniqueness. Domain
idempotency protects the gap between a successful mutation and its node receipt.
Completed receipts return their original product references.

Generation receipts add the stored model output and the charge flag to the same
node row; see Paid copy generation above.

Historical connection backfill is recorded separately and never dispatches
marketing workflows. Imported releases retain their historical output lineage;
later live redelivery of that semantic event is a duplicate.

For automated release association, a release's explicit PR references and the
provider occurrence cutoff establish membership. PR-defined releases attach that
PR only; deployments do not imply PR membership. Tenant, source, and repository
must all match. A late PR can attach to exactly one evidenced release if its merge
time precedes the cutoff. Unreferenced PRs remain collected. Ambiguous references
remain unassigned and emit `product.source_change_association_unresolved` in the
workspace audit trail. Operators must inspect source evidence before correcting
association; arrival order is never membership evidence. This version does not
offer a bulk manual association editor.

## Authorization and state

Existing workspace read permissions govern definitions, events, runs, versions,
and connection visibility; members see the dashboard, history, and a read-only
editor. Owner/admin **sessions** manage connections, save or
activate definitions, change modes, disconnect, cancel, and retry. API keys and
service principals cannot authorize their own automation. Actions use a scoped
workspace service principal, never an administrator session. Existing channel
management still requires the product's two-factor authentication policy.

Tenant identity comes from the authenticated context or persisted run. Sources,
brands, destinations, releases, campaigns, posts, and versions are tenant-scoped
at their respective boundaries. Public/shared routes expose no automation history.

| Run state         | Meaning / recovery                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `queued`          | Durable dispatch is pending. Inspect outbox age if delayed.                                          |
| `running`         | Temporal has loaded the run; node receipts show progress.                                            |
| `succeeded`       | The selected path completed, possibly ending at human review.                                        |
| `skipped`         | Historical, source-filtered, no-match, or an explicit skip end.                                      |
| `failed`          | Infrastructure activity retries exhausted. Admin retry is offered only for `activity_failed`.        |
| `needs_attention` | Missing evidence, invalid configuration, or permanent access failure. Reconcile before further work. |
| `cancelled`       | Work was stopped; existing outputs are retained. No automatic restart.                               |

Activities use bounded retry/backoff and timeouts; file enrichment heartbeats.
Generation runs with 5-minute attempts and at most three tries.

A selected run that finishes `succeeded` emits the `workflow.completed`
workspace activity (admins, in-app by default); `failed` and `needs_attention`
emit `workflow.needs_attention` (owners and admins, restricted). Both link to
the run page and use the existing notification preferences and channels.
Unmatched and skipped events stay quiet. Review submission keeps notifying
approvers through `campaign_posts.submitted`.

Run history reads Postgres only. Filters are workflow, version, repository,
event family, status, and a date window, 50 runs per page by run ID. Each run
reports the revision it executed.
An old recovery attempt cannot resume new actions or overwrite the new attempt's
terminal status. There is no `waiting_for_review` automation state because v1 ends
at submission; the campaign's review status remains authoritative.

Review transitions have a stable outbox key. Each notification recipient has a
durable receipt written **before** sending. A lost acknowledgement leaves
`UNKNOWN_DELIVERY`, and replay refuses to send again until reconciled. This trades
possible missing mail for preventing duplicate mail. It is not an exactly-once
external delivery guarantee. Existing publishing UNKNOWN_DELIVERY behavior is
unchanged; no automation action calls publishing.

## GitHub App and rollout

Use the existing backend-held `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`,
`GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_SLUG`, and
`GITHUB_APP_WEBHOOK_SECRET`. Keep the existing setup/OAuth callback URLs and
single-use state flow. The shared webhook remains `/api/webhooks/github`.

App repository permissions: Metadata read, Contents read (release events and
reads), Pull requests read (metadata and paths), Deployments read. Subscribe to
`release`, `pull_request`, `deployment_status`, `push`, and `milestone`, plus the
App's installation and installation-repository lifecycle events. `push` uses the
Contents permission and `milestone` the Pull requests permission. Milestone
releases list the milestone through the issues API; GitHub does not document
whether Pull requests read alone suffices, so grant Issues read if a milestone
release stops with a repository-access attention state. No write permission, source-code
read operation, organization-membership permission, or per-customer webhook is
introduced. Existing installations may need an owner to approve permission changes.

1. Apply `20261026090000_release_automation.sql` and
   `20261026090800_workflow_generation.sql` with the existing platform migration
   command. The first adds six tables and source mode/policy columns; the second
   adds the generation receipt (`generation`, `charged`), executor `capabilities`,
   and a run index. Both are additive. The second batch of v2 features needs no
   further migration.
2. Deploy the Go backend and product worker. The worker registers
   `platform-release-automation-v1` on `platform-release-automation`, plus its
   activities; v2 graphs run on the same registration. Enable existing
   maintenance/outbox dispatch and GitHub configuration. Maintenance retains its
   existing email/HTTPS configuration requirements. For AI checks and paid copy,
   the worker also needs `OPENROUTER_API_KEY` (optionally
   `PLATFORM_AI_MODEL_FAST` and `PLATFORM_AI_MODEL_DRAFTING`) and `REDIS_URL` for
   the AI credit meter. For rendered creatives, the worker needs
   `PLATFORM_WORKFLOW_RENDER_URL` (the web's base URL as the worker reaches it)
   and `PLATFORM_WORKFLOW_RENDER_KEY` (at least 32 characters); the web needs the
   same `PLATFORM_WORKFLOW_RENDER_KEY` and its existing renderer configuration
   (`PLATFORM_DESIGN_RENDERER=enabled` and the CDP or Chromium settings). The
   same URL and key let the worker create canvases (`create_canvas`); that needs
   no renderer on the web.
3. Verify Temporal polling and a fresh executor capability lease. It expires after
   one minute without renewal; the production worker advertises only when GitHub
   and maintenance dispatch are configured. A lease records the newest graph
   language (2), `ai` when the model and meter are present, and `render` and
   `canvas` when the render URL and key are present. The web additionally marks rendering
   unavailable while its own renderer is off. Activation
   needs one live lease covering the graph's version and actions, and fails
   closed without it.
4. Build/deploy the backend SDK and web together. Enable the existing campaign and
   content-draft feature configuration and required workspace entitlements.
5. Verify a controlled end-to-end event before enabling customer definitions.

The new webhook facade routes legacy and automation events through durable intake,
so deploy the worker before the web. Retain the v1 workflow/activity names and
deterministic interpreter for in-flight histories. The interpreter only changes
activity options for `generate_copy` and `render_creatives` nodes and adds the
`release-automation-classify-v1` activity for `classify` nodes; v1 graphs
contain none of them, so
v1 histories replay unchanged. A worker older than this change advertises
version 1, cannot be chosen to activate v2 graphs, and fails a v2 run it picks up
as `needs_attention` without side effects. Rolling the worker back therefore
needs active v2 definitions disabled first. Future interpreter changes need
Temporal versioning or a separate compatible workflow registration; graph schema
versioning alone is insufficient. Rollback must preserve the new tables/receipts
and sticky source mode. Do not roll the facade back to unconditional legacy intake
for opted-in sources; stop their intake/dispatch until compatible code is restored.

## Operations

The webhook returns 401 for invalid signatures, 400 for malformed supported
payloads, 202 for unsupported/unknown/inactive/duplicate deliveries, and 200 after
new durable acceptance. Persistence failures return an error, never success.
Acceptance has a six-second backend deadline and does no GitHub enrichment or
marketing work. GitHub does not automatically redeliver a failed delivery.

- **Before durable acceptance:** use GitHub App delivery history to inspect and
  manually redeliver the failed delivery after fixing storage/connectivity. Search
  by delivery and semantic event first. Do not invent a replacement provider event.
- **Stored event / outbox backlog:** inspect tenant outbox attempts, age, and
  dead letters. Restore the worker/Temporal, then use the existing authenticated
  tenant-outbox replay route. Stable workflow IDs make a lost start acknowledgement
  safe to recover. A customer run retry is a different operation.
- **Temporal outage or worker crash:** history remains in Postgres. Restore the
  same queue/registrations. Replayed activities use the same logical action keys.
- **GitHub rate limit:** rate-limit 403/429 responses are retryable with bounded
  backoff. If retries exhaust, wait for access to recover and use eligible run retry.
- **Revoked access:** reconnect/restore repository selection through the App flow.
  Cancelled work stays cancelled. Inspect preserved outputs before authorizing
  any new business action; a rule edit is not replay authorization.
- **Uncertain mail/provider outcome:** inspect the recipient receipt and provider
  logs. Confirm accepted vs definitely unsent before an operator repairs its
  disposition. Never clear an ambiguous receipt merely to make replay succeed.
- **Needs attention / association ambiguity:** inspect the recorded evidence,
  pinned version, node decision, and workspace audit trail. There is no blind
  retry button for an uncertain or permanently invalid run.

Structured `github_release_event` logs report accepted/duplicate/rejected/ignored
counts and acceptance latency. `release_automation_dispatch` correlates workspace,
logical run, Temporal execution, lag, start failure, and recovery attempt. Audit
events and persisted run/node states supply match/no-match, terminal outcome,
retry, access-revocation, and uncertain-notification evidence. Existing outbox
attempts/dead-letter reporting remains authoritative. Logs omit raw payloads,
credentials, and signed asset URLs.

Snapshots are bounded (512 KiB; notes 50,000 Unicode code points); raw webhook
payloads are not retained. History, versions, and receipts remain until workspace
purge, where the existing deletion job removes the new tenant records in dependency
order. There is no separate automatic age-based automation-history pruning in v1;
do not delete semantic/action receipts while redelivery must remain deduplicated.

## Verification

Pure contract/condition/normalization, v2 language, and shared template fixture
tests are in `internal/releaseautomation`; Temporal interpreter, generation
retry, recorded AI verdict branching, and lost-acknowledgement tests in
`internal/temporalreleaseautomation`;
database/tenant/action tests in
`internal/product/release_automation_integration_test.go` and
`release_automation_workflows_integration_test.go` (capability-gated
activation, charge-once generation, insufficient credits, history filters and
versions across tenants, run notifications, watched branches, AI verdicts
reused and billed once at three confidence levels, tag releases bundling
unreleased PRs, milestone releases, renders with and without a capture, and
legacy sources ignoring tag pushes). A shared vector checks the Go render
signer against the web verifier. Set
`PUBLISHING_TEST_DATABASE_URL` to an isolated migrated test database for those.
`test/workflow-contracts.test.ts` checks the Zod contracts, action registry,
render signatures, and templates against the same fixture.

The opt-in `test/e2e/release-automation.spec.ts` has two journeys. The first
drives the sidebar, GitHub connection and watched repository, a template with
AI copy, undo/redo and duplicate, draft validation, preview, activation and
versions, signed delivery, a real local Temporal worker, run inspection, real
release and campaign records in review, redelivery without duplicate output or
model calls, a needs-attention run, deactivation, mobile navigation, and the
old settings redirect. The second defines a release as a major or minor `v*`
tag with an AI relevance check, AI copy, and a rendered creative: two merged
PRs are bundled into the tag's release, the AI verdict and confidence appear
on the run, the web renders a real image from an uploaded product capture into
the campaign, a patch tag does not qualify, and a maintenance tag takes the AI
false branch. GitHub and the model provider are the protocol fixture
`scripts/e2e-release-automation-mock.mjs`; the renderer is a local headless
Chromium. This is not live GitHub, model, or deployed renderer verification. Run instructions are in
[the fixture guide](./release-automation-fixture.md).

Repository-specific production policies, GitHub Actions evidence, and delivery recovery
are documented in [GitHub production evidence](github-production-evidence.md).
