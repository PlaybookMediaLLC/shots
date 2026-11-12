package product

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/hook"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/database"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/google/uuid"
)

func TestWorkspaceCreationInput(t *testing.T) {
	input := CreateWorkspaceInput{Name: "  Studio  ", Slug: "  studio  "}
	normalized, key, hash, err := normalizeWorkspaceCreation(input)
	if err != nil || normalized.Name != "Studio" || normalized.Slug != "studio" || key != "slug:studio" || len(hash) != 64 {
		t.Fatalf("normalization: %+v %q %q %v", normalized, key, hash, err)
	}
	_, _, retryHash, err := normalizeWorkspaceCreation(normalized)
	if err != nil || retryHash != hash {
		t.Fatal("normalized retry changed its fingerprint")
	}
	for _, input := range []CreateWorkspaceInput{
		{Name: " \t ", Slug: "studio"}, {Name: "A", Slug: "studio"},
		{Name: strings.Repeat("x", 101), Slug: "studio"}, {Name: "Studio", Slug: "wrong/slug"},
		{Name: "Studio", Slug: "studio", IdempotencyKey: "not-a-key"},
		{Name: "Studio", Slug: "studio", IdempotencyKey: uuid.Nil.String()},
		{Name: "Studio", Slug: "studio", HeardAbout: &SignupSourceInput{Source: "billboard"}},
		{Name: "Studio", Slug: "studio", HeardAbout: &SignupSourceInput{Source: "search", Detail: "Google"}},
		{Name: "Studio", Slug: "studio", HeardAbout: &SignupSourceInput{Source: "other", Detail: strings.Repeat("é", 201)}},
		{Name: "Studio", Slug: "studio", HeardAbout: &SignupSourceInput{Source: "other", Detail: "a\x00b"}},
	} {
		if _, _, _, err := normalizeWorkspaceCreation(input); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("invalid input accepted: %+v %v", input, err)
		}
	}
	// An answer is trimmed, and 200 characters of any width fit. It is not part
	// of the workspace, so it leaves the fingerprint as old receipts hold it.
	heard, _, heardHash, err := normalizeWorkspaceCreation(CreateWorkspaceInput{
		Name: "Studio", Slug: "studio", HeardAbout: &SignupSourceInput{Source: "other", Detail: "  " + strings.Repeat("é", 200) + " "},
	})
	if err != nil || heard.HeardAbout.Detail != strings.Repeat("é", 200) || heardHash != hash {
		t.Fatalf("answered input: %+v %v", heard.HeardAbout, err)
	}
}

func TestWorkspaceCreationKeepsTheFirstSignupSource(t *testing.T) {
	db, repo, actor := workspaceCreationFixture(t)
	ctx := context.Background()
	first := creationInput()
	first.HeardAbout = &SignupSourceInput{Source: "other", Detail: "A conference talk"}
	created, err := repo.CreateWorkspace(ctx, actor, first)
	if err != nil {
		t.Fatal(err)
	}
	// The unique index on "userId" leaves at most one row to read.
	answer := func() (source, detail, organizationID string) {
		t.Helper()
		err := db.SQL.QueryRow(`SELECT source, coalesce(detail,''), "organizationId" FROM platform_signup_source WHERE "userId"=$1`,
			actor.UserID).Scan(&source, &detail, &organizationID)
		if err != nil {
			t.Fatal(err)
		}
		return
	}
	if source, detail, organizationID := answer(); source != "other" || detail != "A conference talk" || organizationID != created.ID {
		t.Fatalf("saved answer: %s %q %s", source, detail, organizationID)
	}
	// A retry that changed its answer still replays the first workspace, and a
	// later workspace keeps the first answer.
	changed := first
	changed.HeardAbout = &SignupSourceInput{Source: "youtube"}
	replayed, err := repo.CreateWorkspace(ctx, actor, changed)
	if err != nil || replayed.ID != created.ID {
		t.Fatalf("changed-answer retry=%+v err=%v", replayed, err)
	}
	second := creationInput()
	second.HeardAbout = &SignupSourceInput{Source: "linkedin"}
	if _, err := repo.CreateWorkspace(ctx, actor, second); err != nil {
		t.Fatal(err)
	}
	if source, _, organizationID := answer(); source != "other" || organizationID != created.ID {
		t.Fatalf("first answer replaced: %s %s", source, organizationID)
	}
	// Deleting the account deletes the answer. Rolled back, so the fixture's
	// cleanup still finds this test's workspaces through their receipts.
	tx, err := db.SQL.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	var left int
	if _, err := tx.Exec(`DELETE FROM "user" WHERE id=$1`, actor.UserID); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(`SELECT count(*) FROM platform_signup_source WHERE "userId"=$1`, actor.UserID).Scan(&left); err != nil || left != 0 {
		t.Fatalf("answer outlived the account: %d %v", left, err)
	}
}

