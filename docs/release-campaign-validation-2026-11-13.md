# Release-to-campaign production validation

Target: Shots production, capturing `https://verifier.playbookmedia.io` with the
existing signed-in account, per the user's revised fixture on November 13.
Its canonical repository is `Oppulence-Engineering/paperless-check-if-email-exists`
(verified through GitHub and the local Verifier checkout's remote). All generated
content remains unpublished drafts. Read-only product navigation only; no email
checks, outbound messages or social publishing. Earlier Eigenn observations below
remain historical evidence; its unsigned test connection has been revoked.
Started from clean `feat/test-screencapture`, `c42bdfe9`.

## Execution path and ownership

GitHub signed webhook → trusted installation/repository `SourceApp` →
`AcceptGitHubEvent` → transactional `ReleaseSourceEvent`, `ReleaseAutomationRun`,
outbox → `platform-release-automation-v1` → pinned workflow node receipts →
release → campaign and platform draft posts → `capture_product` →
`PlatformAppConnection` and immutable `CaptureRecipe` → `CaptureJob` outbox →
`platform-capture-job-v1` → Go rod/CDP Cloudflare Browser Run → private object
storage `Asset` → `SurfaceCapture` → optional creative rendering → human review.

The Go product domain owns authorization, tenant attribution, persistence and
idempotency. Temporal owns durable execution. The browser package owns network
and action restrictions. The Next.js UI uses contracts and the backend SDK.
Campaigns and posts use the existing product models; publishing is a separate,
explicit approval and scheduling path.

The current authenticated runner has no AI navigation. Recipes accept only
NAVIGATE, WAIT_FOR and SELECT_TAB. AI currently classifies release relevance and
writes copy. A capture output is handed to creative rendering; further audit is
needed to prove original screenshot attachment without a render step.

## Defect ledger

| ID | Severity | Subsystem | Reproduction and symptom | Root cause | Fix and regression | Local | Production |
| --- | --- | --- | --- | --- | --- | --- | --- |
| RC-001 | P1 | Capture configuration | Open production Automate → Signed-in capture: "Signed-in capture is not set up" | Infisical `/screenshot-studio` lacks PLATFORM_CAPTURE_CDP_URL, PLATFORM_CAPTURE_CDP_TOKEN and PLATFORM_CAPTURE_STATE_KEY | Provisioned capture URL, encryption key and (explicitly authorized) renderer token in Infisical; verified read-back without exposing values | Real Cloudflare session test passed | Config deployment 43498556650 succeeded; production UI shows capture forms |
| RC-002 | P1 | Feature navigation | Request a feature objective through authenticated capture | Runner supports fixed CSS recipes only; no model-guided navigation path | Extend existing bounded runner, preserving network, identity and write restrictions | Pending | Not available |
| RC-003 | P1 | Campaign generation | Model returns missing, unknown, duplicate or invalid posts; node can complete | Response filtering silently drops invalid entries and accepts an empty generation | Reproduce and require complete validated output | Pending | Not tested |
| RC-005 | P1 | Staging deployment attribution | A configured staging workflow accepts its deployment event, but capture cannot find its deployment record | CollectAutomationChange records only production deployments although configured intake accepts staging | Add a staging regression and preserve legacy source policy | Source confirmed; regression pending | Not tested |
| RC-004 | P1 | Draft preservation | Edit a generated draft, then replay its incomplete generation receipt | Replay uses current copy as ExpectedCopy instead of the copy the generation was based on | Persist original copy and draft timestamp; conditionally apply through existing revision owner | PostgreSQL regressions passed for concurrent copy/title/review changes, receipt replay and legacy receipts | Not deployed |

## Production observations

- Existing signed-in Shots session reached Home and Automate.
- Active workspace had no watched repository, workflow or capture connection.
- Capture setup unavailable as described in RC-001.
- Chrome page access was interrupted, then restored. No release was triggered.
- PR #581 promoted develop `c42bdfe9` as main merge
  `0b1057358df5d9184cad710ffdd377b144384894` while inspection was in progress.
- Backend workflow 43495210296 and web workflow 43495210282 both succeeded.
  Active provider revision still needs verification.
- Local doctl cannot authenticate (access token required). Infisical read/write
  access works; secret values were never printed.

## Acceptance evidence

No complete production run has been demonstrated yet. No screenshots, campaigns,
or posts have been created by this task at this point. The production
configuration deployment succeeded and its capture setup UI was verified.
Implementation, local validation, merge, deployment and production verification
will be recorded separately here.

## Configuration deployment cycle 1

- Provisioned `PLATFORM_CAPTURE_CDP_URL`, `PLATFORM_CAPTURE_STATE_KEY` and
  `PLATFORM_CAPTURE_CDP_TOKEN` in the existing prod Infisical folder. The user
  explicitly authorized reuse of the renderer token.
- `TestLiveProviderSession` passed against real Cloudflare and staging.eigenn.io:
  session allocation, bearer CDP connection, configured-host navigation,
  blocked off-host navigation, live view, reconnect and repeatable cleanup.
- Native Chrome visibly reached Eigenn's existing `test-team` account as Alex
  Morgan. No application credentials were extracted.
- Dispatched backend workflow
  https://github.com/PlaybookMediaLLC/shots/actions/runs/43498556650 on production
  main `0b1057358df5d9184cad710ffdd377b144384894` to activate configuration.

## RC-004 regression evidence

Before the correction, editing during generation caused a stale-copy failure;
editing before receipt replay was overwritten with generated copy. Both were
reproduced against an isolated PostgreSQL database. The correction extends the
existing generation receipt and `UpdateCampaignPost` revision path; it adds no
database schema, model provider, queue or alternate mutation path.

Focused PostgreSQL tests passed: `TestAutomationGeneration*` and
`TestUpdateCampaignPost`, including copy edits during generation and replay,
title edits, submission for review, legacy receipts, single charge/model call
on replay and insufficient credits. Full `make check` passed after preparing the
isolated database with the same Founder Hub prerequisites used by CI.

- Cycle 1 result: workflow 43498556650 completed successfully, with the deploy
  job asserting the expected backend image tag and ACTIVE provider deployment.
  Production UI now displays Add connection and Add screen.
- Watched source created through production UI:
  `cmwfezvee0000091my5xf04ii`, Oppulence-Engineering/oppulence-canvas, develop.
  No workflow has been activated.
- A fresh Cloudflare session refused staging capture with `wrong_account`;
  it did not create an image. A separate capture sign-in is required.
- Full Go check initially failed four Founder Hub integration tests because
  the isolated database lacked its roles and domain schema. Applied the CI
  bootstrap, storage fixture and Founder Hub migrations to that test database;
  the complete check is being rerun. Generated code and dependency files had no
  final drift after the initial check.

- Created `Eigenn staging validation` through the production UI, environment
  staging, bound to the watched Eigenn source. The Cloudflare live-view window
  opened successfully. Eigenn verification failed because the test connection's
  sign-in hosts omitted `challenges.cloudflare.com`, required by its Turnstile
  script. No verification bypass was attempted. The user then changed the test
  fixture to Verifier; the unused Eigenn connection was revoked through the UI.
- Production web health endpoint returned HTTP 200 with `status: ok`.
- Second full-check attempt passed the Founder Hub tests but exposed missing
  `shots_hub_owner` membership for the isolated test role. Granted that existing
  test-schema role and restarted the complete check. No production database or
  application authorization was changed.

## RC-004 validation and independent review

- Complete `make -C server check` passed (exit 0): generation, normal tests,
  configured race-test set, vet, and generated-code/module drift checks.
- Database integration tests used the isolated `shots_release_campaign_test`
  database. Optional provider tests remain opt-in; the separate real Cloudflare
  provider test above supplies provider smoke evidence, not campaign E2E proof.
- Six independent reviewers ran: structure, perf, chaos, QA, lean and Go.
  All returned no findings and a scoped Ship verdict. Lean: no removal needed.
- Reused the existing generation receipt and transactional post revision owner.
  No schema, dependency, queue or authentication change. Ordinary API callers
  cannot supply the internal generation precondition.
- Production draft preservation is still unverified. RC-002, RC-003 and RC-005
  remain open; this scoped Ship verdict is not whole-workflow acceptance.
