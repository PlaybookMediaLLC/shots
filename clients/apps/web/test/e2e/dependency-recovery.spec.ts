import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { browserRequest, closeSharedDatabase, db, expect, requestJson, test } from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

const composeArguments = ['compose', '--env-file', '.local/dev.env', '--file', 'dev/compose.yaml']
if (process.env.E2E_DOCKER_HOST_GATEWAY === 'true') {
  composeArguments.push('--file', 'dev/compose.ci.yaml')
}
const assetUpload = {
  bytes: 1,
  classification: 'input',
  contentType: 'image/png',
  fileName: 'resilience.png',
  sha256: '0'.repeat(64),
}

function compose(...args: string[]): void {
  execFileSync('docker', [...composeArguments, ...args], { cwd: '../../..', stdio: 'inherit' })
}

function restartService(service: string): void {
  compose('up', '--detach', service)
}

async function waitForStatus(
  request: () => Promise<number>,
  expectedStatus: number
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await request()) === expectedStatus) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`The recovered dependency did not return ${expectedStatus}.`)
}

function stopService(service: string): void {
  compose('stop', service)
}

async function verifyServiceRecovery(
  service: string,
  request: () => Promise<number>,
  unavailableStatus: number,
  recoveredStatus: number
): Promise<void> {
  try {
    stopService(service)
    expect(await request()).toBe(unavailableStatus)
  } finally {
    restartService(service)
  }
  await waitForStatus(request, recoveredStatus)
}

test('required dependencies return a safe failure or recover without data loss', async ({
  page,
  workspace,
}) => {
  const identifier = `e2e-recovery-${randomUUID()}`
  const screenshotRequest = () =>
    requestJson(
      page,
      '/api/screenshot',
      {
        colorScheme: 'light',
        deviceType: 'desktop',
        url: `https://recovery.example/${identifier}`,
      },
      'POST',
      { 'x-forwarded-for': identifier }
    )

  // Close only the fixture's idle connection before outages: Compose may
  // recreate Postgres when restarting a dependent service. The app stays connected.
  await closeSharedDatabase()
  await verifyServiceRecovery('redis', async () => (await screenshotRequest()).status, 503, 200)
  await verifyServiceRecovery('rustfs', async () => (await screenshotRequest()).status, 200, 200)
  // The web has no database or storage credentials: every product request
  // goes through the backend, which signs uploads without contacting storage.
  await verifyServiceRecovery(
    'publishing-backend',
    async () => (await requestJson(page, '/api/tenant/assets/upload-url', assetUpload)).status,
    503,
    201
  )
  await verifyServiceRecovery(
    'postgres',
    async () => (await browserRequest(page, '/api/tenant/releases')).status,
    503,
    200
  )
  expect(await db.row('SELECT id FROM organization WHERE id = $1', [workspace.id])).toEqual({
    id: workspace.id,
  })
})
