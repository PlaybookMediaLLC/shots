# Branching and releases

The branch flow is:

```text
feature / fix / dependency / upstream / release-preparation branch
  -> pull request -> develop
  -> intentional release pull request -> main
  -> production deployment and versioned GitHub release
```

`develop` is the integration branch and the intended repository default.
`main` contains released work. Keep both branches. All ordinary PRs target
`develop`; only this repository's `develop` may target `main`. A branch named
develop in a fork does not qualify as a release source.

The `Branch policy` workflow checks PR metadata without checking out PR code.
CI validates PRs into both branches and pushes to both. Production web/backend
images and npm SDK publishing remain restricted to `main`.

## Repository configuration

Create `develop` from the current `main` before switching the default branch.
The initial develop branch was created at main commit `e59aef07` on 2026-10-24.
Apply the checked-in rules with a GitHub identity/token that has repository
Administration write access:

```sh
bash .github/rulesets/apply.sh
```

The script sets the default branch to develop and idempotently creates or
updates the named [develop](../.github/rulesets/develop.json) and
[main](../.github/rulesets/main.json) rulesets. It preserves unrelated rulesets.
Both branches require PRs, resolved review conversations, and the Branch policy
and CI validation checks. `CI validation` is the single gate for everything CI
runs: it names every job, asserts each result, and accepts a skip only for the
reason the `Plan` job recorded (see [the CI pipeline](ci.md)). Main used to
require the browser shards by name as well, `integration (1/3)` to
`integration (3/3)`; those contexts are gone, because the shard count now comes
from the measured duration manifest and a release PR may legitimately reuse the
suite the push to develop already ran on the same commit. Develop requires an up-to-date work branch. Main uses
checks on the release merge candidate without requiring a back-merge of its
previous release-only merge commit into develop. Force pushes and branch
deletion are prohibited. No bypass actors or new approval-count requirement
are introduced. Main accepts merge commits only; work PRs may use squash,
merge or rebase. Squash is the normal choice for a single work change.

These files describe the required settings; committing them does not install
GitHub rules. Confirm both rulesets are active and the default branch is
develop in repository Settings. If the integration returns HTTP 403, apply
them with an administrator-capable login. Until required checks are installed,
the policy check reports violations but cannot itself prevent a manual merge.
The workflow files must be present in the PR being validated before requiring
their check contexts. Scheduled upstream sync runs from the default branch.

After switching the default, review open PRs: retarget ordinary PRs to develop
and rerun checks after any base change. Do not automatically merge unrelated
or failing PRs. The release flow does not turn outstanding PRs into approvals.

## Daily work

```sh
git fetch origin
git switch -c feat/your-change origin/develop
# implement, test, commit and push the work branch
gh pr create --base develop
```

Use Conventional Commit titles/messages. After checks and review, merge into
develop. Upstream synchronization follows the same path. Fixes also enter
develop first; promote an urgent fix through a deliberate release PR.

## Prepare and release

1. Release Please runs on develop and prepares a version/changelog PR targeting
   develop. It never tags or publishes from develop, and does not auto-merge
   that PR. Review and merge the preparation PR normally.
2. A prepared version pauses additional preparation until that version is
   published. To explicitly choose a version, dispatch Release Please on
   develop with the optional release_as input. A GITHUB_TOKEN-created PR may
   need a human close/reopen to trigger CI if RELEASE_PLEASE_TOKEN is unset.
3. Open the release PR explicitly:

   ```sh
   gh pr create --base main --head develop --title "chore(release): promote develop"
   ```

4. Review the whole release diff and checks. Resolve conflicts on develop so
   the resulting main tree exactly matches the reviewed develop tree. Merge
   using **Create a merge commit**, never squash/rebase. Keep develop.
5. Main's production workflows deploy changed components. Its release job
   publishes the prepared version using the corresponding CHANGELOG section.
   Verify deployment health and release results separately: a tag is not a
   claim that the production deployment succeeded.

The tag pins the immutable develop commit promoted by the main merge, with
the identical file tree. This keeps the tag discoverable by Release Please on
develop and prevents later develop commits from entering an earlier release.
The publisher verifies the originating release PR, merge ancestry and tree.
It rejects direct-main commits, squash promotions, version regressions and
conflicting tags. It clears pending labels only on preparation PRs included
in the tagged history; interruption can be retried without moving an existing
tag or publishing a second release.

A promotion with an already published version does not create another GitHub
release (for example, documentation-only work). Existing production path
filters still decide whether components need deploying. New application
versions should be prepared before promotion. If publication fails after
promotion, rerun the failed workflow for that exact main commit; never retag
it using today's moving develop head. Do not delete release tags to recover.

### Deploy order and rollbacks

The backend owns migrations and the API, so `web-image.yml` deploys the web
only after the same commit's backend deploy succeeds. Changes keep both
directions working during a rollout: a new backend accepts what the previous
web sends, and the new web sends a new request field only when it is used
(the Go API refuses unknown JSON fields, so an older backend would answer
400). Some changes cannot work against an older backend; for those, **roll
back the web before the backend**:

- `POST /api/v1/scheduled-posts` without `Idempotency-Key`: the web forwards
  an empty key for the backend to derive one from the content; an older
  backend requires the key.
- Drafts made from a release (`releaseId`) and a confirmed repeat post
  (`confirmDuplicate`): an older backend does not know the fields.
- The brand voice in `GET /v1/launch/brand` (`voice`): an older backend does
  not send it, so AI surfaces outside a social set write with no brand voice,
  and nothing reports it.

During a rollout the previous web cannot confirm a repeated post: the new
backend refuses it with its reason until the new web is live.

Merging a work PR into develop does not authorize a production release. The
develop-to-main promotion remains an explicit release decision.
