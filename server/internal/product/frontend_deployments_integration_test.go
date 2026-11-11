package product

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/frontendactivation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/frontendobservation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/outboxevent"
	fd "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/frontenddeploy"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/notifications"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	ra "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releaseautomation"
)

type frontendTransport func(*http.Request) (*http.Response, error)

func (f frontendTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func frontendResponse(body string) *http.Response {
	return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}
}
func frontendPolicy() fd.Policy {
	return fd.Policy{SchemaVersion: 1, Environments: []string{"production"}, Checks: []fd.CheckRule{}, Alerts: []string{"matched"}}
}
func frontendTestSource(t *testing.T) (*testWorkspace, *FrontendSourceRecord) {
	t.Helper()
	w := newTestWorkspace(t)
	frontendFixtureCleanup(t, w)
	subscribe(t, w.ctx, w.repo, w.org, "pro")
	w.repo.WithWebhooks(make([]byte, 32), nil).WithFrontendHTTP(&http.Client{Transport: frontendTransport(func(r *http.Request) (*http.Response, error) {
		if r.Method != "GET" || r.URL.Host != "api.vercel.com" {
			t.Errorf("unexpected provider request %s", r.URL)
		}
		return frontendResponse(`{"id":"prj_web","accountId":"team1"}`), nil
	})})
	s, err := w.repo.SaveFrontendSource(w.ctx, w.owner, FrontendSourceInput{Name: "Frontend", Provider: "vercel", AccountID: "team1", ProjectID: "prj_web", Token: "test-only-token", Secret: "test-only-signing-secret", Enabled: true, Policy: frontendPolicy()})
	if err != nil {
		t.Fatal(err)
	}
	w.exec(t, `UPDATE frontend_source SET "effectiveAt"=now()-interval '1 hour',"baselineAt"=now()-interval '1 hour' WHERE id=$1`, s.ID)
	return w, s
}
func frontendVercel(kind, id, dep string, at time.Time) []byte {
	body, _ := json.Marshal(map[string]any{"id": id, "type": kind, "createdAt": at.UnixMilli(), "payload": map[string]any{"team": map[string]string{"id": "team1"}, "project": map[string]string{"id": "prj_web"}, "target": "production", "deployment": map[string]any{"id": dep, "meta": map[string]string{"githubCommitSha": "revision1", "githubRepoId": "1001"}}, "toDeploymentId": dep}})
	return body
}
func frontendSignature(body []byte) string {
	m := hmac.New(sha1.New, []byte("test-only-signing-secret"))
	m.Write(body)
	return hex.EncodeToString(m.Sum(nil))
}
func frontendAlerts(t *testing.T, w *testWorkspace) int {
	t.Helper()
	return w.db.Client.OutboxEvent.Query().Where(outboxevent.OrganizationID(w.org), outboxevent.TypeHasPrefix("activity.frontend.")).CountX(w.ctx)
}

func TestFrontendWorkflowEventSelectsRepositoryAndActionBranches(t *testing.T) {
	e := frontendWorkflowEvent(&ent.FrontendActivation{ID: "activation", Snapshot: fd.Observation{RepositoryID: "1001", Environment: "production", Revision: "revision1"}})
	for _, c := range []ra.Condition{{Field: "repository.id", Operator: "eq", Values: []string{"1001"}}, {Field: "event.action", Operator: "eq", Values: []string{"success"}}} {
		if d := ra.Evaluate(c, e); d.Status != "evaluated" || !d.Match {
			t.Errorf("%s did not select the branch: %+v", c.Field, d)
		}
	}
	// A restored deployment keeps its artifact's time; the event occurs when it
	// went live again, which is what orders it as a rollback.
	observed := time.Now().UTC()
	restored := frontendWorkflowEvent(&ent.FrontendActivation{ID: "restored", Snapshot: fd.Observation{OccurredAt: observed.Add(-24 * time.Hour), ActivationObservedAt: &observed}})
	if !restored.OccurredAt.Equal(observed) {
		t.Fatalf("occurred=%s observed=%s", restored.OccurredAt, observed)
	}
}

