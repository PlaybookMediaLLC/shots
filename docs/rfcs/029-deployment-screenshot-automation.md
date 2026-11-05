# RFC 029: Deployment-Driven Screenshot Automation

**Priority:** 029 — Reusable foundations
**Previous ID:** 023 ([renumbering map](renumbering-2026-10-24.md))
> **Roadmap disposition (2026-10-23):** Reuse public capture and deployment history. RFC 007 defines the conditional authenticated extension; uploads support early kits.
> See the [current execution order](README.md). Older decision text is
> historical wherever it conflicts with that order or the audited architecture.

**Status:** Partially implemented
**Status note (2026-10-16):** The first deployment-capture slice shipped. Authenticated capture and the rest of this RFC are not built.
**Implementation update (2026-10-20):** [Workflows](../release-automation.md) can render campaign creatives from a product page's current capture with the existing design renderer.
**Date:** 2026-08-17
**Revised:** 2026-08-26
**Historical dependencies:** RFC 020, RFC 018, and RFC 016
**Owners:** Engineering

## Decision

Capture feature screenshots automatically after successful deployments. This
removes one of the founder's biggest marketing annoyances: manually creating
the actual assets.

This RFC has a hard prerequisite that does not exist yet. Most interesting
product screens are behind authentication. Without authenticated capture, this
pipeline can only photograph marketing pages, which is not what "capture the
feature you shipped" means. Authenticated capture is now specified in
[RFC 007](007-authenticated-product-capture.md). It blocks automatic capture of
private screens, while reviewed uploads and public capture support the initial
release-kit milestones.

## Design

Event chain:

```text
PR merged
     ↓
deployment successful
     ↓
feature identified
     ↓
browser opens deployed app
     ↓
navigate to feature
     ↓
capture screenshot
     ↓
Screenshot Studio beautifies it
     ↓
campaign generated
```

## Goals

- Fresh screenshots of changed screens with no manual capture.
- Before-and-after pairs produced automatically from stored baselines.
- Capture that is stable enough that a diff means a real change.
- No standing credential exposure for the customer's application.

## Non-goals

- Video demos. RFC 036 covers demo generation.
- Complex in-app interaction scripting beyond navigation to a surface URL.
- Visual regression testing as a product.
- Capturing production data. Demo accounts and seeded data only.

## Deployment intake

Deployment webhooks (Vercel, Fly.io, or generic) join the GitHub events
from RFC 016.

```ts
DeploymentEvent {
  id
  workspaceId
  provider              // vercel | fly | netlify | github_actions | generic
  externalId
  environment           // production | preview
  url
  commitSha
  branch
  status                // succeeded | failed | cancelled
  receivedAt
}
```

Provider contract, normalized from each provider's payload:

| Field        | Required | Notes                                    |
| ------------ | -------- | ---------------------------------------- |
| `externalId` | yes      | Deduplication key                        |
| `url`        | yes      | Must resolve to a registered product host |
| `commitSha`  | yes      | Correlates with RFC 016 PR events        |
| `environment`| yes      | Only `production` triggers capture by default |
| `status`     | yes      | Only `succeeded` proceeds                |

Generic webhooks are HMAC-signed with a per-source secret, following the
existing `SourceApp` model. Provider-native webhooks use each provider's
signature scheme. All of them are verified, deduplicated by `externalId`, and
processed asynchronously.

## Readiness

A deployment reporting success is not a deployment ready to photograph. Capture
waits for real readiness:

1. Poll a health endpoint, or the deployment URL itself, until it returns a
   success status. Up to 5 minutes with backoff.
2. Require two consecutive successful checks, so a warming instance is not
   captured mid-boot.
3. Wait a settle delay, default 30 seconds, for cache warming and CDN
   propagation.
4. Verify the deployed commit matches the expected SHA when the application
   exposes a version endpoint.

Failing readiness abandons the capture rather than photographing a broken
deployment. A screenshot of an error page attached to a launch announcement is
a worse outcome than no screenshot.

## Preview environments

Preview deployments are off by default. When enabled:

- Preview URLs are typically protected. The capture must present the
  provider's bypass mechanism, stored as a workspace secret reference.
- Preview captures never overwrite a surface's current capture. They attach to
  the suggestion for review and are marked `preview`.
- Preview captures are retained 7 days.

Production is the default because a preview screenshot is a screenshot of
something that may never ship.

## Authenticated capture

Named plainly because it is the blocking gap.

Navigation targets come from the `ProductSurface` map (RFC 018). The feature
identified in the PR selects the surface. Capture runs through the existing
capture API and its SSRF guards. Authenticated app areas require a
workspace-provided demo account.

