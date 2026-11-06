# RFC 026: MCP Server and Agent Integrations

**Priority:** 026 — Reusable foundations
**Previous ID:** 038 ([renumbering map](renumbering-2026-10-24.md))
> **Roadmap disposition (2026-10-23):** Reuse the Go MCP implementation and backend authority. New agent breadth is limited to the active release-kit workflow.
> See the [current execution order](README.md). Older decision text is
> historical wherever it conflicts with that order or the audited architecture.

**Status:** Partially implemented (Go MCP server, tool surface and OAuth present)
**Status note (2026-10-23):** Implementation exists in server/internal/mcp. Older server-inventory text is historical; current code and the release-readiness index govern extensions.
**Date:** 2026-10-17  
**Owners:** Platform Engineering  
**Historical dependencies:** RFC 009, RFC 027, RFC 012, RFC 030, RFC 014, RFC 023

## Decision

### Authorized expansion, 2026-11-05

The owner authorized agents and API keys to publish, so people can post from Claude,
Codex, OpenCode, any MCP client and the REST API. Where the older text below says
scheduling or publishing a draft is human-only, this narrows it for one operation.

- `createPost` (`POST /api/v1/posts`) writes a post or thread and schedules or publishes
  it in one call, with no review by a person. It needs the new `post:publish` scope. No
  key has it by default, the consent page never pre-ticks it even when a client asks,
  and `post:schedule` does not imply it, because those keys were issued on the promise
  of scheduling approved content only.
- A workspace with Require approval keeps that rule: the draft is created, nothing is
  queued, and the result is `awaiting_approval`. No tool approves.
- The call takes finished text per platform. The serializer from a composer document to
  captions lives in TypeScript, and tools don't call Next.js, so **a stored draft is
  still scheduled by a person** and `scheduleContentDraft` stays out of the tool table.
  Exposing it would need a Go port of that serializer.
- Everything a schedule checks runs before the draft exists, so a refused post leaves
  nothing behind. `Idempotency-Key` is required, and a retry can't post twice.
- Private social sets stay session-only: a key can't post to one, or read or cancel the
  posts in one.
- The risk this accepts is a prompt-injected agent posting to public accounts. Mitigations:
  the opt-in scope, `openWorldHint` so clients confirm, the skill's instruction to confirm
  with the user, the audit trail, and the monthly posts allowance.

### Authorized expansion, 2026-10-24

The Typefully implementation assignment authorizes the existing REST/domain operations
to be exposed through the existing Go server. The current inventory has 34 tools;
`lib/agents/mcp-clients.ts` and the Go tool table remain executable inventories.

- `draft:write` creates, edits, duplicates, deletes and tentatively plans permitted
  drafts. A stable import receipt deduplicates creation; optimistic versions protect edits.
- The separate opt-in `draft:comment` scope permits comments, replies, resolution and
  removal of the key's own contributions. The author is the API key, never a person.
  Comments preserve approval of unchanged publication content.
- The separate opt-in `queue:write` scope updates a shared set's time zone, weekly slots
  and natural-time preference with a version check. It cannot rename a set, move existing
  scheduled posts, grant approval or publish a draft.
- `artifact:read` permits canonical comment, queue, calendar and mention reads. Private
  social sets remain session-only. Every write rechecks current membership/key status,
  workspace entitlement and tenant ownership in the canonical product service.
- Content-draft approval, rejection, requesting changes and scheduling/publish-now remain
  human-only. Existing approved campaign scheduling under `post:schedule` is unchanged.
- Outbound webhook administration remains owner/admin session-only. The private Zapier
  package uses signed static hooks configured by that person; it does not gain webhook
  administration through a draft key.

Local protocol, database and browser verification is documented in the work items.
Directory approval for Claude, Raycast and Zapier is not implied by local packaging.

Shots gives AI agents its workspace operations through the MCP server that
already runs in the Go social backend
(`server/internal/social/chat/mcp`). This RFC extends that
server. It does not replace it, and it does not start a second one.

- **One server, in Go.** MCP runs only in the Go backend. Next.js neither hosts
  nor proxies MCP. Each environment publishes one public MCP URL at the root
  of its own host, with RFC 9728 protected-resource metadata. Production is
  `https://shots-mcp.playbookmedia.io/mcp`.
- **The same domain services as REST.** Tools call `server/internal/product`
  and `server/internal/publishing`, the packages behind `/v1/*`. They never
  call Next.js, and they never query Ent directly, which would skip the tenant
  checks those services run.
