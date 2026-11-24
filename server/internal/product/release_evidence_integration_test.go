package product

import (
	"encoding/json"
	"errors"
	"strconv"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/evidencesource"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/evidenceversion"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/outboxevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseevidence"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasesourcebinding"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/sourceapp"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	automation "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releaseautomation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasefacts"
	"github.com/lucsky/cuid"
)

func evidenceWorkspace(t *testing.T) (*testWorkspace, string) {
	t.Helper()
	w, id, _ := qualificationWorkspace(t)
	evidenceFixtureCleanup(t, w)
	return w, id
}

func TestReleaseEvidenceReadRedactionClearanceAndErasure(t *testing.T) {
	w, id := evidenceWorkspace(t)
	input := evidenceInput()
	privateURL := "https://example.com/internal/rollout"
	input.SourceURL = &privateURL
	created, err := w.repo.CreateReleaseEvidence(w.ctx, w.owner, id, "evidence", input)
	if err != nil {
		t.Fatal(err)
	}
	facts := qualifiedFactsFixture()
	facts.OwnerUserID, facts.FactReviewerUserID = &w.owner.UserID, &w.owner.UserID
	if _, err := w.repo.CreateQualificationRevision(w.ctx, w.owner, id, "facts", CreateQualificationInput{ExpectedRevision: "1", Facts: facts}); err != nil {
		t.Fatal(err)
	}
	page, err := w.repo.ListReleaseEvidence(w.ctx, w.owner, id, "")
	if err != nil || len(page.Items) != 1 || page.Items[0].Text == nil || !page.Items[0].Available {
		t.Fatalf("read=%+v err=%v", page, err)
	}
	tx, err := w.db.Client.Tx(w.ctx)
	if err != nil {
		t.Fatal(err)
	}
	_, key, err := mintAPIKey(w.ctx, tx, w.org, "Evidence reader", []string{"artifact:read"}, nil, agentKeyMetadata{})
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	actor := Actor{Kind: "api_key", OrganizationID: w.org, KeyID: key.ID}
	redacted, err := w.repo.ListReleaseEvidence(w.ctx, actor, id, "")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(redacted)
	if err != nil {
		t.Fatal(err)
	}
	if redacted.Items[0].Text != nil || redacted.Items[0].SourceURL != nil || redacted.Items[0].AttestationScope != nil {
		t.Fatalf("machine read leaked private content: %s", raw)
	}
	access := ChangeEvidenceAccessInput{ExpectedRevision: "2", EvidenceVersionID: created.ID, ExpectedSourceSequence: "1", Action: "CLEAR_FOR_AUDIENCE", AudienceIDs: []string{facts.Requirements[0].ID}, Reason: "Reviewed the exact excerpt for this audience."}
	if _, err := w.repo.ChangeEvidenceAccess(w.ctx, actor, id, "machine-clear", access); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("machine clearance=%v", err)
	}
	if _, err := w.repo.ChangeEvidenceAccess(w.ctx, w.owner, id, "clear", access); err != nil {
		t.Fatal(err)
	}
	page, err = w.repo.ListReleaseEvidence(w.ctx, w.owner, id, "")
	if err != nil || page.Items[0].SourceSequence != "2" || page.Items[0].AccessClass != "CUSTOMER_CLEARED" {
		t.Fatalf("clearance=%+v err=%v", page, err)
	}
	access.ExpectedRevision, access.ExpectedSourceSequence, access.Action, access.AudienceIDs = "3", "2", "REVOKE_CLEARANCE", []string{}
	revoked, err := w.repo.ChangeEvidenceAccess(w.ctx, w.owner, id, "revoke", access)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := w.repo.ChangeEvidenceAccess(w.ctx, w.owner, id, "revoke", access)
	if err != nil || replay.Created || replay.ID != revoked.ID {
		t.Fatalf("revocation replay=%+v %v", replay, err)
	}
	page, err = w.repo.ListReleaseEvidence(w.ctx, w.owner, id, "")
	if err != nil || page.Items[0].SourceSequence != "3" || page.Items[0].AccessClass != "PRIVATE_SOURCE" {
		t.Fatalf("revocation=%+v err=%v", page, err)
	}
	access.ExpectedRevision, access.ExpectedSourceSequence, access.Action = "4", "3", "TOMBSTONE"
	if _, err := w.repo.ChangeEvidenceAccess(w.ctx, w.owner, id, "erase", access); err != nil {
		t.Fatal(err)
	}
	page, err = w.repo.ListReleaseEvidence(w.ctx, w.owner, id, "")
	if err != nil || page.Items[0].Text != nil || page.Items[0].SourceURL != nil || page.Items[0].Available || page.Items[0].TombstonedAt == nil || page.Items[0].SourceSequence != "4" {
		t.Fatalf("tombstone=%+v err=%v", page, err)
	}
	if _, err := w.repo.ListReleaseEvidence(w.ctx, w.owner, id, "bad-cursor"); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("bad cursor=%v", err)
	}
	other, otherID := evidenceWorkspace(t)
	if _, err := w.repo.ListReleaseEvidence(w.ctx, w.owner, otherID, ""); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("foreign read=%v", err)
	}
	if _, err := other.repo.LinkReleaseEvidence(other.ctx, other.owner, otherID, "foreign", LinkReleaseEvidenceInput{ExpectedRevision: "0", EvidenceVersionID: created.ID, ExpectedSourceSequence: "3", Purpose: "Wrong tenant"}); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("foreign link=%v", err)
	}
}

