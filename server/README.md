# Publishing services

This directory contains Screenshot Studio's Go product API, its Temporal
worker, and the social provider adapters both use in process. The combined
backend image runs the API and worker together in production.

## Layout

| Path | Contents |
| --- | --- |
| `cmd/product-api` | The product API (`:8080`). The web calls it through the SDK. With `PUBLIC_PORT` it also serves the MCP server there. |
| `cmd/product-worker` | The tenant Temporal worker for publishing, onboarding, and maintenance (`:8081`). |
| `cmd/combined` | The production entry point. It starts the two processes above in one container and serves the MCP server on `:3000`. |
| `cmd/platform-migrate` | The one migration command for the product and social SQL. |
| `cmd/social-migrate` | The social SQL only, for isolated social tests. |
| `internal/httpapi` | The product API's HTTP handlers. |
| `internal/<domain>` | The product domain packages. |
| `internal/socialconnect` | Channel connections (OAuth start and exchange, identity checks) in process. |
| `internal/social` | The social provider adapters and integration storage the API and worker use. |
| `ent`, `internal/social/ent` | The product and social Ent clients. |
| `platformmigrations`, `internal/social/migrations` | The reviewed product and social SQL. |

`Dockerfile` builds one image for every environment. Production runs its
default entry point, `/combined-backend`. Compose and kind run one binary for
each service: `/publishing-backend`, `/publishing-orchestrator`, or
`/platform-migrate`.

## Architecture

The services split into a control plane and an execution plane:

- **The product API** is the control plane. It exposes tenant-scoped APIs for the social API
  channel connections and scheduled posts, validates approved creative variants,
  preserves idempotency, and writes audit records.
- **The product worker** is the Temporal execution plane. It runs the versioned post
  workflow, re-checks workspace and approval eligibility, and records
  publication attempts. The direct provider path calls the Go social adapters
  and stores their remote receipt without creating a second social `Post` row.
- **Ent** is the Go data model and query layer for product and social records.
  One PostgreSQL database and its `public` schema hold both. The Next.js app
  calls the published SDK and never opens a database connection.

Each scheduled post maps to one Temporal workflow: workflow ID `post_<post-id>`,
workflow type `PostWorkflowV2`, workflow task queue `main`, and social activity
task queue `social`. `PostWorkflowV1` remains registered for replay safety. The
workflow owns the scheduled timer, `cancel` and `poke` signals, and bounded
provider retry timers. The V2 activity calls the provider adapter directly and
stores its remote receipt on the canonical attempt. An ambiguous failure is
`UNKNOWN_DELIVERY` because retrying could create a duplicate social post.
[Scheduling reliability](../docs/scheduling/reliability.md) documents the
states and the failure model.

## Temporal guarantees

The services make these Temporal guarantees at Screenshot Studio's provider
boundary:

| Guarantee | Implementation |
| --- | --- |
| Versioned workflows remain registered | `PostWorkflowV1` and `PostWorkflowV2` are both workers |
| Atomic recovery start | `poke` plus `SignalWithStartWorkflow` and `USE_EXISTING` |
| Searchable ownership | typed `organizationId` and `postId` attributes, registered on self-hosted Temporal |
| Durable scheduling and provider backoff | Temporal timers; classified `429` and safe `5xx` responses retry |
| No automatic retry of provider mutations | submit activity has one attempt; timeout becomes `UNKNOWN_DELIVERY` |
| Pending provider confirmation | V1 keeps read-only status checks for replay; V2 requires a confirmed direct receipt |
| Missing-post recovery | `missing-post-workflow` runs immediately and hourly when `RUN_CRON=true` |
| Durable outcome writes | receipt, failure and unknown writes retry for 24 hours; the provider ID is logged first |
| Stalled-post recovery | the `scheduled-posts` job settles `PROCESSING` posts whose run closed: `UNKNOWN_DELIVERY` after a possible send, requeued otherwise |
| Late publication window | a post that cannot start within an hour of its time fails as `MISSED_WINDOW` without sending |
| Worker placement controls | `EXCLUDE_QUEUE` and `WORKER_CONCURRENCY_DIVIDER` |
| Namespace readiness | `DescribeNamespace` with a 10-second bound |
| TLS and API-key authentication | both settings apply independently |

The per-network adapters, token refresh, comments, plugs, and repeat posts live
inside the social Go packages. Screenshot Studio's tenant Temporal
activity invokes the LinkedIn, X, or Instagram adapter directly. The social
HTTP API handles OAuth, but customer publishing does not call
`/public/v1/posts` or stage a second media copy. The social backend's autopost,
streak, and email workflows are product domains, not publishing transport, and
remain owned by Screenshot Studio's campaign and email systems.

## Database ownership

`ent/schema` and `internal/social/ent/schema` are the Ent sources for
product and social tables. One ordered `/platform-migrate` command applies
reviewed SQL from `platformmigrations/sql` and
`internal/social/migrations` to the same `public` schema. Prisma and
Drizzle are no longer runtime or migration authorities. Do not call
`client.Schema.Create` from either service. When a table changes, update its
Ent schema and reviewed SQL migration, then run `make generate` and `make
check` in this directory.

