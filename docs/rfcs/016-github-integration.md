# RFC 016: GitHub Integration and Marketing-Worthy Change Detection

**Priority:** 016 — Reusable foundations
**Previous ID:** 022 ([renumbering map](renumbering-2026-10-24.md))
> **Roadmap disposition (2026-10-23):** Reuse GitHub intake and existing relevance checks. RFC 002 adds accountable human qualification instead of another classifier.
> See the [current execution order](README.md). Older decision text is
> historical wherever it conflicts with that order or the audited architecture.

**Status:** Partially implemented
**Status note (2026-10-16):** Shipped: the GitHub App, the install handshake, and release backfill. Missing: suggestions.
**Implementation update (2026-10-19):** [Release automation](../release-automation.md) implements administrator-authored, first-match release definitions and draft/review workflows. Its explicitly activated campaign action supersedes the blanket “never a campaign” statement below for opted-in sources only. Automatic relevance suggestions remain unimplemented; legacy merge collection remains the default. On 2026-10-20 the language gained budgeted AI channel copy (v2), watched-branch editing, run history filters, an AI relevance check node that decides whether an event is worth marketing, tag-push and closed-milestone triggers, version and PR-size fields, and release contents that bundle every unreleased merged PR. Unprompted relevance suggestions outside workflows remain unimplemented.
**Date:** 2026-08-17
**Revised:** 2026-10-15
**Historical dependencies:** RFC 015 and RFC 048
**Owners:** Engineering

## Decision

Connect GitHub and detect marketing-worthy merged PRs. Suggest campaigns.
Do not publish automatically. Shipping the product starts to create the raw
material for marketing the product.

The output of this pipeline is a `ChangeSuggestion`, never a campaign. A
founder accepts a suggestion to run Workflow 2. An integration that silently
created campaigns from every merge would produce noise the founder learns to
ignore.

## Design

Pipeline:

```text
Merged PR
   ↓
classify external relevance
   ↓
understand feature/change
   ↓
find corresponding ProductSurface
   ↓
update product context
   ↓
suggest campaign
```

Example:

```text
PR #452 merged: "Add recurring invoices"
        ↓
Marketing-worthy change detected.
        ↓
"Create feature launch?"
```

## Goals

- Zero-effort detection of shippable changes worth announcing.
- High precision. A false positive costs founder trust; a false negative costs
  one campaign they can still request manually.
- No repository content in prompts beyond metadata and paths.
- Graceful behavior for high-volume repositories.

## Non-goals