func TestFrontendInactiveWorkflowPreservesEvidenceAndAlerts(t *testing.T) {
	for _, archived := range []bool{false, true} {
		for _, pending := range []bool{false, true} {
			name := "disabled"
			if archived {
				name = "archived"
			}
			if pending {
				name += "_while_checks_pending"
			}
			t.Run(name, func(t *testing.T) {
				f := newAutomationFixture(t)
				frontendFixtureCleanup(t, f.testWorkspace)
				f.graph.Family = ra.Deployed
				f.graph.Qualification = ra.Condition{Field: "deployment.environment", Operator: "eq", Values: []string{"production"}}
				f.graph.Nodes[1].Condition = &ra.Condition{Field: "deployment.state", Operator: "eq", Values: []string{"success"}}
				active := f.activate(t)
				policy := frontendPolicy()
				policy.WorkflowVersionID = *active.ActiveVersionID
				if pending {
					policy.Checks = []fd.CheckRule{{Source: "github_check", Name: "ci", AppID: "44", Scope: "commit", Passing: []string{"success"}, MaxAgeSeconds: 3600}}
				}
				f.repo.WithWebhooks(make([]byte, 32), nil).WithFrontendHTTP(&http.Client{Transport: frontendTransport(func(*http.Request) (*http.Response, error) {
					return frontendResponse(`{"id":"prj_web","accountId":"team1"}`), nil
				})})
				s, err := f.repo.SaveFrontendSource(f.ctx, f.owner, FrontendSourceInput{Name: "Web", GitHubSourceID: f.source.ID, Provider: "vercel", AccountID: "team1", ProjectID: "prj_web", Token: "fixture", Secret: "test-only-signing-secret", Enabled: true, Policy: policy})
				if err != nil {
					t.Fatal(err)
				}
				f.exec(t, `UPDATE frontend_source SET "effectiveAt"=now()-interval '1 hour' WHERE id=$1`, s.ID)
				at := time.Now().UTC()
				body := frontendVercel("deployment.promoted", "promotion", "deployment", at)
				if pending {
					if err := f.repo.AcceptFrontendWebhook(f.ctx, s.ID, frontendSignature(body), body); err != nil {
						t.Fatal(err)
					}
					if frontendAlerts(t, f.testWorkspace) != 0 {
						t.Fatal("alert before the required check")
					}
				}
				if archived {
					err = f.repo.ArchiveReleaseAutomation(f.ctx, f.owner, active.ID, active.Revision, true)
				} else {
					err = f.repo.DisableReleaseAutomation(f.ctx, f.owner, active.ID, active.Revision)
				}
				if err != nil {
					t.Fatal(err)
				}
				check := fd.Observation{Provider: "vercel", Kind: "checks.observed", Key: "check", OccurredAt: at, Checks: []fd.Check{{Source: "github_check", Name: "ci", AppID: "44", ID: "c1", RepositoryID: "1001", Revision: "revision1", Status: "completed", Conclusion: "success", OccurredAt: at}}}
				for i := 0; i < 2; i++ {
					if err := f.repo.AcceptFrontendWebhook(f.ctx, s.ID, frontendSignature(body), body); err != nil {
						t.Fatal(err)
					}
					if pending {
						if err := f.repo.acceptFrontendObservation(f.ctx, f.org, s.ID, check, false); err != nil {
							t.Fatal(err)
						}
					}
				}
				activation := f.db.Client.FrontendActivation.Query().Where(frontendactivation.SourceID(s.ID)).OnlyX(f.ctx)
				if activation.Decision.State != "matched" || activation.Policy.WorkflowVersionID != *active.ActiveVersionID {
					t.Fatalf("lost activation or pinned policy: %+v", activation)
				}
				wantObservations := 1
				if pending {
					wantObservations++
				}
				if n := f.db.Client.FrontendObservation.Query().Where(frontendobservation.SourceID(s.ID)).CountX(f.ctx); n != wantObservations {
					t.Fatalf("observations=%d, want %d", n, wantObservations)
				}
				if n := frontendAlerts(t, f.testWorkspace); n != 1 {
					t.Fatalf("alerts=%d, want 1", n)
				}
				history, err := f.repo.ListAutomationHistory(f.ctx, f.owner, AutomationHistoryFilter{})
				if err != nil || len(history) != 0 {
					t.Fatalf("inactive workflow started: %+v %v", history, err)
				}
				if n := f.db.Client.OutboxEvent.Query().Where(outboxevent.OrganizationID(f.org), outboxevent.Type(EventReleaseAutomationDispatch)).CountX(f.ctx); n != 0 {
					t.Fatalf("inactive workflow dispatches=%d", n)
				}
			})
		}
	}
}

