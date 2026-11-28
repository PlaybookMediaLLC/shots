---
name: pr-video-evidence
description: >
  Use for every implementation task, feature, bug fix, refactor,
  and pull request, including subsequent review corrections.
  Produce narrated video evidence of the actual implementation,
  with visual annotations, passing assertions, synchronized
  captions, and playable video attachments before declaring
  work complete or marking a pull request ready for review.
---

# Narrated PR Video Evidence

## 1. Objective

Enable asynchronous engineering review without requiring the reviewer to check
out branches, start applications, reproduce workflows, or manually verify every
implementation.

Every applicable implementation must be accompanied by a concise, narrated,
visually annotated recording that demonstrates the actual working functionality.
The reviewer should be able to inspect the code, watch the recording, annotate
specific video frames in their review thread, submit feedback, and review a
corrected implementation.

This is a mandatory engineering verification workflow, not a marketing video
production workflow.

## 2. When to execute

Execute this skill automatically:

- Before marking any pull request ready for review.
- Before reporting an implementation as complete.
- After implementing a feature or fixing a bug.
- After addressing pull request review comments.
- After receiving visual annotations or frame-level feedback.
- After changes that invalidate previous verification evidence.

Execute automatically, even when the user has not explicitly requested a
recording, demonstration, or verification. Do not wait for the reviewer to
request evidence.

## 3. Understand the implementation

Before recording:

1. Read the original task and acceptance criteria.
2. Inspect the implementation and relevant code changes.
3. Identify every affected user-facing workflow.
4. Identify relevant backend behavior and side effects.
5. Identify important edge cases and failure states.
6. Determine what observable evidence demonstrates that each acceptance
   criterion has been satisfied.

Create a verification plan mapping acceptance criteria to tests, browser or
terminal actions, and observable results. Do not merely demonstrate the happy
path when the change also affects permissions, validation, billing/credits,
error handling, or data persistence.

## 4. Prepare the verification environment

Use the actual implementation from the current branch:

- Start the required Shots application and dependent services using the
  repository's established setup (`make up` / `make up-production` with
  `dev/studio`, or `dev/native-stack up && dev/native-stack login` in cloud
  sessions where Docker images cannot be pulled).
- Use isolated, deterministic test fixtures and seeded data.
- Authenticate using approved local test accounts (`dev@localhost.test` via
  `STUDIO_DEV_PASSWORD` through `/api/auth/sign-in/email`, or isolated E2E
  workspaces from `clients/apps/web/test/e2e/framework/`).
- Verify the application is healthy (`/api/health` and `127.0.0.1:8080/readyz`)
  before recording.
- Use fictional or sanitized tenant, customer, and billing data.
- Prevent real payments, customer messages, emails, webhooks, social posts, or
  other external side effects.

Never bypass authentication, permissions, tenant isolation, or application
validation to make a demonstration succeed. Never substitute a mock interface or
reconstructed mockup for a working application.

If environment setup fails, investigate and resolve the failure where possible.
Otherwise, report the exact blocker and keep the pull request in draft.

## 5. Execute automated verification

Run all applicable repository-mandated checks:

- Format, lint (`--max-warnings=0`), typecheck, unit, and web server tests:
  `npm run quality:check` in `clients/` (or `make check` in Docker).
- Go generation, vet, race checks, and unit/integration tests:
  `make -C server check`.
- Zod API contract generation (when contracts change):
  `npm run api:generate` in `clients/`.
- RFC verification (when `docs/rfcs/` changes):
  `python3 dev/verify-rfcs.py`.
- End-to-end, tenant isolation, and social publishing checks as applicable:
  `make e2e`, `make e2e-file SPEC=...`, `make tenant-isolation`,
  `./dev/social-gate`.

Reuse existing test infrastructure. For each demonstrated workflow, assert the
expected result using the application UI, API response, database state, or
another appropriate verification mechanism.

A successful video recording does not replace automated tests. Never claim a
behavior works unless it has been observed and verified.

## Mandatory independent engineering review

Narrated video evidence must be generated only after the implementation has
passed independent engineering review. A successful demonstration is not
sufficient evidence of architectural correctness, security, billing/quota
accuracy, tenant isolation, maintainability, or production readiness.

