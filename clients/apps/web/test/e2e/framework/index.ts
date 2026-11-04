/* eslint-disable no-empty-pattern -- `{}` is how a Playwright fixture declares no dependencies. */
import { randomInt } from 'node:crypto'
import { test as base, expect, type Page } from '@playwright/test'
import { createDraftWorkspace } from './content-drafts'
import { createIdentity, type E2EIdentity, waitForHydration } from './flow'
import { getActiveOrganizationId } from './auth'
import { createPublishingWorkspace, unbindTestGoOrganization } from './publishing'
import { closeSharedDatabase } from './services'
import {
  PRODUCT_TOUR_RESOLVED_KEY,
  PRODUCT_TOURS,
  tourTipId,
} from '../../../lib/platform/product-tour'

/**
 * The end-to-end test framework. Every spec imports `test` and `expect` from
 * here, declares the state it starts from, and leaves setup, waiting and
 * cleanup to the fixtures:
 *
 *   // Every test in this file starts signed in to its own Pro workspace.
 *   test.use({ workspaceOptions: { channels: ['x'], plan: 'pro' } })
 *
 *   test('…', async ({ app, workspace }) => {
 *     await app.open('/write')
 *     expect(await db.row('SELECT …', [workspace.id])).toMatchObject({ … })
 *   })
 *
 * See test/e2e/README.md for the rules every spec follows.
 */

export { expect }

/**
 * The workspace a test starts in. Declare it for a file with
 * `test.use({ workspaceOptions })`; a test that only reads `workspace`
 * gets a Pro workspace without channels.
 */
export type WorkspaceOptions = {
  /** Connect these social channels. Brings two-factor and the social API binding. */
  channels?: readonly string[]
  /** Pro; there is no free plan. */
  plan?: 'pro'
  /** The X identity reports standard (not Premium) video limits. */
  verifiedStandardVideo?: boolean
}

/** The signed-in owner's workspace, built through the API. */
export type Workspace = {
  /** Connection ids by platform, for `channels`. */
  channels: Record<string, string>
  id: string
}

/** Navigation that waits until the page can be used. */
export type App = {
  expectPath: (path: string) => Promise<void>
  /** Load `path` and wait until React has hydrated it. */
  open: (path: string) => Promise<void>
  /** Open the screenshot editor and wait until it can be used. */
  openEditor: () => Promise<void>
  /** Reload and wait until React has hydrated the page again. */
  reload: () => Promise<void>
}

/** Opens the screenshot editor on `page` and waits until it can be used. */
export async function openEditor(page: Page): Promise<void> {
  await page.goto('/')
  await waitForHydration(page)
  await expect(page.getByRole('button', { exact: true, name: 'Export' })).toBeVisible()
}

async function buildWorkspace(
  identity: E2EIdentity,
  page: Page,
  { channels: platforms, plan = 'pro', verifiedStandardVideo }: WorkspaceOptions,
  cleanups: (() => Promise<void>)[]
): Promise<Workspace> {
  if (platforms?.length) {
    const built = await createDraftWorkspace(
      identity,
      page,
      platforms,
      verifiedStandardVideo ? { verifiedStandardVideo } : plan
    )
    cleanups.push(
      () => built.provider.close(),
      () => unbindTestGoOrganization(built.organizationId)
    )
    return { channels: built.channels, id: built.organizationId }
  }
  await createPublishingWorkspace(identity, page)
  const id = await getActiveOrganizationId(page)
  return { channels: {}, id }
}

/** Long user journeys may take longer than the default per-test budget. */
const JOURNEY_TIMEOUT = 300_000

export const test = base.extend<
  {
    app: App
    budget: void
    failureContext: void
    identity: E2EIdentity
    /** Let the first-visit product tour start by itself; off, so it covers no other spec's page. */
    productTour: boolean
    quietProductTours: void
    thirdPartyAssets: boolean
    thirdPartyAssetsRoute: void
    startInWorkspace: void
    /**
     * Builds this test's workspace with its own options, once, and cleans it
     * up after the test. For a file whose tests need different channels.
     */
    startWorkspace: (options?: WorkspaceOptions) => Promise<Workspace>
    workspace: Workspace
    workspaceOptions: WorkspaceOptions | null
  },
  { database: void }
