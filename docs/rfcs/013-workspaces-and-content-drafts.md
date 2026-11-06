# RFC 013: npm Workspaces, the Plate.js Editor Package, and Content Drafts

**Priority:** 013 — Reusable foundations
**Previous ID:** 037 ([renumbering map](renumbering-2026-10-24.md))
> **Roadmap disposition (2026-10-23):** Reuse implemented npm workspaces, document editing and content-draft revisions for role-specific kit artifacts.
> See the [current execution order](README.md). Older decision text is
> historical wherever it conflicts with that order or the audited architecture.

**Status:** Partially implemented (npm workspaces, Plate editor, drafts and collaboration present)
**Status note (2026-10-23):** The workspace and draft foundations exist. Reuse them for kit documents; this audit does not re-certify every acceptance criterion or live-provider flow.
**Date:** 2026-10-17  
**Decided:** 2026-10-17 (see Decisions)  
**Supersedes:** [RFC 051](051-workspace-migration.md)
**Owners:** Engineering  
**Historical dependencies:** RFC 030 ([publishing](030-social-publishing.md)), RFC 051 ([migration order](051-workspace-migration.md)), RFC 014 ([REST contracts](014-rest-api-scalar-reference.md)), RFC 023 ([plan gates](023-pricing-and-unit-economics.md))

## Decision

1. Turn the repository into an npm workspace with `"workspaces": ["packages/*"]`
   in the root manifest. The Next.js app stays at the repository root. There
   is no `apps/` directory, no Turbo, no Nx, no pnpm and no Bun.
2. Vendor `@canvas/platejs-editor` from oppulence-canvas into
   `clients/packages/platejs-editor` as `@shots/platejs-editor`, a source copy with
   its origin recorded in `UPSTREAM.md`.
3. Its first consumer is **manual content drafts**: a user writes a post in
   the editor, saves it as a draft, and schedules it to one or more connected
   channels through the existing scheduler.
4. Real-time co-editing ships in production through a new Hocuspocus
   deployable, `clients/apps/collab-server`, which authenticates and persists only
   through the Go backend.

## Why now

RFC 051 deferred workspaces until a second shared artifact existed. The
backend SDK was the first; it shipped to npm from
`clients/packages/screenshot-studio-backend-sdk` without workspaces, built with
`npm --prefix`. The editor is the second, and unlike the SDK it is consumed by
the app at build time, carries more than a hundred dependencies, and needs to
be linked, transpiled and traced. That is the trigger RFC 051 named. A third,
the collaboration server, is a separate deployable.

RFC 051's analysis of cost is out of date (it predates the move of product
data to the Go backend, and mentions Prisma and Trigger.dev, neither of which
the web uses now), but its **migration order** and **interim practice** still
apply: prove the risky parts on a trivial package first, keep the `@/` alias,
and keep boundaries explicit with `server-only` and barrel exports.

## Layout

```text
/                          the Next.js app (unchanged location)
packages/
  screenshot-studio-backend-sdk/   published to npm (unchanged release path)
  platejs-editor/                  @shots/platejs-editor, vendored, private
  collab-server/                   @shots/collab-server, Hocuspocus deployable
```

### Why the app stays at the root

Every nightly upstream sync merges KartikLabhshetwar/screenshot-studio into
the fork. Upstream keeps its app at the root. Moving ours to `apps/web` would
turn every upstream change to an editor file into a rename conflict. The
workspace adds packages beside the app, so a sync conflicts only on files the
fork already owns: the root `package.json` and `package-lock.json`.

### Why the collaboration server lives in `packages/`

The Go module owns `services/`, and the web image's `.dockerignore` excludes
`/services`. Putting a Node workspace there would make every web `npm ci` need
a manifest the image cannot see. One `packages/*` glob keeps the workspace
list, the lockfile and the Docker manifests in step.

### Tooling

npm workspaces are enough. The app builds with one `next build`; the SDK
builds with one `tsc`; the editor ships source and is compiled by Next. Nothing
here needs a task graph or a remote cache. Turbo or Nx is justified only by a
measured need: a CI build where package builds dominate wall-clock time. It is
not the case today, so none is added.