func TestReleaseEvidenceImageAndAssetDeletionBridge(t *testing.T) {
	w, id := evidenceWorkspace(t)
	original, redacted := cuid.New(), cuid.New()
	hash := releasefacts.ByteHash([]byte("image fixture"))
	for _, assetID := range []string{original, redacted} {
		w.exec(t, `INSERT INTO asset(id,"organizationId","objectKey","mediaType",bytes,width,height,sha256,status,"updatedAt") VALUES($1,$2,$3,'image/png',100,200,100,$4,'UPLOADED',now())`, assetID, w.org, "org/"+w.org+"/image/"+assetID, hash)
	}
	w.exec(t, `UPDATE asset SET "parentAssetId"=$1 WHERE id=$2`, original, redacted)
	input := evidenceInput()
	input.Kind, input.Text, input.AssetID, input.RedactionAssetID = "ASSET", "", &original, &redacted
	created, err := w.repo.CreateReleaseEvidence(w.ctx, w.owner, id, "image", input)
	if err != nil {
		t.Fatal(err)
	}
	page, err := w.repo.ListReleaseEvidence(w.ctx, w.owner, id, "")
	if err != nil || page.Items[0].Format != "IMAGE" || page.Items[0].AssetID == nil || page.Items[0].RedactionAssetID == nil || page.Items[0].Width != 200 {
		t.Fatalf("image=%+v err=%v", page, err)
	}
	claim, err := w.repo.SaveReleaseClaim(w.ctx, w.owner, id, "claim", claimInput("1"))
	if err != nil {
		t.Fatal(err)
	}
	support := SetClaimSupportsInput{ExpectedRevision: "2", ClaimVersionID: claim.IDs[1], Supports: []ClaimSupportInput{{EvidenceVersionID: created.ID, ExpectedSourceSequence: "1", Relation: "SUPPORTS", Selector: releasefacts.EvidenceSelector{Kind: "IMAGE_REGION", Width: 200, Height: 100, ContextSHA256: page.Items[0].SHA256, RedactionID: redacted}}}}
	if _, err := w.repo.SetClaimSupports(w.ctx, w.owner, id, claim.ID, "image-support", support); err != nil {
		t.Fatal(err)
	}
	if result, err := w.repo.DeleteAsset(w.ctx, w.owner, original); err != nil || result != AssetDeleted {
		t.Fatalf("delete=%s err=%v", result, err)
	}
	page, err = w.repo.ListReleaseEvidence(w.ctx, w.owner, id, "")
	if err != nil || page.Items[0].Available || page.Items[0].AssetID != nil || page.Items[0].RedactionAssetID != nil || page.Items[0].TombstonedAt == nil || page.Items[0].SourceSequence != "2" {
		t.Fatalf("deleted image remains readable: %+v err=%v", page, err)
	}
	if count := w.db.Client.OutboxEvent.Query().Where(outboxevent.OrganizationID(w.org), outboxevent.Type("asset.deleted"), outboxevent.AggregateID(original)).CountX(w.ctx); count != 1 {
		t.Fatalf("storage cleanup receipts=%d", count)
	}
}

