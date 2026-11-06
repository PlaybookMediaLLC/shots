/**
 * The one rule for test-only behavior in the web app.
 *
 * The browser suite needs a handful of hooks the product never offers real
 * users: a deterministic stand-in AI model, downloads from the screenshot mock
 * on a private address, and sign-in attempts that are not rate limited. They
 * used to be keyed on `NODE_ENV !== 'production'`, which forced every test
 * that needed one onto a second `next dev` lane — a build nobody ships, run on
 * one worker, warmed route by route. That lane cost more CI time than every
 * other browser test put together, and it hid real production-build bugs.
 *
 * Now the production build can be asked for the same hooks explicitly, and
 * the suite runs one lane against the artifact that actually ships.
 *
 * The gate is deliberately hard to enable by accident:
 *
 * 1. `NODE_ENV` below production already means a developer's own machine.
 * 2. A production build additionally needs `PLATFORM_E2E_HOOKS=1`.
 * 3. ...and must be serving a loopback origin. Every e2e lane runs on
 *    localhost; no deployed environment does. A leaked environment variable
 *    on a real deployment therefore still enables nothing.
 *
 * `test/e2e-hooks.test.ts` holds the gate to those three conditions, including
 * the case that matters most: the variable set on a deployed origin, which
 * still enables nothing.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0'])

function isLoopbackOrigin(url: string | undefined): boolean {
  if (!url) return false
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname.toLowerCase())
  } catch {
    return false
  }
}

/**
 * Whether this process may enable end-to-end test hooks.
 *
 * Call it at the point of use rather than caching the answer at module load:
 * the suite's own unit tests change the environment between cases.
 */
export function testHooksAllowed(): boolean {
  if (process.env.NODE_ENV !== 'production') return true
  if (process.env.PLATFORM_E2E_HOOKS !== '1') return false
  return isLoopbackOrigin(process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL)
}
