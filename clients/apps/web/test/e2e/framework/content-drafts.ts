import { expect, type Locator, type Page } from '@playwright/test'
import { db } from './services'
import { openDisclosureFor } from './controls'
import { type E2EIdentity, setupStep } from './flow'
import { type HttpMockServer, startHttpMockServer } from './http-server'
import { socialWorkerPort } from './social-mock'
import {
  apiRequest,
  bindTestGoOrganization,
  connectionSchema,
  createPublishingWorkspace,
  e2eSecretReference,
  enablePublishingTwoFactor,
  trpcMutation,
} from './publishing'

/**
 * Setup for the content draft flows (RFC 013): a paid workspace bound to the
 * social API mock, with one connected channel per platform. The mock answers the
 * destination checks only; posts are scheduled for later, so nothing
 * publishes during a test.
 */

/**
 * This worker's social API mock port. The router on the stack's SOCIAL_API_URL
 * forwards this worker's calls here (framework/social-mock.ts).
 */
export const socialMockPort = socialWorkerPort(Number(process.env.TEST_PARALLEL_INDEX ?? 0))

/** Credential-free standard X identity supplied only by the local protocol fixture. */
/** A verified read-write X profile; the backend requires it before saving an X connection. */
export const xVerification = {
  accountKey: 'x:123456789',
  accountKind: 'profile',
  grantedScopes: ['read-write'],
  capabilities: {
    version: 1,
    x: {
      oauth1AccessLevel: 'read-write',
      subscriptionType: null,
      standardMaxWeightedCharacters: 280,
      charactersReservedPerUrl: 23,
      maxImages: 4,
      maxGifs: 1,
      maxVideos: 1,
      imageMaxBytes: 5000000,
      gifMaxBytes: 15000000,
      longPostMaxWeightedCharacters: null,
      articles: null,
      videoMaxBytes: null,
      videoMaxDurationSeconds: null,
    },
  },
}

/** Native identity snapshots used by local tests; these never authorize real accounts. */
const nativeVerification: Record<string, { nativeId: string; verification: object }> = {
  x: { nativeId: '123456789', verification: xVerification },
  bluesky: {
    nativeId: 'did:plc:abcdefghijklmnopqrstuvwx',
    verification: {
      accountKey: 'bluesky:did:plc:abcdefghijklmnopqrstuvwx',
      accountKind: 'profile',
      grantedScopes: ['com.atproto.appPass'],
      capabilities: {
        version: 1,
        bluesky: {
          maxTextGraphemes: 300,
          maxTextBytes: 3000,
          maxImages: 4,
          imageMaxBytes: 2000000,
          maxVideos: 1,
          videoMaxBytes: 300000000,
          blobUploadLimit: null,
          videoCanUpload: null,
        },
      },
    },
  },
  'mastodon-custom': {
    nativeId: 'mastodon:fixture.social:123',
    verification: {
      accountKey: 'mastodon:fixture.social:123',
      accountKind: 'profile',
      grantedScopes: ['read', 'write'],
      capabilities: {
        version: 1,
        mastodonApiVersion: 7,
        maxCharacters: 500,
        maxMediaAttachments: 4,
        charactersReservedPerUrl: 23,
        mediaMimeTypes: ['image/png', 'video/mp4'],
        imageSizeLimit: 10000000,
        videoSizeLimit: 40000000,
        imageMatrixLimit: 16777216,
        videoMatrixLimit: 2304000,
        videoFrameRateLimit: 60,
        polls: {
          maxOptions: 6,
          maxOptionCharacters: 80,
          minDurationSeconds: 300,
          maxDurationSeconds: 604800,
        },
      },
    },
  },
}

export type DraftWorkspace = {
  channels: Record<string, string>
  organizationId: string
  provider: HttpMockServer
}