func workspaceCreationFixture(t *testing.T) (*database.Database, *Configuration, Actor) {
	t.Helper()
	uri := os.Getenv("PUBLISHING_TEST_DATABASE_URL")
	if uri == "" {
		t.Skip("PUBLISHING_TEST_DATABASE_URL is not set")
	}
	db, err := database.Open(context.Background(), uri)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	var name string
	if err := db.SQL.QueryRow(`SELECT current_database()`).Scan(&name); err != nil || !strings.Contains(name, "test") {
		t.Fatal("workspace creation requires a test database")
	}
	id := uuid.NewString()
	actor := Actor{UserID: "creation-user-" + id, SessionID: "creation-session-" + id, OrganizationID: "creation-org-" + id}
	execCreationSQL(t, db, `INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,'Creation test',$2,true,now(),now())`, actor.UserID, id+"@example.test")
	execCreationSQL(t, db, `INSERT INTO organization(id,name,slug,"createdAt") VALUES($1,'Original',$2,now())`, actor.OrganizationID, id)
	execCreationSQL(t, db, `INSERT INTO member(id,"organizationId","userId",role,"createdAt") VALUES($1,$2,$3,'owner',now())`, "member-"+id, actor.OrganizationID, actor.UserID)
	execCreationSQL(t, db, `INSERT INTO session(id,"userId",token,"expiresAt","createdAt","updatedAt","activeOrganizationId") VALUES($1,$2,$3,now()+interval '1 hour',now(),now(),$4)`, actor.SessionID, actor.UserID, uuid.NewString(), actor.OrganizationID)
	t.Cleanup(func() {
		tx, err := db.SQL.Begin()
		if err != nil {
			t.Error(err)
			return
		}
		defer tx.Rollback()
		for _, query := range []string{
			`SELECT set_config('shots.audit_retention','on',true)`,
			`DELETE FROM audit_log WHERE "organizationId"=$1 OR "organizationId" IN (SELECT "organizationId" FROM platform_workspace_creation WHERE "userId"=$2)`,
			`DELETE FROM organization WHERE id=$1 OR id IN (SELECT "organizationId" FROM platform_workspace_creation WHERE "userId"=$2)`,
			`DELETE FROM "user" WHERE id=$2 AND $1::text IS NOT NULL`,
		} {
			args := []any{actor.OrganizationID, actor.UserID}
			if strings.HasPrefix(query, "SELECT") {
				args = nil
			}
			if _, err := tx.Exec(query, args...); err != nil {
				t.Error(err)
				return
			}
		}
		if err := tx.Commit(); err != nil {
			t.Error(err)
		}
	})
	return db, NewConfiguration(db.Client), actor
}

func execCreationSQL(t *testing.T, db *database.Database, query string, args ...any) {
	t.Helper()
	if _, err := db.SQL.Exec(query, args...); err != nil {
		t.Fatal(err)
	}
}

func creationInput() CreateWorkspaceInput {
	return CreateWorkspaceInput{Name: "Same visible team name", Slug: "team-" + uuid.NewString(), IdempotencyKey: uuid.NewString()}
}

