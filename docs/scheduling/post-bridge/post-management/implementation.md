# Shots post management implementation

Authorized 4 November 2026 as a scoped exception to the [RFC 042](../../../rfcs/042-scheduling-feature-priorities.md) deferral. No paid-customer evidence is recorded for it. The [Post Bridge analysis](post-bridge-post-management-technical-analysis.md) is reference material, not a specification: where they conflict, [scheduling reliability](../../reliability.md) and the existing model win.

Implementation status is tracked per slice below. A row marked Slice N is accepted only when that slice has merged with its tests.

## First slices

| Slice | Scope                                     | Owner                                                                                                     |
| ----- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1     | Month day cap, +N more, Show all          | `components/plan/PlanWorkspace.tsx`, `lib/plan/calendar.ts`                                               |
| 2     | Date-only calendar notes                  | `server/internal/product/calendar_notes.go`, `calendar_note` table, `lib/api/contracts/calendar-notes.ts` |
| 3     | Library All tab; account and date filters | `server/internal/product/content_drafts.go`, `components/write/library.tsx`                               |
| 4     | Account allowance on Settings › Channels  | `server/internal/workspaceplan`, `components/workspace/ChannelConnections.tsx`                            |

Settings › Channels, the calendar's `TimeZonePicker` and the removal impact shipped separately in #433, so this work does not rebuild them.

Client connect links are excluded. They add an unauthenticated path to publishing authority and need their own design and security review.

## Data and authority boundaries

- One `content_draft` with one `scheduled_post` per destination stays the post model. Nothing here adds a post, destination, result or attempt table.
- Social sets stay the account groups. A connection belongs to at most one set, and one active account per platform belongs to a set.
- The session names the workspace and `?set=` the brand. No new routes under `/posts`.
- Reconnecting reactivates the same connection. Removing one cancels its queued posts, and refuses while one is publishing.
- A calendar note is a workspace record: a local date, a title and a color. It references no post or set, so it never publishes and is never converted between time zones. It is visible to everyone in the workspace, which its dialog says.
- A day cap never hides a post that needs attention: Failed, Needs check and Overdue cards always show.

## Acceptance