- **The same principal as REST.** Every call resolves to one workspace and one
  actor: a workspace API key. A key the user creates and a key minted by the
  OAuth consent flow are the same kind of credential. They pass the same scope,
  entitlement, and quota checks that `/api/v1` applies. An MCP call can never
  do what the REST API would refuse.
- **No second spec.** Tool input schemas, scopes, plan gates, and quotas are
  read from the production OpenAPI document (`/openapi.json`). The Go binary
  embeds a committed copy of that document, and CI fails when the copy drifts.
- **People approve, agents may schedule.** No tool approves anything. A key
  with the opt-in `post:schedule` scope may schedule posts and visuals a person
  already approved, and cancel scheduled posts.
- **Leftovers of the original app go.** The original social tools, the `ask_social` agent, the
  social widgets, keys in URL paths, the SSE transport, and the self-hosted
  relay are removed from the Shots MCP surface.

## What the server serves today

This inventory was read from the code on 2026-10-17. The package is a close
port of the original app's `start.mcp.ts`, Mastra's OAuth middleware, and
`mcp.relay.service.ts`. It serves the original social-scheduling toolset scoped
to a social `Organization`. Nothing in it is about Shots.

### Mounting

`server/cmd/social-api/main.go` wraps the whole router with the
MCP handler (`cors().Wrap(a.MCP.Handler(...))`). The MCP handler matches its own
paths and passes the rest on. None of the router's middleware applies to it:
no throttler, no auth middleware, no compression. `internal/app/app.go` wires
it as `mcp.New(a.Agent, a.Tools, a.Organizations, mcpOAuth{a.OAuth}, relay)`.
The process listens on `PORT` (3000). Compose publishes it on
`localhost:3100`, and production runs it as a child of `combined-backend`.

### Endpoints

| Path                                               | Transport and auth                                                   | Tools served                |
| -------------------------------------------------- | -------------------------------------------------------------------- | --------------------------- |
| `/mcp`, `/mcp/`                                    | Streamable HTTP, `Authorization: Bearer <org API key or pos_ token>` | All tools plus `ask_social` |
| `/mcp/{apiKey}`                                    | Streamable HTTP, key in the URL path                                 | All tools plus `ask_social` |
| `/sse/{apiKey}`, `/message/{apiKey}`               | Legacy HTTP+SSE, key in the URL path                                 | All tools plus `ask_social` |
| `/mcp-oauth-dynamic`                               | Streamable HTTP, OAuth bearer, DCR issuer                            | All tools                   |
| `/mcp-oauth-claude`                                | Streamable HTTP, OAuth bearer, DCR issuer                            | All but 8 media tools       |
| `/mcp-oauth-chatgpt`                               | Streamable HTTP, OAuth bearer, static-client issuer                  | All tools                   |
| `/mcp-oauth`                                       | Former ChatGPT path                                                  | All tools                   |
| `/.well-known/oauth-protected-resource/{mount}`    | RFC 9728 metadata for the four OAuth mounts                          | none                        |
| `/.well-known/oauth-authorization-server/{issuer}` | RFC 8414 metadata for `-chatgpt` and `-dynamic`                      | none                        |
| `/.well-known/openid-configuration/{issuer}`       | OIDC metadata when `OPENAI_OAUTH_CLIENT_ID` is set                   | none                        |
| `/.well-known/openai-apps-challenge`               | `OPENAI_APP_CHALLANGE` text                                          | none                        |

The root `/.well-known/oauth-protected-resource` returns 404 on purpose, so
`/mcp` is not treated as OAuth-protected. The OAuth authorization server is the
Social controller at `/oauth/*`: dynamic client registration, the authorize
request, an authenticated approve, and the token endpoint. Its consent page is
`FRONTEND_URL/oauth/authorize`, which Shots does not have.

Each request builds a new stateless server (`Stateless: true`,
`JSONResponse: true`, `DisableLocalhostProtection: true`).

### Tools

The tools are hand-written with a zod-like DSL in `internal/chat/toollist.go`.
There are 20 of them, plus `ask_social`:

- **Channels:** list integrations and groups, read a provider schema, and
  trigger a provider function. The trigger is destructive.
- **Posts:** schedule a post, list posts, and change post settings. Scheduling
  and settings are destructive.
- **Media:** generate an image, upload from a URL, list media, and the upload
  widget with its ticket and status.
- **Video:** generate a video, list its options, call a video function, and
  read its status.
- **Clipping:** clip a YouTube video, read its status, and the clipping widget
  ticket.
- **`ask_social`:** an OpenAI chat loop over the same tools.

