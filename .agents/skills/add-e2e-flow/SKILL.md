---
name: add-e2e-flow
description: Add or change a Screenshot Studio Playwright end-to-end flow. Use for authenticated user journeys, tenant-sensitive features, browser interactions, downstream API integrations, release regressions, mocked external calls, or Testcontainers-backed dependency validation.
---

# Add End-to-End Flow

Paths below are relative to `clients/apps/web/`; run `npm` commands from `clients/`.

Read `test/e2e/README.md`, `test/e2e/framework/index.ts`, and the changed feature's route,
server boundary, and data contract before writing a test. Read
`references/downstream-dependencies.md` when the flow crosses a downstream
boundary.

## Workflow

1. Define one user outcome, its persisted result, and the required negative
   path. Include tenant or permission boundaries when the feature has them.
2. Add a `*.spec.ts` file under `test/e2e/`. Import everything from
   `./framework`, the one entry point. Follow the template and the rules in
   `test/e2e/README.md`.
3. Declare the start state with `test.use({ workspaceOptions })`, the
   `workspace` fixture or `startWorkspace(options)`. The framework builds it
   through the API and cleans it up. Do not sign up through the form unless
   the test is about sign-up or onboarding.
4. Assert visible user results and durable effects. Do not assert only a 200
   response or internal implementation detail.
5. Wait for a state, not a time. Keep a test under 60 seconds, or tag a
   longer journey `{ tag: '@journey' }`.
6. The suite runs one lane, against the production build. A test that needs
   something the production build turns off — the scripted AI model,
   screenshot-mock downloads, room under the sign-in limit — gets it from
   `lib/e2e-hooks.ts`, which the e2e app enables with `PLATFORM_E2E_HOOKS=1`.
   Add a hook there rather than a second server. `@quarantine` is only for a
   flow the production build genuinely fails, with the bug written down
   (`test/e2e/README.md`, "One lane" and "Quarantine").
7. Run the file with `./dev/studio e2e-file <path> --workers=4 --repeat-each=2`
   to prove that it is parallel-safe, then run `make e2e`. New specs run
   automatically in Compose CI and the Kind parity workflow. Preserve normal
   Playwright traces and screenshots on error.

## Test boundaries

- Use the running Compose services for Postgres, Redis, RustFS, and Storage.
  They are real local dependencies, not mocks.
- Mock browser-originated third-party calls with `mockBrowserJson` from
  `./framework`. Assert the request method, body, and number
  of calls as well as the visible result.
- For server-originated calls, inject a test-only downstream base URL before
  the app starts. A browser route cannot intercept a server request.
- Use Testcontainers for a dependency whose actual protocol or lifecycle is
  part of the contract and is not already supplied by Compose. Do not mock
  authentication, authorization, tenant isolation, database constraints, or
  object-storage key behavior.

## Required coverage

- Cover success, authorization denial, invalid input, replay or duplicate
  request, and one downstream failure when applicable.
- Verify idempotency before retrying an external side effect.
- Use provider sandboxes, local fixtures, or mocks. Never send a test action to
  a customer account or production destination.