func assertCreationCount(t *testing.T, db *database.Database, actor Actor, want int) {
	t.Helper()
	var count int
	if err := db.SQL.QueryRow(`SELECT count(*) FROM platform_workspace_creation WHERE "userId"=$1`, actor.UserID).Scan(&count); err != nil || count != want {
		t.Fatalf("creation receipts=%d want=%d err=%v", count, want, err)
	}
}

func TestWorkspaceCreationConcurrentReplay(t *testing.T) {
	db, repo, actor := workspaceCreationFixture(t)
	ctx := context.Background()
	input := creationInput()
	secondActor := actor
	secondActor.SessionID = "second-" + actor.SessionID
	execCreationSQL(t, db, `INSERT INTO session(id,"userId",token,"expiresAt","createdAt","updatedAt","activeOrganizationId") VALUES($1,$2,$3,now()+interval '1 hour',now(),now(),$4)`, secondActor.SessionID, actor.UserID, uuid.NewString(), actor.OrganizationID)
	const count = 8
	results := make([]*Workspace, count)
	errs := make([]error, count)
	var wg sync.WaitGroup
	for i := range count {
		wg.Add(1)
		go func() {
			defer wg.Done()
			requestActor := actor
			if i%2 == 0 {
				requestActor = secondActor
			}
			results[i], errs[i] = repo.CreateWorkspace(ctx, requestActor, input)
		}()
	}
	wg.Wait()
	for i := range count {
		if errs[i] != nil || results[i] == nil || results[i].ID != results[0].ID {
			t.Fatalf("concurrent result %d: %+v %v", i, results[i], errs[i])
		}
	}
	created := results[0]
	assertCreationCount(t, db, actor, 1)
	var owners, settings, audits, attributedEvents int
	err := db.SQL.QueryRow(`SELECT
	  (SELECT count(*) FROM member WHERE "organizationId"=$1 AND "userId"=$2 AND role='owner'),
	  (SELECT count(*) FROM workspace_settings WHERE "organizationId"=$1),
	  (SELECT count(*) FROM audit_log WHERE "organizationId"=$1 AND action='product.workspace_created'),
	  (SELECT count(*) FROM outbox_event WHERE "organizationId"=$1 AND type='activity.member.joined' AND payload->>'actorUserId'=$2)`, created.ID, actor.UserID).Scan(&owners, &settings, &audits, &attributedEvents)
	if err != nil || owners != 1 || settings != 1 || audits != 1 || attributedEvents != 1 {
		t.Fatalf("atomic records owners=%d settings=%d audits=%d attributed events=%d err=%v", owners, settings, audits, attributedEvents, err)
	}
	// A rename and workspace switch must not redirect a delayed retry.
	execCreationSQL(t, db, `UPDATE organization SET name='Renamed',slug=$2 WHERE id=$1`, created.ID, "renamed-"+uuid.NewString())
	execCreationSQL(t, db, `UPDATE session SET "activeOrganizationId"=$2 WHERE id=$1`, actor.SessionID, actor.OrganizationID)
	replayed, err := repo.CreateWorkspace(ctx, actor, input)
	if err != nil || replayed.ID != created.ID || replayed.Name != "Renamed" {
		t.Fatalf("renamed replay=%+v err=%v", replayed, err)
	}
	var active string
	if err := db.SQL.QueryRow(`SELECT "activeOrganizationId" FROM session WHERE id=$1`, actor.SessionID).Scan(&active); err != nil || active != actor.OrganizationID {
		t.Fatalf("retry changed selected workspace: %q %v", active, err)
	}
	input.Name = "Tampered"
	if _, err := repo.CreateWorkspace(ctx, actor, input); err == nil {
		t.Fatal("same key accepted changed input")
	}
	assertCreationCount(t, db, actor, 1)
}

