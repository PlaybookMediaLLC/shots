# Local development

Use `make` for all local services. It calls `dev/studio`, which creates
`.local/dev.env` on the first run. This ignored file contains generated local
passwords and connection strings. Do not copy it to another environment.

Run `make help` to list all commands. Use `make logs SERVICE=app` to follow a
specific Compose service, or `make kind-logs COMPONENT=screenshot-studio` for
the application running in Kind.

## Compose

```sh
make up
make status
make logs SERVICE=app
make down
```

The app reloads at `http://localhost:3000`. Postgres is available on port
`54329`, the Go backend on `8080`, RustFS on `9003`, and the RustFS console on
`9004` (`/rustfs/console/`).

The dev server uses Turbopack. Its compile cache lives in the `app_next_cache`
volume, so a restarted container serves routes in about a second instead of
recompiling them; `make reset` clears it. Production builds still use webpack.

The app container has no database connection: every read and write goes
through the Go backend. Before the backend starts, the one-shot
`platform-go-migrate` service applies the product schema with the Go platform
migrator. A database created by the old `prisma db push` flow has no migration
records, so the migrator refuses it; run `make reset` once.

`make up` also makes sure a local account exists, so a fresh database still has
a login: sign in as `dev@localhost.test` with the `STUDIO_DEV_PASSWORD` value
from `.local/dev.env`. It owns a workspace named Playbook Dev.

`make down` asks whether to preserve data. Use `make reset` to remove all
Compose volumes without a second prompt.

`make smoke` checks the app, Postgres, Redis, RustFS, Storage, the
Redis-backed screenshot rate limit, and a temporary signed Storage
upload/read/delete operation. It also proves cache invalidation rejects an
unauthenticated request and validates an authenticated request body.

`make tenant-isolation` creates two disposable local users and workspaces. It
proves session and organization API-key requests cannot list another
organization's releases or access its asset by ID. It also proves key revocation
takes effect on the next request. It runs only against localhost; use `make
reset` when you want to remove its local fixtures.

## Design renderer

`make up` also starts `render-browser`, a headless Chrome that the app drives
over the Chrome DevTools Protocol (CDP), so AI campaign designs and editor
Directions render locally. Production takes the same path to Cloudflare
Browser Rendering. It runs in the `renderer` Compose profile and shares the
app container's network: Chrome loads the app at `localhost:3000`, and the app
reaches CDP at `localhost:9222`. Nothing new is published on the host.

Set `STUDIO_RENDERER=off make up` to skip it; the app then falls back to sharp
product shots and Directions is hidden. CI skips it because its flows do not
render designs (`npm run test:design-renderer` covers the CDP path), and
`make e2e` stops it because those flows recreate the app
container. Run `make up` again afterwards to bring it back. AI features also
need `OPENROUTER_API_KEY` in your shell when you run `make up`.

The browser shares the app container's network, so restarting the app on its
own (`docker restart`) leaves the browser unreachable until it is restarted
too; `make up` does both. AI generation then quietly falls back to product
shots.

`make e2e` replaces the hot-reload app with the production image — the
artifact that ships, and the only thing the browser suite runs against. Bring
that app up on its own with `make up-production`; `make up` restores the
hot-reload one.

It runs with `PLATFORM_AI_SCRIPTED=1`: a deterministic stand-in model
(`lib/ai/models/scripted.ts`) answers every AI stage, so the launch pipeline is
tested end to end without a provider key. That hook, downloads from the
screenshot mock, and room under Better Auth's sign-in limit all come from
`PLATFORM_E2E_HOOKS=1`, which [`lib/e2e-hooks.ts`](../clients/apps/web/lib/e2e-hooks.ts)
grants only to a production build serving a loopback origin. A deployment never
gets them, however its environment is set.

## Onboarding browser test

After `make up`, run the full sign-up and workspace onboarding flow in Chromium:

```sh
(cd clients && npx playwright install chromium) # once per machine
make e2e
make e2e-onboarding
make e2e-recovery
```

The browser suite creates unique local users and workspaces. It covers sign-in,
tenant assets, release webhooks, Redis limits, cache lifecycle, workspace
settings, audit controls, identity controls, and secret exposure.
`make e2e-recovery` runs serial failure and recovery checks for Redis, RustFS,
Storage, and Postgres. Use a Kind port-forward with
`E2E_MANAGE_SCREENSHOT_MOCK=false` so the command does not recreate Compose.
See [`test/e2e/README.md`](../clients/apps/web/test/e2e/README.md) to add flows with shared lifecycle hooks.

### Give Docker enough memory

Budget at least 12GB for the Docker VM before running the browser suite; CI
runners have 16GB. `make up` runs `next dev`, and compiling routes on demand is
memory-hungry enough to exhaust an 8GB VM mid-run. The failure does not look
like memory pressure from the test side: Playwright reports
`page.evaluate: Failed to fetch` or `net::ERR_CONNECTION_REFUSED`, because the
server died rather than answered. Confirm with

```sh
docker inspect screenshot-studio-app-1 --format '{{.State.OOMKilled}}'
```

The containers themselves are small, roughly 300MB in total, so raising Docker
Desktop's memory limit is the fix rather than trimming services.

