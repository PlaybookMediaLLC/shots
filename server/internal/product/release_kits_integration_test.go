package product

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/kitrevision"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasefacts"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasekits"
	"github.com/google/uuid"
	"github.com/lucsky/cuid"
)

func kitFixture(t *testing.T) (*testWorkspace, string, CreateReleaseKitInput, *derivativeObjects) {
	t.Helper()
	w, id, claimID, decision, _ := claimReviewFixture(t)
	t.Cleanup(func() {
		w.exec(t, `UPDATE platform_release_kit SET "currentRevisionId"=NULL,"approvedRevisionId"=NULL WHERE "organizationId"=$1`, w.org)
		for _, table := range []string{"platform_kit_export", "platform_kit_review_decision", "platform_kit_source_pin", "platform_kit_member", "platform_kit_artifact_claim", "platform_kit_artifact_revision", "platform_release_kit_revision", "platform_release_kit"} {
			w.exec(t, `DELETE FROM `+table+` WHERE "organizationId"=$1`, w.org)
		}
	})
	if _, err := w.repo.VerifyReleaseClaim(w.ctx, w.owner, id, claimID, "verify", decision); err != nil {
		t.Fatal(err)
	}
	facts, err := w.repo.GetReleaseQualification(w.ctx, w.owner, id)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.repo.DecideQualification(w.ctx, w.owner, id, "qualify", DecideQualificationInput{ExpectedRevision: "5", QualificationRevisionID: facts.Current.ID, Decision: "QUALIFIED", Reason: "Confirmed all release facts and audience requirements."}); err != nil {
		t.Fatal(err)
	}
	input := CreateReleaseKitInput{ExpectedRevision: "6", QualificationRevisionID: facts.Current.ID, ApproverUserID: w.owner.UserID, Artifacts: []KitArtifactInput{}}
	for _, kind := range []string{"FACT_SHEET", "SALES_NOTES"} {
		input.Artifacts = append(input.Artifacts, KitArtifactInput{Kind: kind, AudienceID: "sales", Classification: "INTERNAL_MATERIAL", SourceKind: "TEMPLATE", Claims: []KitClaimInput{{NodeID: "fact", ClaimVersionID: decision.ClaimVersionID}}})
	}
	objects := &derivativeObjects{recordingAssetObjects: recordingAssetObjects{exists: true}, files: map[string][]byte{}}
	w.repo.WithObjectStore(objects).WithAssetDownloads(strings.Repeat("k", 32), "http://localhost:3011")
	return w, id, input, objects
}

func prepareKitFixture(t *testing.T, w *testWorkspace, releaseID, revisionID string) *ReleaseKitDetail {
	t.Helper()
	detail, err := w.repo.GetReleaseKit(w.ctx, w.owner, releaseID, revisionID)
	if err != nil {
		t.Fatal(err)
	}
	input := PrepareReleaseKitInput{ExpectedRevision: detail.Readiness.AggregateRevision, Snapshots: []KitSnapshotExpectation{}}
	for _, a := range detail.Artifacts {
		input.Snapshots = append(input.Snapshots, KitSnapshotExpectation{ArtifactRevisionID: a.ID, SnapshotSHA256: a.SnapshotSHA256})
	}
	if _, err := w.repo.PrepareReleaseKit(w.ctx, w.owner, releaseID, revisionID, "prepare-"+revisionID, input); err != nil {
		t.Fatal(err)
	}
	if handled, err := w.repo.HandleOutboxEvent(w.ctx, "event", w.org, EventKitPrepare, revisionID); err != nil || !handled {
		t.Fatalf("dispatch=%v %v", handled, err)
	}
	detail, err = w.repo.GetReleaseKit(w.ctx, w.owner, releaseID, revisionID)
	if err != nil || detail.State != "REVIEWABLE" {
		t.Fatalf("prepared=%+v %v", detail, err)
	}
	return detail
}

func decideKitFixture(t *testing.T, w *testWorkspace, releaseID string, detail *ReleaseKitDetail, review, decision string) *ReleaseKitDetail {
	t.Helper()
	input := DecideReleaseKitInput{ExpectedRevision: detail.Readiness.AggregateRevision, ManifestSHA256: *detail.Readiness.ManifestHash, DependencyToken: detail.Readiness.DependencyToken, ReviewType: review, Decision: decision, Reason: "Reviewed every included assertion, qualifier and image for the selected audiences.", AssertionsConfirmed: true, ScreenshotsConfirmed: true, AudienceConfirmed: true}
	if _, err := w.repo.DecideReleaseKit(w.ctx, w.owner, releaseID, detail.ID, review+decision+detail.ID, input); err != nil {
		t.Fatal(err)
	}
	next, err := w.repo.GetReleaseKit(w.ctx, w.owner, releaseID, detail.ID)
	if err != nil {
		t.Fatal(err)
	}
	return next
}

