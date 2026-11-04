# Screenshot Studio Go social backend

The combined `screenshot-studio-backend` image runs the product API and the
publishing worker. Channel connections, provider adapters and the MCP server
run inside them; there is no separate social API.
The customer web app uses the published `screenshot-studio-backend-sdk` through
`lib/backend/sdk.ts`. It does not hold a PostgreSQL URL, social API key, or R2
signing credentials.

One PostgreSQL database and its `public` schema hold auth, product, scheduling,
and social integration tables. `/platform-migrate` is the only deployment
migration command. `scheduled_post` and `publication_attempt` are the customer
publication state; the worker calls LinkedIn, X, and Instagram adapters and
stores the confirmed remote receipt there. The legacy social `Post` table is
not written by the customer scheduling path.

## Local Compose

Run `./dev/studio up` for the web, product API and worker, PostgreSQL, Redis,
Temporal, and private RustFS. The product API connects channels in process and
serves the MCP server on http://localhost:3100. Provider credentials go in the
ignored `.local/social.env`, which `dev/studio` loads when present.

The operator binding maps a product workspace to the social organization's
integration records and a backend-held API key reference. Store a new key in
the ignored `.local/dev.env` and run the script below; it creates the social
organization for that key when none exists:

```sh
(cd clients/apps/web && npx tsx scripts/bind-social-tenant.ts <workspace-id> <key-variable-name>)
```

This binding is temporary cutover compatibility. The customer worker uses
the canonical workspace ID and checks the mapped social organization before
accepting a destination; a missing or wrong binding blocks the action.
Retiring the binding and the social identity tables is still tracked in
[the cutover plan](plans/backend-owned-data-cutover.md).

Use `./dev/social-gate` for a full isolated test stack with a fake social API.
It does not access connected personal accounts. The
[verification record](social-publishing-verification.md) lists its assertions
and the live canaries still required.

## Provider credentials and callbacks

Provider application secrets belong to the Go social component, never the
web. In the local overlay, use `SOCIAL_X_API_KEY`,
`SOCIAL_X_API_SECRET`, `SOCIAL_FACEBOOK_APP_ID`,
`SOCIAL_FACEBOOK_APP_SECRET`, `SOCIAL_INSTAGRAM_APP_ID`, and
`SOCIAL_INSTAGRAM_APP_SECRET` as applicable. Compose maps them to the Go
process variables. LinkedIn uses `LINKEDIN_CLIENT_ID` and
`LINKEDIN_CLIENT_SECRET`. LinkedIn grants Page publishing (Community
Management API) only to an app with no other products. Set that app in
`PLATFORM_LINKEDIN_PAGE_CLIENT_ID` and `PLATFORM_LINKEDIN_PAGE_CLIENT_SECRET`;
when they are not set, LinkedIn Page uses the shared app. Either app needs
`r_basicprofile` and the organization permissions; Page connections do not use
OpenID. A refresh token works only with the app that issued it, so reconnect
each LinkedIn Page channel after you change these variables. Do not commit the
overlay or tokens.

Threads uses `SOCIAL_THREADS_APP_ID` and `SOCIAL_THREADS_APP_SECRET`; the legacy
mastodon.social branch uses `SOCIAL_MASTODON_CLIENT_ID` and
`SOCIAL_MASTODON_CLIENT_SECRET`. The picker reads the adapter's current
configuration and disables unavailable connections before asking for credentials.
Bluesky and custom Mastodon require their rollout flag on both product and social
APIs. Deploy the adapter availability endpoint before the product/web update;
older adapters cause a recoverable unavailable state. See
[connection availability](implementation/social-connection-availability.md) for
the configuration/status contract and coordinated rollout.

The web's authenticated routes start OAuth at
`/integrations/social/<provider>/start` and receive callbacks at
`/integrations/social/<provider>`. They call the product backend through the
SDK. The backend binds one-use state to the workspace and session, exchanges
the code through the social service, verifies the destination, and registers
one canonical channel connection. The supported callback names are `x`,
`linkedin`, `instagram`, and `instagram-standalone`. Facebook Login's
Instagram flow includes Page selection.

Register each exact HTTPS callback URL with its provider for live tests.
Instagram Login rejects an HTTP callback; a local canary needs a temporary
HTTPS tunnel to the web app, a matching `SOCIAL_FRONTEND_URL`, and that
origin in `BETTER_AUTH_TRUSTED_ORIGINS`. Sign in on the tunnel hostname so the
callback receives its own session cookie. The normal Connect action requires
two-factor authentication. Avoid putting any provider token in the browser or
the web container.

