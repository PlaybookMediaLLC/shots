# RFC 024: The Settings Platform and Social Sets

**Priority:** 024 — Reusable foundations
**Previous ID:** 043 ([renumbering map](renumbering-2026-10-24.md))
> **Roadmap disposition (2026-10-23):** Maintain existing workspace, membership and connection settings. Unrelated settings/social-set expansion is deferred.
> See the [current execution order](README.md). Older decision text is
> historical wherever it conflicts with that order or the audited architecture.

**Status:** Accepted; implementation tracked in [the coverage matrix](../implementation/typefully-settings-coverage.md)

**Date:** 2026-10-20

**Owners:** Product Engineering

**Historical dependencies:** RFC 009, RFC 015, RFC 030, RFC 023, RFC 013, RFC 026, RFC 042

## Decision

Expand the existing route-based settings into the settings platform the
[Typefully settings research](../scheduling/typefully/settings/typefully-settings-spec.md)
describes. Every setting belongs to exactly one owner, and that owner decides
where it is stored, who may change it, and what it changes:

| Owner             | Record                                                         | Examples                                                                                                                                                      |
| ----------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User              | `user_preference`                                              | Display time zone, theme, navigation layout, week start, editor direction, scrollbars, help tips, development mode, email master switch, experiment opt-ins   |
| Workspace         | The organization and its existing rows                         | Plan and billing, members and roles, API keys, notification policy, integrations, audit, security, deletion, review policy, experiments an admin turns off    |
| Social set        | `social_set` and `social_set_writing_sample`                   | Name, colour, accounts, scheduling time zone, weekly slots, natural posting times, new-draft defaults, engagement defaults, public profile, Writing Assistant |
| Connected account | `channel_connection` (unchanged as the publishing destination) | Provider, external account, identity, health, capabilities                                                                                                    |

A team is a workspace. The organization, membership, invitation and role model
already is the access and ownership boundary, so this RFC adds no second team
system. "New team" creates a workspace.

## Social sets

A social set is a publishing identity: the accounts one person or brand posts
from, with that identity's schedule, defaults and writing voice. It belongs to
one workspace.

- **Identity.** A set has a stable cuid. Names are not unique; two sets named
  "Acme" are two sets. Every operation names the set by ID.
- **Accounts.** A `channel_connection` belongs to at most one set
  (`socialSetId`). A set holds at most one active account per platform; a
  partial unique index enforces it. That matches the draft model, which keys
  per-channel text by platform.
- **Visibility.** A set is shared with the workspace or private to its owner.
  A private set, its accounts, its drafts and their notifications are visible to
  its owner only. An API key never sees private sets, because a key is a
  workspace credential, not a person.
- **Sharing.** "Move to team" shares a private set with its workspace. Only the
  set's owner can do it, holding `publish:manage`, after a confirmation that
  lists the accounts and drafts that become visible. It is one-way and audited.
  A set can also be copied to another workspace where the actor also holds
  `publish:manage`; the copy takes the configuration and the accounts are
  connected again there.
- **Moving to another workspace** (decided 2026-11-13, replacing the earlier
  copy-only rule). The set's owner, or a workspace owner or admin for a shared
  set, moves it to another workspace they own or administer whose plan
  includes drafts, after a preview of what moves and what breaks. The set keeps
  its ID and settings, and its drafts move with their comments, backups, tags,
  finishers and writing samples; their files are copied into the destination's
  library. Channel connections stay bound to their workspace's social tenant
  (`social_tenant_binding`): they stay behind, disconnected, and are connected
  again in the destination. Queued posts are cancelled and their drafts arrive
  unscheduled. The move is refused while a post is publishing or may already
  be live, while the set has bulk batches, and for a workspace's last shared
  set. Published history, analytics and audit stay in the source, in a deleted
  copy of the set that keeps their visibility; the destination's history starts
  with a moved-in entry. The set row is locked and its previewed version
  checked, so a repeat or a race moves it once. API keys cannot move a set.
- **Deletion.** Deleting a set is refused while any of its posts is queued or
  publishing. Otherwise its accounts are disabled (so nothing further publishes
  through them), its drafts are archived, its row is soft-deleted, and the
  change is audited. Publication history is kept. The last set of a workspace
  cannot be deleted.
- **Removing an account.** Removal cancels the account's queued posts, refuses
  while one of them is publishing, disables the connection and audits it.
  Drafts keep the ID and show the account as removed. Published posts and their
  receipts stay. Reconnecting the same external account later reactivates the
  same connection in the chosen set.
- **Connecting an account.** The OAuth start record stores the target set, so
  the callback attaches the account to the set the user started from, not to
  whichever set is selected later.

### Permissions inside a set

