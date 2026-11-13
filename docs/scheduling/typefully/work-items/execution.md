# Typefully implementation and verification record

Branch `codex/typefully-backlog-completion`, targeting `develop`. Original baseline `19390194` (2.36.4), reconciled with `develop` at `65e3f42f`. [Coverage](coverage.md) accounts for all 109 entries and 47 work items. Current classifications are 32 Exists, 71 Partial, one Later and five Skip. Partial includes provider outcomes and activation decisions that local fixtures cannot verify. No live social-provider certification is claimed.

## Develop integration

The newer Plan/Analyze workspaces, canonical verified account capabilities, immutable calendar versions, rich Article editor, native media controls, collaboration generations, limited free scheduling policy, public analytics sharing and disabled Auto-DM ledger are retained. Earlier public-sharing and Auto-DM deferrals in this record are superseded by their current work-item specifications.

Original workflows now use the current composer: explicit paste-to-thread and cross-channel poll copy, the full Shots export/import handoff, owned media ordering, native server-side GIF approval, local preview cards and published-thread insertion. Recorded observations/CSV are available from Analyze at `/write/analyze/observations`; both ingestion projections run through the existing maintenance worker. The current weekly calendar supports saved-content selection, drag placement and an equivalent keyboard queue swap. Legacy `view=queue` URLs open its week view.

The combined-tree verification below supersedes corresponding historical checks. Earlier results remain historical evidence and do not certify the merge by themselves.

| Combined-tree command | Observed result |
|---|---|
| `npm test` | 1,110 root tests passed; collaboration 8 passed/1 skipped; Plate 21 passed |
| `npm run verify:rfcs` | 18/18 passed |
| `npm run quality:check` | Passed: format, zero-warning ESLint, TypeScript, 1,110 root tests, workspace tests and 18/18 RFC checks |
| `/tmp/typefully-validation.sh tests ./... -count=1` | Passed across all Go packages with the product and notifications integration databases configured; regenerated Ent plus the final changed-package rerun also passed |
| `npm run api:generate`, `oasdiff breaking` against `65e3f42f`, SDK build and generated-client TypeScript | Passed without adding compatibility exceptions. Anchored and ordinary comment additions retain exclusive, backward-compatible request alternatives |
| `npm test --prefix clients/integrations/zapier` | Four passed |
| `/tmp/typefully-validation.sh tests ./internal/product ./internal/social/chat/mcp -count=1` | Passed with actual PostgreSQL after reconciling connected-destination planning and confirmed-content repurposing |
| `/tmp/typefully-migration-check.sh` | Fresh/idempotent and upgrade preservation passed, 3.904s, including the develop migrations |
| Go race checks | Publishing, Temporal publishing, notifications, tenant publishing and MCP all passed against isolated PostgreSQL databases |
| `go vet ./...` and normal API/worker builds | Passed; normal runtime binaries are built without the E2E build tag |
| Final poll/preview regression | 29 tests passed; legacy Threads one-day defaults normalize to the provider default, and the editor/preview explain that duration is controlled by Threads |
| Main browser integration | 15 checks passed in the second combined-tree run: Plan, Analyze sharing/revocation, new-draft scheduling defaults, immutable X/LinkedIn options, continuous Temporal publication/notification/observations/repurposing, frame handoff, media previews, thread editing, calendar placement, sharing and external clients |
| Bulk scheduling/report regression | Passed after isolating the observation fixture from the maintenance collector: Spread, month filters, move/swap, stored metrics, recommended weekly slots and CSV |
| Targeted browser regression | All 10 passed: AI prompts/transcription and saved voice, accent rollback, limited free scheduling, rejected/lost-response imports, full browser-storage refusal, long-form/downgrade splitting, Threads/unsupported polls, non-retryable quote receipts, media import/edit/AI alt-text/photo tags/share-image revocation. Import tests use a valid decoded image and wait for revocation confirmation |
| Existing develop browser regression | All 11 passed across the main run and focused poll rerun: month swap/move/publish-now/repurpose, Communities, emoji/thread paste, native LinkedIn mentions/reposts, Bluesky finishers/cards, scheduling defaults, cross-channel polls, rich Articles/default-off Auto-DM and dropped video playback. The E2E stack explicitly enables the opt-in Mastodon adapter; normal defaults stay off |
| Native clients | Raycast strict TypeScript, three contract/client tests and seven-entry CLI build passed; four Zapier tests passed. A dedicated CI job installs each client's lockfile dependencies; the web compiler excludes the separate Raycast project |
| Production web build | Passed with exit 0: webpack compilation, TypeScript (83s), all 1,161 static pages and build traces. Existing MediaPipe import and circular chunk warnings remain |
| Production HTTP smoke and local services | Production sign-in and `/api/openapi` returned 200; unauthenticated preferences returned 401. The normal non-E2E API/worker and collaboration health endpoints returned 200 against the original database after migration |


