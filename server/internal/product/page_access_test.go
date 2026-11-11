package product

import (
	"context"
	"errors"
	"strconv"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

func TestPageAccessKeepsSessionWorkspaceAndRecoveryBoundaries(t *testing.T) {
	w, foreign := newTestWorkspace(t), newTestWorkspace(t)
	subscribe(t, w.ctx, w.repo, w.org, "pro")
	actor := w.owner
	actor.OrganizationID = foreign.org // The session, not a caller header, selects the page workspace.
	snapshot, err := w.repo.PageAccess(w.ctx, actor)
	if err != nil || snapshot.Active.ID != w.org || snapshot.Workspace.ID != w.org || !snapshot.Features["workspace:use"] {
		t.Fatalf("snapshot=%+v err=%v", snapshot, err)
	}
	w.exec(t, `UPDATE session SET "activeOrganizationId"=NULL WHERE id=$1`, w.owner.SessionID)
	snapshot, err = w.repo.PageAccess(w.ctx, w.owner)
	if err != nil || snapshot.Active.ID != w.org {
		t.Fatalf("fallback=%+v err=%v", snapshot, err)
	}
	w.exec(t, `UPDATE member SET role='viewer' WHERE "userId"=$1`, w.owner.UserID)
	snapshot, err = w.repo.PageAccess(w.ctx, w.owner)
	if err != nil || snapshot.Active.Role != "viewer" {
		t.Fatalf("role=%+v err=%v", snapshot, err)
	}
	w.exec(t, `UPDATE member SET role='owner,admin' WHERE "userId"=$1`, w.owner.UserID)
	if _, err := w.repo.PageAccess(w.ctx, w.owner); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("unknown role=%v", err)
	}
	w.exec(t, `UPDATE member SET role='owner' WHERE "userId"=$1`, w.owner.UserID)
	if _, err := w.repo.RequestDeletion(w.ctx, w.owner, "Workspace"); err != nil {
		t.Fatal(err)
	}
	snapshot, err = w.repo.PageAccess(w.ctx, w.owner)
	if err != nil || snapshot.Active.WorkspaceDeletion == nil || snapshot.Workspace != nil || len(snapshot.Features) != 0 {
		t.Fatalf("recovery=%+v err=%v", snapshot, err)
	}
	w.exec(t, `UPDATE session SET "expiresAt"=now()-interval '1 hour' WHERE id=$1`, w.owner.SessionID)
	if _, err := w.repo.PageAccess(w.ctx, w.owner); !errors.Is(err, publishing.ErrUnauthorized) {
		t.Fatalf("expired=%v", err)
	}
}

func TestPageAccessWithoutMembershipOrSubscription(t *testing.T) {
	w := newTestWorkspace(t)
	snapshot, err := w.repo.PageAccess(w.ctx, w.owner)
	if err != nil || snapshot.Features["content:drafts"] || snapshot.Features["workspace:paid"] {
		t.Fatalf("unpaid=%+v %v", snapshot, err)
	}
	w.exec(t, `DELETE FROM member WHERE "userId"=$1`, w.owner.UserID)
	snapshot, err = w.repo.PageAccess(w.ctx, w.owner)
	if err != nil || snapshot.Count != 0 || snapshot.Active != nil || snapshot.Workspace != nil {
		t.Fatalf("no membership=%+v %v", snapshot, err)
	}
}

func TestWorkflowOverviewLoadsInstallationLinksInBulk(t *testing.T) {
	f := newAutomationFixture(t)
	for i := 0; i < 20; i++ {
		_, err := f.db.Client.SourceApp.Create().SetID("perf-" + strconv.Itoa(i) + f.id).
			SetOrganizationID(f.org).SetName("Repo " + strconv.Itoa(i)).SetProvider("github").SetStatus("ACTIVE").
			SetGithubInstallationID("gi" + f.id).SetAllowedHosts([]string{}).Save(f.ctx)
		if err != nil {
			t.Fatal(err)
		}
	}
	installationQueries, linkQueries := 0, 0
	f.db.Client.Intercept(ent.InterceptFunc(func(next ent.Querier) ent.Querier {
		return ent.QuerierFunc(func(ctx context.Context, query ent.Query) (ent.Value, error) {
			switch query.(type) {
			case *ent.GitHubInstallationQuery:
				installationQueries++
			case *ent.WorkspaceGitHubInstallationQuery:
				linkQueries++
			}
			return next.Query(ctx, query)
		})
	}))
	overview, err := f.repo.ReleaseAutomationOverview(f.ctx, f.owner)
	if err != nil {
		t.Fatal(err)
	}
	if len(overview.Sources) != 21 || installationQueries != 1 || linkQueries != 1 {
		t.Fatalf("sources=%d installation reads=%d link reads=%d", len(overview.Sources), installationQueries, linkQueries)
	}
	for _, source := range overview.Sources {
		if source.Account != "acme" || source.ConnectionState != "connected" {
			t.Fatalf("source=%+v", source)
		}
	}
	f.exec(t, `DELETE FROM workspace_github_installation WHERE id=$1`, "link"+f.id)
	overview, err = f.repo.ReleaseAutomationOverview(f.ctx, f.owner)
	if err != nil {
		t.Fatal(err)
	}
	for _, source := range overview.Sources {
		if source.ConnectionState != "disconnected" {
			t.Fatalf("revoked link=%+v", source)
		}
	}
}
