# RFC 025: The Write Workspace

**Priority:** 025 — Reusable foundations
**Previous ID:** 042 ([renumbering map](renumbering-2026-10-24.md))
> **Roadmap disposition (2026-10-23):** Reuse authoring and review. Wider social publishing feature parity is deferred.
> See the [current execution order](README.md). Older decision text is
> historical wherever it conflicts with that order or the audited architecture.

**Status:** Accepted; implemented (each section's state is in the [coverage matrix](../scheduling/typefully/write/implementation-matrix.md))

**Date:** 2026-10-20

**Owners:** Product Engineering

**Historical dependencies:** RFC 030 ([publishing](030-social-publishing.md)), RFC 013 ([content drafts](013-workspaces-and-content-drafts.md)), RFC 042 ([scheduling priorities](042-scheduling-feature-priorities.md))

## Decision

Drafts become **Write**: a first-class surface for writing, reviewing,
planning, and publishing social content. Write extends the content drafts of
RFC 013. It adds no second editor, no second scheduler, and no second
automation executor. The functional reference is the
[Typefully Write specification](../scheduling/typefully/write/typefully-write-spec.md)
and its [checklist](../scheduling/typefully/write/typefully-write-build-checklist.md).
The [coverage matrix](../scheduling/typefully/write/implementation-matrix.md)
records the state of each section and each verification case.

`/write` is the canonical route. `/drafts`, `/drafts/{id}`, `/drafts/calendar`,
and `/drafts/settings` redirect to their `/write` equivalents, so existing links
and bookmarks keep working.

## The model

```text
Workspace
└── Social set            a publishing identity: one account per platform
    └── Draft             kind, title, scratchpad, tags, pin, plan
        ├── Primary body  Plate JSON; posts start at post breaks
        └── Platform versions
            ├── synced    derived from the primary body when serialized
            └── manual    its own Plate body, never overwritten silently
```

### Social sets

Write uses the social sets of the [settings platform](024-settings-platform.md)
(RFC 024, `social_set`): a name and a colour,
which need not be unique, at most one active account per platform
(`channel_connection.socialSetId`), the ordered default platforms and primary
platform for new drafts, a scheduling time zone, posting slots, natural
posting times, engagement defaults, and the set's Writing Assistant. Sets are
created and edited in workspace settings; Write's switcher links there.

- The workspace's organization and membership stay the authority. A set is
  shared with the workspace (`WORKSPACE`) or private to its owner (`PRIVATE`).
- The workspace's default set is its oldest shared set (RFC 024). A draft
  without a `socialSetId` belongs to it.
- Go checks set access on every draft read and write, in lists, and in
  background work. A draft in a private set is not found for anyone but the
  set's owner.
- A new draft copies its set's default platforms, primary platform, natural
  posting time and engagement defaults (RFC 024). Write adds its kind, which
  can narrow the platforms (a reply or an article is X's).

### Draft kinds and targets

`content_draft.kind` is `standard`, `reply`, `quote`, `repurpose`, or
`article`. A thread is a standard draft with more than one post. A reply or
quote stores an explicit target (`platform`, `url`, `remoteId`), not a URL in
the text. A repurposed draft stores the published post it came from. Kinds are
offered only on platforms that support them (the capability registry).

### Platform versions

`content_draft.platformVersions` is a versioned document
(`schemaVersion: 1`). Each entry is a channel and a mode:

- **synced**: the version has no text of its own. It is serialized from the
  primary body each time, so an edit to the primary can never overwrite it.
- **manual**: the version has its own Plate body. Primary edits leave it alone.
  The entry records the primary's version and a hash of the primary's
  serialization when it was forked, so the composer can show "the primary
  changed since you wrote this" and offer a comparison.

Switching a manual version back to synced is an explicit decision that
discards its body. When the body carries comment threads, the composer names
how many and resolves them as orphaned, rather than moving them onto other
text.

Four things stay separate: the tab being edited (UI state only), whether a
connection is enabled for publication (`channelConnectionIds`), whether that
connection is healthy (its status and credential state), and the version's
mode. Changing tabs changes nothing that is saved.

The legacy `channelText` map still reads: a channel with text there and no
platform version is a manual version whose body is that text. The first save
by the new composer moves it into `platformVersions`.

Per-version options are stored with the version, typed per platform:

| Platform | Options |
| --- | --- |
| X | audience (everyone or a community, with share-to-followers), per-post reply settings, per-post disclosures (paid partnership, made with AI), numbering, finisher, follow-up automation |
| LinkedIn | visibility, first comment, poll, PDF document |
| Threads, Bluesky, Mastodon, Instagram | the options RFC 013 already validates |

### Posts with stable identity

A post starts at a `post_break` block. Every document starts with one, so the
first post has an identity too; the composer adds it when it opens an older
draft. Each break carries an `id`, and per-post settings (poll, reply settings,
disclosures) live on that break. Moving a post moves its break, its blocks, its
media, and its comment marks together; inserting a post renumbers nothing but
the visible numbers. Splitting a post makes a new break; merging two posts
keeps the earlier post's settings.

### Numbering and finishers

Numbering is configuration on the X version: on or off, start or end,
style (`#1`, emoji, `1.`, `1/`, `/1`, `1/9`, `1 of 9`), and how many posts to
skip at the start and end. It is applied when the version is serialized, for
the preview and for publication, and counted against the limit. The authored
text never contains it.

A thread finisher is a reusable template (`content_draft_finisher`, per social
set). Applying one appends a post. A finisher that quotes the first post holds
an unresolved reference until the first post is live; the publisher resolves it
to that post's id and never sends a quote of a post that does not exist.
Nothing promotional is ever inserted into a customer's draft.

## Organization, history, and sharing

- **Tags** are `content_draft_tag` rows scoped to a social set, with a colour.
  A draft keeps tag ids. Copying a draft to another set maps tags by name or
  drops them, as the person copying chooses. Tags stay behind RFC 024's
  `draft-tags` experiment: Go refuses them unless the person turned it on and
  the workspace allows it, and Write hides them otherwise. The
  `draft.tags_changed` webhook carries tag ids and names.
- **Pinning** sets `pinnedAt`; pinned drafts sort first.
- **Activity** reads the audit log for the draft and its posts: creation,
  content edits, renames, destination and tag changes, review, sharing,
  planning, scheduling, publication, failures, reconciliation, recovery, and
  stopped follow-ups. Only safe metadata keys are shown. Viewing writes nothing.
- **Backups** are `content_draft_revision` rows: immutable snapshots of title,
  body, platform versions, and article, kept at most every ten minutes of
  editing and at every plan, schedule, publish, and recovery, each with its
  reason. Retention: every snapshot of the last 30 days, then the last one of
  each day for a year, then none; it is applied as a draft gains a backup.
  Recovering a snapshot creates a new draft and leaves the source alone.
- **Duplicate and copy** create a new draft: new id, version 1, status draft,
  no share token, no guest comments, no discussions, no review, no plan, no
  scheduled posts. Copying to another set rechecks destinations and set access.
- **Comments** stay the discussion plugin's threads, saved with the draft. Go
  now refuses a save that edits or deletes another person's comment; resolving
  and reopening stay open to every editor.
- **Public links** stay the 24-byte share token. Turning one on is an explicit
  switch; copying the internal link never turns it on.

## Planning and publishing

Three operations, with different backend semantics:

| Operation | Effect |
| --- | --- |
| Save | Persists content. |
| Plan | Sets `plannedFor` and its time zone. No scheduled post exists, so nothing can publish. RFC 024's `draft-planning` experiment is promoted: planning is on for every workspace with drafts. |
| Schedule | Creates the canonical scheduled posts (RFC 013), at an instant resolved in Go. |

Publishing now is a schedule at the current instant, reached only from a final
review dialog. Go resolves a local wall time in an IANA zone itself and
refuses a time that does not exist (a DST gap) or is ambiguous (a repeated
hour) unless the request says which; without a zone it uses the set's
scheduling zone. Queue slots are the set's (RFC 024), reserved inside the
scheduling transaction, so two "add to queue" requests never take one slot.
The natural posting offset (up to four minutes either way) is RFC 024's: it is
derived from the draft, its version and the base instant, and stored with the
post, so a retry or a reload keeps it.

Each destination is its own scheduled post with its own outcome. A failed
post can be retried by itself; a post whose outcome is unknown must be
reconciled first ("it is live" with its URL, or "it is not live"), so a retry
never publishes twice.

## Follow-up automation

Follow-ups run in the publishing workflow after the post is live; nothing is
planned before then. Version 2 of the workflow's `post-auto-actions` marker
runs them as receipted steps; version 1 (RFC 013) stays for workflows that
started under it.

- **First comment** (LinkedIn): posted right after the post.
- **Auto-RT**: up to five rules, each a duration after publishing or a time of
  day some days later in a named zone (so it holds across a daylight-saving
  change); each repost can be removed a set time later.
- **Auto-Plug**: a reply posted once when the post reaches a like or repost
  count, checked every 15 minutes for six hours, then hourly, for 48 hours;
  it then expires.
- The RFC 013 like-gated repost and delayed quote run as steps too.

`PlanPostAutomations` (on the main queue) computes the steps from the post's
options and records a `post_automation_run` receipt per post and key
(`first-comment`, `retweet:N`, `unretweet:N`, `plug`, `repost-at-likes`,
`quote`). `RunPostAutomation` reads the receipt before it acts and settles it:
`done` (with the platform's id), `failed` (with a short code such as
`http_403`, never the provider's message), `skipped` (the platform cannot, or
a removal whose repost never went up), `expired`, or `cancelled`. A replayed
workflow or a retried activity finds the receipt and does nothing again.

Stopping follow-ups (`POST /api/v1/content-draft-posts/{id}/automations/cancel`)
cancels pending steps but keeps the removals: one whose repost never went up
skips itself, and one whose repost did, even a repost in flight while the
cancel ran, still takes it down. Completed actions are not undone. A new
draft copies its set's engagement defaults (RFC 024: repost and plug at a
like count); its X version follows them until the writer sets follow-ups of
its own, and a plug can be saved back as the set's default.

**Auto-DM is not built.** Sending needs X's direct-message permission and a
paid X API plan; the workspace's X connection is authorized with write access
only, and there is no event ingestion for reposts and replies. The composer
shows the switch off with that reason, and nothing is sent.

X engagement is read from the post's public metrics; the RFC 013 check
counted one page of liking users and never passed 100.

## Mentions, media, and AI

- **Mentions** are looked up with the set's own account: an X user by exact
  username, a LinkedIn company page by the name in its address. LinkedIn's API
  gives this connection no people search, so the picker says so. A mention is
  an atomic inline element written per platform when the post is serialized:
  the LinkedIn annotation for a LinkedIn organization, the @handle for an X
  user, the plain name elsewhere. Lookups are for signed-in members only.
- **Alt text** is kept on the image asset (up to 1,000 characters) and sent
  with it: X sets it with `POST /2/media/metadata` after the upload finishes
  and before the post exists; LinkedIn sends `altText` on image content.
- **The editor's AI menu** opens with ⌘J, **Ask AI**, or a space on an empty
  line. It writes into the post as it answers, and the writer accepts or
  discards the text. It also reviews a post and leaves comment threads on the
  passages it quotes. While the writer types, it offers an inline suggestion
  that Tab accepts. `POST /api/ai/document` and its `/copilot` route serve it,
  with `artifact:edit`, the workspace AI switch, a rate limit and AI credits.
  The menu never opens on a selection that crosses posts.
- **Refine** (listed in that menu) works on an explicit scope (the selection, the post at the caret,
  or every post of the open version) with twelve actions or the writer's own
  instruction. The server answers one text per text, each within the
  platform's limit, or fails; the composer previews the answer and applies it
  only on Accept, as one change Undo takes back, and refuses if the text
  changed meanwhile. The **Shots assistant** (Ask AI, or **Assistant** in the
  composer) talks about the draft in the set's voice (style guide, audience, and
  samples saved on the set). It offers text as a card, and the draft changes only
  on Accept. Its composer holds the writing prompts, and it turns a voice memo
  into text to review. Both use the workspace's AI credits.