## Implemented slices by epic

| Epic | Integrated behavior |
|---|---|
| POLL | X retained; LinkedIn question/options/durations, native Threads poll attachments, Mastodon advertised instance limits, reviewed cross-channel copy and unsupported-channel explanations. |
| XOPT | Canonical account capability checks for long posts, Articles, replies and Communities; disclosures, weighted lengths, photo IDs and bounded upload/media constraints. Unknown eligibility fails closed. |
| LIOPT | Native first comments with separate outcomes, authorized mention lookup, document uploads/PDF preview and permitted repost contracts. |
| CHAN | Existing connection/brand flows preserved; optional configured X and LinkedIn sign-in providers remain distinct from publishing authorization. Bluesky native record references and channel capabilities are explicit. |
| ANALYTICS | Timestamped stored observations, bounded maintenance ingestion, unavailable states, account/post series, weekly/monthly reports, CSV, X external-post discovery and privacy-scoped best posting times. Personal accent preferences now persist with accessible contrast. |
| COLLAB | Existing review/guest/history infrastructure retained; brand-specific Slack routing and per-draft publish suppression, idempotent fanout and a repaired organization/member lock order. |
| SCHED | Draft-slot picker, rail drag, precise move/swap, month and all-brand views, persistent filters, bulk Spread, bounded natural variation, explicit publish-now and confirmed-content repurposing. |
| QUOTE | URL-to-native-quote review, Bluesky URI/CID resolution, Mastodon capability/permission checks, quote approval receipts and confirmed-thread continuation/read views. |
| FOLLOW | Existing durable scheduler receives defaults, time/engagement conditions and native quote follow-ups; unknown outcomes remain non-retryable until reconciled. |
| MEDIA | Owned alt text and metered descriptions, within/across-post ordering, GIF search, reviewed link-image upload, real Shots frame-export handoff, bounded image resizing and native X photo tags. |
| EDITOR | Reviewed URL import, delimiter/weighted thread splitting, undo, rich paste, numbering, stable thread drag and existing focus/mobile/collaboration/history behavior. |
| PREVIEW | Selected canonical publication, weighted X cutoff, LinkedIn collapse, fitted device viewport, playable video, PDF pages, Article cover/title, local OG dismissal, absolute share metadata and confirmed published-thread reading. |
| ORG | Search, multi-select, tags/pins under their existing controls, archive/duplicate/delete and authorized brand isolation verified. |
| AI | Existing assistant extended with original prompts, continuation, reviewed voice transcription, explicit insertion and saved style/sample context. Missing/inaccessible draft contexts refuse AI requests; workspace policy and existing credit metering remain authoritative. |
| AGENT | Existing Go MCP expanded to 34 scoped tools; comments, queue and mention APIs; transactional draft-updated webhooks; private Zapier package, Raycast client/tools and unsigned Shortcut source. API keys still cannot approve or publish drafts. |

## Architecture and database

Next/React still reads product data only through the Go SDK. Plate remains the collaborative document; preview and publishing share its canonical selected-channel serialization. Go/Ent owns validation, tenant scope, receipts, approval, immutable scheduling commands and observations. Existing Temporal workers execute publication, analytics maintenance and notification delivery. Assets remain in the existing workspace object store. There is no second database access layer, scheduler, MCP server or asset library.

Five additive migrations belong to this work:

1. `20261102090000_platform_social_observation.sql`: attributed daily account/post observations.
2. `20261102091000_platform_draft_import.sql`: workspace/actor import receipts with immutable request fingerprints.
3. `20261102092000_platform_publish_notifications.sql`: per-brand Slack destinations and per-draft publish-notice suppression.
4. `20261102093000_platform_observed_posts.sql`: external-post projections with provider/account identity and collection receipts.
5. `20261102094000_platform_accent_color.sql`: personal accent, defaulting to the existing palette.