The Ent projections for `creative_variant`, `approval`, `asset`,
`workspace_deletion`, and the audit tables intentionally contain only fields the
publishing services read or write.

## API

The backend listens on `:8080` by default:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | Process health |
| `GET` | `/readyz` | Database and Temporal readiness |
| `GET` / `POST` | `/v1/channel-connections` | List or create social destinations |
| `GET` / `POST` | `/v1/scheduled-posts` | List or create scheduled posts |
| `POST` | `/v1/scheduled-posts/{id}/cancel` | Cancel an unpublished post |

Service requests use `Authorization: Bearer $PUBLISHING_SERVICE_TOKEN` and
`X-Session-ID` with scoped organization, user, and request headers. The backend
validates the session and membership through Ent. The web server calls this
service through `clients/packages/screenshot-studio-backend-sdk`; browser code uses
the existing same-origin tRPC facade and never receives the service token.

The orchestrator listens on `:8081` only for `/healthz` and `/readyz`.

## Configuration

Both services require `DATABASE_URL` and connect to Temporal with
`TEMPORAL_ADDRESS` (default `127.0.0.1:7233`), `TEMPORAL_NAMESPACE` (default
`default`), `TEMPORAL_API_KEY`, and `TEMPORAL_TLS`. The backend also requires
`PUBLISHING_SERVICE_TOKEN` and refuses to start or authenticate without it. The
orchestrator also requires:

- `R2_ENDPOINT`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
  (and optional `R2_REGION`, `R2_BROWSER_ENDPOINT`, `R2_DELIVERY_ENDPOINT`) for private tenant media.
  `R2_DELIVERY_ENDPOINT` overrides only the origin used to sign provider media
  delivery URLs; it defaults to `R2_ENDPOINT`. Use it when internal storage
  access and the public HTTPS delivery origin differ.
- `SOCIAL_API_URL` and an allow-listed API key reference for social OAuth and
  destination verification. They are held by the product backend, not the web.
  Without `SOCIAL_API_URL` the product API connects channels in process
  (`internal/socialconnect`) with the social provider settings,
  `PLATFORM_SOCIAL_ENCRYPTION_KEY`, `REDIS_URL`, and `STORAGE_PROVIDER`.
  The publishing worker reads social integration rows from the shared database
  and signs the canonical private asset when due.

Optional workflow controls are `TEMPORAL_TASK_QUEUE`,
`TEMPORAL_SOCIAL_TASK_QUEUE`,
`TEMPORAL_MAX_CONCURRENT_ACTIVITY_TASK_EXECUTORS`,
`EXCLUDE_QUEUE`, `WORKER_CONCURRENCY_DIVIDER`, `RUN_CRON`,
`PUBLISHING_ACTIVITY_TIMEOUT`, `PUBLISHING_RETRY_DELAY`,
`PUBLISHING_MAX_ATTEMPTS`, and `SOCIAL_REQUEST_TIMEOUT`.

## Development

```sh
make generate
make check
make build
```

`./dev/social-gate` (from the repository root) is the end-to-end check: it runs
the web, backend, Temporal worker, private RustFS, and a fake social provider,
and publishes through the direct Go path. The database-gated Go tests cover the
workflow mapping, missing-post and due-post recovery, and Ent compatibility.

From the repository root, start the optional Compose profile with:

```sh
make publishing-up
curl --fail http://localhost:8080/healthz
curl --fail http://localhost:8081/healthz
```

The image uses the `server` directory as its Docker build context.

## MCP server

The product API serves the Shots MCP server (RFC 026, `internal/mcp`) on a
second listener, `PUBLIC_PORT`, that serves nothing else: `/mcp`, the OAuth
mounts `/mcp-oauth-claude`, `/mcp-oauth-chatgpt`, and `/mcp-oauth-dynamic`,
their `/.well-known` documents, and `POST /oauth/register` and
`POST /oauth/token` (`httpapi.NewAgentOAuth`). Its tools call
`internal/product`, the same domain the `/v1` API serves, with the caller's
workspace API key as the actor:

- `internal/shotsapi/openapi.json` is the web's OpenAPI document (`npm run
  api:generate` in `clients/`). Each tool's input schema, API-key scope, plan gate, and quota
  come from the operation it is named after; the server refuses to start when
  one is missing.
- A call runs the REST order: per-key limit, scope, `workspace:use`, the
  operation's feature, its quota, then argument validation and the domain call.
  Every call logs one `shots.mcp_call` line with the request ID, client, and
  workspace.
- Scheduling tools need the opt-in `post:schedule` scope and take only
  approved posts and variants. The orchestrator's once-a-minute
  `scheduled-posts` dispatcher starts the workflow of a post an agent
  scheduled, and a cancelled post is never claimed.
- OAuth consent happens on the web (`/oauth/authorize`), recorded through
  `POST /v1/agent-authorizations`; `/oauth/token` exchanges the `shc_` code for
  a workspace API key with the approved scopes. Clients register in the social
  `OAuthApp` table (`internal/agentclients`), their secrets sealed with
  `JWT_SECRET`; `DCR_VERIFIED_DOMAINS` limits web callbacks.

Besides the product API's settings it reads `PUBLIC_PORT`, `PLATFORM_MCP_URL`
(required with `PUBLIC_PORT`), the public MCP URL, which must sit at a host
root for OAuth discovery: production is
`https://shots-mcp.playbookmedia.io/mcp`; `JWT_SECRET` (required, the social
backend's value), `FRONTEND_URL`, `SCREENSHOT_API_URL`, `SCREENSHOT_API_KEY`,
`DCR_VERIFIED_DOMAINS`, `OPENAI_OAUTH_CLIENT_ID`, and `OPENAI_APP_CHALLANGE`.
Per-key call limits use the product API's `REDIS_URL`.

