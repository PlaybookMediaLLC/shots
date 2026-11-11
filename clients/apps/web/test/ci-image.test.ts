import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { IMAGES, waitForImage } = require('../../../../dev/ci-image.cjs') as {
  IMAGES: Record<string, { prefix: string; job: string; label: string }>
  waitForImage: (input: object) => Promise<void>
}

type Artifact = { id: number; name: string; expired: boolean }
type Job = { name: string; status: string; conclusion?: string }

function scenario(artifacts: Artifact[][], jobs: Job[], image?: string) {
  let polls = 0
  let sleeps = 0
  let output = ''
  const listArtifacts = Symbol('artifacts')
  const listJobs = Symbol('jobs')
  return {
    result: () => ({ polls, sleeps, output }),
    input: {
      context: { repo: { owner: 'owner', repo: 'shots' }, runId: 42, sha: 'abc' },
      ...(image ? { image } : {}),
      core: {
        setOutput: (key: string, value: string) => {
          assert.equal(key, 'name')
          output = value
        },
      },
      sleep: async (ms: number) => {
        assert.equal(ms, 10_000)
        sleeps++
      },
      github: {
        rest: {
          actions: { listWorkflowRunArtifacts: listArtifacts, listJobsForWorkflowRun: listJobs },
        },
        paginate: async (endpoint: symbol, args: Record<string, unknown>) => {
          assert.equal(args.run_id, 42)
          assert.equal(args.owner, 'owner')
          assert.equal(args.repo, 'shots')
          if (endpoint === listArtifacts) return artifacts[Math.min(polls++, artifacts.length - 1)]
          assert.equal(endpoint, listJobs)
          assert.equal(args.filter, 'latest')
          return jobs
        },
      },
    },
  }
}

test('waits for the same run and SHA while setup overlaps a running build', async () => {
  const run = scenario(
    [[], [{ id: 2, name: 'ci-web-abc-1', expired: false }]],
    [{ name: 'Build web image', status: 'in_progress' }]
  )
  await waitForImage(run.input)
  assert.deepEqual(run.result(), { polls: 2, sleeps: 1, output: 'ci-web-abc-1' })
})

test('failed-job reruns reuse the latest unexpired image for this exact SHA', async () => {
  const run = scenario(
    [
      [
        { id: 5, name: 'ci-web-other-1', expired: false },
        { id: 4, name: 'ci-web-abc-3', expired: true },
        { id: 2, name: 'ci-web-abc-1', expired: false },
        { id: 3, name: 'ci-web-abc-2', expired: false },
      ],
    ],
    []
  )
  await waitForImage(run.input)
  assert.equal(run.result().output, 'ci-web-abc-2')
})

test('upload completing between the artifact and job queries is not a build failure', async () => {
  const run = scenario(
    [[], [{ id: 2, name: 'ci-web-abc-1', expired: false }]],
    [{ name: 'Build web image', status: 'completed', conclusion: 'success' }]
  )
  await waitForImage(run.input)
  assert.deepEqual(run.result(), { polls: 2, sleeps: 0, output: 'ci-web-abc-1' })
})

for (const conclusion of ['failure', 'cancelled', 'skipped', 'success']) {
  test(`a completed ${conclusion} build without its artifact fails immediately`, async () => {
    const run = scenario([[]], [{ name: 'Build web image', status: 'completed', conclusion }])
    await assert.rejects(waitForImage(run.input), /without an available image artifact/)
    assert.equal(run.result().sleeps, 0)
  })
}

test('a missing or stalled producer cannot wait forever', async () => {
  const run = scenario([[]], [])
  await assert.rejects(waitForImage(run.input), /Timed out after 20 minutes/)
  assert.equal(run.result().polls, 120)
})

test('API errors propagate instead of masquerading as a pending build', async () => {
  const run = scenario([[]], [])
  run.input.github.paginate = async () => {
    throw new Error('API unavailable')
  }
  await assert.rejects(waitForImage(run.input), /API unavailable/)
})

test('each image waits on its own producer job and artifact prefix', async () => {
  for (const [image, descriptor] of Object.entries(IMAGES)) {
    const run = scenario(
      [[], [{ id: 2, name: `${descriptor.prefix}-abc-1`, expired: false }]],
      [{ name: descriptor.job, status: 'in_progress' }],
      image
    )
    await waitForImage(run.input)
    assert.equal(run.result().output, `${descriptor.prefix}-abc-1`)
  }
})

// `ci-backend-` is a prefix of `ci-backend-e2e-`; only the SHA separator keeps
// a shard from loading the e2e-tagged backend as the production one.
test('the backend image never matches the e2e-tagged backend artifact', async () => {
  const run = scenario(
    [
      [{ id: 9, name: 'ci-backend-e2e-abc-1', expired: false }],
      [{ id: 2, name: 'ci-backend-abc-1', expired: false }],
    ],
    [{ name: IMAGES.backend.job, status: 'in_progress' }],
    'backend'
  )
  await waitForImage(run.input)
  assert.equal(run.result().output, 'ci-backend-abc-1')
})

test('an unknown image name fails instead of waiting for a job that never runs', async () => {
  const run = scenario([[]], [], 'nope')
  await assert.rejects(waitForImage(run.input), /Unknown CI image "nope"/)
})

// The loader reads one fixed file name; a producer that uploads any other name
// hands every consumer an artifact it downloads and then cannot load.
test('every image artifact holds the image.tar.gz the loader reads', () => {
  const workflow = readFileSync('../../../.github/workflows/ci.yml', 'utf8')
  const loader = readFileSync('../../../.github/actions/load-ci-image/action.yml', 'utf8')
  assert.match(loader, /docker load --input "\$IMAGE_DIR\/image\.tar\.gz"/)
  for (const { prefix } of Object.values(IMAGES)) {
    const upload = workflow.match(
      new RegExp(`name: ${prefix}-\\$\\{\\{ github\\.sha \\}\\}.*\\n\\s+path: (.+)`)
    )
    assert.ok(upload, `no upload step names the ${prefix} artifact`)
    assert.match(upload[1]!, /\/image\.tar\.gz$/, `${prefix} uploads ${upload[1]}`)
  }
})
