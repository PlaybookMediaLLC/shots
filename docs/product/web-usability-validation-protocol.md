# Web usability validation protocol

This protocol implements the baseline and study preparation in D1/B3 of the [audit plan](web-usability-audit-and-plan-2026-11-20.md). It contains no customer observations. Product owns recruitment and interpretation; Engineering owns event validation and reproducible technical checks. The [implementation ledger](web-usability-implementation.md) records which gates have actually passed.

## Baseline before changing Home's primary task

Recruit five to eight consenting participants across new release owners, returning reviewers, and current creative/publishing users. Record role, plan, relevant flags, viewport, experience with Shots, exact deployed revision and study date. Use each participant's authorized workspace and their chosen non-sensitive source material. Keep identity and recordings in the customer-approved private research store; use a study ID in the report.

Observe the current experience before showing a release-oriented prototype. Do not explain navigation or product terminology first. Read the same tasks in both sessions. Counterbalance task order where prior learning would change the result. Record assistance separately from completion. Small qualitative samples identify failures; they do not establish conversion uplift.

| Task              | Prompt                                                                                | Observable completion                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| First release     | Bring in a recent meaningful product change and prepare work someone else can review. | Saved release/campaign with correct source context; participant can identify the next review step. Profile confirmation alone is not completion. |
| Resume            | Return to the work you started and identify what remains.                             | Correct saved item and authoritative stage located without assistance.                                                                           |
| Review            | Check the material and decide whether it can move forward.                            | Participant distinguishes a draft, explicit approval and delivery; the intended current version is reviewed.                                     |
| Find older work   | Find a named item outside the recent list.                                            | Correct owning collection or search result; correct workspace and item.                                                                          |
| Recover           | Continue after a saved response is lost or a conflicting edit is detected.            | Same saved creation, or explicit conflict resolution; no duplicate or silent loss. Use test data for fault injection.                            |
| Standalone visual | Make and save a visual without starting a campaign.                                   | Saved visual found again in its actual storage scope.                                                                                            |
| Standalone post   | Draft a post and return to it later.                                                  | Same persisted draft recovered; scheduling remains a separate explicit action.                                                                   |

Per task record: start/end timestamps, completed/assisted/abandoned/not-applicable, wrong destinations, misunderstood terms, observed failure, recovery, and a private evidence reference. A permission denial is not abandonment by an eligible actor. Preserve unsuccessful and incomplete sessions in the denominator. Separate first-time and returning users and release versus standalone intent.

## Minimal outcome definitions

| Measure                          | Denominator and observation                                                                                  | Missing evidence                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| First useful result              | Eligible workspaces starting a chosen journey; first saved inspectable artifact in that journey.             | No baseline yet. Join persisted resource/audit timestamps with consented journey intent; a generation event is insufficient. |
| Time to result                   | Observed journey start to persisted useful result, plus assistance time.                                     | Report observed count and missing starts; do not substitute zero.                                                            |
| Resume/recovery                  | Returning or fault-exposed participants; correct item and valid next action without lost/duplicate work.     | Study observations first. Search clicks alone do not prove recovery.                                                         |
| Release to explicit approval     | Real release-ready timestamp to first human approval of the exact artifact version.                          | Readiness timestamps are not yet native. Use RFC 001 ledger; retain pre-release approvals and missing timestamps separately. |
| Repeat use and audience adoption | Eligible qualified release cohort and required audiences.                                                    | RFC 001's exact approval → handoff → use chain is required. A sent post or download is not adoption.                         |
| Support and conversion           | Help per completed journey; eligible pilot/trial cohort with known exposure and actual paid/renewal records. | Support tags and a valid cohort baseline are absent. UI changes alone cannot establish revenue causation.                    |

Use the existing consent-aware PostHog utility for browser telemetry. Do not send source text, URLs, error bodies, customer names, or private evidence to analytics. Record bounded outcome/category values. Server audit and persisted domain records remain the authority for creation, decisions and delivery. Consent withdrawal means missing browser observations, not failed tasks. Localhost deliberately emits no analytics, so local tests cannot prove deployed event ingestion.

The onboarding funnel records product-start and profile-confirmation events. `onboarding_campaign_ready` historically represented the old automatic chain and must not be compared as the same outcome after explicit review replaces it. New creation and resumed events use the backend's persisted creation outcome; failure is recorded separately. Duration measures that submission attempt, not total time to a useful result. A response lost after commit can leave no browser creation event, so reconcile with persisted creation/audit records rather than treating telemetry as a complete census. Validate with a consenting deployed test workspace before establishing a baseline.

## Pilot and rollout decisions

1. Complete local failure/permission/browser checks and independent feature-flow review for each slice.
2. Verify the exact deployed revision and configuration in an authorized internal workspace. Capture screenshots at phone, tablet and desktop sizes, keyboard focus/return, 200%/400% reflow, loading and partial failure. Record actual screen-reader and physical-touch checks separately.
3. Run the baseline tasks; then test a non-mutating release-oriented Home prototype. Keep standalone tools visible and avoid any claim that current campaign stages equal verified release readiness.
4. Record each observed problem, its evidence, severity, correction and retest result. Decide whether to continue, revise or stop the Home pilot. Do not promote a changed default based only on screenshots or code tests.
5. For a selected pilot cohort, compare the same definitions at the same follow-up age. Report counts, denominator, missingness, assistance and guardrails before setting numerical targets.

Stop rollout on silent loss, implicit approval, tenant leakage or duplicate external effects. Revert navigation/entry changes while preserving saved records and audit history. Provider ambiguity remains `UNKNOWN_DELIVERY` until reconciled. Qualification, kits, handoff and freshness follow RFC 002–006 gates; a study cannot waive their authorization or exact-version requirements.

## Evidence manifest template

Store one manifest with the private study/report export: metric-definition version, input hash, deployed revision/configuration, cohort definition, UTC as-of cutoff, follow-up days, scenario/task IDs, observed/missing counts, and private evidence references. For the assisted pilot, use the [offline JSONL schema/report](pilot-ledger.md) for RFC 001 slice A; do not commit customer records here. Reproduction of a synthetic report and observation of customer outcomes are separate gates.

Current decision: baseline collection and the Home pilot have not occurred. No conversion, revenue, adoption, accessibility or usability improvement is claimed by this protocol.
