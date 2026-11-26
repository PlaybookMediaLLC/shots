# Playbook Core: the organization control plane

The backend in this repository is **Playbook Core**, the control plane for
every PlaybookMedia product. Screenshot Studio is the first web shell on top of
it. Other repositories (Wanta, OpenWhispr, bb, Steel, OpenScreen, Kaneo,
OpenConnector) are shells or execution engines. They are never an
organization authority.

> One organization ID. One membership system. One permission system. One
> company graph. One audit trail. Many shells and execution engines.

## What Core owns

Identity, sessions, organizations and switching, members, invitations, roles,
permissions, SSO and SCIM, entitlements, workspace settings, capability flags,
audit records, support grants, product surfaces, releases, campaigns, and
connection ownership all live here. They use the existing models: `User`,
`Session`, `Organization`, `Member`, `Invitation`, `WorkspaceSettings`,
`WorkspaceEntitlement`, `OrganizationEnterpriseSettings`, `SsoProvider`,
`ScimProvider`, `AuditLog`, `SupportAccessGrant`, `WorkspaceDeletion`,
`ProductSurface`, `Release`, and `Campaign`.

There is exactly one authorization path, `lib/auth/access.ts`:

1. authenticate the session or API key
2. resolve `Session.activeOrganizationId` (`resolveActiveOrganizationId`)
3. load the `Member` row for that organization
4. normalize the role
5. check the permission (`hasPermission`)
6. check the workspace is operational (`isWorkspaceOperational`)
7. build the tenant context
8. run the domain mutation in `lib/tenant` or `lib/workspace`
9. append an `AuditLog` entry in the same transaction

Client-side permission state is a rendering hint. **Client permissions control
presentation; server permissions control security.** A shell that receives a
401 or 403 refreshes its bootstrap.

## Code layout

| Path | Role |
| --- | --- |
| `lib/auth/*` | principals, sessions, RBAC |
| `lib/workspace/*` | organization, member, and settings lifecycle |
| `lib/tenant/*` | tenant-owned business domains |
| `lib/core/*` | cross-domain control-plane services (bootstrap, capabilities) |
| `app/api/v1/*` | the versioned shell and tenant API |
| `app/api/internal/*` | service API |
| `app/api/webhooks/*` | external event ingress |
| components and app routes | shell UI only |

Route handlers adapt HTTP onto these services. They never re-implement
business rules.

## Three API classes

| Class | Prefix | Callers | Authentication |
| --- | --- | --- | --- |
| Shell and user | `/api/v1/*` | web, Wanta, OpenWhispr, CLI, mobile | user session, or an organization API key for tenant routes |
| Internal service | `/api/internal/*` | workers, bb and Kaneo adapters, orchestration | service secret, never a browser session |
| Webhooks | `/api/webhooks/*` | GitHub, connectors, billing | per-provider signature and idempotent ingestion |

Inside `/api/v1`, shell routes (`me`, `bootstrap`, `organizations/*`) describe
a signed-in user. They refuse API keys. Tenant routes (`releases`,
`source-apps`, `assets`) also accept organization API keys with a scope. The
web app may also use tRPC (`/api/trpc`), which lives in the same codebase.
External shells must not depend on tRPC procedure names.

## Shell endpoints

| Endpoint | Permission | Returns |
| --- | --- | --- |
| `GET /api/v1/me` | session | the signed-in user |
| `GET /api/v1/bootstrap` | `workspace:read` in the active organization | the full `PlaybookBootstrap` |
| `GET /api/v1/organizations` | session | the user's memberships and roles |
| `GET /api/v1/organizations/:id` | `workspace:read` | organization identity |
| `GET /api/v1/organizations/:id/members` | `member:read` | members and roles |
| `GET /api/v1/organizations/:id/invitations` | `invitation:read` | invitations |
| `GET /api/v1/organizations/:id/settings` | `workspace:read` | locale, time zone, publish time |
| `GET /api/v1/organizations/:id/permissions` | `workspace:read` | role and resolved permissions |
| `GET /api/v1/organizations/:id/capabilities` | `workspace:read` | capabilities and the safe entitlement view |
| `POST /api/v1/organizations/:id/activate` | membership | switches the active organization, returns a fresh bootstrap |

