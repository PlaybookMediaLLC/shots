# Workspace activity notifications

Activity intent commits with business state in `outbox_event`. Its
`notification_version` and `notification_fanned` fields are independent of the
existing outbox side effects. The `notifications` job uses the existing Temporal
`platform-maintenance` queue and runs by default. Legacy activity email senders
are paused by default; no notification enable flag is required. Explicitly setting
`PLATFORM_ACTIVITY_LEGACY_PAUSED=false` keeps the legacy senders running and
pauses the new dispatcher to prevent duplicate delivery.

The [event matrix](workspace-notification-events.md) lists the supported committed
transitions. Autosaves, retries, polling, audit writes, and generation substeps do
not produce activity. Multistage approval and recurring campaign automation do
not exist in this product and have no notification emitters.

## Recipients and preferences

People involved receive activity; operational failures also reach owners/admins.
Human actors are excluded from their own actions. Background completion may
notify the requester. Every personal delivery checks current membership, current
resource access, and the current workspace. Removed members lose their receipt content
immediately. A link is authorized again when opened, including for read or archived
receipts. Inaccessible resources have a generic unavailable state.

Workspace channel availability and event selection are hard ceilings. Personal
in-app/email opt-outs can only reduce delivery. In-app starts enabled. Existing
campaign review email stays enabled; other email and Slack streams require an
administrator to select them. Required authentication, invitation and security
mail remain outside these preferences. Slack has no personal preferences: its
destination is shared and receives only explicitly permitted coarse catalogue
metadata. Comments, review content, member details, diagnostics, and restricted
resource links are never included in Slack messages.

The sidebar and mobile shell poll the unread count every 30 seconds while the
document is visible. Inbox contains comments, mentions and reviews; Activity
contains publishing and operational events. Archive contains archived receipts
from either category. Tab choice is remembered per user/workspace for the browser
session. Opening the panel or fetching a page never marks anything read.

Read/unread and archive/restore are explicit recipient actions. Reading sets
`read_at`; archiving sets `archived_at` without changing read state. Restoring
returns the receipt to its original category and preserves its read state. The
badge counts only unread, unarchived receipts. Each feed uses descending
`created_at, id` cursor pagination bound to user, workspace and feed. Concurrent
arrivals appear on refresh; they cannot change an older page's cursor boundary.

The session-only `POST /api/workspace/notifications/state` contract accepts a
validated action, view, either receipt IDs (at most 100) or all, and a stable
request key. Bulk actions apply to a transaction snapshot of the selected feed.
Retrying a completed key returns its original changed count without consuming
subsequent arrivals. Reusing a key with a different payload is rejected. Membership
and session context remain locked through the commit. Confirmed results update
the badge and invalidate user/workspace-scoped caches across browser tabs.
The compatibility `/seen` endpoint now marks receipts read; its deprecated
`deleted` result counts acknowledgments and no longer means storage deletion.

Migration `20261031090000_notification_receipt_state.sql` adds read/archive state
and backfills categories without changing existing unread receipts. Previously
deleted acknowledgments cannot be reconstructed and are not replayed. Apply the
additive migration before releasing the new API/UI. Rolling the application back
to the destructive acknowledgment implementation can delete read/archive history;
retain the new handler during rollback. Notifications and their delivery
records are deleted 90 days after creation, read or not, by the daily
`notification-retention` job; a workspace legal hold pauses it. Archive is not
permanent storage.

`platform_notification_delivery` is a content-free receipt after completion. Its
unique workspace/event/channel/destination identity survives recipient state changes, so
outbox replay cannot reset read/archive state or resend a success while the
receipt is kept. An encrypted, immutable payload exists only while an external
request may require retry or reconciliation. Uncertain payloads expire after 24
hours. A receipt is removed after 90 days, or earlier when its canonical outbox
event no longer exists. Workspace deletion removes
the workspace's inbox, preferences, receipts and Slack connections, and preserves
installations still used by other workspaces.

