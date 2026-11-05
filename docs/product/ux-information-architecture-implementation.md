# UX information architecture implementation

Implemented locally on October 22, 2026 against `6447f4edc95a2ac6b41e412a2176e305e13db301`. This is the delivery record for [the redesign specification](ux-information-architecture-redesign.md); the original audit remains a historical record. This document describes source implementation and local verification, not a production deployment.

## Delivered scope

| Specification | Implementation                                                                                                                                                                                                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01           | Removed the coordinated PostCSS zoom transform and 80% shell scaling. Management UI uses explicit 14px sizing and existing semantic surface, border, focus and spacing tokens. Export geometry stays in the native renderers.                                                                             |
| F02           | Lucide icons in primary navigation, shared controls and touched fork surfaces. Direct imports retain accessible control names. Provider marks and upstream editor icons remain; no dependency upgrade or premature legacy-package removal.                                                                |
| F03           | Existing Page/Section/Row primitives, bounded settings forms, distinct loading/error/empty states, and explicit workspace/local save labels. Review, readiness and delivery have separate labels.                                                                                                         |
| F04           | Source, unsupported-format and render failure states are distinguishable. Safe retry remounts previews, originals remain reachable, and no retry rewrites the document.                                                                                                                                   |
| S01           | Home plus Create, Campaigns, Publish, Library and Automate. Workspace selector above; Activity, Settings and account below. New users get labels; explicit compact/dynamic/expanded preferences survive. Mobile navigation closes on selection.                                                           |
| S02           | One shell navigation owner, skip link and content target. Editor focus mode remains. Workspace switching waits for saves or refuses dirty/busy work, clears tenant query state and reloads authorized context.                                                                                            |
| S03           | Home uses bounded project/Canvas/draft reads with partial-failure recovery and the existing authorized notification inbox for attention. Original document URLs and browser-local scope remain explicit. Auth without an explicit return destination lands on Home.                                       |
| S04           | Typed New chooser and one Ctrl/Cmd+K owner. Publish delegates to its existing object-aware command palette; other areas start with destination search. Existing tenant-authorized queries, error handling and publishing scope are retained.                                                              |
| P01           | Create starters; Library projects, assets, templates and brand resources. Screenshot, Canvas, Story Set and browser-local Store collections reuse their existing storage and original editors. Restricted Story Set creation remains explained.                                                           |
| P02           | Publish groups Drafts, Calendar, Campaign deliveries and Link checks. Publishing-brand scope persists across writing/calendar navigation. Campaign posts retain their own review and delivery model.                                                                                                      |
| P03           | Campaign Release inbox and local navigation, including archived collections. Brief/evidence, plan, visuals and content/review retain existing routes. Delivery links select the original channel and post hash. Approval never implies delivery readiness.                                                |
| P04           | Automate separates Overview, Workflows, Repositories, Runs and Deployments. Both new blank graphs and saved definitions use a full-page workspace inside the shell. Save, Test, Activate, validation, history and archive remain distinct. Mobile switches between canvas and inspector.                                              |
| P05           | Attach from Library inserts an existing immutable media asset through native draft serialization, with a current-access check and a recoverable stale/deleted error. Canvas creation is labeled as a copy; native lineage and source approvals remain intact. Setup links carry validated return context. |
| P06           | Library Brand resources links to existing voice/visual-kit/product configuration. Publishing brands and local Store kits are labeled separately; existing save paths, inheritance and pinned versions are retained.                                                                                       |
| R01           | Task starters, first-use/filter-empty states, eligibility hints and actionable setup destinations. No new analytics or invented readiness metrics.                                                                                                                                                        |
| R02           | Settings uses a searchable section sheet on narrow screens. Responsive job navigation and one workflow panel at a time; local editor panels retain their specialized behavior.                                                                                                                            |
| R03           | Shell shortcut ownership, visible focus, focus-return recovery after rename/filter removal, mobile validation focus, reduced-motion handling and keyboard regression coverage. Manual assistive-technology certification remains a release check below.                                                   |
| R04           | Native-editor, export, persistence, approval, authorization, scope-switch and deep-link regressions exercised locally. Reversible rollout procedure below; production revision/live verification remain separate.                                                                                         |

