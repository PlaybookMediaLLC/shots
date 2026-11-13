# L2 provider evidence — 2026-11-13

These are the original local-stack screenshots from `.context/typefully-l2`,
preserved with the outcomes already recorded in PR #545. They are not a new
publishing run or production evidence. Only X `@yoanyombax` and LinkedIn member
`yoanyomba` were used. Times below are UTC; screenshots may display local time.

On 2026-11-13, a read-only query of the same local stack rechecked the canonical
posts, publication attempts and automation receipts. [receipts.json](receipts.json)
contains those records, including the cancelled schedules and the reconciled
unknown outcome. All nine delivered root posts in this export are `PUBLISHED`
with exactly one `SUCCEEDED` attempt whose native ID matches the post. The
screenshots and original run record establish the public rendering and removal;
the receipt recheck does not recreate those deleted posts.

The default body was **Shots live test, please ignore**. Exceptions and additional
content appear below. Original URLs no longer resolve after deletion.

| Check | Canonical post / native receipt | Content and native proof | Removal proof |
| --- | --- | --- | --- |
| 1 / TF-036 | `cmwebbjax000801qkbgok1y9l` / `2121056706041925765` | 01:45:00; question/body as above, **Option A**, **Option B**, 5 minutes. [Native poll](x-poll-live.jpg). | [Deleted](x-poll-deleted.jpg), verified by 01:47:33. |
| 2 / TF-107 | `cmwebk4em000j01qk5pnfzz9e` / `2121057905294090370` | 01:49:46; [post](x-replies-live.jpg), [Accounts you follow selected](x-replies-following.jpg). Other restricted reply modes were not tested. | [Deleted](x-replies-deleted.jpg), verified by 01:51:04. |
| 3 / TF-097 | `cmwebnqki000v01qkibny3bcf` / `2121058611589722292` | 01:52:35; [Made with AI and Paid partnership](x-disclosures-live.jpg). | [Deleted](x-disclosures-deleted.jpg), verified by 01:53:32. |
| 4 / TF-069, TF-068, TF-092, TF-007 | `cmwedpp29000o01o8oankmcp7` / `2121073120832311594` | 02:50:14; Publish now replaced the 16:15 schedule. [Noise image first, blue image second](x-media-live.jpg), [ALT description](x-media-alt.jpg). Exact assets and alt text are below. | [Deleted](x-media-deleted.jpg), verified by 02:51:40; all three assets `DELETED`. |
| 5 / TF-011, TF-027, TF-064 | `cmwedu5gy001001o8o9g6jtan` / `2121073956824183158` | 02:53:33; [main post](x-automation-live.jpg), [plug after the owner's like](x-plug-live.jpg), [repost](x-repost-live.jpg). Plug: **Shots live test reply, please ignore**, native ID `2121081510233010373`. | [Repost undone](x-repost-undone.jpg), [reply deleted](x-plug-deleted.jpg), [main deleted](x-automation-deleted.jpg), [33-post baseline restored](x-profile-baseline.jpg), by 03:56:01. |
| 13 / TF-071 | `cmwedxiw0001h01o83rao349e` / `urn:li:share:7526840307548594176` | 02:56:11; [main post](linkedin-first-comment-post-live.jpg). Requested first comment: **Shots live test first comment, please ignore**. Comment failed; see Blocked outcomes. | [Deleted](linkedin-first-comment-post-deleted.jpg), by 03:01:06, after check 17. |
| 17 / TF-098 | `cmwee1llf001x01o840qntg3m` / `urn:li:share:7526841103610929152` | 02:59:21; **Shots live test repost, please ignore**; [original embedded under commentary](linkedin-repost-live.jpg). | [Deleted](linkedin-repost-deleted.jpg), by 03:01:06. |
| 16 / TF-109 | `cmwee99aj002i01o8zzatye9g` / `urn:li:ugcPost:7526842603464720385` | 03:05:19; default body; question **Shots live test poll, please ignore**, **Option A**, **Option B**, 1 day. [Native poll](linkedin-poll-live.jpg). | [Deleted](linkedin-poll-deleted.jpg), by 03:06:23. |
| 15 / TF-083 | `cmweecuzh002x01o883j23lne` / `urn:li:ugcPost:7526843401661661184` | 03:08:29; **Shots live test PDF**, two pages: **Shots live test - page 1** and **Shots live test - page 2**. [Page 1](linkedin-pdf-page1.jpg), [page 2](linkedin-pdf-page2.jpg). | [Deleted](linkedin-pdf-deleted.jpg), by 03:09:38; PDF asset `DELETED`. |

## Reads and automation

- Check 6 / TF-001: [live X mention suggestion](x-mention-suggestion.png) for
  `@getsol` returned **Lysol (@getsol)**. This is an exact-handle lookup, not
  prefix search. The scratch draft was archived; nothing was published.
- Check 6 / TF-003: [Analyze observation](x-poll-analyze-observation.jpg) for
  `cmwebbjax000801qkbgok1y9l` was stored at `2026-11-13T01:45:02.004306Z`,
  `kind=post`, `status=available`, before the poll was deleted. Likes, quotes,
  replies, reposts, bookmarks, impressions and profile clicks were all zero.
- The repost receipt `cmwedu5z1000k01qsg07k40sf` is `done`, `attempts=1`;
  its stored update time is `03:53:34.103` and the original browser check was
  `03:53:48`. X reposts do not have a separate new post ID in this receipt.
- The plug receipt `cmwedu5yy000j01qsm5x9gr4l` is `done`, `attempts=2`, native
  reply ID `2121081510233010373`, updated `03:23:34.496`. This counter includes
  engagement checks while a receipt stays pending; it is not a count of
  successful reply creations. Failed or uncertain provider mutations are not
  automatically retried by this automation path.
- The live automation used per-post values: one-hour repost, no automatic
  removal, plug at one like. The profile's six-hour repost / twelve-hour removal
  defaults loaded in the dialog but were changed. That does not prove publishing
  with unchanged defaults, automatic removal or like-gated reposting.
- The later same-day Auto-RT retest for PR #544 is retained in
  [execution.md](../../work-items/execution.md#live-provider-evidence). Its
  screenshots are not part of this original bundle.

## Media and cleanup

The 02:50 receipt's asset order is the derivative followed by the blue image.
The read-only recheck confirmed these statuses and metadata:

| Asset | Bytes | Relationship / exact alt text | Cleanup UTC |
| --- | --- | --- | --- |
| `2b28e99d-0a34-4214-acb8-c1ef469a3bdf` | 7,911,006 | Original PNG; **Shots live test image 1: grey noise with a red square** | `DELETED`, 03:25:20.621 |
| `241f91c6-a967-49f6-b224-b67816340568` | 4,078,756 | 1440×1290 PNG derivative of the original, same alt text | `DELETED`, 03:24:38.666 |
| `3e5d3cd0-d78e-4c62-b444-25e851916637` | 13,322 | Second PNG; **Shots live test image 2: blue with a white circle** | `DELETED`, 03:24:59.858 |
| `8384323c-dec3-448c-a3f2-153de9df8aab` | 876 | Two-page PDF, title **Shots live test PDF** | `DELETED`, 03:15:42.480 |

The delivered posts' drafts were archived before using the Library's
reference-aware Delete controls. An earlier incomplete browser upload,
`b1e0c6ca-799a-4f4c-a612-0d984eefd052`, is still `PENDING` at the recheck.
It was never published and the Library does not offer it. The normal 24-hour
expiration cleanup remains outstanding; this record does not claim it ran.

## Blocked and unknown outcomes

- **Check 4, first media draft:** `cmwebuylx001v01qkudcazh1d` recorded
  `UNKNOWN_DELIVERY`, **The X media source is unavailable**, before any X create
  call. [Profile check](x-media-unknown-profile-check.jpg) found no delivery.
  A later check at 03:22 preceded the normal **It is not there** reconciliation
  at 03:23:17. The canonical post is now `FAILED` / `NOT_LIVE`; its one failed
  attempt still retains `UNKNOWN_DELIVERY`. It was not automatically retried.
  The successful media post above belongs to a separate draft.
- **Check 13 / TF-071 — Blocked:** first-comment receipt
  `cmwedxjxv000t01qsg06lyfqz` is `failed`, `attempts=1`,
  `failureCode=provider_error`, no native comment ID. The adapter's message was
  **LinkedIn rejected this request. Check permissions, content and account
  limits before retrying.** The provider HTTP status and body were discarded;
  this is not evidence of a specific 403 or permission scope. No retry was sent.
- **Check 14 / TF-077 — Blocked:** [company lookup error](linkedin-mention-lookup-error.png)
  for Solomon AI / `getsolomonai`, Page `106498803`. Web HTTP 503 wrapped backend
  HTTP 500 `{"error":"internal server error"}`. The exact LinkedIn status/body
  was not retained. Community Management permission is a possible cause, not a
  verified provider refusal. No mention resolved and no post was sent.
- **Check 7 / TF-035 — Blocked:** X and LinkedIn are assigned to separate
  profiles. A draft belongs to one profile; moving a connection disables it and
  requires a reconnect. This run does not authorize that account change. Separate
  successful publications do not prove the requested single-draft cross-post.
- **Check 26 / TF-066 — Pending:** no ten-minute publication or 9:50 playback
  proof exists. The standard-account 20-minute limit is already represented in
  the code and docs; Premium is not the blocker. The next post still requires
  explicit approval of its exact content and a usable signed-in composer.
