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
  // The JSON report feeds scripts/e2e-durations.mjs (the suite's time baseline)
  // and scripts/e2e-shard-manifest.mjs (the committed shard plan). The blob
  // report merges every shard into one HTML report with traces, which a
  // per-shard artifact cannot give you. E2E_LANE keeps the files apart.
  reporter: process.env.CI
    ? [
        ['github'],
        ['json', { outputFile: `playwright-report/results-${process.env.E2E_LANE ?? 'all'}.json` }],
        [
          'blob',
          {
            // Shards are given explicit file lists rather than `--shard`, so
            // Playwright cannot name the blob after the shard itself; every
            // shard would write report.zip and the merge would lose all but one.
            fileName: `report-${process.env.E2E_SHARD_ID ?? '1'}-${process.env.E2E_LANE ?? 'all'}.zip`,
            outputDir: 'blob-report',
          },
        ],
      ]
    : 'list',
  // One retry only reports a flaky test; a test that needs more is a bug.
  retries: process.env.CI ? 1 : 0,
  // Both lanes run Chromium; snapshots keep the names they had before the lanes.
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}-chromium{-snapshotSuffix}{ext}',
  testDir: './test/e2e',
  testIgnore,
  // The per-test budget. Tests tagged @journey get five minutes (framework/index.ts).
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
  // One lane: the production build, the artifact that ships (test/e2e/README.md).
  // The hooks that once needed a second `next dev` lane are now asked for
  // explicitly (lib/e2e-hooks.ts).
  projects: [
    {
      name: 'production',
      grepInvert: /@quarantine/,
      outputDir: 'test-results/production',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Flows the production build is known to fail, or that were held out of
      // it with no reason recorded. They run nightly against the same image,
      // never on the pull request path, so a known bug costs no review time
      // and a fixed one shows up as a pass. A failure here is expected, so
      // there is nothing to gain from a retry or from a five-minute budget.
      name: 'quarantine',
      grep: /@quarantine/,
      outputDir: 'test-results/quarantine',
      retries: 0,
      timeout: 120_000,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
