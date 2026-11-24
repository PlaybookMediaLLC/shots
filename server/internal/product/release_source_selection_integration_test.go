package product

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"testing"
	"time"

	entsql "entgo.io/ent/dialect/sql"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/frontendactivation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/githubinstallation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/outboxevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/readinesscommandreceipt"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/release"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasequalificationdecision"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasesourcebinding"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/sourceapp"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/sourcechange"
	fd "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/frontenddeploy"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	automation "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releaseautomation"
)

func TestSourceSelectionInstallationRevocationLockOrdering(t *testing.T) {
	f, input, _ := sourceSelectionFixture(t)
	ctx, cancel := context.WithTimeout(f.ctx, 10*time.Second)
	defer cancel()
	installationLocked := make(chan int, 1)
	resume := make(chan struct{})
	var once sync.Once
	releaseRevocation := func() { once.Do(func() { close(resume) }) }
	defer releaseRevocation()
	f.db.Client.GitHubInstallation.Use(func(next ent.Mutator) ent.Mutator {
		return ent.MutateFunc(func(ctx context.Context, mutation ent.Mutation) (ent.Value, error) {
			value, err := next.Mutate(ctx, mutation)
			m, ok := mutation.(*ent.GitHubInstallationMutation)
			if err != nil || !ok {
				return value, err
			}
			status, changed := m.Status()
			if !changed || status != githubinstallation.StatusDELETED {
				return value, nil
			}
			tx, err := m.Tx()
			if err != nil {
				return nil, err
			}
			var pid int
			if err := tx.PlatformQuery(ctx, `SELECT pg_backend_pid()`, nil, func(row entsql.ColumnScanner) error { return row.Scan(&pid) }); err != nil {
				return nil, err
			}
			installationLocked <- pid
			select {
			case <-resume:
				return value, nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		})
	})
	revoked := make(chan error, 1)
	go func() {
		_, err := f.repo.SetGitHubInstallationStatus(ctx, f.installation, GitHubInstallationDeleted)
		revoked <- err
	}()
	var blocker int
	select {
	case blocker = <-installationLocked:
	case err := <-revoked:
		t.Fatalf("revocation did not acquire its installation: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	selected := make(chan error, 1)
	go func() {
		_, err := f.repo.SelectReleaseSources(ctx, f.owner, "revocation-race", input)
		selected <- err
	}()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiting bool
		if err := f.db.SQL.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, blocker).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case err := <-selected:
			t.Fatalf("selection did not contend with revocation: %v", err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-ticker.C:
		}
	}
	releaseRevocation()
	if err := <-revoked; err != nil {
		t.Fatalf("revocation failed under source-selection contention: %v", err)
	}
	err := <-selected
	var unavailable *SourceSelectionError
	if !errors.As(err, &unavailable) || unavailable.Reason != "SOURCE_UNAVAILABLE" {
		t.Fatalf("selection must observe committed revocation, not time out or deadlock: %v", err)
	}
	if f.db.Client.SourceApp.GetX(f.ctx, f.source.ID).Status != sourceapp.StatusARCHIVED ||
		f.db.Client.Release.Query().Where(release.OrganizationID(f.org)).CountX(f.ctx) != 0 ||
		f.db.Client.ReadinessCommandReceipt.Query().Where(readinesscommandreceipt.OrganizationID(f.org)).CountX(f.ctx) != 0 {
		t.Fatal("revocation or rejected selection left inconsistent state")
	}
}

func sourceSelectionFixture(t *testing.T) (*automationFixture, SelectReleaseSourcesInput, automation.Event) {
	t.Helper()
	f := newAutomationFixture(t)
	enableSourceSelection(t, f.testWorkspace)
	at := time.Now().UTC().Round(time.Microsecond)
	event := automation.Event{Family: automation.Merged, SemanticKey: "pr:1001:51", RepositoryID: "1001", RepositoryName: "acme/app", Number: 51, ObjectID: "9051", Title: "Source facts",
		Origin: "live", ObservationOnly: true, OccurredAt: at, SourceUpdatedAt: &at, URL: "https://github.com/acme/app/pull/51", Fields: map[string]automation.Value{"pr.base": automation.StringValue("main")}}
	if _, err := f.repo.acceptGitHubEvent(f.ctx, "selection-source", event, []*WebhookSource{webhookSource(f.source)}, nil); err != nil {
		t.Fatal(err)
	}
	b := f.db.Client.ReleaseSourceBinding.Query().Where(releasesourcebinding.OrganizationID(f.org)).OnlyX(f.ctx)
	return f, SelectReleaseSourcesInput{ExpectedRevision: "0", NewRelease: &ReleaseSourceBrief{Title: "Human release title", BenefitStatement: "Human description of the change"},
		Sources: []ReleaseSourceChoice{{BindingID: b.ID, ObservationID: *b.CurrentObservationID, ExpectedSequence: "1"}}}, event
}

func TestSourceSelectionCreatesAndReplaysWithoutQualifying(t *testing.T) {
	f, input, event := sourceSelectionFixture(t)
	result, err := f.repo.SelectReleaseSources(f.ctx, f.owner, "choose-source", input)
	if err != nil || !result.Created || result.Revision != "1" {
		t.Fatalf("selection: %+v %v", result, err)
	}
	replayed, err := f.repo.SelectReleaseSources(f.ctx, f.owner, "choose-source", input)
	if err != nil || replayed.Created || replayed.ReleaseID != result.ReleaseID || replayed.Revision != result.Revision {
		t.Fatalf("selection replay: %+v %v", replayed, err)
	}
	changed := input
	changed.NewRelease = &ReleaseSourceBrief{Title: "Different request", BenefitStatement: "Different facts"}
	_, err = f.repo.SelectReleaseSources(f.ctx, f.owner, "choose-source", changed)
	requireQualificationFailure(t, err, "COMMAND_KEY_REUSED")
	root, err := f.repo.GetReleaseQualification(f.ctx, f.owner, result.ReleaseID)
	if err != nil || root.State != "NEEDS_FACTS" || root.Current != nil || !root.NeedsReview || root.FirstQualifiedAt != nil {
		t.Fatalf("source choice invented qualification: %+v %v", root, err)
	}
	row := f.db.Client.Release.GetX(f.ctx, result.ReleaseID)
	if row.Title != input.NewRelease.Title || row.BenefitStatement != input.NewRelease.BenefitStatement {
		t.Fatal("source facts replaced the human brief")
	}
	if n := f.db.Client.ReleaseQualificationDecision.Query().Where(releasequalificationdecision.OrganizationID(f.org)).CountX(f.ctx); n != 0 {
		t.Fatalf("source selection made %d human decisions", n)
	}
	if n := f.db.Client.OutboxEvent.Query().Where(outboxevent.OrganizationID(f.org), outboxevent.Type(EventReleaseAutomationDispatch)).CountX(f.ctx); n != 0 {
		t.Fatalf("source selection dispatched %d workflows", n)
	}
	page, err := f.repo.ListReleaseSources(f.ctx, f.owner, "", "")
	if err != nil || len(page.Items) != 0 {
		t.Fatalf("selected source still in the inbox: %+v %v", page, err)
	}
	at := event.SourceUpdatedAt.Add(time.Hour)
	event.SourceUpdatedAt, event.Title = &at, "New provider facts"
	if _, err := f.repo.acceptGitHubEvent(f.ctx, "source-updated", event, []*WebhookSource{webhookSource(f.source)}, nil); err != nil {
		t.Fatal(err)
	}
	page, err = f.repo.ListReleaseSources(f.ctx, f.owner, "", "")
	if err != nil || len(page.Items) != 1 || !page.Items[0].SelectionNeedsReview || page.Items[0].Selected.Snapshot.Title != "Source facts" || page.Items[0].Current.Snapshot.Title != event.Title {
		t.Fatalf("new evidence hid the selected version: %+v %v", page, err)
	}
	input.NewRelease, input.ReleaseID, input.ExpectedRevision = nil, &result.ReleaseID, "1"
	if _, err := f.repo.SelectReleaseSources(f.ctx, f.owner, "stale-source", input); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("stale source selection accepted: %v", err)
	}
	input.Sources[0].ObservationID, input.Sources[0].ExpectedSequence = page.Items[0].Current.ID, "2"
	updated, err := f.repo.SelectReleaseSources(f.ctx, f.owner, "current-source", input)
	if err != nil || updated.ReleaseID != result.ReleaseID || updated.Revision != "2" {
		t.Fatalf("source refresh: %+v %v", updated, err)
	}
	if n := f.db.Client.Release.Query().Where(release.OrganizationID(f.org)).CountX(f.ctx); n != 1 {
		t.Fatalf("source refresh created %d releases", n)
	}
	row = f.db.Client.Release.GetX(f.ctx, result.ReleaseID)
	if row.Title != "Human release title" || row.BenefitStatement != "Human description of the change" {
		t.Fatal("source refresh overwrote the release brief")
	}
	facts := qualifiedFactsFixture()
	facts.OwnerUserID, facts.FactReviewerUserID = &f.owner.UserID, &f.owner.UserID
	draft, err := f.repo.CreateQualificationRevision(f.ctx, f.owner, result.ReleaseID, "review-facts", CreateQualificationInput{ExpectedRevision: "2", Facts: facts})
	if err != nil {
		t.Fatal(err)
	}
	decision, err := f.repo.DecideQualification(f.ctx, f.owner, result.ReleaseID, "qualify", DecideQualificationInput{ExpectedRevision: draft.Revision, QualificationRevisionID: draft.QualificationRevisionID, Decision: "QUALIFIED", Reason: "Facts reviewed"})
	if err != nil {
		t.Fatal(err)
	}
	input.ExpectedRevision = decision.Revision
	unchanged, err := f.repo.SelectReleaseSources(f.ctx, f.owner, "same-selection-new-command", input)
	if err != nil || unchanged.Revision != decision.Revision {
		t.Fatalf("unchanged source selection advanced the aggregate: %+v %v", unchanged, err)
	}
	qualified, err := f.repo.GetReleaseQualification(f.ctx, f.owner, result.ReleaseID)
	if err != nil || qualified.State != "QUALIFIED" || qualified.NeedsReview {
		t.Fatalf("unchanged source selection invalidated human qualification: %+v %v", qualified, err)
	}
}