func TestWorkspaceCreationPreservesContextAndAllowsDuplicateNames(t *testing.T) {
	db, repo, actor := workspaceCreationFixture(t)
	subscribe(t, context.Background(), repo, actor.OrganizationID, "pro")
	input := creationInput()
	input.KeepCurrentActiveOrganization = true
	first, err := repo.CreateWorkspace(context.Background(), actor, input)
	if err != nil {
		t.Fatal(err)
	}
	second, err := repo.CreateWorkspace(context.Background(), actor, creationInput())
	if err != nil || second.ID == first.ID || second.Name != first.Name {
		t.Fatalf("independent duplicate name=%+v %v", second, err)
	}
	// The first request preserved context; a later explicit create may activate.
	execCreationSQL(t, db, `UPDATE session SET "activeOrganizationId"=$2 WHERE id=$1`, actor.SessionID, actor.OrganizationID)
	input = creationInput()
	input.KeepCurrentActiveOrganization = true
	if _, err := repo.CreateWorkspace(context.Background(), actor, input); err != nil {
		t.Fatal(err)
	}
	var active string
	if err := db.SQL.QueryRow(`SELECT "activeOrganizationId" FROM session WHERE id=$1`, actor.SessionID).Scan(&active); err != nil || active != actor.OrganizationID {
		t.Fatalf("creation changed selected workspace: %q %v", active, err)
	}
	// New workspaces do not inherit the original workspace's subscription.
	execCreationSQL(t, db, `UPDATE session SET "activeOrganizationId"=$2 WHERE id=$1`, actor.SessionID, first.ID)
	summary, err := repo.GetEntitlementSummary(context.Background(), Actor{UserID: actor.UserID, SessionID: actor.SessionID, OrganizationID: first.ID})
	if err != nil || summary.Plan != "free" {
		t.Fatalf("new workspace inherited subscription=%+v %v", summary, err)
	}
}

func TestWorkspaceCreationRollsBackOwnerFailure(t *testing.T) {
	db, repo, actor := workspaceCreationFixture(t)
	fail := true
	injected := errors.New("injected owner write failure")
	db.Client.Member.Use(hook.On(func(next ent.Mutator) ent.Mutator {
		return ent.MutateFunc(func(ctx context.Context, mutation ent.Mutation) (ent.Value, error) {
			if fail {
				return nil, injected
			}
			return next.Mutate(ctx, mutation)
		})
	}, ent.OpCreate))
	input := creationInput()
	if _, err := repo.CreateWorkspace(context.Background(), actor, input); !errors.Is(err, injected) {
		t.Fatalf("owner failure=%v", err)
	}
	assertCreationCount(t, db, actor, 0)
	var count int
	if err := db.SQL.QueryRow(`SELECT count(*) FROM organization WHERE slug=$1`, input.Slug).Scan(&count); err != nil || count != 0 {
		t.Fatalf("ownerless workspace survived: %d %v", count, err)
	}
	fail = false
	if _, err := repo.CreateWorkspace(context.Background(), actor, input); err != nil {
		t.Fatalf("retry after rollback: %v", err)
	}
	assertCreationCount(t, db, actor, 1)
}

func TestWorkspaceCreationRechecksAuthority(t *testing.T) {
	db, repo, actor := workspaceCreationFixture(t)
	input := creationInput()
	wrong := actor
	wrong.UserID = "other-user"
	if _, err := repo.CreateWorkspace(context.Background(), wrong, input); !errors.Is(err, publishing.ErrUnauthorized) {
		t.Fatalf("foreign session accepted: %v", err)
	}
	wrong = actor
	wrong.Kind = "api_key"
	if _, err := repo.CreateWorkspace(context.Background(), wrong, input); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("API key accepted: %v", err)
	}
	execCreationSQL(t, db, `UPDATE "user" SET banned=true WHERE id=$1`, actor.UserID)
	if _, err := repo.CreateWorkspace(context.Background(), actor, input); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("banned actor accepted: %v", err)
	}
	execCreationSQL(t, db, `UPDATE "user" SET banned=false WHERE id=$1`, actor.UserID)
	execCreationSQL(t, db, `UPDATE session SET "expiresAt"=now()-interval '1 second' WHERE id=$1`, actor.SessionID)
	if _, err := repo.CreateWorkspace(context.Background(), actor, input); !errors.Is(err, publishing.ErrUnauthorized) {
		t.Fatalf("expired actor accepted: %v", err)
	}
	assertCreationCount(t, db, actor, 0)
}

