# Social connection availability

The provider picker reads configuration readiness from the running social
adapter before showing a connection form. Registration in the provider registry
alone does not make an adapter ready. Readiness does not prove provider approval,
account authorization, native identity, granted scopes, or publishing capability.
Those checks remain part of connection completion and publishing.

## Request and authority

`GET /api/v1/social-connection-availability` is a member-only REST contract for
workspace owners/admins with `content:drafts`. The web forwards the original
session to `GET /v1/social-connection-availability` in the product API. Go
reauthorizes the actor and entitlement, resolves the workspace's social binding,
and verifies that the binding's server-held credential identifies the expected
social organization before requesting `/public/v1/connection-availability`.
API keys cannot use the product operation. Query overrides are rejected.

The response contains only version 1 and nine `{provider, status}` entries:
`x`, `linkedin`, `threads`, `mastodon`, `mastodon-custom`, `bluesky`, `instagram`,
`instagram-standalone`, and `substack`. It contains no app IDs, configuration
values, credentials, secret references, or provider account data. Each branch is
required exactly once; missing, duplicate, unknown or invalid entries fail closed.

| Status           | Meaning                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `available`      | The registered adapter has the required local configuration and rollout gates. A connection may be attempted. |
| `not_configured` | Required application credentials, encryption key, or callback configuration are missing or invalid.           |
| `disabled`       | The operator hid the provider or a required rollout gate is off.                                              |
| `unsupported`    | The adapter is absent or the product has no supported integration. Substack Notes remains in this state.      |

The product and adapter must both enable Bluesky or custom Mastodon. A product
gate cannot override an adapter disable. Legacy Mastodon is the mastodon.social
branch; other instances use the custom-server flow. Company-page LinkedIn uses
the same app configuration internally, without adding a separate picker choice.

The response uses `Cache-Control: no-store`. The browser request is scoped by
user and workspace, cancelled on scope changes, and discarded when the dialog
closes. Loading/error states disable provider selection. An error offers a retry;
a disabled item explains why it cannot connect. A disabled credential-based
provider never mounts its credential form. Reopening reads the current catalog.

Both public and legacy authenticated adapter start routes recheck readiness
before external registration, OAuth generation, or state persistence. Changes
after the catalog read therefore fail safely. Existing callback receipts remain
recoverable; these configuration gates do not discard successful prior exchanges.
Availability does not reserve capacity or authorize a target: the existing
attempt/commit boundaries still enforce ownership, occupied slots, fresh session
requirements and subscription capacity.

## Configuration and rollout

Supply application credentials only to the social component. Local Compose maps
`SOCIAL_X_API_KEY`/`SOCIAL_X_API_SECRET`,
`SOCIAL_THREADS_APP_ID`/`SOCIAL_THREADS_APP_SECRET`,
`SOCIAL_MASTODON_CLIENT_ID`/`SOCIAL_MASTODON_CLIENT_SECRET`, and the existing
Instagram/Facebook variables to their adapter names. LinkedIn retains
`LINKEDIN_CLIENT_ID`/`LINKEDIN_CLIENT_SECRET`. LinkedIn Page requires
`PLATFORM_LINKEDIN_PAGE_CLIENT_ID`/`PLATFORM_LINKEDIN_PAGE_CLIENT_SECRET` when
the Page client ID is set, else the LinkedIn pair. `SOCIAL_FRONTEND_URL` supplies the
callback origin. Every backend reading credentials requires the existing
`PLATFORM_SOCIAL_ENCRYPTION_KEY`; never rotate it as part of this rollout.

`PLATFORM_SOCIAL_BLUESKY_ENABLED=true` and
`PLATFORM_SOCIAL_CUSTOM_MASTODON_ENABLED=true` remain explicit opt-ins, off by
default, and must reach both APIs. Supply product gates in the normal product
environment and matching adapter gates in the social overlay where separate
services are used. `HIDDEN_PROVIDERS` also prevents new starts for these managed
providers. Other legacy adapters retain their existing connection policy.

Deploy the adapter catalog/start guards first, then the product API/SDK and web.
An old or unreachable adapter returns a recoverable availability error; the web
does not assume that it is ready. There is no new schema migration. Existing
credential and verified-identity migrations remain required. Rolling back the
adapter alone makes the new picker unavailable until compatible services return.

## Evidence and limitations

Go tests cover complete/invalid catalogs, missing configuration, encryption,
hidden providers, both rollout gates, callback origins, tenant-bound adapter
reads, authentication/entitlement failures, safe errors, and stale starts without
OAuth or external-registration side effects. SDK/REST tests enforce the strict
catalog and original session. Production-browser scenarios cover unavailable
configuration, retry, reopen, no premature credential entry, safe failed starts,
no persisted set/attempt, and desktop/mobile accessibility.

These tests use adapter protocol fixtures and the real local product API,
authentication and PostgreSQL. They are not live provider proof. The user selected
X for the next disposable account check; the local real adapter currently lacks
`X_API_KEY` and `X_API_SECRET`. Live X authorization remains pending that operator
configuration. Mastodon account authorization is deferred at the user's request.
The 60-criterion implementation ledger retains all remaining work.
