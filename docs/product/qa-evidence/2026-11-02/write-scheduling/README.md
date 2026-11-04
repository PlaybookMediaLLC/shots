# Write and Plan scheduling: browser evidence (2 November 2026)

Captured with Playwright (Chromium) against the native stack in a cloud
container: `next dev`, the Go product API and worker, PostgreSQL 16, Temporal
dev server, and the e2e social API mock with fixture-only credentials. No
request reached a real social network. "Before" is commit `2d83b4b`; "after"
is this branch. Light theme unless named; widths are CSS pixels.

| File | What it shows |
| --- | --- |
| 01, 02 | Composer at 390 px. Before: Schedule hidden, Publish is the filled action. After: Schedule is primary; the rest is in ⋯ |
| 03, 04 | Composer at 1024 px. Before: the header wraps to three rows. After: two |
| 05, 06, 07 | Add to queue dialog. Before: wider than a 390 px screen (title, close and times cut off). After: fits at 390, 1024 and 1440 in both themes |
| 08, 09 | A draft queued for 10:00 New York. Before: its posts read "3:00 PM" (browser zone) beside "10:00 AM EST". After: "10:00 AM EST" |
| 10, 11, 12 | Posting times. Before: Remove cut off in the drawer, no limit or preview. After: "10 of 50", next slots with offsets, a zone-change note |
| 13, 14 | An edit after scheduling: each queued post says it keeps the scheduled text; "Replace queued posts…" opens a Reschedule review listing what moves |
| 15 | Cancelling one destination names it and asks first |
| 16, 17 | Another client replaced the body: the unsaved edit is kept (Copy or Discard in a live session) and review is blocked until the writer chooses |
| 18 | Two tabs reviewed the same queue slot; the second is told and shown the next one, nothing committed. (Its copy said "below"; it now says "above", next to the summary.) |
| 19 | A failed save (503 injected by the test) blocks review with Retry save |
| 20 | **Seeded database rows, not provider results**: a destination with an unconfirmed delivery reads "Needs check" with no Retry, and one cancelled after a reviewer asked for changes gives that reason. The header shows "Needs check" |
| 21 | Plan month view after the change |

`after-metrics.json` and `states-metrics.json` record, per capture, whether
the page or the open dialog scrolled horizontally. After the change, none did.