Each slice is accepted by its tests and the [verification](#verification) below.

| Behavior                                                                                                                                       | Slice |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| A day with a Failed post and more than two others shows the Failed card without expanding                                                      | 1     |
| Show all survives a reload, and saved preferences without the field still load                                                                 | 1     |
| A note created in one zone reads as the same day in another                                                                                    | 2     |
| Notes are refused across workspaces and for roles that cannot edit drafts; every change is audited without its title                           | 2     |
| Deleting a workspace deletes its notes                                                                                                         | 2     |
| A draft matches filters only when one live post meets all of them; a draft with no live post matches on its intended accounts and planned date | 3     |
| Filters are in the URL and restore on reload; a private set's posts stay hidden                                                                | 3     |
| A library date filter puts a post on the calendar's day, even after a retry moves it past midnight                                             | 3     |
| Queue says it shows the next 60 days and links to the calendar                                                                                 | 3     |
| The allowance counts active accounts against the backend's limit, and is absent when the plan has none                                         | 4     |

The Queue tab lists, groups and filters posts by when they go out (`scheduledFor`), so a retried post sits under the day it runs.

## Outcome metric

Weekly workspaces that use library filters or calendar notes, read beside release-kit adoption. If it does not move in a quarter of use, remove the feature rather than extend it.

Recording was added on 13 November 2026 and counts from the first production deploy that carries it. The browser sends one PostHog event, `post_management_used`, when a person sets an account or date filter in the library (`feature: library_filter`) or creates a calendar note (`feature: calendar_note`). It carries the workspace ID and the feature only: `scrubEvent` (`lib/analytics-scrub.ts`) removes the URL query, where the library keeps filter values, and no title is sent. Search, tag and kind filters existed before this work and are not counted.

Read the weekly number in PostHog under SQL insights:

```sql
SELECT toStartOfWeek(timestamp, 1) AS week, count(DISTINCT properties.workspace_id) AS workspaces
FROM events
WHERE event = 'post_management_used' AND timestamp >= toDateTime('2026-11-13')
GROUP BY week
ORDER BY week
```

The number is a lower bound: PostHog loads only after a person accepts analytics, and local hosts send nothing. Release-kit adoption has no report yet ([RFC 005](../../../rfcs/005-release-kit-handoffs-and-adoption.md) is proposed), so until it does, read this number alone.

## Rollback

- Slices 1, 3 and 4: redeploy the previous web and API. New query parameters and endpoints are additive.
- Slice 2: deploy the migration, then the API, then the web. To roll back, redeploy the previous code. The table is ignored and can stay.

## Verification

```bash
python3 dev/verify-rfcs.py
(cd clients && npm run quality:check)
make -C server check
make e2e
make tenant-isolation
```

Then, in the running app with posts seeded in every state, at 1440, 1024 and 390 pixels in both themes, follow the acceptance table above.

## Check mapping

Every check from the [verification matrix](post-management-verification-matrix.csv), against Shots. "Exists" was established by reading the code on 4 November 2026 unless a test is named.

| Check                 | Disposition                                                                                                                                                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PM-001, 002, 003      | Skip: Shots has no path-based workspace. The session names it.                                                                                                                                                                                       |
| PM-004 to 009         | Exists: library empty states. All arrives in Slice 3.                                                                                                                                                                                                |
| PM-010, 011           | Exists: Posted tab. All arrives in Slice 3.                                                                                                                                                                                                          |
| PM-012                | Exists: created and updated sorts. A sort by post time is skipped until asked for.                                                                                                                                                                   |
| PM-013 to 015         | Slice 3: date presets and custom range, with a no-matches state.                                                                                                                                                                                     |
| PM-016                | Skip: Shots has no trial reels.                                                                                                                                                                                                                      |
| PM-017                | Slice 3: account filter, offered from the brand's accounts rather than loaded posts. A brand holds one active account per platform, so it is the platform filter too. A removed account's old posts match no option and show when the filter is off. |
| PM-018                | Slice 3: filters are in the URL, unlike the observed product.                                                                                                                                                                                        |
| PM-019                | Skip: navigation re-reads the list.                                                                                                                                                                                                                  |
| PM-020                | Exists: cursor pagination in the API. Slice 3 adds a notice when the 100-row load has more.                                                                                                                                                          |
| PM-021 to 023         | Exists: `/publish/[draftId]` with `components/drafts/DraftPosts.tsx`, including View post, retry and reconcile.                                                                                                                                      |
| PM-024                | Skip: no path-based workspace to lose. Slice 3 tests that links keep `?set=`.                                                                                                                                                                        |
| PM-025 to 030         | Exists: `components/plan/PlanWorkspace.tsx`. Week start and view are preferences.                                                                                                                                                                    |
| PM-031                | Exists for create on today and later. Add note is Slice 2.                                                                                                                                                                                           |
| PM-032                | Skip: overflow days keep their actions.                                                                                                                                                                                                              |
| PM-033, 034           | Exists: a day's ＋ opens `PlanComposer`, with Choose existing content. Text, image, video and story share one composer.                                                                                                                              |
| PM-035                | Exists: creating from a day plans the draft on it.                                                                                                                                                                                                   |
| PM-036 to 039, 074    | Slice 2: notes, with persistence, edit and delete defined.                                                                                                                                                                                           |
| PM-040                | Exists: the calendar lists published posts.                                                                                                                                                                                                          |
| PM-041 to 044         | Slice 1: day cap, per-day expansion, Show all. Posts that need attention are never collapsed, which the observed product has no rule for.                                                                                                            |
| PM-045                | Exists: platform filter, over Shots' own providers.                                                                                                                                                                                                  |
| PM-046, 047, 075      | Exists: `TimeZonePicker` (#433), a searchable portaled menu of every IANA zone. Named presets are skipped: search finds them.                                                                                                                        |
| PM-048                | Existing responsive calendar header; checked at the widths in Verification.                                                                                                                                                                          |
| PM-049, 050, 052      | Exists: Settings › Channels, one row per platform (#433). Only providers Shots has adapters for.                                                                                                                                                     |
| PM-051                | Slice 4: allowance.                                                                                                                                                                                                                                  |
| PM-053, 070           | Exists: Reconnect, Refresh and account health (#433).                                                                                                                                                                                                |
| PM-054                | Exists: Show IDs on Settings › Channels (#433).                                                                                                                                                                                                      |
| PM-055 to 059, 076    | Exists as social sets, with a brand filter on Settings › Channels (#433).                                                                                                                                                                            |
| PM-060, 061, 068, 069 | Excluded: client connect links.                                                                                                                                                                                                                      |
| PM-062 to 067         | Skip: vendor API behavior. Shots uses explicit schedule and publish-now commands, and per-destination `scheduled_post` rows.                                                                                                                         |
| PM-071                | Exists with a different rule: removal cancels queued posts, and says how many first (#433).                                                                                                                                                          |
| PM-072                | Differs by decision: reconnecting reactivates the same connection.                                                                                                                                                                                   |
| PM-073                | Exists: `test/e2e/write.spec.ts` and related specs.                                                                                                                                                                                                  |
| PM-077                | Exists: `TestSchedulingThroughTemporal` in [scheduling reliability](../../reliability.md#verification). Not a live-provider certification.                                                                                                           |
| PM-078                | Exists: `make tenant-isolation` and social set scope tests.                                                                                                                                                                                          |
