package product

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/claimverification"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasefacts"
)

func claimInput(revision string) SaveReleaseClaimInput {
	return SaveReleaseClaimInput{ExpectedRevision: revision, Text: "Exports are available to Pro workspaces.", Origin: "HUMAN", Qualifiers: releasefacts.ClaimQualifiers{Audience: "Workspace administrators", Availability: "Available now", Eligibility: "Pro plan", Limitations: "Unavailable offline"}}
}

func claimReviewFixture(t *testing.T) (*testWorkspace, string, string, VerifyReleaseClaimInput, SetClaimSupportsInput) {
	t.Helper()
	w, id := evidenceWorkspace(t)
	evidence, err := w.repo.CreateReleaseEvidence(w.ctx, w.owner, id, "evidence", evidenceInput())
	if err != nil {
		t.Fatal(err)
	}
	facts := qualifiedFactsFixture()
	facts.OwnerUserID, facts.FactReviewerUserID = &w.owner.UserID, &w.owner.UserID
	if _, err := w.repo.CreateQualificationRevision(w.ctx, w.owner, id, "facts", CreateQualificationInput{ExpectedRevision: "1", Facts: facts}); err != nil {
		t.Fatal(err)
	}
	claim, err := w.repo.SaveReleaseClaim(w.ctx, w.owner, id, "claim", claimInput("2"))
	if err != nil {
		t.Fatal(err)
	}
	row := w.db.Client.EvidenceVersion.GetX(w.ctx, evidence.ID)
	selector := releasefacts.EvidenceSelector{Kind: "TEXT_SPAN", EndByte: len(*row.NormalizedText), QuoteSHA256: row.NormalizedSha256, ContextSHA256: row.NormalizedSha256}
	supportInput := SetClaimSupportsInput{ExpectedRevision: "3", ClaimVersionID: claim.IDs[1], Supports: []ClaimSupportInput{{EvidenceVersionID: row.ID, ExpectedSourceSequence: "1", Relation: "SUPPORTS", Selector: selector}}}
	support, err := w.repo.SetClaimSupports(w.ctx, w.owner, id, claim.ID, "support", supportInput)
	if err != nil {
		t.Fatal(err)
	}
	set := w.db.Client.ClaimSupportSet.GetX(w.ctx, support.ID)
	version := w.db.Client.ReleaseClaimVersion.GetX(w.ctx, claim.IDs[1])
	input := VerifyReleaseClaimInput{ExpectedRevision: "4", ClaimVersionID: version.ID, ClaimSHA256: version.ContentSha256, SupportSetID: set.ID, SupportSHA256: set.SupportSha256, Decision: "SUPPORTED", Reason: "The retained passage explicitly confirms the audience, availability and limitations."}
	return w, id, claim.ID, input, supportInput
}

