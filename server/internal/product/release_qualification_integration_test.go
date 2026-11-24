package product

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/outboxevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasequalification"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasequalificationdecision"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasefacts"
	"github.com/lucsky/cuid"
)

func qualificationWorkspace(t *testing.T) (*testWorkspace, string, releasefacts.Facts) {
	t.Helper()
	w := newTestWorkspace(t)
	subscribe(t, w.ctx, w.repo, w.org, "pro")
	enabled := true
	if _, err := w.repo.UpdateWorkspace(w.ctx, w.owner, UpdateWorkspaceInput{Name: "Qualification", Slug: w.org, ReleaseReadinessEnabled: &enabled}); err != nil {
		t.Fatal(err)
	}
	id := cuid.New()
	w.exec(t, `INSERT INTO release(id,"organizationId",title,"benefitStatement","updatedAt") VALUES($1,$2,'Manual release','Useful change',now())`, id, w.org)
	qualificationFixtureCleanup(t, w)
	facts := qualifiedFactsFixture()
	facts.OwnerUserID, facts.FactReviewerUserID = &w.owner.UserID, &w.owner.UserID
	return w, id, facts
}

func qualificationFixtureCleanup(t *testing.T, w *testWorkspace) {
	t.Helper()
	t.Cleanup(func() {
		for _, table := range []string{"platform_release_lineage_binding", "platform_release_lineage", "platform_release_readiness", "platform_readiness_command_receipt", "platform_release_qualification_decision", "platform_release_qualification_source", "platform_release_qualification_asset", "platform_release_qualification"} {
			w.exec(t, `DELETE FROM `+table+` WHERE "organizationId"=$1`, w.org)
		}
	})
}

func requireQualificationFailure(t *testing.T, err error, reason string) {
	t.Helper()
	var failure *QualificationError
	if !errors.As(err, &failure) || failure.Reason != reason {
		t.Fatalf("want %s, got %v", reason, err)
	}
}

func TestQualificationManualDecisionAndReplay(t *testing.T) {
	w, id, facts := qualificationWorkspace(t)
	before, err := w.repo.GetReleaseQualification(w.ctx, w.owner, id)
	if err != nil || before.Revision != "0" || before.Current != nil || before.State != "NEEDS_FACTS" || before.FirstQualifiedAt != nil {
		t.Fatalf("historical release inferred qualified: %+v %v", before, err)
	}
	input := CreateQualificationInput{ExpectedRevision: "0", Facts: facts}
	draft, err := w.repo.CreateQualificationRevision(w.ctx, w.owner, id, "facts-1", input)
	if err != nil || !draft.Created || draft.Revision != "1" {
		t.Fatalf("create: %+v %v", draft, err)
	}
	replay, err := w.repo.CreateQualificationRevision(w.ctx, w.owner, id, "facts-1", input)
	if err != nil || replay.Created || replay.QualificationRevisionID != draft.QualificationRevisionID || replay.Revision != "1" {
		t.Fatalf("draft replay: %+v %v", replay, err)
	}
	changed := input
	changed.Facts.Rollout = "UNKNOWN"
	_, err = w.repo.CreateQualificationRevision(w.ctx, w.owner, id, "facts-1", changed)
	requireQualificationFailure(t, err, "COMMAND_KEY_REUSED")
	decisionInput := DecideQualificationInput{ExpectedRevision: "1", QualificationRevisionID: draft.QualificationRevisionID, Decision: "QUALIFIED", Reason: "I confirmed the release facts."}
	decision, err := w.repo.DecideQualification(w.ctx, w.owner, id, "qualify-1", decisionInput)
	if err != nil || decision.DecisionID == nil || decision.Revision != "2" {
		t.Fatalf("decide: %+v %v", decision, err)
	}
	qualified, err := w.repo.GetReleaseQualification(w.ctx, w.owner, id)
	if err != nil || qualified.State != "QUALIFIED" || qualified.FirstQualifiedAt == nil || qualified.Current.Decision.HumanUserID != w.owner.UserID {
		t.Fatalf("qualified read: %+v %v", qualified, err)
	}
	replay, err = w.repo.DecideQualification(w.ctx, w.owner, id, "qualify-1", decisionInput)
	if err != nil || replay.Created || replay.DecisionID == nil || *replay.DecisionID != *decision.DecisionID {
		t.Fatalf("decision replay: %+v %v", replay, err)
	}
	for label, count := range map[string]int{
		"facts":     w.db.Client.ReleaseQualification.Query().Where(releasequalification.OrganizationID(w.org)).CountX(w.ctx),
		"decisions": w.db.Client.ReleaseQualificationDecision.Query().Where(releasequalificationdecision.OrganizationID(w.org)).CountX(w.ctx),
		"events":    w.db.Client.OutboxEvent.Query().Where(outboxevent.OrganizationID(w.org), outboxevent.Type("activity.release.qualification_changed")).CountX(w.ctx),
	} {
		want := 1
		if label == "events" {
			want = 2
		}
		if count != want {
			t.Fatalf("%s count=%d want=%d", label, count, want)
		}
	}
	var sends int
	if err := w.db.SQL.QueryRow(`SELECT count(*) FROM scheduled_post WHERE "organizationId"=$1`, w.org).Scan(&sends); err != nil || sends != 0 {
		t.Fatalf("qualification scheduled delivery: %d %v", sends, err)
	}
	_, err = w.db.SQL.Exec(`UPDATE platform_release_qualification SET rollout='UNKNOWN' WHERE id=$1`, draft.QualificationRevisionID)
	if err == nil {
		t.Fatal("immutable facts could be overwritten")
	}
	_, err = w.db.SQL.Exec(`UPDATE platform_release_qualification_decision SET reason='Changed' WHERE id=$1`, *decision.DecisionID)
	if err == nil {
		t.Fatal("immutable decision could be overwritten")
	}
	// Authorization is rechecked even when the receipt already exists.
	w.exec(t, `DELETE FROM session WHERE id=$1`, w.owner.SessionID)
	if _, err = w.repo.DecideQualification(w.ctx, w.owner, id, "qualify-1", decisionInput); !errors.Is(err, publishing.ErrUnauthorized) {
		t.Fatalf("revoked session replay: %v", err)
	}
}