`:id` routes act on the **active** organization only. To read another
organization, a shell activates it first. `activate` delegates to
`setActiveWorkspace`, which checks membership and deletion state the same way
the web switcher does.

The bootstrap shape is defined in `lib/core/bootstrap-shape.ts`. It is built
by copying named fields only, so connector secrets, OAuth tokens, browser
profiles, billing provider ids, and infrastructure details cannot leak into it.
Capabilities without a connected execution engine report `false`. Today that
is browser automation, voice capture, the engineering agent, and workflows.
`publishing` is true once the organization has an active channel connection.

Every shell request logs one structured line, `event:
playbook.shell_request`, with the route, status, latency, and the
`X-Playbook-Client` label (`web`, `wanta`, `openwhispr`, `cli`). The label is
for metrics only and never affects authorization.

## Ownership rules for other repositories

- **Wanta** (desktop shell): signs in, calls `GET /api/v1/bootstrap`, and
  renders the organization, switcher, role, and counters. Every durable edit
  goes through Core. Wanta keeps no local members, roles, invitations, billing,
  company graph, tasks, or customers.
- **OpenWhispr** (voice capture): knows the user id, the active organization,
  and the current product, customer, or campaign context. It delivers
  versioned capture artifacts to Core. It never syncs the organization
  database.
- **bb** (engineering runtime): receives a bounded, Core-authorized job:
  organization id, actor, run id, authorized repository, task, context packet,
  and constraints. Nothing else.
- **Steel** (browser runtime): receives bounded browser jobs: organization id
  for correlation, operation id, a profile reference, allowed domains,
  permission mode, and a validated plan. Steel never decides who is an admin.
- **OpenScreen** (rendering): receives render jobs. Core owns which
  organization owns the inputs and outputs.
- **OpenConnector**: owns OAuth credentials and provider execution. Core owns
  which organization owns a connection, who may use it, and its audit and
  approval state. Credentials never enter bootstrap or organization records.
- **Kaneo**: may model workspaces internally. Core stores the mapping. A Kaneo
  admin is not a Playbook admin.

The system is online-first and centrally authoritative. All collaborative
edits flow shell → Core API → membership and permission check → mutation →
`AuditLog`. The same mutation produces the same audit record whichever shell
called it.

## Product connection and the first campaign

A workspace connects its product as one or more `ProductSurface` rows: name,
URL, and `environment` (`production`, `staging`, `demo`, or `development`). A
`Release` holds the brief: title, benefit, plain-text description, audience,
and source links. It can be anchored to a surface. A `Campaign` links its
release and surface and always starts as `DRAFT`. A draft may have no angles
or posts. Copy is required only to enter `READY_FOR_REVIEW`.

Campaign status changes go through the table in
`lib/tenant/campaign-status.ts`, never inferred from filled fields.
Generation and publishing are job states, not campaign states. Editing a
release brief (`release.update`) changes only the brief. Campaigns, angles,
posts, and variants stay intact. Release and surface links use `ON DELETE SET
NULL`, so history survives deletion.

The campaign pages (`/campaigns`) are behind the `campaign:workflow` rollout
flag. Design-partner workspaces get it through
`WorkspaceEntitlement.featureOverrides`:

```sql
INSERT INTO workspace_entitlement ("organizationId", "featureOverrides", "updatedAt")
VALUES ('<organization id>', '{"campaign:workflow": true}', now())
ON CONFLICT ("organizationId") DO UPDATE
SET "featureOverrides" = COALESCE(workspace_entitlement."featureOverrides", '{}'::jsonb)
  || '{"campaign:workflow": true}'::jsonb;
```