func TestReleaseClaimDecisionAndSelectiveInvalidation(t *testing.T) {
	w, id, claimID, input, _ := claimReviewFixture(t)
	before, err := w.repo.ListReleaseClaims(w.ctx, w.owner, id, "")
	if err != nil || len(before.Items) != 1 || before.Items[0].State != "UNRESOLVED" || before.Items[0].Decision != nil {
		t.Fatalf("before=%+v err=%v", before, err)
	}
	decided, err := w.repo.VerifyReleaseClaim(w.ctx, w.owner, id, claimID, "verify", input)
	if err != nil || decided.Revision != "5" {
		t.Fatalf("decision=%+v err=%v", decided, err)
	}
	replay, err := w.repo.VerifyReleaseClaim(w.ctx, w.owner, id, claimID, "verify", input)
	if err != nil || replay.Created || replay.ID != decided.ID {
		t.Fatalf("replay=%+v err=%v", replay, err)
	}
	other, err := w.repo.SaveReleaseClaim(w.ctx, w.owner, id, "other", claimInput("5"))
	if err != nil {
		t.Fatal(err)
	}
	page, err := w.repo.ListReleaseClaims(w.ctx, w.owner, id, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range page.Items {
		if item.ID == claimID && (item.State != "SUPPORTED" || item.Decision.ID != decided.ID) {
			t.Fatalf("unrelated claim invalidated verified claim: %+v", item)
		}
	}
	edit := claimInput("6")
	edit.ClaimID, edit.ExpectedClaimVersionID = &claimID, &input.ClaimVersionID
	edit.Text = "Exports are available to all workspaces."
	changed, err := w.repo.SaveReleaseClaim(w.ctx, w.owner, id, "edit", edit)
	if err != nil || changed.ID != claimID || changed.IDs[1] == input.ClaimVersionID {
		t.Fatalf("edit=%+v err=%v", changed, err)
	}
	page, err = w.repo.ListReleaseClaims(w.ctx, w.owner, id, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range page.Items {
		if item.State != "UNRESOLVED" || item.Decision != nil {
			t.Fatalf("edit kept verification: %+v", item)
		}
	}
	if count := w.db.Client.ClaimVerification.Query().Where(claimverification.OrganizationID(w.org)).CountX(w.ctx); count != 1 {
		t.Fatalf("lost historical decision: %d", count)
	}
	if unchanged := w.db.Client.ReleaseClaim.GetX(w.ctx, other.ID); unchanged.CurrentVersionID == nil || *unchanged.CurrentVersionID != other.IDs[1] {
		t.Fatal("unrelated claim changed")
	}
	input.ExpectedRevision = "7"
	_, err = w.repo.VerifyReleaseClaim(w.ctx, w.owner, id, claimID, "stale", input)
	requireQualificationFailure(t, err, "CLAIM_CHANGED")
}

func TestReleaseClaimReviewAuthorityAndRace(t *testing.T) {
	w, id, claimID, input, _ := claimReviewFixture(t)
	for _, kind := range []string{"api_key", "service", "support", "webhook"} {
		actor := w.owner
		actor.Kind = kind
		if _, err := w.repo.VerifyReleaseClaim(w.ctx, actor, id, claimID, kind, input); !errors.Is(err, publishing.ErrForbidden) {
			t.Fatalf("%s decision: %v", kind, err)
		}
	}
	w.exec(t, `UPDATE member SET role='creator' WHERE "organizationId"=$1 AND "userId"=$2`, w.org, w.owner.UserID)
	if _, err := w.repo.VerifyReleaseClaim(w.ctx, w.owner, id, claimID, "role", input); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("assignment granted role: %v", err)
	}
	w.exec(t, `UPDATE member SET role='owner' WHERE "organizationId"=$1 AND "userId"=$2`, w.org, w.owner.UserID)
	wrong := input
	wrong.SupportSHA256 = strings.Repeat("0", 64)
	_, err := w.repo.VerifyReleaseClaim(w.ctx, w.owner, id, claimID, "wrong", wrong)
	requireQualificationFailure(t, err, "CLAIM_CHANGED")
	var group sync.WaitGroup
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		group.Add(1)
		go func(i int) {
			defer group.Done()
			_, err := w.repo.VerifyReleaseClaim(w.ctx, w.owner, id, claimID, "race-"+strconv.Itoa(i), input)
			errs <- err
		}(i)
	}
	group.Wait()
	close(errs)
	successes, conflicts := 0, 0
	for err := range errs {
		if err == nil {
			successes++
		} else {
			requireQualificationFailure(t, err, "REVISION_CONFLICT")
			conflicts++
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("success=%d conflict=%d", successes, conflicts)
	}
	if count := w.db.Client.ClaimVerification.Query().Where(claimverification.OrganizationID(w.org)).CountX(w.ctx); count != 1 {
		t.Fatalf("race committed %d decisions", count)
	}
	w.exec(t, `UPDATE member SET role='viewer' WHERE "organizationId"=$1 AND "userId"=$2`, w.org, w.owner.UserID)
	page, err := w.repo.ListReleaseClaims(w.ctx, w.owner, id, "")
	if err != nil || page.Items[0].State != "UNRESOLVED" || page.Items[0].Blockers[0] != "REVIEWER_UNAVAILABLE" {
		t.Fatalf("revoked reviewer read=%+v err=%v", page, err)
	}
}

func TestReleaseClaimSelectorsContradictionsAndSourceFence(t *testing.T) {
	w, id, claimID, input, support := claimReviewFixture(t)
	invalid := support
	invalid.ExpectedRevision = "4"
	invalid.Supports = append([]ClaimSupportInput{}, support.Supports...)
	invalid.Supports[0].Selector.EndByte = 9999
	if _, err := w.repo.SetClaimSupports(w.ctx, w.owner, id, claimID, "invalid-span", invalid); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("invalid selector=%v", err)
	}
	contradiction := support.Supports[0]
	contradiction.Relation = "CONTRADICTS"
	support.ExpectedRevision = "4"
	support.Supports = append(support.Supports, contradiction)
	changed, err := w.repo.SetClaimSupports(w.ctx, w.owner, id, claimID, "contradiction", support)
	if err != nil {
		t.Fatal(err)
	}
	set := w.db.Client.ClaimSupportSet.GetX(w.ctx, changed.ID)
	input.ExpectedRevision, input.SupportSetID, input.SupportSHA256 = "5", set.ID, set.SupportSha256
	_, err = w.repo.VerifyReleaseClaim(w.ctx, w.owner, id, claimID, "contradicted", input)
	requireQualificationFailure(t, err, "CONTRADICTION_NOT_REVIEWED")
	dropped := support
	dropped.ExpectedRevision = "5"
	dropped.Supports = support.Supports[:1]
	_, err = w.repo.SetClaimSupports(w.ctx, w.owner, id, claimID, "drop", dropped)
	requireQualificationFailure(t, err, "CONTRADICTION_NOT_REVIEWED")
	support.ExpectedRevision = "5"
	support.Supports[1].ExclusionReason = "This adjacent context describes the older edition, not the Pro rollout."
	changed, err = w.repo.SetClaimSupports(w.ctx, w.owner, id, claimID, "exclude", support)
	if err != nil {
		t.Fatal(err)
	}
	set = w.db.Client.ClaimSupportSet.GetX(w.ctx, changed.ID)
	input.ExpectedRevision, input.SupportSetID, input.SupportSHA256 = "6", set.ID, set.SupportSha256
	if _, err = w.repo.VerifyReleaseClaim(w.ctx, w.owner, id, claimID, "verified", input); err != nil {
		t.Fatal(err)
	}
	evidence := w.db.Client.EvidenceVersion.GetX(w.ctx, support.Supports[0].EvidenceVersionID)
	sequence := "1"
	replacement := evidenceInput()
	replacement.ExpectedRevision, replacement.SourceID, replacement.ExpectedSourceSequence = "7", &evidence.SourceID, &sequence
	replacement.Text = "Exports are no longer offered."
	if _, err := w.repo.CreateReleaseEvidence(w.ctx, w.owner, id, "replace", replacement); err != nil {
		t.Fatal(err)
	}
	page, err := w.repo.ListReleaseClaims(w.ctx, w.owner, id, "")
	if err != nil || page.Items[0].State != "UNRESOLVED" || page.Items[0].Blockers[0] != "SOURCE_CHANGED" {
		t.Fatalf("stopped fanout read=%+v err=%v", page, err)
	}
	input.ExpectedRevision = "8"
	_, err = w.repo.VerifyReleaseClaim(w.ctx, w.owner, id, claimID, "stale-source", input)
	requireQualificationFailure(t, err, "SOURCE_CHANGED")
	other, otherID := evidenceWorkspace(t)
	if _, err := other.repo.ListReleaseClaims(other.ctx, other.owner, id, ""); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("cross-tenant read=%v", err)
	}
	if _, err := w.db.SQL.ExecContext(w.ctx, `INSERT INTO platform_claim_support(id,"organizationId","releaseId","claimId","claimVersionId","supportSetId","evidenceVersionId",relation,selector,"selectorSha256") VALUES('invalid',$1,$2,$3,$4,$5,$6,'SUPPORTS','{}',$7)`, other.org, otherID, claimID, input.ClaimVersionID, input.SupportSetID, evidence.ID, strings.Repeat("0", 64)); err == nil {
		t.Fatal("foreign claim accepted by database")
	}
}

