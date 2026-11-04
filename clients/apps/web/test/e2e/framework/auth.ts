import { z } from 'zod'
import { expect, type Page, type Response } from '@playwright/test'
import { type E2EIdentity, setupStep, waitForHydration } from './flow'
import { browserJson, browserRequest, type BrowserRequest } from './browser'
import { db } from './services'
import { getTotpCode } from './totp'
import { SETTINGS_SECTIONS, settingsHref } from '../../../components/workspace/settings-sections'

const sessionSchema = z.object({
  session: z.object({ activeOrganizationId: z.string().nullable() }),
})

export type TwoFactorSetup = { backupCodes: string[]; totpURI: string }

// Production Better Auth limits account creation/sign-in independently of the
// app's Redis limiter. Retry only an explicit 429 (no write was admitted), never
// a timeout or an unknown result. Other test failures remain immediate failures.
async function waitForAuthLimit(page: Page, retryAfter: string | null): Promise<void> {
  const seconds = Number(retryAfter)
  if (!retryAfter || !Number.isFinite(seconds) || seconds < 0 || seconds > 60)
    throw new Error('Invalid auth Retry-After.')
  await page.waitForTimeout(Math.max(1, seconds) * 1_000 + 100)
}

async function submitAuthForm(page: Page, path: string, label: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = page.waitForResponse(
      (candidate) => candidate.url().endsWith(path) && candidate.request().method() === 'POST'
    )
    await page.getByRole('button', { name: label, exact: true }).click()
    const result = await response
    if (result.status() !== 429 || attempt === 3) return result
    await waitForAuthLimit(
      page,
      result.headers()['retry-after'] ?? result.headers()['x-retry-after'] ?? null
    )
  }
}

async function authJson(page: Page, path: string, input: BrowserRequest): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const result = await browserRequest(page, path, input)
    if (result.status === 429 && attempt < 3) {
      await waitForAuthLimit(page, result.retryAfter)
      continue
    }
    expect(result.status, `Auth request ${path}`).toBe(200)
    return result.body
  }
}

export async function signUp(identity: E2EIdentity, page: Page): Promise<void> {
  await page.goto(getE2EUrl('/sign-up'))
  await page.getByLabel('Name').fill(identity.name)
  await page.getByLabel('Email').fill(identity.email)
  await page.getByLabel('Password').fill(identity.password)
  const registration = await submitAuthForm(page, '/api/auth/sign-up/email', 'Create account')
  expect(registration.status()).toBe(200)
  // A successful form can navigate before Chromium exposes its response body.
  const session = await page.request.get(getE2EUrl('/api/auth/get-session'))
  if (!z.object({ user: z.object({ id: z.string() }) }).safeParse(await session.json()).success) {
    // Production intentionally does not auto-sign-in after registration. The
    // disposable stack disables email verification, so establish a real session
    // through the sign-in form instead of assuming a development-only redirect.
    await page.goto(getE2EUrl('/sign-in'))
    await page.getByLabel('Email').fill(identity.email)
    await page.getByLabel('Password', { exact: true }).fill(identity.password)
    expect((await submitAuthForm(page, '/api/auth/sign-in/email', 'Sign in')).status()).toBe(200)
  }
  await expectPath(page, '/onboarding')
}

/**
 * Create an account through the API rather than the sign-up form.
 *
 * Specs that assert on what an account may do, rather than on how it was
 * created, do not need the form. Driving the UI for each of them costs a
 * page load and four field interactions per account, which dominates the
 * runtime of any spec that needs several accounts and pushes it into
 * timeout territory for reasons unrelated to what it verifies.
 *
 * Sign-up through the form stays covered by the specs that exist to
 * exercise it.
 */