### 1. Discover repository-specific reviewers

Before implementation, inspect the repository's:

- Root `AGENTS.md` and `CLAUDE.md`
- Nested instruction files (`clients/apps/web/AGENTS.md`, `server/README.md`)
- `.codex/agents/` (`reviewer.toml`, `workflow-orchestrator.toml`)
- `.claude/skills/` and `.agents/skills/` (including `ponytail-review`,
  `verify-tenant-isolation`, `review-artifact-policy`, `add-e2e-flow`,
  `run-native-stack`)
- `docs/playbook-core.md` and `docs/ci.md`

Load all applicable repository instructions. Reuse existing reviewer definitions
rather than replacing them with generic review prompts. Current repository and
product-specific guardrails take precedence over outdated assumptions.

### 2. Review orchestration

After implementation and initial verification, assemble an independent review
team. The implementing agent acts as the review coordinator and dispatches
independent reviewers in parallel where their responsibilities do not require
sequential execution.

Each reviewer must receive:

- Original task and acceptance criteria.
- Base branch and current commit SHA.
- Actual implementation diff and paths of untracked files.
- Relevant architecture and repository instructions.
- Affected components, callers, and execution paths.
- Existing and newly added tests.
- Initial verification results.
- Known risks and unresolved questions.

Reviewers must inspect the actual source code and tests — never give reviewers
only the implementing agent's summary. Reviewers operate in read-only mode. The
implementing agent coordinates all remediation to prevent conflicting edits. Do
not recursively dispatch additional review teams from review-only subagents.

### 3. Mandatory Shots core review team

For every substantive code change in `PlaybookMediaLLC/shots`, dispatch
independent review covering all mandatory core perspectives:

#### Core reviewer perspectives (`.codex/agents/reviewer.toml` & `AGENTS.md`)

Use separate independent `reviewer` subagents for each focused perspective:

- **structure**: correctness, security, contracts, tenant isolation, and module
  boundaries (including web-database boundary and API zod contracts).
- **perf**: performance, resource use, query efficiency, and expensive
  execution paths.
- **chaos**: invalid inputs, failure modes, cleanup, concurrency, retries, and
  resilience.
- **qa**: test coverage, assertion quality, edge-case coverage, and missing
  regression tests.
- **lean**: unnecessary abstractions, duplication, speculative code, and
  dependencies.

#### Structural and blast-radius analysis (`code-review-graph` MCP)

Follow `CLAUDE.md` and `AGENTS.md`: when the `code-review-graph` MCP tools are
available and built, inspect callers, importers, tests, and blast radius
(`semantic_search_nodes_tool`, `query_graph_tool` with `callers_of`,
`importers_of`, `tests_for`). Use targeted source inspection to verify graph
findings. If the graph integration is unavailable, explicitly report the
limitation and perform targeted `rg`/source impact analysis. Never fabricate
graph results.

#### Simplicity and production-quality review (`.claude/skills/ponytail-review/SKILL.md`)

Evaluate the implementation in order of priority:

1. Correctness.
2. Safety.
3. Behavior under expected production load.
4. Adequate testing.
5. Performance.
6. Simplicity (`delete`, `reuse`, `stdlib / native`, `yagni`, `merge`, `split`).

Every finding must include a concrete failure scenario or demonstrable
unnecessary cost, with the smallest correction that solves it.

### 4. Specialist reviewer selection

Dispatch up to two additional stack/domain specialists according to the
affected functionality and risk profile. Do not omit an applicable specialist
merely because the core review team reported no findings:

- **Frontend, React 19 & Next.js 16 changes** (`clients/apps/web/app/**`,
  `clients/apps/web/components/**`, `clients/packages/platejs-editor/**`):
  inspect runtime failures, hydration, async state, accessibility, UI primitive
  compliance (`web/components/ui/` — no raw controls), rendering performance,
  and upstream merge cleanliness (`vercel-react-best-practices`,
  `web-design-guidelines`, `emilkowal-animations`).
