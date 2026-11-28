# Outbound webhooks

A workspace owner or admin can send draft events to their own HTTPS
endpoints from **Settings → API → Webhooks**. The design is in
[RFC 024](rfcs/024-settings-platform.md#outbound-webhooks). This page is for the
person writing the receiver.

## Events

| Event                  | Sent when                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `draft.created`        | A draft is created.                                                                              |
| `draft.published`      | One of a draft's posts goes live (once per post).                                                |
| `draft.scheduled`      | A draft is scheduled, rescheduled or moved on the calendar.                                      |
| `draft.planned`        | A draft's planned date is set or changed.                                                        |
| `draft.status_changed` | A draft's status changes: scheduled, archived (also when its social set is deleted) or restored. |
| `draft.tags_changed`         | A draft's tags change (an experiment).                                                                                         |
| `draft.deleted`              | A draft is deleted.                                                                                                            |
| `post.completed`             | A scheduled post reaches a terminal outcome (`published`, `sent_to_app`, `failed`, `unknown_delivery`, or `missed_window`), with its live URL or failure code. |
| `connection.needs_reconnect` | A shared social account stops renewing its credentials and requires reconnection.                                              |
| `webhook.test`               | An admin presses **Send test**. It is never sent on its own.                                                                   |

Events are written in the same database transaction as the change they
describe, so an event exists only if the change was saved. Nothing is emitted
for a workspace without an enabled subscription.

## Request

```http
POST /your/path HTTP/1.1
Content-Type: application/json
User-Agent: ScreenshotStudio-Webhooks/1
X-Shots-Event: draft.scheduled
X-Shots-Event-Id: evt_cm4…
X-Shots-Delivery: cm4…
X-Shots-Timestamp: 2026-10-20T14:00:00Z
X-Shots-Signature: v1=5d41…
```

```json
{
  "schemaVersion": 1,
  "id": "evt_cm4…",
  "type": "draft.scheduled",
  "occurredAt": "2026-10-20T14:00:00.000Z",
  "workspaceId": "…",
  "socialSetId": "…",
  "resource": { "type": "content_draft", "id": "…" },
  "data": {
    "id": "…",
    "title": "Launch day",
    "status": "scheduled",
    "platforms": ["x", "linkedin"],
    "primaryPlatform": "x",
    "tags": [{ "id": "…", "name": "Launch" }],
    "plannedFor": null,
    "version": 4,
    "createdAt": "…",
    "updatedAt": "…",
    "posts": [{ "id": "…", "platform": "x", "scheduledFor": "…" }],
    "scheduleMode": "queue"
  }
}
```

`data` carries identifiers, titles, statuses, tags, platforms and times.
Tags are the draft's tag records in its social set, each with its id and name
(RFC 025); `draft.tags_changed` also carries `previousTags`, the same pairs
before the change. It never carries a draft's body, comments, member details or credentials. Fetch
those with the [API](rfcs/014-rest-api-scalar-reference.md) if you need them.
A breaking change to the envelope bumps `schemaVersion`; new fields can appear
at any time.

## Verifying a delivery

The signature is `v1=` followed by the lowercase hex HMAC-SHA256, keyed with
your signing secret, of:

```text
{X-Shots-Event-Id}.{X-Shots-Timestamp}.{raw request body}
```

Compute it over the raw bytes you received, before parsing JSON. After a
secret rotation, the header holds two comma-separated signatures for 24 hours:
accept the delivery if any one matches.

```ts
import { createHmac, timingSafeEqual } from 'node:crypto'

export function verify(secret: string, headers: Headers, body: string): boolean {
  const eventId = headers.get('x-shots-event-id') ?? ''
  const timestamp = headers.get('x-shots-timestamp') ?? ''
  // Refuse old deliveries so a captured request cannot be replayed later.
  if (Math.abs(Date.now() - Date.parse(timestamp)) > 5 * 60_000) return false
  const want = Buffer.from(
    'v1=' + createHmac('sha256', secret).update(`${eventId}.${timestamp}.${body}`).digest('hex')
  )
  return (headers.get('x-shots-signature') ?? '')
    .split(',')
    .map((part) => Buffer.from(part.trim()))
    .some((got) => got.length === want.length && timingSafeEqual(got, want))
}
```

Then deduplicate on `X-Shots-Event-Id`: delivery is at least once, and a
replay sends the same event ID again.

## Responses, retries and replay

- Answer with any `2xx` within 10 seconds. Anything else is a failure.
  Redirects are not followed.
- A failed delivery is retried after 30 s, 2 min, 10 min, 30 min, 1 h, 3 h and
  6 h: eight attempts in all. After the last it is marked **dead**.
- One delivery at a time goes to each endpoint, oldest first.
- **Settings → API → Webhooks → Deliveries** shows each delivery's attempts:
  time, duration, response status and a safe error class. Response bodies are
  never stored.
- **Replay** sends a dead delivery once more, with the same event ID and body.

## Endpoint rules

The URL must be `https://`, name a host (not an IP address), and carry no user
name, password or fragment. `localhost`, `.local` and `.internal` names are
refused. Every address the name resolves to must be public, both when you save
it and on every connection, so a DNS change cannot point a webhook at a private
network.

## Secrets

The signing secret (`whsec_…`) is shown once, when the webhook is created or
its secret is rotated. Shots stores it encrypted with
`PLATFORM_WEBHOOK_ENCRYPTION_KEY` and never shows it again. Rotating keeps the
previous secret valid for 24 hours.

## Server configuration

`PLATFORM_WEBHOOK_ENCRYPTION_KEY` is a base64-encoded 32-byte key, set on the
backend only (the product API and the product worker; in production
`TENANT_PLATFORM_WEBHOOK_ENCRYPTION_KEY` on the combined backend). Generate one
with `openssl rand -base64 32`. Without it, the webhook API answers
`503 webhooks_unavailable` and the settings page says so; nothing else is
affected. `dev/studio` creates one for local stacks.