async function signUpViaApiSteps(identity: E2EIdentity, page: Page): Promise<void> {
  // Establish the origin without a sign-up screen redirect racing the next navigation.
  await page.goto(getE2EUrl('/api/health'))
  const registration = await authJson(page, '/api/auth/sign-up/email', {
    body: JSON.stringify({
      email: identity.email,
      name: identity.name,
      password: identity.password,
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (z.object({ token: z.string().nullable() }).parse(registration).token === null) {
    await authJson(page, '/api/auth/sign-in/email', {
      body: JSON.stringify({ email: identity.email, password: identity.password }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
  }
}
export const signUpViaApi = setupStep('sign up through the API', signUpViaApiSteps)

export async function acceptInvitation(page: Page, invitationId: string): Promise<void> {
  // The recipient fixture needs verified email; production acceptance always enforces it.
  const session = await page.request.get(getE2EUrl('/api/auth/get-session'))
  const { user } = z.object({ user: z.object({ id: z.string() }) }).parse(await session.json())
  const verified = await db.query(
    'UPDATE "user" SET "emailVerified"=true WHERE id=$1 AND email LIKE $2',
    [user.id, '%@example.test']
  )
  expect(verified.rowCount).toBe(1)

  await page.goto(getE2EUrl(`/accept-invitation?invitationId=${invitationId}`))
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.getByRole('button', { name: 'Accept invitation' }).click(),
  ])
  await expectPath(page, '/settings')
}

export function getE2EUrl(path: string): string {
  return new URL(path, process.env.E2E_BASE_URL ?? 'http://localhost:3000').toString()
}

async function expectPath(page: Page, path: string): Promise<void> {
  // A navigation leaves page.url() on the previous page until the server
  // responds. The e2e stack runs `next dev`, so a route that has not been
  // compiled yet can take tens of seconds on a loaded runner, and the poll
  // then reports a bare timeout that looks like a redirect that never
  // happened. dev/studio warms these routes before the suite starts, so this
  // budget only has to cover a slow response rather than a full compile;
  // it stays above the 20s default because warming is a mitigation, not a
  // guarantee, and a bare URL timeout is an expensive thing to debug.
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 60_000 }).toBe(path)
}

export async function getActiveOrganizationId(page: Page): Promise<string> {
  const result = sessionSchema.parse(await browserJson(page, '/api/auth/get-session'))
  if (!result.session.activeOrganizationId) {
    throw new Error('The signed-in user has no active organization.')
  }

  return result.session.activeOrganizationId
}

/**
 * The active organization id once the session exists, or null while it does not.
 *
 * `/api/auth/get-session` returns null for a short window after a sign-in
 * submit, before the session cookie is readable. `getActiveOrganizationId`
 * throws in that window, and a throw inside `expect.poll` fails the assertion
 * outright rather than retrying, so polling on it turns an ordinary race into
 * a hard failure. Callers that are waiting for a sign-in to land should poll
 * this instead and let the returned value settle.
 */
export async function findActiveOrganizationId(page: Page): Promise<string | null> {
  const parsed = sessionSchema.safeParse(await browserJson(page, '/api/auth/get-session'))
  if (!parsed.success) return null

  return parsed.data.session.activeOrganizationId
}

async function enableTwoFactorSteps(page: Page, password: string): Promise<TwoFactorSetup> {
  await openWorkspaceSetting(page, 'Security')
  await page.getByLabel('Current password').fill(password)
  await page.getByRole('button', { name: 'Set up authenticator' }).click()
  await expect(page.locator('code').first()).toContainText('otpauth://')
  const codes = await page.locator('code').allTextContents()
  const uri = codes[0]
  if (!uri) {
    throw new Error('Two-factor setup did not provide a TOTP URI.')
  }

  await page.getByLabel('Verification code').fill(getTotpCode(uri))
  await page.getByRole('button', { name: 'Verify and enable' }).click()
  await expect(
    page.getByText('Two-factor authentication is enabled for this account.')
  ).toBeVisible()
  return { backupCodes: codes.slice(1), totpURI: uri }
}
export const enableTwoFactor = setupStep(
  'enable two-factor in Security settings',
  enableTwoFactorSteps
)

export async function openWorkspaceSetting(page: Page, name: string): Promise<void> {
  // Go to the section's own route; the compact rail names its links only in
  // tooltips, so clicking through the sidebar depends on the layout.
  const section = SETTINGS_SECTIONS.find((candidate) => candidate.title === name)
  if (!section) throw new Error(`No workspace settings section is titled ${name}.`)
  await page.goto(settingsHref(section), { timeout: 45_000, waitUntil: 'load' })
  await waitForHydration(page)
  await expect(page.getByRole('heading', { exact: true, level: 1, name })).toBeVisible()
}