func TestReleaseKitReviewRejectReviseApproveExportAndSourceFence(t *testing.T) {
	w, id, input, objects := kitFixture(t)
	created, err := w.repo.CreateReleaseKitRevision(w.ctx, w.owner, id, "assemble", input)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := w.repo.CreateReleaseKitRevision(w.ctx, w.owner, id, "assemble", input)
	if err != nil || replay.Created || replay.ID != created.ID {
		t.Fatalf("assembly retry=%+v %v", replay, err)
	}
	detail := prepareKitFixture(t, w, id, created.ID)
	if detail.Readiness.CanApprove || detail.Readiness.CanExportApproved {
		t.Fatalf("generation conferred human approval: %+v", detail.Readiness)
	}
	detail = decideKitFixture(t, w, id, detail, "CONTENT_COVERAGE", "REJECT")
	oldID := detail.ID
	input.ExpectedRevision = detail.Readiness.AggregateRevision
	input.ExpectedKitRevisionID = &oldID
	keepID := detail.Artifacts[0].ID
	input.Artifacts[0] = KitArtifactInput{ExistingArtifactID: &keepID}
	changed, err := w.repo.CreateReleaseKitRevision(w.ctx, w.owner, id, "replacement", input)
	if err != nil {
		t.Fatal(err)
	}
	detail = prepareKitFixture(t, w, id, changed.ID)
	if detail.Artifacts[0].ID != keepID {
		t.Fatal("selective regeneration replaced an unchanged artifact")
	}
	detail = decideKitFixture(t, w, id, detail, "CONTENT_COVERAGE", "APPROVE")
	if !detail.Readiness.CanApprove || detail.Readiness.CanExportApproved {
		t.Fatalf("coverage/final distinction=%+v", detail.Readiness)
	}
	detail = decideKitFixture(t, w, id, detail, "FINAL_APPROVAL", "APPROVE")
	if !detail.Readiness.CanExportApproved {
		t.Fatalf("approval=%+v", detail.Readiness)
	}
	request := RequestKitExportInput{ExpectedRevision: detail.Readiness.AggregateRevision, ManifestSHA256: *detail.Readiness.ManifestHash, AudienceIDs: []string{"sales"}}
	exported, err := w.repo.RequestKitExport(w.ctx, w.owner, id, detail.ID, "export", request)
	if err != nil {
		t.Fatal(err)
	}
	if handled, err := w.repo.HandleOutboxEvent(w.ctx, "export-event", w.org, EventKitExport, exported.ID); err != nil || !handled {
		t.Fatalf("export dispatch=%v %v", handled, err)
	}
	result, err := w.repo.GetKitExport(w.ctx, w.owner, id, exported.ID, true)
	if err != nil || result.State != "READY" || result.DownloadURL == nil {
		t.Fatalf("export=%+v %v", result, err)
	}
	downloadURL, err := url.Parse(*result.DownloadURL)
	if err != nil {
		t.Fatal(err)
	}
	token := downloadURL.Query().Get("downloadToken")
	downloaded, err := w.repo.ReadKitExportDownload(w.ctx, id, exported.ID, token, "redeem")
	if err != nil || len(downloaded) == 0 {
		t.Fatalf("grant redemption=%v", err)
	}
	if _, _, err := w.repo.ReadAssetDownload(w.ctx, exported.ID, token, "wrong-purpose"); !errors.Is(err, publishing.ErrUnauthorized) {
		t.Fatalf("kit grant used as asset=%v", err)
	}
	stored := w.db.Client.KitExport.GetX(w.ctx, exported.ID)
	original := bytes.Clone(objects.files[*stored.ObjectKey])
	puts := objects.puts
	if err := w.repo.processKitExport(w.ctx, w.org, exported.ID); err != nil {
		t.Fatal(err)
	}
	retry, err := w.repo.RequestKitExport(w.ctx, w.owner, id, detail.ID, "export", request)
	if err != nil || retry.Created || retry.ID != exported.ID {
		t.Fatalf("export retry=%+v %v", retry, err)
	}
	if objects.puts != puts || !bytes.Equal(objects.files[*stored.ObjectKey], original) {
		t.Fatal("retry rerendered or changed approved bytes")
	}
	used, err := storageUsed(w.ctx, w.db.Client, w.org)
	if err != nil || used < int64(len(original)) {
		t.Fatalf("kit bytes omitted from quota: %d %v", used, err)
	}
	for _, a := range detail.Artifacts {
		if _, err := w.db.SQL.ExecContext(w.ctx, `UPDATE platform_kit_artifact_revision SET "snapshotSha256"=repeat('a',64) WHERE id=$1`, a.ID); err == nil {
			t.Fatal("artifact snapshot was mutable")
		}
	}
	if _, err := w.db.SQL.ExecContext(w.ctx, `UPDATE platform_release_kit_revision SET manifest='{}' WHERE id=$1`, detail.ID); err == nil {
		t.Fatal("approved manifest was mutable")
	}
	old, err := w.repo.GetReleaseKit(w.ctx, w.owner, id, oldID)
	if err != nil || old.State != "SUPERSEDED" || len(old.Decisions) != 1 {
		t.Fatalf("old review history=%+v %v", old, err)
	}
	// Stop all workers: a source-head change alone must block new use.
	w.exec(t, `UPDATE platform_evidence_source SET "changeSequence"="changeSequence"+1 WHERE "organizationId"=$1`, w.org)
	if _, err := w.repo.GetKitExport(w.ctx, w.owner, id, exported.ID, true); err == nil {
		t.Fatal("changed source allowed another approved download")
	} else {
		var blocked *KitReadinessError
		if !errors.As(err, &blocked) || blocked.Reason != "SOURCE_CHANGED" {
			t.Fatalf("source gate=%v", err)
		}
	}
	if body, err := w.repo.ReadKitExportDownload(w.ctx, id, exported.ID, token, "changed-source"); err == nil || len(body) > 0 {
		t.Fatalf("old grant bypassed current source fence: %v", err)
	}
	delete(objects.files, *stored.ObjectKey)
	if _, err := w.repo.GetKitExport(w.ctx, w.owner, id, exported.ID, true); !errors.Is(err, ErrStorageUnavailable) {
		t.Fatalf("missing stored object=%v", err)
	}
}