Every tool is scoped to the social organization. Scheduling creates social
posts directly, so it bypasses the Shots approval gate in RFC 012.

### Authentication

- **API keys** are a plaintext equality match on `Organization.apiKey` in the
  social schema, not the hashed Shots workspace keys.
- **OAuth** issues `pos_` tokens that resolve to a social organization and
  user. The advertised scopes (mcp:read and mcp:write) are never enforced.
  The resource indicator is never checked, so a token minted for one mount
  works on all four.
- Any token without the `pos_` prefix falls back to the API-key lookup, even on
  the OAuth mounts.

### Widgets and relay

- **Widgets.** Two MCP Apps widgets (`ui://social/upload` and
  `ui://social/clipping`) upload media and show clipping progress against the
  social media endpoints.
- **Relay.** The relay (`MCP_SELF_HOSTED_RELAY=true`) proxies tool calls from
  the original app's cloud to a customer's self-hosted instance. It holds that instance's API
  key, keyed by a `psh_` token.

### Gaps

- No rate limiting: the handler sits outside the router's throttler.
- No audit records. MCP posts are only tagged `creationMethod: "MCP"`.
- No request IDs. The slot named "request ID" holds the raw bearer token.
  Nothing reads it today, but it is a leak waiting to happen.
- The SSE `/message` route checks that the path key belongs to some
  organization, then routes only by `sessionId`, without binding the session
  to that organization.
- SSE sessions live in process memory, so they break across replicas.
- Only `groupList` is executed in tests. Destructive tools are untested.

## Leftovers of the original app and what happens to them

| Item                                                                    | Today                                   | Decision                                                                  |
| ----------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------- |
| Server name `Social MCP`                                                | `server.go`                             | Renamed `Shots`                                                           |
| Social tools (channels, posts, media, video, clipping)                  | Every mount                             | Removed from MCP. The chat copilot keeps its own copy.                    |
| `ask_social` agent tool                                                 | `/mcp`, `/sse`                          | Removed. An annotation-less catch-all tool cannot be scoped or confirmed. |
| `ui://social/*` widgets and `/media-widget`, `/clipping-widget` tickets | Registered resources                    | Removed from MCP. Uploads use signed upload URLs, as REST does.           |
| Social organization API keys and `pos_` tokens                          | All mounts                              | Refused. Only Shots workspace credentials are accepted.                   |
| Keys in URL paths (`/mcp/{key}`, `/sse/{key}`)                          | Served                                  | Removed. Keys in URLs end up in proxy and access logs.                    |
| HTTP+SSE transport                                                      | `/sse`, `/message`                      | Removed. Every target client speaks Streamable HTTP.                      |
| Self-hosted relay and `psh_` tokens                                     | Behind `MCP_SELF_HOSTED_RELAY`          | Removed (see Relay below)                                                 |
| `claudeHiddenTools`                                                     | Hides 8 media tools on the Claude mount | Removed. No Shots tool generates AI media.                                |
| `/.well-known/openai-apps-challenge`                                    | `OPENAI_APP_CHALLANGE`                  | Kept. It is needed for the ChatGPT directory.                             |
| Legacy `/mcp-oauth` mount                                               | Former ChatGPT path                     | Removed. No Shots connector was ever created against it.                  |
| Unused `Paths`, static and introspection validators                     | Dead code                               | Deleted                                                                   |

## Goals

- Agents can do through MCP what a scoped API key can do through `/api/v1`,
  and nothing more.
- One credential model for REST and MCP, revocable from the same settings
  page.
- Schemas, scopes, and plan gates that cannot drift from the REST contract.
- Every call carries a request ID, a client name, and a workspace in logs.
  Every mutation is audited in the same transaction as its effect.
- A setup guide and a tested configuration for each supported client.

## Non-goals

- Approving content from an agent (RFC 027, RFC 012), or scheduling anything
  a person has not approved.
- Connecting or disconnecting social channels (RFC 030).
- An MCP surface for the in-product copilot. RFC 027 governs that runtime.
- MCP prompts, resources, sampling, or elicitation. The first version serves
  tools only.
- A second MCP server in Next.js, in Scalar, or anywhere else.

## Architecture

```text
agent client ──Streamable HTTP──► shots-mcp.playbookmedia.io/mcp   (Go, screenshot-studio-backend)
                                    │ authenticate key → workspace + actor
                                    │ per-key rate limit
                                    │ scope, entitlement, quota   ◄── embedded openapi.json
                                    │ validate input              ◄── embedded openapi.json
                                    ▼
                         server/internal/product, publishing   (same code as /v1/*)
                                    │ tenant-scoped queries, audit in transaction
                                    ▼
                                PostgreSQL
```