func TestSourceSelectionConcurrentCommandsHaveOneCandidate(t *testing.T) {
	for _, replay := range []bool{false, true} {
		t.Run(fmt.Sprintf("same-key-%v", replay), func(t *testing.T) {
			f, input, _ := sourceSelectionFixture(t)
			var wg sync.WaitGroup
			start := make(chan struct{})
			results := make(chan *ReleaseSourceSelection, 8)
			failures := make(chan error, 8)
			for i := range 8 {
				wg.Add(1)
				go func() {
					defer wg.Done()
					<-start
					key := "same-command"
					if !replay {
						key = fmt.Sprintf("command-%d", i)
					}
					result, err := f.repo.SelectReleaseSources(f.ctx, f.owner, key, input)
					results <- result
					failures <- err
				}()
			}
			close(start)
			wg.Wait()
			close(results)
			close(failures)
			created := 0
			for result := range results {
				if result != nil && result.Created {
					created++
				}
			}
			for err := range failures {
				if err != nil && (replay || !errors.Is(err, publishing.ErrConflict)) {
					t.Fatal(err)
				}
			}
			if created != 1 || f.db.Client.Release.Query().Where(release.OrganizationID(f.org)).CountX(f.ctx) != 1 ||
				f.db.Client.ReadinessCommandReceipt.Query().Where(readinesscommandreceipt.OrganizationID(f.org), readinesscommandreceipt.Operation("source.select")).CountX(f.ctx) != 1 {
				t.Fatalf("concurrent selection duplicated candidates or receipts: created=%d", created)
			}
		})
	}
}

