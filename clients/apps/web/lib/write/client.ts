import type { z } from 'zod'
import type { draftFinisherSchema, draftTagSchema } from '@/lib/api/contracts/draft-tags'
import type { CalendarPlacement, CalendarResultWire } from '@/lib/api/contracts/plan-analyze'
import type {
  engagementSchema,
  socialSetListSchema,
  socialSetSchema,
} from '@/lib/api/contracts/social-sets'
import type {
  draftActivitySchema,
  draftCopyResultSchema,
  draftPropertiesInputSchema,
} from '@/lib/api/contracts/write'
import { call, type DraftPostWire, type DraftWire } from '@/lib/content-drafts/client'

/**
 * Browser calls to the Write API (RFC 025) with the session cookie: a set's
 * engagement defaults, tags and finishers, and a draft's properties, plan, copies,
 * backups, activity and recovery. Failures throw `DraftRequestError`.
 */

/** A social set as the API sends it. */
export type SocialSetWire = z.output<typeof socialSetSchema>

/** The sets you can see, with their connected accounts, as the API sends them. */
export type SocialSetListWire = z.output<typeof socialSetListSchema>

/** A set's tag as the API sends it. */
export type DraftTagWire = z.output<typeof draftTagSchema>

/** A set's thread finisher as the API sends it. */
export type DraftFinisherWire = z.output<typeof draftFinisherSchema>

/** One event in a draft's history as the API sends it. */
export type DraftActivityWire = z.output<typeof draftActivitySchema>

/** A new draft and what its destination could not take. */
export type DraftCopyWire = z.output<typeof draftCopyResultSchema>

const set = (id: string) => `/api/v1/social-sets/${encodeURIComponent(id)}`
const draft = (id: string) => `/api/v1/content-drafts/${encodeURIComponent(id)}`
const post = (id: string) => `/api/v1/content-draft-posts/${encodeURIComponent(id)}`

/** The Write API. */
export const writeApi = {
  /** The sets you can write in and the accounts each one posts from. */
  sets: () => call<SocialSetListWire>('/api/v1/social-sets'),
  /** Search communities without exposing the connection's credentials to the browser. */
  communities: (setId: string, query: string) =>
    call<{ items: { id: string; name: string }[] }>(
      `/api/v1/social-sets/${encodeURIComponent(setId)}/communities?${new URLSearchParams({ q: query })}`
    ),
  /** The boards of the set's Pinterest account, read with its own authorization. */
  pinterestBoards: (setId: string) => call<unknown>(`${set(setId)}/pinterest-boards`),
  /** A set's engagement defaults (RFC 024), based on the set's version. */
  updateSetEngagement: (
    id: string,
    baseVersion: number,
    engagementDefaults: z.input<typeof engagementSchema>
  ) => call<SocialSetWire>(set(id), { body: { baseVersion, engagementDefaults }, method: 'PATCH' }),
  tags: (setId: string) => call<{ items: DraftTagWire[] }>(`${set(setId)}/tags`),
  createTag: (setId: string, input: { color?: DraftTagWire['color']; name: string }) =>
    call<DraftTagWire>(`${set(setId)}/tags`, { body: input, method: 'POST' }),
  updateTag: (
    setId: string,
    tagId: string,
    input: { color?: DraftTagWire['color']; name?: string }
  ) =>
    call<DraftTagWire>(`${set(setId)}/tags/${encodeURIComponent(tagId)}`, {
      body: input,
      method: 'PATCH',
    }),
  deleteTag: (setId: string, tagId: string) =>
    call<{ deleted: true }>(`${set(setId)}/tags/${encodeURIComponent(tagId)}`, {
      method: 'DELETE',
    }),
  finishers: (setId: string) => call<{ items: DraftFinisherWire[] }>(`${set(setId)}/finishers`),
  createFinisher: (
    setId: string,
    input: { name: string; quoteFirstPost?: boolean; text: string }
  ) => call<DraftFinisherWire>(`${set(setId)}/finishers`, { body: input, method: 'POST' }),
  updateFinisher: (
    setId: string,
    finisherId: string,
    input: { name?: string; quoteFirstPost?: boolean; text?: string }
  ) =>
    call<DraftFinisherWire>(`${set(setId)}/finishers/${encodeURIComponent(finisherId)}`, {
      body: input,
      method: 'PATCH',
    }),
  deleteFinisher: (setId: string, finisherId: string) =>
    call<{ deleted: true }>(`${set(setId)}/finishers/${encodeURIComponent(finisherId)}`, {
      method: 'DELETE',
    }),
  properties: (id: string, input: z.input<typeof draftPropertiesInputSchema>) =>
    call<DraftWire>(`${draft(id)}/properties`, { body: input, method: 'PATCH' }),
  plan: (
    id: string,
    input: { baseCalendarVersion: number; plannedFor: string | null; timeZone?: string }
  ) => call<DraftWire>(`${draft(id)}/plan`, { body: input, method: 'POST' }),
  /**
   * Unschedule a draft as the Calendar does: one step cancels every queued
   * post, and the draft keeps their time as its plan.
   */
  unschedule: (placement: CalendarPlacement) =>
    call<CalendarResultWire>('/api/v1/calendar/mutations', {
      body: { action: 'unschedule', items: [placement], key: crypto.randomUUID() },
      method: 'POST',
    }),
  duplicate: (id: string, requestKey?: string) =>
    call<DraftCopyWire>(
      `${draft(id)}/duplicate${requestKey ? `?requestKey=${encodeURIComponent(requestKey)}` : ''}`,
      { method: 'POST' }
    ),
  copy: (id: string, input: { socialSetId: string; tagMode: 'match' | 'drop' }) =>
    call<DraftCopyWire>(`${draft(id)}/copy`, { body: input, method: 'POST' }),
  recover: (id: string, revisionId: string) =>
    call<DraftCopyWire>(`${draft(id)}/revisions/${encodeURIComponent(revisionId)}/recover`, {
      method: 'POST',
    }),
  activity: (id: string, cursor?: string) =>
    call<{ items: DraftActivityWire[]; nextCursor: string | null }>(
      `${draft(id)}/activity${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`
    ),
  retryPost: (id: string) => call<{ post: DraftPostWire }>(`${post(id)}/retry`, { method: 'POST' }),
  cancelAutomations: (id: string) =>
    call<{ post: DraftPostWire }>(`${post(id)}/automations/cancel`, { method: 'POST' }),
  reconcilePost: (id: string, input: { live: boolean; url?: string }) =>
    call<{ post: DraftPostWire }>(`${post(id)}/reconcile`, { body: input, method: 'POST' }),
}