- The MCP package builds a `product.Configuration` from the platform Ent client
  on the same database. It uses the same object store, Redis quota counter, and
  monthly meter that `server/cmd/product-api` wires.
- Tool adapters are thin. Each one decodes the validated input, calls one
  domain function with the resolved `product.Actor`, and returns its result.
  Business rules stay in the domain packages.
- Next.js has two jobs. It is the OAuth consent page, because the person
  signs in there. It is also the settings page that creates keys and shows
  client snippets. Both get their data through `lib/backend/sdk.ts`.

## Tool surface

Each tool name is the `operationId` of the REST operation it mirrors. The
scope, plan gate, and quota columns are read from that operation in
`/openapi.json` at startup. They are listed here for review, not as a second
source.

| Tool                     | REST operation                                                | Hints                 | Scope            | Plan gate           | Quota              |
| ------------------------ | ------------------------------------------------------------- | --------------------- | ---------------- | ------------------- | ------------------ |
| `listReleases`           | `GET /api/v1/releases`                                        | read-only             | `artifact:read`  | `workspace:use`     | none               |
| `createRelease`          | `POST /api/v1/releases`                                       | write                 | `release:create` | `release:create`    | `api:write:minute` |
| `createAssetUploadUrl`   | `POST /api/v1/assets/upload-url`                              | write                 | `upload:sign`    | `asset:create`      | `api:write:minute` |
| `completeAssetUpload`    | `POST /api/v1/assets/{assetId}/complete`                      | write, idempotent     | `asset:write`    | `workspace:use`     | `api:write:minute` |
| `createAssetDownloadUrl` | `GET /api/v1/assets/{assetId}/download-url`                   | read-only             | `artifact:read`  | `workspace:use`     | none               |
| `deleteAsset`            | `DELETE /api/v1/assets/{assetId}`                             | **destructive**       | `asset:write`    | `asset:delete`      | `api:write:minute` |
| `captureScreenshot`      | `POST /api/screenshot`                                        | read-only, open world | `artifact:read`  | `workspace:use`     | none               |
| `listCampaigns`          | `GET /api/v1/campaigns`                                       | read-only             | `artifact:read`  | `campaign:workflow` | none               |
| `getCampaign`            | `GET /api/v1/campaigns/{campaignId}`                          | read-only             | `artifact:read`  | `campaign:workflow` | none               |
| `createCampaign`         | `POST /api/v1/campaigns`                                      | write                 | `release:create` | `campaign:workflow` | `api:write:minute` |
| `listApprovals`          | `GET /api/v1/approvals`                                       | read-only             | `artifact:read`  | `campaign:workflow` | none               |
| `requestCampaignReview`  | `POST /api/v1/campaigns/{campaignId}/review-requests`         | write                 | `release:create` | `campaign:workflow` | `api:write:minute` |
| `scheduleCampaignPost`   | `POST /api/v1/campaigns/{campaignId}/posts/{postId}/schedule` | write, open world     | `post:schedule`  | `campaign:workflow` | `api:write:minute` |
| `listScheduledPosts`     | `GET /api/v1/scheduled-posts`                                 | read-only             | `artifact:read`  | `workspace:use`     | none               |
| `createScheduledPost`    | `POST /api/v1/scheduled-posts`                                | write, open world     | `post:schedule`  | `workspace:use`     | `api:write:minute` |
| `cancelScheduledPost`    | `POST /api/v1/scheduled-posts/{scheduledPostId}/cancel`       | **destructive**       | `post:schedule`  | `workspace:use`     | `api:write:minute` |

Notes on the table:

- Every tool also requires `workspace:use`, the check every `/api/v1` route
  runs first.
- `tools/list` shows only the tools the key's scopes allow, so an agent never
  plans around a tool it cannot call.
- The REST operations for campaigns, approvals, and the entitlement tags come
  from the RFC 014 remaining work. They ship before the tools that mirror them.
- `deleteAsset` carries `destructiveHint: true`, so clients ask for
  confirmation. Every read tool carries `readOnlyHint: true`.
- `captureScreenshot` also carries `openWorldHint: true`, because it renders a
  public URL. Go's `internal/capture` client takes the screenshot. The URL
  passes the same public-host guard that the web route applies, and the
  rendered image comes back as MCP image content.