Apply migrations before the new Go API/worker, then deploy the SDK/web together. Old records keep their content, approval, notification opt-outs and preference values. New preferences require the updated API response. Existing platform publishing, AI, experiment and provider-access gates remain in force. The migration tests execute fresh installation, upgrade and repeat application; the upgrade fixture preserves approved draft version 7, notification opt-out generation 9 and an existing light theme at preference version 3.

## Original implementation checks (before develop integration)

Local PostgreSQL, Redis, RustFS and Temporal back the tests. Go is 1.26.8. Private `/tmp/typefully-*.sh` wrappers supply local service endpoints and credentials; they are not committed. Product, notifications, migration and continuous-browser suites use separate disposable databases to prevent global fanout fixtures from consuming another suite's events.

| Exact command / selected tests | Observed result | Limit |
|---|---|---|
| `/tmp/typefully-validation.sh tests ./... -count=1` | Full Go suite passed in `typefully-go-all-final4.log`; product package 69.924s. Subsequent page-access HTTP package regression passed separately | Actual PostgreSQL and controlled HTTP providers; some opt-in Temporal tests run separately |
| `/tmp/typefully-validation.sh tests ./internal/product -run 'TestRepurpose\|TestNativeQuote' -count=1` | Passed in `typefully-repurpose-quotes-go4.log` | Confirmed/private/unfinished source separation, PDF options, receipt persistence and retry rejection |
| `/tmp/typefully-migration-check.sh` | Fresh/idempotent and upgrade tests passed, 3.068s, `typefully-migrations-full4.log` | Five migrations; existing-data preservation assertions |
| `npm test` | Final3 passed: 1,038 root tests, collaboration 8 passed/1 skipped, Plate 21 passed. One later unsupported-poll assertion passed in the 25-test publication/contract regression run | Root/workspace suites; native OS tests separate |
| `npx tsx --test test/write-preview.test.ts test/write-publication.test.ts test/settings-accent.test.ts` | 16 passed, `typefully-preview-unit2.log` | URL/emoji cutoffs, selected-version video kinds, publication rules and AA contrast |
| `npx tsx --test test/voice-memo.test.ts` | 2 passed | Actual SDK audio serialization/credit middleware, scripted HTTP provider |
| `npm test --prefix clients/integrations/zapier` | 4 passed | Native Zapier runtime/schema and signed webhook/action fixtures |
| `npx tsx --test test/native-shortcut.test.ts` | 1 passed | Plist/token graph and encoded review URL; not Apple import/signing |
| `npm run lint -- --max-warnings=0` | Final4 passed; the later synced-version explanation and its test also passed targeted ESLint | One expression lint error was repaired; no lint gate weakened |
| `npm run typecheck` | Final3 passed after API/SDK regeneration; production build includes a further TypeScript check | `next typegen` and `tsc --noEmit` |
| `npm run format:check`, `npm run api:generate`, `npm run verify:rfcs` | Formatting and generated API/SDK checks passed; RFC verification 17/17 passed | Generated contracts and repository gates |
| `npm run build` through `/tmp/typefully-host.sh build` | Passed with exit 0 in `typefully-build-final1.log`: webpack compilation, TypeScript (62s), all 1,142 static pages and build traces completed | MediaPipe dynamic-import dependency warnings and circular webpack chunk warnings remain; this is not a warning-free build |
| `npm run start` through `/tmp/typefully-host.sh serve`, followed by status-only HTTP requests | Production sign-in and OpenAPI returned 200; unauthenticated `/api/v1/me/preferences` returned 401; Go `/readyz` returned 200 | Local production bundle smoke; no production deployment or authenticated browser suite against the production bundle |

Before integration, the temporary production smoke server and isolated browser provider fixtures were stopped. Normal development web, Go API, worker and collaboration services were restored against the original local database. Development sign-in/OpenAPI and API readiness returned 200; collaboration was listening on port 1234. The restored API/worker are built without the E2E build tag.

### Browser and real-worker evidence

All browser commands use `/tmp/typefully-lifecycle.sh e2e <files> [--grep ...]` or the prior `/tmp/typefully-host.sh e2e` against the same actual web/Go/storage architecture. Provider fixtures are test peers, never an alternate product implementation.

