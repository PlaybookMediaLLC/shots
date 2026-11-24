# Release kit implementation

RFC 004 extends the release qualification and claim evidence owners in Go. A
kit snapshots acknowledged saved draft content, uploaded image hashes, selected
Story Set outputs, or manually selected verified-claim templates. The existing
editors remain the authoring surfaces. Autosave checkpoints, mutable share links,
and generated proposals do not confer approval.

The product domain freezes immutable artifact revisions and a canonical kit
manifest. Preparation and export run through the product outbox and Temporal
maintenance worker. They reserve object keys and quota before uploading, verify
retained bytes, and leave partial failures visible and available to workspace
cleanup. A human content-coverage decision and a separate final approval bind the
exact manifest. Rejection requires a replacement revision; retained artifacts
can be reused without changing their bytes or earlier decisions.

Readiness checks current qualification, claim/support decisions, complete source
pins, required materials or reviewed omissions, audience clearance, and current
human authority. Source changes and permission revocation block approval and
approved export. Downloads use the existing encrypted asset-grant boundary and
recheck the original principal and live dependencies before and after reading
bytes. Private draft previews add a watermark without changing retained output.

The deterministic ZIP contains only the selected audiences' prepared Markdown
and images plus a public file index. Private evidence passages, source URLs, and
review notes stay outside that index. Story Set rendering uses the existing
strict native renderer with pinned owned images and bundled fonts. Google fonts
must be replaced with a bundled font before preparation because their remote
bytes are not a retained input. Draft images must also be included as screenshot
artifacts for the same audience so relative Markdown links resolve in the ZIP.

## Ownership and compatibility

- `server/internal/releasekits` owns the pure readiness evaluator and ZIP format.
- `server/internal/product/release_kit_*.go` owns session commands, native
  snapshots, retained output, approval, and live export authorization.
- `server/ent/schema/release_kits.go` and additive migration
  `20261120130000_release_kits.sql` own the eight kit relations and SQL guards.
- `clients/apps/web/lib/releases` adapts the existing Plate Markdown serializer
  and design renderer to frozen input; it does not add a second editor.
- `ReleaseKitReview` and `KitArtifactComposer` reuse the release screen, shared
  controls, authoring queries, backend SDK, and registered REST contracts.

The existing asset download cipher is shared with kit exports, with separate
resource identities so one grant cannot be redeemed through the other route.
Existing asset downloads retain their authorization behavior. Workspace cleanup
also removes kit records and reserved or completed output keys.

## Verification boundary

The phase checks cover deterministic exports, incomplete output, current saved
content versus autosave, selected creative output, exact command replay, tenant
isolation, nonhuman review rejection, authority/source races, grant expiry and
revocation, and cleanup. The browser journey runs against the production image
and real Postgres, object storage, and Temporal worker. It triggers the existing
Temporal maintenance schedule after enqueueing each job so assertions do not
depend on the minute tick; it does not substitute a fake preparation worker.

Handoff receipts, downstream use evidence, freshness findings, and unchanged-byte
revalidation are separate RFC 005/006 work. This phase does not claim a controlled
customer pilot or live external-provider delivery.
