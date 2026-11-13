# Workspace membership commands

Interactive role changes, removal and leaving now use the same Go commands from
both workspace/tRPC controls and Better Auth's HTTP and `auth.api` endpoints.
Ownership transfer uses the same transaction-time authority guard. The web does
not write membership rows or perform post-commit revocation for these commands.

## Authority and commitment

The transaction locks the workspace, acting session, user and membership before
checking current authority through a transaction-bound client. Target memberships
are locked before mutation. Invitation administration shares this lock order.
Authorization works with a one-connection pool and cannot depend on a stale HTTP
preflight result. API keys, support grants and service principals cannot use these
interactive membership commands.

- Role changes and removal require a current owner or administrator.
- Leaving requires the caller's current membership and session.
- Ownership transfer requires the current owner, a login no older than 15 minutes
  and enabled MFA, rechecked inside the transaction.
- Owners cannot be demoted through role editing, removed or leave directly. They
  must transfer ownership first. A transfer makes the former owner an admin.
- Concurrent transfers from the same owner cannot both succeed. Cross-workspace
  member IDs return no member metadata and do not mutate the foreign membership.
- Removal and leaving commit membership deletion, active-workspace session
  revocation, activity/outbox and audit together. Audit failure rolls back the
  mutation and revocation. A repeated desired role creates no additional event.

Better Auth retains its session and origin protections. Strict Zod inputs reject
forged actor fields, owner elevation and unsupported multi-role values. Email-based
removal resolves an opaque member ID through the authorized list, then Go rechecks
authority and scope when removing it. An uncertain response directs the caller to
refresh membership state instead of automatically replaying a mutation.

SCIM and enterprise provisioning still use their existing hooks and auth-store
path. Those hooks remain intact, including owner protection and revocation. This
increment does not claim to finish their separate transaction/capacity audit.

## Plans, downgrades and lapses

A team is a workspace, and each workspace has its own subscription. No plan
limits how many teams a person creates or joins; there is no Agency plan and no
team quota (Teams spec §8). Plans cap seats and social channels
(`server/internal/workspaceplan/capacity.go`) and stored bytes
(`storageLimits`), and set the monthly allowances (`planQuotas`). The billing
page shows what the backend's entitlement summary says a plan includes; pricing
pages read the same tables from `lib/billing/plans.ts`, which parity tests pin
to Go. A plan value the backend does not sell (billing sync refuses one) grants
nothing, whatever its feature overrides.

When a workspace downgrades, or its subscription is cancelled or its past-due
grace runs out:

- Members stay. A new invitation, or accepting a pending one, needs a free seat
  on the current plan.
- Connected accounts stay connected, and an account the workspace holds renews
  without a free slot while the plan stands. A new account, or restoring a
  removed one, needs a free channel slot, checked when the connection commits.
  While the plan does not stand, no account can be connected or reconnected.
- Stored files stay; a new upload needs room under the plan's storage cap.
- Posts already queued, which were charged against the monthly allowance when
  they were scheduled, still publish while their account's authorization holds.
  New posts need a plan that stands.
- Nothing is deleted or unscheduled automatically. Owners can remove members or
  accounts to get under a limit, and can unschedule posts themselves.

Tests: `TestDowngradeKeepsWhatExistsAndRefusesMore`,
`TestUnknownPlansResolveTheSameForUIAndServer`, `TestFeaturesFollowTheirMinimumPlan`,
`TestPlansHaveNoTeamLimit`, `TestInvitationConcurrentLastSeatAndTerminalStates`.

## Compatibility and rollout

There is no database migration, backfill, new secret or production setting.
Member responses add `organizationId` and `userId`; removal and leave responses
retain `removed: true` / `left: true` and add the member snapshot captured inside
the transaction. Better Auth preserves its existing member response shapes.
The backend SDK validates these responses with Zod 4. The public member-list
contract, OpenAPI document and generated client include the additive metadata.

Deploy every updated Go API replica before the new SDK/web build, since the new
reader requires the added fields. Roll back the web first if older API responses
must be restored. Retain the transaction-time authorization protections. Existing
session-bound collaboration checks continue to enforce revocation for open rooms.

The organization-plugin wrapper uses Better Auth's exported default-plugin type
and exact endpoint overrides. This avoids recursive inferred-type expansion in
TypeScript's incremental declaration cache while preserving the typed endpoints.
Normal and subsequent cached typechecks and the production build were executed.

## Executed verification

- `TestMembership*` checks current roles, expiry, bans, workspace switches, machine
  principals, foreign IDs, one-connection operation, concurrent demotion,
  concurrent ownership transfer, owner protection and rollback after audit failure.
  The focused race run passed in 7.670 seconds.
- Full serial `go test -p 1 ./...` passed all 124 tested packages against an isolated,
  migrated database; full `go vet ./...` passed. Focused invitation, configuration,
  role and comment regressions also passed.
- SDK build, generated API artifacts, format, lint, normal/cached TypeScript,
  production build and all 17 RFC checks passed. The JavaScript suite passed
  939 root tests, 9 collaboration tests using real Redis, and 21 editor tests.
  Six direct Better Auth creation/invitation/membership server checks passed.
- The new production-browser flow passed with three real sessions and PostgreSQL:
  role changes, duplicate-role no-op, owner protections, untrusted origin, wrong
  workspace, email removal, replay, leaving, stale-session refusal and exactly one
  audit for each action. Reload shows one remaining owner and no pending invites.
- The existing member-removal UI flow, two collaboration flows, four invitation
  flows, the role/billing sweep and three workspace-administration flows passed
  across completed runs: 12 distinct scenarios including the new flow.
- The populated member screenshots before/after removal were inspected in
  `.context/membership-before-removal.png` and `.context/membership-after-removal.png`.

Initial failures are retained in local evidence. A reused database exposed a
notification test's assumption that one bounded worker batch would reach its own
events. A fresh run also exposed webhook replay's application/database clock race.
The tests now wait for the exact expected receipts and actual HTTP attempt, keeping
their count, signature, retry and replay assertions. The final full Go run passed.
The original inferred plugin type overflowed cached TypeScript checks; the explicit
derived type fixed normal, cached and production builds without disabling checks.

Browser setup initially returned an invitation 503 after a 33.5-second API request,
then timed out loading the unrelated screenshot editor. The new membership test
now creates its fixture through real auth/workspace APIs and opens Members directly.
The separate UI onboarding/removal test passed. In the ten-scenario regression run,
nine passed and the cross-workspace setup timed out; that unchanged case passed in
the focused final run alongside the new membership flow (2/2, 22 seconds).

The build retains existing MediaPipe and circular-chunk warnings. Full `make e2e`
was not rerun; focused Playwright tests used the isolated runtime wrapper. T12/T16
remain open for media, audit, notification, provisioning and delayed-work boundaries.
Downgrade, pending-invitation and scheduled-work consequences are specified under
[Plans, downgrades and lapses](#plans-downgrades-and-lapses).