Private product media stays in R2. The canonical asset row holds a stable
object key; the worker signs it when publishing and again for a retry. Do not
make the bucket public. TikTok photo publishing remains unavailable until its
verified media URL requirement has a separate design and live test.

## Production release

Social API and worker processes require `PLATFORM_SOCIAL_ENCRYPTION_KEY`, a
base64-encoded random 32-byte key held in the backend secret store. The local
`dev/studio` setup generates it. Supply the same value to every backend process
that reads social credentials, including the product notification service's
legacy Slack import. Never put it in the web environment. The production spec
renderer requires the key; the social process refuses to start without it.

The existing `Integration.token` and `refreshToken` fields now use AES-256-GCM
with a fresh nonce and field-bound authentication. Provider-specific credentials
and temporary OAuth client secrets use the same envelope, bound to their purpose
or OAuth state. Existing plaintext tokens and legacy CBC custom credentials stay
readable during migration. No new credential table or connection identity is
created. Secret fields must not be used as equality/search predicates: the
randomized ciphertext intentionally differs on every write.

This storage change requires a coordinated backend rollout:

1. Back up the database and preserve its existing `JWT_SECRET` and encryption
   keys in the secret store. Pause social API intake and social workers; leave
   queued workflows intact. Drain active provider calls before stopping workers.
2. Deploy all readers and writers with the same new key before resuming them.
   Old binaries cannot read the authenticated envelopes and must not run beside
   the new writers. Include product workers that import legacy Slack accounts.
3. Run `/social-credentials` from the new image with `DATABASE_URL`, the new key,
   and the existing `JWT_SECRET`. It locks batches of 100 integration rows,
   authenticates each value, and commits one batch at a time. A failed batch is
   rolled back; earlier batches remain committed. Its error identifies only the
   row and field. Investigate invalid legacy values without printing credentials,
   then rerun. A rerun verifies completed rows without rewriting them.
4. Verify existing accounts and refresh paths against disposable destinations,
   then resume intake and workers. A rollback to an old binary requires restoring
   the coordinated database backup while writes remain stopped; prefer a forward
   fix so new connections and queued work are preserved.

For key rotation, repeat the coordinated pause above. Keep the old key as
`PLATFORM_SOCIAL_ENCRYPTION_PREVIOUS_KEY` and deploy the new current key to all
readers and writers together before resuming traffic. Run `/social-credentials` again to reseal old
envelopes. Retain the previous key until all rows have been verified and transient
OAuth states (one hour) have expired. Keep historical keys with backups for the
backup retention period. Never rotate the legacy `JWT_SECRET` before the custom
credential backfill completes.

Social Temporal payloads now omit access tokens, refresh tokens and custom
credentials. Activities reload the current account and reject removed, disabled,
reconnect-required, changed-identity or wrong-workspace accounts before provider
calls. Refresh results contain a fixed non-secret success marker for frozen
workflow versions; the next activity reloads the committed token. Retire all old
Go/TypeScript social workers that depend on payload credentials during the
coordinated rollout. Existing workflow names and activity names remain unchanged.

This change does not erase prior workflow history. Restrict access to historical
runs and retain the configured history expiration policy; rotate any credentials
previously exposed through an unauthorized history read. New live-account checks
must use the updated API and workers. A local real-Temporal refresh/publish probe
verifies absence of credential values in durable history and successful replay;
frozen V101 and V112 refresh paths are also covered by workflow tests.

The [DigitalOcean guide](digitalocean-deployment.md) describes the App
Platform renderer and release commands. The intended order is database backup,
`/platform-migrate`, combined backend image and readiness checks, then the
web image pinned to the published npm SDK. Keep the old data stores read-only
for the rollback window and never run old and new workers for the same
destination at once.

Production must provide one logical PostgreSQL URL to the migration, product,
and social processes; separate least-privilege roles may point to it. Keep
Redis, private R2, and distinct Temporal namespaces as execution
infrastructure. The web needs only `PUBLISHING_API_URL` and
`PUBLISHING_SERVICE_TOKEN` to reach the product backend. Confirm a harmless
test-destination post, remote receipt, and private-media fetch for each
enabled provider before customer traffic.
