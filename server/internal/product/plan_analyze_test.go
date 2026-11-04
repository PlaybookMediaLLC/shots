package product

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/analyticsaccount"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/analyticspost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/analyticssnapshot"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/auditlog"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

type analyticsFixture struct {
	metrics    postoptions.Metrics
	err        error
	posts      []ImportedAnalyticsPost
	postErrors map[string]error
	postCalls  map[string]int
}

func (f *analyticsFixture) AnalyticsCapabilities(platform string) AnalyticsCapabilities {
	return AnalyticsCapabilities{Account: platform == "x", Posts: platform == "x" || platform == "linkedin", Import: platform == "x"}
}
func (f *analyticsFixture) AccountObservations(context.Context, string, string, string, string) ([]AccountObservation, error) {
	return []AccountObservation{{At: time.Now(), Counters: map[string]float64{"followers": 42}}}, f.err
}
func (f *analyticsFixture) ImportAnalyticsPosts(context.Context, string, string, string, string, time.Time) ([]ImportedAnalyticsPost, error) {
	return f.posts, f.err
}
func (f *analyticsFixture) PostMetrics(_ context.Context, _, _, _, _, remoteID string) (postoptions.Metrics, error) {
	if f.postCalls != nil {
		f.postCalls[remoteID]++
	}
	if err := f.postErrors[remoteID]; err != nil {
		return nil, err
	}
	return f.metrics, f.err
}