- **API contracts, Go handlers & Ent data model** (`clients/apps/web/lib/api/**`,
  `server/internal/httpapi`, `server/internal/product`, `server/ent/schema`,
  `server/platformmigrations/sql`): verify zod-derived API types, OpenAPI /
  `shots-api-client` regeneration, handler-to-domain separation, Ent schema +
  reviewed SQL migration pairing, and `breaking-changes-allowed.txt`
  compatibility.
- **Security, tenancy, billing & entitlements** (`clients/apps/web/lib/auth/**`,
  `clients/apps/web/lib/billing/**`, `server/internal/workspaceplan`,
  `server/internal/quota`): verify authentication/authorization via
  `web/lib/auth/access.ts` and Go Ent membership checks, organization scoping on
  every query/mutation, fail-closed entitlement gating, Stripe integer minor
  units with currency, webhook signature verification, idempotent ingestion,
  `AuditLog` entries, and `verify-tenant-isolation` coverage.
- **Social publishing & Temporal durability** (`server/internal/social/**`,
  `server/internal/temporal*`): verify replay-safe workflow versioning,
  product/social separation, and idempotency (`UNKNOWN_DELIVERY` on ambiguous
  provider mutations — never unsafe automatic retries).
- **Artifact & brand-kit policy** (`review-artifact-policy`): verify
  source-grounded claims, brand compliance, channel limits, and approval rules.

### 5. Cross-agent compatibility

These review procedures apply across Claude Code, Codex, Antigravity, Capy, and
any other coding agent. When native custom subagent invocation is available,
invoke independent subagents directly with the reviewer definition and assigned
perspective. Never claim a reviewer was dispatched when no independent review
occurred. If independent subagents are unavailable, apply the perspectives
sequentially only where explicitly permitted (e.g. docs-only changes) or report
the blocker and keep substantive work in draft.

### 6. Review findings and severity

Require every reviewer to provide structured findings with:

- Reviewer identity and assigned perspective.
- Finding identifier.
- Severity (`P0`, `P1`, `P2`, `P3`).
- File path and line numbers.
- Affected behavior and concrete failing condition.
- Supporting evidence.
- Smallest recommended correction and required verification.

Severity definitions:

- **P0 — Critical**: cross-tenant data exposure, credential exposure, billing or
  quota corruption, unauthorized actions, data loss, or critical breakage.
- **P1 — High**: material correctness, authorization, contract, replay, or
  reliability defects.
- **P2 — Medium**: recoverable inconsistencies, limited operational failures,
  maintainability risks, and meaningful edge cases.
- **P3 — Low**: non-critical readability, naming, and cleanup observations.

Unsupported concerns must be clearly labeled as hypotheses. P0 and P1 findings
must block readiness for review. P2 findings must normally be resolved before
merge unless explicitly accepted by the authorized reviewer.

### 7. Consolidate and adjudicate findings

The implementing agent consolidates all reviewer outputs into one review report:

- Deduplicate overlapping findings.
- Verify findings against actual source code.
- Resolve disagreements using evidence.
- Reject unsupported or speculative findings (with brief justification).
- Prioritize corrections by severity.

### 8. Mandatory remediation and re-review

Resolve all blocking findings (`P0` and `P1`, plus required `P2` items):

1. Implement minimal, targeted fixes and add/update regression tests.
2. Rerun all affected automated checks.
3. Return the corrected diff to the applicable independent reviewers for
   verification that original findings are closed and no new defects were
   introduced.
4. Repeat until all blocking findings are independently verified closed.

Never weaken tests, lint rules, `--max-warnings=0`, format scope, authorization,
or quality gates to obtain a passing result. If review cannot converge, keep the
pull request in draft and report the unresolved findings.

### 9. Final repository quality gates

Before generating the final narrated recording, execute all applicable Shots
quality gates:

- `npm run quality:check` in `clients/` (or `make check`)
- `make -C server check` (when `server/`, `Makefile`, `.github/workflows/`, or
  shared auth/permission files change)
- `python3 dev/verify-rfcs.py` (when `docs/rfcs/` changes)
- `npm run api:generate` (when zod API contracts change)
- `make e2e` / `make e2e-file SPEC=...` / `make tenant-isolation` /
  `./dev/social-gate` as applicable