Authenticated capture stays off unless the API and the worker both have
`PLATFORM_CAPTURE_CDP_URL` (Browser Run's account base,
`https://api.cloudflare.com/client/v4/accounts/<id>/browser-run`),
`PLATFORM_CAPTURE_CDP_TOKEN` (a Cloudflare API token with Browser Rendering - Edit,
separate from the design renderer's), and `PLATFORM_CAPTURE_STATE_KEY` (32 bytes,
base64). `PLATFORM_CAPTURE_STATE_KEY_PREVIOUS` reads state during a key rotation;
state is re-encrypted on its next validated use. `PLATFORM_CAPTURE_STATE_MAX_AGE`
(a Go duration, default `24h`) is how long saved sign-in state is kept before a
person must sign in again. The worker registers the `platform-capture` queue only
when capture is configured. See [authenticated capture](../docs/rfcs/authenticated-release-capture-review.md#10-implementation-status).

## Social code (`internal/social`)

`internal/social` is a library, not a service: the provider adapters, the
social integration storage and its Ent client. The product API connects
channels through it (`internal/socialconnect`) and the product worker
publishes, reads analytics and refreshes channel tokens through it
(`internal/social/tenantpublishing`). There is no separate social API or
social Temporal worker.

- `internal/social/integrations/social/<provider>`: one package per provider.
- `internal/social/database/<domain>`: the social Ent repositories and services.
- `internal/social/ent`: the generated Ent client; `internal/social/migrations`: the DDL.

**Migrations.** Run `/platform-migrate` before the API and worker. It applies
both Ent-backed SQL sets to one database and records their history.
`/social-migrate` remains in the image for isolated social tests; it is not a
second production migration job.

The migration command also configures the fixed `shots-founder-hub` OAuth
client. Set `FOUNDER_HUB_WEB_ORIGIN` to the Founder Hub web origin to register
its exact `/callback/shots/` browser return URL; HTTPS is required except for
loopback development. An unset value keeps native redirects only. Re-running
the command replaces the old browser origin and preserves the client's disabled
state, PKCE requirement, and grants. Every deployment migration must receive the
intended value; preview request headers never register redirect origins.

The Shots web server and Founder Hub API share a separate
`SHOTS_AUTH_SERVICE_TOKEN` of at least 32 bytes for the private Founder Hub
session endpoint. Keep it server-side and separate from
`PUBLISHING_SERVICE_TOKEN`. A user OAuth token alone cannot read the private
workspace authority snapshot.

The Founder Hub phone app reaches the voice API through the gateway at
`/api/founder-hub/voice/<suffix>`, with the methods, bodies and responses of
`/api/v1/voice/<suffix>`; changing the workspace switches stays browser-only.
The gateway sends its service token, the person's Founder Hub access token and
the Founder Hub workspace id in `X-Shots-Organization-Id`. The web maps that id
to one of the person's organizations and forwards the session with
`X-Principal-Client: shots-founder-hub`; the backend checks that client's live
grant itself and holds the session to the named workspace's membership instead
of the browser's active workspace.

For hosted connectors, set `FOUNDER_HUB_MCP_URL` on both the Shots web server and
Founder Hub sync API to the exact public HTTPS `/mcp` URL (loopback HTTP is
supported locally). Shots then exposes OAuth discovery and public PKCE client
registration restricted to account profile and read-only meeting scopes.
Connector requests recheck current consent, grants, sessions, and workspace
permissions; connector tokens cannot authorize native storage or management.

OAuth refresh retries share a database lease and an encrypted response for 15
seconds. Reuse after that window revokes only the affected Shots session,
including its OAuth grants. If rotation completes but its retry response cannot
be saved, that session may need to sign in again after a lost response.

`dev/studio e2e` runs the server OAuth integration test locally and on CI's first
shard. To run it against another local stack, set `FOUNDER_HUB_TEST_API_URL`,
`BETTER_AUTH_URL`, `PUBLISHING_SERVICE_TOKEN`, and `SHOTS_AUTH_SERVICE_TOKEN`, then
run `npm run test:founder-hub-auth --workspace screenshot-studio` from `clients/`.
Set `FOUNDER_HUB_GATEWAY_URL` to the local Hub API's `/cloud` URL to include real
storage, resumable uploads, and gateway revocation checks.

```sh
SOCIAL_TEST_DATABASE_URL=postgresql://postgres@localhost:55432/social_test?sslmode=disable go test ./internal/social/...
```