- **Scheduling** (`scheduleCampaignPost`, `createScheduledPost`) takes only
  approved content: a campaign post must be `APPROVED` with an approved
  visual, and a variant must be `APPROVED` with an approved review. The domain
  checks that, the brand terms, the channel, and the character limit, and it
  charges `posts:monthly`, exactly as for a session. Both carry
  `openWorldHint: true`, because what they schedule goes out to a public
  channel. `cancelScheduledPost` carries `destructiveHint: true`.
- **Workflow start.** `/v1` starts the publishing workflow as soon as it
  schedules. The MCP process has no tenant Temporal client, so the
  once-a-minute due-post dispatcher (`scheduled-posts` in
  `temporalmaintenance`) starts it. A post an agent schedules publishes within
  a minute of its time. A cancelled post is never claimed, because the claim
  requires `SCHEDULED`.
- **Link check.** The REST schedule reads each link in the post and refuses
  one whose preview is broken, unless `skipLinkCheck` is true. That check runs
  in the web tier, so `scheduleCampaignPost` refuses a call without
  `skipLinkCheck: true` rather than skip a check REST would run. The tool
  description tells the agent to check the post's links first.

What agents cannot do, and why:

| Capability                          | Why it is absent                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Approve, reject, or request changes | RFC 012 makes these decisions human-only. The backend refuses non-session actors (`authorizeDecision`), and RFC 027 says no tool approves. |
| Approve a campaign or a design      | Same rule. `TransitionCampaign` and `ApproveCampaignDesign` refuse API keys.                                                               |
| Schedule unapproved content         | Scheduling requires an approved post or variant, whoever schedules it.                                                                     |
| Connect or disconnect a channel     | RFC 030: channel credentials are a person's action.                                                                                        |
| Edit approval policies              | RFC 043: automation never edits policy.                                                                                                    |
| Transition or archive a campaign    | Left out of the first tool set. The REST operation exists for sessions and scripts.                                                        |

## Schemas from the OpenAPI document

- **Snapshot.** `npm run openapi:export` writes the production document to
  `server/internal/shotsapi/openapi.json`. That is the same document
  `/openapi.json` serves, generated from the zod contracts. The file is
  committed. CI regenerates it and fails on any diff. The OpenAPI breaking-change
  check (RFC 014) compares it against `main`.
- **Embedding.** Package `shotsapi` embeds the file. At startup the MCP server
  builds each tool from its operation:
  - `inputSchema`: the path parameters, query parameters, header parameters
    (`Idempotency-Key` becomes `idempotencyKey`), and the request body
    properties, merged into one object with every `$ref` resolved;
  - `description`: the operation summary and description;
  - `outputSchema`: the success response, when it is a JSON object;
  - policy: the API-key scope from the operation's `workspaceApiKey` security
    requirement, and the feature and quota from `x-shots-entitlement`.
- **Fail closed.** A tool whose `operationId` is missing, has no API-key scope,
  or has an input that is not an object stops the server from starting. A Go
  test fails the same way, so the problem surfaces in CI before deploy.
- **Validation.** Arguments are validated against the generated schema before
  dispatch. The domain function validates them again, exactly as it does for
  REST.

To expose a scope or plan gate to Go, PR 2 records each binding's tenant
requirement in its contract. The OpenAPI generator then emits the scope as
`security: [{ workspaceApiKey: [scope] }]` and the plan gate as
`x-shots-entitlement`. Contracts, route bindings, the reference, the typed
client, and the MCP tools all read that one declaration.

## Authentication

### Workspace API keys

`/mcp` accepts the same keys as `/api/v1`:

- in `Authorization: Bearer ss_…`, which every MCP client supports;
- or in `X-API-Key`, which REST scripts already use.

Go verifies a key the way Better Auth does:

1. Hash the key with SHA-256 and encode it as unpadded base64url.
2. Look up the Better Auth `apikey` row by that hash.
3. Require the key to be enabled and unexpired, and its workspace
   (`referenceId`) to be operational.

The key's `permissions` JSON is the scope set, the same field `apiKeyAllows`
reads today. The resolved actor is
`product.Actor{Kind: "api_key", KeyID, OrganizationID, RequestID, Display}`,
which the domain packages already recheck on every call.

### OAuth for hosted clients

Claude.ai, Claude Desktop, ChatGPT, and other clients that cannot hold a pasted
key use OAuth 2.1 with PKCE. The flow reuses the existing authorization server
and changes what a grant is:

1. **Discovery.** The client reads `/.well-known/oauth-protected-resource/mcp`
   (or the metadata of the `-claude`, `-chatgpt`, or `-dynamic` mount). That
   points at the existing RFC 8414 issuer. Dynamic clients register at the
   existing `/oauth/register`.