func TestQualificationUnknownFactsAndLegitimateOutcomes(t *testing.T) {
	for _, outcome := range []string{"NO_COMMUNICATION", "DEFERRED"} {
		t.Run(outcome, func(t *testing.T) {
			w, id, facts := qualificationWorkspace(t)
			facts.Requirements, facts.ReadyAt, facts.Availability, facts.Exclusions, facts.Rollout = nil, nil, nil, nil, "UNKNOWN"
			draft, err := w.repo.CreateQualificationRevision(w.ctx, w.owner, id, "draft", CreateQualificationInput{ExpectedRevision: "0", Facts: facts})
			if err != nil {
				t.Fatal(err)
			}
			input := DecideQualificationInput{ExpectedRevision: "1", QualificationRevisionID: draft.QualificationRevisionID, Decision: "QUALIFIED", Reason: "Review"}
			_, err = w.repo.DecideQualification(w.ctx, w.owner, id, "decision", input)
			requireQualificationFailure(t, err, "MISSING_FACTS")
			input.Decision = outcome
			// Failed validation must not consume the receipt key or advance the head.
			if _, err := w.repo.DecideQualification(w.ctx, w.owner, id, "decision", input); err != nil {
				t.Fatal(err)
			}
			detail, err := w.repo.GetReleaseQualification(w.ctx, w.owner, id)
			if err != nil || detail.State != outcome || detail.Revision != "2" || detail.FirstQualifiedAt != nil || detail.Current.Facts.ReadyAt != nil {
				t.Fatalf("outcome: %+v %v", detail, err)
			}
		})
	}
}