func TestFrontendPromotedChecksConcurrentDeliveryAndReceipts(t *testing.T) {
	w, s := frontendTestSource(t)
	policy := frontendPolicy()
	policy.Checks = []fd.CheckRule{{Source: "github_check", Name: "frontend-tests", AppID: "44", Scope: "commit", Passing: []string{"success"}, MaxAgeSeconds: 3600}}
	w.db.Client.FrontendSource.UpdateOneID(s.ID).SetPolicy(policy).ExecX(w.ctx)
	at := time.Now().UTC()
	body := frontendVercel("deployment.promoted", "promotion1", "deploy1", at)
	var group sync.WaitGroup
	fail := make(chan error, 6)
	for i := 0; i < 6; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			fail <- w.repo.AcceptFrontendWebhook(w.ctx, s.ID, frontendSignature(body), body)
		}()
	}
	group.Wait()
	close(fail)
	for err := range fail {
		if err != nil {
			t.Fatal(err)
		}
	}
	if frontendAlerts(t, w) != 0 {
		t.Fatal("alert before required checks")
	}
	check := fd.Observation{Provider: "vercel", Kind: "checks.observed", Key: "check-result-1", OccurredAt: at, Checks: []fd.Check{{Source: "github_check", Name: "frontend-tests", AppID: "44", ID: "c1", RepositoryID: "1001", Revision: "revision1", Status: "completed", Conclusion: "success", OccurredAt: at}}}
	if err := w.repo.acceptFrontendObservation(w.ctx, w.org, s.ID, check, false); err != nil {
		t.Fatal(err)
	}
	// A new process sees durable uniqueness and does not resend the success.
	w.repo = NewConfiguration(w.db.Client).WithWebhooks(make([]byte, 32), nil)
	if err := w.repo.AcceptFrontendWebhook(w.ctx, s.ID, frontendSignature(body), body); err != nil {
		t.Fatal(err)
	}
	if n := frontendAlerts(t, w); n != 1 {
		t.Fatalf("alerts=%d", n)
	}
	history, err := w.repo.FrontendHistory(w.ctx, w.owner, s.ID)
	if err != nil || len(history) != 2 {
		t.Fatalf("history=%+v %v", history, err)
	}
	foundCurrent := false
	for _, record := range history {
		if record.Observation.Kind == "deployment.promoted" {
			foundCurrent = true
			if record.Decision.State != "needs_attention" || record.Current == nil || record.Current.Decision.State != "matched" || len(record.Current.Observation.Checks) != 1 {
				t.Fatalf("historical and current decision conflated: %+v", record)
			}
		}
	}
	if !foundCurrent {
		t.Fatal("promotion missing from history")
	}

	w.addMember(t, "viewer", "viewer")
	service := notifications.New(w.db.SQL, w.db.Client)
	var n int
	deadline := time.Now().Add(15 * time.Second)
	for {
		if err := service.Process(w.ctx); err != nil {
			t.Fatal(err)
		}
		if err := w.db.SQL.QueryRowContext(w.ctx, `SELECT count(*) FROM platform_notification_inbox WHERE "organizationId"=$1 AND kind='frontend.checks_passed'`, w.org).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("in-app receipts %d", n)
		}
	}
	if err := service.Process(w.ctx); err != nil {
		t.Fatal(err)
	}

	w.exec(t, `DELETE FROM member WHERE "organizationId"=$1 AND "userId"=$2`, w.org, w.actor("viewer").UserID)
	if _, err := w.repo.FrontendHistory(w.ctx, w.actor("viewer"), s.ID); err == nil {
		t.Fatal("removed member read deployment")
	}
}