async function createDraftWorkspaceSteps(
  identity: E2EIdentity,
  page: Page,
  platforms: readonly string[] = ['x', 'linkedin'],
  planOrOptions: 'pro' | { verifiedStandardVideo?: boolean } = 'pro'
): Promise<DraftWorkspace> {
  const options = typeof planOrOptions === 'object' ? planOrOptions : {}
  let organizationId = ''
  const verifiedX = options.verifiedStandardVideo
    ? {
        ...xVerification,
        capabilities: {
          ...xVerification.capabilities,
          x: {
            ...xVerification.capabilities.x,
            subscriptionType: 'None',
            articles: false,
            videoMaxBytes: 8_000_000_000,
            videoMaxDurationSeconds: 1200,
          },
        },
      }
    : xVerification
  const provider = await startHttpMockServer((request) => {
    if (request.url === '/api/public/v1/me') {
      return { body: { organization: { id: `go-${organizationId}` } } }
    }
    const nativePlatform = platforms.find(
      (platform) =>
        request.url === `/api/public/v1/integrations/social-${organizationId}-${platform}/identity`
    )
    if (nativePlatform && nativeVerification[nativePlatform]) {
      return {
        body: {
          id: `social-${organizationId}-${nativePlatform}`,
          provider: nativePlatform,
          name: `Shots on ${nativePlatform}`,
          handle: `shots_${nativePlatform}`,
          active: true,
          verifiedAt: new Date().toISOString(),
          ...nativeVerification[nativePlatform],
          ...(nativePlatform === 'x' ? { verification: verifiedX } : {}),
        },
      }
    }
    if (request.url === '/api/public/v1/integrations') {
      return {
        body: platforms.map((platform) => ({
          disabled: false,
          id: `social-${organizationId}-${platform}`,
          identifier: platform,
          name: `Shots on ${platform}`,
          picture: '',
          profile: `shots_${platform}`,
        })),
      }
    }
    return { body: { error: 'Unexpected request.' }, status: 500 }
  }, socialMockPort)
  await createPublishingWorkspace(identity, page)
  // Connecting a channel and cancelling a post are sensitive actions.
  await enablePublishingTwoFactor(page, identity.password)
  organizationId = await bindTestGoOrganization(page)
  // The product checks actual provider credentials in the shared database.
  // The HTTP fixture still owns destination verification; neither path bypasses health.
  await db.query(
    `INSERT INTO "Organization" (id,name,"updatedAt") VALUES ($1,'Draft fixture',now())`,
    [`go-${organizationId}`]
  )
  for (const platform of platforms) {
    await db.query(
      `INSERT INTO "Integration" (id,"internalId","organizationId",name,"providerIdentifier",type,token)
         VALUES ($1,$1,$2,$3,$3,'social','fixture-only-credential')`,
      [`social-${organizationId}-${platform}`, `go-${organizationId}`, platform]
    )
    const native = nativeVerification[platform]
    if (native) {
      const verification =
        platform === 'x' ? verifiedX : (native.verification as typeof xVerification)
      await db.query(
        `UPDATE "Integration" SET "internalId"=$2, "verifiedAccountKey"=$3,
          "verifiedAccountKind"=$4, "verifiedScopes"=$5, "verifiedCapabilities"=$6, "identityVerifiedAt"=now()
          WHERE id=$1`,
        [
          `social-${organizationId}-${platform}`,
          native.nativeId,
          verification.accountKey,
          verification.accountKind,
          JSON.stringify(verification.grantedScopes),
          JSON.stringify(verification.capabilities),
        ]
      )
    }
  }
  const channels: Record<string, string> = {}
  for (const platform of platforms) {
    const response = await trpcMutation(page, 'channelConnection.create', {
      externalAccountId: `social-${organizationId}-${platform}`,
      platform,
      secretReference: e2eSecretReference,
    })
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    channels[platform] = connectionSchema.parse(response.body).connection.id
  }
  return { channels, organizationId, provider }
}
export const createDraftWorkspace = setupStep(
  'create a publishing workspace with channels',
  createDraftWorkspaceSteps
)

/**
 * Turn on draft tags for the signed-in person: a settings platform
 * experiment (RFC 024) the backend enforces. Planning was promoted.
 */
export async function enableDraftTags(page: Page): Promise<void> {
  const response = await apiRequest(page, '/api/v1/me/preferences', {
    body: { experiments: { 'draft-tags': true } },
    method: 'PATCH',
  })
  expect(response.status, JSON.stringify(response.body)).toBe(200)
}