`PLATFORM_CAMPAIGN_WORKFLOW=enabled` turns it on for every workspace in an
environment. The local Compose stack sets it by default. Existing campaigns are
never seeded or rewritten by the rollout.

Product analytics events (PostHog) are `product_surface_created`,
`release_created`, `campaign_draft_created` (with `elapsedSeconds` since the
form opened), and `campaign_opened`. The audit trail records
`product.surface_created`, `product.release_created`,
`product.release_updated`, `product.campaign_created`, and
`product.campaign_status_changed`. `product.campaign_created` carries
`workspaceAgeSeconds`, and the earliest one per organization is the time from
workspace creation to the first campaign draft.

## Launch intelligence

Campaigns built from a release go through a staged, reviewable pipeline:
a cited product spec drafted from the brief and the release's sources, a
campaign plan, production of on-brand visuals and channel copy, and AI
revisions that a reviewer applies or discards. See
[launch-intelligence.md](launch-intelligence.md) for the stages, data model,
and guardrails.

## Campaign studio (AI)

`lib/ai` is the platform's AI package. It is ported from `@canvas/ai` (oppulence-canvas)
and keeps its shape: `models/` (role-based model catalog, OpenRouter provider,
registry, settings/usage/logging middleware), `tools/`, `prompts/`, and `agents/`.
Models are addressed by role, not id:

| Role | Default (OpenRouter id) | Override |
| --- | --- | --- |
| `deep` | `anthropic/claude-opus-5.5` | `PLATFORM_AI_MODEL_DEEP` |
| `drafting` | `anthropic/claude-sonnet-5.5` | `PLATFORM_AI_MODEL_DRAFTING` |
| `fast` | `anthropic/claude-haiku-4.5` | `PLATFORM_AI_MODEL_FAST` |
| `nano` | `anthropic/claude-haiku-4.5` | `PLATFORM_AI_MODEL_NANO` |

`OPENROUTER_API_KEY` turns the studio on. Without it, the campaign pages show
their AI actions disabled, and `campaign.generate` and the `launch.*` AI
procedures refuse to run.

The campaign pages drive the launch pipeline (`docs/launch-intelligence.md`);
"Produce campaign" on a campaign's Assets page uses the tools below, briefed
with the approved spec and plan. `campaign.generate` (permission
`release:create`, charged `ai:credits:monthly` for its model calls) runs the
campaign studio agent (`lib/ai/agents/campaign-studio.ts`) from the release
brief alone, for API callers, in the caller's tenant context. Its tools are
built per run around one workspace and one campaign:

- `captureProductPage` captures a screenshot through the existing screenshot
  service. It accepts only the product surface URL and the release's source
  links (SSRF-checked, at most five), shares the screenshot rate limit, rejects
  near-blank captures, and stores the image as a `capture` asset.
- `createProductShot` composites a capture into a front-facing device frame
  from the editor's mockup set (`lib/ai/images/product-shot.ts`, sharp, bundled
  SF Pro fonts) on a gradient with a headline, and stores it as a `derived`
  asset whose parent is the capture. Phone frames require a mobile capture.
- `saveCampaignCopy` appends angles and draft posts to the campaign once per
  run. It never overwrites earlier generations.

Generated images link to the campaign through `CampaignAsset` and open in the
editor at `/?asset=<id>`. Every write is audited (`product.asset_generated`,
`product.campaign_copy_generated`, `product.campaign_generated` with model id,
step count, and token usage). Prompt and completion text are never logged.

### Designs: every editor capability as AI tools

When `PLATFORM_DESIGN_RENDERER=enabled`, the agent designs with the editor
itself instead of the fixed sharp compositor.