func TestQualificationAuthorityAndTenantBoundaries(t *testing.T) {
	w, id, facts := qualificationWorkspace(t)
	other, foreignID, _ := qualificationWorkspace(t)
	w.addMember(t, "reviewer", "approver")
	w.addMember(t, "creator", "creator")
	w.addMember(t, "viewer", "viewer")
	reviewer := w.actor("reviewer")
	facts.FactReviewerUserID = &reviewer.UserID
	create := CreateQualificationInput{ExpectedRevision: "0", Facts: facts}
	if _, err := w.repo.CreateQualificationRevision(w.ctx, w.actor("viewer"), id, "viewer", create); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("viewer draft: %v", err)
	}
	if _, err := w.repo.CreateQualificationRevision(w.ctx, w.owner, foreignID, "foreign", create); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("foreign release: %v", err)
	}
	foreign := create
	foreign.Facts.OwnerUserID = &other.owner.UserID
	if _, err := w.repo.CreateQualificationRevision(w.ctx, w.owner, id, "foreign-owner", foreign); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("foreign owner: %v", err)
	}
	key := postKey(t, w, "readiness", `{"release":["create"],"artifact":["read"]}`)
	readKey := postKey(t, w, "read-only", `{"artifact":["read"]}`)
	if _, err := w.repo.CreateQualificationRevision(w.ctx, readKey, id, "read-key", create); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("scope bypass: %v", err)
	}
	draft, err := w.repo.CreateQualificationRevision(w.ctx, key, id, "machine-draft", create)
	if err != nil {
		t.Fatal(err)
	}
	decision := DecideQualificationInput{ExpectedRevision: "1", QualificationRevisionID: draft.QualificationRevisionID, Decision: "QUALIFIED", Reason: "Reviewed"}
	for _, actor := range []Actor{key, w.owner, w.actor("creator"), {Kind: "service", OrganizationID: w.org}, {Kind: "support", OrganizationID: w.org}, {Kind: "webhook", OrganizationID: w.org}} {
		if _, err := w.repo.DecideQualification(w.ctx, actor, id, "unauthorized", decision); !errors.Is(err, publishing.ErrForbidden) {
			t.Fatalf("decision bypass %+v: %v", actor, err)
		}
	}
	if _, err := w.repo.DecideQualification(w.ctx, reviewer, id, "human", decision); err != nil {
		t.Fatal(err)
	}
	w.exec(t, `UPDATE apikey SET permissions='{"artifact":["read"]}' WHERE id=$1`, key.KeyID)
	if _, err := w.repo.CreateQualificationRevision(w.ctx, key, id, "machine-draft", create); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("scope-revoked replay: %v", err)
	}
	detail, err := w.repo.GetReleaseQualification(w.ctx, readKey, id)
	if err != nil || detail.State != "QUALIFIED" {
		t.Fatalf("scoped read: %+v %v", detail, err)
	}
	if _, err := w.repo.GetReleaseQualification(w.ctx, readKey, foreignID); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("foreign read: %v", err)
	}
}