| Tests exercised | Observed result / log |
|---|---|
| `typefully-lifecycle.spec.ts` | Passed in `typefully-e2e-lifecycle7-regressions.log`: create → edit → preview → approval refusal/review/approve → future scheduling/reload → exactly one provider submission → saved brand Slack channel → maintenance observations → CSV → editable unapproved repurpose/reload with zero new commands and zero browser page errors. |
| `typefully-appearance.spec.ts`, `typefully-preview.spec.ts` | Four passed in `typefully-e2e-preview1.log`: accent save/reload/refused-save/reset; weighted X preview, URL-preserving OG dismissal/restoration, 440px phone fitted into a 390px app; actual uploaded video playback; two PDF pages checked by canvas pixels; GIF/link-image storage bytes and Article cover. |
| `typefully-poll-support.spec.ts` | Passed in `typefully-e2e-polls4.log`: Threads platform-controlled duration, unsupported Bluesky/Instagram explanations even in synced versions, and original poll choices after return/reload. |
| `typefully-quote-receipts.spec.ts` | Passed in lifecycle7 log: pending/rejected/unconfirmed receipts remain published after reload; no retry or continuation action creates a duplicate. This browser test projects stored receipt fixtures, not federation outcomes. |
| `social-set-scope.spec.ts` | Passed in lifecycle7 log: private caches and delayed mutations remain in their originating workspace. |
| `typefully-import-failures.spec.ts` | Two passed in `typefully-e2e-import-failures1.log`: definite rejection/edit/new key; committed POST with lost response/reload/same receipt; storage-full preserves text and sends no POST. |
| `typefully-workitems.spec.ts` selections | Passed: URL import/paste/poll copy/native quote, 25-post rich paste/mobile, calendar picker/rail placement, Spread/month/move/swap/filters/charts/best-time queue, media/alt/photo IDs/share-image revocation and external-client/API flows. Best-time final regression: `typefully-e2e-besttimes18.log`. |
| `typefully-media-handoff.spec.ts` | Passed actual frame/export/review/attachment/reload and thread drag/keyboard/pointer side-panel resize. Frame evidence: `typefully-e2e-frame4.log`; drag/resize selection also passed. |
| `typefully-ai.spec.ts` | Reviewed voice memo/prompt/insertion/reload passed; saved sample/style/policy regression passed in `typefully-e2e-ai-polls3.log`. Scripted AI does not certify transcription or writing quality. |
| `write.spec.ts`, `write-editing-regressions.spec.ts`, collaboration selections | Eight passed in `typefully-e2e-write-regressions1.log`: collaboration/revocation, rich editing, search/multi-select, tags/pins, archive/duplicate/delete, AI accept/reject, optional outcomes, failed-only retry and backups. |
| `content-drafts-platform.spec.ts` guest review and mobile comment selections | Passed in `typefully-e2e-ai-settings1.log`; social-set scheduling/style inheritance regression also passed after updating its old heading locator. |
| `go test ./internal/product -run TestSocialAnalyticsTemporalSchedule` and `go test ./internal/notifications -run TestPublishSlackRoutingThroughTemporal` with opt-in local Temporal env | Passed twice for analytics daily dedupe and separately for one brand-routed notification plus suppression, before the continuous browser proof. |

The continuous test worker is compiled only with `-tags=e2e`, requires an explicitly opted-in loopback test database and isolated Temporal queues, and replaces only the last provider peer. Production account checks, commands, signing, activities, receipts, fanout and observation storage remain real. It cannot certify a native provider permission or app-review outcome. To reproduce that boundary, run `node test/e2e/fixtures/fake-social.mjs` with `SOCIAL_E2E_PORT`, the notification fixture from `test/e2e/fixtures/`, and `go test -tags=e2e ./internal/social/tenantpublishing -run '^TestTypefullyBrowserWorker$' -timeout=60m` with `TYPEFULLY_E2E_WORKER=1`, a loopback test `DATABASE_URL`, matching isolated Temporal queues, `SOCIAL_E2E_URL` and the existing storage/notification environment. The web/API/collaboration services and Playwright must target that same disposable database. Stop this fixture worker before restoring the normal app runtime.

## Defects found and resolved during verification