- **Design document** (`lib/design/document.ts`): a versioned, Zod-validated
  JSON form of one editor composition. It is a `template` plus overrides for
  canvas/aspect ratio, background (gradients, mesh/magic gradients, solids,
  images), pattern, main image (scale, radius, offset, rotation, shadow,
  frame/browser chrome, 3D perspective, filters), device mockups, text,
  overlays, annotations (arrows, boxes, circles, lines), redactions
  (blur/mosaic), and animation. Positions are normalized, so a document renders
  the same at any viewport. Images are references (`asset:<id>` or built-in
  `/paths`) that must belong to the workspace.
- **Catalog** (`lib/design/catalog.ts`): every option id the editor has
  (27 aspect ratios, ~110 gradients, 130+ mesh/magic gradients, solids,
  ~100 background images, 34 fonts, 18 mockups, 6 device layouts, 13 frames,
  overlays, 43 animation presets). Documents are validated against it.
- **Templates** (`lib/design/templates.ts`): the editor's own 6 image
  templates and 8 presets, applied through `applyVisualPreset` exactly as the
  editor does, plus 8 marketing layouts (headline spotlight, browser launch,
  laptop launch, product suite, phone duo, social phone card, story phone,
  editorial) that fill screenshot and headline slots.
- **Tools** (`lib/ai/tools/design-studio.ts`): `listDesignOptions` (the
  catalog by section), `createDesignFromTemplate`, `editDesign` (any change to
  any section, saved as a new variant by default), and `renderDesign`. A render
  returns a preview image to the model, so the agent checks legibility and
  cropping and fixes its own designs before finishing.
- **Rendering** (`lib/design/renderer.ts`): headless Chromium (`playwright-core`)
  opens `/render/<designId>?token=…`, a chrome-free page that mounts the
  editor's canvas, loads the document with the same loader the editor uses,
  and runs the editor's export at 2×. The token is an HMAC capability for one
  design and workspace that expires in five minutes, and workspace images are
  inlined as data URLs so the capture never sees a cross-origin image. Renders
  are stored as `export` assets and set as the design's `renderedAssetId`.
- **Editing**: every design, rendered or not, opens fully editable in the
  editor at `/?design=<id>`, with every layer live rather than a flat image.

| Variable | Purpose |
| --- | --- |
| `PLATFORM_DESIGN_RENDERER=enabled` | Use editor designs instead of sharp product shots, and enable Directions |
| `PLATFORM_RENDER_CDP_URL` | Remote browser over CDP: Cloudflare Browser Rendering in production, `render-browser` locally |
| `PLATFORM_RENDER_CDP_TOKEN` | Bearer token for the CDP endpoint (a Cloudflare API token with Browser Rendering Edit) |
| `PLATFORM_RENDER_BASE_URL` | Where the browser reaches the app (default: `NEXT_PUBLIC_APP_URL`) |
| `PLATFORM_RENDER_CHROMIUM_PATH` | Local Chromium binary when no CDP URL is set |

Every render goes through `renderDesignForTenant` (`lib/design/render-design.ts`):

- **Render cache.** A render key hashes the document, the output format and
  scale, and the content (SHA-256) of every image the design references. When
  any design in the workspace already has a render with that key (the same
  design re-checked, or an identical variant), its stored image is reused and
  no render runs. The key lives on `Design.renderKey` next to
  `renderedAssetId`. Images live in object storage, not Redis.
- **Per-workspace fairness.** Real renders are limited to 60 a minute per
  workspace with the existing Redis rate limiter, so one burst cannot crowd
  out everyone else on the shared browser pool. Cache hits don't count. If
  Redis is down the limit fails open, because Cloudflare bounds concurrent
  browsers per account.
- **Fallback.** `isDesignRendererReady` probes a local CDP browser's
  `/json/version` and caches the answer briefly; Cloudflare is trusted until a
  render fails, because opening a session to probe it is billed. When renders
  are unavailable, campaign runs use sharp product shots instead of failing,
  the agent keeps `createProductShot` for renders that fail mid-run, and
  Directions reports itself unavailable.

