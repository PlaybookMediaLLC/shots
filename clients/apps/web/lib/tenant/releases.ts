import 'server-only'

import { backendSDK, orNull, withDates } from '@/lib/backend/sdk'
import type { TenantContext } from '@/lib/auth/access'
import type { ReleaseCreateInput, ReleaseUpdateInput } from './schemas'

type CreateReleaseInput = ReleaseCreateInput & { idempotencyKey: string }

export class ReleaseError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404
  ) {
    super(message)
    this.name = 'ReleaseError'
  }
}

/**
 * Create a release brief once per idempotency key. The backend records the
 * release, its outbox event, and the audit entry in one transaction, and
 * rejects a product surface from another workspace.
 */
export async function createRelease(context: TenantContext, input: CreateReleaseInput) {
  if (!input.benefitStatement.trim() && (input.sourceUrls?.length ?? 0) === 0) {
    throw new ReleaseError('Say why it matters, or add a source link the spec can draw on.', 400)
  }
  return backendSDK(context).createRelease(input)
}

export async function listReleases(context: TenantContext, take: number, search?: string) {
  return withDates((await backendSDK(context).listReleases(take, search)).releases)
}

export async function getRelease(context: TenantContext, releaseId: string) {
  return withDates(await orNull(backendSDK(context).getRelease(releaseId)))
}

/**
 * Edit a release brief. Only the brief's own columns change: campaigns,
 * angles, posts, and creative variants that reference the release keep
 * their content, so later generation can be re-run without losing work.
 */
export async function updateRelease(
  context: TenantContext,
  releaseId: string,
  input: ReleaseUpdateInput
) {
  const release = await orNull(backendSDK(context).updateRelease(releaseId, input))
  if (!release) throw new ReleaseError('Release not found.', 404)
  return withDates(release)
}