## Provider capabilities

A typed registry (`lib/write/capabilities.ts`, mirrored in Go) says what each
platform and account can do. Each entry is backed by the provider's
documentation, linked in the matrix:

| Capability | X | LinkedIn |
| --- | --- | --- |
| Threads | yes, 25 posts | no; joined into one post |
| Reply / quote | `reply.in_reply_to_tweet_id`, `quote_tweet_id` | reshare with commentary |
| Audience | community (`community_id`, `share_with_followers`) | visibility: anyone or connections (members) |
| Reply settings | following, mentioned users, subscribers, verified | n/a |
| Disclosures | `paid_partnership`, `made_with_ai` | n/a |
| Polls | 2–4 choices, 25 chars, 5 min–7 days, no media | 2–4 options, 30 chars, question 140, 1/3/7/14 days, no media |
| Documents | n/a | PDF up to 100 MB and 300 pages |
| Mentions | @handle, looked up by username | organization annotation, looked up by company page; no people |
| Articles | `POST /2/articles/draft` then `/publish`; X Premium | n/a |
| Long posts | X Premium accounts only | n/a |
| Alt text | `POST /2/media/metadata` | `altText` on images |
| Follow-ups | repost, removal, plug reply | first comment |
| Direct messages | not available (no DM permission) | n/a |

