# Draft history

A draft's history is the audit log read for one draft: the draft's own events
and those of the posts scheduled from it. It shows in the draft's Properties
panel (Draft details) and in the plan sheet. It is separate from the
notification feed and from comment threads. `GET
/api/v1/content-drafts/{id}/activity` (scope `artifact:read`) and the MCP tool
`listContentDraftActivity` serve the same pages. Reading a draft writes
nothing, so viewing is never history.

## Order and pages

Events come newest first, by time and then by id, so two events written in
the same transaction keep one order. A page holds 50 events. `nextCursor`
continues after the last one, and a page never repeats or skips an event.

## Who made a change

Each event names its `source`:

| Source       | Shown as          | Recorded when                                                                           |
| ------------ | ----------------- | --------------------------------------------------------------------------------------- |
| `person`     | The person's name | A signed-in member made the change. A deleted account shows as a former member.         |
| `api`        | API key           | A workspace API key made the change over REST.                                          |
| `mcp`        | AI agent (MCP)    | A key made the change through the MCP server.                                           |
| `workflow`   | Publishing        | The publishing workflow changed a post.                                                 |
| `callback`   | Provider callback | A provider or source callback did.                                                      |
| `support`    | Shots support     | Support acted under a support grant.                                                    |
| `automation` | Shots             | Any other Shots service, and other automated rows written before sources were recorded. |

Automated writers record the source as `actorSource` in the audit row's
metadata. Rows from before that are recognised by their writer's name: the
publishing orchestrator reads as `workflow` and provider callbacks as
`callback`. The history never returns a key's name or prefix, IP hashes, user
agents or any metadata outside its allowlist (`activityMetadataKeys` in
`server/internal/product/content_draft_write.go`).

## Grouping

The page groups what it has loaded: a change joins the entry above it when
the same author (the same person, or else the same source) made it within 30
minutes of that entry's oldest change. An entry shows its newest change, who
made it, how long ago and the moment itself; with more than one change it
opens to list each. The same events always form the same entries
(`groupHistory` in `clients/apps/web/lib/write/history.ts`).

## Retention and recovery

History is the audit log, so it follows the workspace's audit retention and
its legal hold (`AuditRetention` in `server/internal/maintenance/retention.go`;
the per-workspace range is in `server/internal/product/audit_controls.go`).
The audit log is append-only. Recovering a backup makes a new draft and adds
a `product.content_draft_recovered` event to the source draft's history; it
rewrites nothing that was there. Backups (revisions) keep their own schedule,
set in RFC 025.

## Rollout

The web checks every response against its contract, which requires `source`
and `nextCursor`, so deploy the backend before the web, as
[deployment](../deployment.md) says. Callers that read one page used to get up
to 200 events and now get 50 with a cursor for the rest.