func TestReleaseEvidenceProviderSnapshotAndRevocation(t *testing.T) {
	f := newAutomationFixture(t)
	enableSourceSelection(t, f.testWorkspace)
	evidenceFixtureCleanup(t, f.testWorkspace)
	id := cuid.New()
	f.exec(t, `INSERT INTO release(id,"organizationId",title,"benefitStatement","updatedAt") VALUES($1,$2,'Evidence','Product facts',now())`, id, f.org)
	observed := time.Now().UTC().Add(-time.Minute)
	event := automation.Event{Family: automation.Merged, SemanticKey: "pr:1001:9", RepositoryID: "1001", RepositoryName: "acme/app", ObjectID: "9", Number: 9, OccurredAt: observed, SourceUpdatedAt: &observed, Origin: "historical", Title: "Pro export availability", Notes: "Exports are available to Pro workspaces.", URL: "https://github.com/acme/app/pull/9", Fields: map[string]automation.Value{"pr.base": automation.StringValue("main")}}
	if _, err := f.repo.acceptGitHubEvent(f.ctx, "evidence-first", event, []*WebhookSource{webhookSource(f.source)}, nil); err != nil {
		t.Fatal(err)
	}
	binding := f.db.Client.ReleaseSourceBinding.Query().Where(releasesourcebinding.OrganizationID(f.org)).OnlyX(f.ctx)
	input := CreateReleaseEvidenceInput{ExpectedRevision: "0", Kind: "RELEASE_SOURCE", Origin: "PROVIDER", SourceBindingID: &binding.ID, ObservationID: binding.CurrentObservationID, Purpose: "Review retained provider facts"}
	created, err := f.repo.CreateReleaseEvidence(f.ctx, f.owner, id, "provider", input)
	if err != nil {
		t.Fatal(err)
	}
	page, err := f.repo.ListReleaseEvidence(f.ctx, f.owner, id, "")
	if err != nil || len(page.Items) != 1 || !page.Items[0].Current || page.Items[0].Text == nil || page.Items[0].Origin != "PROVIDER" {
		t.Fatalf("provider=%+v err=%v", page, err)
	}
	sourceID := page.Items[0].SourceID
	oldFence := page.Items[0].SourceSequence
	observed = observed.Add(time.Second)
	if _, err := f.repo.acceptGitHubEvent(f.ctx, "evidence-unchanged", event, []*WebhookSource{webhookSource(f.source)}, nil); err != nil {
		t.Fatal(err)
	}
	page, err = f.repo.ListReleaseEvidence(f.ctx, f.owner, id, "")
	if err != nil || !page.Items[0].Current || page.Items[0].SourceSequence != oldFence {
		t.Fatalf("unchanged observation invalidated evidence: %+v %v", page, err)
	}
	observed = observed.Add(time.Second)
	event.Title = "Withdrawn export availability"
	if _, err := f.repo.acceptGitHubEvent(f.ctx, "evidence-update", event, []*WebhookSource{webhookSource(f.source)}, nil); err != nil {
		t.Fatal(err)
	}
	page, err = f.repo.ListReleaseEvidence(f.ctx, f.owner, id, "")
	if err != nil || page.Items[0].Current || page.Items[0].SourceSequence == oldFence {
		t.Fatalf("provider change accepted old snapshot: %+v err=%v", page, err)
	}
	beforeRevocation := f.db.Client.EvidenceSource.GetX(f.ctx, sourceID).ChangeSequence
	f.db.Client.SourceApp.UpdateOneID(f.source.ID).SetStatus(sourceapp.StatusARCHIVED).ExecX(f.ctx)
	page, err = f.repo.ListReleaseEvidence(f.ctx, f.owner, id, "")
	if err != nil || page.Items[0].Available || page.Items[0].Text != nil || page.Items[0].SourceURL != nil {
		t.Fatalf("revoked private snapshot exposed: %+v err=%v", page, err)
	}
	if f.db.Client.EvidenceSource.GetX(f.ctx, sourceID).ChangeSequence <= beforeRevocation {
		t.Fatal("revocation did not advance source fence")
	}
	if row := f.db.Client.EvidenceVersion.GetX(f.ctx, created.ID); row.NormalizedText == nil {
		t.Fatal("revocation destroyed retained historical bytes")
	}
}

