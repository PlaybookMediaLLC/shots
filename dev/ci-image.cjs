const {setTimeout: delay} = require('node:timers/promises');

// Every image a browser shard loads is built once per run by a producer job
// and handed over as a run-scoped artifact. `image` names one of them; the
// catalog below is the single place that pairs an artifact prefix with the job
// that uploads it, so a workflow step names only the image.
const IMAGES = {
  web: {prefix: 'ci-web', job: 'Build web image', label: 'Web image build'},
  backend: {prefix: 'ci-backend', job: 'Build backend images', label: 'Backend image build'},
  'backend-e2e': {
    prefix: 'ci-backend-e2e',
    job: 'Build backend images',
    label: 'Backend image build',
  },
  collab: {prefix: 'ci-collab', job: 'Build collab image', label: 'Collab image build'},
};

// Setup runs beside the build. Artifacts are scoped to this run and exact SHA;
// a failed-jobs-only rerun may reuse the successful earlier attempt's image.
async function waitForImage({github, context, core, image = 'web', sleep = delay}) {
  const descriptor = IMAGES[image];
  if (!descriptor) {
    throw new Error(`Unknown CI image "${image}". Known images: ${Object.keys(IMAGES).join(', ')}.`);
  }
  const run = {...context.repo, run_id: context.runId, per_page: 100};
  const prefix = `${descriptor.prefix}-${context.sha}-`;
  let completedBuild;
  for (let attempt = 0; attempt < 120; attempt++) {
    const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, run);
    const found = artifacts
      // `ci-backend-` also prefixes `ci-backend-e2e-`; the SHA that follows the
      // prefix keeps the two apart only when the separator is part of the match.
      .filter(artifact => !artifact.expired && artifact.name.startsWith(prefix))
      .sort((a, b) => b.id - a.id)[0];
    if (found) {
      core.setOutput('name', found.name);
      return;
    }
    if (completedBuild) {
      throw new Error(`${descriptor.label} ended as ${completedBuild.conclusion} without an available image artifact.`);
    }
    const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {...run, filter: 'latest'});
    const build = jobs.find(job => job.name === descriptor.job);
    if (build?.status === 'completed') {
      // Upload can finish between the artifact and job queries; read artifacts again.
      completedBuild = build;
      continue;
    }
    await sleep(10_000);
  }
  throw new Error(`Timed out after 20 minutes waiting for the ${image} image artifact.`);
}

module.exports = {IMAGES, waitForImage};
