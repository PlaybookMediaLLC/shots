# RFC 030: Social Publishing Abstraction

**Priority:** 030 — Reusable foundations
**Previous ID:** 020 ([renumbering map](renumbering-2026-10-24.md))
> **Roadmap disposition (2026-10-23):** Maintain existing publishing reliability. Social variants are optional kit outputs; wider network parity is deferred.
> See the [current execution order](README.md). Older decision text is
> historical wherever it conflicts with that order or the audited architecture.

**Status:** Partially implemented (see `lib/tenant/publishing-backend.ts` and `server/internal/publishing`)
**Status note (2026-10-17):** Settings → Channels connects X, LinkedIn and Instagram, and the launch Schedule dialog schedules approved posts (#129). Missing: disconnect, provider token revocation, and publishing for the Facebook Login Instagram flow.
**Phase 0 update (2026-10-16):** Launch visuals become schedulable: `ApproveCampaignDesign` creates an approved creative variant from a design's render, and `ScheduleCampaignPost` accepts that variant, checks the post channel against the connection platform, and reschedules after CANCELLED or FAILED (never after UNKNOWN_DELIVERY). Posts report their scheduled post's state instead of a write-back from the publish workers. The Approve visual, Schedule, and Channels screens ship with SDK 0.1.12.
**RFC 026 update (2026-10-17):** A workspace API key with the opt-in `post:schedule` scope may schedule approved content and cancel scheduled posts, through `/api/v1` and MCP. See Agents under Authorization.
**Date:** 2026-08-17
**Revised:** 2026-10-14
**Historical dependencies:** RFC 015 and RFC 012
**Owners:** Engineering

## Decision

Keep the social API as the social infrastructure. Do not build direct Twitter,
LinkedIn, or Instagram integrations. Hide the social API behind one application-owned
abstraction so it stays replaceable.

The application owns scheduling, state, idempotency, retries, and recovery.
The provider owns only the final network call. If the social API disappeared, the
`ScheduledPost` lifecycle would be unchanged and a replacement adapter would
implement one function.

## Status of this document

This RFC is a backfill. The scheduling and publication path shipped before the
document described it in full. The "Shipped contract" sections record behavior
in `main` today. "Planned refinements" records proposed work that has not
shipped. The web app now starts and completes X and Instagram OAuth through
the Go service, while live provider validation remains a release gate.

## Goals

- One provider seam, narrow enough to re-implement in a day.
- Exactly-once publication in practice, with no silent duplicate posts.
- Durable scheduling that survives worker crashes and deploys.
- A stored receipt linking every published post to its provider post ID.

## Non-goals

- Direct social-network API integration of any kind.
- Cross-posting fan-out from one call to many networks.
- Analytics ingestion. RFC 039 covers performance.
- Provider-specific composer features such as threads, polls, or carousels
  beyond a single image.

## Layers

```text
Campaign post (approved)
        │
        ▼
scheduleCampaignPost            application scheduling decision
        │
        ▼
ScheduledPost row               durable state, idempotency key, timing
        │
        ▼
publishDueScheduledPosts        claim, verify, attempt, record
        │
        ▼
publishSocialPost               the only provider-aware function
        │
        ▼
social HTTP API                 upload media, create post
        │
        ▼
X / LinkedIn / Instagram
```

The Go backend owns provider calls and scheduling state; the web reaches it
only through `lib/tenant/publishing-backend.ts`. The backend also checks the
operator-provisioned web-to-Go organization binding on the social path, and
the OAuth routes register returned Go destinations against that binding.

## Provider contract

A scheduler provider implements one operation:

```ts
publish(input: {
  organizationId: string
  destinationId: string      // provider integration ID
  platform: string           // 'x' | 'linkedin' | 'instagram' | ...
  caption: string
  asset: { objectKey: string; mediaType: string }
  providerSettings: unknown  // opaque, provider-validated
  secretReference: string    // env var name, never a secret value
  expectedGoOrganizationId: string // operator-verified tenant binding
}): Promise<string>          // provider post ID
```

Failures raise a typed provider error carrying an HTTP status or `null` for
transport failures. The caller classifies retryability from that status. A
provider adapter must not retry internally, must not write to the database, and
must not log the credential or the caption.

Adding Buffer or Post Bridge means writing this one function plus a capability
row. It does not mean touching the state machine.

## Provider capabilities

Capability limits are a per-platform table, resolved before a post is
scheduled rather than discovered at publish time.

| Platform  | Caption limit | Media                   | Notes                            |
| --------- | ------------- | ----------------------- | -------------------------------- |
| X         | 280           | 1 image                 | Long-form needs a paid tier      |
| LinkedIn  | 3,000         | 1 image                 | First 140 characters are visible |
| Instagram | 2,200         | 1 image, requires media | Caption-only posts are invalid   |

The shipped implementation enforces a single global 3,000-character limit in
`scheduleCampaignPost`. That is permissive for X and strict for nothing. The
planned refinement replaces it with this table. Until then, an over-length X
caption fails at the provider rather than at scheduling, which is a worse
error location but not a correctness failure.

## Credential handling

The shipped model is deliberately conservative. `ChannelConnection.secretReference`
stores an environment variable **name**, not a secret. The name must match
`^SOCIAL_(?:API_KEY|OAUTH_TOKEN)(?:_[A-Z0-9_]+)?$`. The publish path reads
`process.env[secretReference]` at call time.

This gives three properties:

1. No provider credential is ever written to PlanetScale.
2. A database dump contains no usable publishing capability.
3. The regex prevents a tenant-supplied reference from reading an arbitrary
   environment variable such as `DATABASE_URL`. This is the important guard: the
   reference is tenant-influenced input used as an environment lookup key, and
   without the pattern check it would be an environment-variable disclosure
   primitive.

An operator creates a one-to-one `SocialTenantBinding` between the web
organization, Go organization, and credential reference. The binding command
reads Go `/public/v1/me` before writing it. Channel registration requires the
same reference and checks Go `/me` and `/integrations`; publishing checks them
again before media upload. X and both Instagram variants have web-initiated
OAuth routes that tie Go's one-use state to the active web organization, user,
and session before registering the returned destination. Live provider
connections are still unverified.

## Authorization

Every publishing operation is guarded by `publish:manage`, which
`lib/auth/permissions.ts` grants to `owner`, `admin`, and `publisher`. Notably
`approver` does not hold it: approving content and pushing it to a public
channel are deliberately separate capabilities, so the role that signs off on a
message cannot unilaterally broadcast it.

Read and write operations are not guarded equally. `lib/trpc/routers/publishing.ts`
uses `organizationProcedure('publish:manage')` for listing and
`sensitiveOrganizationProcedure('publish:manage')` for every mutation:

| Operation                   | Procedure                                | Requires fresh 2FA |
| --------------------------- | ---------------------------------------- | ------------------ |
| List channel connections    | `organizationProcedure`                  | no                 |
| Create a channel connection | `sensitiveOrganizationProcedure`         | yes                |
| Start X/Instagram OAuth     | `requireSensitiveOrganizationPermission` | yes                |
| List scheduled posts        | `organizationProcedure`                  | no                 |
| Create a scheduled post     | `sensitiveOrganizationProcedure`         | yes                |
| Cancel a scheduled post     | `sensitiveOrganizationProcedure`         | yes                |

`sensitiveOrganizationProcedure` checks the permission twice: once against the
active organization, then again through `requireSensitiveOrganizationPermission`,
which additionally demands a recent two-factor session. The reasoning is that
scheduling is the last reversible moment before content becomes public and
binding a channel connection confers the ability to speak as the tenant. Both
warrant proof of a live, strongly authenticated human rather than a long-lived
cookie.

This is the one place where the platform's general rule that reads and writes
share an authorization path is deliberately broken, and the asymmetry is the
point: observing the schedule is routine, changing it is not.

Tenancy follows the platform invariant. `organizationId` is resolved from the
session principal by `requireActiveOrganizationPermission` and is never read
from client input. The backend resolves both the connection and the variant
scoped by `organizationId`, so a `channelConnectionId` naming another
tenant's connection selects nothing and returns `404` rather than a
permission error.
The surface does not confirm the existence of records the caller cannot see.

### Agents

RFC 026 lets an agent schedule, because the owners asked for it. An agent
still never approves anything. A workspace API key may change the schedule
only when an owner or admin gave it the `post:schedule` scope. That scope is
never on by default, in Settings or on the agent consent page. With it, the key
may:

- create a scheduled post;
- cancel a scheduled post;
- schedule an approved campaign post (`ScheduleCampaignPost`).

A key reads the schedule with `artifact:read`.

For an agent, the proof of a person moves to two places: the person who
approved the content, and the person who granted the scope. A key has no second
factor to check, so the fresh-2FA rule above still applies to sessions only.
The Go backend rechecks the key's scope itself (`AuthorizeAPIKeyScope`) before
it schedules or cancels. It does not rely on the caller's check.

The same lookup carries two further predicates that make scheduling fail closed:
the connection must be `ACTIVE`, and the variant must be `APPROVED` with an
`APPROVED` approval record. Authorization alone is therefore not sufficient to
schedule. A publisher with a valid permission still cannot schedule unapproved
content, which is where the "machines create, humans approve" invariant is
enforced structurally rather than by convention.

## Scheduling contract

`createScheduledPost` requires an idempotency key and enforces uniqueness on
`(channelConnectionId, idempotencyKey)`. The flow:

1. Look for an existing post with the same key. If found, return it with
   `created: false`. The call is safely repeatable.
2. Verify the connection is `ACTIVE`, `social`, and organization-owned.
3. Verify the variant is `APPROVED` with an `APPROVED` `Approval` row.
4. Insert the row as `SCHEDULED` and write `post.scheduled` to the audit log in
   the same transaction.
5. If a concurrent insert wins the unique constraint, catch `P2002`, re-read,
   and return the winner. The race resolves to one row, never to an error.

`scheduleCampaignPost` supplies a fresh UUID per call. REST callers may supply
their own key through the `Idempotency-Key` header. The default publish time
comes from `WorkspaceSettings.defaultPublishTime` in the workspace time zone
when no explicit time is given.

## Publication lifecycle

```text
SCHEDULED ──claim──► PROCESSING ──Go receipt──► PROCESSING ──remote receipt──► PUBLISHED
                          │
                          ├──retryable (429, attempts < 3)──► SCHEDULED
                          │
                          ├──permanent failure──► FAILED
                          │
                          └──ineligible at publish time──► CANCELLED

SCHEDULED ──user cancel──► CANCELLED
```

### Claiming

```ts
updateMany({
  where: { id, status: 'SCHEDULED', scheduledFor: { lte: now } },
  data: { status: 'PROCESSING' },
})
```

A claim succeeds when exactly one row is updated. This is a conditional
compare-and-set, so two workers processing the same due post produce one owner
and one no-op. No distributed lock service is required.

### Re-verification after claiming

After claiming, the worker re-loads the post with its connection and variant
and re-checks eligibility:

- `channelConnection.status === 'ACTIVE'`
- `variant.status === 'APPROVED'`
- `variant.approval.status === 'APPROVED'`
- the workspace is operational, meaning not suspended or pending deletion

The worker also checks the web-to-Go organization binding and whether the Go
destination remains enabled. A missing binding or disabled Go destination
fails the post before upload with a visible publication attempt. It is not
recorded as a user cancellation.

Failing any check cancels the post and writes `post.cancelled`. Approval can be
revoked and a connection can be disabled between scheduling and the scheduled
instant, and the system must honor the newer decision. Nothing publishes on the
strength of a check performed hours earlier.

### Attempts

Each provider call creates a `PublicationAttempt` row before the call. The Go
create response saves its post ID on that attempt, but does not complete it.
The worker polls the organization-scoped Go status endpoint. `QUEUE` stays
`PROCESSING`; `PUBLISHED` with a remote release ID completes the attempt as
`SUCCEEDED`; `ERROR` completes it as `FAILED`. A lookup failure leaves the
attempt open and never issues another create request.

Retry policy is narrow by design:

- Retry only `429` responses, and only up to 3 attempts.
- Every other failure, including timeouts and `5xx`, is terminal for that post.

The reason is that a social post is not idempotent at the provider. The social API's
create-post endpoint accepts no idempotency key, so a retried request after an
ambiguous failure can produce a duplicate public post. A duplicate post is
worse for a founder than a failed post, because the failure is recoverable and
the duplicate is embarrassing. The policy deliberately biases toward
under-delivery. A `429` is safe to retry because it is a definitive refusal:
the provider states that it did nothing.

### Stale recovery

A sweep runs before each processing batch and handles workers that died while
holding a claim, using a 10-minute threshold:

| Condition                                           | Interpretation                     | Action                                  |
| --------------------------------------------------- | ---------------------------------- | --------------------------------------- |
| `PROCESSING`, stale, **no** open attempt            | Died before calling the provider   | Return to `SCHEDULED` for a clean retry |
| `PROCESSING`, stale, open attempt **without** Go ID | Died with an in-flight call        | Mark `FAILED` with `UNKNOWN_DELIVERY`   |
| `PROCESSING`, open attempt **with** Go ID           | Go accepted; remote result pending | Poll Go status, never create again      |

The second case is the ambiguous one and it fails closed. The attempt row is
completed as `FAILED`, the post is `FAILED`, and
`post.publish_recovery_required` is audited so an operator can check the
account and decide. The system never guesses that an in-flight call did not
land.

### Cancellation

`cancelScheduledPost` succeeds from `DRAFT`, `SCHEDULED`, and `FAILED`. It
returns `409` from `PROCESSING` and `PUBLISHED`, because the provider call may
already be in flight or complete. Cancelling an already-`CANCELLED` post
returns the post unchanged rather than erroring, so a repeated cancel is safe.

Amended 2026-11-13: Shots can delete a post it published. A delete is a
separate, audited action with its own receipts; cancellation still refuses a
`PUBLISHED` post. See [delete a published post](../scheduling/post-delete/implementation.md).

## Media handling

The worker reads the asset from the private R2 bucket using the tenant-scoped
object key, uploads it to the social API as multipart form data, and references the
returned upload in the post payload. The asset bytes never pass through a
public URL, and the provider never receives a signed link into the bucket.

`providerSettings` is stored per connection as opaque JSON, validated as a
string-keyed JSON record, and merged with `__type: platform` at publish time.
Platform-specific requirements live in that blob so the state machine stays
platform-agnostic.

## Receipts and lineage

A Go acceptance stores `providerPostId` on the attempt and audits
`post.accepted_by_scheduler`. The post becomes `PUBLISHED` and the attempt
`SUCCEEDED` only after Go reports a remote release ID and published state.
The full chain is queryable:

```text
Release → Asset → CreativeVariant → Approval
                        │
                        ▼
                  CampaignPost → ScheduledPost → PublicationAttempt
                                                         │
                                                  providerPostId
```

RFC 039 joins performance data onto `providerPostId`. Lineage is a set of
foreign keys, so attribution is a join rather than an inference.

## Failure matrix

| Failure                           | Detection                    | Behavior                              |
| --------------------------------- | ---------------------------- | ------------------------------------- |
| Social unreachable                | fetch throws, 15s timeout    | Attempt fails, post `FAILED`          |
| Social `429`                      | status check                 | Requeue, up to 3 attempts             |
| Social `4xx` other                | status check                 | Post `FAILED`, no retry               |
| Social `5xx`                      | status check                 | Post `FAILED`, no retry               |
| Malformed provider response       | Zod parse failure            | Post `FAILED`                         |
| Missing credential env var        | lookup returns undefined     | Post `FAILED` before any network call |
| Invalid secret reference pattern  | regex check                  | Post `FAILED` before any lookup       |
| Asset missing from R2             | storage read throws          | Post `FAILED`                         |
| Connection revoked before publish | eligibility re-check         | Post `CANCELLED`                      |
| Approval revoked before publish   | eligibility re-check         | Post `CANCELLED`                      |
| Workspace suspended               | operational check            | Post `CANCELLED`                      |
| Worker crash before provider call | stale sweep, no open attempt | Requeued to `SCHEDULED`               |
| Worker crash during provider call | stale sweep, open attempt    | `FAILED` with `UNKNOWN_DELIVERY`      |

## Security threats

| Threat                                        | Mitigation                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| Arbitrary environment variable disclosure     | Strict regex on `secretReference`                                          |
| Credential leakage through logs               | Errors carry status codes only, never bodies or tokens                     |
| Cross-tenant publication                      | Tenant-scoped queries, one-to-one Go binding, `/me` and destination checks |
| Publishing unapproved content                 | Eligibility re-checked immediately before the call                         |
| Duplicate public posts                        | Claim CAS, unique idempotency key, no ambiguous retries                    |
| Publication from a suspended workspace        | Operational check inside the worker                                        |
| Provider response injection into stored state | Zod parses the response before persistence                                 |

## Observability

Per workspace and per platform:

- posts by status, and the age of the oldest `SCHEDULED` post past its time;
- publication success rate and attempt count distribution;
- provider latency at p50 and p95, and timeout count;
- `UNKNOWN_DELIVERY` count, which should be near zero and alerts when not;
- count of posts cancelled by eligibility re-check, split by reason.

Scheduling lag, meaning `publishedAt - scheduledFor`, is the user-visible
quality metric. A founder who scheduled 9:00 and published at 9:40 experienced
a broken product even though every state transition was correct.

## Acceptance criteria

1. An approved post schedules, publishes at its scheduled time, and stores a
   Go post ID plus a confirmed remote release ID before marking `PUBLISHED`.
2. Cancelling before publish prevents the publication and audits the cancel.
3. Cancelling a `PROCESSING` post returns `409`.
4. Two identical schedule calls with the same idempotency key create one row.
5. Two workers claiming the same due post produce one publication.
6. A `429` requeues and succeeds on a later attempt; a fourth `429` fails the
   post.
7. A `500` fails the post without a retry.
8. A revoked connection cancels the post instead of publishing it.
9. A variant whose approval is revoked after scheduling is cancelled.
10. A `secretReference` of `DATABASE_URL` is rejected before any lookup.
11. A worker killed after an uncertain Go create request does not issue a
    second create request; the attempt remains pending for reconciliation.
12. No log line, error message, or audit entry contains a provider token.

## Planned refinements

1. **Live OAuth proof.** Validate X and both Instagram variants with dedicated
   developer apps and test accounts. The Go service owns social access and
   refresh tokens; the web app retains only an organization credential
   reference and a destination ID.
2. **Per-platform capability enforcement.** Move the caption limit and media
   requirements into the capability table above and validate at schedule time.
3. **Future-dated provider scheduling.** The adapter currently sends
   `type: 'now'` with the current timestamp, so our worker owns timing entirely.
   Handing `scheduledFor` to the social API would reduce lag but move timing authority
   to the provider and complicate cancellation. Keep worker-owned timing unless
   measured lag justifies the change.
4. **Reconciliation sweep.** A periodic job that lists recent provider posts and
   reconciles them against `PublicationAttempt` rows would resolve
   `UNKNOWN_DELIVERY` automatically instead of leaving it for an operator.
5. **Connection health checks.** Probe connections on a schedule and mark them
   `DISABLED` before a scheduled post discovers the failure.
6. **Threads and multi-image posts.** Requires a payload model richer than one
   caption plus one image.

## Out of scope

- Performance ingestion. RFC 039 covers analytics.
- Any direct social-network API integration.
