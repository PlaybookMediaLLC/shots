import { availableParallelism } from 'node:os'
import { defineConfig, devices } from '@playwright/test'

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const recoveryTest = 'test/e2e/dependency-recovery.spec.ts'
const testIgnore = process.env.E2E_INCLUDE_RECOVERY === 'true' ? undefined : [recoveryTest]
// Every context starts with a saved cookie choice so the consent banner
// never covers the controls a flow clicks.
const storageState = {
  cookies: [],
  origins: [
    {
      origin: new URL(baseURL).origin,
      localStorage: [{ name: 'shots-consent', value: '{"analytics":false,"ads":false}' }],
    },
  ],
}

export default defineConfig({
  expect: { timeout: 20_000 },
  forbidOnly: Boolean(process.env.CI),
  // Starts the social API router every worker shares (framework/social-mock.ts).
  globalSetup: './test/e2e/framework/social-mock.ts',
  // The JSON report feeds scripts/e2e-durations.mjs, the suite's time baseline.
  // dev/studio runs one lane at a time (E2E_LANE), so each lane keeps its report.
  reporter: process.env.CI
    ? [
        ['github'],
        ['json', { outputFile: `playwright-report/results-${process.env.E2E_LANE ?? 'all'}.json` }],
      ]
    : 'list',
  // One retry only reports a flaky test; a test that needs more is a bug.
  retries: process.env.CI ? 1 : 0,
  // Both lanes run Chromium; snapshots keep the names they had before the lanes.
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}-chromium{-snapshotSuffix}{ext}',
  testDir: './test/e2e',
  testIgnore,
  // The per-test budget. A cold Next.js dev route compiles on first request,
  // once for all workers. Tests tagged @journey get five minutes (framework/index.ts).
  timeout: 60_000,
  // Every test builds its own workspace, client IP and social secret, so
  // workers share nothing but the stack. dev/studio provisions 8 worker social
  // secrets (framework/social-mock.ts), so a local run uses at most 8.
  workers: process.env.CI ? 4 : Math.min(8, Math.max(1, Math.floor(availableParallelism() / 2))),
  use: {
    baseURL,
    screenshot: 'only-on-failure',
    storageState,
    trace: 'retain-on-failure',
  },
  // The two lanes (test/e2e/README.md). dev/studio runs `production` against
  // a production build and `dev-server` against `next dev`; against `next dev`
  // alone, both projects pass.
  projects: [
    {
      name: 'production',
      grepInvert: /@dev-server/,
      outputDir: 'test-results/production',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'dev-server',
      grep: /@dev-server/,
      outputDir: 'test-results/dev-server',
      // `next dev` compiles and serves dev React; on a 4-vCPU CI runner, 4
      // workers overloaded it (saves stuck on "Saving…"), so it runs one at a time.
      workers: 1,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
