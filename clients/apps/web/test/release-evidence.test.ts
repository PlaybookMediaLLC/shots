import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { z } from 'zod'
import { createReleaseEvidenceSchema, saveReleaseClaimSchema } from 'screenshot-studio-backend-sdk'
import { canonicalJson } from '@/lib/design/canonical-json'

test('readiness canonical bytes and hashes agree with Go for manifest values', () => {
  const vectors = z
    .array(
      z.object({ raw: z.string(), canonical: z.string(), domain: z.string(), sha256: z.string() })
    )
    .parse(
      JSON.parse(
        readFileSync('../../../server/internal/releasefacts/testdata/canonical.json', 'utf8')
      )
    )
  for (const vector of vectors) {
    const canonical = canonicalJson(JSON.parse(vector.raw))
    assert.equal(canonical, vector.canonical)
    assert.equal(
      createHash('sha256').update(`${vector.domain}\n${canonical}`).digest('hex'),
      vector.sha256
    )
  }
})

test('claim boundaries reject malformed Unicode and count UTF-8 bytes', () => {
  const input = {
    expectedRevision: '0',
    text: 'Valid claim',
    origin: 'HUMAN',
    qualifiers: { audience: '', availability: '', eligibility: '', limitations: '' },
  }
  assert.equal(saveReleaseClaimSchema.safeParse(input).success, true)
  for (const text of ['\ud800', '\udc00', 'x\0y', 'é'.repeat(2049)])
    assert.equal(saveReleaseClaimSchema.safeParse({ ...input, text }).success, false)
  assert.equal(saveReleaseClaimSchema.safeParse({ ...input, text: 'é'.repeat(2048) }).success, true)
  assert.equal(saveReleaseClaimSchema.safeParse({ ...input, expectedRevision: 1 }).success, false)
})

test('replacing evidence requires the exact source sequence and bounded retained text', () => {
  const input = {
    expectedRevision: '0',
    kind: 'TEXT',
    origin: 'HUMAN',
    text: 'Retained text',
    purpose: 'Factual review',
    observedAt: '2026-11-20T12:00:00Z',
  }
  assert.equal(createReleaseEvidenceSchema.safeParse(input).success, true)
  assert.equal(
    createReleaseEvidenceSchema.safeParse({ ...input, sourceId: 'source' }).success,
    false
  )
  assert.equal(
    createReleaseEvidenceSchema.safeParse({
      ...input,
      sourceId: 'source',
      expectedSourceSequence: '1',
    }).success,
    true
  )
  assert.equal(
    createReleaseEvidenceSchema.safeParse({ ...input, text: 'é'.repeat(131073) }).success,
    false
  )
  assert.equal(createReleaseEvidenceSchema.safeParse({ ...input, unexpected: true }).success, false)
})