func TestFrontendBaselineRuleEditsSignaturesAndTenantIsolation(t *testing.T) {
	w, s := frontendTestSource(t)
	other := newTestWorkspace(t)
	w.addMember(t, "viewer", "viewer")
	if _, err := w.repo.FrontendHistory(w.ctx, other.owner, s.ID); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("cross tenant: %v", err)
	}
	input := FrontendSourceInput{ID: s.ID, Name: s.Name, Revision: 1, Provider: s.Provider, AccountID: s.AccountID, ProjectID: s.ProjectID, Policy: s.Policy, Enabled: true}
	if _, err := w.repo.SaveFrontendSource(w.ctx, w.actor("viewer"), input); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("viewer save: %v", err)
	}
	body := frontendVercel("deployment.promoted", "historical", "deploy-old", time.Now().Add(-24*time.Hour))
	if err := w.repo.AcceptFrontendWebhook(w.ctx, s.ID, "invalid", body); !errors.Is(err, publishing.ErrUnauthorized) {
		t.Fatalf("signature: %v", err)
	}
	if err := w.repo.AcceptFrontendWebhook(w.ctx, s.ID, frontendSignature(body), body); err != nil {
		t.Fatal(err)
	}
	if frontendAlerts(t, w) != 0 {
		t.Fatal("historical live alert")
	}
	if _, err := w.repo.SaveFrontendSource(w.ctx, w.owner, input); err != nil {
		t.Fatal(err)
	}
	if _, err := w.repo.SaveFrontendSource(w.ctx, w.owner, input); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("concurrent policy edit: %v", err)
	}
	if err := w.repo.AcceptFrontendWebhook(w.ctx, s.ID, frontendSignature(body), body); err != nil {
		t.Fatal(err)
	}
	if frontendAlerts(t, w) != 0 {
		t.Fatal("rule edit replayed historical event")
	}
	if n := w.db.Client.FrontendObservation.Query().Where(frontendobservation.OrganizationID(w.org)).CountX(w.ctx); n != 1 {
		t.Fatalf("history duplicated %d", n)
	}
	bad := []byte(`{"id":"event","type":"deployment.promoted","payload":{"project":{"id":"wrong"}}}`)
	if err := w.repo.AcceptFrontendWebhook(w.ctx, s.ID, frontendSignature(bad), bad); err == nil {
		t.Fatal("malformed payload accepted")
	}
}

func TestFrontendOutOfOrderChecksAndSameRevisionRedeployment(t *testing.T) {
	w, s := frontendTestSource(t)
	now := time.Now().UTC()
	for _, event := range []struct {
		id, dep string
		at      time.Time
	}{{"new", "d2", now}, {"old", "d1", now.Add(-time.Minute)}, {"redeploy", "d3", now.Add(time.Second)}} {
		body := frontendVercel("deployment.promoted", event.id, event.dep, event.at)
		if err := w.repo.AcceptFrontendWebhook(w.ctx, s.ID, frontendSignature(body), body); err != nil {
			t.Fatal(err)
		}
	}
	if n := frontendAlerts(t, w); n != 2 {
		t.Fatalf("stale or same-SHA handling: %d alerts", n)
	}
	if n := w.db.Client.FrontendActivation.Query().Where(frontendactivation.OrganizationID(w.org)).CountX(w.ctx); n != 3 {
		t.Fatalf("lost distinct deployment: %d", n)
	}
}

func TestFrontendGitHubAndHostUseOneAuthoritativeSource(t *testing.T) {
	f := newAutomationFixture(t)
	frontendFixtureCleanup(t, f.testWorkspace)
	f.repo.WithWebhooks(make([]byte, 32), nil).WithFrontendHTTP(&http.Client{Transport: frontendTransport(func(*http.Request) (*http.Response, error) {
		return frontendResponse(`{"id":"prj_web","accountId":"team1"}`), nil
	})})
	s, err := f.repo.SaveFrontendSource(f.ctx, f.owner, FrontendSourceInput{ID: f.source.ID, Name: "Web", Provider: "vercel", AccountID: "team1", ProjectID: "prj_web", Token: "fixture", Secret: "test-only-signing-secret", Enabled: true, Policy: frontendPolicy()})
	if err != nil {
		t.Fatal(err)
	}
	f.exec(t, `UPDATE frontend_source SET "effectiveAt"=now()-interval '1 hour' WHERE id=$1`, s.ID)
	now := time.Now().UTC()
	body, _ := json.Marshal(map[string]any{"installation": map[string]any{"id": f.installation}, "repository": map[string]any{"id": 1001}, "deployment": map[string]any{"id": 12, "environment": "production", "sha": "revision1"}, "deployment_status": map[string]any{"id": 13, "state": "success", "created_at": now.Format(time.RFC3339Nano)}})
	if _, err := f.repo.AcceptGitHubEvent(f.ctx, AcceptGitHubEventInput{DeliveryID: "github-delivery", EventName: "deployment_status", Body: body}); err != nil {
		t.Fatal(err)
	}
	if frontendAlerts(t, f.testWorkspace) != 0 {
		t.Fatal("GitHub bypassed authoritative provider")
	}
	host := frontendVercel("deployment.promoted", "host-delivery", "d1", now)
	if err := f.repo.AcceptFrontendWebhook(f.ctx, s.ID, frontendSignature(host), host); err != nil {
		t.Fatal(err)
	}
	if frontendAlerts(t, f.testWorkspace) != 1 {
		t.Fatal("missing authoritative success")
	}
	if n := f.db.Client.FrontendObservation.Query().Where(frontendobservation.SourceID(s.ID)).CountX(f.ctx); n != 2 {
		t.Fatalf("both observations not retained: %d", n)
	}
}