func TestSourceSelectionAuthorityAndAtomicFailure(t *testing.T) {
	f, input, _ := sourceSelectionFixture(t)
	other, foreign, _ := sourceSelectionFixture(t)
	f.addMember(t, "viewer", "viewer")
	readKey := postKey(t, f.testWorkspace, "source-read", `{"artifact":["read"]}`)
	for _, actor := range []Actor{f.actor("viewer"), readKey, {Kind: "service", OrganizationID: f.org}, {Kind: "support", OrganizationID: f.org}, {Kind: "webhook", OrganizationID: f.org}} {
		if _, err := f.repo.SelectReleaseSources(f.ctx, actor, "forbidden", input); !errors.Is(err, publishing.ErrForbidden) {
			t.Fatalf("selection authority bypass: %+v %v", actor, err)
		}
	}
	foreignInput := input
	foreignInput.Sources = foreign.Sources
	if _, err := f.repo.SelectReleaseSources(f.ctx, f.owner, "foreign", foreignInput); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("foreign sources accepted: %v", err)
	}
	invalid := input
	invalid.Sources = append(append([]ReleaseSourceChoice{}, input.Sources...), input.Sources...)
	if _, err := f.repo.SelectReleaseSources(f.ctx, f.owner, "duplicate", invalid); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("duplicate bindings accepted: %v", err)
	}
	invalid.Sources = make([]ReleaseSourceChoice, 201)
	if _, err := f.repo.SelectReleaseSources(f.ctx, f.owner, "overflow", invalid); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("201 bindings accepted: %v", err)
	}
	invalid.Sources = []ReleaseSourceChoice{{BindingID: input.Sources[0].BindingID, ObservationID: foreign.Sources[0].ObservationID, ExpectedSequence: "1"}}
	if _, err := f.repo.SelectReleaseSources(f.ctx, f.owner, "foreign-observation", invalid); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("foreign observation accepted: %v", err)
	}
	if n := f.db.Client.Release.Query().Where(release.OrganizationID(f.org)).CountX(f.ctx); n != 0 {
		t.Fatalf("rejected commands orphaned %d releases", n)
	}
	key := postKey(t, f.testWorkspace, "source-create", `{"release":["create"]}`)
	result, err := f.repo.SelectReleaseSources(f.ctx, key, "machine-source-choice", input)
	if err != nil || result.ReleaseID == "" {
		t.Fatalf("scoped draft command: %+v %v", result, err)
	}
	f.exec(t, `UPDATE apikey SET enabled=false WHERE id=$1`, key.KeyID)
	if _, err := f.repo.SelectReleaseSources(f.ctx, key, "machine-source-choice", input); !errors.Is(err, publishing.ErrUnauthorized) {
		t.Fatalf("revoked key replay: %v", err)
	}
	input.NewRelease, input.ReleaseID, input.ExpectedRevision = nil, &result.ReleaseID, "1"
	if _, err := f.repo.SelectReleaseSources(f.ctx, f.owner, "human-source-choice", input); err != nil {
		t.Fatal(err)
	}
	f.db.Client.SourceApp.UpdateOneID(f.source.ID).SetStatus(sourceapp.StatusARCHIVED).ExecX(f.ctx)
	if _, err := f.repo.SelectReleaseSources(f.ctx, f.owner, "human-source-choice", input); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("revoked source replay: %v", err)
	}
	other.exec(t, `DELETE FROM member WHERE "organizationId"=$1 AND "userId"=$2`, other.org, other.owner.UserID)
	if _, err := other.repo.SelectReleaseSources(other.ctx, other.owner, "revoked-member", foreign); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("revoked member command: %v", err)
	}
}