## Compatibility and boundaries

- Root screenshot editor and `project`, `editor`, `storeProject` query links remain valid. `/editor` aliases and legacy query-bearing `/home` links preserve parameters, including localized bookmarks. Plain `/home` is the new landing page.
- `/projects`, `/assets`, `/drafts`, `/write`, `/canvas`, `/creative-sets`, `/store-screenshots`, campaign sections/hashes, `/workflows#sources` and `/workflows?view=sources` remain usable and open Repositories at `/workflows/sources`, where GitHub also returns.
- Existing editor documents, local IndexedDB, artifact identifiers, revision checks, queue semantics, approval hashes and provider adapters were not replaced. There is no new database schema or data migration.
- The web continues to use the Go backend through existing contracts and SDK paths. New UI queries do not establish a second authorization system. Feature availability still comes from existing server access checks.
- A universal object index, combined campaign/draft calendar, Store cloud synchronization, new analytics and external provider integrations remain separate projects, as permitted by the specification.
- Two defects encountered during verification were corrected: timezone selection no longer accepts an empty hydration event, and renaming a filtered project returns focus to search when its row disappears.

## Verification

Local stack: Next.js on port 3180, isolated Go backend, Postgres, Redis, object storage and collaboration service. Disposable test accounts/data and protocol fixtures were used. No customer account, real social publication or production data was used.

| Check                                   | Result / coverage                                                                                                                                                                                                                                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full unit/workspace suite               | 1,038 passed; one pre-existing collaboration skip. Includes web/database and API contract boundary checks.                                                                                                                                                                                          |
| Go preference regression                | `TestNavigationPreferenceDefaultsAndExistingValues` passed: expanded default and all persisted layout choices.                                                                                                                                                                                      |
| Review                                  | Final CodeRabbit review covered 124 changed files and reported zero findings.                                                                                                                                                                                                                       |
| Repository checks                       | All 17 RFC verification checks passed. The full format check reports one existing violation in unchanged `test/e2e/notification-recovery.spec.ts`; changed scoped files were formatted.                                                                                                             |
| ESLint and TypeScript                   | Passed; ESLint prints its existing React-version configuration notice.                                                                                                                                                                                                                              |
| Production builds                       | Baseline and redesigned builds completed. Existing media-library dynamic-import and circular-chunk warnings occur in the baseline as well.                                                                                                                                                          |
| New platform E2E                        | Seven journeys passed: jobs/commands/deep links, mobile settings and local storage scope, Automate/releases/preferences, native asset attachment and deletion rejection, preview retry without mutation, localized/light/RTL/reduced-motion reflow, workflow save/test/validation/dirty navigation. |
| Navigation and project library          | Warm navigation request-count test and all three library regressions passed. One initial list request, zero extra warm-return request, one rename invalidation.                                                                                                                                     |
| Screenshot persistence                  | All four project journeys passed, including autosave/reopen/version, recovery, conflict copy, duplicate/delete and tenant privacy.                                                                                                                                                                  |
| Canvas                                  | All five core journeys and all three regressions passed: native editing, exact exported sizes/ZIP, source campaign approval preservation, interrupted save/conflict, tenant isolation, undo/Escape/save-before-navigation, duplicate/archive/restore.                                               |
| Store screenshots                       | Save/undo/reload/exact export size, review/comment/revoke and forged-link rejection passed.                                                                                                                                                                                                         |
| Publishing and campaigns                | Existing draft scheduling/queue/calendar, approval invalidation, guest/mobile comments, replies, Markdown/DOCX and AI-tool journeys passed. Both campaign workflow journeys passed.                                                                                                                 |
| Creative exports                        | Batch screenshot export, branded bento/variant multi-size export and redacted-share OCR/detector checks passed.                                                                                                                                                                                     |
| Workspace and settings                  | Shell bootstrap, workspace creation/switching, authorization revocation, settings save/discard and security freshness checks passed.                                                                                                                                                                |
| Responsive and accessibility automation | 320, 390, 767, 768, 769, 1024 and 1440 CSS-pixel management widths; 640/320 reflow proxies for 200/400% zoom, light/dark, French labels, RTL and reduced motion; keyboard focus/escape and modal counts.                                                                                            |