func evidenceFixtureCleanup(t *testing.T, w *testWorkspace) {
	t.Helper()
	t.Cleanup(func() {
		w.exec(t, `UPDATE platform_release_claim SET "currentVersionId"=NULL,"currentSupportSetId"=NULL,"currentDecisionId"=NULL WHERE "organizationId"=$1`, w.org)
		w.exec(t, `UPDATE platform_evidence_source SET "currentVersionId"=NULL,"changeSequence"="changeSequence"+1 WHERE "organizationId"=$1`, w.org)
		for _, table := range []string{"platform_claim_path_binding", "platform_claim_verification", "platform_claim_support", "platform_claim_support_set", "platform_release_claim_version", "platform_release_claim", "platform_evidence_clearance", "platform_release_evidence", "platform_evidence_version", "platform_evidence_source"} {
			w.exec(t, `DELETE FROM `+table+` WHERE "organizationId"=$1`, w.org)
		}
	})
}

func evidenceInput() CreateReleaseEvidenceInput {
	return CreateReleaseEvidenceInput{ExpectedRevision: "0", Kind: "TEXT", Origin: "HUMAN", Text: "Exports are available to Pro workspaces.\r\nNot available offline.",
		ObservedAt: time.Now().UTC().Add(-time.Minute), Purpose: "Availability and limitation evidence"}
}

func TestReleaseEvidenceRetainsBytesAndExactRetry(t *testing.T) {
	w, id := evidenceWorkspace(t)
	input := evidenceInput()
	created, err := w.repo.CreateReleaseEvidence(w.ctx, w.owner, id, "attach", input)
	if err != nil || !created.Created || created.Revision != "1" || len(created.IDs) != 1 || created.ID != created.IDs[0] {
		t.Fatalf("create=%+v error=%v", created, err)
	}
	row := w.db.Client.EvidenceVersion.GetX(w.ctx, created.ID)
	if row.NormalizedText == nil || *row.NormalizedText != "Exports are available to Pro workspaces.\nNot available offline." ||
		row.RawSha256 != releasefacts.ByteHash([]byte(input.Text)) || row.NormalizedSha256 != releasefacts.ByteHash([]byte(*row.NormalizedText)) || row.ConfirmedAt != nil || row.ConfirmedByUserID != nil {
		t.Fatalf("retained evidence=%+v", row)
	}
	replay, err := w.repo.CreateReleaseEvidence(w.ctx, w.owner, id, "attach", input)
	if err != nil || replay.Created || replay.ID != created.ID || replay.Revision != "1" {
		t.Fatalf("retry=%+v error=%v", replay, err)
	}
	if count := w.db.Client.EvidenceVersion.Query().Where(evidenceversion.OrganizationID(w.org)).CountX(w.ctx); count != 1 {
		t.Fatalf("retry wrote %d evidence versions", count)
	}
	if count := w.db.Client.ReleaseEvidence.Query().Where(releaseevidence.OrganizationID(w.org), releaseevidence.ReleaseID(id)).CountX(w.ctx); count != 1 {
		t.Fatalf("release references=%d", count)
	}
	if count := w.db.Client.OutboxEvent.Query().Where(outboxevent.OrganizationID(w.org), outboxevent.Type("activity.release.readiness_changed")).CountX(w.ctx); count != 1 {
		t.Fatalf("committed readiness events=%d", count)
	}
	changed := input
	changed.Text = "Changed evidence"
	_, err = w.repo.CreateReleaseEvidence(w.ctx, w.owner, id, "attach", changed)
	requireQualificationFailure(t, err, "COMMAND_KEY_REUSED")
	source := w.db.Client.EvidenceSource.GetX(w.ctx, row.SourceID)
	sequence := strconv.FormatInt(source.ChangeSequence, 10)
	changed.ExpectedRevision, changed.SourceID, changed.ExpectedSourceSequence = "1", &source.ID, &sequence
	updated, err := w.repo.CreateReleaseEvidence(w.ctx, w.owner, id, "update", changed)
	if err != nil || updated.ID == created.ID || updated.Revision != "2" {
		t.Fatalf("update=%+v error=%v", updated, err)
	}
	if previous := w.db.Client.EvidenceVersion.GetX(w.ctx, created.ID); previous.NormalizedText == nil || *previous.NormalizedText != *row.NormalizedText {
		t.Fatal("source replacement changed historical bytes")
	}
	changed.ExpectedRevision = "2"
	_, err = w.repo.CreateReleaseEvidence(w.ctx, w.owner, id, "stale-source", changed)
	requireQualificationFailure(t, err, "SOURCE_CHANGED")
	if count := w.db.Client.EvidenceVersion.Query().Where(evidenceversion.OrganizationID(w.org)).CountX(w.ctx); count != 2 {
		t.Fatalf("rejected update wrote %d evidence versions", count)
	}
	w.exec(t, `DELETE FROM session WHERE id=$1`, w.owner.SessionID)
	if _, err = w.repo.CreateReleaseEvidence(w.ctx, w.owner, id, "attach", input); !errors.Is(err, publishing.ErrUnauthorized) {
		t.Fatalf("revoked-session replay=%v", err)
	}
}