## Backend configuration

Set these on the Go API and maintenance worker, with the social backend receiving
the same Slack lifecycle configuration when legacy publishing is enabled:

| Variable                                                                                                     | Purpose                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLATFORM_NOTIFICATION_ENCRYPTION_KEY`                                                                       | Independent base64 encoding of 32 random bytes; seals Slack credentials and temporary delivery payloads.                                        |
| `PLATFORM_ACTIVITY_LEGACY_PAUSED`                                                                            | Defaults to true. Setting false runs legacy activity email instead of the new dispatcher. Existing queued workflows must be drained separately. |
| `BETTER_AUTH_URL`                                                                                            | Trusted application origin for preference and authorized resource links.                                                                        |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`                                                                     | Slack application credentials, backend only.                                                                                                    |
| `PLATFORM_SLACK_CALLBACK_URL`                                                                                | Exact web callback URL, normally `<app-origin>/api/integrations/slack/callback`.                                                                |
| `INTEGRATION_ENCRYPTION_KEY`                                                                                 | Temporary legacy decryption key for existing Slack `v1` ciphertext. Notion/Figma retain their existing use of this key.                         |
| `RESEND_API_KEY`, `AUTH_EMAIL_FROM`                                                                          | Existing Go email transport and sender.                                                                                                         |
| `AUTH_EMAIL_WEBHOOK_URL`                                                                                     | Existing email webhook fallback when Resend is absent.                                                                                          |
| `EMAIL_PROVIDER=nodemailer`, existing `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_USER`, `EMAIL_PASS`, `EMAIL_SECURE` | Preserve an intentionally configured legacy SMTP transport when no Resend/webhook is configured.                                                |

DigitalOcean's backend deploy copies the notification encryption key, Slack client
credentials, callback URL, and temporary legacy decryption key from Infisical into
`TENANT_` runtime secrets. The combined backend shares that Slack configuration
with the social process. The web deploy removes Slack credentials and the new
notification encryption key while retaining the key used by unrelated integrations.

The maintenance process also retains its existing audit, database, Temporal, and
authentication configuration requirements. Missing providers are shown as
unavailable. Missing email transport skips the delivery; invalid configuration
blocks it with a stable failure code. Settings responses contain availability,
installation identity, destination, health, and delivery metadata, never tokens.
Test actions send only to the selected Slack destination or current user's
verified email and are throttled to one per destination per minute.

## Slack