Requirements the future RFC must satisfy:

| Requirement            | Constraint                                                  |
| ---------------------- | ----------------------------------------------------------- |
| Credential storage     | Secrets manager, never PlanetScale, referenced indirectly   |
| Credential scope       | A demo account with seeded data, never a real customer account |
| Session acquisition    | A scripted login or an injected session token               |
| Session reuse          | Cached per surface set, refreshed on expiry                 |
| Blast radius           | Read-only demo data; capture must never mutate application state |
| Failure mode           | An auth failure marks the surface, never retries into a lockout |
| Auditability           | Every login attempt against a customer system is audited    |
| Revocation             | Disconnecting removes credentials and cancels queued captures |

Until that RFC ships, `requiresAuth` surfaces are skipped with
`capture_requires_auth`, exactly as RFC 018 specifies. This pipeline runs
against public marketing pages only, which is a limited version of the feature
and should be described that way to users.

## Capture stability

New captures update the surface's screenshot set and refresh the suggested
campaign's creatives. For a diff to be meaningful, capture must be stable
across runs. The recipe controls from RFC 018 do the work:

- Fixed viewport and device scale factor.
- `prefers-reduced-motion` forced, and CSS animation disabled.
- A fixed clock injected, so timestamps render identically.
- `hideSelectors` for cookie banners, chat widgets, and announcement bars.
- `maskSelectors` for volatile regions such as counts and relative times.
- Fonts loaded and settled before capture.
- Lazy content scrolled into view, then scrolled back.
- Two captures compared; a mismatch above threshold means the page is unstable
  and a third capture arbitrates.

Without masking, every capture differs, every comparison shows change, and
before-and-after becomes meaningless.

## Before and after

Before-and-after pairs come from the surface's previous capture plus the new
one.

- The baseline is the pinned `isBaseline` capture, or the most recent
  pre-deployment capture when none is pinned.
- Both captures must share a viewport and recipe version. A mismatch means the
  pair is not comparable and the comparison is skipped rather than shown
  misleadingly.
- A perceptual difference below threshold means nothing visibly changed, so no
  before-and-after creative is produced. Announcing a change that is invisible
  in the screenshots is worse than announcing it without a screenshot.
- The comparison creative uses RFC 020's `createComparison`.

## Lineage

```text
PR merged (RFC 016)
   → DeploymentEvent
      → CaptureRun
         → SurfaceCapture (baseline + new)
            → Asset
               → CreativeVariant
                  → CampaignPost
```

Every link is a foreign key. Given a published post, the originating commit is
a join. Given a commit, the content it produced is a join.

## Concurrency and cost

| Limit                              | Default                    |
| ---------------------------------- | -------------------------- |
| Concurrent capture runs/workspace  | 1                          |
| Surfaces per run                   | 10                         |
| Capture attempts per surface       | 2                          |
| Readiness wait                     | 5 minutes                  |
| Run wall clock                     | 15 minutes                 |
| Runs per workspace per hour        | Plan-scoped                |

Rapid successive deployments coalesce: a new deployment for the same
environment supersedes a queued run rather than queueing behind it. A team
deploying ten times an hour should produce captures of the latest state, not
ten sequential capture runs.

Surface selection is targeted. Only surfaces matching the PR's affected paths
or the classified feature are captured, not the whole map. Capturing everything
on every deployment is the obvious cost failure.

## Failure behavior

| Failure                       | Code                        | Behavior                          |
| ----------------------------- | --------------------------- | --------------------------------- |
| Deployment never becomes ready| `deployment_not_ready`      | Abandoned, recorded               |
| Deployment URL off-host       | `deployment_host_rejected`  | Rejected before any navigation    |
| Auth required, none configured| `capture_requires_auth`     | Surface skipped, marked           |
| Login fails                   | `capture_auth_failed`       | Stop immediately; no retry storm  |
| Page unstable after 3 tries   | `capture_unstable`          | Latest capture kept, flagged      |
| Capture times out             | `capture_timeout`           | One retry, then skip              |
| Every surface fails           | `capture_run_failed`        | Suggestion stands without images  |
| Baseline incomparable         | `comparison_unavailable`    | Skip the comparison creative      |

A failed capture never blocks the RFC 016 suggestion. The founder still gets
"we noticed you shipped X", just without fresh screenshots.

## Security

| Threat                                      | Mitigation                                            |
| ------------------------------------------- | ----------------------------------------------------- |
| Forged deployment webhook                   | Signature verification per provider                   |
| Capture pointed at an internal host         | Host allowlist plus the existing SSRF guards          |
| Redirect from the deployment to an internal host | Every hop re-validated                           |
| Demo credentials leaked in logs or assets   | Redaction; credentials never in traces or screenshots |
| Capture mutating customer data              | Read-only demo accounts; navigation only, no form submission beyond login |
| Screenshot capturing real customer PII      | Seeded demo data required; masking for known fields   |
| Credential reuse across workspaces          | Per-workspace secret references                       |

