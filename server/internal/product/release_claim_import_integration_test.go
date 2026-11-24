package product

import (
	"encoding/json"
	"fmt"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/outboxevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasespec"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/claimpathbinding"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/evidenceversion"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseclaim"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasefacts"
)

func TestReleaseClaimImportStableIdentityAndOriginalSources(t *testing.T) {
	w, id := evidenceWorkspace(t)
	input := SaveLaunchSpecInput{Origin: "human", Content: json.RawMessage(`{"summary":{"text":"Summary","sources":["S1"]},"capabilities":[{"name":"Same","description":"Duplicated text","sources":["S1"]},{"name":"Same","description":"Duplicated text","sources":["S1"]}]}`), Sources: json.RawMessage(`[{"id":"S1","status":"ok","excerpt":"Original source","url":"https://example.com/one"}]`)}
	first, err := w.repo.SaveLaunchSpec(w.ctx, w.owner, id, input)
	if err != nil {
		t.Fatal(err)
	}
	claims, document, err := releasefacts.LegacySpecClaims(first.Content)
	if err != nil || len(claims) != 3 {
		t.Fatalf("import=%+v err=%v", claims, err)
	}
	if claims[1].ClaimID == claims[2].ClaimID || claims[1].ClaimID == "" {
		t.Fatal("identical text merged identities")
	}
	bindings := w.db.Client.ClaimPathBinding.Query().Where(claimpathbinding.OrganizationID(w.org), claimpathbinding.SpecID(first.ID)).AllX(w.ctx)
	if len(bindings) != 3 {
		t.Fatalf("bindings=%d", len(bindings))
	}
	var capabilities []json.RawMessage
	if err := json.Unmarshal(document["capabilities"], &capabilities); err != nil {
		t.Fatal(err)
	}
	capabilities[0], capabilities[1] = capabilities[1], capabilities[0]
	document["capabilities"], err = json.Marshal(capabilities)
	if err != nil {
		t.Fatal(err)
	}
	input.Content, err = json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	input.Sources = json.RawMessage(`[{"id":"S1","status":"ok","excerpt":"Different source","url":"https://example.com/two"}]`)
	second, err := w.repo.SaveLaunchSpec(w.ctx, w.owner, id, input)
	if err != nil {
		t.Fatal(err)
	}
	next, _, err := releasefacts.LegacySpecClaims(second.Content)
	if err != nil {
		t.Fatal(err)
	}
	if next[1].ClaimID != claims[2].ClaimID || next[1].ClaimVersionID != claims[2].ClaimVersionID || next[2].ClaimID != claims[1].ClaimID {
		t.Fatalf("reorder rebound stable IDs: %+v", next)
	}
	if count := w.db.Client.ReleaseClaim.Query().Where(releaseclaim.OrganizationID(w.org)).CountX(w.ctx); count != 3 {
		t.Fatalf("reorder created %d claims", count)
	}
	sources := w.db.Client.EvidenceVersion.Query().Where(evidenceversion.OrganizationID(w.org)).AllX(w.ctx)
	if len(sources) != 2 || sources[0].SourceID == sources[1].SourceID || sources[0].ProviderRevision == sources[1].ProviderRevision {
		t.Fatalf("S1 rebound across specs: %+v", sources)
	}
	for _, row := range sources {
		if row.Origin != "AI" || row.ConfirmedAt != nil {
			t.Fatal("imported source claimed human verification")
		}
	}
	original := w.db.Client.ClaimPathBinding.Query().Where(claimpathbinding.OrganizationID(w.org), claimpathbinding.SpecID(first.ID), claimpathbinding.LegacyPath("capabilities.0")).OnlyX(w.ctx)
	if original.ClaimVersionID != claims[1].ClaimVersionID {
		t.Fatal("historical path changed")
	}
	input.Content = json.RawMessage(`{"summary":{"text":"Summary","sources":["S1"]},"capabilities":[{"name":"Same","description":"Duplicated text","sources":["S1"]}]}`)
	third, err := w.repo.SaveLaunchSpec(w.ctx, w.owner, id, input)
	if err != nil {
		t.Fatal(err)
	}
	ambiguous, _, err := releasefacts.LegacySpecClaims(third.Content)
	if err != nil {
		t.Fatal(err)
	}
	if ambiguous[1].ClaimID == claims[1].ClaimID || ambiguous[1].ClaimID == claims[2].ClaimID {
		t.Fatal("ambiguous legacy text guessed an identity")
	}
	page, err := w.repo.ListReleaseClaims(w.ctx, w.owner, id, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, claim := range page.Items {
		if claim.Decision != nil || claim.State != "UNRESOLVED" {
			t.Fatal("legacy import inferred factual verification")
		}
	}
}

func TestReleaseClaimLegacyImportPreservesHistoricalApproval(t *testing.T) {
	w, id := evidenceWorkspace(t)
	w.exec(t, `UPDATE workspace_settings SET "releaseReadinessEnabled"=false WHERE "organizationId"=$1`, w.org)
	legacy, err := w.repo.SaveLaunchSpec(w.ctx, w.owner, id, SaveLaunchSpecInput{Origin: "ai", Content: json.RawMessage(`{"summary":{"text":"Legacy claim","sources":["brief"]}}`)})
	if err != nil {
		t.Fatal(err)
	}
	approved, err := w.repo.ApproveLaunchSpec(w.ctx, w.owner, legacy.ID)
	if err != nil {
		t.Fatal(err)
	}
	before := w.db.Client.ReleaseSpec.GetX(w.ctx, legacy.ID)
	w.exec(t, `UPDATE workspace_settings SET "releaseReadinessEnabled"=true WHERE "organizationId"=$1`, w.org)
	result, err := w.repo.ImportReleaseSpecClaims(w.ctx, w.owner, id, "import", ImportReleaseSpecInput{ExpectedRevision: "0", SpecID: legacy.ID})
	if err != nil {
		t.Fatal(err)
	}
	row := w.db.Client.ReleaseSpec.GetX(w.ctx, legacy.ID)
	if string(row.Status) != approved.Status || string(row.Content) != string(before.Content) || row.ApprovedByUserID == nil || *row.ApprovedByUserID != w.owner.UserID || row.ApprovedAt == nil || before.ApprovedAt == nil || !row.ApprovedAt.Equal(*before.ApprovedAt) {
		t.Fatalf("historical approval mutated: %+v", row)
	}
	if len(result.IDs) != 2 {
		t.Fatalf("import references=%+v", result)
	}
	page, err := w.repo.ListReleaseClaims(w.ctx, w.owner, id, "")
	if err != nil || len(page.Items) != 1 || page.Items[0].State != "UNRESOLVED" || page.Items[0].Origin != "AI" {
		t.Fatalf("legacy review=%+v err=%v", page, err)
	}
}

func TestReleaseClaimBackfillResumesAndSkipsInvalidSpecs(t *testing.T) {
	w, id := evidenceWorkspace(t)
	w.exec(t, `UPDATE workspace_settings SET "releaseReadinessEnabled"=false WHERE "organizationId"=$1`, w.org)
	var invalid string
	for i := 0; i < 7; i++ {
		row, err := w.repo.SaveLaunchSpec(w.ctx, w.owner, id, SaveLaunchSpecInput{Origin: "human", Content: json.RawMessage(`{"summary":{"text":"Legacy claim","sources":["S1"]}}`), Sources: json.RawMessage(`[]`)})
		if err != nil {
			t.Fatal(err)
		}
		if i == 2 {
			invalid = row.ID
		}
	}
	w.db.Client.ReleaseSpec.Update().Where(releasespec.ID(invalid)).SetContent(json.RawMessage(`{"summary":"invalid legacy shape"}`)).ExecX(w.ctx)
	w.exec(t, `UPDATE workspace_settings SET "releaseReadinessEnabled"=true WHERE "organizationId"=$1`, w.org)
	beforeEvents := w.db.Client.OutboxEvent.Query().Where(outboxevent.OrganizationID(w.org)).CountX(w.ctx)
	revision := "0"
	for batch := 0; batch < 2; batch++ {
		input := ImportReleaseSpecInput{ExpectedRevision: revision}
		result, err := w.repo.ImportReleaseSpecClaims(w.ctx, w.owner, id, fmt.Sprintf("batch-%d", batch), input)
		if err != nil {
			t.Fatal(err)
		}
		replay, err := w.repo.ImportReleaseSpecClaims(w.ctx, w.owner, id, fmt.Sprintf("batch-%d", batch), input)
		if err != nil || replay.Created || replay.Revision != result.Revision {
			t.Fatalf("replay=%+v %v", replay, err)
		}
		revision = result.Revision
		page, err := w.repo.ListReleaseClaims(w.ctx, w.owner, id, "")
		if err != nil {
			t.Fatal(err)
		}
		if page.ImportProgress.Done != (batch == 1) {
			t.Fatalf("progress=%+v", page.ImportProgress)
		}
		if batch == 1 && (page.ImportProgress.Imported != 6 || page.ImportProgress.Invalid != 1 || len(page.Items) != 6) {
			t.Fatalf("progress=%+v claims=%d", page.ImportProgress, len(page.Items))
		}
		if w.db.Client.OutboxEvent.Query().Where(outboxevent.OrganizationID(w.org)).CountX(w.ctx) != beforeEvents {
			t.Fatal("backfill emitted notifications")
		}
		for _, claim := range page.Items {
			if claim.State != "UNRESOLVED" || claim.Decision != nil {
				t.Fatal("backfill inferred approval")
			}
		}
	}
}
