# Authentication and enterprise access

Screenshot Studio uses Better Auth with PlanetScale Postgres. The application
uses the Better Auth organization ID as the tenant ID.

## Required production configuration

Set these server-only values in the deployment secret store:

```text
PUBLISHING_API_URL
PUBLISHING_SERVICE_TOKEN
BETTER_AUTH_SECRET
BETTER_AUTH_URL
BETTER_AUTH_TRUSTED_ORIGINS
AUDIT_IP_HASH_SECRET
AUDIT_DRAIN_ENCRYPTION_KEY
AUTH_EMAIL_WEBHOOK_URL
```

The web app has no database connection. Better Auth stores its records through
the Go backend at `PUBLISHING_API_URL`, authenticated with
`PUBLISHING_SERVICE_TOKEN`. The backend's `DATABASE_URL` role can read and
insert audit rows but must not update or delete them. The maintenance worker's
separate `AUDIT_RETENTION_DATABASE_URL` role can delete only expired audit rows.

Set `NEXT_PUBLIC_APP_URL` to the public application URL. It is safe for the
browser. Do not expose any other value in this list.

Set the Google, Microsoft, and GitHub client ID and secret pairs to enable
those sign-in methods.

## Outbound email

Verification links, password resets, and organization invitations all require
outbound email. Two transports are supported:

- `RESEND_API_KEY` sends through Resend and takes precedence when set.
- `AUTH_EMAIL_WEBHOOK_URL` receives a JSON object with `to`, `subject`, and
  `text`, so a self-hosted deployment can route mail through its own service.

`AUTH_EMAIL_FROM` sets the sender and defaults to
`Shots <noreply@playbookmedia.io>`. The address must belong to a
domain verified with the provider; an unverified sender is rejected at send
time rather than at startup. Both a bare address and the
`Name <address>` header form are accepted.

Organization invitations depend on this even in an OAuth-only deployment,
because the invited user has no account yet and is reached by email alone.

## Sign-in methods

`AUTH_ENABLE_PASSWORD` controls email/password sign-in. It defaults to
enabled so local development and self-hosted deployments work without extra
configuration. Set it to `false` to run OAuth-only. In production, the web
deploy copies the value from Infisical `prod`; when Infisical has no value, the
web keeps the one already on the service.

Password auth depends on outbound email. Verification and password reset both
deliver links through `AUTH_EMAIL_WEBHOOK_URL`, so enabling passwords without
that webhook creates accounts that can never be verified and passwords that
can never be reset. OAuth has no such dependency, because the provider has
already verified the address.

A provider appears on the sign-in page only when both its client ID and
client secret are set. A half-configured provider is treated as absent rather
than rendering a button that fails when clicked.

The application refuses to start when password auth is disabled and no OAuth
provider is configured, since that combination leaves no way to sign in,
including for administrators.

Register these redirect URIs with each provider, replacing the host with the
deployment's public URL:

```text
https://shots.playbookmedia.io/api/auth/callback/google
https://shots.playbookmedia.io/api/auth/callback/github
https://shots.playbookmedia.io/api/auth/callback/microsoft
```

Set `BETTER_AUTH_API_KEY`, and optionally `BETTER_AUTH_API_URL` and
`BETTER_AUTH_KV_URL`, to enable Better Auth Infrastructure audit capture for
authentication and identity-provider events.

## Authorization

The fixed organization roles are owner, admin, creator, approver, publisher,
and viewer. Better Auth uses an internal `member` role only as a
viewer-equivalent default for SSO and SCIM provisioning.

Every server operation must resolve a request principal and then check the
organization membership and named permission. Organization API keys can only
use these scopes:

```text
release:create, source:write, asset:write, upload:sign, artifact:read, post:schedule
```

They cannot manage users, SSO, SCIM, drains, retention, or channel connections.
They never approve content. A key with `post:schedule` may schedule what a
person approved and cancel scheduled posts (RFC 026).

## Enterprise identity

SSO supports OIDC and SAML through Better Auth. SCIM tokens are
organization-scoped and stored as hashes. A billing or entitlement service
must set `OrganizationEnterpriseSettings.ssoEnabled` or `.scimEnabled` before
an owner can configure that feature. The auth route rejects unentitled setup
requests and requires a fresh TOTP-protected owner or admin session.

SCIM deprovisioning is handled by Better Auth. Product workers must re-read
membership and approval state before they run a capture or publish action.

## Audit logs and SIEM drains

`AuditLog` is the product system of record. It stores a redacted, tenant-scoped
event for governance and product actions. The audit API supports filter and
search by time range, action, actor, outcome, entity type, and controlled text.

Use these APIs from the enterprise settings UI:

```text
GET  /api/audit-logs?organizationId=...&search=...&cursor=...
GET  /api/enterprise/audit-drains?organizationId=...
POST /api/enterprise/audit-drains
DELETE /api/enterprise/audit-drains/:drainId?organizationId=...
GET  /api/enterprise/audit-retention?organizationId=...
PUT  /api/enterprise/audit-retention
```

Drain events use CloudEvents JSON. Generic endpoints receive an HMAC SHA-256
signature. Splunk presets use a HEC token and Datadog presets use a Datadog API
key. Secrets are encrypted at rest, shown to no API consumer, and never added
to audit metadata or logs. Trigger.dev retries delivery without blocking the
customer action.

The retention task runs daily. Standard retention is 90 days. Enterprise
tenants can set a longer retention period or place their audit history on legal
hold.