func TestReleaseEvidenceHumanOriginAndTenantBoundaries(t *testing.T) {
	w, id := evidenceWorkspace(t)
	other, foreignID := evidenceWorkspace(t)
	input := evidenceInput()
	if _, err := w.repo.CreateReleaseEvidence(w.ctx, w.owner, foreignID, "foreign-release", input); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("foreign release accepted: %v", err)
	}
	service := w.owner
	service.Kind = "service"
	if _, err := w.repo.CreateReleaseEvidence(w.ctx, service, id, "worker", input); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("worker authored evidence: %v", err)
	}
	input.Kind, input.Origin, input.AttestationScope, input.Limitations, input.ConfirmAttestation = "ATTESTATION", "AI", "Pro rollout", "No offline use", true
	if _, err := w.repo.CreateReleaseEvidence(w.ctx, w.owner, id, "attest", input); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("AI attestation confirmed: %v", err)
	}
	input.Origin = "HUMAN"
	created, err := w.repo.CreateReleaseEvidence(w.ctx, w.owner, id, "attest", input)
	if err != nil {
		t.Fatal(err)
	}
	row := w.db.Client.EvidenceVersion.GetX(w.ctx, created.ID)
	if row.ConfirmedByUserID == nil || *row.ConfirmedByUserID != w.owner.UserID || row.ConfirmedAt == nil || row.AttestationScope != input.AttestationScope {
		t.Fatalf("missing accountable attestation: %+v", row)
	}
	sequence := "1"
	input.SourceID, input.ExpectedSourceSequence = &row.SourceID, &sequence
	if _, err := other.repo.CreateReleaseEvidence(other.ctx, other.owner, foreignID, "foreign-source", input); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("foreign source accepted: %v", err)
	}
	if _, err := w.db.SQL.ExecContext(w.ctx, `INSERT INTO platform_release_evidence(id,"organizationId","releaseId","evidenceVersionId",purpose,"attachedByUserId") VALUES('foreign-evidence',$1,$2,$3,'Invalid','user')`, other.org, foreignID, row.ID); err == nil {
		t.Fatal("database accepted foreign evidence binding")
	}
	if err := w.db.Client.EvidenceSource.UpdateOneID(row.SourceID).SetAvailability(evidencesource.AvailabilityUNAVAILABLE).Exec(w.ctx); err == nil {
		t.Fatal("source availability changed without advancing its fence")
	}
	if _, err := w.db.SQL.ExecContext(w.ctx, `UPDATE platform_evidence_version SET "normalizedText"='different' WHERE id=$1`, row.ID); err == nil {
		t.Fatal("reviewed source bytes could be overwritten")
	}
	w.exec(t, `UPDATE platform_evidence_version SET "tombstonedAt"=now(),"normalizedText"=NULL,"sourceUrl"=NULL,"assetId"=NULL,"redactionAssetId"=NULL,"attestationScope"='',limitations='' WHERE id=$1`, row.ID)
	if _, err := w.db.SQL.ExecContext(w.ctx, `UPDATE platform_evidence_version SET "tombstonedAt"=NULL,"normalizedText"='restored' WHERE id=$1`, row.ID); err == nil {
		t.Fatal("erased source content could be restored")
	}
}