Any failed mandatory quality gate blocks readiness for review.

### 10. Review evidence manifest

Preserve a structured review record (pass `--review-file <review.json>` to
`dev/pr-video-evidence/cli.mjs record` or set `scenarioDef.review` so it is
embedded in `manifest.json` under `review` and rendered into the PR evidence
summary, and save the full report alongside the recording under
`.local/pr-evidence/`):

- Repository, base branch, and reviewed commit SHA.
- Reviewer identities, source definitions, and specialist selection rationale.
- Review scope and unresolved findings by severity (`P0`, `P1`, `P2`, `P3`).
- Corrections applied and findings independently verified as resolved.
- Accepted exceptions and outstanding findings.
- Automated verification results and final recommendation (`ship` / `no-ship`).

### 11. Narrated video generation

Generate the final narrated recording only after:

- Independent engineering review is complete.
- All blocking findings are resolved and re-verified.
- All applicable mandatory quality gates pass.
- The final implementation commit is identified.

Include demonstration beats covering important defects caught and fixed during
review where observable. Deliver both the playable narrated video and the
consolidated engineering review report in the review thread and PR description.

### 12. Subsequent review iterations

When human feedback or annotated frames result in implementation changes:

- Reassess blast radius.
- Dispatch core and applicable specialist reviewers.
- Resolve new and previously outstanding findings.
- Rerun required automated verification.
- Regenerate a fresh narrated video against the new commit SHA.
- Update the consolidated review report and PR evidence section.

Never reuse stale review approvals or recordings from earlier commits.

### 13. Final readiness gate

An implementation must not be declared complete or marked ready for review until:

- Core review team and applicable specialists executed.
- Findings consolidated; P0 and P1 independently verified resolved.
- P2 findings resolved or explicitly accepted.
- All repository quality gates passed.
- Security, tenancy, and billing invariants verified where applicable.
- Consolidated review report delivered.
- Narrated video delivered where applicable and verified against current commit.
- Remaining limitations explicitly disclosed.

Never merge without explicit human authorization.

## 6. Build the demonstration storyboard

Before recording, design a concise storyboard mapping each beat to:

- Acceptance criterion ID and description.
- Application route or backend/terminal target.
- Browser or terminal action and target element/control.
- Expected result and assertion confirming it.
- Direct, factual spoken narration.
- Visual annotations (bounding box, numbered callout, arrow, spotlight,
  restrained zoom, explanatory label).
- Estimated duration.

Organize beats around what the reviewer needs to verify rather than the order in
which code was written. Prioritize evidence over presentation.

## 7. Capture the actual application

For web changes, use Playwright and Chromium via `dev/pr-video-evidence/cli.mjs`
(`npm run devx:video-evidence` in `clients/`, or `make video-evidence`):

- Record real interactions against the running Shots app (`1920 x 1080`,
  Playwright video recording + full Playwright trace `trace.zip`).
- Record navigation, smooth cursor movement, clicking, form inputs, menus,
  dialogs, data changes, validation messages, loading/success states, error and
  recovery states, and persisted state after reload where relevant.
- Do not record dependency installs, long compilation delays, irrelevant
  navigation, or unnecessary waiting.
- Never edit out a genuine application failure to present a misleading pass.

## 8. Visual annotations

Every recording must make it immediately obvious which interface element or
output is being discussed. `dev/pr-video-evidence/playwright-helpers.mjs`
provides:

- Element bounding boxes derived from live `getBoundingClientRect()` coordinates.
- Subtle animated highlight borders.
- Visible cursor movement (`clickWithIndicator`) and click ripple indicators.
- Directional SVG arrows (`arrow: true`).
- Numbered callout badges (`stepNumber`).
- Restrained spotlight dimming (`spotlight: true`) around target elements.
- Smooth, restrained viewport zoom (`zoom: 1.15–1.35`).
- Non-obscuring explanatory labels (`label`).

Keep annotations synchronized with the action and narration. Never obscure key
text, controls, numbers, or results. Preserve unmodified raw footage (`raw/`)
and Playwright traces (`raw/trace.zip`).