>({
  identity: async ({}, provide) => {
    await provide(createIdentity())
  },

  // Every test account is new, so the first-visit tour would open its card,
  // a second dialog, on each page. A spec about the tour sets `productTour`.
  productTour: [false, { option: true }],
  quietProductTours: [
    async ({ context, productTour }, provide) => {
      if (!productTour) {
        const tips = PRODUCT_TOURS.filter((tour) => 'autoStart' in tour && tour.autoStart).map(
          tourTipId
        )
        await context.addInitScript(
          ([key, seen]) => {
            try {
              window.sessionStorage.setItem(key, JSON.stringify(seen))
            } catch {
              // A page without storage still runs the spec; the tour can then open.
            }
          },
          [PRODUCT_TOUR_RESOLVED_KEY, tips] as const
        )
      }
      await provide()
    },
    { auto: true },
  ],

  // Each test is its own client, so rate limits keyed by client IP count only
  // the test's own requests and parallel workers never share a budget.
  extraHTTPHeaders: async ({ extraHTTPHeaders }, provide) => {
    await provide({
      ...extraHTTPHeaders,
      'x-forwarded-for': `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`,
    })
  },

  // The client IP is for the app only. On a cross-origin request, such as a
  // font or a model from a CDN, the extra header forces a CORS preflight
  // that the third party refuses. A file that loads such assets sets
  // `thirdPartyAssets`. Off by default: any route turns off the browser's
  // HTTP cache, which made every test about 1.4 times slower.
  thirdPartyAssets: [false, { option: true }],
  thirdPartyAssetsRoute: [
    async ({ baseURL, context, thirdPartyAssets }, provide) => {
      if (!thirdPartyAssets) return provide()
      const app = new URL(baseURL ?? 'http://localhost:3000').origin
      await context.route(
        (url) => url.origin !== app,
        async (route) => {
          const headers = { ...route.request().headers() }
          delete headers['x-forwarded-for']
          await route.fallback({ headers })
        }
      )
      await provide()
    },
    { auto: true },
  ],

  budget: [
    async ({}, provide, testInfo) => {
      // 0 is no timeout (--timeout=0); a longer file budget stays.
      if (testInfo.tags.includes('@journey') && testInfo.timeout)
        testInfo.setTimeout(Math.max(testInfo.timeout, JOURNEY_TIMEOUT))
      await provide()
    },
    { auto: true },
  ],

  // A failure names the test's identity, never its password.
  failureContext: [
    async ({ identity }, provide, testInfo) => {
      await provide()
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('e2e-identity', {
          body: JSON.stringify({ email: identity.email, workspaceName: identity.workspaceName }),
          contentType: 'application/json',
        })
      }
    },
    { auto: true },
  ],

  app: async ({ page }, provide) => {
    await provide({
      expectPath: async (path) => {
        await expect.poll(() => new URL(page.url()).pathname).toBe(path)
      },
      open: async (path) => {
        const response = await page.goto(path)
        const type = response?.headers()['content-type'] ?? 'text/html'
        // A redirect off the app or a JSON error never hydrates: fail with what came back.
        if (!type.startsWith('text/html'))
          throw new Error(`${path} answered ${response?.status()} ${type}, not a page.`)
        await waitForHydration(page)
      },
      openEditor: () => openEditor(page),
      reload: async () => {
        await page.reload()
        await waitForHydration(page)
      },
    })
  },

  // Closes the worker's database pool (`db`) when the worker stops.
  database: [
    async ({}, provide) => {
      await provide()
      await closeSharedDatabase()
    },
    { auto: true, scope: 'worker' },
  ],

  workspaceOptions: [null, { option: true }],

  startWorkspace: async ({ identity, page, workspaceOptions }, provide) => {
    let built: { options: string; workspace: Promise<Workspace> } | null = null
    const cleanups: (() => Promise<void>)[] = []
    await provide((options) => {
      const wanted = options ?? workspaceOptions ?? {}
      built ??= {
        options: JSON.stringify(wanted),
        workspace: buildWorkspace(identity, page, wanted, cleanups),
      }
      if (options && JSON.stringify(options) !== built.options)
        throw new Error('This test already has a workspace with other options.')
      return built.workspace
    })
    for (const cleanup of cleanups.reverse()) await cleanup()
  },

  workspace: async ({ startWorkspace }, provide) => {
    await provide(await startWorkspace())
  },

  // A file that declares `workspaceOptions` starts every test in its workspace.
  startInWorkspace: [
    async ({ startWorkspace, workspaceOptions }, provide) => {
      if (workspaceOptions) await startWorkspace()
      await provide()
    },
    { auto: true },
  ],
})

export type { Browser, Download, Locator, Page, Route } from '@playwright/test'
export type { E2EIdentity }

// One import for every spec. Where two modules once shared a name, this is
// the one to use.
export {
  acceptInvitation,
  /** Two-factor through the Security settings screen, for specs about that screen. */
  enableTwoFactor as enableTwoFactorInSettings,
  findActiveOrganizationId,
  getActiveOrganizationId,
  getE2EUrl,
  openWorkspaceSetting,
  signUp,
  signUpViaApi,
} from './auth'
export {
  browserJson,
  browserRequest,
  downloadSignedAsset,
  requestJson,
  uploadSignedAsset,
} from './browser'
export {
  addBatchRows,
  caretAtDocumentEnd,
  chooseChannels,
  draftEditor,
  enableDraftTags,
  expectSaved,
  inPreview,
  openNewBatch,
  openNewDraft,
  openSchedule,
  previewOf,
  saveBatchDrafts,
  settleSelection,
  socialMockPort,
  xVerification,
} from './content-drafts'
export { borderContrastOf, chooseOption, contrastOf, openDisclosureFor } from './controls'
export { mockBrowserJson } from './downstream'
export { startHttpMockServer, type HttpMockRequest, type HttpMockServer } from './http-server'
export { getMaintenanceHeaders } from './maintenance'
export { decodeMp4, readMp4Tracks } from './mp4'
export {
  apiRequest,
  bindTestGoOrganization,
  connectionSchema,
  createApprovedVariant,
  /** A workspace for another identity, such as a second tenant. */
  createPublishingWorkspace as createWorkspace,
  createScheduledPost,
  createUploadedAsset,
  e2eSecretReference,
  /** Two-factor through the API, for specs that only need it on. */
  enablePublishingTwoFactor as enableTwoFactor,
  png,
  scheduledPostSchema,
  signedAssetSchema,
  unbindTestGoOrganization,
} from './publishing'
export { SECRETS, dropSensitiveScreenshot, ocr } from './sensitive'
export {
  createE2EObjectStoreClient,
  db,
  getE2EObjectStoreBucket,
  grantWorkspacePlan,
} from './services'
export { connectionAvailabilityFixture } from './social-availability'
export { unroutedSocialRequests } from './social-mock'
export { getTotpCode } from './totp'
export { trpcMutation, trpcQuery } from './trpc'
