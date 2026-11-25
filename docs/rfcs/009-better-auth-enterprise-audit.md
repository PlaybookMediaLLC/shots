# RFC 009: Better Auth, Enterprise Access, and Audit Logging

**Priority:** 009 — Reusable foundations
**Previous ID:** 003 ([renumbering map](renumbering-2026-10-24.md))
> **Roadmap disposition (2026-10-23):** Reusable foundation. Maintain identity, tenant boundaries, human decision authority and audit behavior.
> See the [current execution order](README.md). Older decision text is
> historical wherever it conflicts with that order or the audited architecture.

**Status:** Partially implemented
**Status note (2026-10-16):** Mostly shipped. Missing: the support-grant approval flow, required TOTP, and a database-enforced append-only audit log.
**Date:** 2026-08-14
**Historical dependencies:** RFC 010
**Owners:** Engineering and Security

## Decision

Adopt Better Auth with the Prisma adapter and PlanetScale Postgres. Use the
organization plugin as the tenant boundary, the API key plugin for
organization-owned machine credentials, and custom organization roles for
Screenshot Studio permissions.

Require TOTP two-factor authentication for privileged roles. Offer SAML/OIDC
SSO and SCIM provisioning only to enterprise organizations that need them.

Use two audit systems:

1. Better Auth Infrastructure audit logs and log drains, if its paid
   Infrastructure service is selected, for authentication and provider events.
2. Screenshot Studio's append-only `AuditLog` for application, support,
   capture, approval, scheduling, and publication events.

The application audit log is mandatory. An identity provider cannot prove what
happened to a release or asset, and vendor audit retention is plan-dependent.

## Why Better Auth

The application is Next.js and Prisma. Better Auth provides a Prisma adapter,
organization membership, role-aware organization APIs, TOTP, SSO, SCIM, and an
optional Infrastructure layer. It keeps identity configuration in the
TypeScript codebase and avoids building a separate identity service.

This RFC does not commit the product to Better Auth Infrastructure pricing or a
hosted identity database. The paid Infrastructure service is an optional
enterprise layer over our Better Auth deployment and PlanetScale data.

## Authentication paths

| Path | Availability | Policy |
| --- | --- | --- |
| Email and password with verified email | General availability | Rate-limit sign-in and reset; verify before accepting an invitation |
| Social sign-in | General availability | Google, Microsoft, and GitHub; never bypass organization membership |
| Organization API key | Core MVP | Scope to intake and upload actions; show the raw key once and allow rotation or revocation |
| TOTP two-factor authentication | Required for owner, admin, publisher | Provide recovery codes; require a fresh session to view them |
| SAML 2.0 or OIDC SSO | Enterprise add-on | Configure and activate per organization after test sign-in |
| SCIM 2.0 | Enterprise add-on | Scope to one organization; restrict connection management to approved admins |

Do not add anonymous auth, multi-session switching, or a custom identity
provider in the first release. Each needs a defined customer workflow,
permission model, and audit contract.

## Organization and authorization model

Better Auth's organization plugin creates organizations, membership, and
invitations. A session selects an active organization. Screenshot Studio
resolves that active organization on the server and checks the membership role
before every tenant action.

| Role | Permissions |
| --- | --- |
| `owner` | Billing, organization deletion, configure SSO/SCIM, assign roles, view all audits |
| `admin` | Invite members, manage brand and channel configuration, manage releases |
| `creator` | Create releases, run permitted recipes, edit variants |
| `approver` | Approve or reject variants and view lineage |
| `publisher` | Schedule and publish approved variants through authorized connections |
| `viewer` | Read permitted releases, assets, and audit history |

These are least-privilege defaults. Future enterprise roles map to named
permissions, never unchecked role strings. Each protected action requires:
authenticated session, active organization, membership, required permission,
and an organization-scoped data query.