- Repurposing returned an empty editor. It now copies confirmed immutable publication text/media and posted replies, retains native PDF options, validates source visibility and excludes private later edits, approval and unfinished replies.
- A reloaded best-time button could be clicked before hydration; it waits for client readiness and duplicate weekly-slot checks remain intact.
- SVG chart titles with multiple React text children caused hydration mismatch. Titles now render as one deterministic string, and the continuous lifecycle reports zero page errors.
- Video previews used image elements; selected document nodes now determine native media elements. Phone previews scale their real CSS viewport to the sidebar. Imported PDFs now set the LinkedIn document option.
- Notification fanout locked members before organizations and could deadlock with workspace mutations. Organization-first, skip-locked selection aligns lock order; a PostgreSQL regression checks recovery and no duplicate fanout.
- Unknown publishing transport failures could be confused with known rejection. Explicit rejection is retryable failure; uncertain delivery remains visible and cannot automatically create another post.
- Plate global drag handling intercepted local media/thread gestures; stable identities and local ownership preserve moves after collaboration and reload.
- Media tools could open before the collaborative document arrived. Readiness is explicit, and frame attachment cannot be dismissed while the upload/handoff is pending.
- Shared metadata used the marketing origin; it now uses the configured absolute app origin and rechecks share revocation for image bytes.
- Existing asset imports used the wrong identifier shape; validation now accepts canonical workspace asset IDs.
- Page access exposed Ent settings field names, so a saved AI-off switch displayed as enabled after reload. It now uses the same explicit settings response as the workspace API; disabled values survive the boundary.
- AI requests with an inaccessible supplied draft could proceed without its context. Assistant/refinement now refuse that request before model spending, matching transcription.

Initial test failures are retained in local logs. Regression checks also repaired the contract inventory after splitting queue contracts into their own file. Fixture-only fixes included the PostAnalytics method's `int64` signature, decoding a provider response before returning its ID, explicit E2E database selection, an outdated “Brands” heading assertion and a test using `shorten` instead of the supported `condense` refinement action. These are not counted as live provider outcomes.

## External blockers and activation

| Boundary | Exact unresolved dependency |
|---|---|
| X | Registered app credentials, current access tier/read-write grant and account capability proof; Premium/Articles/video/reply restrictions cannot be inferred from a display badge. Video length follows the verified `subscription_type` (20 minutes standard, 125 Premium; X docs read 2026-11-13) and needs a live long-video post. The X API does not allow photos and video in one post, and 1080p playback is X's choice. |
| LinkedIn | Authorized member/page scopes and required app products/review for Posts, document upload, mentions, reposts, polls and analytics; no controlled live account was available. |
| Threads / Instagram | Meta app review and correct publish/insight grants. Threads poll duration remains native; unsupported metrics show unavailable. |
| Mastodon | A real instance's advertised poll limits, API version/native-quote support and source quote permission; pending federation approval is not a failed root publication. The server makes link cards and its API cannot turn them off. |
| Bluesky | Authorized account and native record/CID resolution against a live PDS; protocol fixtures do not prove live remote behavior. |
| Slack / email | Real workspace grant, destination access and delivery. The task verified controlled OAuth/HTTP peers with actual fanout/Temporal. |
| AI / GIPHY | Production credentials and permitted models/search access; transcription accuracy and generated writing quality remain unverified. |
| Native/external clients | Raycast macOS execution, Apple Shortcut import/signing, hosted Zapier workflows and ChatGPT/Claude directory approval require their external environments. |
| Deferred products | Public analytics sharing is now implemented by develop with explicit enable and revoke. Auto-DM has a default-off ledger/adapter and still needs an accepted consent/abuse model and provider scope. Substack Notes alone remains Later: on 2026-11-13 Substack offered no public Notes publishing API, only access it grants to selected tools. Five Typefully-specific products/releases remain Skip with reasons in coverage. |

Do not activate restricted provider features from fixture success. Supported local authoring, organization, media, scheduling controls, preferences, contracts and reports passed the recorded checks and can be reviewed behind current product gates. Publishing still requires a healthy authorized connection, applicable entitlement and approval. The build warnings above and the provider/native-client boundaries remain release considerations. API-key draft publishing and autonomous approval remain deliberately unavailable. No production deployment, live public post or vendor message has been performed. The user authorized a work PR and merge into develop; this does not authorize a production promotion.