The expanded release-automation worker/GitHub fixture suite was updated for the new navigation and page editor, but was not run with a live Temporal worker. The focused workflow test exercises the real backend save and preview operations and confirms that neither activates the definition.

Representative screenshots are saved locally in `.context/ux-redesign/`: `library-desktop.png`, `settings-mobile.png`, `create-mobile.png`, `library-light-rtl.png`, and `workflow-desktop.png`. Local logs in the same directory record builds, static checks, unit results and the final E2E/review runs. Screenshots include development tooling and are not production evidence.

### Bundle and request evidence

Both builds use the same installed dependencies and webpack production configuration. The figures below are the gzip sum of the unique JavaScript chunk references in each route's client-reference manifest. Shared/lazy references are included; these are comparable build-footprint bounds, **not** measured first-load bytes or latency. Shared chunks are counted once within each route, not across rows.

| Route             | Baseline KiB | Redesigned KiB | Change KiB |
| ----------------- | -----------: | -------------: | ---------: |
| Projects          |        784.8 |          787.6 |       +2.8 |
| Settings          |        921.6 |          932.7 |      +11.1 |
| Publish           |        840.2 |          848.3 |       +8.1 |
| Automate          |        843.8 |          852.4 |       +8.6 |
| Canvas collection |        778.2 |          785.8 |       +7.6 |
| Home (new)        |            — |          817.7 |          — |
| Library (new)     |            — |          824.4 |          — |

The navigation regression confirms list-cache reuse after returning from an editor. No claim of user task-time improvement or production latency reduction is made.

## Release checks and rollback

The code implementation is ready for review. Before broad release, deploy the same reviewed web/backend revision to staging, record its SHA and repeat the saved-project, workspace-switch, publish prerequisites and export smoke journeys there. Existing feature flags and entitlements continue controlling restricted features. The new preference default requires the matching backend release; previously stored preferences remain unchanged.

Roll back by redeploying the previous web and backend artifacts together. The zoom CSS and PostCSS changes must move together; mixing generated assets from the two builds is unsupported. No data rollback is required: this change introduces no schema migration, document rewrite or local-storage migration.

Still required for launch acceptance: a real macOS VoiceOver pass and a second customer-relevant browser/screen reader; actual browser zoom and touch/keyboard-device checks; unfamiliar-user comprehension testing; staging/production revision recording and live smoke verification. Automated keyboard/reflow checks are evidence for implementation, not a substitute for these human and deployment checks.

## Template previews and scrollbar follow-up

Native scrollbar chrome is hidden globally, including nested containers and portals; overflow and native scrolling remain enabled. Appearance settings no longer offer a conflicting scrollbar toggle. The persisted API field is retained for compatibility.

Create and Library now share an on-demand visual catalog covering screenshot templates, animated posters, layouts and presets, Canvas recipes, built-in and locally saved Store templates, and all five executable workflow templates. Existing document, Canvas and Store renderers produce the previews. Workflow diagrams use the same graph builder as draft creation, and workflow design selectors show native design previews. Browsing creates or activates nothing.

The browser regression checks every layout/preset renders, each template family has a preview, workflow browsing leaves backend definitions unchanged, wheel and PageDown scrolling still work, and mobile templates do not overflow horizontally. The earlier bundle table predates this follow-up; it is not a measurement of the expanded catalog. The gallery module loads only when the Templates view is opened.

Follow-up validation: TypeScript, ESLint, targeted formatting and the production webpack build passed; the combined platform-redesign and Canvas-template browser suites passed all 11 tests. Build warnings remain in the existing media-processing dependencies. No deployment or manual Safari/touch-device verification was performed.

## Audit evidence closure