// These are real PostgreSQL transactions with deterministic provider observations, never live network evidence.
func TestPlanAnalyzeDatabase(t *testing.T) {
	w := newTestWorkspace(t)
	ctx, repo, owner := w.ctx, w.repo, w.owner
	subscribe(t, ctx, repo, w.org, "pro")
	fixture := &analyticsFixture{metrics: postoptions.Metrics{"likes": 0, "impressions": 0}}
	repo.WithAnalytics(fixture).WithPostMetrics(fixture).WithMonthlyMeter(&recordingMonthlyMeter{})
	for name, role := range map[string]string{"reader": "viewer", "editor": "creator", "publisher": "publisher", "admin": "admin"} {
		w.addMember(t, name, role)
	}
	set, err := repo.CreateSocialSet(ctx, owner, SocialSetInput{Name: "Same name", TimeZone: "America/New_York"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := repo.CreateSocialSet(ctx, owner, SocialSetInput{Name: "Same name", TimeZone: "Asia/Tokyo"})
	if err != nil {
		t.Fatal(err)
	}
	credential := socialCredentialFixture(t, ctx, w.db.SQL, w.org)
	connect := func(platform, setID string) *ent.ChannelConnection {
		t.Helper()
		credential(platform+w.id, platform)
		c, e := repo.auth.CreateConnection(ctx, owner.auditActor(), publishing.CreateConnectionInput{ExternalAccountID: platform + w.id, Platform: platform, ProviderSettings: map[string]any{}, SecretReference: "SOCIAL_API_KEY", SocialSetID: &setID})
		if e != nil {
			t.Fatal(e)
		}
		row, e := repo.client.ChannelConnection.Get(ctx, c.ID)
		if e != nil {
			t.Fatal(e)
		}
		return row
	}
	x, li := connect("x", set.ID), connect("linkedin", second.ID)
	draft := func(text string) *ContentDraftRecord {
		t.Helper()
		d, e := repo.CreateContentDraft(ctx, owner, ContentDraftInput{SocialSetID: set.ID, PlainText: text, Title: text})
		if e != nil {
			t.Fatal(e)
		}
		return d
	}
	at := time.Now().UTC().Add(48 * time.Hour).Truncate(time.Minute)
	plan := func(d *ContentDraftRecord, when time.Time) *ContentDraftRecord {
		t.Helper()
		p, e := repo.PlanContentDraft(ctx, owner, d.ID, ContentDraftPlanInput{BaseCalendarVersion: d.CalendarVersion, PlannedFor: &when, TimeZone: "America/New_York"})
		if e != nil {
			t.Fatal(e)
		}
		return p
	}
	place := func(d *ContentDraftRecord, when *time.Time) CalendarPlacement {
		return CalendarPlacement{DraftID: d.ID, Version: d.Version, CalendarVersion: d.CalendarVersion, At: when, TimeZone: "America/New_York"}
	}

	t.Run("P24 P29 P32 creation retry returns one draft and rejects changed intent", func(t *testing.T) {
		input := ContentDraftInput{RequestKey: cuid.New(), SocialSetID: set.ID, PlainText: "retry-safe creation"}
		first, e := repo.CreateContentDraft(ctx, owner, input)
		if e != nil {
			t.Fatal(e)
		}
		second, e := repo.CreateContentDraft(ctx, owner, input)
		if e != nil || first.ID != second.ID {
			t.Fatalf("duplicate creation: %+v %v", second, e)
		}
		input.PlainText = "different intent"
		if _, e = repo.CreateContentDraft(ctx, owner, input); !errors.Is(e, publishing.ErrConflict) {
			t.Fatalf("reused key accepted: %v", e)
		}
	})
	t.Run("P35 P36 deleting from stale details cannot remove intervening edits", func(t *testing.T) {
		d := draft("keep newer work")
		changed := "newer title"
		saved, e := repo.UpdateContentDraft(ctx, owner, d.ID, ContentDraftUpdate{BaseVersion: d.Version, Title: &changed})
		if e != nil {
			t.Fatal(e)
		}
		if e = repo.DeleteContentDraftAtVersion(ctx, owner, d.ID, d.Version, d.CalendarVersion); !errors.Is(e, publishing.ErrConflict) {
			t.Fatalf("stale delete=%v", e)
		}
		if e = repo.DeleteContentDraftAtVersion(ctx, owner, d.ID, saved.Version, saved.CalendarVersion); e != nil {
			t.Fatal(e)
		}
	})

	t.Run("P32 disconnected destinations cannot acquire a new plan", func(t *testing.T) {
		d := draft("disconnected")
		if _, e := repo.client.ChannelConnection.UpdateOneID(x.ID).SetStatus("DISABLED").Save(ctx); e != nil {
			t.Fatal(e)
		}
		defer repo.client.ChannelConnection.UpdateOneID(x.ID).SetStatus("ACTIVE").Exec(ctx)
		if _, e := repo.PlanContentDraft(ctx, owner, d.ID, ContentDraftPlanInput{BaseCalendarVersion: d.CalendarVersion, PlannedFor: &at, TimeZone: "UTC"}); !errors.Is(e, publishing.ErrConflict) {
			t.Fatalf("disconnected plan=%v", e)
		}
	})

	t.Run("P33 planned placement never creates a publishing job and remove-date preserves content", func(t *testing.T) {
		d := plan(draft("never publish from a plan"), at)
		if n, e := repo.client.ScheduledPost.Query().Where(scheduledpost.ContentDraftID(d.ID)).Count(ctx); e != nil || n != 0 {
			t.Fatalf("jobs=%d err=%v", n, e)
		}
		moved, e := repo.MutateCalendar(ctx, owner, CalendarCommand{Key: cuid.New(), Action: "remove_date", Items: []CalendarPlacement{place(d, nil)}})
		if e != nil || moved.Drafts[0].PlannedFor != nil || moved.Drafts[0].PlainText != d.PlainText || moved.Drafts[0].Version != d.Version {
			t.Fatalf("result=%+v err=%v", moved, e)
		}
	})
	t.Run("P34 moving replay swapping and Undo are durable and conditional", func(t *testing.T) {
		a, b := plan(draft("a"), at), plan(draft("b"), at.Add(time.Hour))
		command := CalendarCommand{Key: cuid.New(), Action: "swap", Items: []CalendarPlacement{place(a, b.PlannedFor), place(b, a.PlannedFor)}}
		result, e := repo.MutateCalendar(ctx, owner, command)
		if e != nil {
			t.Fatal(e)
		}
		replay, e := repo.MutateCalendar(ctx, owner, command)
		if e != nil || replay.Drafts[0].CalendarVersion != result.Drafts[0].CalendarVersion {
			t.Fatalf("replay=%+v %v", replay, e)
		}
		events, e := repo.client.AuditLog.Query().Where(auditlog.OrganizationID(w.org), auditlog.Action("product.content_draft_planned"), auditlog.EntityIDIn(a.ID, b.ID)).All(ctx)
		if e != nil {
			t.Fatal(e)
		}
		mutations := 0
		for _, event := range events {
			if event.Metadata["key"] == command.Key {
				mutations++
				if event.Metadata["action"] != "swap" || event.Outcome != auditlog.OutcomeSUCCEEDED || event.ActorUserID == nil || *event.ActorUserID != owner.UserID {
					t.Fatalf("incorrect mutation audit: %+v", event)
				}
			}
		}
		if mutations != 2 {
			t.Fatalf("swap replay must retain exactly one audit per draft, got %d", mutations)
		}
		undo, e := repo.MutateCalendar(ctx, owner, CalendarCommand{Key: cuid.New(), Action: "swap", Items: result.Undo})
		if e != nil || !undo.Drafts[0].PlannedFor.Equal(at) {
			t.Fatalf("undo=%+v %v", undo, e)
		}
		if _, e = repo.MutateCalendar(ctx, owner, CalendarCommand{Key: cuid.New(), Action: "swap", Items: result.Undo}); !errors.Is(e, publishing.ErrConflict) {
			t.Fatalf("stale undo=%v", e)
		}
		command.Items[0].At = &at
		if _, e = repo.MutateCalendar(ctx, owner, command); !errors.Is(e, publishing.ErrConflict) {
			t.Fatalf("key reuse=%v", e)
		}
	})
	t.Run("P36 legacy date edits require the current calendar revision", func(t *testing.T) {
		d := draft("legacy date edit")
		planned := plan(d, at)
		next := at.Add(time.Hour).Format(time.RFC3339)
		if _, e := repo.UpdateContentDraft(ctx, owner, d.ID, ContentDraftUpdate{BaseVersion: d.Version, BaseCalendarVersion: d.CalendarVersion, PlannedFor: &next}); !errors.Is(e, publishing.ErrConflict) {
			t.Fatalf("stale legacy date=%v", e)
		}
		if _, e := repo.UpdateContentDraft(ctx, owner, d.ID, ContentDraftUpdate{BaseVersion: d.Version, BaseCalendarVersion: planned.CalendarVersion, PlannedFor: &next}); e != nil {
			t.Fatal(e)
		}
	})
	t.Run("P36 concurrent moves admit exactly one winner", func(t *testing.T) {
		d := plan(draft("race"), at)
		var wg sync.WaitGroup
		outcomes := make(chan error, 2)
		for i := 0; i < 2; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				when := at.Add(time.Duration(i+1) * time.Hour)
				_, e := repo.MutateCalendar(ctx, owner, CalendarCommand{Key: cuid.New(), Action: "move", Items: []CalendarPlacement{place(d, &when)}})
				outcomes <- e
			}(i)
		}
		wg.Wait()
		close(outcomes)
		success, conflicts := 0, 0
		for e := range outcomes {
			if e == nil {
				success++
			} else if errors.Is(e, publishing.ErrConflict) {
				conflicts++
			} else {
				t.Fatal(e)
			}
		}
		if success != 1 || conflicts != 1 {
			t.Fatalf("success=%d conflicts=%d", success, conflicts)
		}
	})
	t.Run("P36 legacy plan requests initialize once and cannot overwrite existing plans", func(t *testing.T) {
		d := draft("legacy initial plan")
		legacy := ContentDraftPlanInput{PlannedFor: &at, TimeZone: "UTC"}
		planned, e := repo.PlanContentDraft(ctx, owner, d.ID, legacy)
		if e != nil || planned.CalendarVersion != 2 {
			t.Fatalf("legacy initial placement=%+v %v", planned, e)
		}
		if _, e := repo.PlanContentDraft(ctx, owner, d.ID, ContentDraftPlanInput{}); !errors.Is(e, publishing.ErrConflict) {
			t.Fatalf("unversioned clear overwrote the plan: %v", e)
		}
		// A migrated pre-existing plan starts at revision 1, but is not empty.
		if e := repo.client.ContentDraft.UpdateOneID(d.ID).SetCalendarVersion(1).Exec(ctx); e != nil {
			t.Fatal(e)
		}
		next := at.Add(time.Hour)
		legacy.PlannedFor = &next
		if _, e := repo.PlanContentDraft(ctx, owner, d.ID, legacy); !errors.Is(e, publishing.ErrConflict) {
			t.Fatalf("legacy request overwrote a migrated plan: %v", e)
		}
		stored, e := repo.client.ContentDraft.Get(ctx, d.ID)
		if e != nil || stored.PlannedFor == nil || !stored.PlannedFor.Equal(at) {
			t.Fatalf("original placement was not preserved: %+v %v", stored, e)
		}
		legacy.BaseCalendarVersion = 1
		if _, e := repo.PlanContentDraft(ctx, owner, d.ID, legacy); e != nil {
			t.Fatalf("explicit current revision rejected: %v", e)
		}
	})
	t.Run("P35 editor can plan reader cannot and editor cannot commit publication", func(t *testing.T) {
		d := draft("permissions")
		if _, e := repo.PlanContentDraft(ctx, w.actor("reader"), d.ID, ContentDraftPlanInput{BaseCalendarVersion: d.CalendarVersion, PlannedFor: &at, TimeZone: "UTC"}); !errors.Is(e, publishing.ErrForbidden) {
			t.Fatalf("reader plan=%v", e)
		}
		p, e := repo.PlanContentDraft(ctx, w.actor("editor"), d.ID, ContentDraftPlanInput{BaseCalendarVersion: d.CalendarVersion, PlannedFor: &at, TimeZone: "UTC"})
		if e != nil {
			t.Fatal(e)
		}
		_, e = repo.ScheduleContentDraft(ctx, w.actor("editor"), p.ID, ScheduleContentDraftInput{Version: p.Version, ScheduledFor: at, Targets: []ContentDraftScheduleTarget{{ChannelConnectionID: x.ID, Caption: p.PlainText}}})
		if !errors.Is(e, publishing.ErrForbidden) {
			t.Fatalf("editor schedule=%v", e)
		}
	})
	t.Run("P33 P37 schedule retry and unschedule retain one commitment and the plan", func(t *testing.T) {
		d := plan(draft("schedule once"), at)
		input := ScheduleContentDraftInput{Version: d.Version, ScheduledFor: at, TimeZone: "America/New_York", Targets: []ContentDraftScheduleTarget{{ChannelConnectionID: x.ID, Caption: d.PlainText}}}
		result, e := repo.ScheduleContentDraft(ctx, owner, d.ID, input)
		if e != nil {
			t.Fatal(e)
		}
		replay, e := repo.ScheduleContentDraft(ctx, owner, d.ID, input)
		if e != nil || replay.Created || replay.Posts[0].ID != result.Posts[0].ID {
			t.Fatalf("replay=%+v %v", replay, e)
		}
		unsafeStatus := "draft"
		if _, e := repo.UpdateContentDraft(ctx, owner, d.ID, ContentDraftUpdate{BaseVersion: result.Draft.Version, Status: &unsafeStatus}); !errors.Is(e, publishing.ErrConflict) {
			t.Fatalf("scheduled draft relabelled=%v", e)
		}
		item := place(&result.Draft, &at)
		item.PostID = result.Posts[0].ID
		result2, e := repo.MutateCalendar(ctx, owner, CalendarCommand{Key: cuid.New(), Action: "unschedule", Items: []CalendarPlacement{item}})
		if e != nil {
			t.Fatal(e)
		}
		if result2.Drafts[0].Status != "draft" || !result2.Drafts[0].PlannedFor.Equal(at) {
			t.Fatalf("unscheduled=%+v", result2)
		}
		if n, e := repo.client.ScheduledPost.Query().Where(scheduledpost.ContentDraftID(d.ID), scheduledpost.StatusEQ(scheduledpost.StatusSCHEDULED)).Count(ctx); e != nil || n != 0 {
			t.Fatalf("live jobs=%d %v", n, e)
		}
		// Teammates told the post was scheduled are told it was cancelled.
		if n, e := repo.client.AuditLog.Query().Where(auditlog.Action("post.cancelled"), auditlog.EntityID(result.Posts[0].ID)).Count(ctx); e != nil || n != 1 {
			t.Fatalf("cancel records=%d %v", n, e)
		}
	})

	t.Run("P33 archive restoration preserves publication commitments without replanning", func(t *testing.T) {
		for _, item := range []struct {
			name      string
			status    scheduledpost.Status
			remote    string
			committed bool
		}{
			{name: "planned"},
			{name: "scheduled", status: scheduledpost.StatusSCHEDULED, committed: true},
			{name: "processing", status: scheduledpost.StatusPROCESSING, committed: true},
			{name: "unknown", status: scheduledpost.StatusUNKNOWN_DELIVERY, committed: true},
			{name: "published", status: scheduledpost.StatusPUBLISHED, remote: "archived-publication", committed: true},
			{name: "partial", status: scheduledpost.StatusFAILED, remote: "partial-publication", committed: true},
			{name: "failed", status: scheduledpost.StatusFAILED},
			{name: "cancelled", status: scheduledpost.StatusCANCELLED},
		} {
			t.Run(item.name, func(t *testing.T) {
				d := plan(draft("restore "+item.name), at)
				postID := ""
				if item.status != "" {
					result, e := repo.ScheduleContentDraft(ctx, owner, d.ID, ScheduleContentDraftInput{Version: d.Version, BaseCalendarVersion: d.CalendarVersion, ScheduledFor: at, Targets: []ContentDraftScheduleTarget{{ChannelConnectionID: x.ID, Caption: d.PlainText}}})
					if e != nil {
						t.Fatal(e)
					}
					d = &result.Draft
					postID = result.Posts[0].ID
					// Explicit provider-outcome fixture; restoring must not change it.
					update := repo.client.ScheduledPost.UpdateOneID(postID).SetStatus(item.status)
					if item.remote != "" {
						update.SetRemotePostID(item.remote)
					}
					if _, e = update.Save(ctx); e != nil {
						t.Fatal(e)
					}
				}
				archived, restore := "archived", "draft"
				saved, e := repo.UpdateContentDraft(ctx, owner, d.ID, ContentDraftUpdate{BaseVersion: d.Version, Status: &archived})
				if e != nil {
					t.Fatal(e)
				}
				if item.committed {
					clearPlan := ""
					if _, e = repo.UpdateContentDraft(ctx, owner, d.ID, ContentDraftUpdate{BaseVersion: saved.Version, BaseCalendarVersion: saved.CalendarVersion, Status: &restore, PlannedFor: &clearPlan}); !errors.Is(e, publishing.ErrConflict) {
						t.Fatalf("restoration bypassed the planning guard: %v", e)
					}
				}
				restored, e := repo.UpdateContentDraft(ctx, w.actor("editor"), d.ID, ContentDraftUpdate{BaseVersion: saved.Version, Status: &restore})
				if e != nil {
					t.Fatal(e)
				}
				want := "draft"
				if item.committed {
					want = "scheduled"
				}
				if restored.Status != want || restored.CalendarVersion != d.CalendarVersion || !sameJSON(restored.PlannedFor, d.PlannedFor) || !sameString(restored.PlanTimeZone, d.PlanTimeZone) {
					t.Fatalf("restoration changed publication placement: %+v", restored)
				}
				if _, e = repo.UpdateContentDraft(ctx, owner, d.ID, ContentDraftUpdate{BaseVersion: saved.Version, Status: &restore}); !errors.Is(e, publishing.ErrConflict) {
					t.Fatalf("stale restoration accepted: %v", e)
				}
				posts, e := repo.client.ScheduledPost.Query().Where(scheduledpost.ContentDraftID(d.ID)).All(ctx)
				if e != nil {
					t.Fatal(e)
				}
				if postID == "" {
					if len(posts) != 0 {
						t.Fatal("restoration created a publishing job")
					}
				} else if len(posts) != 1 || posts[0].ID != postID || posts[0].Status != item.status || optionalText(posts[0].RemotePostID) != item.remote || !posts[0].ScheduledFor.Equal(at) {
					t.Fatalf("restoration changed a provider commitment: %+v", posts)
				}
				if item.committed {
					if _, e = repo.PlanContentDraft(ctx, owner, d.ID, ContentDraftPlanInput{BaseCalendarVersion: restored.CalendarVersion, PlannedFor: &at, TimeZone: "UTC"}); !errors.Is(e, publishing.ErrConflict) {
						t.Fatalf("restored publication could be replanned: %v", e)
					}
				}
			})
		}
	})
	t.Run("P27 P29 source duplication is retry-safe and preserves the original", func(t *testing.T) {
		d := draft("historical source")
		key := cuid.New()
		first, e := repo.DuplicateContentDraftWithKey(ctx, owner, d.ID, key)
		if e != nil {
			t.Fatal(e)
		}
		replay, e := repo.DuplicateContentDraftWithKey(ctx, owner, d.ID, key)
		if e != nil || replay.Draft.ID != first.Draft.ID {
			t.Fatalf("reuse=%+v %v", replay, e)
		}
		original, e := repo.GetContentDraft(ctx, owner, d.ID)
		if e != nil || original.PlannedFor != nil || original.Version != d.Version {
			t.Fatalf("original=%+v %v", original, e)
		}
		if _, e = repo.DuplicateContentDraftWithKey(ctx, owner, draft("different").ID, key); !errors.Is(e, publishing.ErrConflict) {
			t.Fatalf("changed reuse=%v", e)
		}
	})
	t.Run("calendar move and undo preserve a commitment's natural offset", func(t *testing.T) {
		d := draft("natural calendar movement")
		queued, err := repo.ScheduleContentDraft(ctx, owner, d.ID, ScheduleContentDraftInput{Version: d.Version, ScheduledFor: at, Targets: []ContentDraftScheduleTarget{{ChannelConnectionID: x.ID, Caption: d.PlainText}}})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.db.SQL.ExecContext(ctx, `UPDATE scheduled_post SET "slotAt"=$2,"naturalOffsetSeconds"=45,"scheduledFor"=$3 WHERE id=$1`, queued.Posts[0].ID, at, at.Add(45*time.Second)); err != nil {
			t.Fatal(err)
		}
		next := at.Add(2 * time.Hour)
		placement := place(&queued.Draft, &next)
		placement.PostID = queued.Posts[0].ID
		moved, err := repo.MutateCalendar(ctx, owner, CalendarCommand{Key: cuid.New(), Action: "move", Items: []CalendarPlacement{placement}})
		if err != nil {
			t.Fatal(err)
		}
		if !moved.Posts[0].ScheduledFor.Equal(next.Add(45*time.Second)) || !moved.Undo[0].At.Equal(at) {
			t.Fatalf("offset lost or duplicated: %+v", moved)
		}
		undone, err := repo.MutateCalendar(ctx, owner, CalendarCommand{Key: cuid.New(), Action: "move", Items: moved.Undo})
		if err != nil {
			t.Fatal(err)
		}
		if !undone.Posts[0].ScheduledFor.Equal(at.Add(45 * time.Second)) {
			t.Fatalf("undo changed offset: %+v", undone.Posts[0])
		}
	})
	t.Run("P34 P35 scheduled swap and undo replace jobs and respect publisher authority", func(t *testing.T) {
		schedule := func(text string, when time.Time) *ScheduleContentDraftResult {
			d := plan(draft(text), when)
			result, e := repo.ScheduleContentDraft(ctx, owner, d.ID, ScheduleContentDraftInput{Version: d.Version, BaseCalendarVersion: d.CalendarVersion, ScheduledFor: when, TimeZone: "America/New_York", Targets: []ContentDraftScheduleTarget{{ChannelConnectionID: x.ID, Caption: text}}})
			if e != nil {
				t.Fatal(e)
			}
			return result
		}
		a, b := schedule("scheduled-a", at), schedule("scheduled-b", at.Add(time.Hour))
		first, second := place(&a.Draft, &b.Posts[0].ScheduledFor), place(&b.Draft, &a.Posts[0].ScheduledFor)
		first.PostID, second.PostID = a.Posts[0].ID, b.Posts[0].ID
		command := CalendarCommand{Key: cuid.New(), Action: "swap", Items: []CalendarPlacement{first, second}}
		if _, e := repo.MutateCalendar(ctx, w.actor("editor"), command); !errors.Is(e, publishing.ErrForbidden) {
			t.Fatalf("editor swap=%v", e)
		}
		swapped, e := repo.MutateCalendar(ctx, w.actor("publisher"), command)
		if e != nil {
			t.Fatal(e)
		}
		if len(swapped.Posts) != 2 || swapped.Posts[0].ID == a.Posts[0].ID || !swapped.Posts[0].ScheduledFor.Equal(b.Posts[0].ScheduledFor) {
			t.Fatalf("swap=%+v", swapped)
		}
		undone, e := repo.MutateCalendar(ctx, w.actor("publisher"), CalendarCommand{Key: cuid.New(), Action: "swap", Items: swapped.Undo})
		if e != nil {
			t.Fatal(e)
		}
		for _, d := range undone.Drafts {
			n, e := repo.client.ScheduledPost.Query().Where(scheduledpost.ContentDraftID(d.ID), scheduledpost.StatusEQ(scheduledpost.StatusSCHEDULED)).Count(ctx)
			if e != nil || n != 1 {
				t.Fatalf("active jobs=%d %v", n, e)
			}
		}
	})
	t.Run("A19 reconciliation skips receiptless backlogs before applying its batch limit", func(t *testing.T) {
		d := draft("reconciliation backlog")
		old := time.Now().UTC().Add(-48 * time.Hour).Truncate(time.Millisecond)
		builders := make([]*ent.ScheduledPostCreate, 0, 201)
		ids := make([]string, 201)
		for i := range ids {
			ids[i] = cuid.New()
			builders = append(builders, repo.client.ScheduledPost.Create().SetID(ids[i]).SetOrganizationID(w.org).SetContentDraftID(d.ID).SetChannelConnectionID(x.ID).SetStatus(scheduledpost.StatusPUBLISHED).SetScheduledFor(old).SetCaption("reconciliation fixture").SetIdempotencyKey(ids[i]).SetRemotePostID(ids[i]).SetUpdatedAt(old.Add(time.Duration(i)*time.Second)))
		}
		if _, e := repo.client.ScheduledPost.CreateBulk(builders...).Save(ctx); e != nil {
			t.Fatal(e)
		}
		completed := old.Add(time.Hour)
		attempt := func(index, number int, remote string, at *time.Time) {
			t.Helper()
			if _, e := repo.client.PublicationAttempt.Create().SetID(cuid.New()).SetOrganizationID(w.org).SetScheduledPostID(ids[index]).SetAttemptNumber(number).SetStartedAt(old).SetNillableCompletedAt(at).SetProviderPostID(remote).Save(ctx); e != nil {
				t.Fatal(e)
			}
		}
		// Neither a different provider ID nor an unfinished attempt supplies a date.
		attempt(0, 1, "different-receipt", &completed)
		attempt(1, 1, ids[1], nil)
		attempt(200, 1, ids[200], &completed)
		for i := 0; i < 2; i++ {
			if e := repo.importCanonicalAnalyticsPosts(ctx, x); e != nil {
				t.Fatal(e)
			}
		}
		rows, e := repo.client.AnalyticsPost.Query().Where(analyticspost.ConnectionID(x.ID), analyticspost.RemoteIDIn(ids...)).All(ctx)
		if e != nil || len(rows) != 1 || rows[0].RemoteID != ids[200] || !rows[0].PublishedAt.Equal(completed) {
			t.Fatalf("receiptless backlog blocked confirmed publication or invented dates: %+v %v", rows, e)
		}
		// A skipped publication becomes eligible as soon as its matching dated receipt arrives.
		attempt(0, 2, ids[0], &completed)
		if e := repo.importCanonicalAnalyticsPosts(ctx, x); e != nil {
			t.Fatal(e)
		}
		if count, e := repo.client.AnalyticsPost.Query().Where(analyticspost.ConnectionID(x.ID), analyticspost.RemoteIDIn(ids...)).Count(ctx); e != nil || count != 2 {
			t.Fatalf("late receipt was never reconciled: %d %v", count, e)
		}
	})
	t.Run("P33 P37 confirmed receipt completes a scheduled plan once and becomes analytics history", func(t *testing.T) {
		d := plan(draft("confirmed fixture publication"), at)
		scheduled, e := repo.ScheduleContentDraft(ctx, owner, d.ID, ScheduleContentDraftInput{Version: d.Version, PublishNow: true, Targets: []ContentDraftScheduleTarget{{ChannelConnectionID: x.ID, Caption: d.PlainText}}})
		if e != nil {
			t.Fatal(e)
		}
		queue := publishing.NewRepository(repo.client)
		post := scheduled.Scheduled[0]
		claimed, e := queue.Claim(ctx, post.ID, "fixture-workflow", time.Now().Add(time.Second))
		if e != nil || !claimed {
			t.Fatalf("claim=%v %v", claimed, e)
		}
		attempt, e := queue.StartAttempt(ctx, post, "fixture-workflow", 1)
		if e != nil {
			t.Fatal(e)
		}
		for i := 0; i < 2; i++ {
			if e = queue.Complete(ctx, post, attempt, "confirmed-fixture-id", "fixture-workflow"); e != nil {
				t.Fatal(e)
			}
		}
		if e = repo.importCanonicalAnalyticsPosts(ctx, x); e != nil {
			t.Fatal(e)
		}
		row, e := repo.client.AnalyticsPost.Query().Where(analyticspost.ConnectionID(x.ID), analyticspost.RemoteID("confirmed-fixture-id")).Only(ctx)
		if e != nil || row.ScheduledPostID == nil || *row.ScheduledPostID != post.ID || row.PublishedAt.Equal(at) {
			t.Fatalf("analytics attribution=%+v %v", row, e)
		}
		current, e := repo.ListContentDraftPosts(ctx, owner, d.ID)
		if e != nil || len(current) != 1 || current[0].Status != "PUBLISHED" || current[0].URL == nil || *current[0].URL != "https://x.com/i/status/confirmed-fixture-id" {
			t.Fatalf("publication=%+v %v", current, e)
		}
	})

	q := AnalyticsQuery{From: "2026-03-01", To: "2026-03-31", TimeZone: "America/New_York", Grouping: "daily", Sort: "impressions", Limit: 1}
	observed := time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC)
	addPost := func(id string, at time.Time, counters map[string]float64) *ent.AnalyticsPost {
		t.Helper()
		p, e := repo.importAnalyticsPost(ctx, x, ImportedAnalyticsPost{ID: id, Text: "=formula, \"quoted\"", URL: "https://x.com/i/status/" + id, At: at}, nil)
		if e != nil {
			t.Fatal(e)
		}
		if e = repo.RecordAnalyticsSnapshot(ctx, w.org, x.ID, "post", id, observed, observed, counters, 60); e != nil {
			t.Fatal(e)
		}
		return p
	}
	root := addPost("root", time.Date(2026, 3, 8, 6, 30, 0, 0, time.UTC), map[string]float64{"impressions": 0, "likes": 0})
	reply := addPost("reply", time.Date(2026, 3, 8, 7, 30, 0, 0, time.UTC), map[string]float64{"impressions": 100, "likes": 7, "replies": 2})
	if _, e := repo.client.AnalyticsPost.UpdateOneID(reply.ID).SetIsReply(true).SetThreadPosition(1).SetThreadRootID(root.RemoteID).Save(ctx); e != nil {
		t.Fatal(e)
	}
	for i, count := range []float64{100, 90, 110} {
		when := time.Date(2026, 3, 8+i, 12, 0, 0, 0, time.UTC)
		if e := repo.RecordAnalyticsSnapshot(ctx, w.org, x.ID, "account", x.ID, when, when, map[string]float64{"followers": count}, 0); e != nil {
			t.Fatal(e)
		}
	}
	t.Run("A01 A03 account isolation follows installed capabilities including LinkedIn", func(t *testing.T) {
		r, e := repo.GetAnalytics(ctx, owner, li.ID, q)
		if e != nil || r.AccountID != li.ID || !r.Capabilities.Posts || r.TotalPosts != 0 {
			t.Fatalf("linkedin=%+v %v", r, e)
		}
		outsider := owner
		outsider.OrganizationID = "another-workspace"
		if _, e = repo.GetAnalytics(ctx, outsider, x.ID, q); e == nil {
			t.Fatal("cross-workspace analytics allowed")
		}
	})
	t.Run("A04 A08 A16 A17 zeros missing counters and zero baselines remain distinct", func(t *testing.T) {
		r, e := repo.GetAnalytics(ctx, owner, x.ID, q)
		if e != nil {
			t.Fatal(e)
		}
		if r.Metrics["impressions"].Value == nil || *r.Metrics["impressions"].Value != 100 || r.Metrics["profileClicks"].Value != nil || r.Metrics["followers"].Change != nil {
			t.Fatalf("metrics=%+v", r.Metrics)
		}
		q2 := q
		q2.Sort = "latest"
		q2.Limit = 100
		r, e = repo.GetAnalytics(ctx, owner, x.ID, q2)
		if e != nil {
			t.Fatal(e)
		}
		for _, row := range r.Posts {
			if row.RemoteID == "root" {
				if row.Metrics["likes"] != 0 {
					t.Fatal("zero changed")
				}
				if _, ok := row.Metrics["engagementRate"]; ok {
					t.Fatal("zero-denominator rate invented")
				}
			}
		}
	})
	t.Run("A14 A15 A19 A20 follower grouping retains the last count and explicit missing intervals", func(t *testing.T) {
		for _, group := range []string{"daily", "weekly", "monthly"} {
			query := q
			query.Grouping = group
			r, e := repo.GetAnalytics(ctx, owner, x.ID, query)
			if e != nil {
				t.Fatal(e)
			}
			m := r.Metrics["followers"]
			if m.Value == nil || *m.Value != 110 {
				t.Fatalf("%s total=%v", group, m.Value)
			}
			if group == "monthly" && *m.Points[0].Value != 110 {
				t.Fatal("cumulative totals were summed")
			}
			if group == "daily" && m.Points[0].Value != nil {
				t.Fatal("missing day filled")
			}
		}
	})
	t.Run("A21 A22 A23 A24 A25 hourly cells preserve DST publication hours sample sizes and exact post IDs", func(t *testing.T) {
		r, e := repo.GetAnalytics(ctx, owner, x.ID, q)
		if e != nil {
			t.Fatal(e)
		}
		if len(r.Hourly) != 168 {
			t.Fatalf("cells=%d", len(r.Hourly))
		}
		first, skipped, later := r.Hourly[1], r.Hourly[2], r.Hourly[3]
		if first.Samples != 1 || first.Average == nil || *first.Average != 0 || first.PostIDs[0] != root.ID || skipped.Samples != 0 || skipped.Average != nil || later.Samples != 1 || later.PostIDs[0] != reply.ID {
			t.Fatalf("hours=%+v %+v %+v", first, skipped, later)
		}
	})
	t.Run("A29 A30 A31 A32 A33 stable pagination isolates exact rows and survives ingestion", func(t *testing.T) {
		r, e := repo.GetAnalytics(ctx, owner, x.ID, q)
		if e != nil {
			t.Fatal(e)
		}
		if len(r.Posts) != 1 || r.Posts[0].RemoteID != "reply" || r.Posts[0].ThreadPosition != 1 || r.NextCursor == nil {
			t.Fatalf("first=%+v", r)
		}
		addPost("arrived-later", time.Date(2026, 3, 9, 6, 30, 0, 0, time.UTC), map[string]float64{"impressions": 999})
		q2 := q
		q2.Cursor = *r.NextCursor
		q2.AsOf = &r.AsOf
		r2, e := repo.GetAnalytics(ctx, owner, x.ID, q2)
		if e != nil || r2.TotalPosts != 2 || len(r2.Posts) != 1 || r2.Posts[0].RemoteID != "root" {
			t.Fatalf("second=%+v %v", r2, e)
		}
		q2 = q
		q2.Scope = "replies"
		r2, e = repo.GetAnalytics(ctx, owner, x.ID, q2)
		if e != nil || r2.TotalPosts != 1 || *r2.Metrics["publishedPosts"].Value != 1 {
			t.Fatalf("reply scope=%+v %v", r2, e)
		}
	})
	t.Run("A26 A27 A36 A37 explicit settings are versioned authorized opt-in and revoked", func(t *testing.T) {
		r, e := repo.GetAnalytics(ctx, owner, x.ID, q)
		if e != nil {
			t.Fatal(e)
		}
		if r.Settings.Goal != nil || r.Settings.PublicToken != nil {
			t.Fatal("settings mutated during read")
		}
		for _, role := range []string{"reader", "editor"} {
			if _, e := repo.UpdateAnalyticsSettings(ctx, w.actor(role), x.ID, AnalyticsSettingsInput{Version: r.Settings.Version, Action: "enable"}); !errors.Is(e, publishing.ErrForbidden) {
				t.Fatalf("%s share=%v", role, e)
			}
		}
		saved, e := repo.UpdateAnalyticsSettings(ctx, w.actor("publisher"), x.ID, AnalyticsSettingsInput{Version: r.Settings.Version, Action: "goal", Goal: &PostingGoal{Cadence: "weekly", ExcludeWeekends: true, TimeZone: "Asia/Tokyo"}})
		if e != nil {
			t.Fatal(e)
		}
		if saved.Goal == nil || saved.Goal.EffectiveDate == "" || saved.PublicToken != nil {
			t.Fatal("goal implicitly shared")
		}
		shared, e := repo.UpdateAnalyticsSettings(ctx, w.actor("admin"), x.ID, AnalyticsSettingsInput{Version: saved.Version, Action: "enable"})
		if e != nil {
			t.Fatal(e)
		}
		public, e := repo.GetPublicAnalytics(ctx, *shared.PublicToken, q)
		if e != nil || public.AccountID != "" || public.Settings.PublicToken != nil || public.Settings.Goal != nil || len(public.Hourly) != 0 {
			t.Fatalf("public leaked=%+v %v", public, e)
		}
		if _, e := repo.UpdateAnalyticsSettings(ctx, owner, x.ID, AnalyticsSettingsInput{Version: saved.Version, Action: "revoke"}); !errors.Is(e, publishing.ErrConflict) {
			t.Fatalf("stale revoke=%v", e)
		}
		if _, e := repo.UpdateAnalyticsSettings(ctx, owner, x.ID, AnalyticsSettingsInput{Version: shared.Version, Action: "revoke"}); e != nil {
			t.Fatal(e)
		}
		if _, e := repo.GetPublicAnalytics(ctx, *shared.PublicToken, q); !errors.Is(e, publishing.ErrNotFound) {
			t.Fatalf("revoked token=%v", e)
		}
		events, e := repo.client.AuditLog.Query().Where(auditlog.OrganizationID(w.org), auditlog.EntityID(x.ID), auditlog.ActionIn("product.analytics_goal", "product.analytics_enable", "product.analytics_revoke")).All(ctx)
		if e != nil || len(events) != 3 {
			t.Fatalf("expected only three successful settings audits, got %d: %v", len(events), e)
		}
		seen := map[string]bool{}
		for _, event := range events {
			if seen[event.Action] || event.Outcome != auditlog.OutcomeSUCCEEDED || event.ActorUserID == nil || len(event.Metadata) != 1 || event.Metadata["version"] == nil {
				t.Fatalf("settings audit duplicated or leaked sharing data: %+v", event)
			}
			seen[event.Action] = true
		}
	})
	t.Run("A19 A40 ingestion retries deduplicate observations and retain provider corrections", func(t *testing.T) {
		before, e := repo.client.AnalyticsSnapshot.Query().Where(analyticssnapshot.ConnectionID(x.ID), analyticssnapshot.SubjectID(root.RemoteID)).Count(ctx)
		if e != nil {
			t.Fatal(e)
		}
		for i := 0; i < 2; i++ {
			if e := repo.RecordAnalyticsSnapshot(ctx, w.org, x.ID, "post", root.RemoteID, observed, observed, map[string]float64{"likes": 0, "impressions": 0}, 60); e != nil {
				t.Fatal(e)
			}
		}
		after, _ := repo.client.AnalyticsSnapshot.Query().Where(analyticssnapshot.ConnectionID(x.ID), analyticssnapshot.SubjectID(root.RemoteID)).Count(ctx)
		if before != after {
			t.Fatalf("duplicate snapshots %d -> %d", before, after)
		}
		if e := repo.RecordAnalyticsSnapshot(ctx, w.org, x.ID, "post", root.RemoteID, observed, observed.Add(time.Second), map[string]float64{"likes": 0, "impressions": 4}, 60); e != nil {
			t.Fatal(e)
		}
		if e := repo.RecordAnalyticsSnapshot(ctx, w.org, li.ID, "account", li.ID, observed, observed, map[string]float64{"followers": -1}, 0); e == nil {
			t.Fatal("invalid provider counter accepted")
		}
		fixture.err = errors.New("fixture provider failure")
		if e := repo.collectAnalytics(ctx, x, true); e != nil {
			t.Fatal(e)
		}
		state, e := repo.client.AnalyticsAccount.Get(ctx, x.ID)
		if e != nil || state.Availability != analyticsaccount.AvailabilityFailed || state.LeaseUntil != nil {
			t.Fatalf("failed state=%+v %v", state, e)
		}
		fixture.err = nil
		fixture.posts = []ImportedAnalyticsPost{{ID: "fixture-post", At: time.Now().Add(-time.Hour), Counters: map[string]float64{"likes": 0}}}
		if e := repo.collectAnalytics(ctx, x, true); e != nil {
			t.Fatal(e)
		}
		observations, e := repo.client.AnalyticsSnapshot.Query().Where(analyticssnapshot.ConnectionID(x.ID), analyticssnapshot.KindEQ(analyticssnapshot.KindAccount)).All(ctx)
		if e != nil {
			t.Fatal(e)
		}
		for _, observation := range observations {
			if observation.CollectedAt.Before(observation.ObservedAt) {
				t.Fatal("collection timestamp predates the returned measurement")
			}
		}
		if count, e := repo.client.AnalyticsPost.Query().Where(analyticspost.ConnectionID(x.ID), analyticspost.RemoteID("fixture-post")).Count(ctx); e != nil || count != 1 {
			t.Fatalf("recovery=%d %v", count, e)
		}
	})
	t.Run("A19 imported partial counters do not postpone richer metrics or erase clicks", func(t *testing.T) {
		fixture.posts = []ImportedAnalyticsPost{{ID: "rich-post", At: time.Now().Add(-time.Hour), Counters: map[string]float64{"likes": 1}}}
		fixture.metrics = postoptions.Metrics{"likes": 2, "impressions": 100, "profileClicks": 3, "linkClicks": 0}
		if e := repo.collectAnalytics(ctx, x, true); e != nil {
			t.Fatal(e)
		}
		post, e := repo.client.AnalyticsPost.Query().Where(analyticspost.ConnectionID(x.ID), analyticspost.RemoteID("rich-post")).Only(ctx)
		if e != nil {
			t.Fatal(e)
		}
		if post.CheckedAt == nil {
			t.Fatal("timeline import postponed per-post polling")
		}
		if e := repo.collectAnalytics(ctx, x, true); e != nil {
			t.Fatal(e)
		}
		today := time.Now().UTC().Format("2006-01-02")
		report, e := repo.GetAnalytics(ctx, owner, x.ID, AnalyticsQuery{From: time.Now().Add(-48 * time.Hour).UTC().Format("2006-01-02"), To: today, Limit: 100})
		if e != nil {
			t.Fatal(e)
		}
		found := false
		for _, row := range report.Posts {
			if row.RemoteID == "rich-post" {
				found = true
				if row.Metrics["profileClicks"] != 3 || row.Metrics["likes"] != 2 {
					t.Fatalf("richer metrics lost: %+v", row)
				}
			}
		}
		if !found {
			t.Fatal("post missing")
		}
	})
	t.Run("A19 deleted posts do not defer account collection or healthy posts", func(t *testing.T) {
		previous := *fixture
		defer func() { *fixture = previous }()
		for _, code := range []int{404, 410} {
			t.Run(fmt.Sprint(code), func(t *testing.T) {
				goneID, liveID, discoveredID := cuid.New(), cuid.New(), cuid.New()
				*fixture = analyticsFixture{
					metrics:    postoptions.Metrics{"likes": 7},
					postErrors: map[string]error{goneID: analyticsStatusError(code)},
					postCalls:  map[string]int{},
				}
				before := time.Now().UTC()
				gone, e := repo.importAnalyticsPost(ctx, x, ImportedAnalyticsPost{ID: goneID, At: before.Add(-time.Hour)}, nil)
				if e != nil {
					t.Fatal(e)
				}
				// Encounter the deleted post before the healthy post in this batch.
				if _, e = repo.client.AnalyticsPost.UpdateOneID(gone.ID).SetNextCheckAt(before.Add(-time.Hour)).Save(ctx); e != nil {
					t.Fatal(e)
				}
				live, e := repo.importAnalyticsPost(ctx, x, ImportedAnalyticsPost{ID: liveID, At: before.Add(-time.Hour)}, nil)
				if e != nil {
					t.Fatal(e)
				}
				if e = repo.collectAnalytics(ctx, x, true); e != nil {
					t.Fatal(e)
				}
				state, e := repo.client.AnalyticsAccount.Get(ctx, x.ID)
				if e != nil {
					t.Fatal(e)
				}
				if state.Availability != analyticsaccount.AvailabilityAvailable || state.NextCheckAt.Before(before.Add(45*time.Minute)) || state.NextCheckAt.After(time.Now().Add(45*time.Minute)) {
					t.Fatalf("deleted post changed account availability or polling interval: %+v", state)
				}
				gone, e = repo.client.AnalyticsPost.Get(ctx, gone.ID)
				if e != nil || gone.Availability != analyticspost.AvailabilityDeleted || gone.NextCheckAt.Before(before.Add(29*24*time.Hour)) {
					t.Fatalf("deleted post lost its own backoff: %+v %v", gone, e)
				}
				if fixture.postCalls[liveID] != 1 {
					t.Fatal("deleted post stopped healthy post collection")
				}
				observations, e := repo.client.AnalyticsSnapshot.Query().Where(analyticssnapshot.ConnectionID(x.ID), analyticssnapshot.KindEQ(analyticssnapshot.KindAccount)).Count(ctx)
				if e != nil {
					t.Fatal(e)
				}
				// Exercise the next account pass without waiting for its due time.
				if _, e = repo.client.AnalyticsPost.UpdateOneID(live.ID).SetNextCheckAt(before).Save(ctx); e != nil {
					t.Fatal(e)
				}
				fixture.posts = []ImportedAnalyticsPost{{ID: discoveredID, At: before.Add(-time.Minute)}}
				if e := repo.collectAnalytics(ctx, x, true); e != nil {
					t.Fatal(e)
				}
				if fixture.postCalls[goneID] != 1 || fixture.postCalls[liveID] != 2 || fixture.postCalls[discoveredID] != 1 {
					t.Fatalf("subsequent post collection: %+v", fixture.postCalls)
				}
				if after, e := repo.client.AnalyticsSnapshot.Query().Where(analyticssnapshot.ConnectionID(x.ID), analyticssnapshot.KindEQ(analyticssnapshot.KindAccount)).Count(ctx); e != nil || after != observations+1 {
					t.Fatalf("follower collection did not continue: %d -> %d %v", observations, after, e)
				}
			})
		}
	})
	t.Run("A19 revoked accounts reject new observations and public reads", func(t *testing.T) {
		if _, e := repo.client.ChannelConnection.UpdateOneID(li.ID).SetStatus("REVOKED").Save(ctx); e != nil {
			t.Fatal(e)
		}
		if e := repo.RecordAnalyticsSnapshot(ctx, w.org, li.ID, "account", li.ID, time.Now(), time.Now(), map[string]float64{"followers": 1}, 0); !errors.Is(e, publishing.ErrNotFound) {
			t.Fatalf("revoked ingestion=%v", e)
		}
	})

}