func TestFrontendPausedEvidenceAndConflictingChecksStayQuiet(t *testing.T) {
	w, s := frontendTestSource(t)
	p := frontendPolicy()
	p.Checks = []fd.CheckRule{{Source: "github_check", Name: "ci", AppID: "44", Scope: "commit", Passing: []string{"success"}, MaxAgeSeconds: 3600}}
	w.db.Client.FrontendSource.UpdateOneID(s.ID).SetPolicy(p).SetEnabled(false).ExecX(w.ctx)
	at := time.Now().UTC()
	body := frontendVercel("deployment.promoted", "paused-event", "paused-deploy", at)
	if err := w.repo.AcceptFrontendWebhook(w.ctx, s.ID, frontendSignature(body), body); err != nil {
		t.Fatal(err)
	}
	w.db.Client.FrontendSource.UpdateOneID(s.ID).SetEnabled(true).ExecX(w.ctx)
	check := fd.Check{Source: "github_check", Name: "ci", AppID: "44", ID: "one", RepositoryID: "1001", Revision: "revision1", Status: "completed", Conclusion: "success", OccurredAt: at}
	observed := fd.Observation{Provider: "vercel", Key: "late-check", Kind: "checks.observed", OccurredAt: at, Checks: []fd.Check{check}}
	if err := w.repo.acceptFrontendObservation(w.ctx, w.org, s.ID, observed, false); err != nil {
		t.Fatal(err)
	}
	if frontendAlerts(t, w) != 0 {
		t.Fatal("paused evidence replayed after enabling")
	}
	conflict := check
	conflict.ID = "two"
	conflict.Conclusion = "failure"
	merged := mergeFrontendChecks([]fd.Check{check}, []fd.Check{conflict})
	if len(merged) != 2 {
		t.Fatal("conflict was discarded by arrival order")
	}
	a := fd.Observation{Provider: "vercel", DeploymentID: "d2", Environment: "production", Production: "active", Status: "success", RepositoryID: "1001", Revision: "revision1", Checks: merged}
	if fd.Evaluate(p, a, at).State != "needs_attention" {
		t.Fatal("conflicting evidence passed")
	}
}

// Existing generic workspace fixtures retain append-only audit rows. Remove this
// fixture's audit and tenant with the same explicit retention setting used by
// notification fixtures so bounded polling never consumes old test connections.
func frontendFixtureCleanup(t *testing.T, w *testWorkspace) {
	t.Helper()
	t.Cleanup(func() {
		tx, err := w.db.SQL.BeginTx(w.ctx, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer tx.Rollback()
		for _, q := range []string{`SELECT set_config('shots.audit_retention','on',true)`, `DELETE FROM audit_log WHERE "organizationId"=$1`, `DELETE FROM organization WHERE id=$1`} {
			var err error
			if strings.Contains(q, "$1") {
				_, err = tx.ExecContext(w.ctx, q, w.org)
			} else {
				_, err = tx.ExecContext(w.ctx, q)
			}
			if err != nil {
				t.Error(err)
				return
			}
		}
		if err := tx.Commit(); err != nil {
			t.Error(err)
		}
	})
}
