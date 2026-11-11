import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const studio = readFileSync('../../../dev/studio', 'utf8')

/** One function of dev/studio, so these tests exercise the real shell code. */
function section(from: string, to: string): string {
  const start = studio.indexOf(from)
  const end = studio.indexOf(to)
  assert.ok(start !== -1 && end > start, `dev/studio no longer defines ${from}`)
  return studio.slice(start, end)
}

const startApp = section('start_e2e_app() {', '# Runs npm in the web app')
const runE2E = section('run_e2e() {', '# The tests held out of the suite')
const composeUp = section('compose_up() {', 'E2E_LANE_FILE_NAME=')

type Run = { status: number | null; stderr: string; commands: string[]; directory: string }

function runStudio(script: string, env: Record<string, string> = {}): Run {
  const directory = mkdtempSync(join(tmpdir(), 'studio-'))
  const result = spawnSync(
    'bash',
    [
      '-c',
      `
      set -euo pipefail
      compose() { printf '%s\\n' "$*" >> commands; }
      wait_for_screenshot_mock() { :; }
      wait_for_http() { :; }
      prebuilt_images() { [[ "\${STUDIO_PREBUILT_IMAGES:-}" == "true" ]]; }
      # The app answers /api/health only once the test says it is serving.
      curl() { [[ -f serving ]]; }
      E2E_LANE_FILE_NAME=e2e-lane
      ${composeUp}
      ${startApp}
      ${script}
    `,
    ],
    {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, LOCAL_DIR: directory, ROOT_DIR: directory, ...env },
      timeout: 10_000,
    }
  )
  let commands: string[] = []
  try {
    commands = readFileSync(join(directory, 'commands'), 'utf8').trim().split('\n').filter(Boolean)
  } catch {
    commands = []
  }
  return { status: result.status, stderr: result.stderr, commands, directory }
}

function runE2EWith(args: string[], env: Record<string, string> = {}): Run {
  const directory = mkdtempSync(join(tmpdir(), 'studio-e2e-'))
  const result = spawnSync(
    'bash',
    [
      '-c',
      `
      set -euo pipefail
      load_env() { :; }
      e2e_app_url() { printf '%s' 'http://localhost:3000'; }
      e2e_trusted_origins() { printf '%s' 'http://localhost:3000'; }
      sync_dependencies() { :; }
      start_e2e_app() { :; }
      compose() { printf '%s\\n' "$*" >> commands; }
      e2e_npm() { printf '%s\\n' "$*" >> commands; }
      WEB_DIR='${directory}'
      ${runE2E}
      run_e2e test:e2e "$@"
    `,
      'run-e2e',
      ...args,
    ],
    {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, LOCAL_DIR: directory, ...env },
      timeout: 10_000,
    }
  )
  let commands: string[] = []
  try {
    commands = readFileSync(join(directory, 'commands'), 'utf8').trim().split('\n').filter(Boolean)
  } catch {
    commands = []
  }
  return { status: result.status, stderr: result.stderr, commands, directory }
}

const START_APP = 'start_e2e_app http://localhost:3000 http://localhost:3000'

test('the e2e app is the production image, with the mock reloaded beside it', () => {
  const run = runStudio(START_APP, { E2E_APP_IMAGE_READY: 'true' })
  try {
    assert.equal(run.status, 0, run.stderr)
    const starts = run.commands.filter((command) => command.endsWith('publishing-orchestrator app'))
    assert.equal(starts.length, 1)
    // The production build (dev/compose.e2e.yaml), never `next dev`.
    assert.match(starts[0]!, /compose\.e2e\.yaml/)
    assert.deepEqual(
      run.commands.filter((command) => command.includes('--force-recreate')),
      ['--profile e2e up --detach --force-recreate screenshot-mock']
    )
    assert.equal(readFileSync(join(run.directory, 'e2e-lane'), 'utf8').trim(), 'production')
  } finally {
    rmSync(run.directory, { recursive: true, force: true })
  }
})

