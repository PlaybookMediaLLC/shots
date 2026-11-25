import assert from 'node:assert/strict'
import test from 'node:test'
import { isSignInTooOld } from '@/lib/api/access-requirements'
import {
  beginBlueskyConnectionContract,
  completeBlueskyConnectionContract,
} from '@/lib/api/contracts/bluesky-connections'
import { createSocialConnectionAttemptContract } from '@/lib/api/contracts/social-connections'

const now = Date.parse('2026-11-25T12:00:00Z')
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000)

test('a sensitive action needs a sign-in from the last 15 minutes', () => {
  assert.equal(isSignInTooOld(minutesAgo(15), true, now), false)
  assert.equal(isSignInTooOld(minutesAgo(16), true, now), true)
})

test('connecting a channel accepts a sign-in from the last 24 hours', () => {
  assert.equal(isSignInTooOld(minutesAgo(24 * 60), 'connection', now), false)
  assert.equal(isSignInTooOld(minutesAgo(24 * 60 + 1), 'connection', now), true)
  assert.equal(createSocialConnectionAttemptContract.access.sensitive, 'connection')
  assert.equal(beginBlueskyConnectionContract.access.sensitive, 'connection')
  assert.equal(completeBlueskyConnectionContract.access.sensitive, 'connection')
})