`bun.lock` is deleted. npm is the only package manager (`npm ci` in CI and in
the `Dockerfile`), and a second lockfile drifts silently. Upstream still
carries `bun.lock`; a sync that touches it resolves as a modify/delete
conflict with `git rm bun.lock`, which `AGENTS.md` records.

## Workspace migration

Done first, as its own change, with no editor (RFC 051 step 1).

| Concern | Change |
| --- | --- |
| Root manifest | `"workspaces": ["packages/*"]`; the lockfile is regenerated with npm |
| SDK build | `npm run build -w screenshot-studio-backend-sdk` replaces `npm --prefix` |
| SDK publishing | `publish-sdk.yml` and release-please are unchanged; a dry-run publish proves it |
| Docker | Every workspace's `package.json` is copied before `npm ci` |
| Standalone tracing | The tracing root is the app root, which contains `packages/`; no `outputFileTracingRoot` |
| CI | `ci.yml` builds the SDK through the workspace; `web-image.yml` rebuilds on `packages/**` |
| Guard | `test/workspace-manifests.test.ts` fails when an image misses a workspace manifest |

Job names and required checks do not change.

## The editor package

### Vendoring

The package is copied, not linked:

- No git submodule or subtree: both make every clone and every upstream sync
  aware of a second repository, and subtree merges rewrite history the
  nightly sync then has to carry.
- No registry dependency: the package is private to oppulence-canvas and is
  built for a Bun, Turbo and Biome monorepo, so it cannot be installed as is.

`clients/packages/platejs-editor/UPSTREAM.md` records the source repository, path and
commit, the rename, every local change, and the ownership and license
confirmation. Pulling a later fix is a reviewed diff:

1. In oppulence-canvas, `git diff <recorded commit>..<new commit> -- clients/packages/platejs-editor`.
2. Apply it here with `git apply --directory=clients/packages/platejs-editor -p3`
   (paths shift by the package prefix), resolve against the local changes
   listed in `UPSTREAM.md`, and run the package tests.
3. Record the new commit in `UPSTREAM.md` in the same change.

### Name and API

The package is renamed `@shots/platejs-editor`, a platform namespace. Its 27
subpath exports, including the `platejs/*` and `@platejs/*` re-exports, keep
their paths, so `@canvas/platejs-editor/ui` becomes `@shots/platejs-editor/ui`
and nothing else changes for a caller.

### Making it build here

| Upstream assumption | Here |
| --- | --- |
| `@canvas/tsconfig` | A package `tsconfig.json` that extends the root one |
| `types: ["bun-types"]` | Dropped; the package uses DOM and Node types only |
| `bun test` | `tsx --test`, from the root `npm test` |
| Biome | The repo's ESLint and Prettier, scoped to the package, without reformatting upstream files |
| React peer `19.2.5` | The root moves to React `19.2.5`; `npm ls react` must show one copy |

The `platejs` and `@platejs/*` family is pinned to one exact version set, and
dependencies shared with the app (`zod`, `ai`, `lucide-react`,
`tailwind-merge`, `sonner`, `date-fns`, Radix) resolve to one copy each.
`npm audit` findings that remain are recorded in `UPSTREAM.md` with the reason
each is accepted.

Next.js compiles the package through `transpilePackages`, and the app's
Tailwind v4 entry adds an `@source` for `clients/packages/platejs-editor/src` so the
package's classes are generated.

### Boundaries

The package is a library. It must not reach into the app or the environment:

- **No app imports.** Nothing under `clients/packages/platejs-editor` imports `@/`.
  The app imports only the package's public exports.
- **No `process.env`.** Configuration arrives as props or providers.
- **No hard-coded routes.** No `/api/*` string appears in the package.
- **Uploads are injected.** The uploadthing packages are removed. The
  package takes an upload adapter; the app implements it
  with the existing signed upload flow (sign, `PUT` to R2, complete) through
  the Go backend.
- **AI is injected.** The AI chat and copilot plugins take an endpoint or a
  handler. The app points them at platform AI routes declared in
  `lib/api/contracts/ai.ts`, which meter credits and honor the workspace AI
  kill switch.
- **Collaboration is configured.** The collab URL, token source and cursor
  identity are passed in by the app.

