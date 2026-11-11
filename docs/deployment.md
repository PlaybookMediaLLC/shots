# Deployment

Production runs on DigitalOcean App Platform at `shots.playbookmedia.io`
(`shots.oppulence.io` redirects there; see `lib/canonical-host.ts`). The
[DigitalOcean deployment guide](digitalocean-deployment.md) documents the live
components, secrets, migration jobs, health checks, and release procedure.

The web and combined backend images are built on GitHub and stored in the
public GitHub Container Registry package. App Platform selects each image with
a unique commit SHA tag. The backend
container runs the social API, social Temporal worker,
tenant publishing worker, and six maintenance schedules as one service.

The `Web image` and `Social backend image` GitHub workflows publish their
respective images when relevant code lands on `main`. Their manual `deploy`
inputs load production secrets from Infisical using GitHub OIDC, validate the
live app topology, and update the corresponding App Platform components.
Deploy the backend before the web: its image carries the schema migrations, and
the web deploy refuses a topology that still has `web-migrate`. The Fly
deployment workflow and configuration have been removed.

All work PRs target `develop`. Release Please reads its Conventional Commits
and opens version/changelog PRs into `develop`, without publishing a release.
An intentional `develop` → `main` PR releases those changes. Use a merge commit
to preserve ancestry. The promotion publishes the prepared GitHub Release and
triggers the existing production workflows; `develop` never deploys production.
The `RELEASE_PLEASE_TOKEN` secret lets generated preparation PRs trigger CI;
without it, a human must reopen the generated PR to start checks. See
[branching and releases](branching-and-releases.md) for repository rules,
tag behavior and the complete procedure.

App Platform runs one `platform-migrate` predeploy job from the backend image.
It applies product and social migrations to the same PostgreSQL database and
`public` schema. The web has no database connection. Review the migration
sources in `server/platformmigrations/sql` and
`server/internal/social/migrations` and the
database backup before changing the backend image.

For a local web image smoke test:

```sh
docker build -t screenshot-studio .
docker run --rm -p 3000:3000 screenshot-studio
curl --fail http://localhost:3000/api/health
```

## Restoring the database