func TestWorkspaceCreationLegacyReplayAndRevocation(t *testing.T) {
	db, repo, actor := workspaceCreationFixture(t)
	ctx := context.Background()
	input := creationInput()
	input.IdempotencyKey = ""
	created, err := repo.CreateWorkspace(ctx, actor, input)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := repo.CreateWorkspace(ctx, actor, input)
	if err != nil || replayed.ID != created.ID {
		t.Fatalf("legacy replay=%+v %v", replayed, err)
	}
	execCreationSQL(t, db, `DELETE FROM member WHERE "organizationId"=$1 AND "userId"=$2`, created.ID, actor.UserID)
	if _, err := repo.CreateWorkspace(ctx, actor, input); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("removed member replay=%v", err)
	}
	// Simulate authorized retention of this disposable fixture before physical
	// deletion; normal workspace purge retains the organization for audit.
	tx, err := db.SQL.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`SELECT set_config('shots.audit_retention','on',true)`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(`DELETE FROM audit_log WHERE "organizationId"=$1`, created.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(`DELETE FROM organization WHERE id=$1`, created.ID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.CreateWorkspace(ctx, actor, input); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("deleted organization replay=%v", err)
	}
	assertCreationCount(t, db, actor, 1)
}

func TestWorkspaceCreationReceiptFailureRollsBackEverything(t *testing.T) {
	db, repo, actor := workspaceCreationFixture(t)
	injected := errors.New("injected receipt failure")
	db.Client.PlatformWorkspaceCreation.Use(hook.On(func(next ent.Mutator) ent.Mutator {
		return ent.MutateFunc(func(context.Context, ent.Mutation) (ent.Value, error) { return nil, injected })
	}, ent.OpCreate))
	input := creationInput()
	if _, err := repo.CreateWorkspace(context.Background(), actor, input); !errors.Is(err, injected) {
		t.Fatalf("receipt failure=%v", err)
	}
	assertCreationCount(t, db, actor, 0)
	var organizations, memberships, audits int
	var active string
	err := db.SQL.QueryRow(`SELECT
	 (SELECT count(*) FROM organization WHERE slug=$1),
	 (SELECT count(*) FROM member WHERE "userId"=$2),
	 (SELECT count(*) FROM audit_log WHERE "actorUserId"=$2),
	 (SELECT "activeOrganizationId" FROM session WHERE id=$3)`, input.Slug, actor.UserID, actor.SessionID).Scan(&organizations, &memberships, &audits, &active)
	if err != nil || organizations != 0 || memberships != 1 || audits != 0 || active != actor.OrganizationID {
		t.Fatalf("partial commit: orgs=%d members=%d audits=%d active=%q err=%v", organizations, memberships, audits, active, err)
	}
}

func TestWorkspaceCreationRequestKeysAreActorScoped(t *testing.T) {
	db, repo, actor := workspaceCreationFixture(t)
	otherDB, otherRepo, other := workspaceCreationFixture(t)
	input := creationInput()
	created, err := repo.CreateWorkspace(context.Background(), actor, input)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := otherRepo.CreateWorkspace(context.Background(), other, input); err == nil {
		t.Fatal("another actor replayed a workspace they do not own")
	}
	input.Slug = "independent-" + uuid.NewString()
	independent, err := otherRepo.CreateWorkspace(context.Background(), other, input)
	if err != nil || independent.ID == created.ID {
		t.Fatalf("actor-scoped request=%+v %v", independent, err)
	}
	assertCreationCount(t, db, actor, 1)
	assertCreationCount(t, otherDB, other, 1)
}