2. **Consent.** The browser opens `FRONTEND_URL/oauth/authorize`, the Shots
   web consent page:
   - A signed-in member who may create API keys (owner or admin, the same rule
     as Settings → Developer API) sees the client name, its redirect host, and
     the requested scopes, and can narrow the scopes.
   - The page validates the request and records the approval through
     `lib/backend/sdk.ts` (`POST /v1/agent-authorizations/preview`, then
     `POST /v1/agent-authorizations`). The backend checks the client against
     the registered OAuth clients, then stores a 10-minute, single-use, hashed
     authorization code in a new platform table, `agent_authorization`. The
     row holds the workspace, the user, the client, the redirect URI, the PKCE
     challenge, and the scopes.
   - Denying redirects with `error=access_denied`.
3. **Token.** The client calls the existing `/oauth/token`. The social service
   authenticates the client as before. A Shots code (`shc_` prefix) then goes
   to the platform exchanger, which:
   - checks PKCE and the redirect URI;
   - consumes the code with a conditional write, and disables the key a
     replayed code already produced, since a replay means the code leaked;
   - mints a workspace API key named after the client, with exactly the
     approved scopes and metadata that marks it as agent-issued;
   - returns that key as the `access_token`.

So an OAuth access token _is_ a workspace API key. It uses the same
verification, the same scope checks, and the same audit actor. It is listed and
revoked on the same settings page. Revoking the key ends the connection.
Agent-issued keys do not expire by default, the same as user-created keys. The
consent page offers the same optional expiry.

### What is refused

- Social organization keys, `pos_` and `psh_` tokens, and session cookies.
- Keys in URL paths or query strings.
- A missing credential on `/mcp` gets `401` with
  `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"`,
  so clients that support OAuth start the flow on their own.
- An invalid, disabled, or expired key gets `401 invalid_token`.

## Scopes

MCP scopes are the API-key scopes in `lib/auth/api-key-scopes.ts`. There is no
second scope vocabulary. The authorization server advertises them in
`scopes_supported`, the consent page grants a subset, and the minted key holds
exactly that subset.

| Scope            | Lets an agent                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `artifact:read`  | list releases, campaigns, the review queue, and the schedule; read a campaign; sign a download URL; capture a screenshot |
| `release:create` | create releases and draft campaigns; submit drafts for review                                                            |
| `post:schedule`  | schedule approved campaign posts and approved variants; cancel scheduled posts                                           |
| `upload:sign`    | sign asset uploads                                                                                                       |
| `asset:write`    | complete and delete asset uploads                                                                                        |
| `source:write`   | no MCP tool in the first version                                                                                         |

`post:schedule` is never granted by default. Settings and the consent page
leave it unchecked, so a person opts in per key. For a session, scheduling
still needs `publish:manage`, and a fresh second factor where RFC 030 asks for
one. The Go backend rechecks the key's `post:schedule` permission itself
before it schedules or cancels, rather than trust the caller's scope check.

## Entitlements, quotas, and parity with REST

Each call runs one fixed pipeline, in the same order `requireTenantAccess` uses
for REST:

1. Authenticate the key, which resolves the workspace and the actor.
2. Apply the per-key rate limit.
3. Require the operation's API-key scope.
4. Require `workspace:use`, then the operation's feature, through
   `product.Configuration.GetFeatureDecision`. That is the function the web
   reaches through the SDK for REST.
5. Consume the operation's declared quota through `ConsumeWorkspaceQuota`.
6. Validate the arguments, then call the domain function.

Failures use the REST error envelope, returned as a tool result with
`isError: true`. The `code` values are the REST ones: `unauthorized`,
`forbidden`, `not_found`, `conflict`, `workspace_feature_not_entitled` with
`feature`, `currentPlan`, and `requiredPlan`, and `rate_limited` with `limit`,
`quota`, and `retryAfter`. A missing or foreign identifier returns
`not_found`, never `forbidden`, so identifiers stay non-enumerable across
workspaces.

## Rate limits

- **Per key:** 60 calls per minute, matching the Better Auth limit every REST
  key call passes through, and 20 screenshots a minute, matching
  `POST /api/screenshot`. The counts are kept in the backend's Redis counter.
  When the counter is unavailable the per-key limit is skipped: reads
  continue, and writes are still refused by the workspace quota below.
- **Per workspace:** write tools consume the quota their REST operation
  declares (`api:write:minute`: 300, 1,500, or 10,000 a minute by plan, per
  RFC 023). This counter fails closed.