| Action                                                    | Requirement                                          |
| --------------------------------------------------------- | ---------------------------------------------------- |
| View a set, its drafts and its schedule                   | `artifact:read` and visibility                       |
| Write drafts                                              | `artifact:edit` and visibility                       |
| Change scheduling, defaults, public profile, name, colour | `publish:manage` and visibility                      |
| Change the Writing Assistant                              | `artifact:edit` and visibility                       |
| Add, reconnect or remove accounts                         | `publish:manage` and visibility                      |
| Schedule and publish                                      | `publish:manage`, a signed-in person, and visibility |
| Share a private set                                       | Its owner, holding `publish:manage`                  |
| Delete a set                                              | `workspace:update`, or the owner of a private set    |

Go checks every row. The browser hides controls only as a courtesy.

### Account health

The product reads each account's state from the social service and reports one
of: connected, reconnect required, expired, revoked, removed, or permission
required. Only a connected account can be scheduled to, and the composer shows
the recovery action for every other state.

## Scheduling per set

A set owns an IANA time zone, a weekly template of slots (weekday and local
time), and a natural-posting-times default. The workspace keeps the review
policy (`requireApproval`).

- **Templates are not schedules.** A slot is a recurring local wall time. When a
  draft is queued, Go resolves the next free slot to an instant and stores it on
  each scheduled post. Changing the template or the set's time zone never
  changes a stored instant.
- **The weekly count** is the number of enabled weekday and time cells. Two
  times on weekdays are ten slots.
- **Reservation.** Queueing happens inside the scheduling transaction under a
  per-set advisory lock (`pg_advisory_xact_lock`), so two concurrent requests
  cannot take the same slot. A retry at the same draft version replays the
  posts it already made, through the existing idempotency key.
- **Daylight saving.** A slot inside a spring-forward gap fires the same number
  of minutes after the transition (02:30 becomes 03:30). A slot in a
  fall-back repeat fires at its first occurrence.
- **Natural posting times.** When on, Go adds an offset of up to four minutes
  either side, derived from the draft, its version and the slot, and stores it
  with the post. A reload, retry or worker recovery reads the stored value, so
  the instant never changes. The set holds the default, the draft keeps its own
  copy, and the schedule dialog can override it for one schedule.
- **Explanation.** Each scheduled post records how its instant was chosen:
  queue or explicit, the base instant, the offset, and the time zone.

## New-draft defaults

A set stores its default platforms in order, the primary platform, and the X
engagement defaults (auto-repost and auto-reply thresholds). A new draft copies
them once, at creation: its channels in that order, its primary platform, its
natural-time choice and its engagement options. Changing the defaults never
changes an existing draft.

The primary platform's text is the draft body. Every other platform follows it
until someone edits that platform's text, which is then stored separately and
is never overwritten by later edits to the body. Engagement defaults pre-fill
the composer's X options; nothing reaches the provider until the post is
scheduled and Go accepts the options for an X account.

## Public profiles

Each set has one public profile, off by default. When on, `/p/<slug>` shows the
set's name, colour and its connected accounts' public identity (name, handle,
avatar, platform). The page is rendered per request and sends
`Cache-Control: no-store`, so turning the profile off takes effect on the next
request. Go returns nothing for a disabled or deleted set. Drafts, members and
credentials are never part of the profile.

## Writing Assistant

A set's Writing Assistant has a style guide (tone, audience, preferred
terminology, prohibited phrases, formatting, example openings and endings, and
per-platform guidance) and up to 20 writing samples. A sample is text written
in place or imported from a draft of the same set, and records where it came
from and who added it.

AI writing help for a draft in that set uses the workspace brand voice refined
by the set's guide. The brand's prohibited terms stay hard rules; the set adds
to them and cannot remove them. The set's tone and audience replace the
brand's when set. Samples are passed to the model as quoted examples, with an
instruction to ignore any instructions inside them. The assistant only returns
suggestions; the composer applies one when the writer chooses it. Every call
goes through the existing AI credit meter and the workspace AI switch.

## User preferences and appearance

`user_preference` is keyed by the user, so it follows them across workspaces
and never changes another person's view. Saves carry a version and are refused
when stale. The browser applies a preference only after the backend confirms
it, and restores the previous value when a save fails.

- **Theme.** Light, dark or system, through `next-themes` with its pre-paint
  script, so there is no flash or hydration mismatch. Platform pages follow the
  theme. The screenshot editor and the marketing site stay dark, because their
  upstream styles are dark-only.
- **Navigation.** Compact keeps the icon rail. Expanded shows labels. Dynamic
  shows labels from 1280 px wide, the rail below that, and keeps a temporary
  expansion the user opened until they close it or navigate.
- **Calendar week start, editor direction, scrollbars.** These change
  presentation only. Stored instants and keyboard behaviour are unchanged.
  Hiding scrollbars keeps every container scrollable; Safari may need a reload.
- **Display time zone.** It formats times in lists and the composer. It is
  separate from every set's scheduling time zone, and changing it reschedules
  nothing.

Debug logging is browser-local by design: the switch, the log and its count
live in this browser's storage, values are redacted before they are stored,
the log is bounded, and it is downloaded as a file rather than uploaded.