## 9. Spoken narration

Every applicable demonstration must include natural, human-sounding, clearly
intelligible spoken narration — never robotic or mechanical formant speech:

- **Default local neural TTS provider**: Kokoro-82M ONNX (`kokoro-onnx` via
  `dev/pr-video-evidence/tts.py`, set up once with
  `node dev/pr-video-evidence/cli.mjs setup-kokoro` into
  `~/.cache/shots-pr-evidence/`). Defaults to voice `af_heart` at a natural,
  unhurried `0.98` speaking cadence (weighted blends like
  `af_heart:0.75+af_bella:0.25` and other curated Kokoro voices like
  `am_michael`, `af_bella`, `bf_emma`, `bm_george` are also supported).
- **Optional cloud neural fallback**: OpenAI TTS (`--tts openai` with
  `gpt-4o-mini-tts` and conversational senior-engineer tone instructions, only
  when explicitly requested and `OPENAI_API_KEY` is configured — never transmit
  secrets or customer data).
- **No robotic formant synthesizers**: `espeak-ng`, `festival`, `flite`, and
  similar formant synthesizers are disallowed for deliverable PR recordings and
  rejected by `dev/pr-video-evidence/schema.mjs`. Never silently fall back to a
  robotic voice if Kokoro is unavailable; fix Kokoro setup or report the
  blocker.
- **Studio-clean speech mastering**: `tts.py` synthesizes sentence-by-sentence
  with natural `240 ms` inter-sentence breath pauses, normalizes awkward
  technical tokens for speech without altering captions, and masters audio via
  two-pass linear `loudnorm` (`-16 LUFS`, `75 Hz` high-pass, soft limiter) to
  avoid dynamic gain pumping.

Pre-synthesize narration as individual per-beat segments, measure exact audio
duration, and synchronize beat timing before recording.

Narration must explain:

- What was broken or missing.
- What changed and why it was necessary.
- How the new behavior works and what the user is doing.
- What the application does in response (observed behavior only).
- Which acceptance criteria are being demonstrated.
- Relevant error states, edge cases, and limitations.