- **Transport:** request bodies over 1 MiB are refused. A tool call times out
  after 60 seconds.

## Audit and observability

- **Mutations** write their existing audit actions (`product.release_created`,
  `product.campaign_created`, `product.campaign_post_status_changed`,
  `product.campaign_post_scheduled`, `post.scheduled`, `post.cancelled`,
  `product.asset_upload_signed`, `product.asset_deletion_requested`, and the
  rest) inside the domain transaction. The actor is the key's display name and
  the request ID is the MCP call's request ID.
- **OAuth.** A consent writes `product.agent_access_granted`. A code exchange
  writes `product.api_key_created`, the action Settings already uses.
- **Every call** writes one structured log line, `shots.mcp_call`, with:
  - `requestId`, `tool`, `client`, `organizationId`, and `keyId`;
  - `outcome` (`ok`, `denied`, `invalid`, `error`) and `durationMs`.

  Arguments and results are never logged.

- **Request ID.** It is the caller's `X-Request-Id` when that header is valid,
  otherwise a new ID. It is never the credential.
- **Client name.** The registered OAuth client name for an agent-issued key,
  otherwise the `User-Agent` product token. A stateless transport only sees
  `clientInfo` on `initialize`, not on the tool calls that matter.

Tool-call success rate per connected workspace is the metric that matters. A
connection that mostly fails is one users abandon. Alerts also cover:

- any call that succeeds where the same principal's REST call would be refused
  (this must be zero);
- sustained refusals per tool;
- latency per tool.

## Relay

The relay goes. It exists so the original app's cloud can front a self-hosted instance. A
self-hosted Shots publishes its own `/mcp`, so there is nothing to front. Keeping
the relay would leave the server holding customer instance keys and running an
outbound proxy to customer-chosen hosts, with no Shots use case behind it.
`relay.go`, the `psh_` and `psc_` grants, `MCP_SELF_HOSTED_RELAY`, and
`POST /oauth/authorize/self-hosted` are deleted.

## Scalar

The reference at `/api-reference` keeps Scalar's own MCP and agent features
disabled (`mcp: { disabled: true }` and `agent: { disabled: true }` in
`app/api-reference/route.ts`). Scalar's MCP would publish a second MCP surface,
generated outside the Go authentication, rate-limit, and audit path.

## Client integrations

Every guide points at the Go URL. The guides have one source in the web app,
rendered at `/docs/agents`, on the settings page, and in `/llms-full.txt`, so a
snippet is never copied by hand. The settings page (Settings → AI agents) shows
the URL for the current environment, creates a scoped key that fills each
client's snippet, and lists the agents connected through OAuth.

| Client                                                               | Transport and auth                                                                                         | Setup                                                                                                                                                                        |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code                                                          | HTTP and an API key, or HTTP and OAuth                                                                     | `claude mcp add --transport http shots https://shots-mcp.playbookmedia.io/mcp`, with `--header "Authorization: Bearer …"` for a key. A plugin bundle wraps the same command. |
| Claude.ai, Claude Desktop                                            | OAuth through `/mcp-oauth-claude`                                                                          | Custom connector URL                                                                                                                                                         |
| ChatGPT                                                              | OAuth through `/mcp-oauth-chatgpt` for the listed app, `/mcp-oauth-dynamic` for a developer-mode connector | Connector or Apps SDK app URL                                                                                                                                                |
| Cursor, VS Code (Copilot), Windsurf, Gemini CLI, Codex CLI, OpenCode | HTTP and an API key, or OAuth through `/mcp-oauth-dynamic`                                                 | Each client's JSON or TOML snippet                                                                                                                                           |

`/llms.txt` lists the MCP URL, the OpenAPI document, and an agent quickstart.

## Failure behavior

| Failure                            | Behavior                                                            |
| ---------------------------------- | ------------------------------------------------------------------- |
| Database unavailable               | Every call fails with `503`. No partial writes.                     |
| Redis unavailable                  | Reads continue. Writes are refused with `rate_limited`, as on REST. |
| Embedded spec missing an operation | The server refuses to start.                                        |
| Screenshot provider down           | `captureScreenshot` returns an `isError` result. Nothing is stored. |
| Key revoked mid-session            | The next call returns `401`. Nothing is cached between calls.       |
| Workspace scheduled for deletion   | Every call is refused, as `AuthorizeAPIKey` already does.           |
| Client sends an unknown argument   | Rejected before dispatch, matching REST's strict mutation bodies.   |

## Security threats