Invite acceptance requires verified email. Organization creation is enabled
only for the chosen self-serve plan; otherwise onboarding creates it. Better
Auth supports organization hooks and verified invitation controls. See the
[organization plugin documentation](https://better-auth.com/docs/beta/plugins/organization).

## Organization API keys

Use Better Auth's API key plugin with `references: "organization"`. A key
belongs to the organization, not to the person who created it. The application
must map a key to explicit product scopes before a tRPC procedure can use it:

```text
release:create, source:write, asset:write, upload:sign, artifact:read
```

Do not allow an API key to invite members, manage SSO or SCIM, change billing,
create another key, publish a post, or delete organization data. A human
session with the correct organization role is required for those actions.

Owners can create, list, rotate, and revoke keys. Admins get those permissions
only when the organization role explicitly grants Better Auth's `apiKey`
permissions. Store a name, prefix, scopes, expiry, creator, last-used time,
and a redacted request ID in audit data. Never store or log a raw API key.

The tRPC `apiKeyProcedure` validates the key once, resolves its organization,
checks an action scope, applies a per-key rate and byte quota, and adds
`actorType = service` to the audit context. Do not enable Better Auth session
mocking for API keys; an organization key must not impersonate a user. Better
Auth documents organization-owned keys, organization RBAC, and this session
restriction in its [API key documentation](https://better-auth.com/docs/plugins/api-key/advanced).

## Session and sign-in controls

- Keep server auth configuration and client auth configuration in separate
  modules.
- Set explicit production trusted origins. Do not trust an unvalidated host
  header as an origin.
- Use HTTPS-only secure cookies in production and fixed environment-specific
  base URLs and redirect targets.
- Rate-limit sign-in, password reset, invitation, and SSO callback endpoints.
- Require fresh sign-in plus TOTP for organization deletion, SSO/SCIM changes,
  support-grant approval, and credential rotation. A fresh sign-in is less than
  15 minutes old.
- Accept a sign-in up to 24 hours old, plus TOTP, to connect or reconnect a
  social channel. A stolen session of that age can then connect a channel.
- Revoke active sessions after password reset, role removal, support-grant
  revocation, or account-compromise response.
- Make trusted devices visible and revocable in account security settings.

Better Auth's 2FA plugin supports TOTP, recovery codes, and trusted devices.
See the [2FA documentation](https://better-auth.com/docs/plugins/2fa).

## Enterprise SSO and SCIM

Enable enterprise identity features per organization, not globally.

1. An owner configures an OIDC or SAML connection, completes a test sign-in,
   and explicitly activates it.
2. The connection maps a verified identity to the intended organization and a
   conservative default product role. IdP claims cannot grant owner access.
3. A SCIM connection may create, update, and remove members only within its
   organization. Deprovisioning revokes sessions and future task access.
4. Keep a separately audited break-glass owner using TOTP until the customer
   verifies a recovery path.

Use `@better-auth/sso` for SAML/OIDC and `@better-auth/scim` for provisioning.
Both are now gated by organization enterprise settings. Better Auth documents organization-scoped
SCIM controls and its default owner/admin requirement in the [SCIM
documentation](https://better-auth.com/docs/plugins/scim). Validate SAML
timestamps, issuer, audience, redirect URLs, and trusted origins before
enterprise release.

## Audit design

### Event contract

A sensitive action writes an `AuditLog` row in the same PlanetScale transaction
as its state change. The row has:

```text
id, organizationId, createdAt, requestId,
actorType, actorUserId, actorDisplay,
action, outcome, entityType, entityId,
ipHash, userAgentSummary, metadata
```

`actorType` is `user`, `service`, or `support`. `metadata` is structured,
allow-listed, and redacted. It must never include passwords, cookies, OAuth
tokens, SSO assertions, full IP addresses, signed URLs, or browser step input.
Hash IP addresses with a rotating service secret when correlation is required.

| Event family | Examples |
| --- | --- |
| Authentication | `auth.sign_in.succeeded`, `auth.mfa.enabled`, `auth.session.revoked` |
| Access | `member.invited`, `member.role_changed`, `sso.activated`, `scim.user_deprovisioned` |
| Product | `release.created`, `capture.queued`, `capture.completed`, `variant.exported` |
| Governance | `approval.granted`, `approval.rejected`, `support_access.granted`, `support_access.revoked` |
| Distribution | `post.scheduled`, `post.publish_started`, `post.published`, `post.failed` |

A correction is a new event that references the original event ID. The
application database role cannot update or delete audit rows. Audit reads are
tenant-scoped and available only to owner and authorized admin roles.

### Trigger.dev service actions

Trigger.dev tasks use `actorType = service` and include the Trigger task run ID
in redacted metadata. A task receives IDs and an idempotency key, not a user
session, token, or browser secret. It re-reads current permissions and state
from PlanetScale before it starts a capture or post. Each external side effect
writes a `PublicationAttempt` or capture state and a corresponding audit event.

This prevents a delayed task from publishing content after approval was removed
or an organization member was deprovisioned.

### Better Auth Infrastructure

If the enterprise plan uses Better Auth Infrastructure, configure its `dash()`
plugin and log drain for authentication events, suspicious activity, and
provider-level audits. Its dashboard, SSO, SCIM, and retention are vendor
capabilities that may vary by plan. Screenshot Studio `AuditLog` remains the
system of record for product activity.

Vendor references: [Infrastructure introduction](https://better-auth.com/docs/infrastructure/introduction),
[audit logs](https://better-auth.com/docs/infrastructure/plugins/audit-logs),
and [log drains](https://better-auth.com/docs/infrastructure/plugins/dash).

### Retention and export

- Keep application audit logs for 90 days by default. Enterprise tenants can
  configure a longer period, including two years, or set a legal hold.
- Send a redacted event copy to an enterprise SIEM through `AuditOutbox`.
  Trigger.dev retries delivery; a log-drain failure does not block a customer action.
- Organization deletion retains only legally required audit evidence. Media and
  credentials never appear in audit data.

## Support access

There is no permanent global support role. A customer owner must approve a
time-bounded `SupportAccessGrant` with a purpose and scope. The default is
read-only metadata. Media download, publishing, SSO changes, and secret access
are excluded.

Support access is checked on every request, expires automatically, is revocable
by the customer, and creates `support.*` audit events. Break-glass use requires
an incident ID, short expiry, and review after the incident.

## PlanetScale and Better Auth migration

1. Create PlanetScale Postgres development and production branches and
   least-privilege roles.
2. Add Better Auth and the Prisma adapter. Configure it with PostgreSQL and
   the selected core, organization, organization-owned API key, and 2FA
   plugins.
3. Run `npx auth@latest generate` and review the generated Prisma models.
4. Add the application models from RFC 010, then produce a normal Prisma
   migration on a PlanetScale development branch.
5. Test sign-in, organization isolation, privileged TOTP, and audit failures.
6. Apply the reviewed migration to the PlanetScale production branch, record
   the result, deploy the code, then enable SSO and SCIM behind an enterprise
   entitlement.

The Better Auth Prisma adapter explicitly supports schema generation but not
Prisma schema migration. Do not use `auth migrate` against this Prisma project.
See the [Prisma adapter documentation](https://better-auth.com/docs/adapters/prisma).

## Acceptance criteria

- A user with no active organization cannot access tenant data.
- A member of organization A cannot access organization B by changing an ID.
- A revoked, expired, unscoped, or organization-B API key cannot access
  organization-A data or sign an upload.
- Owner, admin, and publisher accounts cannot perform privileged actions without
  TOTP after enforcement.
- Invitations require verification for the invited email identity.
- SSO/SCIM changes, role changes, captures, approvals, scheduling, publishing,
  Trigger service actions, and support access all create tenant-scoped audits.
- An audit write failure prevents its sensitive state change.
- Secrets and authentication artifacts are absent from audits, Trigger payloads,
  task logs, and application logs.
- SCIM deprovisioning promptly revokes sessions and blocks future task actions.
