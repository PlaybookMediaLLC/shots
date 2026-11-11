import assert from 'node:assert/strict'
import test from 'node:test'
import {
  releaseCaptionNotes,
  releaseClaimsNote,
  releaseSummary,
} from '@/lib/launch/release-summary'
import type { SpecSource } from '@/lib/launch/spec-schema'

const source = (id: string, overrides: Partial<SpecSource> = {}): SpecSource => ({
  excerpt: '',
  fetchedAt: '2026-11-01T00:00:00Z',
  flagged: false,
  flags: [],
  id,
  kind: 'release',
  sections: [],
  status: 'ok',
  statusReason: '',
  title: 'Release notes',
  url: 'https://example.com/releases/1',
  ...overrides,
})

const text = 'Named views ship to every plan.'
const spec = (approvedAt: Date | null, sources: SpecSource[], refs = ['s1'], summary = text) => ({
  approvedAt,
  content: { summary: { sources: refs, text: summary } },
  sources,
})

test('a release with no spec is written from its brief, which a person wrote', () => {
  assert.deepEqual(releaseSummary({ benefitStatement: ' Faster exports. ', spec: null }), {
    source: 'release',
    text: 'Faster exports.',
    verified: true,
  })
})

test('a release with nothing written yet has no summary to write from', () => {
  assert.equal(releaseSummary({ benefitStatement: '  ', spec: null }), null)
  assert.equal(
    releaseSummary({ benefitStatement: 'Faster exports.', spec: spec(null, [], [], ' ') }),
    null
  )
})

test('an approved spec on readable sources is verified', () => {
  const summary = releaseSummary({
    benefitStatement: 'Faster exports.',
    spec: spec(new Date('2026-11-02T00:00:00Z'), [source('s1')], ['brief', 's1']),
  })
  assert.deepEqual(summary, { source: 'spec', text, verified: true })
  assert.equal(releaseClaimsNote(summary), '')
  assert.equal(releaseCaptionNotes(summary!), `Write from this release summary: ${text}`)
})

test('a summary no one approved, or resting on a bad source, stays unverified', () => {
  const approved = new Date('2026-11-02T00:00:00Z')
  for (const input of [
    spec(null, [source('s1')]),
    spec(approved, [source('s1', { status: 'failed' })]),
    spec(approved, [source('s1', { flagged: true, flags: ['instruction'] })]),
    // A citation to a source the spec does not carry cannot be checked.
    spec(approved, []),
  ]) {
    const summary = releaseSummary({ benefitStatement: 'Faster exports.', spec: input })
    assert.deepEqual(summary, { source: 'spec', text, verified: false })
    // The draft lists it to check, and the writer is told not to go beyond it.
    assert.equal(releaseClaimsNote(summary), `Claims to verify before approval:\n- ${text}`)
    assert.match(releaseCaptionNotes(summary!), /No person has verified it yet: state nothing/)
    assert.ok(releaseCaptionNotes(summary!).endsWith(text))
  }
})

test('a summary longer than the notes is cut at a word, never inside one', () => {
  const long = `${'Exports run 45% faster on large projects. '.repeat(30)}Final`
  const notes = releaseCaptionNotes({ source: 'spec', text: long, verified: true })
  assert.ok(notes.length <= 1_000)
  assert.ok(notes.endsWith('…'))
  assert.match(notes, /(?:faster|projects\.|large|on|Exports|run|45%)…$/)
})
