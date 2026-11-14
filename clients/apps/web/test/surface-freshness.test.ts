import assert from 'node:assert/strict'
import test from 'node:test'
import { captureFailureMessage, surfaceFreshness } from '@/lib/tenant/surface-freshness'

const now = new Date('2026-10-16T12:00:00Z')
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString()

test('a surface is fresh under 30 days, stale after, and never without a capture', () => {
  assert.equal(surfaceFreshness(null, now), 'never')
  assert.equal(surfaceFreshness(daysAgo(0), now), 'fresh')
  assert.equal(surfaceFreshness(daysAgo(29.9), now), 'fresh')
  assert.equal(surfaceFreshness(daysAgo(30), now), 'stale')
  assert.equal(surfaceFreshness(new Date(daysAgo(90)), now), 'stale')
})

test('capture failure codes read as sentences, unknown ones included', () => {
  assert.equal(captureFailureMessage('capture_failed'), 'The page could not be captured.')
  assert.equal(
    captureFailureMessage('asset_unavailable'),
    'The screenshot was taken but could not be stored.'
  )
  assert.equal(captureFailureMessage('new_code'), 'The last capture failed (new code).')
  // Not a prototype key.
  assert.match(captureFailureMessage('toString'), /^The last capture failed/)
})

test('every safe code from signed-in capture has its own sentence', () => {
  for (const code of [
    'needs_auth',
    'sign_in_incomplete',
    'session_restore_failed',
    'wrong_account',
    'waiting_for_deployment',
    'deployment_unverified',
    'marker_missing',
    'forbidden_view',
    'mask_missing',
    'origin_refused',
    'recipe_invalid',
    'image_invalid',
    'page_failed',
    'provider_unavailable',
    'connection_missing',
    'connection_revoked',
    'connect_expired',
    'stale_authorization',
    'deadline_exceeded',
    'cancelled',
    'source_inactive',
    'recipe_archived',
    'recipe_missing',
    'surface_missing',
    'deployment_missing',
    'workspace_unavailable',
  ]) {
    assert.doesNotMatch(captureFailureMessage(code), /last capture failed|_/, code)
  }
})