func TestReleaseKitClearanceRevocationBlocksApprovedExport(t *testing.T) {
	w, id, input, _ := kitFixture(t)
	claims, err := w.repo.ListReleaseClaims(w.ctx, w.owner, id, "")
	if err != nil {
		t.Fatal(err)
	}
	claim := claims.Items[0]
	support := claim.Supports[0]
	access := ChangeEvidenceAccessInput{ExpectedRevision: "6", EvidenceVersionID: support.EvidenceVersionID, ExpectedSourceSequence: "1", Action: "CLEAR_FOR_AUDIENCE", AudienceIDs: []string{"sales"}, Reason: "Reviewed for the sales audience."}
	if _, err := w.repo.ChangeEvidenceAccess(w.ctx, w.owner, id, "clear-for-kit", access); err != nil {
		t.Fatal(err)
	}
	updated, err := w.repo.SetClaimSupports(w.ctx, w.owner, id, claim.ID, "cleared-support", SetClaimSupportsInput{ExpectedRevision: "7", ClaimVersionID: claim.VersionID, Supports: []ClaimSupportInput{{EvidenceVersionID: support.EvidenceVersionID, ExpectedSourceSequence: "2", Relation: support.Relation, Selector: support.Selector}}})
	if err != nil {
		t.Fatal(err)
	}
	set := w.db.Client.ClaimSupportSet.GetX(w.ctx, updated.ID)
	if _, err := w.repo.VerifyReleaseClaim(w.ctx, w.owner, id, claim.ID, "verify-cleared", VerifyReleaseClaimInput{ExpectedRevision: "8", ClaimVersionID: claim.VersionID, ClaimSHA256: claim.SHA256, SupportSetID: set.ID, SupportSHA256: set.SupportSha256, Decision: "SUPPORTED", Reason: "Verified the cleared evidence and its exact qualifiers."}); err != nil {
		t.Fatal(err)
	}
	input.ExpectedRevision = "9"
	for i := range input.Artifacts {
		input.Artifacts[i].Classification = "CUSTOMER_CLEARED"
	}
	created, err := w.repo.CreateReleaseKitRevision(w.ctx, w.owner, id, "cleared-kit", input)
	if err != nil {
		t.Fatal(err)
	}
	detail := prepareKitFixture(t, w, id, created.ID)
	detail = decideKitFixture(t, w, id, detail, "CONTENT_COVERAGE", "APPROVE")
	detail = decideKitFixture(t, w, id, detail, "FINAL_APPROVAL", "APPROVE")
	exported, err := w.repo.RequestKitExport(w.ctx, w.owner, id, detail.ID, "cleared-export", RequestKitExportInput{ExpectedRevision: detail.Readiness.AggregateRevision, ManifestSHA256: *detail.Readiness.ManifestHash, AudienceIDs: []string{"sales"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := w.repo.processKitExport(w.ctx, w.org, exported.ID); err != nil {
		t.Fatal(err)
	}
	result, err := w.repo.GetKitExport(w.ctx, w.owner, id, exported.ID, true)
	if err != nil || result.DownloadURL == nil {
		t.Fatalf("approved export=%+v %v", result, err)
	}
	url, err := url.Parse(*result.DownloadURL)
	if err != nil {
		t.Fatal(err)
	}
	detail, err = w.repo.GetReleaseKit(w.ctx, w.owner, id, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	access.ExpectedRevision, access.ExpectedSourceSequence = detail.Readiness.AggregateRevision, "2"
	access.Action, access.AudienceIDs = "REVOKE_CLEARANCE", []string{}
	if _, err := w.repo.ChangeEvidenceAccess(w.ctx, w.owner, id, "revoke-kit-clearance", access); err != nil {
		t.Fatal(err)
	}
	if _, err := w.repo.GetKitExport(w.ctx, w.owner, id, exported.ID, true); err == nil {
		t.Fatal("revoked evidence allowed a new approved download")
	}
	if body, err := w.repo.ReadKitExportDownload(w.ctx, id, exported.ID, url.Query().Get("downloadToken"), "revoked-clearance"); err == nil || len(body) != 0 {
		t.Fatalf("old grant bypassed clearance revocation: %v", err)
	}
	var clearances, revocations int
	if err := w.db.SQL.QueryRowContext(w.ctx, `SELECT count(*),count(*) FILTER (WHERE "audienceIds"='[]') FROM platform_evidence_clearance WHERE "organizationId"=$1`, w.org).Scan(&clearances, &revocations); err != nil || clearances != 2 || revocations != 1 {
		t.Fatalf("immutable clearance history=%d/%d %v", clearances, revocations, err)
	}
}

func TestReleaseKitAuthorityPartialRenderAndTenantBoundary(t *testing.T) {
	w, id, input, objects := kitFixture(t)
	for _, kind := range []string{"api_key", "service", "support", "webhook"} {
		actor := w.owner
		actor.Kind = kind
		if _, err := w.repo.CreateReleaseKitRevision(w.ctx, actor, id, "machine", input); !errors.Is(err, publishing.ErrForbidden) {
			t.Fatalf("machine %s=%v", kind, err)
		}
	}
	created, err := w.repo.CreateReleaseKitRevision(w.ctx, w.owner, id, "assemble", input)
	if err != nil {
		t.Fatal(err)
	}
	other, otherID, _ := qualificationWorkspace(t)
	if _, err := w.repo.GetReleaseKit(w.ctx, other.owner, id, created.ID); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("cross tenant=%v", err)
	}
	if _, err := w.repo.GetReleaseKit(w.ctx, w.owner, otherID, created.ID); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("foreign release=%v", err)
	}
	detail := prepareKitFixture(t, w, id, created.ID)
	decision := DecideReleaseKitInput{ExpectedRevision: detail.Readiness.AggregateRevision, ManifestSHA256: *detail.Readiness.ManifestHash, DependencyToken: detail.Readiness.DependencyToken, ReviewType: "CONTENT_COVERAGE", Decision: "APPROVE", Reason: "Review", AssertionsConfirmed: true, ScreenshotsConfirmed: true, AudienceConfirmed: true}
	for _, kind := range []string{"api_key", "service", "support", "webhook"} {
		actor := w.owner
		actor.Kind = kind
		if _, err := w.repo.DecideReleaseKit(w.ctx, actor, id, detail.ID, "machine-review", decision); !errors.Is(err, publishing.ErrForbidden) {
			t.Fatalf("machine decision %s=%v", kind, err)
		}
	}
	decision.ManifestSHA256 = strings.Repeat("a", 64)
	if _, err := w.repo.DecideReleaseKit(w.ctx, w.owner, id, detail.ID, "wrong-hash", decision); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("wrong hash=%v", err)
	}
	detail = decideKitFixture(t, w, id, detail, "CONTENT_COVERAGE", "APPROVE")
	detail = decideKitFixture(t, w, id, detail, "FINAL_APPROVAL", "APPROVE")
	w.exec(t, `UPDATE member SET role='creator' WHERE "organizationId"=$1 AND "userId"=$2`, w.org, w.owner.UserID)
	current, err := w.repo.GetReleaseKit(w.ctx, w.owner, id, detail.ID)
	if err != nil || current.Readiness.CanExportApproved || !slices.ContainsFunc(current.Readiness.Blockers, func(b releasekits.Blocker) bool { return b.Code == "APPROVER_REVOKED" }) {
		t.Fatalf("revocation=%+v %v", current, err)
	}
	w.exec(t, `UPDATE member SET role='owner' WHERE "organizationId"=$1 AND "userId"=$2`, w.org, w.owner.UserID)
	input.ExpectedRevision = detail.Readiness.AggregateRevision
	input.ExpectedKitRevisionID = &detail.ID
	failed, err := w.repo.CreateReleaseKitRevision(w.ctx, w.owner, id, "failed-candidate", input)
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := w.repo.GetReleaseKit(w.ctx, w.owner, id, failed.ID)
	if err != nil {
		t.Fatal(err)
	}
	prepare := PrepareReleaseKitInput{ExpectedRevision: candidate.Readiness.AggregateRevision}
	for _, a := range candidate.Artifacts {
		prepare.Snapshots = append(prepare.Snapshots, KitSnapshotExpectation{ArtifactRevisionID: a.ID, SnapshotSHA256: a.SnapshotSHA256})
	}
	if _, err := w.repo.PrepareReleaseKit(w.ctx, w.owner, id, failed.ID, "prepare-failure", prepare); err != nil {
		t.Fatal(err)
	}
	w.repo.WithObjectStore(nil)
	if err := w.repo.processKitPreparation(w.ctx, w.org, failed.ID); err != nil {
		t.Fatal(err)
	}
	row := w.db.Client.KitRevision.GetX(w.ctx, failed.ID)
	if row.State != kitrevision.StateFAILED || row.ManifestSha256 != "" {
		t.Fatalf("failure silently ready: %+v", row)
	}
	w.repo.WithObjectStore(objects)
	if handled, err := w.repo.HandleOutboxEvent(w.ctx, "event", w.org, "unknown.kit.event", failed.ID); handled || err != nil {
		t.Fatalf("unknown routing=%v %v", handled, err)
	}
}

type kitDraftRenderer struct{ snapshot releasekits.NativeSnapshot }

func (r *kitDraftRenderer) Render(context.Context, AutomationRenderRequest) ([]AutomationRender, error) {
	return nil, ErrRendererRefused
}
func (r *kitDraftRenderer) RenderKit(_ context.Context, request KitRenderRequest) (KitRenderOutput, error) {
	r.snapshot = request.Snapshot
	return KitRenderOutput{Body: []byte("Current saved facts\n"), MediaType: "text/markdown; charset=utf-8", RendererVersion: releasekits.ExporterVersion}, nil
}

func TestReleaseKitFreezesCurrentSavedDraftAndRejectsConcurrentSave(t *testing.T) {
	w, id, input, objects := kitFixture(t)
	draft, err := w.repo.CreateContentDraft(w.ctx, w.owner, ContentDraftInput{Title: "Kit notes", Body: []any{map[string]any{"id": "fact", "type": "p", "children": []any{map[string]any{"text": "Earlier draft"}}}}, PlainText: "Earlier draft"})
	if err != nil {
		t.Fatal(err)
	}
	current := []any{map[string]any{"id": "fact", "type": "p", "children": []any{map[string]any{"text": "Current saved facts"}}}}
	if err := w.db.Client.ContentDraft.UpdateOneID(draft.ID).SetBody(current).SetPlainText("Current saved facts").SetVersion(2).Exec(w.ctx); err != nil {
		t.Fatal(err)
	}
	input.Artifacts = input.Artifacts[:1]
	input.Artifacts[0].SourceKind = "DRAFT"
	input.Artifacts[0].SourceID = draft.ID
	input.Artifacts[0].ExpectedNativeRevision = "1"
	if _, err := w.repo.CreateReleaseKitRevision(w.ctx, w.owner, id, "stale-draft", input); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("stale saved revision=%v", err)
	}
	input.Artifacts[0].ExpectedNativeRevision = "2"
	assetIDs := []string{uuid.NewString(), uuid.NewString()}
	assetBody := []byte("retained image fixture")
	for _, assetID := range assetIDs {
		key := "org/" + w.org + "/image/" + assetID
		w.exec(t, `INSERT INTO asset(id,"organizationId","objectKey","mediaType",bytes,sha256,status,"updatedAt") VALUES($1,$2,$3,'image/png',$4,$5,'UPLOADED',now())`, assetID, w.org, key, len(assetBody), releasefacts.ByteHash(assetBody))
		objects.files[key] = assetBody
	}
	if err := w.db.Client.ContentDraft.UpdateOneID(draft.ID).SetAssetIds(append(assetIDs, assetIDs[0])).Exec(w.ctx); err != nil {
		t.Fatal(err)
	}
	if err := w.db.Client.Asset.UpdateOneID(assetIDs[1]).SetStatus(asset.StatusPENDING).Exec(w.ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := w.repo.CreateReleaseKitRevision(w.ctx, w.owner, id, "unfinished-assets", input); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("partial asset set=%v", err)
	}
	if err := w.db.Client.Asset.UpdateOneID(assetIDs[1]).SetStatus(asset.StatusUPLOADED).Exec(w.ctx); err != nil {
		t.Fatal(err)
	}
	created, err := w.repo.CreateReleaseKitRevision(w.ctx, w.owner, id, "current-draft", input)
	if err != nil {
		t.Fatal(err)
	}
	detail, err := w.repo.GetReleaseKit(w.ctx, w.owner, id, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	var body []any
	if err := json.Unmarshal(detail.Artifacts[0].Document, &body); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(detail.Artifacts[0].Document), "Current saved facts") || strings.Contains(string(detail.Artifacts[0].Document), "Earlier draft") {
		t.Fatalf("snapshot missed current autosave: %s", detail.Artifacts[0].Document)
	}
	if err := w.db.Client.ContentDraft.UpdateOneID(draft.ID).SetVersion(3).Exec(w.ctx); err != nil {
		t.Fatal(err)
	}
	prepare := PrepareReleaseKitInput{ExpectedRevision: detail.Readiness.AggregateRevision, Snapshots: []KitSnapshotExpectation{{ArtifactRevisionID: detail.Artifacts[0].ID, SnapshotSHA256: detail.Artifacts[0].SnapshotSHA256}}}
	if _, err := w.repo.PrepareReleaseKit(w.ctx, w.owner, id, created.ID, "racing-save", prepare); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("editor save race=%v", err)
	}
	if err := w.db.Client.ContentDraft.UpdateOneID(draft.ID).SetVersion(2).Exec(w.ctx); err != nil {
		t.Fatal(err)
	}
	renderer := &kitDraftRenderer{}
	w.repo.WithAutomationRenderer(renderer)
	prepared := prepareKitFixture(t, w, id, created.ID)
	if renderer.snapshot.Revision != "2" || !strings.Contains(renderer.snapshot.Document, "Current saved facts") {
		t.Fatalf("renderer used a live pointer: %+v", renderer.snapshot)
	}
	if len(renderer.snapshot.Assets) != 2 || !slices.IsSortedFunc(renderer.snapshot.Assets, func(a, b releasekits.AssetPin) int { return strings.Compare(a.ID, b.ID) }) {
		t.Fatalf("asset pins were not unique and ordered: %+v", renderer.snapshot.Assets)
	}
	for _, pin := range renderer.snapshot.Assets {
		if pin.SHA256 != releasefacts.ByteHash(assetBody) || pin.ByteLength != int64(len(assetBody)) {
			t.Fatalf("asset pin lost retained identity: %+v", pin)
		}
	}
	if err := w.db.Client.ContentDraft.UpdateOneID(draft.ID).SetVersion(3).SetPlainText("Unrelated scratch edit").Exec(w.ctx); err != nil {
		t.Fatal(err)
	}
	after, err := w.repo.GetReleaseKit(w.ctx, w.owner, id, created.ID)
	if err != nil || *after.Readiness.ManifestHash != *prepared.Readiness.ManifestHash {
		t.Fatalf("scratch edit mutated snapshot: %+v %v", after, err)
	}
}