Renders stay synchronous HTTP on purpose: callers wait for the bytes (the
agent reviews each render), renders take 1.5-3s, and a lost request is cheap
to retry. Long or batch work (video, bulk exports, scheduled kits) should run
as Temporal workflows that render through the same browser, not through a
separate queue.

Production renders in **Cloudflare Browser Rendering**, so there is no render
service to deploy and the web image never ships Chromium.
`lib/design/renderer.ts` connects with Playwright's `connectOverCDP` to
`wss://api.cloudflare.com/client/v4/accounts/<account>/browser-run/devtools/browser?keep_alive=600000`
using `PLATFORM_RENDER_CDP_TOKEN`, opens one browser per agent run, and
reconnects if Cloudflare ends an idle session. The remote browser loads
`/render/<id>` from the public app origin and may contact nothing else; it
holds no tenant credentials, because every page carries its own five-minute,
single-design token. Without a CDP URL, the app renders in-process with a
local Chromium. With the flag off, the campaign agent falls back to sharp
product shots and Directions is hidden.


### In-editor AI

Signed-in workspace members get one assistant on every page and editor when
`OPENROUTER_API_KEY` is set. Open it with **Ask AI**, ⌘J, or the editor's
**AI** button. It is built on the same design layer as the campaign agent:

- **One turn route.** `POST /api/ai/assistant` streams newline-delimited lines:
  text, tool steps, then the reply. The model gets the workspace tools and the
  tools of the open surface. Surface tools have no server `execute`. Each call
  returns to the browser, which runs it with the editor's own actions and sends
  the result back. Surface tools need `artifact:edit`. Every round trip is rate
  limited and charged to `ai:credits:monthly`.
- **Surfaces.** The screenshot editor, Canvas, Store screenshots, Story Sets,
  Code Studio and the post composer each register their tools. Typed command
  schemas limit what the model may change. None of them deletes work.
- **Saved chats.** Go keeps the words and links of each person's last 30
  chats in a workspace (`assistant_thread`). Cards and Undo are not saved.
- **The post editor** also has its own AI menu on ⌘J
  ([RFC 025](rfcs/025-write-workspace.md#mentions-media-and-ai)). There, ⌘J
  opens that menu; **Ask AI** in the sidebar opens the assistant.
- **Attachments.** A message may carry up to three inline images. The server
  refuses a file that names an address. A voice memo becomes text to review.
- **Scoped commands.** ⌘K opens the copilot on the selected text, device,
  overlay, annotation, or main image, and the agent changes only that element.
  Selection is read from the stores and from the DOM markers the canvas
  already renders, with no changes to editor components.
- **Suggestions.** `editorAi.critique` reviews the canvas snapshot and
  returns up to three one-click changes, each validated against the current
  document before it is offered. It runs once when the panel opens and on
  demand, never while you edit.
- **Directions.** `editorAi.explore` saves the current image to the workspace,
  has the model propose variations, stores each as a variant `Design`, renders
  them with the headless renderer, and shows the previews. Choosing one loads
  it as a single undoable step. It requires `PLATFORM_DESIGN_RENDERER`.

`exportDesignDocument` (`lib/design/export.ts`) is the inverse of the loader:
it reads the live editor into a DesignDocument, normalizes pixel layers, and
drops anything not portable (local uploads, CSS-variable colors) section by
section.

Critique and directions use tool calls rather than structured output. The
change schema has far more optional fields than providers allow in constrained
JSON (OpenRouter's Vertex route caps it at 24), so tool arguments are validated
in code instead, and an invalid proposal goes back to the model to correct.

Upstream merges: all of this lives in fork-owned directories
(`lib/design`, `lib/ai`, `components/editor-ai`, `app/api/ai`). The only
upstream editor file touched is `components/editor/EditorLayout.tsx`, which
mounts `<EditorPlatformLayer />` in one line.
