import {
  type E2EIdentity,
  enableTwoFactorInSettings,
  expect,
  getE2EUrl,
  getTotpCode,
  type Page,
  requestJson,
  test,
} from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

async function startTwoFactorSignIn(page: Page, identity: E2EIdentity): Promise<void> {
  await page.goto(getE2EUrl('/sign-in'))
  await page.getByLabel('Email', { exact: true }).fill(identity.email)
  await page.getByLabel('Password').fill(identity.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  // Race the redirect against the form's error alert. Polling the URL alone
  // reports a bare timeout whichever way this fails, which hides whether the
  // credentials were rejected (for example by the two-factor account lockout
  // this spec's replay assertions can trigger) or the navigation was merely
  // slow. Surfacing the alert text turns that ambiguity into a real message.
  await expect
    .poll(
      async () => {
        try {
          const pathname = new URL(page.url()).pathname
          if (pathname === '/two-factor') return pathname
          const alert = page.getByRole('alert')
          if ((await alert.count()) === 0) return pathname
          return `${pathname} rejected: ${await alert.first().innerText()}`
        } catch {
          // Reading the page mid-navigation destroys the execution context.
          // expect.poll fails on a thrown error instead of retrying, so return a
          // non-matching value and let the next tick observe the settled page.
          return 'pending'
        }
      },
      { timeout: 45_000 }
    )
    .toBe('/two-factor')
}

async function signOut(page: Page): Promise<void> {
  expect((await requestJson(page, '/api/auth/sign-out', {})).status).toBe(200)
}

// Signs in several times in a few seconds on purpose. The production build
// raises Better Auth's 3-per-10-s sign-in limit only for an end-to-end stack
// (lib/e2e-hooks.ts); deployed builds keep it.
test(
  'two-factor sign-in accepts a TOTP or one-time recovery code and rejects replay',
  { tag: '@journey' },
  async ({ identity, page }) => {
    const setup = await enableTwoFactorInSettings(page, identity.password)
    const recoveryCode = setup.backupCodes[0]
    if (!recoveryCode) throw new Error('Two-factor setup did not return a recovery code.')

    await signOut(page)
    await startTwoFactorSignIn(page, identity)
    await page.getByLabel('Authenticator code').fill(getTotpCode(setup.totpURI))
    await page.getByRole('button', { name: 'Verify and sign in' }).click()
    await expect.poll(() => new URL(page.url()).pathname).toBe('/home')

    await signOut(page)
    await startTwoFactorSignIn(page, identity)
    await page.getByRole('button', { name: 'Use a recovery code' }).click()
    await page.getByLabel('Recovery code').fill(recoveryCode)
    await page.getByRole('button', { name: 'Verify and sign in' }).click()
    await expect.poll(() => new URL(page.url()).pathname).toBe('/home')

    await signOut(page)
    await startTwoFactorSignIn(page, identity)
    await page.getByRole('button', { name: 'Use a recovery code' }).click()
    await page.getByLabel('Recovery code').fill(recoveryCode)
    await page.getByRole('button', { name: 'Verify and sign in' }).click()
    await expect(page.getByText('Invalid backup code')).toBeVisible()
  }
)
