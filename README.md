# Shots by PlaybookMedia

**Release-ready product communication for B2B software teams.**

Shots is becoming a release-readiness platform: turn genuine product changes
into accurate, source-linked materials that marketing, sales, customer success
and customers can use. Teams keep their existing engineering, design,
documentation and publishing tools.

**The product promise: one approved product change becomes one reusable,
role-specific release kit.** The technical foundation exists; the complete
readiness workflow, production reliability and repeat paid adoption still need
validation.

[Company](docs/company.md) · [Vision and north star](docs/vision.md) ·
[Codebase audit](docs/release-readiness-audit-2026-10-23.md) ·
[RFC execution order](docs/rfcs/README.md)

**Platform and editor:** [shots.playbookmedia.io](https://shots.playbookmedia.io) ·
**Image tools:** [shots.playbookmedia.io/tools](https://shots.playbookmedia.io/tools) ·
**Code to image:** [shots.playbookmedia.io/code](https://shots.playbookmedia.io/code)

## The workflow we are building

1. **Detect and qualify.** Select a GitHub release, merged PR, deployment or
   manual change. Decide whether it warrants communication and who owns it.
2. **Establish the facts.** Collect real source material and screenshots;
   confirm what shipped, for whom, rollout, benefits and limitations.
3. **Create the kit.** Produce a versioned fact sheet, sales and CS talking
   points, customer announcement, FAQ and branded screenshots. Add email or
   social variants when useful.
4. **Review and deliver.** Show the evidence, approve exact versions and export
   or hand off to the tools teams already use.
5. **Maintain.** Identify potentially stale claims/images after later product
   changes and propose reviewable updates.

The initial customer hypothesis is B2B SaaS teams with roughly 20–200 employees
and at least two meaningful release moments per month. Product marketers,
product operations and launch owners are the daily users. Size, cadence and
willingness to pay are hypotheses, not established customer demographics.

## What exists and what is missing

The [2026-10-23 audit](docs/release-readiness-audit-2026-10-23.md) inspected source
at `5bc7b8d0` and ran 48 focused existing tests, all passing. “Present” below
means implementation exists; it is not a claim of complete production
verification. The audit links the relevant code and separates tests run from
tests only inspected.

| Area | Existing foundation | Next gap |
| --- | --- | --- |
| Release intake | Manual/source releases, GitHub change collection, deployment events and workflow relevance checks | Human qualification, accountable owner, rollout facts and meaningful-release grouping |
| Product facts | Versioned specs, source excerpts, citation/reference checks, limitations, FAQs and review | Claim-level supporting evidence and explicit human factual verification |
| Creative production | Image/video editor, brand kits, native documents, Story Sets, Canvas, multi-size and store exports | Reuse for kit screenshots; no new general-purpose editor required |
| Review | Human approval authority, spec/plan revisions, campaign post state transitions | Exact-version readiness across facts, audiences and every required kit artifact |
| Distribution | Export/share, design delivery to Slack/Notion/Figma, email and social scheduling | Role-specific document handoffs, durable receipts and evidence of use |
| Maintenance | Capture history, age-based freshness and revision proposals | Source-change → affected claim/image → kit/destination review |
| Platform | Auth/RBAC, tenant assets, API/SDK/MCP, Go backend, durable jobs and billing | Validate the complete narrowed workflow in a pilot environment |

Citation checks currently verify references. They do not prove that a source
supports a claim or that generated copy contains no additional assertions.
Likewise, a capture less than 30 days old is not necessarily current. These
are central product gaps, not claims that a new verification system has shipped.

## Existing creative and platform capabilities

The original browser screenshot editor is a substantial reusable creative
engine. It includes device/browser/window frames, multi-screenshot composition,
text and branding, redaction, animation, video export, cloud projects, share
links and batch exports. Story Sets and Canvas compose native documents and
preserve revision history. The store studio adds localization, device layouts,
compliance checks and provider upload paths. See the
[editor platform](docs/editor-platform.md) and [store screenshots](docs/store-screenshots.md).

Product capture supports public URLs with request safeguards and caching.
Workspace services include Better Auth, organization roles, enterprise identity
features, audit logs, scoped keys, brand context and tenant assets. Launch
intelligence drafts specs, plans, visuals and copy with human review. Social
publishing and Write remain supported capabilities. Provider availability and
live reliability require their own validation.

New platform work belongs in fork-owned modules. Shots is a PlaybookMediaLLC
fork of [KartikLabhshetwar/screenshot-studio](https://github.com/KartikLabhshetwar/screenshot-studio);
keep upstream editor merges inexpensive as described in [AGENTS.md](AGENTS.md).

## Roadmap

Work PRs target `develop`; releases promote `develop` into `main`. See the
[branch and release workflow](docs/branching-and-releases.md).

The [RFC index](docs/rfcs/README.md) is the authoritative build order and covers
every RFC. Numbers and filenames now follow priority: 001–006 active delivery,
007–008 conditional work, 009–035 existing foundations, 036–045 deferred
expansion, and 046–052 historical designs. The
[renumbering map](docs/rfcs/renumbering-2026-10-24.md) resolves earlier IDs.

Start engineering with **RFC 002: release qualification**, while **RFC 001**
runs the assisted pilot program and measures customer outcomes.

| Milestone | Increment | Definition of progress |
| --- | --- | --- |
| 0 | [001: assisted paid pilots](docs/rfcs/001-release-readiness-pilots.md) | Real kits with human fact checks, baseline effort, payment evidence and downstream-use records |
| 1 | [002: qualified releases](docs/rfcs/002-release-qualification.md) → [003: verified claims](docs/rfcs/003-claim-evidence-and-verification.md) | Owners resolve what shipped and support material claims with versioned evidence |
| 2 | [004: role-specific kits and readiness](docs/rfcs/004-release-kits-and-readiness.md) | Complete editable kits, exact-version approval gates and approved exports |
| 3 | [005: handoffs and adoption](docs/rfcs/005-release-kit-handoffs-and-adoption.md) | Receipts for selected destinations, safe retries and evidence of audience use |
| 4 | [006: evidence-based freshness](docs/rfcs/006-evidence-based-material-freshness.md) | Later changes produce targeted review and approved corrections |

[007: authenticated capture](docs/rfcs/007-authenticated-product-capture.md) is a
conditional track when paid pilot needs justify it. Reviewed uploads and public
capture keep the main sequence usable without it.

Wider social-network parity, general-purpose canvas expansion, autonomous
marketing campaigns and a separate interactive-demo product are deferred.
Maintain the existing tools and reuse them where they improve release kits.

The north-star outcome is **adopted release kits per active customer
organization**, with eligible-release coverage. A kit counts only with approved
facts, successful required handoffs and recorded use for each required audience. Guardrails
include factual corrections, release-to-approval time, customer labor saved,
operator cost, repeat usage and retention. Asset counts and social impressions
are secondary. See [vision.md](docs/vision.md) for the definition.

## Commercial validation

Current subscriptions are Pro **$29/month**, Business **$79/month** and
Enterprise **from $799/month**, with metered AI and no free plan. See
[RFC 023](docs/rfcs/023-pricing-and-unit-economics.md). The release-readiness
pilot hypothesis is approximately **$199–$399/month** or a defined per-release
fee; it is not a new implemented billing plan.

The first 90-day targets are 15 buyer interviews and three pilot commitments,
payment authorization from at least two buyers, repeat release cycles with
three customers, and a test of five paying organizations with renewal intent.
These are validation targets, not current traction. The
[company brief](docs/company.md) and [RFC 001](docs/rfcs/001-release-readiness-pilots.md)
define the evidence and decision gates.

## Architecture

The repository follows polar.sh's split: `server/` holds the Go backend and
`clients/` holds the npm workspace (the Next.js web app in `clients/apps/web/`,
the collaboration server, shared packages and native integrations).

Next.js/React provides the product UI and web API contracts. Product data goes
through `clients/apps/web/lib/backend/sdk.ts` to Go services; Go/Ent and SQL migrations own
PostgreSQL. Temporal runs durable work, object storage holds media, and AI
usage is metered. Reuse these boundaries for qualification, evidence, kits and
handoffs. The web does not access the database directly.

Current implementation guides are [Playbook Core](docs/playbook-core.md),
[backend services](server/README.md), [editor platform](docs/editor-platform.md)
and [local development](docs/local-development.md). Older RFC architecture
sketches and parts of [ARCHITECTURE.md](docs/ARCHITECTURE.md) retain historical
Prisma/Trigger.dev assumptions; they do not override the current code.

## Quick start

Install Docker with Compose, Git and Make, then start the local stack:

```sh
git clone https://github.com/PlaybookMediaLLC/screenshot-studio.git
cd screenshot-studio
make up
make status
```

Open [localhost:3000](http://localhost:3000). `dev/studio` generates the ignored
`.local/dev.env` and a local development account; see
[local development](docs/local-development.md) for sign-in, prerequisites,
provider configuration and test workflows. AI and live-provider features need
their own credentials. The web alone is not the complete platform stack.

For host-side tooling, run `npm ci` in `clients/` (npm is the package manager).
Useful checks:

```sh
python3 dev/verify-rfcs.py
python3 dev/verify-rfcs.py --self-test
(cd clients && npm run quality:check)
make publishing-test   # Go generation, tests, race checks and vet
```

The full quality and integration workflows require the services described in
the local development guide and [CI configuration](.github/workflows/ci.yml).

## Agent and API discovery

The deployed product publishes machine-readable interfaces for agents and API clients:

- [`llms.txt`](https://shots.playbookmedia.io/llms.txt) and
  [`llms-full.txt`](https://shots.playbookmedia.io/llms-full.txt)
- [OpenAPI 3.1 specification](https://shots.playbookmedia.io/openapi.json)
- [API documentation](https://shots.playbookmedia.io/docs) and
  [developer portal](https://shots.playbookmedia.io/developers)
- Markdown representations of supported pages via `Accept: text/markdown`
- [MCP server and agent setup](https://shots.playbookmedia.io/docs/agents), so Claude,
  Codex, OpenCode and other agents can write, schedule and publish posts, with a
  [plugin and skill](clients/integrations/agent-plugin). In Claude Code:
  `claude plugin marketplace add PlaybookMediaLLC/shots@main`, then
  `claude plugin install shots@shots`

## Deployment

The app ships production Docker images, a portable Helm chart, and GitHub
Actions workflows for DigitalOcean App Platform. See [deployment instructions](docs/deployment.md).

For the hot-reload local stack, Temporal Go workers, RustFS, and Kind commands,
see [local development](docs/local-development.md). Start with `make help` to view
the team workflow.

Better Auth, fixed organization RBAC, SSO, SCIM, audit logs, retention, and SIEM drains are
documented in [authentication and enterprise access](docs/authentication.md).

The backend is Playbook Core, the organization control plane every Playbook shell
uses. Its API classes, the `/api/v1/bootstrap` shell contract, ownership rules for
other repositories, and the campaign workflow rollout are documented in
[Playbook Core](docs/playbook-core.md).

Campaigns built from a release run through a reviewable AI pipeline: a cited
product spec drafted from the release's sources (with prompt-injection
defenses), a campaign plan, on-brand visuals with automated critique, channel
copy carrying spec references, and AI revisions a reviewer applies or discards.
These checks support human review; they do not establish factual verification.
See [launch intelligence](docs/launch-intelligence.md).

Email templating, release announcements, audience consent, and unsubscribe
handling are documented in
[customer email and release broadcast](docs/email-and-broadcast.md).

## Tech stack

Next.js 16 · React 19 · TypeScript · Tailwind CSS 4 · Go · Ent · PostgreSQL · Zustand · Radix UI ·
Motion · FFmpeg WASM · WebCodecs · Temporal · Social API

## Third-party providers

Production services and optional integrations. The local Compose stack supplies
local infrastructure; external AI and provider flows require their own setup.
See the deployment and integration guides for current configuration.

### Production services

| Provider                                                                                                           | Role                                               | Environment variables                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [DigitalOcean App Platform](https://www.digitalocean.com/products/app-platform)                                    | Application hosting                                | `DIGITALOCEAN_PRODUCTION_TOKEN` (CI only)                                                                                              |
| [PlanetScale](https://planetscale.com) ([console](https://app.planetscale.com))                                    | Managed Postgres, primary datastore                | `DATABASE_URL`                                                                                                                         |
| [Upstash](https://upstash.com) ([console](https://console.upstash.com))                                            | Serverless Redis for rate limiting and caching     | `REDIS_URL`                                                                                                                            |
| [Cloudflare R2](https://developers.cloudflare.com/r2/) ([dashboard](https://dash.cloudflare.com/?to=/:account/r2)) | Object storage for exports, uploads, and assets    | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_ENDPOINT`, `R2_REGION`, `NEXT_PUBLIC_R2_PUBLIC_URL` |
| [Better Auth](https://www.better-auth.com) ([docs](https://www.better-auth.com/docs))                              | Authentication, sessions, organization RBAC        | `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `BETTER_AUTH_TRUSTED_ORIGINS`                                                                 |
| [Resend](https://resend.com) ([dashboard](https://resend.com/overview))                                            | Verification, password reset, and invitation email | `RESEND_API_KEY`, `AUTH_EMAIL_FROM`                                                                                                    |

Temporal runs publishing and maintenance in the Go backend. See
[production deployment](docs/digitalocean-deployment.md) for schedules and credentials.

### Optional integrations

| Provider                                                                                                                                  | Role                                                                                                                                 | Environment variables                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| [Microlink](https://microlink.io) ([docs](https://microlink.io/docs))                                                                     | Screenshot capture API                                                                                                               | `SCREENSHOT_API_URL`                                                                                                      |
| [OpenRouter](https://openrouter.ai) ([models](https://openrouter.ai/models))                                                              | Model access for the campaign studio, editor copilot, captions, and AI backgrounds                                                   | `OPENROUTER_API_KEY`, optional `PLATFORM_AI_MODEL_*`, `PLATFORM_AI_IMAGE_MODEL`                                           |
| [Slack](https://api.slack.com/apps) | Workspace activity, design delivery, and publishing ([backend setup](docs/workspace-notifications.md)) | Backend only: `PLATFORM_NOTIFICATION_ENCRYPTION_KEY`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `PLATFORM_SLACK_CALLBACK_URL` |
| [Notion](https://www.notion.so/profile/integrations), [Figma](https://www.figma.com/developers/apps) | Delivering published designs ([setup](docs/integrations.md)) | `INTEGRATION_ENCRYPTION_KEY`, `{NOTION,FIGMA}_CLIENT_ID`, `{NOTION,FIGMA}_CLIENT_SECRET` |
| Outbound webhooks | Signed draft events to a workspace's own endpoints ([consumer guide](docs/outbound-webhooks.md)) | Backend only: `PLATFORM_WEBHOOK_ENCRYPTION_KEY` (base64, 32 bytes) |
| [PostHog](https://posthog.com) ([app](https://app.posthog.com))                                                                           | Product analytics and session insight                                                                                                | `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST`                                                                     |
| [Google Cloud](https://console.cloud.google.com/apis/credentials)                                                                         | Google OAuth sign-in                                                                                                                 | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                                                                                |
| [Google Picker](https://developers.google.com/workspace/drive/picker/guides/overview) | Importing images and videos from Google Drive in the composer (unavailable until all three are set; `drive.file` scope) | `GOOGLE_PICKER_CLIENT_ID`, `GOOGLE_PICKER_API_KEY`, `GOOGLE_PICKER_APP_ID` (the Cloud project number) |
| [Senja](https://senja.io) | Importing video testimonials into drafts; each workspace's own project key, pasted by an admin in Settings | `INTEGRATION_ENCRYPTION_KEY` (seals the key) |
| [GitHub OAuth](https://github.com/settings/developers)                                                                                    | GitHub sign-in and release intake                                                                                                    | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`                                                                                |
| [Microsoft Entra ID](https://entra.microsoft.com)                                                                                         | Microsoft SSO for enterprise tenants                                                                                                 | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`                                                                          |
| Billing provider or support automation                                                                                                    | Signed workspace plan and entitlement synchronization                                                                                | `BILLING_ENTITLEMENT_WEBHOOK_SECRET`                                                                                      |
| [Stripe](https://stripe.com) ([dashboard](https://dashboard.stripe.com))                                                                  | Self-serve Checkout, billing portal, and extra-launch credit packs; events at `/api/webhooks/stripe` sync the plan and grant credits | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_{PRO,BUSINESS}_{MONTHLY,ANNUAL}`, `STRIPE_PRICE_EXTRA_LAUNCH` |

Configure runtime secrets through the deployment environment described in
[deployment instructions](docs/deployment.md); never commit credentials.
Build-time `NEXT_PUBLIC_*` values are compiled into the client bundle and must
contain only public configuration.
