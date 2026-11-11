import type {
  draftCommentResultSchema,
  DraftCommentInput,
} from '@/lib/api/contracts/draft-comments'
import { z } from 'zod'
import { duplicatePostSchema } from '@/lib/api/platform-errors'
import type {
  calendarPostSchema,
  reviewContentDraftContract,
  contentDraftRevisionSchema,
  contentDraftSettingsSchema,
  linkCardSchema,
} from '@/lib/api/contracts/content-draft-platform'
import type {
  contentDraftCreateSchema,
  contentDraftPostSchema,
  contentDraftScheduleSchema,
  contentDraftSchema,
} from '@/lib/api/contracts/content-drafts'
import type { DraftDiscussions } from '@/lib/content-drafts/discussions'
import type { DraftChannel } from '@/lib/content-drafts/serialize'

/**
 * Browser calls to the content draft API (`/api/v1/content-drafts`), with the
 * session cookie. The routes answer the platform error envelope; its message
 * becomes the error, and its status says what to do (409: reload).
 */

/** A draft as the API sends it, with ISO timestamps. */
export type DraftWire = z.output<typeof contentDraftSchema>

/** A post scheduled from a draft, as the API sends it. */
export type DraftPostWire = z.output<typeof contentDraftPostSchema>

export class DraftRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** A failure's extra fields, such as a taken queue slot's `nextQueueSlot`. */
    readonly details: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'DraftRequestError'
  }
}

/** An account's queued or published post that a schedule would repeat within a day. */
export type DuplicatePost = z.infer<typeof duplicatePostSchema>

/** The posts a `duplicate_content` refusal named, or null for any other failure. */
export function duplicatePosts(error: unknown): DuplicatePost[] | null {
  if (!(error instanceof DraftRequestError) || error.status !== 409) return null
  const parsed = z.array(duplicatePostSchema).min(1).safeParse(error.details.duplicates)
  return parsed.success ? parsed.data : null
}

/** One API call with the session cookie; a failure throws its message and status. */
export async function call<T>(
  path: string,
  init: { body?: unknown; method?: string } = {}
): Promise<T> {
  const response = await fetch(path, {
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
    method: init.method ?? 'GET',
  })
  const body = (await response.json().catch(() => null)) as {
    error?: string
    message?: string
  } | null
  if (!response.ok) {
    throw new DraftRequestError(
      body?.message ?? body?.error ?? `The request failed (${response.status}).`,
      response.status,
      body ?? {}
    )
  }
  return body as T
}

const base = '/api/v1/content-drafts'
const one = (id: string) => `${base}/${encodeURIComponent(id)}`

/** Fields a save writes; `baseVersion` is the version the editor last saw. */
export type DraftSave = {
  collabGeneration?: number
  assetIds?: string[]
  baseVersion: number
  body?: unknown[]
  channelConnectionIds?: string[]
  channelText?: Partial<Record<DraftChannel, string>>
  discussions?: DraftDiscussions
  plainText?: string
  /** An ISO instant, or an empty string to clear it. */
  plannedFor?: string
  status?: 'draft' | 'archived'
  /** Labels (an experiment). */
  tags?: string[]
  title?: string
  /** Write (RFC 025): the draft's structured parts beside the body. */
  article?: DraftWire['article'] & object
  platformVersions?: DraftWire['platformVersions']
  primaryPlatform?: DraftChannel
  target?: DraftWire['target'] & object
}

export const draftsApi = {
  comment: (id: string, input: DraftCommentInput) =>
    call<z.output<typeof draftCommentResultSchema>>(`${one(id)}/comments`, {
      body: input,
      method: 'POST',
    }),
  create: (input: z.input<typeof contentDraftCreateSchema> = {}) =>
    call<DraftWire>(base, { body: input, method: 'POST' }),
  get: (id: string) => call<DraftWire>(one(id)),
  posts: (id: string) => call<{ posts: DraftPostWire[] }>(`${one(id)}/posts`),
  remove: (id: string, expected?: { version: number; calendarVersion: number }) =>
    call<{ deleted: true }>(
      `${one(id)}${expected ? `?version=${expected.version}&calendarVersion=${expected.calendarVersion}` : ''}`,
      { method: 'DELETE' }
    ),
  save: (id: string, input: DraftSave) =>
    call<DraftWire>(one(id), { body: input, method: 'PATCH' }),
  schedule: (id: string, input: z.input<typeof contentDraftScheduleSchema>) =>
    call<{ created: boolean; draft: DraftWire; posts: DraftPostWire[] }>(`${one(id)}/schedule`, {
      body: input,
      method: 'POST',
    }),
  review: (id: string, input: z.input<typeof reviewContentDraftContract.body>) =>
    call<DraftWire>(`${one(id)}/review`, { body: input, method: 'POST' }),
  share: (id: string, enabled: boolean) =>
    call<DraftWire>(`${one(id)}/share`, { body: { enabled }, method: 'PUT' }),
  revisions: (id: string) => call<{ items: RevisionWire[] }>(`${one(id)}/revisions`),
  revision: (id: string, revisionId: string) =>
    call<RevisionWire>(`${one(id)}/revisions/${encodeURIComponent(revisionId)}`),
  linkCard: (url: string) =>
    call<z.output<typeof linkCardSchema>>(`${base}/link-card?${new URLSearchParams({ url })}`),
  settings: () => call<SettingsWire>('/api/v1/content-draft-settings'),
  saveSettings: (input: Partial<SettingsWire>) =>
    call<SettingsWire>('/api/v1/content-draft-settings', { body: input, method: 'PUT' }),
  bestTimes: (socialSetId?: string) =>
    call<{ items: { at: string; reason: string }[] }>(
      `/api/v1/content-draft-queue/best-times${socialSetId ? `?${new URLSearchParams({ socialSetId })}` : ''}`
    ),
  calendar: (from: Date, to: Date) =>
    call<{ items: CalendarPostWire[] }>(
      `/api/v1/content-draft-posts?${new URLSearchParams({ from: from.toISOString(), to: to.toISOString() })}`
    ),
  movePost: (id: string, scheduledFor: Date) =>
    call<{ post: DraftPostWire }>(`/api/v1/content-draft-posts/${encodeURIComponent(id)}/move`, {
      body: { scheduledFor: scheduledFor.toISOString() },
      method: 'POST',
    }),
  swapPosts: (id: string, withId: string) =>
    call<{ posts: DraftPostWire[] }>(`/api/v1/content-draft-posts/${encodeURIComponent(id)}/swap`, {
      body: { withId },
      method: 'POST',
    }),
  publishQueuedPost: (id: string) =>
    call<{ post: DraftPostWire }>(
      `/api/v1/content-draft-posts/${encodeURIComponent(id)}/publish-now`,
      {
        method: 'POST',
      }
    ),
  resumeThread: (id: string) =>
    call<{ post: DraftPostWire }>(`/api/v1/content-draft-posts/${encodeURIComponent(id)}/resume`, {
      method: 'POST',
    }),
  refreshMetrics: (id: string) =>
    call<{ post: DraftPostWire }>(`/api/v1/content-draft-posts/${encodeURIComponent(id)}/metrics`, {
      method: 'POST',
    }),
}

/** A saved point in a draft's history, as the API sends it. */
export type RevisionWire = z.output<typeof contentDraftRevisionSchema>

/** The workspace's drafts settings, as the API sends them. */
export type SettingsWire = z.output<typeof contentDraftSettingsSchema>

/** A draft post on the calendar, as the API sends it. */
export type CalendarPostWire = z.output<typeof calendarPostSchema>
