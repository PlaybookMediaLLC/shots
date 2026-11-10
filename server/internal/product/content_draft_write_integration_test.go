package product

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentdraftrevision"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/draftdoc"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

// The Write workspace (RFC 025) on the settings platform's social sets (RFC
// 043): a draft posts as its set's accounts and is hidden with a private
// set; organizing a draft never touches its content or version; copies,
// duplicates and recovered backups are new drafts without the source's
// publication, sharing, review or discussion state.
func TestWriteWorkspace(t *testing.T) {
	w := newTestWorkspace(t)
	ctx, repo, owner := w.ctx, w.repo, w.owner
	subscribe(t, ctx, repo, w.org, "pro")
	w.addMember(t, "writer", "creator")
	writer := w.actor("writer")
	if _, err := repo.UpdateUserPreferences(ctx, owner, UserPreferencesUpdate{Experiments: map[string]bool{
		ExperimentDraftTags: true}}); err != nil {
		t.Fatal(err)
	}
	defaultSet, err := repo.CreateSocialSet(ctx, owner, SocialSetInput{Name: "Acme"})
	if err != nil {
		t.Fatal(err)
	}
	brand, err := repo.CreateSocialSet(ctx, owner, SocialSetInput{Name: defaultSet.Name, Visibility: "PRIVATE"})
	if err != nil {
		t.Fatal(err)
	}
	connect := func(platform, external, setID string) string {
		t.Helper()
		connection, err := repo.auth.CreateConnection(ctx, publishing.Actor{Organization: w.org, UserID: owner.UserID, RequestID: owner.RequestID, Type: "USER"},
			publishing.CreateConnectionInput{ExternalAccountID: external, Platform: platform, ProviderSettings: map[string]any{},
				SecretReference: "SOCIAL_API_KEY", SocialSetID: &setID})
		if err != nil {
			t.Fatal(err)
		}
		return connection.ID
	}
	xOne, linkedinOne := connect("x", "x-one-"+w.id, defaultSet.ID), connect("linkedin", "li-one-"+w.id, defaultSet.ID)
	xTwo := connect("x", "x-two-"+w.id, brand.ID)
	for id, platforms := range map[string][]string{defaultSet.ID: {"x", "linkedin"}, brand.ID: {"x"}} {
		current, err := repo.GetSocialSet(ctx, owner, id)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := repo.UpdateSocialSet(ctx, owner, id, SocialSetUpdate{BaseVersion: current.Version, DefaultPlatforms: &platforms}); err != nil {
			t.Fatal(err)
		}
	}
	text := func(value string) []any {
		return []any{map[string]any{"type": "p", "children": []any{map[string]any{"text": value}}}}
	}

	t.Run("same-named sets stay apart: a draft posts as its own set's accounts", func(t *testing.T) {
		draft, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{SocialSetID: brand.ID, Body: text("brand post")})
		if err != nil || draft.SocialSetID == nil || *draft.SocialSetID != brand.ID || len(draft.ChannelConnectionIDs) != 1 ||
			draft.ChannelConnectionIDs[0] != xTwo {
			t.Fatalf("a draft in the brand set posts as the brand's account: %+v err=%v", draft, err)
		}
		if _, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{SocialSetID: brand.ID, ChannelConnectionIDs: []string{xOne}}); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("a draft took another set's account: %v", err)
		}
	})

	t.Run("a private set's drafts are hidden from everyone else", func(t *testing.T) {
		draft, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{SocialSetID: brand.ID, Body: text("secret")})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := repo.GetContentDraft(ctx, writer, draft.ID); !errors.Is(err, publishing.ErrNotFound) {
			t.Fatalf("another member read a private draft: %v", err)
		}
		title := "taken over"
		if _, err := repo.UpdateContentDraft(ctx, writer, draft.ID, ContentDraftUpdate{BaseVersion: 1, Title: &title}); !errors.Is(err, publishing.ErrNotFound) {
			t.Fatalf("another member wrote a private draft: %v", err)
		}
		page, err := repo.ListContentDrafts(ctx, writer, ContentDraftListQuery{})
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range page.Items {
			if item.ID == draft.ID {
				t.Fatal("another member listed a private draft")
			}
		}
		if _, err := repo.ListContentDrafts(ctx, writer, ContentDraftListQuery{SocialSetID: brand.ID}); !errors.Is(err, publishing.ErrNotFound) {
			t.Fatalf("another member listed the private set: %v", err)
		}
	})

	t.Run("kinds carry explicit targets for their platform", func(t *testing.T) {
		reply, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{Kind: "reply",
			Target: &draftdoc.Target{URL: "https://x.com/someone/status/1234567890"}})
		if err != nil || reply.Kind != "reply" || reply.Target == nil || reply.Target.RemoteID != "1234567890" ||
			reply.Target.Platform != "x" || reply.PrimaryPlatform == nil || *reply.PrimaryPlatform != "x" || len(reply.ChannelConnectionIDs) != 1 || reply.ChannelConnectionIDs[0] != xOne {
			t.Fatalf("reply=%+v err=%v", reply, err)
		}
		if _, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{Kind: "reply"}); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("a reply without a target was accepted: %v", err)
		}
		if _, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{Kind: "reply", Target: &draftdoc.Target{URL: "https://example.com/x/status/1"}}); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("a reply to a non-X URL was accepted: %v", err)
		}
		quote, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{Kind: "quote",
			Target: &draftdoc.Target{URL: "https://www.linkedin.com/feed/update/urn:li:share:7000000000000000000/"}})
		if err != nil || quote.PrimaryPlatform == nil || *quote.PrimaryPlatform != "linkedin" || quote.Target.RemoteID != "urn:li:share:7000000000000000000" {
			t.Fatalf("a LinkedIn reshare: %+v err=%v", quote, err)
		}
		if _, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{Kind: "article", PrimaryPlatform: "linkedin"}); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("a LinkedIn article was accepted: %v", err)
		}
		article, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{Kind: "article", Article: &draftdoc.Article{Title: " Why we built it "}})
		if err != nil || article.Article == nil || article.Article.Title != "Why we built it" || len(article.ChannelConnectionIDs) != 1 {
			t.Fatalf("article=%+v err=%v", article, err)
		}
	})

	t.Run("platform versions keep manual bodies and refuse unsupported options", func(t *testing.T) {
		manual := draftdoc.PlatformVersions{SchemaVersion: 1, Versions: []draftdoc.PlatformVersion{{
			Channel: "linkedin", Mode: draftdoc.ModeManual, Body: text("LinkedIn says it longer"), ForkedFromVersion: 1, SourceHash: "abc",
			Options: &draftdoc.VersionOptions{Visibility: "CONNECTIONS", FirstComment: "Link in comments"},
		}}}
		draft, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{Body: text("X first"), PlatformVersions: &manual})
		if err != nil || len(draft.PlatformVersions.Versions) != 1 || draft.PlatformVersions.Versions[0].Mode != draftdoc.ModeManual {
			t.Fatalf("draft=%+v err=%v", draft, err)
		}
		body := text("X edited")
		saved, err := repo.UpdateContentDraft(ctx, owner, draft.ID, ContentDraftUpdate{BaseVersion: 1, Body: &body})
		if err != nil || !sameJSON(saved.PlatformVersions, draft.PlatformVersions) {
			t.Fatalf("a primary edit changed the LinkedIn version: %+v err=%v", saved, err)
		}
		for name, doc := range map[string]draftdoc.PlatformVersions{
			"synced with a body":       {SchemaVersion: 1, Versions: []draftdoc.PlatformVersion{{Channel: "linkedin", Mode: "synced", Body: text("x")}}},
			"a duplicate channel":      {SchemaVersion: 1, Versions: []draftdoc.PlatformVersion{{Channel: "linkedin", Mode: "synced"}, {Channel: "linkedin", Mode: "synced"}}},
			"visibility on X":          {SchemaVersion: 1, Versions: []draftdoc.PlatformVersion{{Channel: "threads", Mode: "synced", Options: &draftdoc.VersionOptions{Visibility: "PUBLIC"}}}},
			"a future schema":          {SchemaVersion: 2, Versions: []draftdoc.PlatformVersion{}},
			"a manual primary version": {SchemaVersion: 1, Versions: []draftdoc.PlatformVersion{{Channel: "x", Mode: "manual", Body: text("x")}}},
			"an unknown numbering":     {SchemaVersion: 1, Versions: []draftdoc.PlatformVersion{{Channel: "threads", Mode: "synced", Options: &draftdoc.VersionOptions{Numbering: &draftdoc.Numbering{Enabled: true, Position: "middle", Style: "hash"}}}}},
		} {
			doc := doc
			if _, err := repo.UpdateContentDraft(ctx, owner, draft.ID, ContentDraftUpdate{BaseVersion: saved.Version, PlatformVersions: &doc}); !errors.Is(err, ErrInvalidInput) {
				t.Errorf("%s accepted: %v", name, err)
			}
		}
	})

	t.Run("organizing a draft keeps its version and order", func(t *testing.T) {
		created, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{Body: text("tag me")})
		if err != nil {
			t.Fatal(err)
		}
		draft, err := repo.GetContentDraft(ctx, owner, created.ID)
		if err != nil {
			t.Fatal(err)
		}
		launch, err := repo.CreateContentDraftTag(ctx, owner, defaultSet.ID, ContentDraftTagInput{Name: ptr("Launch")})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := repo.CreateContentDraftTag(ctx, owner, defaultSet.ID, ContentDraftTagInput{Name: ptr("launch")}); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("a duplicate tag name was accepted: %v", err)
		}
		brandTag, err := repo.CreateContentDraftTag(ctx, owner, brand.ID, ContentDraftTagInput{Name: ptr("Launch"), Color: ptr("violet")})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := repo.UpdateContentDraftProperties(ctx, owner, draft.ID, ContentDraftPropertiesInput{AddTagIDs: []string{brandTag.ID}}); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("another set's tag was applied: %v", err)
		}
		pinned := true
		tagged, err := repo.UpdateContentDraftProperties(ctx, owner, draft.ID, ContentDraftPropertiesInput{
			AddTagIDs: []string{launch.ID}, Pinned: &pinned, Scratchpad: ptr("internal only")})
		if err != nil || tagged.Version != draft.Version || !tagged.UpdatedAt.Equal(draft.UpdatedAt) || tagged.PinnedAt == nil ||
			len(tagged.TagIDs) != 1 || tagged.Scratchpad != "internal only" {
			t.Fatalf("tagged=%+v err=%v", tagged, err)
		}
		page, err := repo.ListContentDrafts(ctx, owner, ContentDraftListQuery{TagID: launch.ID})
		if err != nil || len(page.Pinned) != 1 || page.Pinned[0].ID != draft.ID || len(page.Items) != 0 {
			t.Fatalf("a tag filter lists the pinned draft first: %+v err=%v", page, err)
		}
		if found, err := repo.ListContentDrafts(ctx, owner, ContentDraftListQuery{Search: "INTERNAL"}); err != nil || len(found.Pinned) != 1 {
			t.Fatalf("search reaches the scratchpad: %+v err=%v", found, err)
		}
		if err := repo.DeleteContentDraftTag(ctx, owner, defaultSet.ID, launch.ID); err != nil {
			t.Fatal(err)
		}
		untagged, err := repo.GetContentDraft(ctx, owner, draft.ID)
		if err != nil || len(untagged.TagIDs) != 0 || untagged.Version != draft.Version {
			t.Fatalf("deleting a tag untags in place: %+v err=%v", untagged, err)
		}
		oldest, err := repo.ListContentDrafts(ctx, owner, ContentDraftListQuery{Sort: "created_asc", Limit: 2})
		if err != nil || len(oldest.Items) != 2 || oldest.Items[0].CreatedAt.After(oldest.Items[1].CreatedAt) || oldest.NextCursor == nil {
			t.Fatalf("oldest first: %+v err=%v", oldest, err)
		}
		next, err := repo.ListContentDrafts(ctx, owner, ContentDraftListQuery{Sort: "created_asc", Limit: 2, Cursor: *oldest.NextCursor})
		if err != nil || len(next.Items) == 0 || next.Items[0].CreatedAt.Before(oldest.Items[1].CreatedAt) {
			t.Fatalf("the next page continues oldest first: %+v err=%v", next, err)
		}
		if _, err := repo.ListContentDrafts(ctx, owner, ContentDraftListQuery{Sort: "random"}); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("an unknown sort was accepted: %v", err)
		}
	})

	t.Run("planning is promoted: no opt-in, and no switch turns it off", func(t *testing.T) {
		// A workspace that turned the experiment off before it was promoted.
		w.exec(t, `INSERT INTO workspace_settings ("organizationId","updatedAt","disabledExperiments") VALUES ($1, now(), $2)
			ON CONFLICT ("organizationId") DO UPDATE SET "disabledExperiments" = EXCLUDED."disabledExperiments"`, w.org, `["draft-planning"]`)
		draft, err := repo.CreateContentDraft(ctx, writer, ContentDraftInput{Body: text("the writer plans")})
		if err != nil {
			t.Fatal(err)
		}
		at := time.Now().Add(24 * time.Hour).Truncate(time.Minute)
		if _, err := repo.PlanContentDraft(ctx, writer, draft.ID, ContentDraftPlanInput{BaseCalendarVersion: draft.CalendarVersion, PlannedFor: &at, TimeZone: "UTC"}); err != nil {
			t.Fatalf("someone who never opted in could not plan: %v", err)
		}
		states, err := repo.ListExperiments(ctx, writer)
		if err != nil {
			t.Fatal(err)
		}
		for _, state := range states {
			if state.ID == ExperimentDraftPlanning && (!state.Enabled || state.DisabledByAdmin || state.UserEditable) {
				t.Fatalf("planning reads as optional: %+v", state)
			}
		}
		if _, err := repo.UpdateUserPreferences(ctx, writer, UserPreferencesUpdate{Experiments: map[string]bool{ExperimentDraftPlanning: false}}); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("a person turned planning off: %v", err)
		}
		if _, err := repo.SetWorkspaceExperiment(ctx, owner, ExperimentDraftPlanning, true); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("an owner turned planning off for the workspace: %v", err)
		}
	})

	t.Run("a planned draft has no scheduled post", func(t *testing.T) {
		draft, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{Body: text("plan me")})
		if err != nil {
			t.Fatal(err)
		}
		at := time.Now().Add(48 * time.Hour).Truncate(time.Minute)
		planned, err := repo.PlanContentDraft(ctx, owner, draft.ID, ContentDraftPlanInput{BaseCalendarVersion: draft.CalendarVersion, PlannedFor: &at, TimeZone: "Europe/Paris"})
		if err != nil || planned.PlannedFor == nil || !planned.PlannedFor.Equal(at) || planned.Version != draft.Version {
			t.Fatalf("planned=%+v err=%v", planned, err)
		}
		if posts, err := repo.ListContentDraftPosts(ctx, owner, draft.ID); err != nil || len(posts) != 0 {
			t.Fatalf("planning made posts: %+v err=%v", posts, err)
		}
		calendar, err := repo.ListPlannedContentDrafts(ctx, owner, at.Add(-time.Hour), at.Add(time.Hour), "")
		if err != nil || len(calendar) != 1 || calendar[0].ID != draft.ID {
			t.Fatalf("calendar=%+v err=%v", calendar, err)
		}
		past := time.Now().Add(-time.Hour)
		if _, err := repo.PlanContentDraft(ctx, owner, draft.ID, ContentDraftPlanInput{BaseCalendarVersion: planned.CalendarVersion, PlannedFor: &past, TimeZone: "UTC"}); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("a past plan was accepted: %v", err)
		}
		if _, err := repo.PlanContentDraft(ctx, owner, draft.ID, ContentDraftPlanInput{BaseCalendarVersion: planned.CalendarVersion, PlannedFor: &at, TimeZone: "Mars/Olympus"}); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("an unknown zone was accepted: %v", err)
		}
		revisions, err := repo.ListContentDraftRevisions(ctx, owner, draft.ID)
		if err != nil || len(revisions) != 1 || revisions[0].Reason != "plan" {
			t.Fatalf("a plan keeps a backup: %+v err=%v", revisions, err)
		}
		cleared, err := repo.PlanContentDraft(ctx, owner, draft.ID, ContentDraftPlanInput{BaseCalendarVersion: planned.CalendarVersion})
		if err != nil || cleared.PlannedFor != nil {
			t.Fatalf("cleared=%+v err=%v", cleared, err)
		}
	})

	t.Run("duplicates and copies leave publication and sharing behind", func(t *testing.T) {
		source, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{Body: text("original"), ChannelConnectionIDs: []string{xOne, linkedinOne},
			Title: "Source"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := repo.ShareContentDraft(ctx, owner, source.ID, true); err != nil {
			t.Fatal(err)
		}
		if _, err := repo.ReviewContentDraft(ctx, owner, source.ID, ContentDraftReviewInput{Version: source.Version, Action: "approve"}); err != nil {
			t.Fatal(err)
		}
		tag, err := repo.CreateContentDraftTag(ctx, owner, defaultSet.ID, ContentDraftTagInput{Name: ptr("Evergreen")})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := repo.CreateContentDraftTag(ctx, owner, brand.ID, ContentDraftTagInput{Name: ptr("evergreen")}); err != nil {
			t.Fatal(err)
		}
		if _, err := repo.UpdateContentDraftProperties(ctx, owner, source.ID, ContentDraftPropertiesInput{AddTagIDs: []string{tag.ID}}); err != nil {
			t.Fatal(err)
		}
		duplicate, err := repo.DuplicateContentDraft(ctx, owner, source.ID)
		if err != nil {
			t.Fatal(err)
		}
		copy := duplicate.Draft
		if copy.ID == source.ID || copy.Version != 1 || copy.ShareToken != nil || copy.ReviewStatus != "none" || copy.PinnedAt != nil ||
			copy.SourceDraftID == nil || *copy.SourceDraftID != source.ID || copy.Title != "Source (copy)" || len(copy.ChannelConnectionIDs) != 2 ||
			len(copy.TagIDs) != 1 || len(copy.GuestComments) != 0 {
			t.Fatalf("duplicate=%+v", copy)
		}
		moved, err := repo.CopyContentDraftToSet(ctx, owner, source.ID, ContentDraftCopyInput{SocialSetID: &brand.ID, TagMode: "match"})
		if err != nil {
			t.Fatal(err)
		}
		if moved.Draft.SocialSetID == nil || *moved.Draft.SocialSetID != brand.ID || len(moved.Draft.ChannelConnectionIDs) != 1 ||
			moved.Draft.ChannelConnectionIDs[0] != xTwo || len(moved.Draft.TagIDs) != 1 || len(moved.Dropped) != 1 || moved.Dropped[0] != "platform:linkedin" {
			t.Fatalf("copy to the brand set: %+v", moved)
		}
		dropped, err := repo.CopyContentDraftToSet(ctx, owner, source.ID, ContentDraftCopyInput{SocialSetID: &brand.ID, TagMode: "drop"})
		if err != nil || len(dropped.Draft.TagIDs) != 0 {
			t.Fatalf("drop tags: %+v err=%v", dropped, err)
		}
		if _, err := repo.CopyContentDraftToSet(ctx, writer, source.ID, ContentDraftCopyInput{SocialSetID: &brand.ID, TagMode: "drop"}); !errors.Is(err, publishing.ErrNotFound) {
			t.Fatalf("another member copied into a private set: %v", err)
		}
	})

	t.Run("recovering a backup makes a new draft and leaves the source", func(t *testing.T) {
		draft, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{Body: text("first words"), PlainText: "first words"})
		if err != nil {
			t.Fatal(err)
		}
		body := text("second words")
		edited, err := repo.UpdateContentDraft(ctx, owner, draft.ID, ContentDraftUpdate{BaseVersion: 1, Body: &body, PlainText: ptr("second words")})
		if err != nil {
			t.Fatal(err)
		}
		revisions, err := repo.ListContentDraftRevisions(ctx, owner, draft.ID)
		if err != nil || len(revisions) == 0 {
			t.Fatalf("revisions=%+v err=%v", revisions, err)
		}
		recovered, err := repo.RecoverContentDraftRevision(ctx, owner, draft.ID, revisions[0].ID)
		if err != nil {
			t.Fatal(err)
		}
		if recovered.Draft.ID == draft.ID || recovered.Draft.Version != 1 || recovered.Draft.SourceDraftID == nil {
			t.Fatalf("recovered=%+v", recovered.Draft)
		}
		after, err := repo.GetContentDraft(ctx, owner, draft.ID)
		if err != nil || after.Version != edited.Version || !sameJSON(after.Body, edited.Body) {
			t.Fatalf("the source changed: %+v err=%v", after, err)
		}
		if _, err := repo.RecoverContentDraftRevision(ctx, owner, draft.ID, "cnotarevision000000000000"); !errors.Is(err, publishing.ErrNotFound) {
			t.Fatalf("an unknown revision: %v", err)
		}
	})

	t.Run("activity records changes and never views", func(t *testing.T) {
		draft, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{Body: text("watched")})
		if err != nil {
			t.Fatal(err)
		}
		title := "Renamed"
		if _, err := repo.UpdateContentDraft(ctx, owner, draft.ID, ContentDraftUpdate{BaseVersion: 1, Title: &title}); err != nil {
			t.Fatal(err)
		}
		if _, err := repo.ShareContentDraft(ctx, owner, draft.ID, true); err != nil {
			t.Fatal(err)
		}
		for range 3 {
			if _, err := repo.GetContentDraft(ctx, writer, draft.ID); err != nil {
				t.Fatal(err)
			}
		}
		items, err := repo.ListContentDraftActivity(ctx, writer, draft.ID)
		if err != nil || len(items) != 3 || items[0].Action != "product.content_draft_shared" || items[2].Action != "product.content_draft_created" ||
			items[1].Metadata["changed"] == nil || items[0].ActorName == nil || *items[0].ActorName != "owner" {
			t.Fatalf("activity=%+v err=%v", items, err)
		}
	})

	t.Run("a draft's own follow-ups are checked", func(t *testing.T) {
		own := draftdoc.PlatformVersions{SchemaVersion: 1, Versions: []draftdoc.PlatformVersion{{Channel: "x", Mode: "synced",
			Options: &draftdoc.VersionOptions{Automation: &postoptions.AutoActions{PlugAtLikes: 5, PlugText: "Mine"}}}}}
		mine, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{PlatformVersions: &own})
		if err != nil || mine.PlatformVersions.Versions[0].Options.Automation.PlugAtLikes != 5 {
			t.Fatalf("a draft's own follow-ups: %+v %v", mine, err)
		}
		for name, actions := range map[string]draftdoc.PlatformVersion{
			"LinkedIn reposts": {Channel: "linkedin", Mode: "synced", Options: &draftdoc.VersionOptions{Automation: &postoptions.AutoActions{
				Retweets: []postoptions.RetweetRule{{AfterMinutes: 60}}}}},
			"a repost at 25:00": {Channel: "x", Mode: "synced", Options: &draftdoc.VersionOptions{Automation: &postoptions.AutoActions{
				Retweets: []postoptions.RetweetRule{{At: "25:00", TimeZone: "UTC", Days: 1}}}}},
		} {
			doc := draftdoc.PlatformVersions{SchemaVersion: 1, Versions: []draftdoc.PlatformVersion{actions}}
			if _, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{PlatformVersions: &doc}); !errors.Is(err, ErrInvalidInput) {
				t.Errorf("%s: %v", name, err)
			}
		}
	})

	t.Run("backups are kept for 30 days, then one a day for a year", func(t *testing.T) {
		draft, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{Body: text("kept"), PlainText: "kept"})
		if err != nil {
			t.Fatal(err)
		}
		backup := func(name string, createdAt time.Time) {
			w.exec(t, `INSERT INTO content_draft_revision (id,"organizationId","contentDraftId",version,title,body,"plainText","createdAt",reason)
				VALUES ($1,$2,$3,1,'',`+"'[]'::jsonb"+`,'',$4,'edit')`, name+"_"+draft.ID, w.org, draft.ID, createdAt)
		}
		day := 24 * time.Hour
		now := time.Now().UTC()
		// Both older revisions must fall on the same UTC calendar day, even
		// when this test runs shortly after midnight.
		oldDay := now.Truncate(day).Add(-40 * day)
		backup("recent_a", now.Add(-2*day))
		backup("recent_b", now.Add(-2*day-time.Hour))
		backup("old_morning", oldDay.Add(2*time.Hour))
		backup("old_evening", oldDay.Add(20*time.Hour))
		backup("ancient", now.Add(-400*day))
		planned := time.Now().Add(day)
		if _, err := repo.PlanContentDraft(ctx, owner, draft.ID, ContentDraftPlanInput{BaseCalendarVersion: draft.CalendarVersion, PlannedFor: &planned, TimeZone: "UTC"}); err != nil {
			t.Fatal(err)
		}
		rows, err := w.db.Client.ContentDraftRevision.Query().Where(contentdraftrevision.ContentDraftID(draft.ID)).All(ctx)
		if err != nil {
			t.Fatal(err)
		}
		kept := map[string]bool{}
		for _, row := range rows {
			kept[strings.TrimSuffix(row.ID, "_"+draft.ID)] = true
		}
		if len(rows) != 4 || !kept["recent_a"] || !kept["recent_b"] || !kept["old_evening"] || kept["old_morning"] || kept["ancient"] {
			t.Fatalf("kept=%v", kept)
		}
	})

	t.Run("an editor cannot erase another member's comment", func(t *testing.T) {
		thread := func(comments ...map[string]any) map[string]any {
			list := []any{}
			for _, comment := range comments {
				list = append(list, comment)
			}
			return map[string]any{"threads": []any{map[string]any{"id": "thread-1", "userId": owner.UserID, "comments": list}}}
		}
		first := map[string]any{"id": "c1", "userId": owner.UserID, "contentRich": []any{}}
		draft, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{Discussions: thread(first)})
		if err != nil {
			t.Fatal(err)
		}
		reply := map[string]any{"id": "c2", "userId": writer.UserID, "contentRich": []any{}}
		both := thread(first, reply)
		if _, err := repo.UpdateContentDraft(ctx, writer, draft.ID, ContentDraftUpdate{BaseVersion: 1, Discussions: &both}); err != nil {
			t.Fatal(err)
		}
		// A third member's stale copy lacks both comments.
		w.addMember(t, "editor", "creator")
		empty := map[string]any{"threads": []any{}}
		saved, err := repo.UpdateContentDraft(ctx, w.actor("editor"), draft.ID, ContentDraftUpdate{BaseVersion: 2, Discussions: &empty})
		if err != nil {
			t.Fatal(err)
		}
		threads, _ := saved.Discussions["threads"].([]any)
		if len(threads) != 1 || len(threads[0].(map[string]any)["comments"].([]any)) != 2 {
			t.Fatalf("other members' comments were erased: %+v", saved.Discussions)
		}
		// The thread's author may delete it.
		none := map[string]any{"threads": []any{}}
		saved, err = repo.UpdateContentDraft(ctx, owner, draft.ID, ContentDraftUpdate{BaseVersion: 3, Discussions: &none})
		if err != nil || len(saved.Discussions["threads"].([]any)) != 0 {
			t.Fatalf("the owner could not delete the thread: %+v err=%v", saved.Discussions, err)
		}
	})

	t.Run("finishers belong to a set", func(t *testing.T) {
		finisher, err := repo.CreateContentDraftFinisher(ctx, owner, defaultSet.ID, ContentDraftFinisherInput{Name: ptr("Follow"),
			Text: ptr("Follow for more"), QuoteFirstPost: ptr(true)})
		if err != nil || !finisher.QuoteFirstPost {
			t.Fatalf("finisher=%+v err=%v", finisher, err)
		}
		if items, err := repo.ListContentDraftFinishers(ctx, owner, brand.ID); err != nil || len(items) != 0 {
			t.Fatalf("brand finishers=%+v err=%v", items, err)
		}
		if _, err := repo.UpdateContentDraftFinisher(ctx, owner, brand.ID, finisher.ID, ContentDraftFinisherInput{Text: ptr("x")}); !errors.Is(err, publishing.ErrNotFound) {
			t.Fatalf("a finisher was edited through another set: %v", err)
		}
		if _, err := repo.ListContentDraftFinishers(ctx, writer, brand.ID); !errors.Is(err, publishing.ErrNotFound) {
			t.Fatalf("another member read a private set's finishers: %v", err)
		}
		if err := repo.DeleteContentDraftFinisher(ctx, owner, defaultSet.ID, finisher.ID); err != nil {
			t.Fatal(err)
		}
	})
}