type partialKitObjects struct {
	*derivativeObjects
	writes int
}

func (o *partialKitObjects) Put(ctx context.Context, key, mediaType string, body io.Reader) error {
	o.writes++
	if o.writes == 2 {
		return ErrStorageUnavailable
	}
	return o.derivativeObjects.Put(ctx, key, mediaType, body)
}

func TestReleaseKitPartialPreparationRetainsCleanupReferencesAndNeverApproves(t *testing.T) {
	w, id, input, objects := kitFixture(t)
	created, err := w.repo.CreateReleaseKitRevision(w.ctx, w.owner, id, "assemble-partial", input)
	if err != nil {
		t.Fatal(err)
	}
	detail, err := w.repo.GetReleaseKit(w.ctx, w.owner, id, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	prepare := PrepareReleaseKitInput{ExpectedRevision: detail.Readiness.AggregateRevision}
	for _, a := range detail.Artifacts {
		prepare.Snapshots = append(prepare.Snapshots, KitSnapshotExpectation{ArtifactRevisionID: a.ID, SnapshotSHA256: a.SnapshotSHA256})
	}
	if _, err := w.repo.PrepareReleaseKit(w.ctx, w.owner, id, created.ID, "prepare-partial", prepare); err != nil {
		t.Fatal(err)
	}
	partial := &partialKitObjects{derivativeObjects: objects}
	w.repo.WithObjectStore(partial)
	if err := w.repo.processKitPreparation(w.ctx, w.org, created.ID); err != nil {
		t.Fatal(err)
	}
	after, err := w.repo.GetReleaseKit(w.ctx, w.owner, id, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.State != "FAILED" || after.Readiness.CanApprove || after.Readiness.CanExportApproved || !after.Artifacts[0].Prepared || after.Artifacts[1].Prepared {
		t.Fatalf("partial output accepted: %+v", after)
	}
	row := w.db.Client.KitArtifactRevision.GetX(w.ctx, after.Artifacts[1].ID)
	if row.OutputKey == nil {
		t.Fatal("failed PUT lost its cleanup reference")
	}
	preview, err := w.repo.GetKitArtifactPreview(w.ctx, w.owner, id, created.ID, after.Artifacts[0].ID)
	if err != nil || len(preview.Body) == 0 {
		t.Fatalf("prepared preview=%+v %v", preview, err)
	}
	actor := w.owner
	actor.Kind = "api_key"
	if _, err := w.repo.GetKitArtifactPreview(w.ctx, actor, id, created.ID, after.Artifacts[0].ID); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("machine private preview=%v", err)
	}
	if err := w.repo.processKitPreparation(w.ctx, w.org, created.ID); err != nil || partial.writes != 2 {
		t.Fatalf("failed candidate silently retried: %d %v", partial.writes, err)
	}
}

func TestReleaseKitApprovalSerializesWithSourceChangeAndRevocation(t *testing.T) {
	for _, revoke := range []bool{false, true} {
		t.Run(fmt.Sprint("revoke=", revoke), func(t *testing.T) {
			w, id, input, _ := kitFixture(t)
			created, err := w.repo.CreateReleaseKitRevision(w.ctx, w.owner, id, "assemble-race", input)
			if err != nil {
				t.Fatal(err)
			}
			detail := decideKitFixture(t, w, id, prepareKitFixture(t, w, id, created.ID), "CONTENT_COVERAGE", "APPROVE")
			tx, err := w.db.SQL.BeginTx(w.ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback()
			lock := `SELECT id FROM platform_evidence_source WHERE "organizationId"=$1 FOR UPDATE`
			change := `UPDATE platform_evidence_source SET "changeSequence"="changeSequence"+1 WHERE "organizationId"=$1`
			if revoke {
				if _, err := tx.ExecContext(w.ctx, `SELECT id FROM organization WHERE id=$1 FOR UPDATE`, w.org); err != nil {
					t.Fatal(err)
				}
				lock = `SELECT id FROM member WHERE "organizationId"=$1 FOR UPDATE`
				change = `UPDATE member SET role='viewer' WHERE "organizationId"=$1`
			}
			if _, err := tx.ExecContext(w.ctx, lock, w.org); err != nil {
				t.Fatal(err)
			}
			started := make(chan struct{})
			done := make(chan error, 1)
			go func() {
				close(started)
				_, err := w.repo.DecideReleaseKit(w.ctx, w.owner, id, detail.ID, "racing-approval", DecideReleaseKitInput{ExpectedRevision: detail.Readiness.AggregateRevision, ManifestSHA256: *detail.Readiness.ManifestHash, DependencyToken: detail.Readiness.DependencyToken, ReviewType: "FINAL_APPROVAL", Decision: "APPROVE", Reason: "Reviewed exact bytes."})
				done <- err
			}()
			<-started
			select {
			case err := <-done:
				t.Fatalf("approval ignored dependency lock: %v", err)
			case <-time.After(30 * time.Millisecond):
			}
			if _, err := tx.ExecContext(w.ctx, change, w.org); err != nil {
				t.Fatal(err)
			}
			if err := tx.Commit(); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-done:
				if !errors.Is(err, publishing.ErrConflict) && !errors.Is(err, publishing.ErrForbidden) {
					t.Fatalf("racing approval=%v", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("approval did not finish")
			}
			current := w.db.Client.KitRevision.GetX(w.ctx, detail.ID)
			if current.State != kitrevision.StateREVIEWABLE {
				t.Fatalf("racing source/authority change approved: %s", current.State)
			}
		})
	}
}

func TestKitPrivateSourceURLCannotHideBehindJSONEscaping(t *testing.T) {
	source := "https://private.example/evidence?token=one&document=two"
	raw, _ := json.Marshal([]any{map[string]any{"type": "a", "url": source, "children": []any{map[string]any{"text": "Evidence"}}}})
	if !kitContainsSourceURL(releasekits.NativeSnapshot{Document: string(raw)}, source) {
		t.Fatal("escaped private URL bypassed audience gate")
	}
	if kitContainsSourceURL(releasekits.NativeSnapshot{Document: `[{"text":"Public facts"}]`}, source) {
		t.Fatal("safe copy blocked")
	}
}

func TestReleaseKitCreativeSnapshotPinsSelectedSavedOutput(t *testing.T) {
	t.Setenv("PLATFORM_CREATIVE_SETS", "enabled")
	w, id, input, _ := kitFixture(t)
	assetID := uuid.NewString()
	w.exec(t, `INSERT INTO asset(id,"organizationId","objectKey","mediaType",bytes,status,sha256,"createdAt","updatedAt") VALUES($1,$2,$3,'image/png',100,'UPLOADED',$4,now(),now())`, assetID, w.org, "org/"+w.org+"/input/"+assetID+"/1/screen.png", strings.Repeat("a", 64))
	creative, err := w.repo.CreateCreativeSet(w.ctx, w.owner, cuid.New(), "Reviewed screenshot", creativeSetFixture(assetID))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		w.exec(t, `DELETE FROM platform_creative_set_version WHERE "organizationId"=$1`, w.org)
		w.exec(t, `DELETE FROM platform_creative_set WHERE "organizationId"=$1`, w.org)
		w.exec(t, `DELETE FROM asset WHERE id=$1`, assetID)
	})
	input.Artifacts = []KitArtifactInput{{Kind: "SCREENSHOT", AudienceID: "sales", Classification: "INTERNAL_MATERIAL", SourceKind: "CREATIVE", SourceID: creative.ID, ExpectedNativeRevision: "1", OutputID: "missing"}}
	if _, err := w.repo.CreateReleaseKitRevision(w.ctx, w.owner, id, "missing-output", input); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("missing output=%v", err)
	}
	input.Artifacts[0].OutputID = "wide"
	created, err := w.repo.CreateReleaseKitRevision(w.ctx, w.owner, id, "saved-output", input)
	if err != nil {
		t.Fatal(err)
	}
	detail, err := w.repo.GetReleaseKit(w.ctx, w.owner, id, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	row := w.db.Client.KitArtifactRevision.GetX(w.ctx, detail.Artifacts[0].ID)
	if row.Snapshot.OutputID != "wide" || row.Snapshot.Revision != "1" || len(row.Snapshot.Assets) != 1 || row.Snapshot.Assets[0].SHA256 != strings.Repeat("a", 64) {
		t.Fatalf("snapshot=%+v", row.Snapshot)
	}
	input.ExpectedRevision = detail.Readiness.AggregateRevision
	input.ExpectedKitRevisionID = &detail.ID
	w.exec(t, `UPDATE platform_creative_set SET kind='canvas' WHERE id=$1`, creative.ID)
	if _, err := w.repo.CreateReleaseKitRevision(w.ctx, w.owner, id, "unsupported-kind", input); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("unsupported creative kind=%v", err)
	}
}