PII in captures deserves emphasis. A screenshot of a real customer dashboard
may contain names, emails, and financial figures, and it may end up in a public
social post. Requiring a seeded demo account is a privacy control, not a
convenience.

## Authorization

| Operation                  | Permission          |
| -------------------------- | ------------------- |
| Connect a deployment source| `workspace:update`  |
| Configure demo credentials | `workspace:update`  |
| View capture runs          | `workspace:read`    |
| Trigger a manual capture   | `release:create`    |
| Pin a baseline             | `artifact:edit`     |

Capture runs execute as a workspace-scoped service principal that can create
captures and assets and cannot create campaigns, approve, or publish.

## Observability

- Deployments received, captures attempted, captures succeeded.
- Time from deployment to captured screenshot.
- Instability rate per surface, which identifies missing masks.
- Auth failure rate, which sizes the authenticated-capture gap.
- Share of suggestions carrying fresh screenshots.
- Capture cost per workspace.

Share of suggestions with fresh screenshots is the value metric. This whole
pipeline exists to raise it.

## Acceptance criteria

1. A merged feature PR plus a successful deployment produces fresh, beautified
   screenshots of the changed screen, attached to a suggested campaign, with no
   manual capture.
2. A failed deployment triggers no capture.
3. A deployment that never becomes ready is abandoned and recorded.
4. Readiness requires two consecutive healthy checks.
5. A deployment URL outside the registered hosts is rejected.
6. A login-walled surface with no credentials is skipped and marked.
7. A failed login stops immediately without retrying.
8. Masked volatile regions do not produce a spurious visual difference.
9. An unchanged screen produces no before-and-after creative.
10. Captures with mismatched viewports skip the comparison.
11. Ten deployments in an hour coalesce rather than producing ten runs.
12. Only surfaces related to the change are captured.
13. Capture failure leaves the RFC 016 suggestion intact.
14. Preview captures never overwrite production captures.
15. No credential appears in a log, trace, or asset.
16. Every published post traces back to its originating commit by join.

## Rollout

1. Ship deployment intake and readiness with no capture. Verify signatures and
   deduplication.
2. Capture public surfaces only; measure stability and iterate on masks.
3. Add before-and-after against pinned baselines.
4. Wire captures into RFC 016 suggestions.
5. Add authenticated capture once its RFC ships. This unlocks the actual
   feature.
6. Add preview environments last.

## Out of scope

- Video demos. RFC 036 covers demo generation.
- Complex in-app interaction scripting beyond navigation to a surface URL.
- Authenticated capture, which needs its own RFC and blocks the useful half of
  this one.

## As built (2026-10-16)

The first slice, behind the GitHub App's `Deployments: read` permission or a
repository webhook subscribed to `deployment_status`:

- Intake: `deployment_status` with state `success` and environment
  `production` (or GitHub's `production_environment` flag) becomes a
  `deployment_event`, once per GitHub deployment, with its https URL.
- Targets: only the workspace's `production` product surfaces on the deployed
  origin (scheme, host and port) are captured (at most ten), never a URL from the
  payload; another origin is skipped as `deployment_host_rejected`, a missing URL
  as `deployment_url_missing`, a private address as `deployment_url_refused`, and an
  archived source as `source_inactive`.
- Readiness: the first surface must answer; until it does, the outbox retries
  each minute, which is the readiness window. The backend dials public addresses
  only and checks every redirect hop.
- Capture: through the same Microlink-compatible API as the web
  (`SCREENSHOT_API_URL`), bypassing its cache, downloading only from that API's
  host or Microlink's CDN on every hop. Each capture is a workspace asset added to
  the surface's screenshots and recorded on the event, with one receipt per page: a
  retried run captures only the missing pages. The event ends `CAPTURED`, `PARTIAL`
  (`capture_incomplete`), `SKIPPED`, or `FAILED`. A page that redirects to a sign-in
  form fails as `capture_login_page`, and an older deployment that finishes late
  never replaces a newer deployment's current image.
- SHA verification is available to workflows through
  [`capture_product`](../release-automation.md#deployment-capture), not on this path.
- A page with an active authenticated recipe gets a durable capture job instead of
  a public screenshot ([status](authenticated-release-capture-review.md#10-implementation-status)).
- Not yet: two consecutive healthy checks, stability controls, and before-and-after pairs.
