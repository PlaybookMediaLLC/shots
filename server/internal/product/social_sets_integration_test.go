package product

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"slices"
	"sync"
	"testing"
	"time"

	entgo "entgo.io/ent"
	entsql "entgo.io/ent/dialect/sql"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/analyticsaccount"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/analyticspost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/analyticssnapshot"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/auditlog"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformsocialobservation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/schema"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/database"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

// RFC 024 acceptance: social sets are addressed by ID, keep their own
// schedules and defaults, stay private until shared, and changing a template,
// a default or a display time zone never rewrites stored work.
func TestSocialSetsPlatform(t *testing.T) {
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
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.SQL.ExecContext(ctx, query, args...); err != nil {
			t.Fatalf("%v\n%s", err, query)
		}
	}
	id := cuid.New()
	org := "org_" + id
	repo := NewConfiguration(db.Client).WithMonthlyMeter(&recordingMonthlyMeter{})
	exec(`INSERT INTO organization (id,name,slug,"createdAt") VALUES ($1,'Acme',$1,now())`, org)
	people := map[string]Actor{}
	for _, person := range []struct{ name, role string }{{"owner", "owner"}, {"admin", "admin"}, {"publisher", "publisher"}} {
		user := person.name + "_" + id
		exec(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,true,now(),now())`, user, user+"@example.test")
		exec(`INSERT INTO session (id,"expiresAt",token,"createdAt","updatedAt","userId","activeOrganizationId") VALUES ($1,now()+interval '1 hour',$1,now(),now(),$2,$3)`,
			"session_"+user, user, org)
		exec(`INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,$4,now())`, "member_"+user, org, user, person.role)
		people[person.name] = Actor{OrganizationID: org, UserID: user, SessionID: "session_" + user, RequestID: "request_" + user}
	}
	owner, admin, publisher := people["owner"], people["admin"], people["publisher"]
	subscribe(t, ctx, repo, org, "pro")
	t.Cleanup(func() {
		for _, statement := range []string{`DELETE FROM scheduled_post WHERE "organizationId"=$1`, `DELETE FROM content_draft_revision WHERE "organizationId"=$1`,
			`DELETE FROM content_draft WHERE "organizationId"=$1`, `DELETE FROM channel_connection WHERE "organizationId"=$1`,
			`DELETE FROM social_set_writing_sample WHERE "organizationId"=$1`, `DELETE FROM social_set WHERE "organizationId"=$1`,
			`DELETE FROM organization WHERE id=$1`} {
			_, _ = db.SQL.ExecContext(ctx, statement, org)
		}
		for _, person := range people {
			_, _ = db.SQL.ExecContext(ctx, `DELETE FROM user_preference WHERE "userId"=$1`, person.UserID)
			_, _ = db.SQL.ExecContext(ctx, `DELETE FROM "user" WHERE id=$1`, person.UserID)
		}
	})

	listed, err := repo.ListSocialSets(ctx, owner)
	if err != nil || len(listed.Items) != 0 {
		t.Fatalf("browsing created an empty set=%+v err=%v", listed, err)
	}
	addCredential := socialCredentialFixture(t, ctx, db.SQL, org)
	connect := func(platform string, setID *string) *publishing.Actor {
		t.Helper()
		actor := publishing.Actor{Organization: org, UserID: owner.UserID, RequestID: owner.RequestID, Type: "USER"}
		external := platform + "-" + cuid.New()
		addCredential(external, platform)
		if _, err := repo.auth.CreateConnection(ctx, actor, publishing.CreateConnectionInput{ExternalAccountID: external,
			Platform: platform, ProviderSettings: map[string]any{}, SecretReference: "SOCIAL_API_KEY", SocialSetID: setID}); err != nil {
			t.Fatal(err)
		}
		return &actor
	}
	connect("x", nil)
	listed, err = repo.ListSocialSets(ctx, owner)
	if err != nil || len(listed.Items) != 1 || listed.Items[0].Name != "Acme" || len(listed.Items[0].Accounts) != 1 {
		t.Fatalf("legacy account not adopted=%+v err=%v", listed, err)
	}
	defaultSet := listed.Items[0]
	connect("linkedin", nil)
	accounts := func(set *SocialSetRecord) map[string]string {
		ids := map[string]string{}
		for _, account := range set.Accounts {
			ids[account.Platform] = account.ID
		}
		return ids
	}
	current, err := repo.GetSocialSet(ctx, owner, defaultSet.ID)
	if err != nil || len(current.Accounts) != 2 || len(current.DefaultPlatforms) != 2 || *current.PrimaryPlatform != "x" {
		t.Fatalf("connected accounts join the default set and its defaults: %+v err=%v", current, err)
	}
	ids := accounts(current)

	t.Run("an account in no set is listed apart from the sets", func(t *testing.T) {
		exec(`UPDATE channel_connection SET "socialSetId"=NULL WHERE id=$1`, ids["linkedin"])
		defer exec(`UPDATE channel_connection SET "socialSetId"=$2 WHERE id=$1`, ids["linkedin"], defaultSet.ID)
		list, err := repo.ListSocialSets(ctx, owner)
		if err != nil || len(list.Unassigned) != 1 || list.Unassigned[0].ID != ids["linkedin"] {
			t.Fatalf("unassigned=%+v err=%v", list, err)
		}
	})

	t.Run("the list counts writing samples and shows a configured assistant without AI", func(t *testing.T) {
		exec(`INSERT INTO social_set_writing_sample (id,"organizationId","socialSetId",text,source) VALUES ($1,$2,$3,'A sample','manual')`, "sample_"+id, org, defaultSet.ID)
		defer exec(`DELETE FROM social_set_writing_sample WHERE id=$1`, "sample_"+id)
		exec(`UPDATE social_set SET "writingAssistant"='{"status":"configured"}' WHERE id=$1`, defaultSet.ID)
		defer exec(`UPDATE social_set SET "writingAssistant"='{}' WHERE id=$1`, defaultSet.ID)
		assistant := func() WritingAssistantRecord {
			t.Helper()
			list, err := repo.ListSocialSets(ctx, owner)
			if err != nil {
				t.Fatal(err)
			}
			for _, set := range list.Items {
				if set.ID == defaultSet.ID {
					return set.WritingAssistant
				}
			}
			t.Fatal("the default set is not listed")
			return WritingAssistantRecord{}
		}
		if got := assistant(); got.SampleCount != 1 || got.Status != "configured" {
			t.Fatalf("assistant=%+v", got)
		}
		exec(`INSERT INTO workspace_settings ("organizationId","aiAgentEnabled","updatedAt") VALUES ($1,false,now())
			ON CONFLICT ("organizationId") DO UPDATE SET "aiAgentEnabled"=false`, org)
		defer exec(`UPDATE workspace_settings SET "aiAgentEnabled"=true WHERE "organizationId"=$1`, org)
		if got := assistant(); got.Status != "attention" {
			t.Fatalf("AI turned off: %+v", got)
		}
	})

	t.Run("a second account of a platform is refused in the same set", func(t *testing.T) {
		actor := publishing.Actor{Organization: org, UserID: owner.UserID, RequestID: owner.RequestID, Type: "USER"}
		_, err := repo.auth.CreateConnection(ctx, actor, publishing.CreateConnectionInput{ExternalAccountID: "x-" + cuid.New(),
			Platform: "x", ProviderSettings: map[string]any{}, SecretReference: "SOCIAL_API_KEY", SocialSetID: &defaultSet.ID})
		if !errors.Is(err, publishing.ErrSocialSetSlotTaken) {
			t.Fatalf("second X account: %v", err)
		}
	})

	t.Run("two sets with the same name stay separate", func(t *testing.T) {
		first, err := repo.CreateSocialSet(ctx, owner, SocialSetInput{Name: "Acme"})
		if err != nil {
			t.Fatal(err)
		}
		second, err := repo.CreateSocialSet(ctx, owner, SocialSetInput{Name: "Acme", Color: "#10B981"})
		if err != nil || second.ID == first.ID || second.Color != "#10b981" {
			t.Fatalf("second=%+v err=%v", second, err)
		}
		renamed, err := repo.UpdateSocialSet(ctx, owner, second.ID, SocialSetUpdate{BaseVersion: second.Version, Name: ptr("Acme EU")})
		if err != nil || renamed.Name != "Acme EU" {
			t.Fatalf("rename=%+v err=%v", renamed, err)
		}
		untouched, err := repo.GetSocialSet(ctx, owner, first.ID)
		if err != nil || untouched.Name != "Acme" {
			t.Fatalf("renaming one renamed the other: %+v err=%v", untouched, err)
		}
		if _, err := repo.UpdateSocialSet(ctx, owner, second.ID, SocialSetUpdate{BaseVersion: second.Version, Name: ptr("Stale")}); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("a stale version was saved: %v", err)
		}
	})

	t.Run("weekdays at two times are ten slots", func(t *testing.T) {
		slots := []schema.QueueSlot{}
		for day := 1; day <= 5; day++ {
			slots = append(slots, schema.QueueSlot{Weekday: day, Time: "12:00"}, schema.QueueSlot{Weekday: day, Time: "17:00"})
		}
		current, err := repo.GetSocialSet(ctx, owner, defaultSet.ID)
		if err != nil {
			t.Fatal(err)
		}
		saved, err := repo.UpdateSocialSet(ctx, owner, defaultSet.ID, SocialSetUpdate{BaseVersion: current.Version, PostingSlots: &slots})
		if err != nil || saved.WeeklySlotCount != 10 {
			t.Fatalf("count=%d err=%v", saved.WeeklySlotCount, err)
		}
	})

	var firstDraft *ContentDraftRecord
	t.Run("a new draft copies the set's ordered defaults, and later defaults leave it alone", func(t *testing.T) {
		current, _ := repo.GetSocialSet(ctx, owner, defaultSet.ID)
		ordered := []string{"linkedin", "x"}
		if _, err := repo.UpdateSocialSet(ctx, owner, defaultSet.ID, SocialSetUpdate{BaseVersion: current.Version,
			DefaultPlatforms: &ordered, PrimaryPlatform: ptr("linkedin")}); err != nil {
			t.Fatal(err)
		}
		firstDraft, err = repo.CreateContentDraft(ctx, owner, ContentDraftInput{Title: "Defaults", SocialSetID: defaultSet.ID})
		if err != nil {
			t.Fatal(err)
		}
		if len(firstDraft.ChannelConnectionIDs) != 2 || firstDraft.ChannelConnectionIDs[0] != ids["linkedin"] ||
			firstDraft.ChannelConnectionIDs[1] != ids["x"] || *firstDraft.PrimaryPlatform != "linkedin" {
			t.Fatalf("draft defaults=%+v", firstDraft)
		}
		current, _ = repo.GetSocialSet(ctx, owner, defaultSet.ID)
		onlyX := []string{"x"}
		if _, err := repo.UpdateSocialSet(ctx, owner, defaultSet.ID, SocialSetUpdate{BaseVersion: current.Version, DefaultPlatforms: &onlyX}); err != nil {
			t.Fatal(err)
		}
		reread, err := repo.GetContentDraft(ctx, owner, firstDraft.ID)
		if err != nil || len(reread.ChannelConnectionIDs) != 2 || *reread.PrimaryPlatform != "linkedin" {
			t.Fatalf("changing defaults rewrote a draft: %+v err=%v", reread, err)
		}
		next, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{Title: "After", SocialSetID: defaultSet.ID})
		if err != nil || len(next.ChannelConnectionIDs) != 1 || next.ChannelConnectionIDs[0] != ids["x"] || *next.PrimaryPlatform != "x" {
			t.Fatalf("new draft after defaults changed=%+v err=%v", next, err)
		}
		empty := []string{"tiktok"}
		current, _ = repo.GetSocialSet(ctx, owner, defaultSet.ID)
		if _, err := repo.UpdateSocialSet(ctx, owner, defaultSet.ID, SocialSetUpdate{BaseVersion: current.Version, DefaultPlatforms: &empty}); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("an unconnected default was saved: %v", err)
		}
	})

	t.Run("the display time zone is not the set's time zone", func(t *testing.T) {
		if _, err := repo.UpdateUserPreferences(ctx, owner, UserPreferencesUpdate{TimeZone: ptr("Asia/Tokyo")}); err != nil {
			t.Fatal(err)
		}
		set, err := repo.GetSocialSet(ctx, owner, defaultSet.ID)
		if err != nil || set.TimeZone != "UTC" {
			t.Fatalf("set zone=%s err=%v", set.TimeZone, err)
		}
		if _, err := repo.UpdateUserPreferences(ctx, owner, UserPreferencesUpdate{TimeZone: ptr("Mars/Olympus")}); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("an unknown zone was saved: %v", err)
		}
		if _, err := repo.UpdateUserPreferences(ctx, owner, UserPreferencesUpdate{BaseVersion: ptr(1), ShowScrollbars: ptr(false)}); err != nil {
			t.Fatal(err)
		}
		if _, err := repo.UpdateUserPreferences(ctx, owner, UserPreferencesUpdate{BaseVersion: ptr(1), Theme: ptr("light")}); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("a stale preferences save was accepted: %v", err)
		}
		saved, err := repo.GetUserPreferences(ctx, owner)
		if err != nil || saved.Theme != "dark" || *saved.TimeZone != "Asia/Tokyo" {
			t.Fatalf("preferences=%+v err=%v", saved, err)
		}
		other, err := repo.GetUserPreferences(ctx, admin)
		if err != nil || other.TimeZone != nil {
			t.Fatalf("one person's zone changed another's: %+v", other)
		}
	})

	var queued ContentDraftPost
	t.Run("a queued natural time is stored, replayed and kept when the template changes", func(t *testing.T) {
		current, _ := repo.GetSocialSet(ctx, owner, defaultSet.ID)
		daily := []schema.QueueSlot{}
		for day := 0; day < 7; day++ {
			daily = append(daily, schema.QueueSlot{Weekday: day, Time: "07:30"})
		}
		if _, err := repo.UpdateSocialSet(ctx, owner, defaultSet.ID, SocialSetUpdate{BaseVersion: current.Version,
			PostingSlots: &daily, NaturalPostingTimes: ptr(true)}); err != nil {
			t.Fatal(err)
		}
		draft, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{Title: "Natural", SocialSetID: defaultSet.ID})
		if err != nil || !draft.NaturalPostingTime {
			t.Fatalf("draft did not copy natural times: %+v err=%v", draft, err)
		}
		input := ScheduleContentDraftInput{Queue: true, Version: draft.Version,
			Targets: []ContentDraftScheduleTarget{{Caption: "Natural", ChannelConnectionID: ids["x"]}}}
		result, err := repo.ScheduleContentDraft(ctx, owner, draft.ID, input)
		if err != nil || len(result.Posts) != 1 {
			t.Fatalf("schedule=%+v err=%v", result, err)
		}
		queued = result.Posts[0]
		offset := *queued.NaturalOffsetSeconds
		if offset < -240 || offset > 240 || *queued.ScheduleMode != "queue" || queued.SlotAt.UTC().Hour() != 7 ||
			!queued.ScheduledFor.Equal(queued.SlotAt.Add(time.Duration(offset)*time.Second)) {
			t.Fatalf("placement=%+v", queued)
		}
		replay, err := repo.ScheduleContentDraft(ctx, owner, draft.ID, input)
		if err != nil || replay.Created || !replay.Posts[0].ScheduledFor.Equal(queued.ScheduledFor) {
			t.Fatalf("a retry moved the post: %+v err=%v", replay, err)
		}
		current, _ = repo.GetSocialSet(ctx, owner, defaultSet.ID)
		evening := []schema.QueueSlot{{Weekday: 1, Time: "21:00"}}
		if _, err := repo.UpdateSocialSet(ctx, owner, defaultSet.ID, SocialSetUpdate{BaseVersion: current.Version,
			PostingSlots: &evening, TimeZone: ptr("Europe/Paris")}); err != nil {
			t.Fatal(err)
		}
		post, err := db.Client.ScheduledPost.Get(ctx, queued.ID)
		if err != nil || !post.ScheduledFor.Equal(queued.ScheduledFor) {
			t.Fatalf("changing the template moved a scheduled post: %v err=%v", post, err)
		}
		current, _ = repo.GetSocialSet(ctx, owner, defaultSet.ID)
		if _, err := repo.UpdateSocialSet(ctx, owner, defaultSet.ID, SocialSetUpdate{BaseVersion: current.Version,
			PostingSlots: &daily, TimeZone: ptr("UTC")}); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("concurrent queueing takes distinct slots", func(t *testing.T) {
		drafts := make([]*ContentDraftRecord, 4)
		for index := range drafts {
			if drafts[index], err = repo.CreateContentDraft(ctx, owner, ContentDraftInput{Title: "Race", SocialSetID: defaultSet.ID}); err != nil {
				t.Fatal(err)
			}
		}
		slots := make([]time.Time, len(drafts))
		var wait sync.WaitGroup
		failures := make(chan error, len(drafts))
		for index, draft := range drafts {
			wait.Add(1)
			go func() {
				defer wait.Done()
				result, err := repo.ScheduleContentDraft(ctx, owner, draft.ID, ScheduleContentDraftInput{Queue: true, Version: draft.Version, ConfirmDuplicate: true,
					Targets: []ContentDraftScheduleTarget{{Caption: "Race", ChannelConnectionID: ids["x"]}}})
				if err != nil {
					failures <- err
					return
				}
				slots[index] = *result.Posts[0].SlotAt
			}()
		}
		wait.Wait()
		close(failures)
		for err := range failures {
			t.Fatal(err)
		}
		seen := map[int64]bool{queued.SlotAt.Unix(): true}
		for _, slot := range slots {
			if seen[slot.Unix()] {
				t.Fatalf("two drafts took the slot %v: %v", slot, slots)
			}
			seen[slot.Unix()] = true
		}
	})

	var private *SocialSetRecord
	t.Run("a private set is its owner's until they share it", func(t *testing.T) {
		private, err = repo.CreateSocialSet(ctx, admin, SocialSetInput{Name: "Personal", Visibility: "PRIVATE"})
		if err != nil {
			t.Fatal(err)
		}
		draft, err := repo.CreateContentDraft(ctx, admin, ContentDraftInput{Title: "Private draft", SocialSetID: private.ID})
		if err != nil {
			t.Fatal(err)
		}
		mine, _ := repo.ListSocialSets(ctx, owner)
		for _, set := range mine.Items {
			if set.ID == private.ID {
				t.Fatal("the workspace owner sees another person's private set")
			}
		}
		// Its accounts are listed for its owner alone, never for an API key.
		connect("threads", &private.ID)
		all, err := db.Client.ChannelConnection.Query().Where(channelconnection.OrganizationID(org)).All(ctx)
		if err != nil {
			t.Fatal(err)
		}
		exec(`UPDATE channel_connection SET "socialSetId"=NULL WHERE id=$1`, ids["linkedin"])
		defer exec(`UPDATE channel_connection SET "socialSetId"=$2 WHERE id=$1`, ids["linkedin"], defaultSet.ID)
		all, err = db.Client.ChannelConnection.Query().Where(channelconnection.OrganizationID(org)).All(ctx)
		if err != nil {
			t.Fatal(err)
		}
		// listed reports whether actor sees the private, shared (x) and set-less (linkedin) accounts.
		listed := func(actor Actor) [3]bool {
			t.Helper()
			visible, err := repo.VisibleConnections(ctx, actor, all)
			if err != nil {
				t.Fatal(err)
			}
			var seen [3]bool
			for _, connection := range visible {
				seen[0] = seen[0] || (connection.SocialSetID != nil && *connection.SocialSetID == private.ID)
				seen[1] = seen[1] || connection.ID == ids["x"]
				seen[2] = seen[2] || connection.ID == ids["linkedin"]
			}
			return seen
		}
		key := owner
		key.Kind, key.UserID = "api_key", ""
		if listed(admin) != [3]bool{true, true, true} || listed(owner) != [3]bool{false, true, true} || listed(key) != [3]bool{false, true, true} {
			t.Fatalf("admin=%v owner=%v key=%v", listed(admin), listed(owner), listed(key))
		}
		if _, err := repo.GetSocialSet(ctx, owner, private.ID); !errors.Is(err, publishing.ErrNotFound) {
			t.Fatalf("private set read by another member: %v", err)
		}
		if _, err := repo.GetContentDraft(ctx, owner, draft.ID); !errors.Is(err, publishing.ErrNotFound) {
			t.Fatalf("private draft read by another member: %v", err)
		}
		page, _ := repo.ListContentDrafts(ctx, owner, ContentDraftListQuery{})
		for _, item := range page.Items {
			if item.ID == draft.ID {
				t.Fatal("a private draft appears in another member's list")
			}
		}
		if _, err := repo.ShareSocialSet(ctx, owner, private.ID); !errors.Is(err, publishing.ErrNotFound) {
			t.Fatalf("someone other than the owner shared a private set: %v", err)
		}
		shared, err := repo.ShareSocialSet(ctx, admin, private.ID)
		if err != nil || shared.Visibility != "WORKSPACE" {
			t.Fatalf("share=%+v err=%v", shared, err)
		}
		if _, err := repo.GetContentDraft(ctx, owner, draft.ID); err != nil {
			t.Fatalf("a shared set's draft is still hidden: %v", err)
		}
	})

	t.Run("the Channels page counts queued posts and removes an account in no brand", func(t *testing.T) {
		connections, err := db.Client.ChannelConnection.Query().Where(channelconnection.OrganizationID(org)).All(ctx)
		if err != nil {
			t.Fatal(err)
		}
		states, err := repo.ChannelAccountStates(ctx, org, connections)
		if err != nil || states[ids["x"]].QueuedPosts < 5 || states[ids["x"]].Health == "" || states[ids["linkedin"]].QueuedPosts != 0 {
			t.Fatalf("states=%+v err=%v", states, err)
		}
		// The brand already has an X account, so a second one joins no brand.
		connect("x", nil)
		spare, err := db.Client.ChannelConnection.Query().Where(channelconnection.OrganizationID(org),
			channelconnection.SocialSetIDIsNil(), channelconnection.StatusEQ(channelconnection.StatusACTIVE)).Only(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := repo.RemoveChannelAccount(ctx, publisher, spare.ID); !errors.Is(err, publishing.ErrForbidden) {
			t.Fatalf("a publisher removed an account: %v", err)
		}
		removal, err := repo.RemoveChannelAccount(ctx, admin, spare.ID)
		if err != nil || len(removal.CancelledPostIDs) != 0 {
			t.Fatalf("removal=%+v err=%v", removal, err)
		}
		if removed, _ := db.Client.ChannelConnection.Get(ctx, spare.ID); removed.Status != channelconnection.StatusDISABLED {
			t.Fatalf("the removed account is %s", removed.Status)
		}
		if _, err := repo.RemoveChannelAccount(ctx, admin, spare.ID); !errors.Is(err, publishing.ErrNotFound) {
			t.Fatalf("a removed account was removed again: %v", err)
		}
	})

	t.Run("a removed account cancels its queue and cannot publish", func(t *testing.T) {
		removal, err := repo.RemoveSocialSetAccount(ctx, owner, defaultSet.ID, ids["x"])
		if err != nil || len(removal.CancelledPostIDs) < 5 {
			t.Fatalf("removal=%+v err=%v", removal, err)
		}
		post, _ := db.Client.ScheduledPost.Get(ctx, queued.ID)
		connection, _ := db.Client.ChannelConnection.Get(ctx, ids["x"])
		if post.Status != scheduledpost.StatusCANCELLED || connection.Status != channelconnection.StatusDISABLED {
			t.Fatalf("post=%s connection=%s", post.Status, connection.Status)
		}
		draft, _ := repo.CreateContentDraft(ctx, owner, ContentDraftInput{Title: "Removed", SocialSetID: defaultSet.ID, ChannelConnectionIDs: []string{ids["x"]}})
		if _, err := repo.ScheduleContentDraft(ctx, owner, draft.ID, ScheduleContentDraftInput{ScheduledFor: time.Now().Add(time.Hour), Version: draft.Version,
			Targets: []ContentDraftScheduleTarget{{Caption: "Removed", ChannelConnectionID: ids["x"]}}}); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("a removed account was scheduled to: %v", err)
		}
	})

	t.Run("a provider callback revokes an account without waiting for a post", func(t *testing.T) {
		connection, err := db.Client.ChannelConnection.Get(ctx, ids["linkedin"])
		if err != nil {
			t.Fatal(err)
		}
		// Posts the previous removal cancelled give this account a queue.
		queued, err := db.Client.ScheduledPost.Query().Where(scheduledpost.ChannelConnectionID(ids["x"]),
			scheduledpost.StatusEQ(scheduledpost.StatusCANCELLED)).Limit(3).All(ctx)
		if err != nil || len(queued) != 3 {
			t.Fatalf("queued=%d err=%v", len(queued), err)
		}
		for _, post := range queued {
			exec(`UPDATE scheduled_post SET "channelConnectionId"=$1, status='SCHEDULED' WHERE id=$2`, connection.ID, post.ID)
		}
		// A member's removal refuses this; the provider's request cannot wait for it.
		publishingPost := queued[0].ID
		if err := db.Client.ScheduledPost.UpdateOneID(publishingPost).SetStatus(scheduledpost.StatusPROCESSING).Exec(ctx); err != nil {
			t.Fatal(err)
		}
		connect("x", nil)
		other, err := db.Client.ChannelConnection.Query().Where(channelconnection.OrganizationID(org),
			channelconnection.StatusEQ(channelconnection.StatusACTIVE), channelconnection.IDNEQ(connection.ID)).First(ctx)
		if err != nil {
			t.Fatal(err)
		}
		seedAnalytics := func(id string) {
			t.Helper()
			if exists, _ := db.Client.AnalyticsAccount.Query().Where(analyticsaccount.ID(id)).Exist(ctx); !exists {
				db.Client.AnalyticsAccount.Create().SetID(id).SetOrganizationID(org).ExecX(ctx)
			}
			db.Client.AnalyticsSnapshot.Create().SetID(cuid.New()).SetOrganizationID(org).SetConnectionID(id).SetSubjectID(id).
				SetKind(analyticssnapshot.KindAccount).SetObservedAt(time.Now()).SetCounters(map[string]float64{"followers": 1}).
				SetPayloadHash(cuid.New()).ExecX(ctx)
			db.Client.AnalyticsPost.Create().SetID(cuid.New()).SetOrganizationID(org).SetConnectionID(id).SetRemoteID(cuid.New()).
				SetPublishedAt(time.Now()).ExecX(ctx)
			db.Client.PlatformSocialObservation.Create().SetID(cuid.New()).SetOrganizationID(org).SetSocialSetID(defaultSet.ID).
				SetConnectionID(id).SetSubjectID(id).SetKind(platformsocialobservation.KindAccount).SetPlatform("linkedin").
				SetDay(time.Now()).SetStatus(platformsocialobservation.StatusAvailable).ExecX(ctx)
		}
		seedAnalytics(connection.ID)
		seedAnalytics(other.ID)
		analyticsRows := func(id string) int {
			t.Helper()
			accounts := db.Client.AnalyticsAccount.Query().Where(analyticsaccount.ID(id)).CountX(ctx)
			snapshots := db.Client.AnalyticsSnapshot.Query().Where(analyticssnapshot.ConnectionID(id)).CountX(ctx)
			posts := db.Client.AnalyticsPost.Query().Where(analyticspost.ConnectionID(id)).CountX(ctx)
			observations := db.Client.PlatformSocialObservation.Query().Where(platformsocialobservation.ConnectionID(id)).CountX(ctx)
			return accounts + snapshots + posts + observations
		}
		cancelled, err := repo.RevokeProviderConnections(ctx, []string{connection.ExternalAccountID}, "CONFIRM-CODE")
		if err != nil || len(cancelled) != len(queued)-1 || slices.Contains(cancelled, publishingPost) {
			t.Fatalf("cancelled=%v of %d err=%v", cancelled, len(queued), err)
		}
		revoked, err := db.Client.ChannelConnection.Get(ctx, connection.ID)
		if err != nil || revoked.Status != channelconnection.StatusREVOKED || revoked.DisplayName != nil ||
			revoked.Handle != nil || revoked.AvatarURL != nil {
			t.Fatalf("revoked=%+v err=%v", revoked, err)
		}
		if left, kept := analyticsRows(connection.ID), analyticsRows(other.ID); left != 0 || kept != 4 {
			t.Fatalf("analytics left on the revoked account=%d, on the other account=%d", left, kept)
		}
		if post, _ := db.Client.ScheduledPost.Get(ctx, publishingPost); post.Status != scheduledpost.StatusPROCESSING {
			t.Fatalf("the publishing post became %s", post.Status)
		}
		if untouched, _ := db.Client.ChannelConnection.Get(ctx, other.ID); untouched.Status != channelconnection.StatusACTIVE {
			t.Fatalf("another account became %s", untouched.Status)
		}
		if connection.SocialSetID != nil {
			set, err := db.Client.SocialSet.Get(ctx, *connection.SocialSetID)
			if err != nil || slices.Contains(set.DefaultPlatforms, connection.Platform) {
				t.Fatalf("defaults=%v err=%v", set.DefaultPlatforms, err)
			}
		}
		logged, err := db.Client.AuditLog.Query().Where(auditlog.Action("product.channel_account_revoked"), auditlog.EntityID(connection.ID)).Only(ctx)
		if err != nil || logged.Metadata["confirmationCode"] != "CONFIRM-CODE" || logged.Metadata["actorSource"] != "callback" {
			t.Fatalf("audit=%+v err=%v", logged, err)
		}
		if again, err := repo.RevokeProviderConnections(ctx, []string{connection.ExternalAccountID}, "SECOND"); err != nil || len(again) != 0 {
			t.Fatalf("a retry did more work: %v err=%v", again, err)
		}
		if err := db.Client.ScheduledPost.UpdateOneID(publishingPost).SetStatus(scheduledpost.StatusCANCELLED).Exec(ctx); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("deleting a set needs authority and keeps the last shared set", func(t *testing.T) {
		set, err := repo.CreateSocialSet(ctx, owner, SocialSetInput{Name: "Delete me"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := repo.DeleteSocialSet(ctx, publisher, set.ID, "Delete me"); !errors.Is(err, publishing.ErrForbidden) {
			t.Fatalf("a publisher deleted a shared set: %v", err)
		}
		if _, err := repo.DeleteSocialSet(ctx, owner, set.ID, "Wrong"); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("a wrong confirmation deleted a set: %v", err)
		}
		if _, err := repo.DeleteSocialSet(ctx, owner, set.ID, "Delete me"); err != nil {
			t.Fatal(err)
		}
		if _, err := repo.GetSocialSet(ctx, owner, set.ID); !errors.Is(err, publishing.ErrNotFound) {
			t.Fatalf("a deleted set is still readable: %v", err)
		}
	})

	t.Run("experiments are enforced by the backend", func(t *testing.T) {
		draft, _ := repo.CreateContentDraft(ctx, owner, ContentDraftInput{Title: "Tags", SocialSetID: defaultSet.ID})
		launch, err := repo.CreateContentDraftTag(ctx, owner, defaultSet.ID, ContentDraftTagInput{Name: ptr("Launch")})
		if err != nil {
			t.Fatal(err)
		}
		add := ContentDraftPropertiesInput{AddTagIDs: []string{launch.ID}}
		if _, err := repo.UpdateContentDraftProperties(ctx, owner, draft.ID, add); !errors.Is(err, publishing.ErrForbidden) {
			t.Fatalf("tags without opting in: %v", err)
		}
		if _, err := repo.UpdateUserPreferences(ctx, owner, UserPreferencesUpdate{Experiments: map[string]bool{ExperimentDraftTags: true}}); err != nil {
			t.Fatal(err)
		}
		tagged, err := repo.UpdateContentDraftProperties(ctx, owner, draft.ID, add)
		if err != nil || len(tagged.TagIDs) != 1 || tagged.TagIDs[0] != launch.ID {
			t.Fatalf("tags=%v err=%v", tagged, err)
		}
		if _, err := repo.SetWorkspaceExperiment(ctx, owner, ExperimentDraftTags, true); err != nil {
			t.Fatal(err)
		}
		remove := ContentDraftPropertiesInput{RemoveTagIDs: []string{launch.ID}}
		if _, err := repo.UpdateContentDraftProperties(ctx, owner, draft.ID, remove); !errors.Is(err, publishing.ErrForbidden) {
			t.Fatalf("a workspace-disabled experiment still worked: %v", err)
		}
		if _, err := repo.UpdateUserPreferences(ctx, owner, UserPreferencesUpdate{Experiments: map[string]bool{"realistic-previews": false}}); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("a promoted experiment was changed: %v", err)
		}
		states, err := repo.ListExperiments(ctx, owner)
		if err != nil || len(states) != len(experimentRegistry) {
			t.Fatalf("experiments=%v err=%v", states, err)
		}
		// The web's contract reads every list as an array, never null.
		if raw, _ := json.Marshal(states); bytes.Contains(raw, []byte("null")) {
			t.Fatalf("the experiment list carries a null: %s", raw)
		}
		for _, state := range states {
			if state.ID == ExperimentDraftTags && (!state.DisabledByAdmin || state.Enabled) {
				t.Fatalf("a workspace-disabled experiment reads as on: %+v", state)
			}
		}
	})

	t.Run("an owner cannot delete their account while they own the workspace", func(t *testing.T) {
		status, err := repo.GetAccountDeletion(ctx, owner)
		if err != nil || len(status.Blockers) != 1 || status.Blockers[0].WorkspaceID != org {
			t.Fatalf("status=%+v err=%v", status, err)
		}
		var blocked *AccountDeletionBlockedError
		if _, err := repo.RequestAccountDeletion(ctx, owner, owner.UserID+"@example.test"); !errors.As(err, &blocked) {
			t.Fatalf("blocked request=%v", err)
		}
		requested, err := repo.RequestAccountDeletion(ctx, publisher, publisher.UserID+"@example.test")
		if err != nil || requested.Request == nil || requested.Request.Status != "REQUESTED" {
			t.Fatalf("request=%+v err=%v", requested, err)
		}
		cancelled, err := repo.CancelAccountDeletion(ctx, publisher)
		if err != nil || cancelled.Request != nil {
			t.Fatalf("cancel=%+v err=%v", cancelled, err)
		}
	})

	t.Run("only owners and admins see a departed member's private set", func(t *testing.T) {
		departed, err := repo.CreateSocialSet(ctx, admin, SocialSetInput{Name: "Departed", Visibility: "PRIVATE"})
		if err != nil {
			t.Fatal(err)
		}
		exec(`DELETE FROM member WHERE id=$1`, "member_"+admin.UserID)
		if _, err := repo.ListSocialSets(ctx, admin); !errors.Is(err, publishing.ErrForbidden) {
			t.Fatalf("a former member listed the sets: %v", err)
		}
		orphaned := func(actor Actor) bool {
			t.Helper()
			list, err := repo.ListSocialSets(ctx, actor)
			if err != nil {
				t.Fatal(err)
			}
			return slices.ContainsFunc(list.Orphaned, func(set OrphanedSocialSet) bool { return set.ID == departed.ID })
		}
		if !orphaned(owner) {
			t.Fatal("the owner cannot see a departed member's private set")
		}
		if orphaned(publisher) {
			t.Fatal("a publisher sees orphaned sets")
		}
	})
}

func TestMoveConnectedAccountBetweenProfiles(t *testing.T) {
	w := newTestWorkspace(t)
	ctx, repo, owner := w.ctx, w.repo, w.owner
	subscribe(t, ctx, repo, w.org, "business")
	source, err := repo.CreateSocialSet(ctx, owner, SocialSetInput{Name: "Source"})
	if err != nil {
		t.Fatal(err)
	}
	destination, err := repo.CreateSocialSet(ctx, owner, SocialSetInput{Name: "Destination"})
	if err != nil {
		t.Fatal(err)
	}
	account := "move_" + w.id
	w.exec(t, `INSERT INTO channel_connection(id,"organizationId",provider,"externalAccountId","secretReference","createdByUserId","updatedAt",platform,"socialSetId",status)
 VALUES($1,$2,'social',$1,'test-only',$3,now(),'linkedin',$4,'ACTIVE')`, account, w.org, owner.UserID, source.ID)
	w.exec(t, `UPDATE social_set SET "defaultPlatforms"='["linkedin"]', "primaryPlatform"='linkedin' WHERE id=$1`, source.ID)
	draft, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{Title: "Stays here", PlainText: "Post", SocialSetID: source.ID})
	if err != nil {
		t.Fatal(err)
	}
	post := "post_" + w.id
	w.exec(t, `INSERT INTO scheduled_post(id,"organizationId","contentDraftId","channelConnectionId","socialSetId","scheduledFor",status,caption,"idempotencyKey","updatedAt")
 VALUES($1,$2,$3,$4,$5,now(),'PUBLISHED','Post',$1,now())`, post, w.org, draft.ID, account, source.ID)
	move := func(actor Actor, to string) error {
		_, err := repo.MoveSocialSetAccount(ctx, actor, source.ID, account, to)
		return err
	}
	w.addMember(t, "publisher", "publisher")
	if err := move(w.actor("publisher"), destination.ID); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("publisher=%v", err)
	}
	if err := move(owner, "missing-profile"); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("foreign profile=%v", err)
	}
	other := newTestWorkspace(t)
	subscribe(t, ctx, other.repo, other.org, "business")
	foreign, err := other.repo.CreateSocialSet(ctx, other.owner, SocialSetInput{Name: "Another workspace"})
	if err != nil {
		t.Fatal(err)
	}
	if err := move(owner, foreign.ID); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("cross-tenant move=%v", err)
	}
	occupied := "occupied_" + w.id
	w.exec(t, `INSERT INTO channel_connection(id,"organizationId",provider,"externalAccountId","secretReference","createdByUserId","updatedAt",platform,"socialSetId",status)
 VALUES($1,$2,'social',$1,'test-only',$3,now(),'linkedin',$4,'ACTIVE')`, occupied, w.org, owner.UserID, destination.ID)
	if err := move(owner, destination.ID); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("occupied platform=%v", err)
	}
	w.exec(t, `DELETE FROM channel_connection WHERE id=$1`, occupied)
	private, err := repo.CreateSocialSet(ctx, owner, SocialSetInput{Name: "Private", Visibility: "PRIVATE"})
	if err != nil {
		t.Fatal(err)
	}
	if err := move(owner, private.ID); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("visibility widened=%v", err)
	}
	for _, revocation := range []struct {
		name, statement string
	}{
		{"demotion", `UPDATE member SET role='viewer' WHERE "userId"=$1`},
		{"ban", `UPDATE "user" SET banned=true WHERE id=$1`},
	} {
		t.Run("a concurrent "+revocation.name+" fences the move", func(t *testing.T) {
			name := "move-admin-" + revocation.name
			w.addMember(t, name, "admin")
			admin := w.actor(name)
			ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
			defer cancel()
			tx, err := w.db.SQL.BeginTx(ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback()
			var blocker int
			if err := tx.QueryRowContext(ctx, `SELECT pg_backend_pid()`).Scan(&blocker); err != nil {
				t.Fatal(err)
			}
			if _, err := tx.ExecContext(ctx, revocation.statement, admin.UserID); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() {
				_, err := repo.MoveSocialSetAccount(ctx, admin, source.ID, account, destination.ID)
				done <- err
			}()
			for {
				var blocked bool
				if err := w.db.SQL.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, blocker).Scan(&blocked); err != nil {
					t.Fatal(err)
				}
				if blocked {
					break
				}
				select {
				case err := <-done:
					t.Fatalf("move did not wait for authority: %v", err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				case <-time.After(5 * time.Millisecond):
				}
			}
			if err := tx.Commit(); err != nil {
				t.Fatal(err)
			}
			if err := <-done; !errors.Is(err, publishing.ErrForbidden) {
				t.Fatalf("revoked admin moved the account: %v", err)
			}
			connection := w.db.Client.ChannelConnection.GetX(ctx, account)
			unchanged, err := repo.GetSocialSet(ctx, owner, source.ID)
			if err != nil || *connection.SocialSetID != source.ID || !slices.Contains(unchanged.DefaultPlatforms, "linkedin") {
				t.Fatalf("denied move changed defaults: %+v %v", unchanged, err)
			}
		})
	}
	for _, status := range []string{"DRAFT", "SCHEDULED", "PROCESSING", "UNKNOWN_DELIVERY"} {
		w.exec(t, `UPDATE scheduled_post SET status=$2 WHERE id=$1`, post, status)
		if err := move(owner, destination.ID); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("%s=%v", status, err)
		}
	}
	w.exec(t, `UPDATE scheduled_post SET status='PUBLISHED' WHERE id=$1`, post)
	run := "automation_" + w.id
	w.exec(t, `INSERT INTO post_automation_run(id,"organizationId","scheduledPostId",key,kind,status,"dueAt","updatedAt") VALUES($1,$2,$3,'first-comment','first_comment','pending',now(),now())`, run, w.org, post)
	if err := move(owner, destination.ID); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("pending followup=%v", err)
	}
	w.exec(t, `UPDATE post_automation_run SET status='failed',"failureCode"='UNKNOWN_DELIVERY' WHERE id=$1`, run)
	if err := move(owner, destination.ID); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("uncertain followup=%v", err)
	}
	w.exec(t, `UPDATE post_automation_run SET "failureCode"='http_403' WHERE id=$1`, run)
	// A normal refusal is settled. The existing credentials and all old history survive the move.
	// Pause a real move while it holds the connection lock. A late automation
	// plan must wait, then observe the new profile instead of creating old work.
	moveLocked, releaseMove := make(chan int, 1), make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(releaseMove) })
	w.db.Client.ChannelConnection.Use(func(next entgo.Mutator) entgo.Mutator {
		return entgo.MutateFunc(func(ctx context.Context, mutation entgo.Mutation) (entgo.Value, error) {
			value, err := next.Mutate(ctx, mutation)
			m := mutation.(*ent.ChannelConnectionMutation)
			if setID, changed := m.SocialSetID(); err == nil && changed && setID == destination.ID {
				var pid int
				if err := m.Client().PlatformQuery(ctx, `SELECT pg_backend_pid()`, nil, func(row entsql.ColumnScanner) error { return row.Scan(&pid) }); err != nil {
					return nil, err
				}
				moveLocked <- pid
				select {
				case <-releaseMove:
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			}
			return value, err
		})
	})
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	type moveResult struct {
		saved *SocialSetRecord
		err   error
	}
	moved := make(chan moveResult, 1)
	go func() {
		saved, err := repo.MoveSocialSetAccount(ctx, owner, source.ID, account, destination.ID)
		moved <- moveResult{saved, err}
	}()
	var blocker int
	select {
	case blocker = <-moveLocked:
	case result := <-moved:
		t.Fatalf("move did not reach connection update: %v", result.err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	store := publishing.NewRepository(w.db.Client)
	planned := make(chan error, 1)
	go func() {
		statuses, err := store.PlanAutomations(ctx, w.org, post, []publishing.AutomationReceipt{{DueAt: time.Now(), Key: "late-plan", Kind: "first_comment"}})
		if err == nil && len(statuses) != 0 {
			err = errors.New("a moved account acquired old follow-ups")
		}
		planned <- err
	}()
	for {
		var blocked bool
		if err := w.db.SQL.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, blocker).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		select {
		case err := <-planned:
			t.Fatalf("planning did not wait for move: %v", err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(5 * time.Millisecond):
		}
	}
	releaseOnce.Do(func() { close(releaseMove) })
	result := <-moved
	saved, err := result.saved, result.err
	if err != nil || len(saved.Accounts) != 1 || saved.Accounts[0].ID != account || !slices.Contains(saved.DefaultPlatforms, "linkedin") {
		t.Fatalf("moved=%+v err=%v", saved, err)
	}
	if err := <-planned; err != nil {
		t.Fatal(err)
	}
	if status, _, err := store.AutomationReceipt(ctx, post, "late-plan"); err != nil || status != "skipped" {
		t.Fatalf("late plan=%s %v", status, err)
	}
	if err := move(owner, destination.ID); err != nil {
		t.Fatalf("replay=%v", err)
	}
	connection, err := w.db.Client.ChannelConnection.Get(ctx, account)
	if err != nil || connection.Status != channelconnection.StatusACTIVE || connection.SecretReference != "test-only" || *connection.SocialSetID != destination.ID {
		t.Fatalf("connection=%+v err=%v", connection, err)
	}
	old, err := repo.GetSocialSet(ctx, owner, source.ID)
	if err != nil || len(old.Accounts) != 0 || len(old.DefaultPlatforms) != 0 || old.PrimaryPlatform != nil {
		t.Fatalf("source=%+v err=%v", old, err)
	}
	stored, err := repo.GetContentDraft(ctx, owner, draft.ID)
	if err != nil || stored.SocialSetID == nil || *stored.SocialSetID != source.ID {
		t.Fatalf("draft=%+v err=%v", stored, err)
	}
	published, err := w.db.Client.ScheduledPost.Get(ctx, post)
	if err != nil || *published.SocialSetID != source.ID || published.Status != scheduledpost.StatusPUBLISHED {
		t.Fatalf("post=%+v err=%v", published, err)
	}
	audits, err := w.db.Client.AuditLog.Query().Where(auditlog.OrganizationID(w.org), auditlog.Action("product.social_set_account_moved")).Count(ctx)
	if err != nil || audits != 1 {
		t.Fatalf("audit count=%d err=%v", audits, err)
	}
}
