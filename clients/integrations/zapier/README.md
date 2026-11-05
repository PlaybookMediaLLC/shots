# Shots for Zapier

A private Zapier Platform integration using the canonical Shots API: create drafts, read them by ID, tentatively plan them, and receive eight instant draft lifecycle events. Human review and publication remain in Shots. A plan is not a publishing command.

## Install and connect

1. Install Node 22 or newer and the Zapier Platform CLI. In this directory run `npm ci` and `npm test`.
2. Log in to your Zapier developer account, register a **private** integration, and push this source. Do not commit `.zapierapprc` or credentials. Zapier may report style warnings for static hooks without automatic subscribe/unsubscribe or live sample listing; these are intentional for this private integration. Public-directory submission is not claimed.
3. Connect the HTTPS origin of your Shots deployment and an API key with `artifact:read` and `draft:write`. The backend applies workspace plan, scope and content permissions. Personal private profiles require a Shots session and are not offered to keys.
4. For **Create Draft**, map a source event/version ID, profile and text. Separate posts with `---` on its own line. Keep the source event ID stable when retrying an uncertain request; a changed payload with that ID returns a conflict. Use a new event ID for a new source version.
5. **Plan Draft** sets a tentative timestamp and IANA time zone. Open the draft in Shots to review and publish.

## Instant triggers

These are supported Zapier **static webhooks**, not polling triggers. They preserve Shots' owner/admin-only webhook administration.

1. Choose the event trigger in Zapier and copy its generated hook URL.
2. In Shots → Settings → Webhooks, an owner/admin creates an HTTPS subscription to that URL and selects the matching event. Copy the signing secret shown once.
3. Enter that secret in the Zapier connection's password field. Enter the `workspaceId` from a Shots test delivery. Each independently signed subscription needs its matching connection/secret.
4. Enable the Zap and perform the real action in Shots. A test delivery is acknowledged but does not run downstream actions.
5. Map the event's `draftId`, `type`, `occurredAt` and redacted `data` into a Slack message, email or calendar action. **Find Draft** can fetch permitted content if your workflow needs it.
6. On disabling/deleting the Zap, disable/delete the subscription in Shots too. Rotate the secret in both places when needed.

Supported events: `draft.created`, `draft.updated`, `draft.scheduled`, `draft.published`, `draft.planned`, `draft.status_changed`, `draft.tags_changed`, `draft.deleted`.

The receiver verifies the exact raw body with HMAC-SHA256, event ID, five-minute delivery timestamp window and expected workspace. It accepts rotated signatures, preserves the stable event ID for Zapier deduplication, and rejects modified bodies. A retried Shots delivery gets a fresh signed delivery timestamp and retains its event ID. No draft bodies or comments are present in the event envelope. Private brands are excluded at enqueue and delivery.

## Verification and external requirements

`npm test` executes the Zapier runtime and schema validator, signed delivery handling, replay identity, wrong-workspace/tampering/stale rejection, retry-stable draft payloads, HTTPS restrictions and redirect refusal. It does not establish a hosted Zap's downstream delivery. Hosted trigger activation, Slack/email/calendar mapping and public-directory approval require the user's Zapier account and controlled destination accounts. Those checks remain outstanding; no messages have been sent to external recipients by this implementation task.
