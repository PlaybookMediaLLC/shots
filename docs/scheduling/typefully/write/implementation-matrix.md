# Write: requirements-to-code coverage matrix

Tracks [the functional reconstruction](typefully-write-spec.md) (29 sections) and
[the verification checklist](typefully-write-build-checklist.md) (60 cases) against
Screenshot Studio's Write workspace ([RFC 025](../../../rfcs/025-write-workspace.md)).
It is kept with the code: a change that adds, removes or weakens a behavior updates
its row.

Status values:

- **Done**: implemented and covered by an automated test that ran green.
- **Done (fixture)**: implemented; verified against a recorded or fake provider only.
  The live provider call has not been exercised from this repository.
- **Blocked (live)**: needs credentials, a paid provider plan or an account we do not
  have; the fixture path is tested, the live one is not claimed.
- **Gated**: deliberately unavailable, with the exact reason shown in the product.
- **Deviation**: implemented differently from the reconstruction, on purpose; the row
  says why.
- **Partial**: part of the case is covered; the row says which part is not.
- **Implemented, untested**: the behavior is in the code but no automated test
  checks it yet.
- **Not built**: out of scope for this change; the row says why.

Columns: *Existing* is what the repository had before RFC 025; *FE* and *BE* are the
main web and Go locations; *Tests* names the tests that cover the row (Go tests run
against a migrated PostgreSQL with `PUBLISHING_TEST_DATABASE_URL`; `write-*.test.ts`
are TypeScript unit tests; `write.spec.ts` is the Playwright journey).

## Specification sections