func TestQualificationConcurrentDecisionsHaveOneWinner(t *testing.T) {
	w, id, facts := qualificationWorkspace(t)
	draft, err := w.repo.CreateQualificationRevision(w.ctx, w.owner, id, "draft", CreateQualificationInput{ExpectedRevision: "0", Facts: facts})
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for i := range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := w.repo.DecideQualification(context.Background(), w.owner, id, fmt.Sprintf("decision-%d", i), DecideQualificationInput{ExpectedRevision: "1", QualificationRevisionID: draft.QualificationRevisionID, Decision: "QUALIFIED", Reason: "Confirmed"})
			results <- err
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	wins, conflicts := 0, 0
	for err := range results {
		if err == nil {
			wins++
		} else if errors.Is(err, publishing.ErrConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if wins != 1 || conflicts != 1 {
		t.Fatalf("wins=%d conflicts=%d", wins, conflicts)
	}
	if n := w.db.Client.ReleaseQualificationDecision.Query().Where(releasequalificationdecision.OrganizationID(w.org)).CountX(w.ctx); n != 1 {
		t.Fatalf("decisions=%d", n)
	}
	if n := w.db.Client.OutboxEvent.Query().Where(outboxevent.OrganizationID(w.org), outboxevent.Type("activity.release.qualification_changed")).CountX(w.ctx); n != 2 {
		t.Fatalf("events=%d", n)
	}
}

func TestQualificationHistoryAndEvidenceRemainReadable(t *testing.T) {
	w, id, facts := qualificationWorkspace(t)
	other, foreignRelease, _ := qualificationWorkspace(t)
	file, foreign, pending, poster := cuid.New(), cuid.New(), cuid.New(), cuid.New()
	for _, row := range []struct{ id, org, status, key string }{
		{file, w.org, "UPLOADED", "org/" + w.org + "/input/evidence/1/launch.pdf"},
		{foreign, other.org, "UPLOADED", "org/" + other.org + "/input/foreign/1/foreign.pdf"},
		{pending, w.org, "PENDING", "org/" + w.org + "/input/pending/1/pending.pdf"},
		{poster, w.org, "UPLOADED", videoPosterPrefix(w.org) + "video/1/poster.png"},
	} {
		w.exec(t, `INSERT INTO asset(id,"organizationId","objectKey","mediaType",bytes,status,"updatedAt") VALUES($1,$2,$3,'application/pdf',10,$4,now())`, row.id, row.org, row.key, row.status)
	}
	for _, invalid := range []string{foreign, pending, poster, cuid.New()} {
		facts.SourceAssetIDs = []string{invalid}
		if _, err := w.repo.CreateQualificationRevision(w.ctx, w.owner, id, "invalid-asset", CreateQualificationInput{ExpectedRevision: "0", Facts: facts}); !errors.Is(err, publishing.ErrNotFound) {
			t.Fatalf("invalid source %s: %v", invalid, err)
		}
	}
	facts.SourceAssetIDs = []string{file}
	draft, err := w.repo.CreateQualificationRevision(w.ctx, w.owner, id, "evidence", CreateQualificationInput{ExpectedRevision: "0", Facts: facts})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.repo.DecideQualification(w.ctx, w.owner, id, "decision", DecideQualificationInput{ExpectedRevision: "1", QualificationRevisionID: draft.QualificationRevisionID, Decision: "QUALIFIED", Reason: "Confirmed against the source."}); err != nil {
		t.Fatal(err)
	}
	facts.SourceAssetIDs = nil
	next, err := w.repo.CreateQualificationRevision(w.ctx, w.owner, id, "new-facts", CreateQualificationInput{ExpectedRevision: "2", Facts: facts})
	if err != nil {
		t.Fatal(err)
	}
	disabled := false
	if _, err := w.repo.UpdateWorkspace(w.ctx, w.owner, UpdateWorkspaceInput{Name: "Qualification", Slug: w.org, ReleaseReadinessEnabled: &disabled}); err != nil {
		t.Fatal(err)
	}
	history, err := w.repo.GetQualificationRevision(w.ctx, w.owner, id, draft.QualificationRevisionID)
	if err != nil || history.Version != "1" || history.Decision == nil || history.Decision.Decision != "QUALIFIED" || len(history.SourceAssets) != 1 || history.SourceAssets[0].FileName != "launch.pdf" {
		t.Fatalf("historical evidence lost: %+v %v", history, err)
	}
	current, err := w.repo.GetReleaseQualification(w.ctx, w.owner, id)
	if err != nil || current.Current.ID != next.QualificationRevisionID || current.Current.ParentRevisionID == nil || *current.Current.ParentRevisionID != history.ID || current.State != "NEEDS_FACTS" || current.Enabled {
		t.Fatalf("historical read changed effective state: %+v %v", current, err)
	}
	for _, releaseID := range []string{foreignRelease, cuid.New()} {
		if _, err := w.repo.GetQualificationRevision(w.ctx, w.owner, releaseID, draft.QualificationRevisionID); !errors.Is(err, publishing.ErrNotFound) {
			t.Fatalf("revision escaped its release: %v", err)
		}
	}
	if _, err := w.repo.GetQualificationRevision(w.ctx, other.owner, id, draft.QualificationRevisionID); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("foreign history: %v", err)
	}
	if result, err := w.repo.DeleteAsset(w.ctx, w.owner, file); err != nil || result != AssetInUse {
		t.Fatalf("historical evidence deleted: %s %v", result, err)
	}
	var status string
	if err := w.db.SQL.QueryRow(`SELECT status FROM asset WHERE id=$1`, file).Scan(&status); err != nil || status != "UPLOADED" {
		t.Fatalf("source state: %s %v", status, err)
	}
	// The database also rejects a cross-tenant pin independently of the domain checks.
	if _, err := w.db.SQL.Exec(`INSERT INTO platform_release_qualification_asset(id,"organizationId","releaseId","qualificationRevisionId","assetId") VALUES($1,$2,$3,$4,$5)`, cuid.New(), w.org, id, next.QualificationRevisionID, foreign); err == nil {
		t.Fatal("foreign asset pin accepted by database")
	}
	w.exec(t, `DELETE FROM session WHERE id=$1`, w.owner.SessionID)
	if _, err := w.repo.GetQualificationRevision(w.ctx, w.owner, id, draft.QualificationRevisionID); !errors.Is(err, publishing.ErrUnauthorized) {
		t.Fatalf("revoked history read: %v", err)
	}
}

func TestQualificationLegacyEditsAndRollbackKeepHistory(t *testing.T) {
	w, id, facts := qualificationWorkspace(t)
	draft, err := w.repo.CreateQualificationRevision(w.ctx, w.owner, id, "draft", CreateQualificationInput{ExpectedRevision: "0", Facts: facts})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = w.repo.DecideQualification(w.ctx, w.owner, id, "qualified", DecideQualificationInput{ExpectedRevision: "1", QualificationRevisionID: draft.QualificationRevisionID, Decision: "QUALIFIED", Reason: "Reviewed"}); err != nil {
		t.Fatal(err)
	}
	before, err := w.repo.GetReleaseQualification(w.ctx, w.owner, id)
	if err != nil {
		t.Fatal(err)
	}
	title := "Manual release"
	if _, err := w.repo.UpdateRelease(w.ctx, w.owner, id, UpdateReleaseInput{Title: OptionalValue[string]{Set: true, Value: &title}}); err != nil {
		t.Fatal(err)
	}
	unchanged, _ := w.repo.GetReleaseQualification(w.ctx, w.owner, id)
	if unchanged.State != "QUALIFIED" || unchanged.Revision != "2" {
		t.Fatalf("no-op invalidated: %+v", unchanged)
	}
	enabled := false
	if _, err := w.repo.UpdateWorkspace(w.ctx, w.owner, UpdateWorkspaceInput{Name: "Qualification", Slug: w.org, ReleaseReadinessEnabled: &enabled}); err != nil {
		t.Fatal(err)
	}
	title = "Changed factual title"
	if _, err := w.repo.UpdateRelease(w.ctx, w.owner, id, UpdateReleaseInput{Title: OptionalValue[string]{Set: true, Value: &title}}); err != nil {
		t.Fatal(err)
	}
	after, err := w.repo.GetReleaseQualification(w.ctx, w.owner, id)
	if err != nil || after.State != "NEEDS_FACTS" || !after.NeedsReview || after.Revision != "3" || after.Enabled || !after.FirstQualifiedAt.Equal(*before.FirstQualifiedAt) || after.Current.Decision == nil {
		t.Fatalf("legacy edit/rollback: %+v %v", after, err)
	}
	_, err = w.repo.CreateQualificationRevision(w.ctx, w.owner, id, "disabled", CreateQualificationInput{ExpectedRevision: "3", Facts: facts})
	requireQualificationFailure(t, err, "READINESS_DISABLED")
}

func TestQualificationAssignedReviewerWithdrawsAndReopens(t *testing.T) {
	for _, incomplete := range []bool{false, true} {
		t.Run(fmt.Sprintf("incomplete=%t", incomplete), func(t *testing.T) {
			w, id, facts := qualificationWorkspace(t)
			w.addMember(t, "reviewer", "approver")
			reviewer := w.actor("reviewer")
			facts.FactReviewerUserID = &reviewer.UserID
			if incomplete {
				facts = releasefacts.Facts{Rollout: "UNKNOWN", FactReviewerUserID: &reviewer.UserID}
			}
			draft, err := w.repo.CreateQualificationRevision(w.ctx, w.owner, id, "draft", CreateQualificationInput{ExpectedRevision: "0", Facts: facts})
			if err != nil {
				t.Fatal(err)
			}
			withdraw := DecideQualificationInput{ExpectedRevision: "1", QualificationRevisionID: draft.QualificationRevisionID, Decision: "WITHDRAWN", Reason: "Rollout stopped"}
			withdrawn, err := w.repo.DecideQualification(w.ctx, reviewer, id, "withdraw", withdraw)
			if err != nil || withdrawn.Revision != "2" || withdrawn.QualificationRevisionID == draft.QualificationRevisionID {
				t.Fatalf("withdraw: %+v %v", withdrawn, err)
			}
			replay, err := w.repo.DecideQualification(w.ctx, reviewer, id, "withdraw", withdraw)
			if err != nil || replay.Created || replay.QualificationRevisionID != withdrawn.QualificationRevisionID {
				t.Fatalf("withdraw replay: %+v %v", replay, err)
			}
			reopen := DecideQualificationInput{ExpectedRevision: "2", QualificationRevisionID: withdrawn.QualificationRevisionID, Decision: "REOPEN", Reason: "Recheck rollout facts"}
			key := postKey(t, w, "reopen", `{"release":["create"],"artifact":["read"]}`)
			for _, actor := range []Actor{w.owner, key} {
				if _, err := w.repo.DecideQualification(w.ctx, actor, id, "denied-reopen", reopen); !errors.Is(err, publishing.ErrForbidden) {
					t.Fatalf("unassigned or machine reopen: %v", err)
				}
			}
			reopened, err := w.repo.DecideQualification(w.ctx, reviewer, id, "reopen", reopen)
			if err != nil || reopened.Revision != "3" || reopened.DecisionID != nil {
				t.Fatalf("reopen: %+v %v", reopened, err)
			}
			replay, err = w.repo.DecideQualification(w.ctx, reviewer, id, "reopen", reopen)
			if err != nil || replay.Created || replay.QualificationRevisionID != reopened.QualificationRevisionID {
				t.Fatalf("reopen replay: %+v %v", replay, err)
			}
			state, err := w.repo.GetReleaseQualification(w.ctx, reviewer, id)
			if err != nil || state.State != "NEEDS_FACTS" || state.CanonicalState != "ACTIVE" || state.Revision != "3" || state.Current.Version != "3" || state.Current.Decision != nil || state.Current.Facts.Rollout != "UNKNOWN" || state.FirstQualifiedAt != nil || *state.Current.ParentRevisionID != withdrawn.QualificationRevisionID {
				t.Fatalf("reopened state: %+v %v", state, err)
			}
			previous, err := w.repo.GetQualificationRevision(w.ctx, reviewer, id, withdrawn.QualificationRevisionID)
			if err != nil || previous.Decision == nil || previous.Decision.Decision != "WITHDRAWN" || *previous.ParentRevisionID != draft.QualificationRevisionID {
				t.Fatalf("withdrawn history: %+v %v", previous, err)
			}
			if _, err := w.repo.CreateQualificationRevision(w.ctx, reviewer, id, "no-edit", CreateQualificationInput{ExpectedRevision: "3", Facts: facts}); !errors.Is(err, publishing.ErrForbidden) {
				t.Fatalf("reopen granted fact editing: %v", err)
			}
			reopen.ExpectedRevision, reopen.QualificationRevisionID = "3", reopened.QualificationRevisionID
			_, err = w.repo.DecideQualification(w.ctx, reviewer, id, "already-open", reopen)
			requireQualificationFailure(t, err, "REVISION_CONFLICT")
			for label, count := range map[string]int{
				"facts":     w.db.Client.ReleaseQualification.Query().Where(releasequalification.OrganizationID(w.org)).CountX(w.ctx),
				"decisions": w.db.Client.ReleaseQualificationDecision.Query().Where(releasequalificationdecision.OrganizationID(w.org)).CountX(w.ctx),
				"events":    w.db.Client.OutboxEvent.Query().Where(outboxevent.OrganizationID(w.org), outboxevent.Type("activity.release.qualification_changed")).CountX(w.ctx),
			} {
				want := 3
				if label == "decisions" {
					want = 1
				}
				if count != want {
					t.Fatalf("%s count=%d want=%d", label, count, want)
				}
			}
		})
	}
}

func TestQualificationWithdrawReopenAndPastRevisit(t *testing.T) {
	w, id, facts := qualificationWorkspace(t)
	draft, err := w.repo.CreateQualificationRevision(w.ctx, w.owner, id, "draft", CreateQualificationInput{ExpectedRevision: "0", Facts: facts})
	if err != nil {
		t.Fatal(err)
	}
	withdrawn, err := w.repo.DecideQualification(w.ctx, w.owner, id, "withdraw", DecideQualificationInput{ExpectedRevision: "1", QualificationRevisionID: draft.QualificationRevisionID, Decision: "WITHDRAWN", Reason: "Rollout stopped"})
	if err != nil || withdrawn.QualificationRevisionID == draft.QualificationRevisionID {
		t.Fatalf("withdraw: %+v %v", withdrawn, err)
	}
	reason := "Rollout restarted"
	reopened, err := w.repo.CreateQualificationRevision(w.ctx, w.owner, id, "reopen", CreateQualificationInput{ExpectedRevision: "2", Facts: facts, Reason: &reason})
	if err != nil {
		t.Fatal(err)
	}
	input := DecideQualificationInput{ExpectedRevision: "3", QualificationRevisionID: reopened.QualificationRevisionID, Decision: "DEFERRED", Reason: "Wait for confirmation"}
	// New deferrals reject a revisit time that has already passed.
	past := time.Now().Add(-time.Hour)
	input.RevisitAt = &past
	_, err = w.repo.DecideQualification(w.ctx, w.owner, id, "past", input)
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("past revisit accepted: %v", err)
	}
	input.RevisitAt = nil
	if _, err = w.repo.DecideQualification(w.ctx, w.owner, id, "defer", input); err != nil {
		t.Fatal(err)
	}
	state, err := w.repo.GetReleaseQualification(w.ctx, w.owner, id)
	if err != nil || state.State != "DEFERRED" || state.Current.Version != "3" || state.FirstQualifiedAt != nil {
		t.Fatalf("reopen/defer: %+v %v", state, err)
	}
}
