# Fork development rules

This repo is a PlaybookMediaLLC fork of KartikLabhshetwar/screenshot-studio.
The fork is the product of record: Shots, the release-readiness platform.
Product direction lives in `docs/company.md` and `docs/vision.md`; the authoritative
execution order lives in `docs/rfcs/README.md` and the README roadmap. Upstream
remains the original browser screenshot editor.

## Repository layout

The repository separates the backend from its clients, as polar.sh does:

- `server/`: the Go backend (APIs, workers, Ent models, migrations). Its
  `Makefile` runs the Go checks; see [server/README.md](server/README.md).
- `clients/`: the npm workspace. Run `npm` commands from here.
  - `apps/web/`: the Next.js web app, including the editor upstream ships at
    its repository root. Its rules are in
    [clients/apps/web/AGENTS.md](clients/apps/web/AGENTS.md).
  - `apps/collab-server/`: the real-time co-editing server.
  - `packages/`: shared libraries (backend SDK, typed API client, editor).
  - `integrations/`: native clients (Raycast, Zapier, Shortcuts) and the
    agent plugin for Claude Code, Codex and OpenCode.
- `dev/`: local development and repository tooling. `dev/studio` (behind
  `make`) runs the Compose stack in `dev/compose*.yaml`; `dev/native-stack`
  runs it as host processes where images cannot be pulled, as in cloud
  sessions (the [run-native-stack skill](.agents/skills/run-native-stack/SKILL.md));
  `dev/verify-rfcs.py` and `dev/release-flow.cjs` back the RFC and release
  checks.
- `infra/`: deployment (Helm chart in `infra/charts/`, DigitalOcean, storage).
- `docs/`: product, architecture and RFC documentation.

When instructions conflict, the `AGENTS.md` nearest to the changed file wins
for its directory. The current code, this file and
[server/README.md](server/README.md) override historical RFC sketches,
[ARCHITECTURE.md](docs/ARCHITECTURE.md) and any skill in `.agents/skills/`
that still names Prisma, PlanetScale or Trigger.dev: Go, Ent and Temporal own
data and durable work now.

## Reuse before writing new code

Every code change follows this workflow. It keeps the monorepo from growing
second copies of components, contracts, queries and business rules.

Before you implement a change, you MUST:

1. Read this file, the `AGENTS.md` nearest to the files you change, and the
   guide it links ([server/README.md](server/README.md) for `server/`,
   [Playbook Core](docs/playbook-core.md) for web platform code). Use the
   matching task skill in `.agents/skills/` when one exists.
