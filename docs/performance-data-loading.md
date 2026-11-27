# Signed-in data loading

Product queries use a 30-second freshness window, five-minute inactive retention,
and stale refetch on focus. Image queries retain their own longer policy. Preferences
keep their existing five-minute freshness. Project and Story Set lists now use the
shared infinite-query cache. The tRPC link invalidates list filters after editor
and library mutations, including completed asset uploads. Sign-out and workspace
switching retain full navigation, which discards the browser's QueryClient.

Authorization reads are deduplicated only within one tRPC query request. Each
procedure still evaluates permissions and sensitive-session requirements. Mutations,
quota consumption, and subsequent requests do not reuse this snapshot. The transport
owns tRPC retries: at most three read attempts within its existing 20-second budget.

Private thumbnails are stored in the existing Redis service for 24 hours. Keys
include the workspace, immutable asset ID, and transformation version. Ownership
and uploaded/deleted state are checked before every cache hit. Only in-flight renders
are kept in process memory; concurrent misses share work within that process. Separate
replicas may render the same cold key concurrently. Redis failures fall back to rendering,
and authenticated immutable asset and thumbnail responses use
`Cache-Control: private, max-age=0, must-revalidate` with `ETag` (`304 Not Modified`),
preserving per-request authorization and revocation checks while avoiding repeated transfers.

The workflow overview bulk-loads installation and workspace-link rows. Its configuration
and aggregate counters refresh every minute; recent run statuses refresh every 15 seconds.
Both poll only while visible. Explicit workflow actions still refresh both immediately.

## Rollout and measurement

Deploy the Go backend with `GET /v1/page-access` before the web release that calls it.
The endpoint is internal and session-only, and preserves workspace deletion recovery.
No database migration or new environment variable is required. Build the local SDK
before standalone web typechecking (`npm run build:sdk`).

Measure production builds, using the same account, workspace, data, and device before
and after: cold/warm Projects → Workflows → Projects navigation, requests and bytes per
screen, p50/p95 time to useful content, SQL queries per workflow refresh, and repeated
gallery thumbnail CPU/object reads. Verify writes, filters, pagination, workspace
switching, revoked membership, and cache outages. Source-level request reductions do
not establish a production latency percentage.
