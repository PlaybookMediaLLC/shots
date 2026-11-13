# Delete a published post

Authorized 13 November 2026 by the owner as a scoped exception to the
[RFC 042](../../rfcs/042-scheduling-feature-priorities.md) deferral. It
amends [RFC 030](../../rfcs/030-social-publishing.md), which said that Shots
has no unpublish. The Typefully live verification (L2) showed the gap: every
test post had to be deleted in the network's own app.

## Decisions

The owner made these decisions on 2026-11-13:

1. Every publishing adapter takes part. An adapter whose network has no
   delete call reports "delete not supported" with the reason. It never
   pretends to delete.
2. Delete is available in the public REST API, in the web app, and as an MCP
   tool.
3. A delete is safe to retry. A network that answers "not found" for the post
   means it is already deleted. A transient failure (a timeout, HTTP 429 or
   5xx) retries with backoff. A definite refusal (HTTP 401, 403 or 400) stops
   and records the network's HTTP status.
4. Anyone who may publish to the account may delete its posts. Each delete
   writes an `AuditLog` entry. An API key needs the new `post:delete` scope.
   Like `post:publish`, the consent page never ticks it for a client. Like
   scheduling, a key reaches only the accounts of shared social sets.

## What a delete removes

A delete removes what Shots published for one `scheduled_post`:

1. The thread continuations, last first, from the post's `threadProgress`.
2. The follow-ups that Shots posted: the first comment, the plug reply and
   the quote, from `post_automation_run` rows that are `done`.
3. Each repost that Shots made, by undoing it.
4. The root post, last.

Pending follow-ups of the post are cancelled first. The workflow then plans
a second time, after the first pass: a reply or a repost that a running
follow-up made during the first pass is deleted too, and a follow-up planned
late is cancelled.

A post is marked deleted when its root part is `done`. A new request is
accepted while a part is `failed` or `pending`: it sets the failed parts back
to `pending` and retries them, for example after a reconnect. An error that
Shots raises itself, such as a removed or expired account, is never counted
as "already deleted": the part records it as `failed` with its code, such as
`ACCOUNT_RECONNECT`.

Each part has one receipt in a new `post_deletion` table: the part key, the
remote ID, the status (`pending`, `done`, `failed`, `unsupported`), the
attempts, the failure code (the HTTP status, such as `http_403`), and the
times. The `scheduled_post` keeps its `PUBLISHED` status and its receipt, and
gets a `deletedAt` time when the root part is `done`. The post's API view and
the web app list each part's receipt. The metrics refresh skips a deleted
post.

## Provider support

Read on 2026-11-13. An adapter implements `DeletePost`, which deletes one
remote record and returns the provider error with its HTTP status. A platform
without `DeletePost` is unsupported. The workflow classifies the status: 404 and 410 are
done, 429 and 5xx retry, and another status is a refusal.

| Platform | Call | Notes |
| --- | --- | --- |
| X | `DELETE /2/tweets/{id}`; reposts with `DELETE /2/users/{id}/retweets/{post}` | The undo call exists already (`UnretweetPost`). |
| LinkedIn member and Page | `DELETE /rest/posts/{encoded URN}`; comments with `DELETE /rest/socialActions/{post}/comments/{id}` | The member grant `w_member_social` covers posts. |
| YouTube | `videos.delete` | Needs the existing upload scope. |
| Bluesky | `com.atproto.repo.deleteRecord` for `app.bsky.feed.post` | Uses the record key from the AT URI. |
| Mastodon | `DELETE /api/v1/statuses/{id}` | Needs `write:statuses`. |
| Threads | `DELETE /{threads-media-id}` | [Needs `threads_delete`](https://developers.facebook.com/docs/threads/posts/delete-posts); 100 deletes per account per day. Shots does not ask for the scope yet: Meta must approve it for the app first, or every new Threads connection could fail. Until then Threads refuses the delete and the part records the status. To enable it, add the scope in `threads/provider.go`; existing connections then reconnect. |
| Instagram | Not supported | Meta [announced media deletion](https://developers.facebook.com/blog/post/2025/12/03/instragram-api-updates/) for accounts linked through a Facebook Page. Shots uses Instagram Login; support there is not confirmed. |
| TikTok | Not supported | The Content Posting API has no delete call. |

## Slices

| Slice | Scope | Owner |
| --- | --- | --- |
| 1 | `post_deletion` table, `scheduled_post.deletedAt`, migration | `server/ent/schema`, `server/platformmigrations/sql` |
| 2 | Adapter delete methods and their request-shape tests | `server/internal/social/integrations/social/<provider>` |
| 3 | Delete workflow: plan the parts, cancel pending follow-ups, run each part with the retry rule, settle the receipts | `server/internal/temporalpublishing`, `server/internal/social/tenantpublishing` |
| 4 | Domain rule, permission, audit and the workflow start, shared by the Go HTTP handler and the MCP tool | `server/internal/product`, `server/internal/httpapi` |
| 5 | Web contract, SDK call, `post:delete` scope, OpenAPI and generated client | `web/lib/api/contracts`, `web/lib/backend/sdk.ts` |
| 6 | "Delete from <network>" in the web app with a confirm step, and the receipts | `web/components/drafts/DraftPosts.tsx` |
| 7 | MCP tool `deleteContentDraftPost` (destructive, open world) | `server/internal/mcp` |
| 8 | Live check on X and LinkedIn with test posts the owner approves | `docs/scheduling/typefully/work-items/execution.md` |

## Acceptance

- A delete of an X post with a plug reply and a repost removes all three and
  records `done` for each part.
- A part that the network reports as not found is `done`.
- A transient failure retries and then succeeds without a second visible
  effect.
- A refusal records `failed` with the provider status, and the other parts
  continue.
- An unsupported platform records `unsupported`, and the web app says before
  the person confirms that such a part stays up.
- A person without publish access, or a key without `post:delete`, gets 403,
  and nothing is called.
- A deleted post shows "Deleted from <network>" with its time and the receipt
  of each part, and the metrics refresh no longer reads it.
- A part that failed can be retried after the root is deleted.