An account's X Premium status is the account's, read from X, never inferred
from the workspace's plan. Until it is read, the account is treated as
standard (280).

## Rollout

Four migrations follow RFC 024's `20261029090000_settings_platform`:
`20261030090000_write_workspace` (tags and finishers of a set, draft and
revision columns), `20261030090100_write_publish_options` (a scheduled post's
settings), `20261030090200_write_post_automation` (follow-up receipts), and
`20261030090300_write_asset_alt_text`. All are additive but one change: the
string `tags` RFC 024 kept on drafts become tag records of each draft's set
(names matched without case, order kept, blanks dropped; a tagged draft
without a set joins the default set), the drafts point at them by id, and
the `tags` column is dropped. Older clients keep working: Go ignores what it
is not sent.

Write ships behind `PLATFORM_CONTENT_DRAFTS`, as drafts do. Capabilities that
need provider permissions (articles, LinkedIn documents and polls, mentions,
follow-ups) only act when the account has them; Auto-DM stays off. Turning
Write off hides the UI; planned drafts never publish because they have no
scheduled posts, and scheduled posts keep running in Temporal as before.

### Rolling back

- **Web**: the previous release reads drafts without the new fields. Planned
  drafts stay planned (no posts); manual platform versions are not shown, and
  the old composer's per-channel text was cleared on first save, so a draft
  edited in Write and then in the old composer publishes the primary text.
- **API and worker**: the new columns and tables are unused by older code, so
  no down-migration is needed, except for tags: an RFC 024 backend reads the
  dropped `content_draft.tags` column. Rolling back past this release needs
  `ALTER TABLE content_draft ADD COLUMN tags JSONB NOT NULL DEFAULT '[]'`,
  refilled from `content_draft_tag` names by `tagIds` if the tags matter. A follow-up workflow that started under version
  2 of `post-auto-actions` cannot be replayed by an older worker; before
  rolling the worker back, let those finish (at most 48 hours after their post
  went live, or the last repost removal) or terminate them, which stops only
  follow-ups: their posts are already live.
- **Data**: deleting `post_automation_run` rows loses receipts, so a later
  replay could act again; keep them until every version-2 workflow is gone.