Create a Slack application and register the exact callback above. Use Slack's
[server authorization-code flow](https://docs.slack.dev/authentication/installing-with-oauth/).
State is random, ten-minute, single-use, and bound to user, session, active
workspace and purpose. Permission loss and workspace changes invalidate it.
Do not enable [PKCE](https://docs.slack.dev/authentication/using-pkce/) or change
[token rotation](https://docs.slack.dev/authentication/using-token-rotation/)
settings during cutover. Both involve consequential application-level changes.
Already-issued rotating tokens are supported: refresh is claimed across
processes, replacement credentials commit atomically, and ambiguous refresh
requires reconnection.

Minimal manifest template (substitute the deployed callback):

```yaml
display_information:
  name: Shots workspace activity
features:
  bot_user:
    display_name: Shots
    always_online: false
oauth_config:
  redirect_urls:
    - https://YOUR-APP/api/integrations/slack/callback
  scopes:
    bot:
      - chat:write
      - channels:read
      - groups:read
      - files:write
      - channels:join
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
```

`chat:write` sends activity; `channels:read` and `groups:read` discover destinations.
`files:write` and `channels:join` preserve existing design uploads to public
channels. Existing publishing with a custom sender additionally requests
`chat:write.customize` when the connection purpose is publishing. Private
channels require an invitation; archived channels are rejected. Pagination
continues through empty pages until the cursor is empty. No webhook subscriptions
or interactive Slack actions are required.

One message is sent per occurrence/destination with escaped fallback text,
disabled unfurls and automatic mentions. The shared installation/channel clock
enforces pacing; pacing does not consume provider-failure retries. Provider
`Retry-After` extends backoff. Health checks examine at most five installations
per run and no more than once per installation per hour. Disconnect affects only
this platform workspace and its pending sends, without revoking a shared token.

Enable distribution for a controlled pilot only after configuring Slack's
[distribution prerequisites](https://docs.slack.dev/app-management/distribution/).
Commercial distribution and Marketplace review have separate requirements;
successful pilot installation does not establish Marketplace approval. Review
Slack's current requirements before commercial release. The manifest is a setup
template, not a claim that an external app has been configured or approved.

Provider contracts: [messaging](https://docs.slack.dev/reference/methods/chat.postMessage/),
[pagination](https://docs.slack.dev/reference/methods/conversations.list/), and
[rate limits](https://docs.slack.dev/apis/web-api/rate-limits/).

## Cutover and rollback

Fresh deployments need no cutover flags or legacy import. Apply the schema, deploy
the backend/worker, then the web. The notifications schedule runs automatically.
The following migration steps apply only when legacy notification data or queued
activity emails exist.

1. Apply reviewed additive SQL with `npm run db:migrate`. Generation is
   `cd services && go generate ./ent`; build the SDK with `npm run build:sdk`
   and API artifacts with `npm run api:generate`.
2. Pause the Temporal notifications schedule before deploying the compatible Go
   API/worker. Keep legacy activity production paused (the default) and drain
   existing `digestEmailWorkflow`, activity-related `sendSingleEmailWorkflow`, and
   legacy `sendEmailWorkflow` executions. Inspect their histories and provider
   receipts; do not classify an attempted recipient as unsent without evidence.
   Required authentication mail must remain operational. The old review handler
   in this version no longer sends whole-event email.
3. Run `go run ./cmd/notification-cutover -mapping reviewed.json` against the
   deployment database to preview. It requires a current administrator and a
   verified `social_tenant_binding`. User mappings require independent identity
   evidence, never matching email addresses. A mapping file is operator input,
   not a public API:

   ```json
   {
     "workspaceId": "platform-workspace-id",
     "operatorId": "current-administrator-user-id",
     "preserveEmail": true,
     "mappings": [
       {
         "legacyUserId": "legacy-id",
         "userId": "platform-id",
         "evidence": "reviewed account-binding record reference"
       }
     ]
   }
   ```

   Every active legacy recipient must be mapped before content moves. The global
   `lastReadNotifications` timestamp cannot establish workspace read state, so
   every surviving legacy item is imported as unseen. Recipient receipts and
   copies commit together; shared legacy text is deleted only after all verified
   copies exist. Preview rolls back. `-apply` commits only after the legacy pause
   flag is set. Historical imports create no Slack/email jobs. Existing
   success/failure email choices are copied only for those existing categories
   when `preserveEmail` is true; explicit new settings take precedence.
   Empty `mappings` performs review cutover only and preserves all legacy content.

4. The same transaction converts untouched pending review events to recipient
   jobs. Previously attempted events without recipient evidence become
   `UNCERTAIN`, not automatically retryable. Already-delivered legacy events are
   not replayed. Repeat the reviewed operation for each workspace.
5. Legacy design Slack credentials are lazily verified with `auth.test`, imported
   under a transaction lock, and resealed with the backend key while retaining
   the connection ID. Native social Slack tokens use the verified tenant binding
   and provider team identity. Unknown application identity stays in a separate
   installation; email/name coincidence never merges installations. Inspect all
   legacy connections before retiring the temporary decryption key.
6. Deploy web adapters and settings. Remove Slack client credentials and the new
   backend encryption key from the web deployment. Keep unrelated Notion/Figma
   configuration. Then resume the Temporal notifications schedule and inspect pilot
   receipts.

Rollback pauses the Temporal notifications schedule. Retain the additive schema, receipts and compatible backend adapters.
Never restart old activity senders, restore deleted inbox rows, or reset delivery
successes. Resolve configuration and resume the same jobs.

## Delivery recovery and operation

Each recipient/channel has a separate claim token, retry count and receipt.
Stale workers cannot record a result after losing ownership. A lost worker after
the send boundary, transport timeout, malformed success response, or potentially
accepted server error produces `UNCERTAIN`. Known configuration errors block
until corrected. Other retryable provider failures are bounded to eight attempts.

Owners/admins inspect recent deliveries and recover an individual unresolved
delivery in Workspace → Notifications. Use provider receipts and the delivery ID
before choosing **Confirm delivered** or **Dismiss**. Successful receipts are
immutable. Retry rechecks access, connection, policy and preference generations.
A changed destination is not an instruction to send historical activity to the
new channel. For uncertain Resend requests, retry is allowed only with the exact
sealed payload and stable idempotency key inside Resend's documented
[24-hour window](https://resend.com/docs/dashboard/emails/idempotency-keys).
SMTP/webhooks and expired/missing retry payloads require reconciliation; never
automatically resend them. Recovery actions enter the existing audit/drain path.

Correlate `eventId`, `deliveryId`, workspace ID and provider receipt. Log stable
failure codes only. Do not log OAuth codes/state, token ciphertext/plaintext,
email bodies, comment/review text, or raw provider responses. Provider sinks in
tests contain fixture data only. Keep the backend encryption key available for
pending payloads and installations; key replacement requires a controlled
resealing/reconnection procedure.

## Architectural references

Examined the active, unarchived repositories below at pinned commits. They are
architectural references only; no dependency or implementation was copied.

- Slack Node SDK `1fabb452808d6c643a779c7fa8af36a34077c9ac`:
  [installation provider](https://github.com/slackapi/node-slack-sdk/blob/1fabb452808d6c643a779c7fa8af36a34077c9ac/packages/oauth/src/install-provider.ts)
  and [tests](https://github.com/slackapi/node-slack-sdk/blob/1fabb452808d6c643a779c7fa8af36a34077c9ac/packages/oauth/src/install-provider.test.ts).
  Adopted provider identity, state validation, and persisted refresh patterns;
  storage here is durable Go/PostgreSQL, not the default memory store.
- Novu `d0b3f296c44d4caba4a8b742098f81e9d35ff033`:
  [preference merging](https://github.com/novuhq/novu/blob/d0b3f296c44d4caba4a8b742098f81e9d35ff033/libs/application-generic/src/usecases/merge-preferences/merge-preferences.usecase.ts)
  and [tests](https://github.com/novuhq/novu/blob/d0b3f296c44d4caba4a8b742098f81e9d35ff033/libs/application-generic/src/usecases/merge-preferences/merge-preferences.spec.ts).
  Adopted explicit precedence and table-driven tests. Workspace policy here is a
  hard permission ceiling.

## Local validation

The Playwright journey is `test/e2e/workspace-notifications.spec.ts`. It uses the
repository auth/database framework, real Go business transactions and Temporal
maintenance, plus `test/e2e/fixtures/notification-providers.mjs` as the only provider
replacement. Compile Go API/worker with `-tags=e2e`; set
`NOTIFICATIONS_E2E_PROVIDER_URL` to that loopback HTTP origin. Production builds
do not include the override. Set the existing E2E database/Redis/base URL variables
and `NOTIFICATIONS_E2E_TEMPORAL_CONTAINER` to the isolated Temporal container.
The journey launches headed Chromium to verify actual background focus; Linux
CI needs a display (for example, `xvfb-run`). The test configures real settings,
completes OAuth, follows an empty channel
page, inspects sinks, checks actor exclusion, hard deletion/reopening, opt-out,
disconnect and workspace isolation. Database-backed Go tests cover retry,
uncertainty, concurrent claims/refresh/mark-all, cutover, and replay resistance.
Live Slack/email acceptance is a separate, authorized provider exercise.