On October 26, 2026 each audit finding (S01–S18 in [section 2 of the specification](ux-information-architecture-redesign.md#2-current-shots-uiux-audit), with captures in [`ux-audit-evidence/2026-10-22/`](ux-audit-evidence/2026-10-22/)) was re-checked against `develop` at `6bbb39c6`. Findings that were already resolved are listed with the remaining gaps that this follow-up closed.

| Finding | Status after this follow-up                                                                                                                                                                                                                                                             |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S01–S02 | Already resolved: labeled job navigation, Home landing and preserved editor links. The editor keeps its compact rail by default; labels remain in tooltips.                                                                                                                             |
| S03     | The App Store studio menu and dialog now say “Projects in this browser”, so local projects no longer share the workspace Projects noun.                                                                                                                                                 |
| S04–S05 | Already resolved: zoom transform removed; preview loading, unsupported, source and render failures are distinct and retryable.                                                                                                                                                          |
| S06     | Story Sets now says “Create Canvas copy”, matching Projects. The copy flow is unchanged.                                                                                                                                                                                                |
| S07     | One `publishLinks` list (Drafts, Calendar, Analyze, Campaign deliveries, Link checks) is used by Write, Calendar, Analyze, Campaign deliveries and Link checks. Without content drafts, Publish opens Link checks instead of disappearing from the rail and search.                     |
| S08     | Already resolved; the empty Workflows state now links to Sources when no source is connected.                                                                                                                                                                                           |
| S09     | Already resolved. The Go backend enforces `creative-sets:create` on create and duplicate (`requireCreativeCreation`).                                                                                                                                                                   |
| S10–S11 | Already resolved: content-first settings section sheet; consistent account placement and separate workspace switching.                                                                                                                                                                  |
| S12     | Link checks results show Result, Previews, Fix and Share first. Basic tags, Open Graph, X, images, technical, automation and raw output are grouped as Advanced diagnostics. Result leads with the score and fixes, links to previews and fixes, then the JavaScript check and history. |
| S13     | The Activity releases empty state links to “Connect a release source”. Announcements still have no scheduling screen, so their API wording stays accurate.                                                                                                                              |
| S14     | Each campaign post shows a separate Scheduling pill (waiting for approval, blocked by review, no scheduling channel, ready without a visual, ready for a connected channel, or delivery status). “Approved revision” only appears while the post still rests on that approval.          |
| S15     | User-facing labels use “Publishing brand” for social sets and “Visual brand kit” for versioned kits across Write, publishing settings, brand settings, workflows, Canvas and the editor. Store studio’s local kits keep their separate label.                                           |
| S16     | Already resolved: truthful readiness states with setup details. A status filter was deferred; the directory has about eight entries.                                                                                                                                                    |
| S17     | The editor shortcut dialog returns focus to its launcher, covered by `editor-adversarial.spec.ts`. Write’s shortcut reference restores focus after the focus trap releases.                                                                                                             |
| S18     | Already resolved: one shell-level Ctrl/Cmd+K owner.                                                                                                                                                                                                                                     |

No schema, persistence, authorization or API contract changed. The human checks under “Release checks and rollback” still apply.

### Browser suite repairs

Running the affected Playwright specs surfaced failures that also occurred on `develop`. They were repaired rather than skipped:

- Stale selectors from earlier redesign work: `Remove screenshot`, `Select slide N`, `Saved to workspace`, `Saved on this browser`, `Settings sections`, the `Link checks` heading, the Library rail link and the shell search dialog width (`max-w-xl`). Editor section tests now use the remaining in-app path (the canvas App Store shortcut, browser Back, and Create on mobile) because the rail's Editor expander no longer exists.
- `test/e2e/framework/services.ts` reads `timestamp without time zone` columns as UTC, so database assertions no longer shift on a non-UTC machine.
- The Calendar acceptance test puts its posting slot on the planned day instead of a fixed Monday that may already be past.
- The failed-destination test seeds failures for posts a running worker has already claimed (`PROCESSING`); worker transitions are guarded on that status.
- The editor project button now shrinks and truncates its name instead of being clipped under the history toolbar at 1156 CSS px.
