import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeManifest, totalsByFile } from '../scripts/e2e-shard-manifest.mjs'

const report = {
  suites: [
    {
      specs: [
        {
          file: 'test/e2e/a.spec.ts',
          tests: [{ status: 'expected', results: [{ duration: 1000 }] }],
        },
      ],
      suites: [
        {
          specs: [
            {
              file: 'test/e2e/a.spec.ts',
              // A flake costs the shard both attempts.
              tests: [{ status: 'flaky', results: [{ duration: 500 }, { duration: 400 }] }],
            },
            {
              file: 'test/e2e/b.spec.ts',
              tests: [
                { status: 'skipped', results: [{ duration: 5 }] },
                { status: 'expected', results: [{ duration: 2000 }] },
              ],
            },
          ],
        },
      ],
    },
  ],
}

test('a spec costs the sum of its tests, retries included, across nested suites', () => {
  assert.deepEqual(totalsByFile([report]), {
    'test/e2e/a.spec.ts': 1900,
    'test/e2e/b.spec.ts': 2000,
  })
})

test('shard reports are summed, so one manifest covers the whole run', () => {
  assert.deepEqual(totalsByFile([report, report]), {
    'test/e2e/a.spec.ts': 3800,
    'test/e2e/b.spec.ts': 4000,
  })
})

test('a first measurement is taken as-is and later ones are smoothed', () => {
  const first = mergeManifest(null, { 'test/e2e/a.spec.ts': 1000 })
  assert.equal(first.specs['test/e2e/a.spec.ts'], 1000)
  const second = mergeManifest(first, { 'test/e2e/a.spec.ts': 2000 })
  assert.equal(second.specs['test/e2e/a.spec.ts'], 1400)
})

test('a deleted spec leaves the manifest instead of keeping a shard reserved', () => {
  const previous = mergeManifest(null, { 'test/e2e/gone.spec.ts': 1000, 'test/e2e/a.spec.ts': 10 })
  const next = mergeManifest(previous, { 'test/e2e/a.spec.ts': 10 })
  assert.deepEqual(Object.keys(next.specs), ['test/e2e/a.spec.ts'])
})