PlanetScale restores production to any moment in the last two days
([DigitalOcean guide](digitalocean-deployment.md#releases)). A restore rolls
back the database only. Temporal keeps every post workflow that ran after the
restore point, so a post the database has forgotten could be sent again, and
R2 has already lost the bytes of everything deleted since. Follow the steps in
order and keep publishing paused until step 5. `T` below is the restore point
in UTC, written as RFC 3339 (`2026-11-10T12:00:00Z`).

1. **Pause publishing and maintenance.**
   - Add `TENANT_PUBLISHING_PAUSED=true` as a plain (not secret) variable on
     `screenshot-studio-backend` in App Platform. While it is set, the first
     step of every post workflow (`PreparePostPublication`) fails before it
     claims the post: nothing reaches a provider, the post stays `SCHEDULED`,
     and its workflow closes as failed after three tries. The pause is an
     environment variable rather than a database setting because the database
     is what is being restored. The cost is a redeploy of the backend to set
     it and another to clear it, a few minutes each; backend deploys from the
     `Social backend image` workflow keep it. Locally the variable is
     `PUBLISHING_PAUSED=true` on the product worker.
   - Pause every maintenance schedule in `screenshot-studio-publishing.kpisa`
     (`temporal schedule list` shows the `platform-maintenance-*` IDs):
     `temporal schedule toggle --schedule-id <id> --pause --reason "database restore"`.
     Restarts keep the pause.
   - Wait for sends that started before the pause:
     `SELECT id FROM scheduled_post WHERE status = 'PROCESSING'` returns no
     rows once they finish, within the publishing activity timeout.
2. **Restore** `T` to a new branch (Backups > Restore to new branch) and
   point the database URLs at it, as for a bad migration.
3. **Reconcile posts from Temporal.** List the post workflows that were
   running at `T` or started since, with their typed search attributes:

   ```sh
   temporal workflow list --namespace screenshot-studio-publishing.kpisa -o json \
     --query "WorkflowType IN ('PostWorkflowV1', 'PostWorkflowV2') AND (ExecutionStatus = 'Running' OR CloseTime >= '$T')"
   ```

   Each one carries `organizationId` and `postId`; add
   `AND organizationId = '<workspace>'` to work through one workspace at a
   time. The workflow ID is `post_<postId>`. For each, read its history
   (`temporal workflow show --workflow-id post_<postId> --run-id <runId> -o json`)
   and the restored row (`SELECT status, "remotePostId" FROM scheduled_post WHERE id = '<postId>'`):

   - **A provider receipt**: the result has `"Outcome": "PUBLISHED"` and a
     `ProviderID`, or a `CompletePostPublication` activity carries one (the
     worker log's `provider accepted publication` line names it too). If the
     row is not `PUBLISHED`, write it:
     `UPDATE scheduled_post SET status = 'PUBLISHED', "publishedAt" = '<time of the receipt>', "remotePostId" = '<ProviderID>' WHERE id = '<postId>' AND status <> 'PUBLISHED';`
   - **Sending began without a receipt**: a `SubmitPost` (V1: `PublishPost`)
     activity was scheduled and no receipt followed. If the row is
     `SCHEDULED` or `PROCESSING`, mark it for the workspace to check with the
     existing Needs check control:
     `UPDATE scheduled_post SET status = 'UNKNOWN_DELIVERY', "failureCode" = 'UNKNOWN_DELIVERY' WHERE id = '<postId>' AND status IN ('SCHEDULED', 'PROCESSING');`
   - **Cancelled after `T`**: the result is `"Outcome": "CANCELLED"` but the
     row is `SCHEDULED` again. Cancel it again, or it publishes in step 5.
   - **Held by the pause**: only `PreparePostPublication` ran, failing with
     `publishing is paused`. Nothing was sent; leave it.
   - **No row**: the post was created after `T`. Terminate a running workflow
     (`temporal workflow terminate --workflow-id post_<postId> --reason "database restored"`)
     and send the workspace owner the list of these posts, with any receipt.

   Other changes people made after `T` are lost; only deletions are replayed.
4. **Replay the deletion ledger.** Before it removes an asset's bytes, the
   outbox writes the deletion to R2 at
   `deletion-ledger/YYYY/MM/DD/<outbox event ID>.json`, under the day the
   deletion was requested. An entry holds IDs only: kind, workspace, asset,
   event and request time. Against the restored database, from `server/`:

   ```sh
   DATABASE_URL=... R2_ENDPOINT=... R2_BUCKET_NAME=screenshot-studio \
   R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \
     go run ./cmd/deletion-ledger-replay -since "$T"
   ```

   Each asset deleted after `T` becomes `DELETED` again, with an
   `asset.deleted` outbox event and an audit entry; the command prints how
   many entries it read and how many records it deleted again. A second run
   changes nothing. Bytes still in R2 go once the outbox schedule resumes.
5. **Resume.** Remove `TENANT_PUBLISHING_PAUSED` (a redeploy), then unpause
   the schedules (`temporal schedule toggle --schedule-id <id> --unpause`).
   The `scheduled-posts` job starts the held posts again. One due less than
   an hour ago publishes late; one more overdue fails as `MISSED_WINDOW`
   (`temporalpublishing.LatePublicationWindow`) and is never sent late, so
   its workspace publishes or reschedules it by hand.

Limits:

- A deletion requested in the last minute or so before `T` may be missing
  from the ledger if the outbox had not run yet. Its bytes are then still in
  R2, so nothing is inconsistent, but the deletion is lost: ask the
  workspace to delete it again.
- The ledger records asset deletions. A workspace or account purge that ran
  after `T` runs again from its restored request once maintenance resumes; a
  workspace or account deletion requested after `T` is lost and must be
  requested again.
- The pause stops posts, not the follow-ups (reposts, plugs) of posts that
  are already live.
- Ledger entries matter only within the two-day restore window and are never
  deleted by the app; an R2 lifecycle rule may expire `deletion-ledger/`
  after 30 days.
- Run this procedure once on staging before a release that depends on it,
  and again after any change to publishing: publish a post, delete an asset,
  restore to before both, and check that the post shows as published, is not
  sent again, and the asset is deleted.

### Rotating webhook secrets

The web verifies GitHub App deliveries with `GITHUB_APP_WEBHOOK_SECRET`.
Sources without an operator-managed secret sign with a secret derived from
`SOURCE_WEBHOOK_SIGNING_KEY`. Each has an optional `_PREVIOUS` twin,
`GITHUB_APP_WEBHOOK_SECRET_PREVIOUS` and
`SOURCE_WEBHOOK_SIGNING_KEY_PREVIOUS`: a delivery is checked against the
current value, then the previous one, both in constant time. To rotate the
GitHub App secret:

1. In Infisical, set `GITHUB_APP_WEBHOOK_SECRET_PREVIOUS` to the current
   secret and `GITHUB_APP_WEBHOOK_SECRET` to a new one
   (`openssl rand -hex 32`). Add `GITHUB_APP_WEBHOOK_SECRET_PREVIOUS` to the
   `web` component as a secret variable too: the web deploy refreshes only
   the secrets the component already names.
2. Deploy the web (`Web image`, `deploy=true`).
3. Set the new secret in the GitHub App's webhook settings. Deliveries signed
   with either secret are accepted meanwhile.
4. A day later, delete `GITHUB_APP_WEBHOOK_SECRET_PREVIOUS` from the `web`
   component, then from Infisical, and deploy the web. Keep that order: a web
   deploy fails while the component names a secret Infisical lacks.

`SOURCE_WEBHOOK_SIGNING_KEY` rotates the same way, with a new key of at least
32 characters. A new key changes the derived secret of every source without
an operator-managed one, and a derived secret is shown only when its source is
created. Keep `SOURCE_WEBHOOK_SIGNING_KEY_PREVIOUS` until each such source
has been re-created, which shows its new secret for the provider, or given an
operator-managed secret.
