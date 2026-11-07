import assert from 'node:assert/strict'
import test from 'node:test'
import { campaignPublishDraftSchema } from '@/lib/tenant/campaign-publish-draft'
import {
  campaignCreateSchema,
  productSurfaceUpdateSchema,
  releaseCreateSchema,
  releaseUpdateSchema,
} from '@/lib/tenant/schemas'

const release = { benefitStatement: 'Invoices send themselves.', title: 'Recurring invoices' }

test('release briefs reject markup and non-web source links', () => {
  assert.equal(releaseCreateSchema.safeParse(release).success, true)
  assert.equal(
    releaseCreateSchema.safeParse({ ...release, description: 'Use <script>alert(1)</script>' })
      .success,
    false
  )
  assert.equal(
    releaseCreateSchema.safeParse({ ...release, description: 'Faster: 2 < 3 and 5 > 4' }).success,
    true
  )
  assert.equal(
    releaseCreateSchema.safeParse({ ...release, sourceUrls: ['javascript:alert(1)'] }).success,
    false
  )
  assert.equal(
    releaseCreateSchema.safeParse({ ...release, sourceUrls: ['https://example.com/changelog'] })
      .success,
    true
  )
})

test('draft campaigns accept no angles or posts and optional release context', () => {
  const parsed = campaignCreateSchema.parse({ name: 'Launch', objective: 'Announce' })
  assert.deepEqual(parsed.angles, [])
  assert.deepEqual(parsed.posts, [])
  assert.equal(
    campaignCreateSchema.safeParse({ name: 'L', objective: 'A', releaseId: 'not-a-uuid' }).success,
    false
  )
})

test('partial updates do not reset omitted fields to their create defaults', () => {
  assert.deepEqual(productSurfaceUpdateSchema.parse({ name: 'Renamed' }), { name: 'Renamed' })
  assert.deepEqual(releaseUpdateSchema.parse({ title: 'Renamed' }), { title: 'Renamed' })
  assert.deepEqual(releaseUpdateSchema.parse({ description: null }), { description: null })
})

test('a campaign publish draft needs a real campaign, asset and draft', () => {
  const handoff = {
    campaignId: 'clf0f1a2c3d4e5f6g7h8',
    assetId: '0f1e2d3c-4b5a-4968-8778-66554433221f',
    draft: { assetIds: ['0f1e2d3c-4b5a-4968-8778-66554433221f'], body: [] },
  }
  assert.equal(campaignPublishDraftSchema.safeParse(handoff).success, true)
  // The campaign post the copy came from is optional, but must look like one.
  assert.equal(
    campaignPublishDraftSchema.safeParse({ ...handoff, campaignPostId: 'nope' }).success,
    false
  )
  assert.equal(campaignPublishDraftSchema.safeParse({ ...handoff, assetId: 'nope' }).success, false)
  assert.equal(
    campaignPublishDraftSchema.safeParse({ ...handoff, campaignId: 'nope' }).success,
    false
  )
  // The draft keeps the composer's own shape, including its retry key.
  const parsed = campaignPublishDraftSchema.parse({
    ...handoff,
    draft: { ...handoff.draft, requestKey: '0f1e2d3c-4b5a-4968-8778-66554433221f' },
  })
  assert.equal(parsed.draft.requestKey, '0f1e2d3c-4b5a-4968-8778-66554433221f')
})
