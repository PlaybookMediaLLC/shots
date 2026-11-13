package product

import (
	"context"
	"errors"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/database"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

// Content drafts: version-checked writes, workspace isolation, ownership of
// attached assets and channels, and the plan gate.
func TestContentDrafts(t *testing.T) {
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
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.SQL.ExecContext(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	id := cuid.New()
	org, other, unpaid := "org_"+id, "other_"+id, "unpaid_"+id
	for _, organization := range []string{org, other, unpaid} {
		exec(`INSERT INTO organization (id,name,slug,"createdAt") VALUES ($1,$1,$1,now())`, organization)
	}
	for _, organization := range []string{org, other} {
		exec(`INSERT INTO workspace_entitlement ("organizationId",plan,status,"updatedAt") VALUES ($1,'pro','active',now())`, organization)
	}
	ownAsset, foreignAsset := cuid.New(), cuid.New()
	exec(`INSERT INTO asset (id,"organizationId","objectKey","mediaType",bytes,status,"createdAt","updatedAt") VALUES ($1,$2,$3,'image/png',1,'UPLOADED',now(),now())`,
		ownAsset, org, org+"/"+ownAsset)
	exec(`INSERT INTO asset (id,"organizationId","objectKey","mediaType",bytes,status,"createdAt","updatedAt") VALUES ($1,$2,$3,'image/png',1,'UPLOADED',now(),now())`,
		foreignAsset, other, other+"/"+foreignAsset)
	t.Cleanup(func() {
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM content_draft WHERE "organizationId" IN ($1,$2,$3)`, org, other, unpaid)
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM asset WHERE "organizationId" IN ($1,$2)`, org, other)
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM organization WHERE id IN ($1,$2,$3)`, org, other, unpaid)
	})
	repo := NewConfiguration(db.Client)
	actor := Actor{OrganizationID: org, Kind: "service"}
	stranger := Actor{OrganizationID: other, Kind: "service"}

	body := []any{map[string]any{"type": "p", "children": []any{map[string]any{"text": "Hello"}}}}
	created, err := repo.CreateContentDraft(ctx, actor, ContentDraftInput{
		AssetIDs: []string{ownAsset, ownAsset}, Body: body, PlainText: "Hello", Title: "  Launch post  ",
	})
	if err != nil || created.Version != 1 || created.Title != "Launch post" || created.Status != "draft" ||
		len(created.AssetIDs) != 1 || len(created.ChannelConnectionIDs) != 0 {
		t.Fatalf("created=%+v err=%v", created, err)
	}
	if untitled, err := repo.CreateContentDraft(ctx, actor, ContentDraftInput{}); err != nil || untitled.Title != contentDraftUntitledTitle {
		t.Fatalf("untitled=%+v err=%v", untitled, err)
	}

	t.Run("a stale write is refused with the current version", func(t *testing.T) {
		title := "Second"
		threads := map[string]any{"threads": []any{}}
		saved, err := repo.UpdateContentDraft(ctx, actor, created.ID, ContentDraftUpdate{BaseVersion: 1, Discussions: &threads, Title: &title})
		if err != nil || saved.Version != 2 || saved.Title != "Second" || saved.PlainText != "Hello" || len(saved.Discussions) != 2 {
			t.Fatalf("saved=%+v err=%v", saved, err)
		}
		if reread, err := repo.GetContentDraft(ctx, actor, created.ID); err != nil || len(reread.Discussions["threads"].([]any)) != 0 {
			t.Fatalf("reread=%+v err=%v", reread, err)
		}
		huge := map[string]any{"threads": strings.Repeat("x", contentDraftThreadsLimit)}
		if _, err := repo.UpdateContentDraft(ctx, actor, created.ID, ContentDraftUpdate{BaseVersion: 2, Discussions: &huge}); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("oversized comments accepted: %v", err)
		}
		stale := "Stale"
		_, err = repo.UpdateContentDraft(ctx, actor, created.ID, ContentDraftUpdate{BaseVersion: 1, Title: &stale})
		var conflict *ContentDraftVersionConflictError
		if !errors.As(err, &conflict) || conflict.Current != 2 || !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("stale write err=%v", err)
		}
	})

	t.Run("attachments must belong to the workspace", func(t *testing.T) {
		foreign := []string{foreignAsset}
		if _, err := repo.UpdateContentDraft(ctx, actor, created.ID, ContentDraftUpdate{BaseVersion: 2, AssetIDs: &foreign}); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("foreign asset accepted: %v", err)
		}
		channels := []string{cuid.New()}
		if _, err := repo.CreateContentDraft(ctx, actor, ContentDraftInput{ChannelConnectionIDs: channels}); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("unknown channel accepted: %v", err)
		}
		scheduled := "scheduled"
		if _, err := repo.UpdateContentDraft(ctx, actor, created.ID, ContentDraftUpdate{BaseVersion: 2, Status: &scheduled}); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("status scheduled set by hand: %v", err)
		}
	})

	t.Run("another workspace sees nothing", func(t *testing.T) {
		if _, err := repo.GetContentDraft(ctx, stranger, created.ID); !errors.Is(err, publishing.ErrNotFound) {
			t.Fatalf("get err=%v", err)
		}
		title := "Hijack"
		if _, err := repo.UpdateContentDraft(ctx, stranger, created.ID, ContentDraftUpdate{BaseVersion: 2, Title: &title}); !errors.Is(err, publishing.ErrNotFound) {
			t.Fatalf("update err=%v", err)
		}
		if err := repo.DeleteContentDraft(ctx, stranger, created.ID); !errors.Is(err, publishing.ErrNotFound) {
			t.Fatalf("delete err=%v", err)
		}
		if page, err := repo.ListContentDrafts(ctx, stranger, ContentDraftListQuery{}); err != nil || len(page.Items) != 0 {
			t.Fatalf("stranger page=%+v err=%v", page, err)
		}
	})

	t.Run("a workspace without a subscription cannot create a draft", func(t *testing.T) {
		_, err := repo.CreateContentDraft(ctx, Actor{OrganizationID: unpaid, Kind: "service"}, ContentDraftInput{})
		var gate *FeatureNotEntitledError
		if !errors.As(err, &gate) || gate.RequiredPlan != "pro" {
			t.Fatalf("unpaid err=%v", err)
		}
	})

	t.Run("lists page newest first and hide archived drafts", func(t *testing.T) {
		archived := "archived"
		if _, err := repo.UpdateContentDraft(ctx, actor, created.ID, ContentDraftUpdate{BaseVersion: 2, Status: &archived}); err != nil {
			t.Fatal(err)
		}
		page, err := repo.ListContentDrafts(ctx, actor, ContentDraftListQuery{Limit: 1})
		if err != nil || len(page.Items) != 1 || page.Items[0].Title != contentDraftUntitledTitle {
			t.Fatalf("page=%+v err=%v", page, err)
		}
		if page.NextCursor != nil {
			if next, err := repo.ListContentDrafts(ctx, actor, ContentDraftListQuery{Cursor: *page.NextCursor, Limit: 1}); err != nil || len(next.Items) != 0 {
				t.Fatalf("archived draft listed: %+v err=%v", next, err)
			}
		}
		if only, err := repo.ListContentDrafts(ctx, actor, ContentDraftListQuery{Status: "archived"}); err != nil || len(only.Items) != 1 {
			t.Fatalf("archived=%+v err=%v", only, err)
		}
	})

	t.Run("delete removes the draft", func(t *testing.T) {
		if err := repo.DeleteContentDraft(ctx, actor, created.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := repo.GetContentDraft(ctx, actor, created.ID); !errors.Is(err, publishing.ErrNotFound) {
			t.Fatalf("deleted draft err=%v", err)
		}
	})
}

// A draft matches only when one live post meets every criterion together. With
// no live post, it matches on what it intends.
func TestContentDraftListFiltersByAccountAndTime(t *testing.T) {
	w := newTestWorkspace(t)
	ctx, repo, owner := w.ctx, w.repo, w.owner
	subscribe(t, ctx, repo, w.org, "pro")
	w.addMember(t, "other", "creator")
	set, err := repo.CreateSocialSet(ctx, owner, SocialSetInput{Name: "Brand"})
	if err != nil {
		t.Fatal(err)
	}
	connect := func(id, platform, setID string) string {
		t.Helper()
		w.exec(t, `INSERT INTO channel_connection(id,"organizationId",provider,"externalAccountId","secretReference","createdByUserId","updatedAt",platform,"socialSetId")
			VALUES($1,$2,'social',$1,'test-only',$3,now(),$4,$5)`, id+w.id, w.org, owner.UserID, platform, setID)
		return id + w.id
	}
	x, linkedin := connect("x", "x", set.ID), connect("li", "linkedin", set.ID)
	day := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	draft := func(title string, intended ...string) string {
		t.Helper()
		row, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{Title: title, SocialSetID: set.ID, ChannelConnectionIDs: intended})
		if err != nil {
			t.Fatal(err)
		}
		return row.ID
	}
	post := func(draftID, connection string, at time.Time, status scheduledpost.Status) {
		t.Helper()
		id := cuid.New()
		if _, err := w.db.Client.ScheduledPost.Create().SetID(id).SetOrganizationID(w.org).SetContentDraftID(draftID).
			SetChannelConnectionID(connection).SetSocialSetID(set.ID).SetScheduledFor(at).SetStatus(status).
			SetCaption("post").SetIdempotencyKey(id).Save(ctx); err != nil {
			t.Fatal(err)
		}
	}
	split := draft("X last week, LinkedIn today", x, linkedin)
	post(split, x, day.AddDate(0, 0, -7), scheduledpost.StatusPUBLISHED)
	post(split, linkedin, day, scheduledpost.StatusSCHEDULED)
	today := draft("X today", x)
	post(today, x, day, scheduledpost.StatusFAILED)
	cancelled := draft("Cancelled on X, meant for LinkedIn", linkedin)
	post(cancelled, x, day, scheduledpost.StatusCANCELLED)
	intended := draft("Never scheduled, meant for X", x)
	planned := draft("Planned for today, meant for LinkedIn", linkedin)
	if _, err := w.db.Client.ContentDraft.UpdateOneID(planned).SetPlannedFor(day).Save(ctx); err != nil {
		t.Fatal(err)
	}

	from, to := day.Add(-12*time.Hour), day.Add(12*time.Hour)
	for name, c := range map[string]struct {
		query ContentDraftListQuery
		want  []string
	}{
		"account alone uses the post, else the intent":  {ContentDraftListQuery{ConnectionID: x}, []string{split, today, intended}},
		"a draft's only live post can be elsewhere":     {ContentDraftListQuery{ConnectionID: linkedin}, []string{split, cancelled, planned}},
		"both criteria on one post, never across posts": {ContentDraftListQuery{ConnectionID: x, From: &from, To: &to}, []string{today}},
		"time alone uses the post, else the plan":       {ContentDraftListQuery{From: &from, To: &to}, []string{split, today, planned}},
		"the end is exclusive":                          {ContentDraftListQuery{From: &from, To: &day}, []string{}},
		"the start is inclusive":                        {ContentDraftListQuery{From: &day, To: &to}, []string{split, today, planned}},
		"a posted view still applies":                   {ContentDraftListQuery{View: "posted", ConnectionID: x}, []string{split}},
		"a failed view lists what needs someone":        {ContentDraftListQuery{View: "failed"}, []string{today}},
		"a drafts view leaves failures out":             {ContentDraftListQuery{View: "drafts"}, []string{cancelled, intended, planned}},
		"an account from elsewhere matches nothing":     {ContentDraftListQuery{ConnectionID: cuid.New()}, []string{}},
	} {
		c.query.SocialSetID = set.ID
		page, err := repo.ListContentDrafts(ctx, owner, c.query)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		got := []string{}
		for _, row := range page.Items {
			got = append(got, row.ID)
		}
		slices.Sort(got)
		slices.Sort(c.want)
		if !slices.Equal(got, c.want) {
			t.Errorf("%s: got %v, want %v", name, got, c.want)
		}
	}

	// A retry replaces the failure before it, so the draft no longer needs anyone.
	retried := draft("Failed, then retried", x)
	post(retried, x, day.AddDate(0, 0, -30), scheduledpost.StatusFAILED)
	time.Sleep(5 * time.Millisecond) // createdAt keeps milliseconds; the retry must be newer.
	post(retried, x, day.AddDate(0, 0, -30), scheduledpost.StatusSCHEDULED)
	failed, err := repo.ListContentDrafts(ctx, owner, ContentDraftListQuery{SocialSetID: set.ID, View: "failed"})
	if err != nil {
		t.Fatal(err)
	}
	if len(failed.Items) != 1 || failed.Items[0].ID != today || failed.Items[0].AttentionAt == nil {
		t.Errorf("failed view: %+v", failed.Items)
	}

	if _, err := repo.ListContentDrafts(ctx, owner, ContentDraftListQuery{ConnectionID: "not an id"}); !errors.Is(err, ErrInvalidInput) {
		t.Errorf("a malformed account: %v", err)
	}
	if _, err := repo.ListContentDrafts(ctx, owner, ContentDraftListQuery{From: &to, To: &from}); !errors.Is(err, ErrInvalidInput) {
		t.Errorf("a reversed range: %v", err)
	}

	private, err := repo.CreateSocialSet(ctx, owner, SocialSetInput{Name: "Private", Visibility: "PRIVATE"})
	if err != nil {
		t.Fatal(err)
	}
	hidden := connect("private", "x", private.ID)
	secret, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{Title: "Private", SocialSetID: private.ID, ChannelConnectionIDs: []string{hidden}})
	if err != nil {
		t.Fatal(err)
	}
	post(secret.ID, hidden, day, scheduledpost.StatusSCHEDULED)
	page, err := repo.ListContentDrafts(ctx, w.actor("other"), ContentDraftListQuery{ConnectionID: hidden})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 0 {
		t.Errorf("another member found a private set's draft through its account: %+v", page.Items)
	}
}

// A post at 23:50 in the brand's zone whose rate-limit retry moves it past
// midnight is on the same day in the calendar and in the library's filter.
func TestContentDraftListTimeFilterMatchesCalendarDay(t *testing.T) {
	w := newTestWorkspace(t)
	ctx, repo, owner := w.ctx, w.repo, w.owner
	subscribe(t, ctx, repo, w.org, "pro")
	zone, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	set, err := repo.CreateSocialSet(ctx, owner, SocialSetInput{Name: "Brand", TimeZone: zone.String()})
	if err != nil {
		t.Fatal(err)
	}
	x := "x" + w.id
	w.exec(t, `INSERT INTO channel_connection(id,"organizationId",provider,"externalAccountId","secretReference","createdByUserId","updatedAt",platform,"socialSetId")
		VALUES($1,$2,'social',$1,'test-only',$3,now(),'x',$4)`, x, w.org, owner.UserID, set.ID)
	draft, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{Title: "Late post", SocialSetID: set.ID, ChannelConnectionIDs: []string{x}})
	if err != nil {
		t.Fatal(err)
	}
	slot := time.Date(2026, 11, 4, 23, 50, 0, 0, zone).UTC()
	post, err := w.db.Client.ScheduledPost.Create().SetID(cuid.New()).SetOrganizationID(w.org).SetContentDraftID(draft.ID).
		SetChannelConnectionID(x).SetSocialSetID(set.ID).SetSlotAt(slot).SetScheduledFor(slot).
		SetStatus(scheduledpost.StatusSCHEDULED).SetCaption("post").SetIdempotencyKey(cuid.New()).Save(ctx)
	if err != nil {
		t.Fatal(err)
	}
	queue := publishing.NewRepository(w.db.Client)
	run := "rate-limited-" + post.ID
	if claimed, err := queue.Claim(ctx, post.ID, run, slot); err != nil || !claimed {
		t.Fatalf("claim=%v %v", claimed, err)
	}
	attempt, err := queue.StartAttempt(ctx, post, run, 1)
	if err != nil {
		t.Fatal(err)
	}
	retryAt := slot.Add(30 * time.Minute)
	if err := queue.Fail(ctx, post, attempt, "RATE_LIMITED", &retryAt, run); err != nil {
		t.Fatal(err)
	}

	// The calendar reads a padded range and places each post at publishedAt ?? slotAt ?? scheduledFor.
	wed, thu := time.Date(2026, 11, 4, 0, 0, 0, 0, zone), time.Date(2026, 11, 5, 0, 0, 0, 0, zone)
	calendar, err := repo.ListContentDraftPostsBetween(ctx, owner, wed.AddDate(0, 0, -1), thu.AddDate(0, 0, 2), set.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(calendar) != 1 || !calendar[0].ScheduledFor.Equal(retryAt) || calendar[0].SlotAt == nil || calendar[0].PublishedAt != nil {
		t.Fatalf("calendar=%+v", calendar)
	}
	if got := calendar[0].SlotAt.In(zone).Format(time.DateOnly); got != "2026-11-04" {
		t.Fatalf("calendar day=%s", got)
	}
	for name, c := range map[string]struct {
		from time.Time
		want int
	}{"the calendar's day": {wed, 1}, "the day the retry runs": {thu, 0}} {
		to := c.from.AddDate(0, 0, 1)
		page, err := repo.ListContentDrafts(ctx, owner, ContentDraftListQuery{SocialSetID: set.ID, From: &c.from, To: &to})
		if err != nil {
			t.Fatal(err)
		}
		if len(page.Items) != c.want {
			t.Errorf("%s: got %d drafts, want %d", name, len(page.Items), c.want)
		}
	}

	// Once it goes out, the calendar dates it by publishedAt, and so does the filter.
	if _, err := w.db.Client.ScheduledPost.UpdateOneID(post.ID).SetStatus(scheduledpost.StatusPUBLISHED).
		SetPublishedAt(retryAt.Add(time.Minute)).Save(ctx); err != nil {
		t.Fatal(err)
	}
	for name, c := range map[string]struct {
		from time.Time
		want int
	}{"before it went out": {wed, 0}, "the day it went out": {thu, 1}} {
		to := c.from.AddDate(0, 0, 1)
		page, err := repo.ListContentDrafts(ctx, owner, ContentDraftListQuery{SocialSetID: set.ID, From: &c.from, To: &to})
		if err != nil {
			t.Fatal(err)
		}
		if len(page.Items) != c.want {
			t.Errorf("%s: got %d drafts, want %d", name, len(page.Items), c.want)
		}
	}
}