A test scans the package and fails on an `@/` import, a `process.env` read or
an `/api/` literal, next to the existing `test/web-database-boundary.test.ts`
and `test/api-platform-boundary.test.ts`.

### Bundle cost

The editor is heavy. It loads with `next/dynamic` on the draft composer route
only, after the page renders, and DOCX support (mammoth and the Word writer)
loads on first use. No package code reaches the screenshot editor's main
route.

Measured on production builds, signed in, gzipped JavaScript the browser
downloads (2026-10-17):

| Route | Before | After |
| --- | --- | --- |
| Screenshot editor (`/`), first load | 920.0 KB | 926.9 KB (+0.75%, chunk re-partitioning and the Drafts nav entry) |
| Drafts list (`/drafts`), first load | none | 944.3 KB |
| Composer (`/drafts/{id}`), first load | none | 951.9 KB |
| Composer, editor chunk after render | none | 1,266 KB |
| Composer, DOCX import or export on first use | none | 369 KB |

## Content drafts

### Data model

A new Ent model, `ContentDraft` (table `content_draft`), added through a
`platformmigrations` migration. It does not overload `ScheduledPost`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | text | cuid |
| `organizationId` | text | workspace scope; cascade on workspace delete |
| `title` | text | up to 200 characters |
| `body` | jsonb | Plate JSON |
| `plainText` | text | plain-text render, for search and previews |
| `assetIds` | jsonb | workspace asset ids attached to the draft |
| `channelConnectionIds` | jsonb | the target channels |
| `status` | text | `draft`, `scheduled` or `archived` (lowercase, checked) |
| `version` | integer | optimistic concurrency, starts at 1 |
| `collabState` | bytea | Yjs document state, written by the collab server |
| `createdByUserId`, `updatedByUserId` | text | set null when the user is deleted |
| `createdAt`, `updatedAt` | timestamp | |

### API

Go serves `/v1/content-drafts`: list, create, get, update and delete. Update
takes the version the client last saw and answers `409` when it is stale.
The SDK exposes the same methods, and `lib/backend/sdk.ts` reaches them.

The web exposes `/api/v1/content-drafts` and `/api/v1/content-drafts/{id}`
with zod contracts in `lib/api/contracts/`, so they appear in the OpenAPI
document and the Scalar reference. The composer autosaves on a debounce and
sends the version with every save; a `409` reloads the latest version
instead of overwriting it.

### Permissions, plan and flag