func TestWorkspaceCreationPreNormalizationReceiptReplay(t *testing.T) {
	db, repo, actor := workspaceCreationFixture(t)
	input := creationInput()
	input.Name = " Cafe\u0301 "
	created, err := repo.CreateWorkspace(context.Background(), actor, input)
	if err != nil || created.Name != "Café" {
		t.Fatalf("normalized creation=%+v err=%v", created, err)
	}
	// Reproduce the exact v1 payload, independent of today's fingerprint helper.
	legacy, err := json.Marshal(struct {
		Name                          string `json:"name"`
		Slug                          string `json:"slug"`
		IdempotencyKey                string `json:"idempotencyKey,omitempty"`
		KeepCurrentActiveOrganization bool   `json:"keepCurrentActiveOrganization,omitempty"`
	}{Name: strings.TrimSpace(input.Name), Slug: input.Slug})
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(legacy)
	execCreationSQL(t, db, `UPDATE platform_workspace_creation SET "requestHash"=$2 WHERE "organizationId"=$1`, created.ID, hex.EncodeToString(hash[:]))
	execCreationSQL(t, db, `UPDATE organization SET name='Renamed after creation',slug=$2 WHERE id=$1`, created.ID, "renamed-"+uuid.NewString())
	replay, err := repo.CreateWorkspace(context.Background(), actor, input)
	if err != nil || replay.ID != created.ID || replay.Name != "Renamed after creation" {
		t.Fatalf("pre-normalization retry=%+v err=%v", replay, err)
	}
	assertCreationCount(t, db, actor, 1)
}

func TestWorkspaceCreationReturnsDurableMetadataAndCurrentMember(t *testing.T) {
	db, repo, actor := workspaceCreationFixture(t)
	input := creationInput()
	logo := "https://example.test/logo.png"
	input.Logo = &logo
	input.Metadata = map[string]any{"source": "test", "nested": map[string]any{"count": 2, "enabled": true}}
	created, err := repo.CreateWorkspace(context.Background(), actor, input)
	if err != nil {
		t.Fatal(err)
	}
	if created.Logo == nil || *created.Logo != logo || created.Metadata == nil || created.CreationMember == nil {
		t.Fatalf("missing persisted creation fields: %+v", created)
	}
	var metadata map[string]any
	if err := json.Unmarshal([]byte(*created.Metadata), &metadata); err != nil || metadata["source"] != "test" {
		t.Fatalf("metadata=%v err=%v", metadata, err)
	}
	owner := created.CreationMember
	if owner.ID == "" || owner.UserID != actor.UserID || owner.OrganizationID != created.ID || owner.Role != "owner" || owner.CreatedAt.IsZero() {
		t.Fatalf("wrong owner projection: %+v", owner)
	}
	execCreationSQL(t, db, `UPDATE member SET role='viewer' WHERE id=$1`, owner.ID)
	replay, err := repo.CreateWorkspace(context.Background(), actor, input)
	if err != nil || replay.CreationMember == nil || replay.CreationMember.ID != owner.ID || replay.CreationMember.Role != "viewer" {
		t.Fatalf("stale membership on replay=%+v err=%v", replay, err)
	}
	assertCreationCount(t, db, actor, 1)
}

func TestWorkspaceCreationRejectsInvalidMetadataAndLogo(t *testing.T) {
	for _, value := range []string{"file:///tmp/logo.png", "https://user:password@example.test/logo.png", "https://example.test/" + strings.Repeat("x", 2048)} {
		input := creationInput()
		input.Logo = &value
		if _, _, _, err := normalizeWorkspaceCreation(input); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("accepted invalid logo: %v", err)
		}
	}
	for _, value := range []map[string]any{
		{"large": strings.Repeat("x", 8193)},
		{"escaped": strings.Repeat("<", 1500)},
		{"nested": map[string]any{"nested": map[string]any{"nested": map[string]any{}}}},
		{"invalid": make(chan string)},
	} {
		input := creationInput()
		input.Metadata = value
		if _, _, _, err := normalizeWorkspaceCreation(input); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("accepted invalid metadata: %v", err)
		}
	}
}