/** The draft body editor. */
export function draftEditor(page: Page) {
  return page.getByRole('textbox', { name: 'Draft body' })
}

/** Choose an item from the editor toolbar's More menu (insert, media tools, import and export). */
export async function editorMore(page: Page, item: string): Promise<void> {
  await page
    .getByRole('toolbar', { name: 'Draft tools' })
    .getByRole('button', { name: 'More', exact: true })
    .click()
  // An item's name can go on with how it publishes ("Table Publishes as image").
  const name = new RegExp(`^${item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`)
  await page.getByRole('menuitem', { name }).click()
}

/** Open post `number`'s More menu in its bar; returns the menu, to choose an item or check one. */
export async function postMenu(page: Page, number: number): Promise<Locator> {
  await page.getByRole('button', { name: `More for post ${number}`, exact: true }).click()
  return page.getByRole('menu')
}

/** Wait until autosave has written every change. */
export async function expectSaved(page: Page): Promise<void> {
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 20_000 })
}

/** How the composer names each platform. */
const PLATFORM_LABELS: Record<string, string> = { linkedin: 'LinkedIn', x: 'X' }

/**
 * Open a new draft and return its id. A blank post is only saved at its
 * first word, so this makes the row through the API, for specs that start
 * from a saved draft; `fields` seeds it, such as an older draft's body.
 * `startPostByTyping` is the path a person takes.
 */
export async function openNewDraft(
  page: Page,
  fields: Record<string, unknown> = {}
): Promise<string> {
  await page.goto('/publish')
  const created = await apiRequest(page, '/api/v1/content-drafts', { method: 'POST', body: fields })
  expect(created.status, JSON.stringify(created.body)).toBe(201)
  const { id } = created.body as { id: string }
  await page.goto(`/publish/${id}`)
  await expect(draftEditor(page)).toBeVisible({ timeout: 60_000 })
  return id
}

/** Start a post the way a person does: the box opens, and the first word makes the draft. */
export async function startPostByTyping(page: Page, text: string): Promise<string> {
  await page.getByTestId('new-draft').first().click()
  await expect(page.getByRole('textbox', { name: 'New draft text' })).toBeFocused()
  await page.keyboard.type(text)
  await page.waitForURL(/\/publish\/[a-z0-9]+/)
  await expect(draftEditor(page)).toContainText(text, { timeout: 60_000 })
  return new URL(page.url()).pathname.split('/').pop() ?? ''
}

/**
 * Start a bulk batch (RFC 042) from Write's batches page, in the workspace's
 * profile, and return its id once its page can be used.
 */
export async function openNewBatch(
  page: Page,
  app: { open(path: string): Promise<void>; reload(): Promise<void> }
): Promise<string> {
  await app.open('/publish/batches')
  await page
    .getByTestId('bulk-tools')
    .getByRole('radio', { name: /^Mixed files or a CSV/ })
    .click()
  await page.getByRole('button', { name: 'Start a batch', exact: true }).click()
  await page.waitForURL(/\/publish\/batches\/[^/]+$/)
  await app.reload()
  await expect(page.getByTestId('bulk-batch')).toBeVisible()
  return new URL(page.url()).pathname.split('/').pop() ?? ''
}

/** Type `csv` into the batch's CSV box, opening its section first when it is closed. */
export async function fillBatchCSV(page: Page, csv: string): Promise<void> {
  const box = page.getByLabel('Batch CSV', { exact: true })
  if (!(await box.isVisible())) await openDisclosureFor(box)
  await box.fill(csv)
}

/** Uploaded media shown on a batch item: its type, or why it is not stored yet. */
const PENDING_MEDIA = /Uploading|Waiting to upload|Upload failed/

/**
 * Add a batch's rows from `csv` with the selected `files`, wait for every
 * upload, and return the items' locators in order. Rows with a problem stay
 * in the preview and are not added.
 */