- Automatic screenshot capture from deployments. RFC 029 covers that.
- Automatic publishing.
- Reading file contents or diffs for release intake and automation. Titles,
  bodies, labels, and changed paths only. (Amended 2026-11-04: Code Studio
  reads the code behind a link a member imports; see
  [Code Studio](../code-studio.md#source-code-policy).)
- Issue tracking, code review, or any non-marketing GitHub feature.

## GitHub App

A GitHub App delivers webhook events to the existing webhook infrastructure
with signature verification.

Requested permissions, minimum viable:

| Permission    | Level | Why                                                          |
| ------------- | ----- | ------------------------------------------------------------ |
| Metadata      | Read  | Required baseline                                            |
| Pull requests | Read  | Titles, bodies, labels, changed file paths, signed images    |
| Contents      | Read  | Required for `release` events and release reads              |
| Deployments   | Read  | `deployment_status` events for production captures (RFC 029) |

GitHub has no separate releases permission: the `release` event and every
release endpoint sit under `Contents: read`. Because merges feed the next
published release, the App needs it.

Subscribed events: `pull_request` (closed), `release` (published), `deployment_status` (success), and the
`installation` and `installation_repositories` lifecycle events, which GitHub
delivers to every App.

Merges arrive as `pull_request` with `action: closed` and `merged: true`, not
as `push`. The App requests `Contents: read` for releases but does not subscribe
to pushes. The consequence is a product promise: the integration
tracks merged pull requests, not every commit to a branch. A direct push to
the watched branch produces nothing.

"Release automation never reads your source code" is therefore a policy, not
a permission: the App could read file contents, and release intake never
calls a contents endpoint. It reads release notes, PR titles, bodies, labels,
and changed file paths only. A team that wants the guarantee enforced by
permission can use a hand-made repository webhook, which needs no App
permissions.

**Amendment (2026-11-04):** Code Studio is the one reader of code, and only on
an explicit request. When a member imports a file permalink, pull request,
commit or gist, the backend reads that link with the workspace's installation
(or anonymously for public code), returns it to that member and stores
nothing; the code is kept only in a project the member saves. The audit log
records the repository and link kind, never the code. The one automation
that reads a diff, Automate's **Render a code visual**, runs only where a
workflow owner explicitly allowed it on that action. See
[Code Studio](../code-studio.md#source-code-policy).

### Installation mapping

```ts
GitHubInstallation {
  id
  workspaceId
  installationId        // unique across the platform
  accountLogin
  accountType           // User | Organization
  repositories[]        // selected repository IDs, or 'all'
  status                // active | suspended | revoked
  connectedByUserId
  installedAt
}
```

- Several workspaces may link one installation; each picks its own
  repositories, and a repository may be watched by several workspaces (once
  each). An App delivery fans out to every linked workspace's active source
  for that repository, each under its own rules.
- Mapping is established through an authenticated OAuth callback carrying a
  signed state value bound to the session and the workspace. A webhook alone
  never creates a mapping, because a webhook is unauthenticated with respect to
  our workspaces. The handshake is specified below.
- `installation.deleted` and `suspend` mark the record and stop processing
  without deleting history.
- Repository selection changes update the allowlist; events from unselected
  repositories are dropped.

### Connection handshake

GitHub runs two separate redirects, and only one of them proves anything:

- The installation **setup URL** receives an `installation_id`. GitHub
  documents that this value can be spoofed.
- The **user authorization callback** receives a single-use `code`. Enabling
  "Request user authorization during installation" sends the user here instead
  of the setup URL, and GitHub guarantees only the `code`.

The sequence:

1. A workspace administrator clicks Connect GitHub. We create a pending
   connection row: workspace, user, single-use `state`, short expiry. The
   social OAuth start (`social_oauth_start`) is the pattern to follow.
2. The browser goes to `github.com/apps/<slug>/installations/new`. The user
   picks the account and repositories on GitHub.
3. GitHub redirects back. We check `state` against the session and treat any
   `installation_id` on the URL as a hint only.
4. We exchange the `code` for a user access token, then call
   `GET /user/installations` and
   `GET /user/installations/{installation_id}/repositories`. The installation
   is claimed only if the user can see it, and only for repositories the user
   can see.
5. The user picks a watched branch per repository and the source activates.

### Repository sources and branches

Each watched repository is a `source_app` row: `provider: github`,
`externalId` set to the immutable repository ID (never the name, which changes
on rename or transfer), and a nullable `branch`. A null `branch` follows the
repository's current `default_branch` from the event payload, so a renamed
default branch keeps working. A set `branch` is matched exactly against
`pull_request.base.ref`. GitHub cannot filter deliveries by branch; the
filter runs on our side.

The App lists repositories with `Metadata: read`, but listing branches needs
`Contents: read`. The branch is therefore a text field defaulting to the
repository's default branch, not a picker.

**Decided (2026-10-16): one installation, many workspaces.** Uniqueness is
`(organizationId, provider, externalId)`, and `workspace_github_installation`
links workspaces to installations.

### Lifecycle

| Event                               | Behavior                                                   |
| ----------------------------------- | ---------------------------------------------------------- |
| `installation.created`              | Record the installation; never claim a workspace from it   |
| `installation.deleted`              | Archive every source on the installation; keep history     |
| `installation.suspend`              | Stop processing; events are acknowledged and dropped       |
| `installation.unsuspend`            | Re-verify repository access before resuming                |
| `installation_repositories.added`   | Refresh the repositories offered in settings               |
| `installation_repositories.removed` | Archive the affected sources immediately                   |
| Repository renamed or transferred   | Keyed on repository ID; refresh the name, re-verify access |

Without `installation_repositories.removed`, a workspace keeps showing a
repository as connected after GitHub access is gone, which is a correctness
and security bug rather than a settings detail.

## Webhook handling

The route is one of the raw-body exceptions to tRPC described in RFC 035.

1. Read the raw body and verify `X-Hub-Signature-256` with HMAC-SHA256 in
   constant time. Invalid signatures return `401` with no detail.
2. Resolve the installation to a workspace and the repository to an active
   source. Unknown installations are recorded and dropped.
3. Acknowledge events that ship nothing with `202`: `ping`, unmerged or
   off-branch pull requests, release actions other than `published`. A `4xx`
   would show as a failed delivery in the customer's GitHub settings.
4. Persist the event in one Postgres transaction before answering `2xx`. A
   failed write answers `5xx`, so the customer sees a failed delivery they
   can redeliver.
5. Process asynchronously once classification exists.

GitHub sends no timestamp header, so the five-minute freshness window from
the earlier revision cannot be implemented. GitHub also never redelivers on
its own; recovery is a manual or API redelivery, which keeps the original
`X-GitHub-Delivery`.

Idempotency has two layers, both enforced by Postgres unique indexes:

| Layer          | Key                                       | Purpose                                         |
| -------------- | ----------------------------------------- | ----------------------------------------------- |
| Business event | `source:<id>:pr:<repositoryId>:<number>`  | One release per merged pull request             |
| Business event | `source:<id>:release:<repositoryId>:<id>` | One release per published GitHub release        |
| Delivery       | `github:<X-GitHub-Delivery>`              | Receipt, processing, and retry tracking (async) |

The business key carries the defense. The signature covers the body but not
the delivery header, so a captured delivery replayed with a new delivery ID
must still be a no-op, and it is: the key comes from the signed body. The
delivery table becomes necessary when processing goes asynchronous (step 5),
because only then can an event be acknowledged and not yet processed. Until
then ingestion is synchronous: the release, its outbox event, and the audit
row commit together before the response, and a failed delivery left nothing
behind, so its redelivery reprocesses cleanly.

The route returns well inside GitHub's 10-second budget while ingestion is one
transaction. Classification calls a model, so it must run behind the outbox,
never on the webhook connection.

## Change worthiness

Classification is two-stage, cheap first.

### Stage 1: deterministic filters

Dropped before any model call:

| Condition                                                   | Reason                    |
| ----------------------------------------------------------- | ------------------------- |
| PR closed without merging                                   | Nothing shipped           |
| Base branch is not a release branch                         | Not in production         |
| Author is a known bot                                       | Dependency noise          |
| Title matches chore, docs, test, ci, refactor, build, style | Conventional non-features |
| Every changed path is internal                              | Tests, CI, config, docs   |
| Labeled `internal`, `no-marketing`, `chore`                 | Explicit opt-out          |
| Fewer than a minimum number of changed files                | Trivial                   |
| Repository not in the allowlist                             | Out of scope              |

Path classification uses a default rule set plus workspace overrides, so a team
whose UI lives in an unusual directory can correct it once.

The filters are the precision mechanism. Most merges in most repositories are
not marketing events, and cheap rules should remove them before spending a
model call.

### Stage 2: model classification

One schema-validated call over the title, body, labels, and changed paths.
Never file contents.

```ts
{
  isExternallyMeaningful: boolean
  confidence: 0.0-1.0
  changeType: 'feature' | 'improvement' | 'fix' | 'performance' | 'internal'
  userFacingSummary: string        // one sentence, founder-readable
  suggestedFeatureName: string
  affectedSurfaceHints: string[]
}
```

Thresholds:

| Confidence | Action                                             |
| ---------- | -------------------------------------------------- |
| ≥ 0.75     | Create a suggestion                                |
| 0.5 – 0.75 | Create a low-confidence suggestion, visually muted |
| < 0.5      | Record the decision, create nothing                |

Every decision is recorded either way, so the filter is tunable against real
data and a founder can ask why a PR produced nothing.

### Prompt injection

PR titles and bodies are attacker-controlled in any repository accepting
outside contributions. The defenses match RFC 017: content is delimited data,
the call has no tools, output is schema-constrained, and the result is a
suggestion a human accepts. A successful injection produces a suggestion the
founder declines.

## Suggestions

```ts
ChangeSuggestion {
  id
  workspaceId
  source                // github_pr | github_release
  externalRef           // repo, PR number, merge SHA
  title
  summary
  changeType
  confidence
  matchedSurfaceIds[]
  status                // pending | accepted | dismissed | expired | superseded
  campaignId?           // set on acceptance
  createdAt
  decidedAt, decidedByUserId
}
```

Behavior:

- A suggestion is created, not a campaign. Accepting runs Workflow 2 (RFC 048).
- Dismissing records the reason and feeds filter tuning.
- Suggestions expire after 30 days. A month-old merge is no longer news.
- Related merges within a short window merge into one suggestion rather than
  producing several, since a feature often lands across several PRs.
- Suggestions are deduplicated on `(repositoryId, prNumber)`.

### Volume control

Active repositories merge many PRs. Without limits, this becomes a notification
firehose.

| Limit                              | Default     |
| ---------------------------------- | ----------- |
| Suggestions per workspace per day  | 3           |
| Suggestions per workspace per week | 10          |
| Classification calls per hour      | Plan-scoped |
| Grouping window for related PRs    | 24 hours    |

At the cap, further qualifying changes accumulate into a digest suggestion
naming several changes rather than being dropped. A weekly digest of five
shipped improvements is often better marketing material than five separate
announcements.

## Product context updates

An accepted or high-confidence suggestion updates `ProductProfile` under the
RFC 017 precedence rules, at `github` rank:

- A new feature may be added to `features[]`.
- Manually locked fields are never overwritten.
- Updates from a dismissed suggestion are reverted.

GitHub outranks page extraction because a merged PR is stronger evidence than a
marketing page, and ranks below manual edits because the founder is
authoritative about their own product.

## Backfill

On connection, backfill the last 30 days of merged PRs, capped at 100, running
the same filters. Backfill produces at most one digest suggestion rather than
30 individual ones, and is clearly labeled as historical.

Backfill is rate-limit aware and resumable. It never blocks connection: the
integration is usable immediately and backfill completes in the background.

## Rate limits

- Respect `X-RateLimit-Remaining` and `Retry-After`, backing off before
  exhaustion.
- Use installation tokens, cached until shortly before expiry.
- Secondary rate limits back off exponentially with jitter.
- Per-installation request budgets prevent one busy workspace from consuming
  the platform's allowance.
- Webhook payloads carry most needed data, so steady-state API use is low.

## Authorization

| Operation            | Permission         |
| -------------------- | ------------------ |
| Connect GitHub       | `workspace:update` |
| Disconnect           | `workspace:update` |
| View suggestions     | `workspace:read`   |
| Accept a suggestion  | `release:create`   |
| Dismiss a suggestion | `release:create`   |
| Edit path rules      | `workspace:update` |

Webhook processing runs as a service principal scoped to the resolved
workspace. It can create suggestions and update product context. It cannot
create campaigns, approve, or publish.

## Failure behavior

| Failure                      | Behavior                                        |
| ---------------------------- | ----------------------------------------------- |
| Invalid signature            | `401`, no processing, security event            |
| Duplicate delivery           | `202`, no processing                            |
| Unknown installation         | Recorded and dropped                            |
| Workspace suspended          | Event stored, processing deferred               |
| Classification fails         | Retried twice, then recorded with no suggestion |
| Model outage                 | Events queue; drained on recovery               |
| Rate limited                 | Backoff; webhook processing continues           |
| Installation revoked mid-run | Processing stops; history retained              |

No GitHub failure ever affects campaign creation, approval, or publishing. The
integration is a suggestion source, and it must be able to be entirely down
without degrading the core product.

## Observability

- Events received, filtered by stage, and classified.
- Suggestion creation rate and acceptance rate, which is the precision metric.
- Dismissal reasons.
- Classification cost per workspace.
- Rate-limit proximity per installation.
- Time from merge to suggestion.

Acceptance rate is the number that decides whether the feature stays. Below
roughly one in three, the filters are wrong and the feature is generating
noise.

## Acceptance criteria

1. A merged, externally meaningful PR produces "We noticed you shipped X.
   Create a feature launch?" within minutes. Internal PRs produce nothing.
2. An invalid signature is rejected with no processing.
3. A duplicate delivery ID produces exactly one suggestion.
4. A replayed delivery outside the timestamp window is rejected.
5. A bot-authored dependency PR produces nothing and costs no model call.
6. A `chore:` PR is filtered before classification.
7. A PR labeled `no-marketing` produces nothing.
8. A PR body containing injected instructions changes no control flow.
9. No release-automation prompt ever contains file contents or a diff.
10. Accepting a suggestion runs Workflow 2 and produces a `DRAFT` campaign.
11. Dismissing records a reason and updates no product context.
12. Three related PRs within 24 hours produce one suggestion.
13. Exceeding the daily cap produces a digest, not dropped changes.
14. Connecting backfills 30 days as one historical digest.
15. An installation cannot be claimed by a second workspace.
16. Revoking the installation stops processing and retains history.
17. GitHub being unavailable does not affect any other product function.

## Rollout

0. **Shipped:** the per-source webhook route (`/api/webhooks/source/{id}`)
   handles `ping`, merged pull requests filtered by `source_app.branch` and
   `externalId`, and release `published` only. A repository webhook configured
   by hand creates one draft release per merged PR. The parser
   (`githubPullRequestEventSchema` in `lib/tenant/webhook-security.ts`) is the
   normalization layer the App webhook reuses; neither route owns release
   logic. Until the suggestion pipeline exists, a merge creates a draft
   release, not a `ChangeSuggestion`. Edge behavior verified end to end:
   - A hand-made repository hook defaults to the `form` content type, which
     wraps the JSON in a `payload` field. Both encodings are accepted.
   - Only the shipped action is parsed in full, so a label change, edit, or
     push never fails on its payload shape; a malformed merge still answers
     `400` so the failure is visible in the delivery log.
   - PR and release text from GitHub is third-party input: HTML comments
     (PR templates), invisible and control characters (NUL fails a Postgres
     insert on every redelivery) are removed, and titles and notes are cut to
     fit rather than rejected.
   - A GitLab source creates a release only for `Release Hook` with action
     `create`. Any other answer would count toward the four consecutive
     failures after which GitLab disables the hook.
   - Each source carries rules, set on create and changed with
     `PATCH /api/v1/source-apps/{sourceAppId}` (`source:write`):
     `ignoreBotPullRequests` (default on) drops PRs whose author is a GitHub
     App bot (`type: Bot` or a `[bot]` login); `ignoredPullRequestAuthors`
     drops listed logins case-insensitively, with or without the bot filter;
     `skipPrereleases` (default off) drops pre-releases. The filter reads the
     author, not who merged, so a merge bot landing a person's PR is kept.
   - Setup without an operator: creating a source (Developer API settings,
     or the API without `secretReference`) returns its webhook URL and a
     secret, shown once. The secret is derived from `SOURCE_WEBHOOK_SIGNING_KEY`
     and the source ID, so no secret is stored. Rotating the key re-keys every
     such source; a single lost secret means a new source. GitLab generates
     its own signing token, so GitLab sources still need an operator-managed
     `secretReference`.
   - Verified against real GitHub on a disposable repository: 81 deliveries
     across a JSON hook and a default-`form` hook, merge, squash, and rebase
     merges, a real Dependabot PR, drafts, pre-releases, and edits, with no
     failed delivery. GitHub's captured request replayed byte for byte, or
     under a forged delivery ID, returned the existing release.
1. Ship the GitHub App, the connection handshake, the lifecycle events, and
   one App-level route (`/api/webhooks/github`, one secret) sharing the
   Phase 0 parser. Classify nothing.
2. Run deterministic filters in shadow mode on real repositories; measure how
   many events survive.
3. Add classification in shadow mode; measure precision against founder
   judgment before showing anything.
4. Enable suggestions for internal workspaces; measure acceptance.
5. Enable broadly with volume caps.
6. Add backfill and digests.

Shadow mode before exposure is essential here. The cost of launching a noisy
detector is that founders disable the integration and do not re-enable it.

## Out of scope

- Automatic screenshot capture from deployments. RFC 029 covers that.
- Automatic publishing.
- GitLab and Bitbucket, which reuse the same suggestion model later.

## As built (2026-10-16)

- **Merges feed the next release.** A merged PR into the watched branch is a
  `source_change`, held until the source's next published release, which
  takes every held change as a feature. No release is created per merge.
- **Full notes.** A release stores its notes in full (cleaned, 50,000
  characters); `releasenotes` parses GitHub's generated notes, section
  headings, and conventional prefixes into features (feature, improvement,
  fix, internal, other) and the PRs they name. The drafter reads the stored
  notes as a fenced source instead of fetching the GitHub page, so private
  repositories work.
- **Connection.** Settings → Connect GitHub → `/integrations/github/start`
  (single-use state) → GitHub install → `/integrations/github/setup` → GitHub
  authorization → `/integrations/github/callback` → the backend exchanges the
  code and checks `GET /user/installations` before linking. GitHub secrets
  (App key, client secret) live in the backend; the web holds the slug,
  client ID, and webhook secret.
- **Linking an existing installation.** When the App is already installed on
  the account, GitHub sends `installations/new` to the installation's settings
  page, drops the `state`, and offers nothing to submit. So a second workspace
  uses Link existing installation instead: GitHub authorization alone, with
  installation `0` in the state. The backend links the one reachable
  installation the workspace has not linked; with several it answers 409 with
  the choices, keeps their verified IDs on the single-use grant, and accepts
  only one of those IDs (no new code) from `/integrations/github/choose`.
- **App webhook.** `/api/webhooks/github` verifies the App secret, keeps
  installations current (`installation`, `installation_repositories`), and
  fans repository events out per workspace. A webhook never links a workspace.
- **Worker.** Outbox events run in the Go worker: `source_change.collected`
  records changed file paths; `release.ingested` stores screenshots from the
  release and its PRs (GitHub image hosts only, signed URLs read through the
  App at download time); `source_app.connected` backfills the last five
  releases and the merges since; `deployment.succeeded` is RFC 029.
- **Found against real GitHub.** GitHub lists releases by their commit's
  date, not by when they were published, so backfill scans a page and takes
  the five most recently published (pre-releases dropped first when the
  source skips them). In a private repository, an image stored in the
  repository renders in `body_html` as an unsigned `blob?raw=true` or
  `raw.githubusercontent.com` URL that 404s anonymously; the worker reads
  those from `raw.githubusercontent.com` with the installation token, only
  for the source's own repository, never following a redirect with it.
- **Not built:** model classification, suggestions, volume caps, and digests
  remain as specified above.