func TestSourceSelectionReusesExplicitAutomationAssociation(t *testing.T) {
	f, input, event := sourceSelectionFixture(t)
	legacy, err := f.repo.IngestSourceRelease(f.ctx, Actor{Kind: "service", OrganizationID: f.org}, IngestSourceReleaseInput{
		SourceAppID: f.source.ID, EventID: "release:1001:prior", RepositoryID: &event.RepositoryID, RepositoryName: &event.RepositoryName,
		Title: "Existing automated release", BenefitStatement: "Existing release description", automationAssociation: &sourceReleaseAssociation{Numbers: []int{event.Number}, Cutoff: event.OccurredAt},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.repo.SelectReleaseSources(f.ctx, f.owner, "new-would-duplicate", input)
	var association *SourceSelectionError
	if !errors.As(err, &association) || association.Reason != "SOURCE_ALREADY_ASSOCIATED" || association.ReleaseID == nil || *association.ReleaseID != legacy.ReleaseID {
		t.Fatalf("existing association not surfaced: %v", err)
	}
	input.NewRelease, input.ReleaseID = nil, &legacy.ReleaseID
	selected, err := f.repo.SelectReleaseSources(f.ctx, f.owner, "use-existing", input)
	if err != nil || selected.ReleaseID != legacy.ReleaseID {
		t.Fatalf("attach existing release: %+v %v", selected, err)
	}
	row := f.db.Client.Release.GetX(f.ctx, legacy.ReleaseID)
	if row.Title != "Existing automated release" || f.db.Client.Release.Query().Where(release.OrganizationID(f.org)).CountX(f.ctx) != 1 {
		t.Fatal("selection duplicated or rewrote an existing release")
	}
}

func TestSourceSelectionLaterAutomationReusesCandidate(t *testing.T) {
	f, input, event := sourceSelectionFixture(t)
	selected, err := f.repo.SelectReleaseSources(f.ctx, f.owner, "choose-before-automation", input)
	if err != nil {
		t.Fatal(err)
	}
	for _, eventID := range []string{event.SemanticKey, "release:1001:later"} {
		ingest := IngestSourceReleaseInput{SourceAppID: f.source.ID, EventID: eventID, RepositoryID: &event.RepositoryID, RepositoryName: &event.RepositoryName,
			Title: "Provider title", BenefitStatement: "Provider description", automationAssociation: &sourceReleaseAssociation{Numbers: []int{event.Number}, Cutoff: event.OccurredAt}}
		result, err := f.repo.IngestSourceRelease(f.ctx, Actor{Kind: "service", OrganizationID: f.org}, ingest)
		if err != nil || !result.Created || result.ReleaseID != selected.ReleaseID {
			t.Fatalf("automation duplicated the selected release: %+v %v", result, err)
		}
		replay, err := f.repo.IngestSourceRelease(f.ctx, Actor{Kind: "service", OrganizationID: f.org}, ingest)
		if err != nil || replay.Created || replay.ReleaseID != selected.ReleaseID {
			t.Fatalf("automation replay lost the selected release: %+v %v", replay, err)
		}
	}
	row := f.db.Client.Release.GetX(f.ctx, selected.ReleaseID)
	if row.Title != input.NewRelease.Title || row.BenefitStatement != input.NewRelease.BenefitStatement || f.db.Client.Release.Query().Where(release.OrganizationID(f.org)).CountX(f.ctx) != 1 {
		t.Fatal("automation rewrote or duplicated the human release")
	}
}

func TestSourceSelectionLateCollectorKeepsCandidate(t *testing.T) {
	f, input, event := sourceSelectionFixture(t)
	selected, err := f.repo.SelectReleaseSources(f.ctx, f.owner, "choose-before-collector", input)
	if err != nil {
		t.Fatal(err)
	}
	result, err := f.repo.CollectSourceChange(f.ctx, Actor{Kind: "webhook", OrganizationID: f.org}, CollectSourceChangeInput{
		SourceAppID: f.source.ID, RepositoryID: event.RepositoryID, Number: event.Number, EventID: "late-collector", Title: event.Title, URL: event.URL, MergedAt: event.OccurredAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	change := f.db.Client.SourceChange.Query().Where(sourcechange.OrganizationID(f.org), sourcechange.ID(result.ChangeID)).OnlyX(f.ctx)
	if change.ReleaseID == nil || *change.ReleaseID != selected.ReleaseID {
		t.Fatalf("late collector lost selected association: %+v", change.ReleaseID)
	}
}

func TestSourceSelectionFrontendAutomationKeepsProjectIdentity(t *testing.T) {
	f := newAutomationFixture(t)
	frontendFixtureCleanup(t, f.testWorkspace)
	enableSourceSelection(t, f.testWorkspace)
	f.repo.WithWebhooks(make([]byte, 32), nil).WithFrontendHTTP(&http.Client{Transport: frontendTransport(func(*http.Request) (*http.Response, error) {
		return frontendResponse(`{"id":"prj_web","accountId":"team1"}`), nil
	})})
	s, err := f.repo.SaveFrontendSource(f.ctx, f.owner, FrontendSourceInput{Name: "Web", GitHubSourceID: f.source.ID, Provider: "vercel", AccountID: "team1", ProjectID: "prj_web", Token: "fixture", Secret: "test-only-signing-secret", Enabled: true, Policy: frontendPolicy()})
	if err != nil {
		t.Fatal(err)
	}
	at := time.Now().UTC().Round(time.Microsecond)
	if err := f.repo.acceptFrontendObservation(f.ctx, f.org, s.ID, fd.Observation{Provider: "vercel", AccountID: "team1", ProjectID: "prj_web", Key: "ready", ProviderEventID: "ready", DeploymentID: "deployment1", RepositoryID: "1001", Environment: "production", Revision: "revision1", OccurredAt: at, Status: "ready", Build: "succeeded", Production: "active"}, false); err != nil {
		t.Fatal(err)
	}
	binding := f.db.Client.ReleaseSourceBinding.Query().Where(releasesourcebinding.OrganizationID(f.org)).OnlyX(f.ctx)
	input := SelectReleaseSourcesInput{ExpectedRevision: "0", NewRelease: &ReleaseSourceBrief{Title: "Human deployment", BenefitStatement: "Human release context"}, Sources: []ReleaseSourceChoice{{BindingID: binding.ID, ObservationID: *binding.CurrentObservationID, ExpectedSequence: "1"}}}
	selected, err := f.repo.SelectReleaseSources(f.ctx, f.owner, "choose-deployment", input)
	if err != nil {
		t.Fatal(err)
	}
	activation := f.db.Client.FrontendActivation.Query().Where(frontendactivation.OrganizationID(f.org), frontendactivation.SourceID(s.ID)).OnlyX(f.ctx)
	event := frontendWorkflowEvent(activation)
	ingest := IngestSourceReleaseInput{SourceAppID: f.source.ID, EventID: event.SemanticKey, RepositoryID: &event.RepositoryID, RepositoryName: ptr("acme/app"), Title: "Automation title", BenefitStatement: "Automation context", automationAssociation: &sourceReleaseAssociation{Cutoff: at}}
	result, err := f.repo.IngestSourceRelease(f.ctx, Actor{Kind: "service", OrganizationID: f.org}, ingest)
	if err != nil || result.ReleaseID != selected.ReleaseID {
		t.Fatalf("frontend automation duplicated selected deployment: %+v %v", result, err)
	}
	if row := f.db.Client.Release.GetX(f.ctx, selected.ReleaseID); row.Title != input.NewRelease.Title || row.BenefitStatement != input.NewRelease.BenefitStatement {
		t.Fatal("frontend automation replaced human facts")
	}
}

func TestSourceSelectionNewEvidenceKeepsQualificationUnresolved(t *testing.T) {
	f, input, event := sourceSelectionFixture(t)
	selected, err := f.repo.SelectReleaseSources(f.ctx, f.owner, "choose-source", input)
	if err != nil {
		t.Fatal(err)
	}
	facts := qualifiedFactsFixture()
	facts.OwnerUserID, facts.FactReviewerUserID = &f.owner.UserID, &f.owner.UserID
	facts.SourceURLs = []string{}
	draft, err := f.repo.CreateQualificationRevision(f.ctx, f.owner, selected.ReleaseID, "original-facts", CreateQualificationInput{ExpectedRevision: selected.Revision, Facts: facts})
	if err != nil {
		t.Fatal(err)
	}
	decision, err := f.repo.DecideQualification(f.ctx, f.owner, selected.ReleaseID, "original-decision", DecideQualificationInput{ExpectedRevision: draft.Revision, QualificationRevisionID: draft.QualificationRevisionID, Decision: "QUALIFIED", Reason: "Reviewed original source facts"})
	if err != nil {
		t.Fatal(err)
	}
	at := event.SourceUpdatedAt.Add(time.Hour)
	event.SourceUpdatedAt, event.Title = &at, "New provider evidence"
	if _, err := f.repo.acceptGitHubEvent(f.ctx, "updated-after-decision", event, []*WebhookSource{webhookSource(f.source)}, nil); err != nil {
		t.Fatal(err)
	}
	detail, err := f.repo.GetReleaseQualification(f.ctx, f.owner, selected.ReleaseID)
	if err != nil || !detail.NeedsReview || detail.State == "QUALIFIED" {
		t.Fatalf("new source facts left stale qualification effective: %+v %v", detail, err)
	}
	revised, err := f.repo.CreateQualificationRevision(f.ctx, f.owner, selected.ReleaseID, "text-edit-after-update", CreateQualificationInput{ExpectedRevision: decision.Revision, Facts: facts})
	if err != nil {
		t.Fatal(err)
	}
	detail, err = f.repo.GetReleaseQualification(f.ctx, f.owner, selected.ReleaseID)
	if err != nil || !detail.NeedsReview {
		t.Fatalf("saving text cleared unresolved source changes: %+v %v", detail, err)
	}
	_, err = f.repo.DecideQualification(f.ctx, f.owner, selected.ReleaseID, "stale-decision", DecideQualificationInput{ExpectedRevision: revised.Revision, QualificationRevisionID: revised.QualificationRevisionID, Decision: "QUALIFIED", Reason: "Still unreviewed sources"})
	if !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("unresolved source update accepted a decision: %v", err)
	}
	old, err := f.repo.GetQualificationRevision(f.ctx, f.owner, selected.ReleaseID, draft.QualificationRevisionID)
	if err != nil || old.Decision == nil || old.Decision.Decision != "QUALIFIED" || len(old.Sources) != 1 || old.Sources[0].Observation.Snapshot.Title != "Source facts" {
		t.Fatalf("source update erased historical decision: %+v %v", old, err)
	}
	page, err := f.repo.ListReleaseSources(f.ctx, f.owner, selected.ReleaseID, "")
	if err != nil {
		t.Fatal(err)
	}
	input.NewRelease, input.ReleaseID, input.ExpectedRevision = nil, &selected.ReleaseID, revised.Revision
	input.Sources[0].ObservationID, input.Sources[0].ExpectedSequence = page.Items[0].Current.ID, page.Items[0].Sequence
	refreshed, err := f.repo.SelectReleaseSources(f.ctx, f.owner, "review-changed-source", input)
	if err != nil {
		t.Fatal(err)
	}
	current, err := f.repo.CreateQualificationRevision(f.ctx, f.owner, selected.ReleaseID, "facts-with-current-source", CreateQualificationInput{ExpectedRevision: refreshed.Revision, Facts: facts})
	if err != nil {
		t.Fatal(err)
	}
	confirmed, err := f.repo.DecideQualification(f.ctx, f.owner, selected.ReleaseID, "current-decision", DecideQualificationInput{ExpectedRevision: current.Revision, QualificationRevisionID: current.QualificationRevisionID, Decision: "QUALIFIED", Reason: "Reviewed changed source"})
	if err != nil {
		t.Fatal(err)
	}
	detail, err = f.repo.GetReleaseQualification(f.ctx, f.owner, selected.ReleaseID)
	if err != nil || detail.State != "QUALIFIED" || detail.NeedsReview || len(detail.Current.Sources) != 1 || detail.Current.Sources[0].Observation.Snapshot.Title != event.Title {
		t.Fatalf("reviewed source did not qualify: %+v %v", detail, err)
	}
	old, err = f.repo.GetQualificationRevision(f.ctx, f.owner, selected.ReleaseID, draft.QualificationRevisionID)
	if err != nil || old.Sources[0].Observation.Snapshot.Title != "Source facts" {
		t.Fatalf("selection rewrote pinned history: %+v %v", old, err)
	}
	f.db.Client.SourceApp.UpdateOneID(f.source.ID).SetStatus(sourceapp.StatusARCHIVED).ExecX(f.ctx)
	detail, err = f.repo.GetReleaseQualification(f.ctx, f.owner, selected.ReleaseID)
	if err != nil || !detail.NeedsReview || detail.State == "QUALIFIED" {
		t.Fatalf("revoked source left qualification effective: %+v %v", detail, err)
	}
	if _, err := f.repo.DecideQualification(f.ctx, f.owner, selected.ReleaseID, "withdraw-revoked", DecideQualificationInput{ExpectedRevision: confirmed.Revision, QualificationRevisionID: current.QualificationRevisionID, Decision: "WITHDRAWN", Reason: "Source no longer available"}); err != nil {
		t.Fatalf("source revocation prevented safe withdrawal: %v", err)
	}
}

func TestSourceSelectionObservationRacingDecisionCannotLeaveStaleQualification(t *testing.T) {
	for attempt := range 4 {
		t.Run(strconv.Itoa(attempt), func(t *testing.T) {
			f, input, event := sourceSelectionFixture(t)
			selected, err := f.repo.SelectReleaseSources(f.ctx, f.owner, "select-before-race", input)
			if err != nil {
				t.Fatal(err)
			}
			facts := qualifiedFactsFixture()
			facts.OwnerUserID, facts.FactReviewerUserID = &f.owner.UserID, &f.owner.UserID
			draft, err := f.repo.CreateQualificationRevision(f.ctx, f.owner, selected.ReleaseID, "facts-before-race", CreateQualificationInput{ExpectedRevision: selected.Revision, Facts: facts})
			if err != nil {
				t.Fatal(err)
			}
			updated := event.SourceUpdatedAt.Add(time.Hour)
			event.SourceUpdatedAt, event.Title = &updated, "New facts during review"
			start := make(chan struct{})
			decisionResult, intakeResult := make(chan error, 1), make(chan error, 1)
			go func() {
				<-start
				_, err := f.repo.DecideQualification(f.ctx, f.owner, selected.ReleaseID, "decision-during-intake", DecideQualificationInput{ExpectedRevision: draft.Revision, QualificationRevisionID: draft.QualificationRevisionID, Decision: "QUALIFIED", Reason: "Reviewed saved evidence"})
				decisionResult <- err
			}()
			go func() {
				<-start
				_, err := f.repo.acceptGitHubEvent(f.ctx, "observation-during-review", event, []*WebhookSource{webhookSource(f.source)}, nil)
				intakeResult <- err
			}()
			close(start)
			decisionErr, intakeErr := <-decisionResult, <-intakeResult
			if intakeErr != nil {
				t.Fatal(intakeErr)
			}
			if decisionErr != nil {
				requireQualificationFailure(t, decisionErr, "SOURCE_CHANGED")
			}
			result, err := f.repo.GetReleaseQualification(f.ctx, f.owner, selected.ReleaseID)
			if err != nil || result.State != "NEEDS_FACTS" || !result.NeedsReview || result.Current.Sources[0].Observation.ID != input.Sources[0].ObservationID {
				t.Fatalf("racing evidence left a stale qualification or replaced its pin: %+v %v", result, err)
			}
		})
	}
}

func TestSourceSelectionLimitAndAssociationConflictAreAtomic(t *testing.T) {
	f, input, event := sourceSelectionFixture(t)
	tx, err := f.db.Client.Tx(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	locked, err := lockAutomationSource(f.ctx, tx, f.org, f.source.ID)
	if err != nil {
		t.Fatal(err)
	}
	for i := 100; i < 300; i++ {
		event.Number, event.SemanticKey = i, fmt.Sprintf("pr:1001:%d", i)
		if err := retainGitHubReleaseSource(f.ctx, tx, locked, fmt.Sprintf("source-%d", i), event); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	bindings := f.db.Client.ReleaseSourceBinding.Query().Where(releasesourcebinding.OrganizationID(f.org)).AllX(f.ctx)
	input.Sources = []ReleaseSourceChoice{}
	for _, binding := range bindings[:200] {
		input.Sources = append(input.Sources, ReleaseSourceChoice{BindingID: binding.ID, ObservationID: *binding.CurrentObservationID, ExpectedSequence: "1"})
	}
	result, err := f.repo.SelectReleaseSources(f.ctx, f.owner, "maximum-selection", input)
	if err != nil || result.Revision != "1" {
		t.Fatalf("200 source selection: %+v %v", result, err)
	}
	last := bindings[200]
	extra := SelectReleaseSourcesInput{ExpectedRevision: "1", ReleaseID: &result.ReleaseID, Sources: []ReleaseSourceChoice{{BindingID: last.ID, ObservationID: *last.CurrentObservationID, ExpectedSequence: "1"}}}
	_, err = f.repo.SelectReleaseSources(f.ctx, f.owner, "would-overflow-release", extra)
	var selectionError *SourceSelectionError
	if !errors.As(err, &selectionError) || selectionError.Reason != "SOURCE_LIMIT" {
		t.Fatalf("201 aggregate sources accepted: %v", err)
	}
	if n := f.db.Client.ReleaseSourceBinding.Query().Where(releasesourcebinding.OrganizationID(f.org), releasesourcebinding.CanonicalReleaseID(result.ReleaseID)).CountX(f.ctx); n != 200 {
		t.Fatalf("failed selection changed aggregate sources: %d", n)
	}
	invalid := extra
	invalid.Sources = []ReleaseSourceChoice{{BindingID: last.ID, ObservationID: *bindings[0].CurrentObservationID, ExpectedSequence: "1"}}
	if _, err := f.repo.SelectReleaseSources(f.ctx, f.owner, "wrong-object-snapshot", invalid); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("same-tenant wrong object snapshot accepted: %v", err)
	}
	extra.ReleaseID, extra.NewRelease, extra.ExpectedRevision = nil, input.NewRelease, "0"
	other, err := f.repo.SelectReleaseSources(f.ctx, f.owner, "separate-release", extra)
	if err != nil {
		t.Fatal(err)
	}
	firstNumber, err := strconv.Atoi(bindings[0].ProviderObjectID)
	if err != nil {
		t.Fatal(err)
	}
	lastNumber, err := strconv.Atoi(last.ProviderObjectID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.repo.IngestSourceRelease(f.ctx, Actor{Kind: "service", OrganizationID: f.org}, IngestSourceReleaseInput{SourceAppID: f.source.ID, EventID: "release:1001:conflicting", RepositoryID: &event.RepositoryID,
		Title: "Would merge two releases", BenefitStatement: "Distinct human candidates", automationAssociation: &sourceReleaseAssociation{Numbers: []int{firstNumber, lastNumber}, Cutoff: event.OccurredAt}})
	if !errors.As(err, &selectionError) || selectionError.Reason != "SOURCE_ASSOCIATION_CONFLICT" {
		t.Fatalf("automation silently merged %s and %s: %v", result.ReleaseID, other.ReleaseID, err)
	}
	if n := f.db.Client.Release.Query().Where(release.OrganizationID(f.org)).CountX(f.ctx); n != 2 {
		t.Fatalf("association conflict created %d releases", n)
	}
}