export async function addBatchRows(
  page: Page,
  csv: string,
  files: Parameters<Locator['setInputFiles']>[0] = []
): Promise<Locator> {
  const items = page.getByTestId('batch-item')
  const before = await items.count()
  if (Array.isArray(files) ? files.length : files)
    await page.getByLabel('Batch media files').setInputFiles(files)
  await fillBatchCSV(page, csv)
  await page.getByRole('button', { name: 'Preview import', exact: true }).click()
  const preview = page.getByTestId('import-preview')
  await expect(preview).toBeVisible()
  const add = preview.getByRole('button', { name: /^Add \d+ ready rows/ })
  const ready = Number((await add.textContent())?.match(/\d+/)?.[0] ?? 0)
  await add.click()
  await expect(items).toHaveCount(before + ready)
  await expect(items.filter({ hasText: PENDING_MEDIA })).toHaveCount(0, { timeout: 60_000 })
  return items
}

/** Save the batch's ready items as drafts and return every saved item's draft id, in order. */
export async function saveBatchDrafts(page: Page): Promise<string[]> {
  const items = page.getByTestId('batch-item')
  await page.getByRole('button', { name: 'Save ready items as drafts', exact: true }).click()
  await expect(items.filter({ has: page.getByText('Not saved', { exact: true }) })).toHaveCount(0, {
    timeout: 60_000,
  })
  return (
    await items
      .getByRole('link', { name: /^Open draft/ })
      .evaluateAll((links) => links.map((link) => link.getAttribute('href')!))
  ).map((href) => href.split('/').pop()!)
}

/**
 * Turn platforms on with their tabs' switches. A new draft already publishes
 * to every platform of its set, so this confirms them rather than adding any.
 */
export async function chooseChannels(page: Page, platforms: readonly string[]): Promise<void> {
  const tabs = page.getByTestId('platform-tabs')
  for (const platform of platforms) {
    await tabs.getByRole('switch', { name: `Publish to ${PLATFORM_LABELS[platform]}` }).check()
  }
}

/** Run checks against the previews, with the preview panel open, then close it. */
export async function inPreview(page: Page, check: () => Promise<void>): Promise<void> {
  const toggle = page.getByRole('button', { name: 'Preview', exact: true })
  await toggle.click()
  await expect(page.getByTestId('preview-panel')).toBeVisible()
  await check()
  await toggle.click()
  await expect(page.getByTestId('preview-panel')).toHaveCount(0)
}

/**
 * Show one platform in the open preview panel. Returns its post preview; the
 * panel around it lists what blocks it and what changes when it is posted.
 */
export async function previewOf(page: Page, platform: string): Promise<Locator> {
  await page
    .getByTestId('preview-panel')
    .getByRole('button', { name: PLATFORM_LABELS[platform], exact: true })
    .click()
  return page.getByTestId(`preview-${platform}`)
}

/** Press Schedule while something blocks it: the checklist comes first, then the dialog, which still explains. */
export async function openBlockedSchedule(page: Page): Promise<Locator> {
  await page.getByTestId('schedule-button').click()
  await expect(page.getByTestId('blockers')).toBeVisible()
  await page.getByRole('button', { name: 'Save as planned instead…' }).click()
  const dialog = page.getByTestId('schedule-dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

/** Open the schedule dialog from the top bar; returns it. */
export async function openSchedule(page: Page): Promise<Locator> {
  await page.getByTestId('schedule-button').click()
  const dialog = page.getByTestId('schedule-dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

/**
 * Put the caret at the end of the draft's last text, as after reopening the
 * editor from a dialog. Waits out slate's selection sync like caretAtEndOf.
 */
/**
 * Slate copies the DOM selection into its model on a 100 ms timer and fires
 * no event when it does. Wait it out so the next key lands at the caret.
 */
export async function settleSelection(page: Page): Promise<void> {
  await page.waitForTimeout(300)
}

export async function caretAtDocumentEnd(page: Page): Promise<void> {
  await draftEditor(page).focus()
  await draftEditor(page).evaluate((editor) => {
    const strings = editor.querySelectorAll('[data-slate-string]')
    const text = strings[strings.length - 1]?.firstChild
    if (!text) return
    const range = document.createRange()
    range.setStart(text, text.textContent?.length ?? 0)
    range.collapse(true)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
  })
  await settleSelection(page)
}