func TestAnalyticsGoalPeriods(t *testing.T) {
	parse := func(value string) time.Time {
		at, e := time.Parse(time.RFC3339, value)
		if e != nil {
			t.Fatal(e)
		}
		return at
	}
	t.Run("A26 confirmed weekdays count across DST and weekends without backfilling history", func(t *testing.T) {
		goal := PostingGoal{Cadence: "daily", ExcludeWeekends: true, TimeZone: "America/New_York", EffectiveDate: "2026-03-06"}
		posts := []time.Time{parse("2026-03-06T16:00:00Z"), parse("2026-03-07T16:00:00Z"), parse("2026-03-09T16:00:00Z")}
		p := calculateGoal(goal, posts, parse("2026-03-10T16:00:00Z"))
		if p.Streak != 2 || p.Current != 0 {
			t.Fatalf("progress=%+v", p)
		}
		p = calculateGoal(goal, posts, parse("2026-03-11T16:00:00Z"))
		if p.Streak != 0 {
			t.Fatalf("missed day=%+v", p)
		}
		goal.Cadence = "weekly"
		p = calculateGoal(goal, posts, parse("2026-03-10T16:00:00Z"))
		if p.Streak != 2 || p.Current != 1 {
			t.Fatalf("weekly=%+v", p)
		}
	})
}

type analyticsStatusError int

func (e analyticsStatusError) Error() string   { return "provider failure" }
func (e analyticsStatusError) HTTPStatus() int { return int(e) }
func TestAnalyticsRetryClassification(t *testing.T) {
	now := time.Date(2026, 10, 24, 0, 0, 0, 0, time.UTC)
	for _, item := range []struct {
		status       int
		availability string
		delay        time.Duration
		halt         bool
	}{{401, "forbidden", 24 * time.Hour, true}, {403, "forbidden", 24 * time.Hour, true}, {404, "deleted", 30 * 24 * time.Hour, false}, {429, "failed", 15 * time.Minute, true}, {500, "failed", time.Hour, false}} {
		availability, retry, halt := analyticsFailure(analyticsStatusError(item.status), now)
		if availability != item.availability || retry.Sub(now) != item.delay || halt != item.halt {
			t.Fatalf("status=%d got=%s %v %v", item.status, availability, retry, halt)
		}
	}
}