// CI brings the app up for its own smoke checks and then runs the suite, and
// `make e2e-recovery` runs Playwright a third time. Each of those would have
// torn the app down and rebuilt it.
test('a second call against the serving app changes nothing', () => {
  const run = runStudio(`${START_APP}\ntouch serving\n${START_APP}\n${START_APP}`, {
    E2E_APP_IMAGE_READY: 'true',
  })
  try {
    assert.equal(run.status, 0, run.stderr)
    assert.equal(
      run.commands.filter((command) => command.endsWith('publishing-orchestrator app')).length,
      1
    )
  } finally {
    rmSync(run.directory, { recursive: true, force: true })
  }
})

test('an app that stopped serving is started again', () => {
  // `serving` is never created, so /api/health keeps failing.
  const run = runStudio(`${START_APP}\n${START_APP}`, { E2E_APP_IMAGE_READY: 'true' })
  try {
    assert.equal(run.status, 0, run.stderr)
    assert.equal(
      run.commands.filter((command) => command.endsWith('publishing-orchestrator app')).length,
      2
    )
  } finally {
    rmSync(run.directory, { recursive: true, force: true })
  }
})

test('the app image is built only when no build job handed one over', () => {
  const built = runStudio(START_APP)
  const loaded = runStudio(START_APP, { E2E_APP_IMAGE_READY: 'true' })
  try {
    assert.ok(
      built.commands.some((command) => command.endsWith('build app')),
      built.stderr
    )
    assert.ok(!loaded.commands.some((command) => command.endsWith('build app')))
  } finally {
    rmSync(built.directory, { recursive: true, force: true })
    rmSync(loaded.directory, { recursive: true, force: true })
  }
})

// The whole point of STUDIO_PREBUILT_IMAGES: a browser shard must never
// compile the Go tree or the dev web image that a build job already produced.
test('prebuilt images are started, not rebuilt', () => {
  const local = runStudio('compose_up postgres publishing-backend')
  const prebuilt = runStudio('compose_up postgres publishing-backend', {
    STUDIO_PREBUILT_IMAGES: 'true',
  })
  try {
    assert.deepEqual(local.commands, ['up --detach --build postgres publishing-backend'])
    assert.deepEqual(prebuilt.commands, ['up --detach postgres publishing-backend'])
  } finally {
    rmSync(local.directory, { recursive: true, force: true })
    rmSync(prebuilt.directory, { recursive: true, force: true })
  }
})

// Every hook the suite needs now comes from the production build asking for
// it, so there is no second server to keep in sync (lib/e2e-hooks.ts).
test('dev/studio has no second browser lane left to maintain', () => {
  assert.ok(!studio.includes('dev-server'), 'the dev-server lane is gone')
  assert.ok(!studio.includes('warm_e2e_routes'), 'route warming belonged to that lane')
  assert.match(startApp, /PLATFORM_AI_SCRIPTED=1/)
})

test('the first balanced E2E shard runs the Founder Hub OAuth check', () => {
  const first = runE2EWith(['./test/e2e/settings.spec.ts'], { E2E_SHARD_ID: '1' })
  const later = runE2EWith(['./test/e2e/settings.spec.ts'], { E2E_SHARD_ID: '2' })
  try {
    assert.equal(first.status, 0, first.stderr)
    assert.ok(first.commands.some((command) => command.includes('test:founder-hub-auth')))
    assert.equal(later.status, 0, later.stderr)
    assert.ok(!later.commands.some((command) => command.includes('test:founder-hub-auth')))
  } finally {
    rmSync(first.directory, { recursive: true, force: true })
    rmSync(later.directory, { recursive: true, force: true })
  }
})

test('the e2e app shortens the signed-download lifetime it is tested against', () => {
  // tenant-assets.spec.ts waits this out; the product default is two minutes.
  assert.match(startApp, /PLATFORM_ASSET_DOWNLOAD_TTL="\$\{E2E_ASSET_DOWNLOAD_TTL:-5s\}"/)
})