| Operation | Requirement |
| --- | --- |
| List, get | `artifact:read` (every workspace member, or an API key with that scope) |
| Create, update, delete | `artifact:edit`, or an API key with `draft:write` |
| Schedule, reschedule, cancel | `publish:manage`, as CopyBoard requires; a session only |
| Write and publish a new post in one call (`POST /api/v1/posts`) | `publish:manage`, or an API key with the opt-in `post:publish` ([RFC 026](026-mcp-and-agent-integrations.md#authorized-expansion-2026-11-05)) |

Every operation is plan-gated by a new workspace feature, `content:drafts`,
declared on each contract with `x-shots-entitlement` and enforced in Go. The
UI and the web routes are also behind a flag, `PLATFORM_CONTENT_DRAFTS`,
following the campaign workflow's `PLATFORM_CAMPAIGN_WORKFLOW` pattern in
`lib/auth/page-access.ts`. Create, update, schedule and delete each write a
tenant audit record in the same transaction as the change
(`product.content_draft_created`, `_updated`, `_scheduled`, `_deleted`).

### Scheduling a draft

"Schedule" creates one `ScheduledPost` per selected channel connection,
through the existing Go scheduling path and Temporal workflow. There is no
second scheduler.

- A scheduled post links to **either** a creative variant or a draft:
  `variantId` becomes nullable, `contentDraftId` is added, and a check
  constraint requires exactly one. The zod schema, Go validation and Ent
  schema change together.
- The idempotency key is `content-draft:<draft>:<connection>:v<version>`, so a
  double click replays the same posts instead of creating new ones.
- Scheduling snapshots the caption into each post. Editing the draft
  afterwards does not change queued posts. Rescheduling cancels the draft's
  live posts and creates new ones under the new version.
- Go re-validates each caption against its channel's limit and the
  workspace's prohibited terms, as the campaign path does.
- Each post carries the draft's images in body order, up to its channel's
  limit: 4 on X, 9 on LinkedIn, 10 on Instagram. The post keeps the list in
  `scheduled_post.assetIds` and the first in `assetId`; the composer says when
  a channel drops images. A draft with no image publishes as text. The publish
  job carries the list beside the single asset fields, so a job prepared
  before the list existed still publishes its one image. If any listed image
  has been deleted by publish time, the post is cancelled rather than sent
  without it.

### Threads

A draft is one post or a thread. A `post_break` block starts the next post;
the composer draws it as that post's header (avatar, author, number, and its
length on X) and joins the avatars with a line. ⌘↵ starts a new post, and so
does Enter on the second empty line in a row, as in Typefully.

X posts a thread as the first post and the rest as replies, each answering
the one before; every post has X's limit and its own images. LinkedIn and
Instagram take the thread joined into one post, and the composer says so.
The scheduled post keeps the replies (`scheduled_post.replies`, each a caption
and image ids), the publish job carries them, the social API receives them as its
value list, and the direct publisher posts each with the provider's comment
call. The first post is live by the time a reply goes out, so a reply that
fails ends the thread there and is logged rather than retried. Exports write
each break as a horizontal rule.

### The posting surface

The drafts pages work like Typefully: the drafts rail (Drafts, Queue,
Posted, Archived), a calendar, and drafts settings around the composer.

- **Queue.** `content_draft_settings` keeps a workspace's weekly posting
  slots (default weekdays at 9:00, in the workspace time zone) and whether
  drafts need approval. "Add to queue" schedules at the next slot no draft
  post takes. The Queue tab lists posts due in the next 60 days.
- **Calendar.** A week of draft posts. Dragging a queued post to another day
  keeps its time; the backend cancels the post and queues a copy without a
  second charge, because a workflow's timer is fixed when it starts.
- **Best times.** The weekday hours the workspace's live posts drew the most
  engagement at, weighting replies and quotes over reposts over likes; with
  fewer than five measured posts, mid-week mornings and noon.
- **Plain-language times.** "tomorrow 9am", "in 3 hours", "fri 2pm", "oct 21
  at noon" read into the schedule time (`lib/content-drafts/when.ts`).
- **Approvals.** With approval on, a draft is scheduled only once a publisher
  or admin approves it, and only at the version approved: an edit after
  approval needs another.
- **Share links.** A draft can have a read-and-comment link
  (`/d/<token>`, 24 random bytes). Guests' comments are kept with the draft
  and shown in the composer; turning the link off makes it find nothing.
- **History.** A revision is kept at most every ten minutes of editing and
  on every schedule; restoring one goes through the editor, so a live
  session and undo see it.
- **Per-channel text.** A channel can say something different
  (`content_draft.channelText`); the draft's images still go with it.
- **Accounts.** Connections keep the account's name, @handle and avatar from
  the social API, filled in at connect time or on first list.
- **Live posts.** A published post keeps its platform id, so the composer
  links to it and reads its engagement on demand through the provider's
  analytics. A thread that stopped partway records how far it got and
  offers "Post the rest": a new post answering the last live reply.
- **Follow-ups (X).** Repost and reply once a post has enough likes, tried 6,
  12 and 18 hours after it goes out, and a quote (text plus a link to the
  post) after a set number of hours. They run in a versioned step of the
  publishing workflow; a failed one is left undone.
- **Polls and video.** An X post can carry a poll (2 to 4 choices, open up to
  7 days, no images). An uploaded video goes out as the post's media, alone:
  one video, no images beside it, on every channel.
- **More channels.** Threads (500 characters, 10 images), Bluesky (300, 4)
  and Mastodon (500, 4) take drafts and threads. Threads and Mastodon
  connect through OAuth; Bluesky signs in with an app password, so it is
  connected through the API until that form exists.
- **Writing help.** The AI rewrites a draft for a channel, turns it into a
  thread, or shortens it to fit, charged to the workspace's AI credits. The
  composer offers the handles and hashtags the workspace already writes, and
  shows a link's card in the preview when a post has no media. X's length
  counts links as 23 and wide characters as 2, in the composer and in Go.

### Serialization

Social channels take plain text. One pure function turns Plate JSON into a
caption per channel and reports what it had to degrade:

| Node | Caption |
| --- | --- |
| Paragraphs, headings, line breaks | Text with line breaks |
| Lists | `- item` or `1. item`, indented per level |
| Links | The link text followed by the URL |
| Mentions, hashtags | Their plain text |
| Tables, math blocks | Images attached to the post, in body order |
| Inline math | The LaTeX source |
| Footnotes | Numbered markers, with the notes listed at the end |
| Unsupported marks | Dropped, and reported |

When the draft is scheduled, the composer renders each table and math block as
it looks in the editor (`modern-screenshot`), uploads it as a workspace asset,
and sends the block-to-asset map with the request. The server serializes with
that map and passes each post's image list to Go, which checks the images are
the workspace's uploads and applies the channel's image limit. A block the
composer could not render stays as text: aligned rows for a table, the LaTeX
source for math. Search and the draft list keep the text form.

The composer shows the per-channel preview the serializer produces, a live
character counter per selected channel (X 280, LinkedIn 3,000, Instagram
2,200, matching the campaign rules in `lib/launch/guards.ts`), and a warning
before scheduling when content is degraded for a channel.

### Editor configuration

The composer uses the full `EditorKit`: tables, math, footnotes, columns,
table of contents, media, mentions, emoji, comments, suggestions and
collaboration stay on. DOCX and Markdown import and export work in production;
images in an imported `.docx` are re-uploaded through the same upload adapter.
AI assistance goes only through the platform AI routes.

## Collaboration

Real-time co-editing ships through Yjs and Hocuspocus.

```text
browser ──token request──▶ web /api/v1/content-drafts/{id}/collab-token ──▶ Go (issues token)
browser ──websocket + token──▶ collab-server ──authorize / load / store──▶ Go
```

- **Deployable.** `clients/apps/collab-server`, its own workspace package,
  `Dockerfile` and Helm entry in `infra/charts/screenshot-studio`.
- **No database.** The server never connects to Postgres or Redis. It loads
  and stores the Yjs state through Go endpoints under `/v1/collab/`.
- **Authentication.** Go issues a short-lived token (five minutes) scoped to
  one draft, one user and one access level, signed with a key only Go holds.
  The collab server cannot mint or verify tokens; it asks Go to authorize each
  connection and passes the connection's token on every load and store, so its
  own service credential cannot read or write any draft by itself. A user of
  another workspace cannot obtain a token for the draft, and a token for one
  draft does not open another.
- **Access.** Members with `artifact:edit` join read-write; members with only
  `artifact:read` join read-only.
- **Presence.** Cursors and presence show the workspace user's name and a
  colour derived from their id, supplied by the app from the session.
- **Offline.** `y-indexeddb` caches the document for offline editing.
- **WebRTC.** `y-webrtc` stays available in the package but is **off in
  production**. The package refuses a WebRTC configuration without explicit
  signaling servers, so the public y-webrtc signaling servers are never used.
  Turning it on requires our own signaling and TURN servers and a revision of
  this RFC. The app's build aliases y-webrtc to a stub that refuses to start,
  so neither the library nor its public defaults ship.
- **Configuration.** The collab URL comes from server config
  (`PLATFORM_COLLAB_URL`) passed in by the app.

### Endpoints and secrets

| Route | Caller | Credential |
| --- | --- | --- |
| `POST /v1/content-drafts/{id}/collab-token` | the web, for a signed-in member | service token and the member's session |
| `POST /v1/collab/authorize` | the collab server, per connection | `COLLAB_SERVICE_TOKEN` and the member's token |
| `GET /v1/collab/epochs` | the collab server, before each frame and once a second for idle connections | `COLLAB_SERVICE_TOKEN` |
| `GET`, `PUT /v1/collab/documents/{draftId}` | the collab server, to load and store | `COLLAB_SERVICE_TOKEN` and the member's token |

Only the backend holds `COLLAB_TOKEN_SECRET`, the signing key. The collab
server holds `COLLAB_SERVICE_TOKEN`, which opens the three collab routes and
nothing else. Authorization and document loads and stores also need a member's
token for that draft. A connection is admitted with an unexpired token; loads and stores
accept the connection's token for twelve hours after it expires, so a long
session keeps saving. A member removed from the workspace is refused on their
next connection, and one demoted below `artifact:edit` joins read-only.

A connection is authorized when it opens, not on every message. The backend
counts the changes that can take access away, per workspace and once for every
workspace: a member demoted, removed or leaving, an ownership transfer, a
draft body replaced or a draft deleted, and any member, session, user or
workspace written through the auth store. Before accepting or sending a frame,
the collab server reads the current counts (`GET /v1/collab/epochs`). Changed
counts require fresh authorization before the frame can pass; unavailable
counts close the connection. A poll also rechecks idle connections when counts
move, closing or demoting them. Every connection is
also authorized again after a minute, which covers changes nothing announces,
such as an expired session. Revocation reaches an idle session within about a
second and is checked before its next frame. With `REDIS_URL` the counts are
shared by every backend replica.

One replica needs nothing else. More replicas relay each document's live
updates and awareness through Redis (the Hocuspocus Redis extension, enabled
by `COLLAB_REDIS_URL`), and one replica, chosen by a Redis lock, stores each
document. The newest writer's token for a document is kept in Redis too, so
the replica that stores can still present it to the backend. Redis carries
live updates and those tokens only; every draft stays in the backend. Helm
(`collab.replicaCount`) and the deploy (`COLLAB_INSTANCE_COUNT`) refuse more
than one replica without Redis.
Comment threads (the discussion plugin) are saved with the draft in its
`discussions` column, capped at 256 KB, by the same versioned autosave as the
body. When an autosave meets a newer version in a live session, the composer
merges the stored threads with its own by thread id before saving again; a
thread both editors changed keeps the local copy.

## Rollout

Each step is its own pull request and can be reverted alone.

1. This RFC.
2. The workspace migration, with no editor.
3. The editor package vendored, building and tested, not yet consumed.
4. Upload, AI, collaboration and configuration adapters, and the boundary test.
5. Drafts: Ent model, Go API, SDK and the `/api/v1` contract.
6. Draft-to-scheduled-post linking, plus the serializer.
7. The composer UI behind the flag, plus end-to-end tests.
8. The Hocuspocus collab service, plus collaboration end-to-end tests.

## Observability

Scheduling success is the metric that matters: the share of draft schedule
requests that produce one live post per selected channel without a retry.
Alongside it, the collab server logs each refused connection with its reason
(expired, wrong draft, wrong workspace), and autosave counts its `409`
responses, which show how often concurrent editors collide.

## Acceptance criteria

1. A clean clone passes `npm ci && npm run quality:check && npm run build`,
   and the Docker image builds and serves the composer route.
2. SDK publishing passes a dry run and release-please is unchanged.
3. `npm ls react react-dom platejs` shows one version of each.
4. A user writes a draft, saves it, reloads it, and schedules it to several
   channels; each channel receives a correctly serialized caption within its
   limit, and a double submit creates no duplicate posts.
5. Campaign-variant scheduling (CopyBoard) works unchanged.
6. Tables, math, footnotes, DOCX import and export, and collaboration work in
   a production build.
7. The collab server authenticates through the Go backend, keeps workspaces
   isolated, and has no database access.
8. The shipped bundle has no uploadthing dependency, no hard-coded `/api`
   path from the package, and no public WebRTC signaling.
9. A trial upstream sync conflicts only on fork-owned files.

## Decisions

- **Workspace layout:** `packages/*` beside a root app. Decided 2026-10-17.
- **Vendoring:** source copy with `UPSTREAM.md`. Decided 2026-10-17.
- **Ownership and license:** confirmed. PlaybookMediaLLC has the right to copy
  this code from Oppulence-Engineering. Decided 2026-10-17.
- **First consumer:** manual drafts that can be scheduled. Decided 2026-10-17.
- **Collaboration in production:** on, through Hocuspocus; WebRTC off.
  Decided 2026-10-17.