2. Name the owner: the app or package, and the layer (UI, web API contract,
   SDK call, Go handler, Go domain, Ent and SQL, Temporal workflow). The
   [owners table](#owners) maps each concern to its directory.
3. Search for code that already does the behavior: components, hooks, zod
   schemas, types, SDK methods, Go domain functions, Ent queries, workflows
   and activities, provider adapters, tests and fixtures. Search the owner,
   its neighbors and the shared owners below, not only the file you opened.
4. Read each candidate's source, callers, contract and tests. With the
   code-review-graph tools ([CLAUDE.md](CLAUDE.md)), start with
   `semantic_search_nodes_tool`, then `query_graph_tool` with `callers_of`,
   `importers_of` and `tests_for`. Use `rg` when the graph is unavailable,
   still building, or does not index the files (Markdown, YAML, generated
   code).
5. Choose by the order below before you create anything.

Take the first option that is correct:

1. **Use** an existing implementation when its behavior and contract fit.
2. **Extend** it when the new behavior belongs there and every existing
   caller and invariant still holds.
3. **Extract** shared behavior into its owner when two real, compatible
   consumers exist.
4. **Create** new code when the candidate is unsuitable: reuse would add a
   dependency the [boundaries](#boundaries) forbid, couple unrelated
   workflows, or change behavior a caller relies on.

Similar-looking code is not interchangeable. Before you reuse it, compare
behavior, authorization, tenant scope, error handling, performance, and side
effects (writes, audit records, emails, provider calls, quota use).

- NEVER create a duplicate because the existing code was hard to find or
  needs a reasonable extension.
- NEVER add an abstraction, option or wrapper for a single use case to make
  code look reusable.
- A new package under `clients/packages/` or a new primitive in
  `clients/apps/web/components/ui/` needs two consumers, or a second adopter named in
  [the RFC index](docs/rfcs/README.md) or the README roadmap.
- When you write new code beside a similar candidate, state in one line, in
  the PR or the handoff, why the candidate did not fit. It is your call; it
  needs no approval.

### Owners

`web/` is short for `clients/apps/web/`.

| Concern | Owner |
| --- | --- |
| UI primitives | `web/components/ui/` (Radix); platform screens: `web/components/platform-ui/`, `web/components/platform-shell/` |
| Rich-text editor | `clients/packages/platejs-editor`, a library that imports nothing from the app |
| Web API contracts and errors | `web/lib/api/contracts/`, `web/lib/api/schemas.ts`, `web/lib/api/route.ts`, `web/lib/api/platform-errors.ts` |
| Product data from the web | `web/lib/backend/sdk.ts` over `clients/packages/screenshot-studio-backend-sdk` |
| Public API client | `clients/packages/shots-api-client`, generated by `npm run api:generate` |
| Sessions, roles, permissions | `web/lib/auth/` (Better Auth); the one authorization path is `web/lib/auth/access.ts` |
| Tenant business domains | `web/lib/tenant/`, `web/lib/workspace/`, `web/lib/core/` ([code layout](docs/playbook-core.md#code-layout)) |
| Plans, billing, credits | `web/lib/billing/`; Go `server/internal/workspaceplan`, `server/internal/quota` |
| Go HTTP handlers | `server/internal/httpapi` (product), `server/internal/social/api` (social) |
| Go business rules | `server/internal/product`, `server/internal/<domain>` |
| Data model and migrations | `server/ent/schema` with `server/platformmigrations/sql`; social: `server/internal/social/ent/schema` with `server/internal/social/migrations` |
| Durable work | Temporal: `server/internal/temporal*`, `server/internal/social/{workflows,activities,worker}` |
| Social providers | `server/internal/social/integrations/social/<provider>` |
| Events and webhooks | `server/internal/webhooks`, `server/internal/notifications` ([outbound webhooks](docs/outbound-webhooks.md), [notification events](docs/workspace-notification-events.md)) |
| Test helpers and fixtures | `web/test/`, `web/test/e2e/framework/`, Go `*_test.go` beside the code |
| Dependencies | `clients/apps/web/package.json`, `clients/package.json`, `server/go.mod`; npm is the only JS package manager |

Check the dependency files for a library that already does the job before you
add one.

### Boundaries

- The web never touches the database (rule 4 of
  [keep upstream merges cheap](#keep-upstream-merges-cheap)). Do not add a
  web-side query to avoid writing a backend endpoint.
- Route handlers, tRPC procedures, MCP tools and Go HTTP handlers adapt
  transport onto the domain. Put a business rule in `web/lib/tenant`,
  `web/lib/workspace` or `server/internal/<domain>`, where every transport
  shares it; never re-implement it in a handler.
- Product and social records have separate Ent clients, repositories and
  migrations. Customer publishing uses the product post state and calls the
  social provider adapters directly ([server/README.md](server/README.md#architecture)).
  Do not merge product and social logic because it looks alike.
- Platform code may call the upstream editor; it does not move platform logic
  into editor files to share it ([keep upstream merges cheap](#keep-upstream-merges-cheap)).
- Do not move code into a shared package when that crosses a boundary above.
  A few duplicated lines beat a wrong dependency; say why in the handoff.

## Engineering standards

- **Types and validation.** Follow the
  [TypeScript standards](CONTRIBUTING.md#coding-standards): no `any`, typed
  parameters and returns. In TypeScript, parse every runtime boundary
  (request body, webhook, provider response, environment) with the owner's
  zod schema and derive the type with `z.infer`. API code uses only zod-derived types
  ([web rules](clients/apps/web/AGENTS.md)).
- **One source of truth.** Import, never redeclare, a schema, enum, role,
  permission, API-key scope, route, error code, plan or environment variable
  that has an owner. Regenerate the OpenAPI document, `shots-api-client` and
  the Ent clients; never hand-edit generated code.
- **UI primitives.** Render web controls through `web/components/ui/`. A raw
  `<input>`, `<textarea>`, `<select>`, `<option>`, `<label>`, `<button>` or
  `<table>` in app code is an antipattern: it skips the design system's
  focus, invalid, disabled and dark-mode states and the platform-shell styles
  keyed to `data-slot`. Use `Input`, `Textarea`, `Select` (`Combobox` for a
  long or searchable list), `Label`, `Button` (`variant="custom" size={null}`
  for a bespoke control) and `Table`; `Checkbox` for a checkbox, `Slider` for
  a range, `DatePicker` or `DateRangePicker` for days, `TimePicker` for a time,
  `TimeZonePicker` for a zone, `SwatchColorPicker` for a color, `FileDropZone`
  for a visible file input and `Disclosure` for a collapsible section, never
  the browser's `type="date|time|color"` inputs, `<datalist>` or `<details>`.
  Only `components/ui/` itself, `<input type="hidden">` and a hidden file input
  behind a button use the raw elements; ESLint enforces it in
  `clients/eslint.config.mjs`.
- **Compatibility.** Before you change shared code, list its callers and
  keep their behavior or update them in the same change. A public API break
  must be listed in `server/internal/shotsapi/breaking-changes-allowed.txt`.
  A table change needs both its Ent schema and a reviewed SQL migration
  ([database ownership](server/README.md#database-ownership)). Keep
  registered Temporal workflow versions for replay.
- **Security and tenancy.** Authenticate, authorize and build tenant context
  through `web/lib/auth/access.ts` and `route(contract, { auth, handler })`;
  Go re-validates session and membership through Ent. Scope every query and
  mutation to the resolved organization. NEVER widen a permission, scope or
  tenant filter, or skip a check, to make code reusable.
- **Money and side effects.** In billing, credits, quotas and Stripe events,
  keep Stripe's integer minor units with their currency, verify webhook
  signatures (`web/lib/billing/signature.ts`), keep ingestion idempotent, and
  keep the `AuditLog` entry the mutation writes. Change plan and approval
  state only through their owners: `web/lib/billing/stripe-events.ts` and
  `campaignPostTransitions` in `web/lib/tenant/campaign-status.ts`. Never add an automatic retry
  to a provider mutation without an idempotency guarantee: an ambiguous
  publish is `UNKNOWN_DELIVERY` by design.
- **Errors.** Map failures through `web/lib/api/platform-errors.ts` (REST and
  tRPC) and the `userError` helpers in `server/internal/product/user_errors.go`.
  A failure reaches the caller as an error response or a recorded job failure.
  NEVER swallow an error or return a default value that hides it.
- **Tests.** Prove behavior at the lowest tier that can show it, and extend
  the existing test file and fixtures for that behavior before adding new
  ones. Assert results and persisted effects, not internal calls. Never skip,
  weaken or delete a test to get green. The upstream testing section in
  `docs/ARCHITECTURE.md` does not apply.

| Tier | Where | Run |
| --- | --- | --- |
| Unit and contract | `web/test/*.test.ts`; other workspaces: `src/**/*.test.ts` | `npm test` in `clients/` |
| Web server modules | `web/test/*.server.ts` | its `test:*` script in `clients/apps/web/package.json` |
| Go | `*_test.go`; `*_integration_test.go` need their `*_TEST_DATABASE_URL` | `make -C server check` |
| Browser flows | `web/test/e2e/*.spec.ts` | `make e2e`, following the [add-e2e-flow skill](.agents/skills/add-e2e-flow/SKILL.md) |
| Whole stack | tenant isolation, social publishing | `make tenant-isolation`, `./dev/social-gate` |

Add a browser flow for an authenticated journey, a tenant or permission
boundary, or a downstream integration. Never mock authentication,
authorization, tenant isolation or database constraints there.

## Checks before you push

| Change | Run |
| --- | --- |
| `clients/` | `npm run quality:check` in `clients/`; `make check` runs it in Docker and adds the RFC check |
| `server/` | `make -C server check` |
| A zod API contract | `npm run api:generate` in `clients/`, then commit the diff |
| `docs/rfcs/` | `python3 dev/verify-rfcs.py` |
| Journeys, tenancy, publishing | `make e2e`, `make tenant-isolation`, `./dev/social-gate` as they apply |

CI runs all of these. Do not loosen a lint rule, `--max-warnings=0`, the
format scope, a CI step or a boundary test's exemption list to pass a check.

## Handoff

For implementation work, end with a short report sized to the change:

- **Reused:** the existing code or pattern you used or extended.
- **New:** code added beside a similar candidate, and why the candidate did
  not fit.
- **Affected:** shared code and the consumers your change reaches.
- **Checks:** what ran and the result; any failure, and any check you could
  not run with the reason.

## Branch and release flow

- Start work branches from `develop` and target `develop` in every work PR,
  including fixes, dependencies, upstream sync and release preparation.
- `main` is the production release branch. Only a PR from this repository's
  `develop` branch may target `main`, and only as an intentional release.
- Merge release PRs with a merge commit; do not squash or rebase `develop`
  into `main`. Preserve both long-lived branches after merging.
- Prepare version/changelog changes through Release Please PRs into `develop`.
  Production deploys and published releases remain tied to `main`.
- See [branching and releases](docs/branching-and-releases.md) for checks,
  repository rules and the release procedure.

## Keep upstream merges cheap

1. Put new platform code in new directories and new files. Edit upstream
   editor files only when the change belongs upstream too.
2. Do not reformat or restyle upstream files.
3. Keep platform namespaces separate: new Ent models, new routes, and new
   env vars get platform names, not editor names.
4. The web never touches the database, and API routes declare zod
   contracts. [clients/apps/web/AGENTS.md](clients/apps/web/AGENTS.md) has
   the rules and the tests that enforce them.

## Upstream sync

`.github/workflows/sync-upstream.yml` merges upstream main into the
`upstream` branch every night and opens a PR against develop. Upstream keeps
the web app at its repository root; the fork keeps it in `clients/apps/web/`.
Git's rename detection maps most upstream paths onto the moved files. Do not
lower its threshold: below 30% it pairs deleted fork pages with unrelated ones.

Resolve conflicts by class:

1. Platform code, tenancy, campaign domain, infra: the fork wins.
2. Editor internals the fork never modified: upstream wins.
3. An upstream file that lands at its old root path (`app/`, `components/`,
   `lib/`, `tests/`, ...) was missed by rename detection. Port the change into
   the same path under `clients/apps/web/` (upstream's `tests/` is
   `clients/apps/web/test/`; upstream's `app/[locale]/page.tsx` is
   `clients/apps/web/app/[locale]/(editors)/editor/page.tsx`, the route group the
   screenshot editor shares with Store screenshots), then `git rm` the root copy.
4. `bun.lock` is deleted in the fork (npm is the only package manager). When
   upstream changes it, resolve the modify/delete conflict with
   `git rm bun.lock`.
5. The root `package.json` only carries the release version for Release
   Please, so upstream's changes to its own root `package.json` conflict
   there. Keep the fork's root file and port upstream's dependency changes
   into `clients/apps/web/package.json`. `clients/package.json` and
   `clients/package-lock.json` are fork-owned: keep the `workspaces` entry,
   then regenerate the lockfile with `npm install` in `clients/`.
6. Run the repo checks before you push the merge.