Write for the ear, as if walking a teammate through a short engineering Loom:
use short, natural sentences and everyday contractions (`we've`, `it's`,
`doesn't`), avoid stiff boilerplate ("This completes verification of the
pipeline"), never read raw file paths or URLs verbatim, and never use
promotional language, exaggerated claims, or background music. Only state
outcomes that were actually observed and verified.

## 10. Audio and video synchronization

Narration, recorded interactions, visual annotations, cursor movement, and
captions share one monotonic timeline:

- Pre-synthesize narration cues before capture so every beat waits until BOTH
  its real interaction finishes AND its spoken audio finishes.
- Place each cue's audio at its exact beat offset (`adelay` + `amix`) so audio
  never drifts from video.
- Generate synchronized `captions.srt`, `captions.vtt`, and `transcript.txt`
  from the same timeline and burn legible captions into the bottom-center safe
  zone.
- Ensure no truncated narration, no unintended silent gaps, no audio clipping,
  and adequate reading time.

## 11. Recording specifications

Default output enforced by `dev/pr-video-evidence/compose.mjs`:

- Container: MP4 (`-movflags +faststart`).
- Video codec: H.264 (`libx264`, pixel format `yuv420p`).
- Audio codec: AAC (`48 kHz`, `128k`).
- Resolution: `1920 x 1080` (16:9).
- Frame rate: `30 fps`.
- Captions: legible burned-in subtitles plus preserved `.srt` / `.vtt` sidecars.
- Narration: clear audible spoken voice (verified non-silent via FFmpeg
  `volumedetect`).
- Background music: none.

Target 30–120 seconds for straightforward changes. Use multiple focused
recordings for larger changes instead of one overly long clip.

## 12. Backend and infrastructure implementations

Video evidence is not limited to frontend UI changes. For Go backend, API,
Ent/SQL migration, Temporal workflow, CI, or developer-tooling changes without a
browser UI, use `EvidenceRecorder.renderTerminalView(...)` (or real dashboard /
Playwright API inspection) to record observable behavior:

- Real command execution and test output.
- Real HTTP/tRPC/MCP API requests and responses.
- Database assertions, worker processing, or performance measurements.
- Error handling and validation failures.

Narrate what is being verified and highlight key output lines. Redact all
credentials and sensitive values.

For genuinely non-demonstrable changes (e.g., pure prose documentation edits),
set `"status": "not_applicable"` with a concrete `notApplicableReason` (20+
characters) and non-empty `equivalentArtifacts`. Never silently skip
verification, and never mark user-facing web UI changes as `not_applicable`.

## 13. Evidence integrity

Associate every recording in `manifest.json` with:

- `repository` (`PlaybookMediaLLC/shots`) and `branch`.
- Exact 40-character `commitSha`.
- `pullRequestNumber` (once assigned).
- `capturedAt` (ISO-8601 UTC timestamp).
- `applicationRoutes` (or backend/CLI targets).
- `testEnvironment` (`native-stack`, `compose-production`, `compose-dev`, etc.).
- `acceptanceCriteria` (each verified with timestamp range).
- `assertionResults` (commands executed and actual pass/fail outcomes).
- `knownLimitations` and `redactionConfirmed: true`.
- `review` manifest linking the exact reviewed commit SHA.

Preserve original raw footage (`raw/`), transcript (`transcript.txt`), captions
(`captions.srt`, `captions.vtt`), Playwright trace (`raw/trace.zip`), timeline
(`timeline.json`), and `manifest.json` under `.local/pr-evidence/<run>/` (which
is gitignored via `/.local/`). Never commit binary recordings to git. Never
expose credentials, auth tokens, real financial data, or customer data.

Never reuse a recording from an earlier commit as evidence for later code
changes. Never fabricate evidence or test results.

## 14. Review the recording before delivery

Before presenting or linking any recording, inspect it thoroughly:

1. Verify `ffprobe` output (`h264`, `yuv420p`, `1920x1080`, `30 fps`, `aac`)
   and `volumedetect` confirming audible narration (`compose.mjs` enforces this
   automatically).
2. Open and visually inspect the extracted per-beat keyframes in
   `.local/pr-evidence/<run>/review-frames/` to confirm:
   - Real application rendered cleanly (no blank/error screens).
   - Text, highlights, labels, and captions are legible and non-obscuring.
   - Annotations match the active beat and acceptance criterion.
   - Zero credentials, tokens, or sensitive data appear on screen.
3. Verify `node dev/pr-video-evidence/cli.mjs validate` passes against the exact
   `HEAD` commit SHA.

If any quality check fails, fix the issue and regenerate the recording.

## 15. Deliver evidence

- Deliver the rendered MP4 as a playable attachment/artifact in the active
  review thread (Capy attachment, Antigravity artifact, or equivalent) so the
  reviewer can watch and annotate frames directly — never provide only a local
  filesystem path or prose summary.
- Include an authorized, accessible HTTPS link to the recording in the pull
  request description (never expose private recordings on public third-party
  file hosts, and never commit binary MP4s to git).
- If the recording or attachment cannot be delivered, report the exact blocker
  and leave the pull request in draft.

## 16. Pull request evidence summary

Generate the PR description block with
`node dev/pr-video-evidence/cli.mjs render-markdown <manifest.json>` so both
human reviewers and the `pr-video-evidence` GitHub Actions check can verify it:

```markdown
<!-- pr-video-evidence:start -->
### Narrated verification
Recording: [Playable demonstration](https://...)
Commit: `<exact 40-char commit SHA>`
Environment: `native-stack`
Routes / targets: `/home`, `/editor`

### Demonstrated behavior
| Acceptance criterion | Timestamp | Verification |
| --- | --- | --- |
| **AC-1**: Criterion description | 00:00–00:15 | Passed |

### Automated checks
- **PASS** `npm run quality:check` (clients): ...

### Independent engineering review
- **Recommendation:** SHIP (reviewed `<sha>`)
- **Reviewers:** ...
- **Unresolved findings:** P0: 0, P1: 0, P2: 0, P3: 0

### Known limitations
- ...

<details>
<summary>Evidence manifest (machine-verified)</summary>

```json pr-video-evidence
{ ... }
```
</details>
<!-- pr-video-evidence:end -->
```

## 17. Visual feedback loop

When the reviewer annotates video frames or submits PR review comments:

1. Inspect every annotated frame and associated comment.
2. Retrieve the corresponding recording, timeline, and commit context.
3. Locate the affected implementation and translate feedback into concrete
   acceptance criteria.
4. Implement the corrections and add/update regression tests.
5. Rerun independent engineering review and all applicable automated checks.
6. Generate a fresh narrated recording against the new commit SHA.
7. Attach the updated recording to the same thread and update the PR evidence
   section.
8. Explicitly list which review comments were addressed and which remain
   outstanding.

Preserve prior recordings as historical evidence; never reuse an earlier
recording for updated code. Repeat until approved.

## 18. Shots repository integration

Inspect and reuse Shots' verification and recording infrastructure:

- `dev/pr-video-evidence/cli.mjs` — unified CLI (`check-deps`, `setup-kokoro`,
  `record`, `render-markdown`, `validate`).
- `dev/pr-video-evidence/playwright-helpers.mjs` — Playwright 1920×1080 capture,
  visual annotation overlay, synchronized beat runner, Shots dev sign-in, and
  terminal/backend scene renderer.
- `dev/pr-video-evidence/compose.mjs` — FFmpeg A/V sync, SRT/VTT captions,
  H.264/AAC encoding, FFprobe + `volumedetect` verification, and keyframe
  extraction.
- `dev/pr-video-evidence/tts.py` — Kokoro-82M ONNX local neural TTS (default,
  two-pass linear `-16 LUFS` mastering) with optional OpenAI `gpt-4o-mini-tts`
  neural cloud fallback.
- `dev/pr-video-evidence/schema.mjs` & `dev/pr-video-evidence/markdown.mjs` —
  manifest validation, secret scanning, and PR markdown rendering.
- `dev/native-stack` & `dev/studio` (`make up`, `make up-production`,
  `make e2e`) — isolated Shots runtime environments.
- `clients/apps/web/test/e2e/framework/` — existing Playwright fixtures and
  workspace builders.
- `.github/workflows/pr-video-evidence.yml` — CI verification check
  (`pr-video-evidence`).

Commands:

- From `clients/`: `npm run devx:video-evidence -- <command> [options]`
- From repository root: `make video-evidence ARGS="<command> [options]"`

Keep engineering verification recordings strictly separate from any marketing or
product demo profiles (no music, no promotional copy, no marketing branding or
scene-length constraints).

## 19. Failure handling

If any mandatory verification step fails:

- Investigate and fix the underlying issue where possible, then rerun
  verification and regenerate evidence.
- If the failure cannot be resolved, report the exact blocker, commands
  attempted, relevant error output, what remains unverified, and the action
  required to proceed.
- Leave the pull request as a draft. Never fabricate evidence or bypass quality
  gates.

## 20. Definition of done

An implementation is ready for review only when:

- [ ] Original acceptance criteria are addressed.
- [ ] Applicable automated tests and quality gates pass.
- [ ] Independent core and specialist reviews executed and P0/P1 findings
      verified resolved.
- [ ] Actual implementation behavior has been verified on the running app (or
      observable backend/terminal output).
- [ ] Relevant failure states and edge cases have been examined.
- [ ] Narrated recording has been generated (`1920x1080`, `30fps`, H.264/AAC).
- [ ] Visual annotations are accurate and non-obscuring.
- [ ] Captions and narration are synchronized.
- [ ] Recording passed `ffprobe`, `volumedetect`, and keyframe visual inspection.
- [ ] Evidence corresponds to the exact current commit SHA.
- [ ] Playable recording and consolidated review report are delivered in the
      review thread.
- [ ] Pull request evidence summary is updated and passes `pr-video-evidence`.
- [ ] Known limitations are explicitly documented.
- [ ] No credentials, tokens, financial data, or customer data are exposed.

For genuinely non-demonstrable changes, document the justification and
equivalent verification artifacts. Never merge a pull request without explicit
human authorization.