| Threat                                     | Mitigation                                                                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Agent approves its own output              | No such tool exists. The domain refuses non-session actors anyway.                                                               |
| Agent schedules unapproved content         | The domain schedules only approved posts and variants, for every actor.                                                          |
| Prompt-injected agent schedules or cancels | `post:schedule` is opt-in per key. `cancelScheduledPost` is destructive, so clients confirm. Every change is audited.            |
| Prompt-injected agent deletes assets       | `deleteAsset` is marked destructive, so clients confirm. Deletion needs `asset:write`, the plan gate, and the in-use check.      |
| Cross-workspace access by identifier       | The workspace comes only from the key. Every query filters on it. Unknown or foreign identifiers return `not_found`.             |
| Stolen OAuth code                          | Single use, 10 minutes, hashed at rest, bound to the client, redirect URI, and PKCE verifier.                                    |
| Malicious dynamic client                   | Consent shows the redirect host. Codes go only to a registered redirect URI. Granted scopes never exceed what the person picked. |
| Credential in logs                         | No keys in URLs. Request IDs are never credentials. Arguments are never logged.                                                  |
| Drift between REST and MCP policy          | Both read one contract. CI fails on spec drift. Parity tests assert the same refusal.                                            |
| SSRF through `captureScreenshot`           | The public-host guard and the screenshot provider fetch the page, never the backend's own network.                               |

## Acceptance criteria

1. An unauthenticated `/mcp` request returns `401` with a `resource_metadata`
   challenge, and the protected-resource metadata names the DCR issuer.
2. A key from workspace A cannot read or change any record of workspace B
   through any tool. Every foreign identifier returns `not_found`.
3. A tool refused by an entitlement returns `workspace_feature_not_entitled`
   with the same feature and plans as the matching REST call.
4. A key without the operation's scope is refused before the domain runs.
5. `tools/list` contains the tools in this RFC that the key's scopes allow.
   Their input schemas equal the ones generated from the embedded OpenAPI
   document, and that document equals `/openapi.json`.
6. `deleteAsset` and `cancelScheduledPost` are listed with
   `destructiveHint: true`.
7. Every mutation writes its audit record with the MCP request ID. Every call
   logs request ID, client name, and workspace.
8. MCP Inspector connects with a key and runs `listReleases`.
9. The OAuth flow mints a key with exactly the approved scopes, and revoking
   that key ends the connection.
10. Social keys, `pos_` tokens, and keys in URL paths are refused.
11. A key without `post:schedule` cannot schedule or cancel, through REST or
    MCP. A key with it cannot schedule a post that is not approved.

## Rollout

1. **RFC 014 remaining work.** Add the campaign, approval, and scheduled-post
   resources, record contract requirements in OpenAPI, publish the typed
   client, and add the OpenAPI diff in CI.
2. **Go MCP.** Add the Shots tools, API-key authentication, the OAuth grant
   exchange, rate limits, and logging. Remove the social surface. Ship behind
   the existing mount.
3. **Public URL.** Set `PLATFORM_MCP_URL=https://shots-mcp.playbookmedia.io/mcp`
   for the backend and the web.
   - The backend has no public route otherwise: the social API stays
     internal. On the `shots-mcp.playbookmedia.io` host only, the MCP paths
     reach it: `/mcp` and its OAuth mounts, `/.well-known/oauth-*`, and
     `/oauth/*`.
   - OAuth discovery reads metadata from the host root, so the MCP needs a
     host of its own.
4. **Web.** Add the consent page, Settings → AI agents, the client guides, and
   `/llms.txt`.
5. **Directories.** Submit to the Claude and ChatGPT directories only after
   each client's guide has run end to end against a deployed environment.

## Open questions

1. **API-key access to the schedule.** Resolved on 2026-10-17: the owners
   asked for agents to schedule campaign posts and manage scheduled posts.
   Scheduling and cancelling take the new `post:schedule` scope. Reading the
   schedule, including channel account identifiers, takes `artifact:read`,
   like the campaign posts that already report delivery state. Approval stays
   with a person.
2. **Who may connect an agent.** This RFC reuses the API-key rule, owner or
   admin. Should a creator be able to connect an agent limited to the scopes
   that role already holds?
3. **Agent key lifetime.** Agent-issued keys follow user keys and do not
   expire by default. Should OAuth grants expire with refresh tokens instead?
4. **ChatGPT static client.** `/mcp-oauth-chatgpt` needs a statically
   registered client (`OPENAI_OAUTH_CLIENT_ID`). Shots has no operator flow to
   register one yet. Until it does, ChatGPT developer-mode connectors use
   `/mcp-oauth-dynamic`.