### Warming routes is a `next dev` concern only

Under `next dev` a route compiles on its first request, which costs 5-30s, and
a browser navigation to an uncompiled route leaves `page.url()` on the previous
page until the server answers — indistinguishable from a redirect that never
happened, and slow to debug. The browser suite no longer meets that: it runs
the production build, where every route is already compiled. Only hand-driven
work against `make up` pays the cost, and only once per route:

```sh
for r in /sign-up /sign-in /two-factor /onboarding /workspace /; do
  curl -s -o /dev/null -w "$r %{time_total}s\n" "http://localhost:3000$r"
done
```

Repeated local runs can also trip auth rate limiting, which surfaces as a
sign-up that fails with an empty error element rather than a message. Clearing
Redis between runs rules that out:

```sh
docker exec screenshot-studio-redis-1 redis-cli FLUSHALL
```

The stack contains:

- Screenshot Studio in Next.js development mode with hot reload.
- The Go backend, its platform migrator, Temporal, and the orchestrator worker.
- Postgres and Redis.
- RustFS as the local R2-compatible object store.

### Go publishing services

The Go backend and orchestrator are part of the default stack. They own the
application's Postgres tables through Ent. Rebuild and verify them with:

```sh
make publishing-up
curl --fail http://localhost:8080/healthz
curl --fail http://localhost:8081/healthz
make publishing-test
```

For the end-to-end publishing check, run `./dev/social-gate`. It starts an
isolated stack with the web, backend, Temporal worker, private RustFS, and a fake
social provider, then publishes through the direct Go path. It never publishes
to a real social account.

The backend is a server-to-server API and requires the local
`PUBLISHING_SERVICE_TOKEN` for tenant operations. Each scheduled post starts one
Temporal workflow named `post_<post-id>`; the workflow owns the durable timer,
cancel signal, and rate-limit retry. Configure a social key only when testing an
actual publication. Compose exposes Temporal gRPC on port 7233 and
its local UI on http://localhost:8233.

The product API connects social channels in process and serves the MCP
server at http://localhost:3100/mcp. Put provider credentials in the ignored
`.local/social.env`; see
[Screenshot Studio backend and orchestrator](social-backend-deployment.md) for the
workspace binding and production configuration.

The RustFS bucket is private. The Go backend creates object keys under
`org/<organization-id>/<classification>/<asset-id>/<revision>/` and signs every
transfer; see [tenant asset storage](tenant-storage.md). Local setup also generates
Better Auth and audit secrets. Do not copy `.local/dev.env` to another
environment.

Cache cleanup and invalidation use the generated `CLEANUP_SECRET` in the
`x-shots-maintenance-secret` request header. It is server-only;
never send it from the browser.

## Quality checks

Run `make check` before you commit. It checks format, lint, TypeScript, unit
tests, file size, function size, complexity, nesting, and parameter count for
the server boundary. `npm install` in `clients/` installs the same check as the Git
pre-commit hook.

## Temporal maintenance development

Maintenance jobs run directly in the Go publishing orchestrator. There is no
Trigger.dev worker or project to configure. The default Compose stack
provides Temporal and the Go workers; `RUN_MAINTENANCE` defaults to false locally
so a normal editor development session cannot send customer announcements.

For isolated maintenance integration tests, create a `maintenance_test` PostgreSQL
database, apply the schema, and run from `server/`:

```sh
DATABASE_URL='postgresql://postgres:password@localhost:5432/maintenance_test?sslmode=disable' \
  go run ./cmd/platform-migrate
MAINTENANCE_TEST_DATABASE_URL='postgresql://postgres:password@localhost:5432/maintenance_test' \
  go test -race ./internal/maintenance ./internal/temporalmaintenance
```

The tests use disposable fixtures and fake mail/drain transports. Production
configuration and the six schedule IDs are documented in
[digitalocean-deployment.md](digitalocean-deployment.md).


## Production task deployment

The `Deploy Trigger.dev` workflow deploys task code after every merge to
`main`. Configure the GitHub `production` environment with the
`TRIGGER_ACCESS_TOKEN` secret and `TRIGGER_PROJECT_REF` variable. Keep runtime
secrets in the Trigger.dev production environment, not in GitHub Actions.

## Kind

```sh
make kind-up
kubectl --namespace screenshot-studio port-forward service/screenshot-studio 3000:80
curl --fail http://127.0.0.1:3000/api/health
make kind-down
```

`kind-up` builds the production image, loads it into the `screenshot-studio-dev`
Kind cluster, generates a Kubernetes Secret from the local values, and installs
the Helm chart with local Postgres, Redis, RustFS, Storage, PgBouncer, and
Imgproxy enabled. It also builds the Go backend image and runs it with a local
Temporal server; the chart's migration hook runs that image's `/platform-migrate`.
Kind is a production-like image test, not a hot-reload loop.

## Production storage

The Go backend signs uploads and downloads against an S3-compatible bucket:
RustFS locally, private Cloudflare R2 in production. The browser transfers
directly to the bucket through `R2_BROWSER_ENDPOINT`, so the bucket's CORS policy
must allow the web origin. The Compose RustFS initializer applies it locally.