## Outbound webhooks

This closes the outbound gap RFC 015 records. A workspace (owner or admin)
subscribes HTTPS endpoints to versioned draft events:

| Event                  | Emitted when                                                 |
| ---------------------- | ------------------------------------------------------------ |
| `draft.created`        | A draft is created                                           |
| `draft.scheduled`      | A draft is scheduled, rescheduled, or one of its posts moves |
| `draft.planned`        | A draft is placed on the calendar without scheduling         |
| `draft.status_changed` | A draft's status changes                                     |
| `draft.tags_changed`   | A draft's tags change                                        |
| `draft.published`      | One of a draft's posts goes live                             |
| `draft.deleted`        | A draft is deleted                                           |

- **Envelope.** `id`, `type`, `schemaVersion`, `occurredAt`, `workspaceId`,
  `socialSetId`, `resource`, and a redacted `data` object (IDs, title, status,
  tags, platforms, times, and a live post's URL). No body text, comments,
  credentials or members.
- **Atomicity.** The event is written to `outbox_event` in the same
  transaction as the change. The tenant outbox job turns it into one delivery
  per matching subscription.
- **Signature.** It reuses the inbound contract: `X-Shots-Signature` is
  `v1=` and the hex HMAC-SHA256 of `<event id>.<timestamp>.<raw body>`, with
  `X-Shots-Event-Id`, `X-Shots-Timestamp` and `X-Shots-Event`. After a
  rotation, both secrets sign for 24 hours.
- **Delivery.** At least once. Deliveries go out in order, one at a time per
  subscription, with a ten-second timeout. Failures retry with bounded backoff
  for eight attempts, then stop for manual replay. The event ID is stable, so
  receivers deduplicate on it.
- **Egress.** HTTPS only. URLs carrying credentials are refused. Every address
  the destination resolves to is checked at creation and again at dial time:
  loopback, private, link-local, shared, and metadata ranges are refused, and
  redirects are not followed.
- **Secrets.** Encrypted at rest with `PLATFORM_WEBHOOK_ENCRYPTION_KEY`, shown
  once at creation and rotation, and never returned again or logged.

Draft tags and calendar planning did not exist. This RFC adds the minimum
durable behaviour so those two events can be emitted: a draft's `tags` and
`plannedFor`. Both started behind experiments (below); calendar planning has
since been promoted with Write (RFC 025), so it is on for every workspace with
drafts.

## Experiments

A registry declares each experimental feature: ID, name, description, status,
required entitlement, minimum app version, dependencies, whether a user can
change it, and where it is enforced. A user's opt-in is a preference. An admin
can turn a feature off for the workspace. Go checks both when the feature is
used, so a browser cannot enable what the server refuses, and no experiment
overrides a plan, a permission, or a provider requirement.

## Migration

Additive and idempotent. The migration:

1. Creates a default set per workspace from its name, its workspace time zone,
   and its saved posting slots (or weekdays at 09:00).
2. Assigns every connection. The oldest connection of each platform joins the
   default set; a second account of the same platform starts a second set,
   and so on, so the one-per-platform rule holds without moving any account
   between workspaces.
3. Assigns every draft to the set of its first channel, or the default set.
4. Leaves every scheduled post, approval, receipt, API key, OAuth connection,
   notification setting, billing record and audit entry as it is. No instant
   changes.

A workspace created later gets its default set on first use, from the same
rule. `PUT /api/v1/content-draft-settings` keeps working: its posting slots now
read and write the workspace's first set.

### Rollback

Every change is additive: new tables and nullable or defaulted columns. Rolling
back the application leaves them in place and unread; the old code ignores
`socialSetId` and keeps reading `content_draft_settings`. Nothing is dropped,
so a re-deploy resumes with the data intact.

## Acceptance criteria

1. Changing a user's display time zone does not change any set's scheduling
   time zone, and reschedules nothing.
2. Editing a set's weekly slots leaves already scheduled instants unchanged.
3. Two time rows enabled Monday to Friday count as 10 weekly slots.
4. A new draft receives its set's default platforms in order, and changing the
   defaults afterwards does not change it.
5. A natural-time offset is stored and survives a reload and a retried
   schedule.
6. Two sets with the same name stay separately addressable by ID.
7. A disconnected account shows recovery guidance and cannot be scheduled to.
8. A private set is visible to the rest of the workspace only after its owner
   shares it.
9. A disabled public profile returns nothing, including on the next request
   after it is turned off.
10. A webhook is validated, signed, retried and deduplicable by event ID.
11. An API key's secret appears once, at creation.
12. A failed preference save restores the previous value instead of showing
    it as saved.

## Observability

The metric that matters is the share of webhook deliveries that succeed
within their retry budget, per subscription; a falling share means customers'
automations silently stop. Alongside it: queue reservations that waited on the
advisory lock, preference saves refused as stale, and accounts in each health
state.