func TestReleaseClaimPaginationKeepsHistoricalClaimsReachable(t *testing.T) {
	w, id := evidenceWorkspace(t)
	for i := 0; i < 102; i++ {
		input := claimInput(strconv.Itoa(i))
		input.Text = fmt.Sprintf("Historical product fact %d", i)
		if _, err := w.repo.SaveReleaseClaim(w.ctx, w.owner, id, fmt.Sprintf("claim-%d", i), input); err != nil {
			t.Fatal(err)
		}
	}
	seen := map[string]bool{}
	cursor := ""
	for pageNumber := 0; pageNumber < 3; pageNumber++ {
		page, err := w.repo.ListReleaseClaims(w.ctx, w.owner, id, cursor)
		if err != nil {
			t.Fatal(err)
		}
		want := 50
		if pageNumber == 2 {
			want = 2
		}
		if len(page.Items) != want {
			t.Fatalf("page %d has %d claims", pageNumber, len(page.Items))
		}
		for _, claim := range page.Items {
			if seen[claim.ID] {
				t.Fatal("duplicate across cursor pages")
			}
			seen[claim.ID] = true
		}
		if pageNumber < 2 {
			if page.NextCursor == nil {
				t.Fatal("missing cursor")
			}
			cursor = *page.NextCursor
		} else if page.NextCursor != nil {
			t.Fatal("unexpected final cursor")
		}
	}
	if len(seen) != 102 {
		t.Fatal("historical claims omitted")
	}
}
