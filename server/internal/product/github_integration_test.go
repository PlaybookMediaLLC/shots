package product

import (
	"context"
	"errors"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/database"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/githubapp"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasenotes"
	"github.com/lucsky/cuid"
)

type fakeGitHub struct {
	access   map[string][]int64
	installs map[int64]githubapp.Installation
	repos    map[int64][]githubapp.Repository
}

func (f fakeGitHub) ExchangeCode(_ context.Context, code string) (string, error) {
	if _, ok := f.access[code]; !ok {
		return "", errors.New("bad code")
	}
	return code, nil
}
func (f fakeGitHub) UserInstallations(_ context.Context, token string) ([]githubapp.Installation, error) {
	out := []githubapp.Installation{}
	for _, id := range f.access[token] {
		installation := f.installs[id]
		installation.ID = id
		out = append(out, installation)
	}
	return out, nil
}
func (f fakeGitHub) Installation(_ context.Context, id int64) (githubapp.Installation, error) {
	return f.installs[id], nil
}
func (f fakeGitHub) Repositories(_ context.Context, id int64) ([]githubapp.Repository, error) {
	return f.repos[id], nil
}

func TestGitHubConnectionsChangesAndReleases(t *testing.T) {
	url := os.Getenv("PUBLISHING_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("PUBLISHING_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	db, err := database.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	var name string
	if err := db.SQL.QueryRowContext(ctx, `SELECT current_database()`).Scan(&name); err != nil || !strings.Contains(name, "test") {
		t.Fatalf("refusing database %q: %v", name, err)
	}
	id := cuid.New()
	orgA, orgB, user, viewer := "orga_"+id, "orgb_"+id, "user_"+id, "viewer_"+id
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.SQL.ExecContext(ctx, query, args...); err != nil {
			t.Fatalf("%v\n%s", err, query)
		}
	}
	count := func(query string, args ...any) int {
		t.Helper()
		var n int
		if err := db.SQL.QueryRowContext(ctx, query, args...).Scan(&n); err != nil {
			t.Fatalf("%v\n%s", err, query)
		}
		return n
	}
	installation := 900000 + time.Now().UnixNano()%99999
	t.Cleanup(func() {
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM organization WHERE id=$1 OR id=$2`, orgA, orgB)
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM "user" WHERE id=$1 OR id=$2`, user, viewer)
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM github_installation WHERE "installationId" IN ($1,$2)`, installation, installation+1)
	})
	for _, u := range []string{user, viewer} {
		exec(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'U',$2,true,now(),now())`, u, u+"@example.test")
	}
	for i, org := range []string{orgA, orgB} {
		exec(`INSERT INTO organization (id,name,slug,"createdAt") VALUES ($1,$1,$1,now())`, org)
		exec(`INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,'owner',now())`, "m"+string(rune('a'+i))+id, org, user)
		exec(`INSERT INTO session (id,"expiresAt",token,"createdAt","updatedAt","userId","activeOrganizationId") VALUES ($1,now()+interval '1 hour',$1,now(),now(),$2,$3)`, "s"+string(rune('a'+i))+id, user, org)
	}
	exec(`INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,'member',now())`, "mv"+id, orgA, viewer)
	exec(`INSERT INTO session (id,"expiresAt",token,"createdAt","updatedAt","userId","activeOrganizationId") VALUES ($1,now()+interval '1 hour',$1,now(),now(),$2,$3)`, "sv"+id, viewer, orgA)
	ownerA := Actor{OrganizationID: orgA, UserID: user, SessionID: "sa" + id}
	ownerB := Actor{OrganizationID: orgB, UserID: user, SessionID: "sb" + id}
	member := Actor{OrganizationID: orgA, UserID: viewer, SessionID: "sv" + id}

	repoX, repoY := githubapp.Repository{ID: 1001, FullName: "acme/app"}, githubapp.Repository{ID: 1002, FullName: "acme/site"}
	fake := fakeGitHub{
		access: map[string][]int64{"owner-code": {installation}, "stranger-code": {42}, "two-code": {installation, installation + 1}},
		installs: map[int64]githubapp.Installation{installation: {ID: installation, AccountLogin: "acme", AccountType: "Organization", RepositorySelection: "selected"},
			installation + 1: {ID: installation + 1, AccountLogin: "octocat", AccountType: "User", RepositorySelection: "all"}},
		repos: map[int64][]githubapp.Repository{installation: {repoX, repoY}},
	}

	if _, err := NewConfiguration(db.Client).StartGitHubInstall(ctx, ownerA); !errors.Is(err, ErrGitHubUnavailable) {
		t.Fatalf("start without an App: %v", err)
	}
	repo := NewConfiguration(db.Client).WithGitHubApp(fake)
	subscribe(t, ctx, repo, orgA, "pro")
	subscribe(t, ctx, repo, orgB, "pro")
	if _, err := repo.StartGitHubInstall(ctx, member); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("a member started an install: %v", err)
	}
	if _, err := repo.StartGitHubInstall(ctx, Actor{OrganizationID: orgA, Kind: "webhook"}); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("a webhook started an install: %v", err)
	}
	stateA, err := repo.StartGitHubInstall(ctx, ownerA)
	if err != nil || len(stateA) < 40 {
		t.Fatalf("state=%q err=%v", stateA, err)
	}
	// Only the session that began it, with a code proving access, completes it.
	if _, err := repo.CompleteGitHubInstall(ctx, ownerB, stateA, "owner-code", installation); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("another workspace's session used the state: %v", err)
	}
	if _, err := repo.CompleteGitHubInstall(ctx, ownerA, stateA, "stranger-code", installation); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("a user without access linked the installation: %v", err)
	}
	if _, err := repo.CompleteGitHubInstall(ctx, ownerA, stateA, "forged", installation); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("a forged code linked the installation: %v", err)
	}
	linkA, err := repo.CompleteGitHubInstall(ctx, ownerA, stateA, "owner-code", installation)
	if err != nil || linkA.AccountLogin != "acme" || linkA.Status != "ACTIVE" {
		t.Fatalf("link=%+v err=%v", linkA, err)
	}
	if _, err := repo.CompleteGitHubInstall(ctx, ownerA, stateA, "owner-code", installation); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("a used state linked again: %v", err)
	}
	// A second workspace links an installation the user already has: GitHub's
	// install page has nothing to install, so it finishes from the code alone.
	stateB, _ := repo.StartGitHubInstall(ctx, ownerB)
	var choice *GitHubChoiceRequiredError
	if _, err := repo.CompleteGitHubInstall(ctx, ownerB, stateB, "two-code", 0); !errors.As(err, &choice) || len(choice.Choices) != 2 ||
		choice.Choices[1].AccountLogin != "octocat" {
		t.Fatalf("several reachable installations did not ask for a choice: %v", err)
	}
	if _, err := repo.CompleteGitHubInstall(ctx, ownerB, stateB, "", 42); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("picked an installation the code did not verify: %v", err)
	}
	if _, err := repo.CompleteGitHubInstall(ctx, ownerA, stateB, "", installation); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("another workspace's session picked: %v", err)
	}
	if _, err := repo.CompleteGitHubInstall(ctx, ownerB, stateB, "", 0); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("finished with neither a code nor an installation: %v", err)
	}
	linkB, err := repo.CompleteGitHubInstall(ctx, ownerB, stateB, "", installation)
	if err != nil || linkB.InstallationID != installation {
		t.Fatalf("link=%+v err=%v", linkB, err)
	}
	if _, err := repo.CompleteGitHubInstall(ctx, ownerB, stateB, "", installation+1); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("a used choice linked again: %v", err)
	}
	unverified, _ := repo.StartGitHubInstall(ctx, ownerB)
	if _, err := repo.CompleteGitHubInstall(ctx, ownerB, unverified, "", installation); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("picked without GitHub verifying anything: %v", err)
	}
	if _, err := repo.CompleteGitHubInstall(ctx, ownerB, unverified, "owner-code", 0); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("nothing left to link was not reported: %v", err)
	}
	// The one reachable installation the workspace lacks links without a choice.
	stateA2, _ := repo.StartGitHubInstall(ctx, ownerA)
	if link, err := repo.CompleteGitHubInstall(ctx, ownerA, stateA2, "two-code", 0); err != nil || link.AccountLogin != "octocat" {
		t.Fatalf("link=%+v err=%v", link, err)
	}
	if n := count(`SELECT count(*) FROM github_installation WHERE "installationId"=$1`, installation); n != 1 {
		t.Fatalf("installation rows=%d", n)
	}
	if n := count(`SELECT count(*) FROM audit_log WHERE action='product.github_installation_linked' AND "organizationId" IN ($1,$2)`, orgA, orgB); n != 3 {
		t.Fatalf("link audits=%d", n)
	}
	if links, err := repo.ListGitHubInstallations(ctx, orgA); err != nil || len(links) != 2 || !slices.ContainsFunc(links,
		func(link GitHubInstallationLink) bool { return link.ID == linkA.ID }) {
		t.Fatalf("links=%+v err=%v", links, err)
	}
	if repos, err := repo.GitHubRepositories(ctx, ownerA, linkA.ID); err != nil || len(repos) != 2 {
		t.Fatalf("repositories=%+v err=%v", repos, err)
	}
	if _, err := repo.GitHubRepositories(ctx, ownerA, linkB.ID); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("read another workspace's connection: %v", err)
	}

	connect := func(actor Actor, link, repository string, secret *string) error {
		_, err := repo.CreateSourceApp(ctx, actor, CreateSourceAppInput{AllowedHosts: []string{"https://api.github.com"},
			ExternalID: &repository, GitHubConnectionID: &link, Name: "GitHub " + repository + " " + cuid.New(),
			Provider: "github", SecretReference: secret})
		return err
	}
	if err := connect(ownerA, linkA.ID, "1001", nil); err != nil {
		t.Fatal(err)
	}
	if err := connect(ownerB, linkB.ID, "1001", nil); err != nil {
		t.Fatalf("a second workspace could not watch the same repository: %v", err)
	}
	if err := connect(ownerA, linkA.ID, "1001", nil); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("a workspace watched one repository twice: %v", err)
	}
	if err := connect(ownerA, linkA.ID, "9999", nil); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("watched a repository the installation cannot read: %v", err)
	}
	if err := connect(ownerA, linkB.ID, "1002", nil); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("used another workspace's connection: %v", err)
	}
	secret := "SOURCE_SECRET"
	if err := connect(ownerA, linkA.ID, "1002", &secret); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("a connected source named a secret: %v", err)
	}
	if n := count(`SELECT count(*) FROM outbox_event WHERE type='source_app.connected' AND "organizationId" IN ($1,$2)`, orgA, orgB); n != 2 {
		t.Fatalf("backfill events=%d", n)
	}
	sources := func(repository string) int {
		t.Helper()
		found, err := repo.GitHubSources(ctx, installation, repository)
		if err != nil {
			t.Fatal(err)
		}
		return len(found)
	}
	if n := sources("1001"); n != 2 {
		t.Fatalf("fan-out reached %d workspaces", n)
	}
	if err := repo.UnlinkGitHubInstallation(ctx, ownerB, linkB.ID); err != nil {
		t.Fatal(err)
	}
	if n := sources("1001"); n != 1 {
		t.Fatalf("an unlinked workspace still receives events: %d", n)
	}
	if n, err := repo.RemoveGitHubRepositories(ctx, installation, []string{"1001"}); err != nil || n != 1 || sources("1001") != 0 {
		t.Fatalf("removed repository archived=%d err=%v", n, err)
	}
	if err := connect(ownerA, linkA.ID, "1002", nil); err != nil {
		t.Fatal(err)
	}
	// Lifecycle events record what GitHub reports now, so a late or replayed
	// signed event never restores access GitHub has since revoked.
	created := fake.installs[installation]
	suspended := created
	suspended.Suspended = true
	githubReports := func(state githubapp.Installation) { fake.installs[installation] = state }
	statusIs := func(want string) bool {
		return count(`SELECT count(*) FROM github_installation WHERE "installationId"=$1 AND status=$2`, installation, want) == 1
	}
	githubReports(suspended)
	if _, err := repo.SetGitHubInstallationStatus(ctx, installation, GitHubInstallationSuspended); err != nil || sources("1002") != 0 {
		t.Fatalf("a suspended installation still delivers: %v", err)
	}
	// created -> suspend -> the original created again: still suspended.
	if err := repo.RecordGitHubInstallation(ctx, created); err != nil || !statusIs("SUSPENDED") || sources("1002") != 0 {
		t.Fatalf("a replayed created event restored a suspended installation: %v", err)
	}
	// GitHub cannot be read: an event that would restore access writes nothing.
	down := NewConfiguration(db.Client).WithGitHubApp(downGitHub{fake})
	githubReports(created)
	if err := down.RecordGitHubInstallation(ctx, created); !errors.Is(err, ErrGitHubUnavailable) || !statusIs("SUSPENDED") {
		t.Fatalf("an unconfirmed created event was recorded: %v", err)
	}
	if _, err := down.SetGitHubInstallationStatus(ctx, installation, GitHubInstallationActive); !errors.Is(err, ErrGitHubUnavailable) || !statusIs("SUSPENDED") {
		t.Fatalf("an unconfirmed resumption was recorded: %v", err)
	}
	if _, err := repo.SetGitHubInstallationStatus(ctx, installation, GitHubInstallationActive); err != nil || sources("1002") != 1 {
		t.Fatalf("a resumed installation does not deliver: %v", err)
	}
	// suspend -> unsuspend -> the original suspend again: GitHub says active.
	if _, err := repo.SetGitHubInstallationStatus(ctx, installation, GitHubInstallationSuspended); err != nil || !statusIs("ACTIVE") || sources("1002") != 1 {
		t.Fatalf("a replayed suspend event overrode GitHub's active installation: %v", err)
	}
	// A suspension restores nothing, so it applies even when GitHub cannot be read.
	if _, err := down.SetGitHubInstallationStatus(ctx, installation, GitHubInstallationSuspended); err != nil || !statusIs("SUSPENDED") {
		t.Fatalf("an unconfirmed suspension was not recorded: %v", err)
	}
	if err := repo.RecordGitHubInstallation(ctx, created); err != nil || !statusIs("ACTIVE") || sources("1002") != 1 {
		t.Fatalf("GitHub's active installation was not restored: %v", err)
	}
	if n, err := repo.SetGitHubInstallationStatus(ctx, installation, GitHubInstallationDeleted); err != nil || n != 1 || sources("1002") != 0 {
		t.Fatalf("a removed installation archived=%d err=%v", n, err)
	}
	// A late suspension, which applies when GitHub cannot be read, leaves a removal final.
	if _, err := down.SetGitHubInstallationStatus(ctx, installation, GitHubInstallationSuspended); err != nil || !statusIs("DELETED") {
		t.Fatalf("a late suspension changed a removed installation: %v", err)
	}

	// Merges wait for the next release, which takes them as features.
	manual, err := repo.CreateSourceApp(ctx, ownerA, CreateSourceAppInput{AllowedHosts: []string{"https://api.github.com"},
		Name: "Manual " + id, Provider: "github", SecretReference: &secret})
	if err != nil {
		t.Fatal(err)
	}
	webhook := Actor{OrganizationID: orgA, Kind: "webhook", Display: manual.ID, RequestID: "delivery"}
	merged := time.Now().Add(-time.Hour)
	change := func(number int, repository, title, author string) (*SourceChangeCollect, error) {
		return repo.CollectSourceChange(ctx, webhook, CollectSourceChangeInput{AuthorLogin: &author,
			Body: "<!-- template -->Details.\n![shot](https://example.com/" + strconv.Itoa(number) + ".png)", EventID: "d",
			Labels: []string{"ui"}, MergedAt: merged, Number: number, RepositoryID: repository, SourceAppID: manual.ID,
			Title: title, URL: "https://github.com/acme/app/pull/" + strconv.Itoa(number)})
	}
	first, err := change(1, "1001", "feat: Recurring invoices", "octocat")
	if err != nil || !first.Created {
		t.Fatalf("change=%+v err=%v", first, err)
	}
	if again, err := change(1, "1001", "feat: Recurring invoices", "octocat"); err != nil || again.Created || again.ChangeID != first.ChangeID {
		t.Fatalf("redelivered change=%+v err=%v", again, err)
	}
	if _, err := change(2, "1001", "fix: Timezones", "octocat"); err != nil {
		t.Fatal(err)
	}
	if _, err := change(7, "2002", "Other repository", "octocat"); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.CollectSourceChange(ctx, Actor{OrganizationID: orgB, Kind: "webhook"}, CollectSourceChangeInput{
		Body: "", EventID: "d", MergedAt: merged, Number: 3, RepositoryID: "1001", SourceAppID: manual.ID, Title: "x",
		URL: "https://github.com/acme/app/pull/3"}); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("another workspace collected into the source: %v", err)
	}
	if n := count(`SELECT count(*) FROM source_change WHERE "sourceAppId"=$1 AND "imageUrls" = '["https://example.com/1.png"]' AND body='Details.
![shot](https://example.com/1.png)'`, manual.ID); n != 1 {
		t.Fatalf("change body and images were not stored cleaned: %d", n)
	}
	notes := "## What's Changed\n* Recurring invoices by @octocat in https://github.com/acme/app/pull/1\n" +
		"* Bump deps by @dependabot[bot] in https://github.com/acme/app/pull/9\n<!-- hidden -->\x00"
	repositoryID, repositoryName := "1001", "acme/app"
	release, err := repo.IngestSourceRelease(ctx, webhook, IngestSourceReleaseInput{BenefitStatement: "Billing.", EventID: "release:1",
		Notes: &notes, RepositoryID: &repositoryID, RepositoryName: &repositoryName, SourceAppID: manual.ID, Title: "v1.0"})
	if err != nil || !release.Created {
		t.Fatalf("release=%+v err=%v", release, err)
	}
	stored, err := db.Client.Release.Get(ctx, release.ReleaseID)
	if err != nil {
		t.Fatal(err)
	}
	want := []releasenotes.Feature{
		{Kind: releasenotes.KindOther, Title: "Recurring invoices", Number: 1, URL: "https://github.com/acme/app/pull/1", Author: "octocat"},
		{Kind: releasenotes.KindFix, Title: "Timezones", Number: 2, URL: "https://github.com/acme/app/pull/2", Author: "octocat"},
	}
	if len(stored.Features) != len(want) || stored.Features[0] != want[0] || stored.Features[1] != want[1] {
		t.Fatalf("features=%+v", stored.Features)
	}
	if stored.Notes == nil || strings.Contains(*stored.Notes, "hidden") || strings.ContainsRune(*stored.Notes, 0) {
		t.Fatalf("notes=%v", stored.Notes)
	}
	if n := count(`SELECT count(*) FROM source_change WHERE "sourceAppId"=$1 AND "releaseId"=$2`, manual.ID, release.ReleaseID); n != 2 {
		t.Fatalf("attached changes=%d", n)
	}
	if n := count(`SELECT count(*) FROM source_change WHERE "sourceAppId"=$1 AND "repositoryId"='2002' AND "releaseId" IS NULL`, manual.ID); n != 1 {
		t.Fatalf("another repository's change was attached")
	}
	if _, err := change(4, "1001", "Late merge", "octocat"); err != nil {
		t.Fatal(err)
	}
	next, err := repo.IngestSourceRelease(ctx, webhook, IngestSourceReleaseInput{BenefitStatement: "More.", EventID: "release:2",
		RepositoryID: &repositoryID, SourceAppID: manual.ID, Title: "v1.1"})
	if err != nil {
		t.Fatal(err)
	}
	if n := count(`SELECT count(*) FROM source_change WHERE "releaseId"=$1`, next.ReleaseID); n != 1 {
		t.Fatalf("next release took %d changes", n)
	}

	// A production deployment is recorded once per GitHub deployment status.
	deployURL, sha := "https://app.acme.test", "abc123"
	deployment := IngestDeploymentInput{Environment: "production", EventID: "d", ExternalID: "555", SHA: &sha, SourceAppID: manual.ID, URL: &deployURL}
	firstDeploy, err := repo.IngestDeployment(ctx, webhook, deployment)
	if err != nil || !firstDeploy.Created {
		t.Fatalf("deployment=%+v err=%v", firstDeploy, err)
	}
	if again, err := repo.IngestDeployment(ctx, webhook, deployment); err != nil || again.Created || again.DeploymentID != firstDeploy.DeploymentID {
		t.Fatalf("replayed deployment=%+v err=%v", again, err)
	}
	insecure := "http://app.acme.test"
	deployment.URL, deployment.ExternalID = &insecure, "556"
	if _, err := repo.IngestDeployment(ctx, webhook, deployment); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("an http deployment URL was accepted: %v", err)
	}
	if n := count(`SELECT count(*) FROM outbox_event WHERE type='deployment.succeeded' AND "organizationId"=$1`, orgA); n != 1 {
		t.Fatalf("deployment events=%d", n)
	}
}