| § | Requirement | Existing | Verified | Missing | FE | BE | Migration | Dependencies | Tests | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Draft → platform version → posts; same-name sets stay distinct | Drafts with per-channel text (RFC 013) | Stable set ids across create/list/copy; versions carry their own body | — | `lib/write/document.ts`, `lib/write/versions.ts` | `internal/draftdoc`, `product/social_sets.go` | `20261030090000_write_workspace` | — | `TestWriteWorkspace/same-named sets stay apart…`, `write-versions.test.ts` | Done |
| 2 | Write and Plan as navigation surfaces; library left, composer, right panels; `/drafts` keeps working | Drafts pages | Sidebar shows Write; `/drafts*` redirect; panels are UI state | Analyze is the existing analytics, not part of Write | `app/[locale]/write/**`, `components/write/WriteFrame.tsx` | — | — | — | `write.spec.ts` | Done |
| 3 | Draft list: preview, platforms, row menu (delete, duplicate, copy to set, pin, tag, select multiple, backups, internal link, public link), search, four sorts, tag filter | List and delete | Row menu and bulk bar; public link asks first | Deleted-draft recovery (no trash; delete is confirmed) | `components/write/library.tsx`, `tags.tsx` | `product/content_drafts.go` (list filters, cursor, pins) | write workspace | — | `TestWriteWorkspace/organizing…`, `…/duplicates and copies…`, `write.spec.ts` (the library organizes drafts…) | Done |
| 4 | Creation kinds: post, X Article, quote, reply, repurpose; set-dependent menu | Standard only | Kinds are immutable on the draft with explicit targets | — | `library.tsx` (`NewDraftMenu`, `TargetDialog`) | `content_draft_documents.go` (`draftTarget`, `draftKindChannel`) | write workspace | X Premium for articles | `TestWriteWorkspace/kinds carry explicit targets…`, `TestWritePublishing/kinds publish only as they can` | Done |
| 5 | Structured posts with stable identity; preview and publication from one normalized model; undo | Thread breaks without ids | Leading `post_break` per post with a stable id; `buildPublication` feeds preview, review and Go | — | `components/drafts/thread.tsx`, `lib/write/publication.ts` | `content_draft_schedule.go` re-checks | — | — | `write-versions.test.ts`, `write-publication.test.ts` | Done |
| 6 | X threads: add below, move up/down (⌥↑/↓), delete, split (⌘↵), weighted counting, Premium from the account, 25 posts | Splitting, counting | Per-post tools; ⌥↑/↓; Premium read from the X account, not our plan | 50-post threads (we cap at 25, X API reply chains) | `thread.tsx`, `post-tools.tsx`, `lib/write/capabilities.ts` | `tenantpublishing/options.go` (`AccountStanding`) | — | — | `TestWritePublishing/Premium is the account's…`, `write-publication.test.ts` | Done (fixture for Premium) |
| 7 | Numbering: switch, start/end, 7 styles, skip first/last; derived, counted, non-destructive | — | Applied at serialization and counted in the limit | — | `version-options.tsx` (`NumberingDialog`), `lib/write/numbering.ts` | `draftdoc.Numbering` validated | — | — | `write-numbering.test.ts` (every style/position/skip), `write.spec.ts` | Done |
| 8 | Thread finisher templates; quote of the first post only once it is live; no surprise promotional inserts | — | Finishers per set; quote resolves the root id at publish | — | `FinisherDialog` | `content_draft_write.go` (finishers), `options.go` | write workspace | — | `TestAFinisherQuotesTheFirstPostOnlyOnceItIsLive`, `TestWriteWorkspace/finishers belong to a set` | Done |
| 9 | Audience (community + share with followers), reply permissions (apply to all), disclosures — separate fields | — | Three fields end to end; reply settings per post | Community lookup by search (we take the URL or id) | `post-tools.tsx`, `CommunityDialog` | `postoptions.PublishOptions`, X adapter | publish options | — | `TestPostSettingsMapEachPlatformsFields`, `TestWritePublishing/each platform's settings…` | Done (fixture) |
| 10 | LinkedIn: media, mention, poll, PDF carousel, visibility, first comment | Plain posts | All six; first comment is a receipted follow-up | People mentions (see §10 note) | `version-options.tsx`, `social-mention.tsx` | LinkedIn adapter, `temporalpublishing/automation.go` | — | LinkedIn Posts API | `TestPostSettingsMapEachPlatformsFields`, `TestAutomationPlan` | Done (fixture); live Blocked |
| 11 | Polls per platform: LinkedIn question 140, options 30, 2–4, durations; no media with polls | X polls | Rules per platform in editor, API and adapter | Threads/Mastodon polls | `PollEditor`, `capabilities.ts` | `content_draft_options.go` | — | — | `write-publication.test.ts` (polls follow each platform's rules), `TestWritePublishing/each platform's settings…` | Done (fixture) |
| 12 | Media lifecycle and validation; PDF ≤100 MB/300 pages; alt text; reorder and move between posts | Images and video | Server sniffs bytes; PDF page count; alt text on the asset, sent to X and LinkedIn | Platform derivatives and transcoding status UI | `pdf-carousel.tsx`, `describe-images.tsx`, editor block drag | `asset_bytes.go`, `asset_alt_text.go`, X/LinkedIn adapters | `…090300_write_asset_alt_text` | `pdfjs-dist` | `TestVerifyAssetBytes`, `TestPDFPageLimit`, `TestAltTextGoesOnTheMedia`, `TestPostContentAltText`, `TestWritePublishing/an image's description…` | Done (fixture) |
| 13 | Manage platforms; enabled ≠ editing tab ≠ connected; synced/manual; explicit re-sync naming orphaned comments | One text per channel | Separate state; re-sync asks and names the threads it orphans | — | `platforms.tsx` | `draftPlatformVersions` | write workspace | — | `write-versions.test.ts`, `TestWriteWorkspace/platform versions keep manual bodies…`, `write.spec.ts` | Done |
| 14 | Refine (scope, actions, custom prompt, preview, accept/reject, undo); Writing Assistant with style guide and samples, metered | Whole-draft rewrite without preview | Scoped refine, preview, single-step undo; Refine and the assistant write in the set's voice: RFC 024's Writing Assistant, merged with the workspace brand by Go and fenced in the prompt; AI credits | Voice input; streaming; the style guide is set up in the set's settings, not in the panel | `refine.tsx`, `assistant.tsx` | `lib/write/refine.ts`, `lib/write/ai-route.ts` (Next.js server); `GET /v1/content-drafts/{id}/writing-context` | — | AI credits (`withAiCredits`) | `write.spec.ts` (scripted model), `settings-platform-web.test.ts` (fence) | Done (scripted model); live model Blocked in CI |
| 15 | Properties: internal title, AI title, tags (per set, 10 colours), scratchpad, id, counts, activity | Title | All; internal fields never enter payloads | — | `properties.tsx`, `tags.tsx` | `UpdateContentDraftProperties`, tag CRUD | write workspace | — | `TestWriteWorkspace/organizing…`, `write.spec.ts` (scratchpad not in captions) | Done |
| 16 | Activity (no views) vs immutable backups; recovery makes a new draft; retention | Revisions | Audit-log activity; backups every 10 min of editing and at plan/schedule/publish/recovery; 30 days all, then daily for a year | Deleted-draft recovery | `share-backups.tsx` (`BackupsBrowser`) | `content_draft_write.go`, `pruneContentDraftRevisions` | write workspace | — | `TestWriteWorkspace/activity records changes and never views`, `…/recovering a backup…`, `…/backups are kept…`, `write.spec.ts` | Done |
| 17 | Comments on selected text, resolve, orphaned anchors; public and internal links; others' comments protected; collaboration | RFC 013 comments and live editing | `keepOthersComments`; public link revocation; set access on internal link | Editing lock (we merge live with Yjs and guard versions instead) | `comments.tsx`, `ShareDialog` | `activity_discussions.go`, share | — | collab server | `TestWriteWorkspace/an editor cannot erase…`, `content-draft-collaboration.spec.ts`, `write.spec.ts` | Done; Deviation (merge instead of lock) |
| 18 | Realistic preview: desktop/mobile devices, truncation, mentions, media, quotes, no engagement numbers | Basic preview | "Preview — not published"; no fake metrics | — | `preview.tsx` | — | — | — | `write.spec.ts` | Done |
| 19 | Schedule: today/tomorrow/later, 15-minute times, past disabled, zone and UTC offset, next slot, browse queue, best times, natural language, natural offset, save as planned, clear, confirm | Date picker | All; Go resolves local times and DST; Schedule or Reschedule, Add to queue; the repeated-hour choice and the confirmation name the brand zone, offset and any moved slot; Plan opens this review | Calendar grid (native date input instead) | `schedule.tsx` | `content_draft_timing.go`, `content_draft_schedule.go` | — | — | `TestResolveLocalTime`, `TestNaturalOffsetIsBoundedAndStable`, `TestWritePublishing/a local time…`, `…/simultaneous queue…`, `write-zoned-time.test.ts`, `write.spec.ts`, `plan-analyze.spec.ts` (P35) | Done; Deviation (native date input) |
| 20 | Publish review separate from publishing; exact accounts; revalidation; per-platform outcomes | Schedule only | Review lists set, accounts, posts, media, settings, follow-ups, approval, and blocks on an unsaved or conflicting edit; Publish now idempotent per version; Schedule is the header's primary action, Publish now is outline (in ⋯ on a phone) | — | `PublishReview` | `ScheduleContentDraft` (`PublishNow`) | — | — | `TestWritePublishing/publish now goes out now, once…`, `write.spec.ts` | Done |
| 21 | Auto-RT: rules (duration, days + time of day), removal after N hours, projected times, defaults, reset | Repost at likes | Receipted steps; removal paired; a new draft follows its set's engagement defaults (RFC 024: repost and plug at a like count) | Timed reposts have no set default: RFC 024's defaults hold a like count; Reset returns to 6 h, removed after 12 h | `automation.tsx`, `lib/write/automation.ts` (`engagementAutomation`) | `temporalpublishing/automation.go`, X adapter | `…090200_write_post_automation` | X API write access | `TestAutomationPlan`, `TestRunAutomation`, `TestPostWorkflowV2RunsAutomationsAfterPublishing`, `TestFollowUps`, `write-automation.test.ts` | Done (fixture); Deviation (no per-set timed defaults); live Blocked |
| 22 | Auto-Plug: likes/reposts threshold, reply composer and preview, counter, once per campaign, save as default | Plug at likes (count capped at 100) | Public-metrics count; once, then expires after 48 h; reply id kept; a likes plug saves as the set's engagement default | A reposts plug cannot be a set default (RFC 024 counts likes) | `automation.tsx` | as §21 | as §21 | as §21 | as §21 | Done (fixture); live Blocked |
| 23 | Auto-DM | — | Shown off with the reason; settings can be prepared, checked as Go checks them; the rules that need no X are built and tested: who may receive a DM, any/all, opt-out, one DM per person per campaign, rate limits, 4-day window ([consent and abuse policy](auto-dm-policy.md), approved 2026-11-13) | Event ingestion and DM sending: off until X grants the connection direct-message access and turning them on is approved | `automation.tsx`, `auto-dm-draft.tsx` | `internal/autodm`, X `direct_message.go` (refuses without `PLATFORM_X_AUTO_DM_DELIVERY_ENABLED`) | `20261102100000_platform_auto_dm` | X `dm.write`, a paid X API plan, approval to turn sending on | `write.spec.ts` (shown off), `write-automation.test.ts` (a prepared Auto-DM is refused here for what Go refuses on save), `autodm_test.go`, `ledger_integration_test.go` | Gated |
| 24 | X Articles: separate schema, Premium, X only, title, cover | — | Separate article field; eligibility checked at review and in Go | Inline media inside the article body editor | `library.tsx`, publication | `draftArticle`, `checkDraftKindTargets`, X adapter article draft/publish | write workspace | X Premium | `TestArticleSettings`, `TestWritePublishing/kinds publish only…` | Done (fixture); live Blocked |
| 25 | Public API: drafts per set, plan vs publish distinct, comment preservation | Drafts API | Social sets, tags, properties, plan, copy, recover, activity, mentions, alt text in `lib/api/contracts`; OpenAPI regenerated; no new API-key publishing authority | — | `lib/api/contracts/{social-sets,draft-tags,write,write-ai}.ts` | `internal/httpapi/write.go` | — | — | `openapi-contracts.test.ts`, `api-platform-boundary.test.ts`, oasdiff | Done |
| 26 | Keyboard contract and reference | Few | ⌘K, ⌘/, ⌘\\, ⌘⇧1/2, ⌘., ⌘⇧P, ⌘⌥S, ⌘⇧↵, ⌘⌥↵, ⌘⌥↑/↓, ⌘↵, ⌥↑/↓, ⌘⇧., ⌘⇧F/H, ⌘⇧M, ⌘J; reference dialog (⌘⇧/) | Refine is ⌘⇧E: ⌘I stays italic in our editor | `shortcuts.ts`, `WriteFrame.tsx` | — | — | — | `write.spec.ts` | Done; Deviation (Refine key) |
| 27 | Architecture: capability registry, sync engine, revision service, scheduler, publisher, automation, AI | — | One module each (see RFC 025) | — | `lib/write/*` | `internal/product`, `temporalpublishing` | — | — | — | Done |
| 28 | Lifecycle invariants 1–10 | — | Each is a test below (27, 11, 13, 26, 34, 48, 16, 18) | — | — | — | — | — | see cases | Done |
| 29 | Observed issues (palette, stale validation, preview from review) | — | Palette works offline from the loaded library; preview from review opens the panel | — | `CommandPalette.tsx` | — | — | — | `write.spec.ts` | Done |

§10 note: LinkedIn mentions are looked up through the set's LinkedIn connection by the
company page's vanity name. LinkedIn's API gives this connection no people search, so
the picker says so and offers no guess; a person typed as text stays plain text.

## Verification cases

| # | Case | How it is met | Evidence | Status |
|---|---|---|---|---|
| 1 | Navigate away and reload: content exact | Autosave with version guard; reload reads Go | `write.spec.ts` (backups/reopen), `content-drafts.spec.ts` | Done |
| 2 | Fast typing: out-of-order saves cannot restore old text | One save in flight; later edits re-save; base version guard | `useDraftDocument.ts`; `TestWriteWorkspace/organizing…` | Done |
| 3 | Offline: unsaved state visible, retry preserves edits | Offline state and online retry; `beforeunload` guard | `write-autosave.test.ts` (offline edits show as unsaved and every one saves when the network returns) | Done |
| 4 | Split at paragraph boundaries | `splitPostAtCaret` keeps text once | `write-versions.test.ts`, `write.spec.ts` | Done |
| 5 | Merge/delete/reorder keeps media and comments | Break and blocks move together; Backspace at start merges | `thread.tsx`; `write-versions.test.ts` | Done |
| 6 | Undo/redo split, mention, poll, template | Each is one undo step that puts the caret back (`asUndoStep` in `thread.tsx`), in Plate's history and in a live session's Yjs history, which otherwise merges edits made within 500 ms | `write-thread-insertion.test.ts` (Plate history / live session history: a split, mention, poll, setting applied to every post, snippet, closing-post template at 11 / at 5 undoes and redoes as one step and puts the caret back); Refine undo in `write.spec.ts` | Done |
| 7 | Emoji, combining characters, URLs, multiline counts | One rule a side: `platformCaptionLength` (composer) and `draftPostLength` (Go). X: twitter-text's weighted count of the trimmed text, every link 23; Bluesky and Mastodon: grapheme clusters (Unicode 17 in Go, Node and current browsers; an older browser can count an Indic conjunct as two, never fewer); others: UTF-16 units. Mastodon's own rules count a link as 23 and a remote mention by its local part: we count both in full, so a link under 23 characters counts short | `server/internal/product/testdata/caption-length-cases.json`, read by `write-publication.test.ts` (the counter counts as Go does: …) and `TestDraftPostLengthMatchesTheComposer`; `write-publication.test.ts` (the over-limit mark starts where the counter passes the limit, on every channel); emoji and URL in `write.spec.ts` | Done; Deviation (Mastodon links and mentions) |
| 8 | Recover a backup makes a new draft | `RecoverContentDraftRevision` | `TestWriteWorkspace/recovering a backup…`, `write.spec.ts` | Done |
| 9 | Duplicate/copy: no published ids or jobs | Copy leaves posts, share and automation receipts behind | `TestWriteWorkspace/duplicates and copies…`, `write.spec.ts` (copy to a same-named set) | Done |
| 10 | Same-name sets distinct | Ids, not names | `TestWriteWorkspace/same-named sets stay apart…`, `write.spec.ts` (copy to a same-named set) | Done |
| 11 | Editing focus ≠ publishing enablement | Tab is UI state; switches are destinations | `write.spec.ts` | Done |
| 12 | X thread synced to LinkedIn: order and separators | Joined in order | `write-versions.test.ts`, `write.spec.ts` | Done |
| 13 | Manual LinkedIn version follows explicit policy | Manual body kept; divergence noticed; re-sync explicit | `write-versions.test.ts`, `write.spec.ts` | Done |
| 14 | Disable/re-enable platform keeps content | Versions persist while a destination is off | `write-versions.test.ts` | Done |
| 15 | Missing/expired connection blocks with reconnect path | Health from status and last 409 failure | `connectionHealth`; `blocking()` in review | Done |
| 16 | X entitlement from the account | `AccountStanding` | `TestWritePublishing/Premium is the account's…`, `TestPremiumReadsTheVerifiedSetting` | Done (fixture) |
| 17 | X Article alone | One X target, no thread or poll | `TestWritePublishing/kinds publish only…` | Done |
| 18 | Numbering counted; every combination | Labels at serialization | `write-numbering.test.ts` | Done |
| 19 | Mentions atomic | Inline void element; per-platform serialization | `social-mention.tsx`, `write-publication.test.ts` (mentions serialize…) | Done |
| 20 | LinkedIn poll validation | Question, lengths, 2–4 options | `write-publication.test.ts`, `TestWritePublishing/each platform's settings…` | Done |
| 21 | Poll/media conflict in editor, API and worker | Same rule in all three | `capabilities.ts`, `content_draft_options.go`, adapter | Done |
| 22 | PDF first/last page, count, size, failure | Carousel navigation; 300 pages; 100 MB; failed upload marked | `TestPDFPageLimit`, `pdf-carousel.tsx` | Done |
| 23 | Upload failure preserves text | Asset marked FAILED; publish refuses missing media | `TestVerifyAssetBytes`, `draftMedia` | Done |
| 24 | Media reorder/move keeps identity and alt text | Alt text lives on the asset | `TestWritePublishing/an image's description…` | Done |
| 25 | Preview renders mentions, quotes, truncation | Annotations shown as names; "more" cut-off | `preview.tsx`, `write.spec.ts` | Done |
| 26 | Internal metadata never in payloads | Title/scratchpad not serialized | `write.spec.ts` (scratchpad absent from captions) | Done |
| 27 | Planned dates never publish | No scheduled post for a plan | `TestWriteWorkspace/a planned draft has no scheduled post`, `write.spec.ts` | Done |
| 28 | Confirming a plan schedules the instant | Plan cleared on schedule | `TestWritePublishing/scheduling a planned draft clears its plan` | Done |
| 29 | Editing slot templates leaves scheduled times | Slots are the set's (RFC 024), read only when a post is queued; a queued post stores its slot and instant | `TestSocialSetsPlatform/a queued natural time is stored, replayed and kept when the template changes` | Done |
| 30 | DST gaps and repeats deterministic | Explicit earlier/later or refusal | `TestResolveLocalTime`, `write-zoned-time.test.ts`, `TestAutomationPlan` | Done |
| 31 | Natural offset stable | RFC 024's offset from the draft, version and base instant, stored with the post | `TestNaturalOffsetIsBoundedAndStable`, `TestSocialSetsPlatform` | Done |
| 32 | Concurrent next-slot requests | Advisory lock per workspace | `TestWritePublishing/simultaneous queue requests…` | Done |
| 33 | Shortcuts cannot bypass validation | Shortcuts open the review only | `shortcuts.ts`, `blocking()` | Done |
| 34 | Double publish or retry: no duplicate | Idempotency key per version; retry once | `TestWritePublishing/publish now…`, `…/a failed destination…` | Done |
| 35 | One platform fails: retry only that one | Per-destination retry | `TestWritePublishing/a failed destination…`, `write.spec.ts` | Done |
| 36 | Partial X thread failure policy | Progress kept; "Post the rest" resumes after the last live reply (no rollback of live parts) | `TestContentDraftPlatform/a stopped thread resumes from its last live reply`, `content-drafts-platform.spec.ts` | Done |
| 37 | Cancel racing a worker is reconcilable | Unknown outcomes need a person; reconcile | `TestWritePublishing/a failed destination…` | Done |
| 38 | Internal links respect set access | Private sets hidden from everyone but the owner | `TestWriteWorkspace/a private set's drafts…` | Done |
| 39 | Public link revocation | Token removed; shared route 404s | `write.spec.ts` | Done |
| 40 | Edits preserve anchors or mark orphans | Orphaned threads shown, not moved | `comments.tsx`, `write-versions.test.ts` | Done |
| 41 | Others' comments protected | `keepOthersComments` | `TestWriteWorkspace/an editor cannot erase…` | Done |
| 42 | Two editors cannot overwrite | Yjs merge; base version 409; a body replaced elsewhere keeps the local edit to use, copy or discard, and blocks review until then | `content-draft-collaboration.spec.ts`, `write-autosave.test.ts`, `write-editing-regressions.spec.ts` | Done |
| 43 | Losing access stops saves and publishing | 403/404 stop autosave; set check on every mutation | `TestWriteWorkspace/a private set's drafts…`; collaboration rechecks visibility on every load and store (`collabClaims`) | Done |
| 44 | Copy does not copy public grants or discussions | Share token and discussions not copied | `TestWriteWorkspace/duplicates and copies…` | Done |
| 45 | AI cancel leaves text; accept undoable | Preview first; one batch | `write.spec.ts` | Done (scripted model) |
| 46 | AI scope respected | Selection, post or version only | `refine.tsx`, `write.spec.ts` | Done (scripted model) |
| 47 | AI output validated | Server checks limits; composer re-validates | `lib/write/refine.ts` | Done |
| 48 | Retweets wait for publication, not duplicated | Planned after publish; receipts | `TestRunAutomation`, `TestPostWorkflowV2RunsAutomationsAfterPublishing` | Done (fixture) |
| 49 | Auto-Plug once | One receipt key; settles on success | `TestRunAutomation` | Done (fixture) |
| 50 | Auto-DM any/all, dedupe | [Who can receive a DM](auto-dm-policy.md#who-can-receive-a-dm) and [de-duplication](auto-dm-policy.md#de-duplication) | `TestAnyOrAllMatchesTheSelectedActions`, `TestEligibilityNeverInfersConsentAndStopsAtExpiryOrOptOut`, `TestDeliveryGateConcurrentDedupeAndUnknownOutcome`, `TestDurableClaimsSurviveConcurrencyRestartAndUnknownOutcome` | Done (local rules); live sending Gated (§23) |
| 51 | DM quota and expiry | [Rate limits](auto-dm-policy.md#rate-limits) and [quota and expiry](auto-dm-policy.md#quota-and-expiry), checked again when a send is claimed | `TestDurableRollingQuotasIncludeUncertainReservations`, `TestLimitsNeverExceedTheProductCaps`, `TestAnyOrAllMatchesTheSelectedActions` (window), `TestDurableConsentOptOutCancellationAndTenantIsolation` (expired, cancelled, removed) | Done (local rules); live sending Gated (§23) |
| 52 | Disabling stops pending work, keeps completed | Cancel keeps removals of reposts already up | `TestWritePublishing/follow-ups are checked…` | Done |
| 53 | Nested dialog returns focus | Auto-DM settings opens from a `DialogTrigger`, so Radix returns focus to it; the publish review, the schedule sheet, the palette and the shortcut reference open from state or a shortcut, and put focus, and a caret, back where it was (`useLauncherFocus`) | `write.spec.ts` (closing a dialog opened from a dialog returns focus to each launcher in turn) | Done |
| 54 | Shortcuts do not publish from fields/modals | `owned()` check; publish keys open review | `shortcuts.ts` | Done |
| 55 | Tooltips match actions | Icon buttons carry the same label and title | `WriteComposer.tsx` | Done |
| 56 | No placeholder text in loading states | Loading copy is product copy | components | Done |
| 57 | Validation clears with the cause | Problems derive from the current publication | `buildPublication` | Done |
| 58 | Previews do not look like analytics | "Preview — not published", no numbers | `preview.tsx`, `write.spec.ts` | Done |
| 59 | Empty, error, permission states distinct | Separate copy per state | `library.tsx`, `useDraftDocument.ts` | Done |
| 60 | Narrow layouts keep review identity and destructive labels | Drawer library; sheet panels; review lists accounts; Schedule stays in the header and the schedule dialogs fit 390 px | `write.spec.ts` (narrow), `docs/product/qa-evidence/2026-11-02` | Done |

## Provider verification

| Behavior | Fixture evidence | Live status |
|---|---|---|
| X posts, threads, reply settings, community, disclosures, quote, polls | Adapter tests against a recorded X server (`x_test.go`) | Blocked: no X developer app with write access in this environment |
| X Article draft and publish | `TestArticleSettings` | Blocked: needs an X Premium account |
| X repost, removal, engagement, plug reply, alt text | `TestFollowUps`, `TestAltTextGoesOnTheMedia` | Blocked: as above |
| LinkedIn visibility, polls, documents, reshare, alt text, first comment | `linkedin_test.go`, `TestPostContentAltText`, `TestAutomationPlan` | Blocked: no LinkedIn app with Community Management API access |
| Mentions lookup (X username, LinkedIn company) | `TestMentionQuery`, `TestWritePublishing/mentions are looked up…` (fake finder) | Blocked: as above |
| Auto-DM | `direct_message_test.go` (refuses while off), `autodm` ledger tests | Gated: the X connection is authorized without direct-message access; the [consent and abuse policy](auto-dm-policy.md) is approved, and turning sending on needs its own approval |
| AI Refine, assistant | Scripted model (`PLATFORM_AI_SCRIPTED=1`) | Blocked in CI: no model key; works with `OPENROUTER_API_KEY` |

A fixture passing is not a live claim: every row above stays Blocked until it is run
against a real account.

## Integration with the settings platform (#228)

PR #228 (RFC 024, settings platform) merged first, with its own
`social_set` model. Write is built on it; nothing of Write's earlier set
model is left.

1. **Sets.** RFC 024's `social_set` is the only one: accounts join a set
   through `channel_connection.socialSetId` (one active account per
   platform), sets are `WORKSPACE` or `PRIVATE` to an owner, and drafts
   reference them by `(organizationId, socialSetId)`. Write's switcher reads
   them and links to the set's settings pages for creating and editing.
   Write's member lists and set preferences are gone.
2. **Drafts.** RFC 024's `socialSetId`, `primaryPlatform`,
   `naturalPostingTime`, `engagement` and `plannedFor` columns are used as
   they are. Write adds kinds and targets, platform versions, articles,
   scratchpad, pins, plan zone, sources, finishers, follow-up receipts,
   backups with reasons, mentions and alt text
   (`20261030090000`–`20261030090300`, after `20261029090000`).
3. **Tags** are records of a set (`content_draft_tag`). The migration moves
   RFC 024's string tags into them and drops `content_draft.tags`. The
   `draft-tags` experiment gate stays on every tag change, and
   `draft.tags_changed` carries tag ids and names.
4. **Planning** is promoted: RFC 024's `draft-planning` experiment is on for
   every workspace with drafts, with no opt-in and no switch to turn it off
   (`TestWriteWorkspace/planning is promoted…`).
5. **Follow-ups.** A draft's X follow-ups default to the engagement it copied
   from its set (repost and plug at a like count). A plug saves back as the
   set's engagement default; timed reposts stay the draft's own.
6. **AI.** Refine and the assistant send the draft id. The backend merges the
   workspace brand with the set's Writing Assistant (`GET
   /v1/content-drafts/{id}/writing-context`), and the web fences it
   (`voiceInstructions`, tested in `settings-platform-web.test.ts`).
7. **Scheduling** uses the set's slots, natural offsets and time zone (RFC
   024). Write adds publish-now and local times resolved in Go.


