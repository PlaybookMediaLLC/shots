package product

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	entsql "entgo.io/ent/dialect/sql"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentdraft"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentdraftrevision"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentdraftsettings"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/predicate"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/schema"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/activity"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/draftdoc"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/thread"
	"github.com/lucsky/cuid"
)

// Content drafts, round two (RFC 013): the posting queue and its settings,
// best times, moving one post, review, guest share links, revisions,
// resuming a thread that stopped, and engagement on live posts.

// defaultQueueSlots are a new workspace's posting times: weekdays at 9:00.
var defaultQueueSlots = schema.DefaultQueueSlots()

// ContentDraftSettings is a workspace's drafts preferences.
type ContentDraftSettings struct {
	PostingSlots    []schema.QueueSlot `json:"postingSlots"`
	RequireApproval bool               `json:"requireApproval"`
	TimeZone        string             `json:"timeZone"`
}

// ContentDraftSettingsUpdate changes the settings it sets.
type ContentDraftSettingsUpdate struct {
	PostingSlots    *[]schema.QueueSlot `json:"postingSlots"`
	RequireApproval *bool               `json:"requireApproval"`
}

func (c *Configuration) workspaceZone(ctx context.Context, organizationID string) (*time.Location, string) {
	name := "UTC"
	if settings, err := c.client.WorkspaceSettings.Get(ctx, organizationID); err == nil && settings.TimeZone != "" {
		name = settings.TimeZone
	}
	zone, err := time.LoadLocation(name)
	if err != nil {
		return time.UTC, "UTC"
	}
	return zone, name
}

// draftSettings is the workspace's review policy with the default social
// set's schedule: since RFC 024 a set owns its slots and time zone, and this
// older settings shape reads and writes the workspace's first set.
func (c *Configuration) draftSettings(ctx context.Context, organizationID string) (ContentDraftSettings, error) {
	set, err := c.defaultSocialSet(ctx, organizationID)
	if err != nil {
		return ContentDraftSettings{}, err
	}
	settings := ContentDraftSettings{PostingSlots: nonNilSlots(set.PostingSlots), TimeZone: set.TimeZone}
	row, err := c.client.ContentDraftSettings.Get(ctx, organizationID)
	if ent.IsNotFound(err) {
		return settings, nil
	}
	if err != nil {
		return ContentDraftSettings{}, err
	}
	settings.RequireApproval = row.RequireApproval
	return settings, nil
}

// GetContentDraftSettings returns the workspace's drafts settings, with the
// defaults when none were saved.
func (c *Configuration) GetContentDraftSettings(ctx context.Context, actor Actor) (*ContentDraftSettings, error) {
	if err := c.authorizeContentDrafts(ctx, actor, false); err != nil {
		return nil, err
	}
	settings, err := c.draftSettings(ctx, actor.OrganizationID)
	return &settings, err
}

// UpdateContentDraftSettings saves the settings an owner, admin or publisher sets.
func (c *Configuration) UpdateContentDraftSettings(ctx context.Context, actor Actor, input ContentDraftSettingsUpdate) (*ContentDraftSettings, error) {
	if err := c.authorizeScheduling(ctx, actor); err != nil {
		return nil, err
	}
	if err := c.requireWorkspaceFeature(ctx, actor.OrganizationID, contentDraftFeature); err != nil {
		return nil, err
	}
	if input.PostingSlots != nil {
		if err := c.requireWorkspaceFeature(ctx, actor.OrganizationID, advancedSchedulingFeature); err != nil {
			return nil, err
		}
	}
	current, err := c.draftSettings(ctx, actor.OrganizationID)
	if err != nil {
		return nil, err
	}
	if input.PostingSlots != nil {
		slots, err := queueSlots(*input.PostingSlots)
		if err != nil {
			return nil, err
		}
		current.PostingSlots = slots
		set, err := c.defaultSocialSet(ctx, actor.OrganizationID)
		if err != nil {
			return nil, err
		}
		if _, err := c.client.SocialSet.UpdateOneID(set.ID).SetPostingSlots(slots).AddVersion(1).Save(ctx); err != nil {
			return nil, err
		}
	}
	if input.RequireApproval != nil {
		current.RequireApproval = *input.RequireApproval
	}
	updated, err := c.client.ContentDraftSettings.Update().Where(contentdraftsettings.ID(actor.OrganizationID)).
		SetPostingSlots(current.PostingSlots).SetRequireApproval(current.RequireApproval).Save(ctx)
	if err == nil && updated == 0 {
		err = c.client.ContentDraftSettings.Create().SetID(actor.OrganizationID).SetPostingSlots(current.PostingSlots).
			SetRequireApproval(current.RequireApproval).Exec(ctx)
	}
	if err != nil {
		return nil, err
	}
	return &current, nil
}

// queueSlots checks and sorts weekly slots: at most 50, each a weekday and HH:MM.
func queueSlots(slots []schema.QueueSlot) ([]schema.QueueSlot, error) {
	if len(slots) > 50 {
		return nil, invalid("Keep the queue to 50 weekly slots or fewer.")
	}
	seen := map[string]bool{}
	out := make([]schema.QueueSlot, 0, len(slots))
	for _, slot := range slots {
		if _, err := time.Parse("15:04", slot.Time); err != nil || slot.Weekday < 0 || slot.Weekday > 6 {
			return nil, invalid("Each slot is a weekday (0 to 6) and a time as HH:MM.")
		}
		key := fmt.Sprintf("%d %s", slot.Weekday, slot.Time)
		if !seen[key] {
			seen[key] = true
			out = append(out, slot)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].Weekday < out[j].Weekday || out[i].Weekday == out[j].Weekday && out[i].Time < out[j].Time
	})
	return out, nil
}

// resolveWallTime is the instant a local wall time names in zone (RFC 024).
// When the clock repeats it (autumn), it is the first occurrence. When the
// clock skips it (spring), it is the same number of minutes after the
// transition: 02:30 on a day that jumps from 02:00 to 03:00 is 03:30.
func resolveWallTime(year int, month time.Month, day, hour, minute int, zone *time.Location) time.Time {
	wall := time.Date(year, month, day, hour, minute, 0, 0, time.UTC)
	var best time.Time
	found := false
	for _, probe := range []time.Duration{-36 * time.Hour, -12 * time.Hour, 12 * time.Hour, 36 * time.Hour} {
		_, offset := wall.Add(probe).In(zone).Zone()
		candidate := wall.Add(-time.Duration(offset) * time.Second)
		local := candidate.In(zone)
		if local.Year() == year && local.Month() == month && local.Day() == day && local.Hour() == hour && local.Minute() == minute &&
			(!found || candidate.Before(best)) {
			best, found = candidate, true
		}
	}
	if found {
		return best
	}
	_, before := wall.Add(-36 * time.Hour).In(zone).Zone()
	return wall.Add(-time.Duration(before) * time.Second)
}

// slotTimes lists the slots' occurrences after `from`, in order, up to `limit`.
func slotTimes(slots []schema.QueueSlot, zone *time.Location, from time.Time, limit int) []time.Time {
	var times []time.Time
	local := from.In(zone)
	for day := 0; day < 7*12 && len(times) < limit; day++ {
		date := time.Date(local.Year(), local.Month(), local.Day()+day, 12, 0, 0, 0, zone)
		for _, slot := range slots {
			if int(date.Weekday()) != slot.Weekday {
				continue
			}
			clock, _ := time.Parse("15:04", slot.Time)
			at := resolveWallTime(date.Year(), date.Month(), date.Day(), clock.Hour(), clock.Minute(), zone)
			if at.After(from) {
				times = append(times, at.UTC())
			}
		}
	}
	sort.Slice(times, func(i, j int) bool { return times[i].Before(times[j]) })
	if len(times) > limit {
		times = times[:limit]
	}
	return times
}

// setZone loads a set's scheduling time zone, falling back to UTC.
func setZone(set *ent.SocialSet) *time.Location {
	zone, err := time.LoadLocation(set.TimeZone)
	if err != nil {
		return time.UTC
	}
	return zone
}

// freeQueueSlots are the set's slots after now, in order, that no queued,
// publishing or unresolved post of the set takes. Inside ScheduleContentDraft
// it runs under the set's advisory lock, so two requests cannot take one slot.
func freeQueueSlots(ctx context.Context, client *ent.Client, set *ent.SocialSet, now time.Time) ([]time.Time, error) {
	if len(set.PostingSlots) == 0 {
		return nil, conflict("Add a posting time to this social set's schedule first.")
	}
	candidates := slotTimes(set.PostingSlots, setZone(set), now.Add(time.Minute), 200)
	if len(candidates) == 0 {
		return nil, conflict("The queue has no open slot in the next twelve weeks.")
	}
	taken, err := client.ScheduledPost.Query().Where(scheduledpost.OrganizationID(set.OrganizationID),
		scheduledpost.SocialSetID(set.ID), scheduledpost.StatusIn(scheduledpost.StatusSCHEDULED,
			scheduledpost.StatusPROCESSING, scheduledpost.StatusUNKNOWN_DELIVERY),
		scheduledpost.SlotAtGTE(candidates[0]), scheduledpost.SlotAtLTE(candidates[len(candidates)-1])).All(ctx)
	if err != nil {
		return nil, err
	}
	busy := map[int64]bool{}
	for _, post := range taken {
		busy[post.SlotAt.Truncate(time.Minute).Unix()] = true
	}
	free := make([]time.Time, 0, len(candidates))
	for _, at := range candidates {
		if !busy[at.Unix()] {
			free = append(free, at)
		}
	}
	if len(free) == 0 {
		return nil, conflict("Every queue slot in the next twelve weeks is taken.")
	}
	return free, nil
}

// nextFreeSlot is the set's next free queue slot after now.
func nextFreeSlot(ctx context.Context, client *ent.Client, set *ent.SocialSet, now time.Time) (time.Time, error) {
	free, err := freeQueueSlots(ctx, client, set, now)
	if err != nil {
		return time.Time{}, err
	}
	return free[0], nil
}

// NextQueueSlot is the next free slot of a set the actor may see; an empty
// set ID is the workspace's default set. It suggests; scheduling reserves.
func (c *Configuration) NextQueueSlot(ctx context.Context, actor Actor, socialSetID string) (time.Time, error) {
	if err := c.authorizeContentDrafts(ctx, actor, false); err != nil {
		return time.Time{}, err
	}
	if err := c.requireWorkspaceFeature(ctx, actor.OrganizationID, advancedSchedulingFeature); err != nil {
		return time.Time{}, err
	}
	set, err := c.resolveSocialSet(ctx, actor, socialSetID)
	if err != nil {
		return time.Time{}, err
	}
	return nextFreeSlot(ctx, c.client, set, time.Now())
}

// resolveSocialSet is the set actor names, or the workspace's default set.
func (c *Configuration) resolveSocialSet(ctx context.Context, actor Actor, socialSetID string) (*ent.SocialSet, error) {
	if socialSetID != "" {
		return visibleSocialSet(ctx, c.client, actor, socialSetID)
	}
	set, err := c.defaultSocialSet(ctx, actor.OrganizationID)
	if err != nil {
		return nil, err
	}
	if !socialSetVisible(set, actor) {
		return nil, notFound("Social set not found.")
	}
	return set, nil
}

// BestTime is a suggested posting time and why.
type BestTime struct {
	At          time.Time `json:"at"`
	Reason      string    `json:"reason"`
	Score       *float64  `json:"score,omitempty"`
	SamplePosts int       `json:"samplePosts"`
}

// postScore weighs a live post's engagement: conversations count most.
func postScore(metrics postoptions.Metrics) float64 {
	score := 0.0
	for name, value := range metrics {
		switch name {
		case "replies", "comments", "quotes":
			score += 3 * value
		case "reposts", "shares", "retweets":
			score += 2 * value
		case "likes", "reactions", "bookmarks":
			score += value
		}
	}
	return score
}

// BestPostingTimes suggests the next times to post: the weekday hours the
// workspace's live posts did best at, from their engagement; with too
// little history, the hours social posts do well at generally.
func (c *Configuration) BestPostingTimes(ctx context.Context, actor Actor, socialSetID string) ([]BestTime, error) {
	if err := c.authorizeContentDrafts(ctx, actor, false); err != nil {
		return nil, err
	}
	if err := c.requireWorkspaceFeature(ctx, actor.OrganizationID, advancedSchedulingFeature); err != nil {
		return nil, err
	}
	set, err := c.resolveSocialSet(ctx, actor, socialSetID)
	if err != nil {
		return nil, err
	}
	zone := setZone(set)
	query := c.client.ScheduledPost.Query().Where(scheduledpost.OrganizationID(actor.OrganizationID),
		scheduledpost.StatusEQ(scheduledpost.StatusPUBLISHED), scheduledpost.SocialSetID(set.ID), scheduledpost.MetricsAtNotNil(),
		scheduledpost.ScheduledForGTE(time.Now().AddDate(0, 0, -120)))
	query.Where(scheduledpost.SocialSetID(set.ID))
	posts, err := query.All(ctx)
	if err != nil {
		return nil, err
	}
	type bucket struct {
		count int
		total float64
	}
	buckets := map[[2]int]*bucket{}
	measuredPosts := 0
	for _, post := range posts {
		known := false
		for _, metric := range []string{"replies", "comments", "quotes", "reposts", "shares", "retweets", "likes", "reactions", "bookmarks"} {
			if _, ok := post.Metrics[metric]; ok {
				known = true
				break
			}
		}
		if !known || !validMetrics(post.Metrics) {
			continue
		}
		measuredPosts++
		publishedAt := post.ScheduledFor
		if post.PublishedAt != nil {
			publishedAt = *post.PublishedAt
		}
		local := publishedAt.In(zone)
		key := [2]int{int(local.Weekday()), local.Hour()}
		if buckets[key] == nil {
			buckets[key] = &bucket{}
		}
		buckets[key].count++
		buckets[key].total += postScore(post.Metrics)
	}
	type ranked struct {
		key     [2]int
		average float64
		count   int
	}
	var hours []ranked
	for key, value := range buckets {
		hours = append(hours, ranked{key: key, average: value.total / float64(value.count), count: value.count})
	}
	sort.Slice(hours, func(i, j int) bool {
		if hours[i].average != hours[j].average {
			return hours[i].average > hours[j].average
		}
		if hours[i].key[0] != hours[j].key[0] {
			return hours[i].key[0] < hours[j].key[0]
		}
		return hours[i].key[1] < hours[j].key[1]
	})
	reason := "Your posts at this hour get the most engagement."
	if measuredPosts < 5 || len(hours) == 0 {
		// Too little history: mid-week mornings and lunchtime, broadly good.
		hours = []ranked{{key: [2]int{2, 9}}, {key: [2]int{3, 12}}, {key: [2]int{4, 9}}}
		reason = "Suggested starting times; insufficient history for personalized recommendations."
	}
	var slots []schema.QueueSlot
	for _, hour := range hours[:min(3, len(hours))] {
		slots = append(slots, schema.QueueSlot{Weekday: hour.key[0], Time: fmt.Sprintf("%02d:00", hour.key[1])})
	}
	suggestions := []BestTime{}
	for _, at := range slotTimes(slots, zone, time.Now().Add(30*time.Minute), 3) {
		item := BestTime{At: at, Reason: reason}
		local := at.In(zone)
		for _, hour := range hours {
			if hour.key == [2]int{int(local.Weekday()), local.Hour()} && hour.count > 0 {
				score := hour.average
				item.Score = &score
				item.SamplePosts = hour.count
				break
			}
		}
		suggestions = append(suggestions, item)
	}
	return suggestions, nil
}

// MovedDraftPost is a post moved to a new time: the old one is cancelled and
// a copy takes its place, since a scheduled workflow's timer is fixed.
type MovedDraftPost struct {
	Cancelled string             `json:"-"`
	Post      ContentDraftPost   `json:"post"`
	Scheduled *ent.ScheduledPost `json:"-"`
}

// MoveContentDraftPost moves one queued draft post to `at`, without charging
// another post: the calendar's drag and drop.
func (c *Configuration) MoveContentDraftPost(ctx context.Context, actor Actor, postID string, at time.Time) (*MovedDraftPost, error) {
	if err := c.authorizeScheduling(ctx, actor); err != nil {
		return nil, err
	}
	if err := c.requireWorkspaceFeature(ctx, actor.OrganizationID, contentDraftFeature); err != nil {
		return nil, err
	}
	if !at.After(time.Now().Add(time.Minute)) {
		return nil, invalid("Pick a time in the future.")
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	moved, err := c.moveDraftPostTx(ctx, tx, actor, postID, at)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return moved, nil
}

func (c *Configuration) moveDraftPostTx(ctx context.Context, tx *ent.Tx, actor Actor, postID string, at time.Time, zones ...string) (*MovedDraftPost, error) {
	post, err := tx.ScheduledPost.Query().Where(scheduledpost.ID(postID), scheduledpost.OrganizationID(actor.OrganizationID),
		scheduledpost.ContentDraftIDNotNil()).WithChannelConnection().Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := requireVisibleDraftPost(ctx, tx.Client(), actor, post); err != nil {
		return nil, err
	}
	if post.Status != scheduledpost.StatusSCHEDULED {
		return nil, conflict("Only a queued post can move; this one is " + strings.ToLower(string(post.Status)) + ".")
	}
	if len(zones) > 0 {
		post.ScheduleTimeZone = &zones[0]
	}
	return replaceQueuedDraftPost(ctx, tx, actor, post, at)
}

// requireVisibleDraftPost refuses a draft post whose draft the actor cannot see.
func requireVisibleDraftPost(ctx context.Context, client *ent.Client, actor Actor, post *ent.ScheduledPost) error {
	if post.ContentDraftID == nil {
		return nil
	}
	_, err := visibleContentDraft(ctx, client, actor, *post.ContentDraftID)
	return err
}

// CalendarPost is a draft post on the calendar, with its draft's title.
type CalendarPost struct {
	ContentDraftPost
	CampaignID      *string  `json:"campaignId,omitempty"`
	CampaignTitle   string   `json:"campaignTitle,omitempty"`
	DraftID         string   `json:"draftId"`
	DraftTitle      string   `json:"draftTitle"`
	SocialSetID     *string  `json:"socialSetId"`
	TagIDs          []string `json:"tagIds"`
	Version         int      `json:"version"`
	CalendarVersion int      `json:"calendarVersion"`
}

// ListContentDraftPostsBetween lists the workspace's draft posts due in
// [from, to): queued, publishing and live, for the calendar and the queue.
// Only posts of drafts in sets the actor may see are listed; setID, when
// set, narrows them to one set.
func (c *Configuration) ListContentDraftPostsBetween(ctx context.Context, actor Actor, from, to time.Time, socialSetID string) ([]CalendarPost, error) {
	if err := c.authorizeContentDrafts(ctx, actor, false); err != nil {
		return nil, err
	}
	if !to.After(from) || to.Sub(from) > 100*24*time.Hour {
		return nil, invalid("Ask for at most 100 days at a time.")
	}
	visible, err := c.visibleSocialSetIDs(ctx, actor)
	if err != nil {
		return nil, err
	}
	if socialSetID != "" {
		if !oneOf(socialSetID, visible...) {
			return nil, notFound("Social set not found.")
		}
		visible = []string{socialSetID}
	}
	inSets := scheduledpost.SocialSetIDIn(visible...)
	if socialSetID == "" {
		inSets = scheduledpost.Or(scheduledpost.SocialSetIDIsNil(), inSets)
	}
	posts, err := c.client.ScheduledPost.Query().Where(scheduledpost.OrganizationID(actor.OrganizationID),
		scheduledpost.Or(scheduledpost.And(inSets, scheduledpost.ContentDraftIDNotNil()), scheduledpost.And(scheduledpost.ContentDraftIDIsNil(), scheduledpost.HasChannelConnectionWith(channelconnection.OrganizationID(actor.OrganizationID), channelconnection.SocialSetIDIn(visible...)))), scheduledpost.ScheduledForGTE(from), scheduledpost.ScheduledForLT(to),
		scheduledpost.StatusIn(scheduledpost.StatusSCHEDULED, scheduledpost.StatusPROCESSING,
			scheduledpost.StatusPUBLISHED, scheduledpost.StatusFAILED, scheduledpost.StatusUNKNOWN_DELIVERY)).
		WithChannelConnection().Order(ent.Asc(scheduledpost.FieldScheduledFor)).All(ctx)
	if err != nil {
		return nil, err
	}
	ids := map[string]bool{}
	for _, post := range posts {
		if post.ContentDraftID != nil {
			ids[*post.ContentDraftID] = true
		}
	}
	keys := make([]string, 0, len(ids))
	for id := range ids {
		keys = append(keys, id)
	}
	var sets predicate.ContentDraft
	if socialSetID != "" {
		sets, err = c.draftSetFilter(ctx, actor, socialSetID)
	} else {
		sets, err = c.draftVisibilityPredicate(ctx, actor)
	}
	if err != nil {
		return nil, err
	}
	drafts, err := c.client.ContentDraft.Query().Where(contentdraft.IDIn(keys...),
		contentdraft.OrganizationID(actor.OrganizationID), sets).All(ctx)
	if err != nil {
		return nil, err
	}
	visibleDrafts := map[string]*ent.ContentDraft{}
	for _, draft := range drafts {
		visibleDrafts[draft.ID] = draft
	}
	campaigns, err := c.calendarCampaigns(ctx, actor, posts)
	if err != nil {
		return nil, err
	}
	items := make([]CalendarPost, 0, len(posts))
	for _, post := range posts {
		if post.ContentDraftID == nil {
			if entry, ok := campaigns[post.ID]; ok {
				items = append(items, entry)
			}
			continue
		}
		draft, visible := visibleDrafts[*post.ContentDraftID]
		if !visible {
			continue
		}
		items = append(items, CalendarPost{ContentDraftPost: contentDraftPost(post, post.Edges.ChannelConnection.Platform),
			DraftID: *post.ContentDraftID, DraftTitle: draft.Title, SocialSetID: draft.SocialSetID, TagIDs: draft.TagIds, Version: draft.Version, CalendarVersion: draft.CalendarVersion})
	}
	return items, nil
}

// ListPlannedContentDrafts lists drafts planned in [from, to) in the sets the
// actor may see, soonest first: the calendar's planned entries.
func (c *Configuration) ListPlannedContentDrafts(ctx context.Context, actor Actor, from, to time.Time, setID string) ([]ContentDraftRecord, error) {
	if err := c.authorizeContentDrafts(ctx, actor, false); err != nil {
		return nil, err
	}
	if !to.After(from) || to.Sub(from) > 100*24*time.Hour {
		return nil, invalid("Ask for at most 100 days at a time.")
	}
	var sets predicate.ContentDraft
	var err error
	if setID != "" {
		sets, err = c.draftSetFilter(ctx, actor, setID)
	} else {
		sets, err = c.draftVisibilityPredicate(ctx, actor)
	}
	if err != nil {
		return nil, err
	}
	rows, err := c.client.ContentDraft.Query().Where(contentdraft.OrganizationID(actor.OrganizationID), sets,
		contentdraft.StatusNEQ(contentdraft.StatusArchived), contentdraft.PlannedForGTE(from), contentdraft.PlannedForLT(to)).
		Order(ent.Asc(contentdraft.FieldPlannedFor), ent.Asc(contentdraft.FieldID)).All(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]ContentDraftRecord, 0, len(rows))
	for _, row := range rows {
		items = append(items, contentDraftRecord(row))
	}
	return items, nil
}

// ContentDraftReviewInput is a review step: request (a writer asks), approve
// or changes (a reviewer answers), with an optional note.
type ContentDraftReviewInput struct {
	Action string `json:"action"`
	Note   string `json:"note"`
}

// ReviewContentDraft records a review step. Writers request review; owners,
// admins and approvers approve or ask for changes. Approval holds for the
// version it was given at.
func (c *Configuration) ReviewContentDraft(ctx context.Context, actor Actor, id string, input ContentDraftReviewInput) (*ContentDraftRecord, error) {
	write := input.Action == "request"
	var err error
	if write {
		err = c.authorizeContentDrafts(ctx, actor, true)
	} else {
		err = c.authorizeDecision(ctx, actor, "owner", "admin", "approver")
	}
	if err != nil {
		return nil, err
	}
	if _, err := c.loadDraft(ctx, actor, id); err != nil {
		return nil, err
	}
	note := strings.TrimSpace(input.Note)
	if utf8.RuneCountInString(note) > 2000 {
		return nil, invalid("Keep the review note under 2,000 characters.")
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = tx.PlatformExec(ctx, `SELECT id FROM content_draft WHERE id=$1 AND "organizationId"=$2 FOR UPDATE`, id, actor.OrganizationID); err != nil {
		return nil, err
	}

	draft, err := visibleContentDraft(ctx, tx.Client(), actor, id)
	if err != nil {
		return nil, err
	}
	nextStatus := map[string]string{"request": "pending", "approve": "approved", "changes": "changes_requested"}[input.Action]
	if nextStatus == "" {
		return nil, invalid("A review action is request, approve or changes.")
	}
	if string(draft.ReviewStatus) == nextStatus && optionalText(draft.ReviewNote) == note && (input.Action != "approve" || draft.ApprovedVersion != nil && *draft.ApprovedVersion == draft.Version) {
		result := contentDraftRecord(draft)
		return &result, nil
	}
	// A review step does not change the content, so it keeps the version.
	update := tx.ContentDraft.UpdateOneID(id).SetNillableReviewedByUserID(projectActor(actor))
	if note == "" {
		update.ClearReviewNote()
	} else {
		update.SetReviewNote(note)
	}
	switch input.Action {
	case "request":
		update.SetReviewStatus(contentdraft.ReviewStatusPending).ClearApprovedVersion()
	case "approve":
		update.SetReviewStatus(contentdraft.ReviewStatusApproved).SetApprovedVersion(draft.Version)
	case "changes":
		update.SetReviewStatus(contentdraft.ReviewStatusChangesRequested).ClearApprovedVersion()
	default:
		return nil, invalid("A review action is request, approve or changes.")
	}
	row, err := update.Save(ctx)
	if err != nil {
		return nil, err
	}
	if err := recordProductActivity(ctx, tx, actor, map[string]string{"request": "draft.review_requested", "approve": "draft.approved", "changes": "draft.changes_requested"}[input.Action], "product.content_draft_review", "content_draft", id,
		map[string]any{"action": input.Action, "version": draft.Version}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := contentDraftRecord(row)
	return &result, nil
}

// requireDraftApproval refuses to schedule a draft the workspace wants
// reviewed until it is approved at its current version.
func (c *Configuration) requireDraftApproval(ctx context.Context, draft *ent.ContentDraft) error {
	settings, err := c.draftSettings(ctx, draft.OrganizationID)
	if err != nil || !settings.RequireApproval {
		return err
	}
	if draft.ReviewStatus == contentdraft.ReviewStatusApproved && draft.ApprovedVersion != nil &&
		*draft.ApprovedVersion == draft.Version {
		return nil
	}
	return conflict("This workspace approves drafts before they are scheduled. Ask for review, then schedule once it is approved.")
}

// ShareContentDraft turns the draft's read-and-comment link on (a fresh
// token) or off.
func (c *Configuration) ShareContentDraft(ctx context.Context, actor Actor, id string, on bool) (*ContentDraftRecord, error) {
	if err := c.authorizeContentDrafts(ctx, actor, true); err != nil {
		return nil, err
	}
	current, err := c.loadDraft(ctx, actor, id)
	if err != nil {
		return nil, err
	}
	if on == (current.ShareToken != nil) {
		result := contentDraftRecord(current)
		return &result, nil
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	// Sharing is not content: the version and the list order stay.
	update := tx.ContentDraft.Update().Where(contentdraft.ID(id), contentdraft.OrganizationID(actor.OrganizationID)).
		SetUpdatedAt(current.UpdatedAt)
	if on {
		token := make([]byte, 24)
		if _, err := rand.Read(token); err != nil {
			return nil, err
		}
		update.SetShareToken(base64.RawURLEncoding.EncodeToString(token))
	} else {
		update.ClearShareToken()
	}
	count, err := update.Save(ctx)
	if err != nil {
		return nil, err
	}
	if count == 0 {
		return nil, publishing.ErrNotFound
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.content_draft_shared", "content_draft", id,
		map[string]any{"enabled": on}); err != nil {
		return nil, err
	}
	row, err := tx.ContentDraft.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := contentDraftRecord(row)
	return &result, nil
}

// SharedContentDraft is what a share link shows a guest: the draft's title,
// body and the comments guests left; nothing about the workspace.
type SharedContentDraft struct {
	ImageAssetID  *string             `json:"imageAssetId,omitempty"`
	Published     bool                `json:"published"`
	PublishedURL  *string             `json:"publishedUrl,omitempty"`
	Body          []any               `json:"body"`
	GuestComments []map[string]string `json:"guestComments"`
	PlainText     string              `json:"plainText"`
	Title         string              `json:"title"`
	UpdatedAt     time.Time           `json:"updatedAt"`
}

func sharedDraftByToken(ctx context.Context, client *ent.Client, token string) (*ent.ContentDraft, error) {
	if len(token) < 20 || len(token) > 64 {
		return nil, publishing.ErrNotFound
	}
	draft, err := client.ContentDraft.Query().Where(contentdraft.ShareToken(token)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	return draft, err
}

// GetSharedContentDraft reads a draft through its share link. The token is
// the only credential; a link that was turned off finds nothing.
func (c *Configuration) GetSharedContentDraft(ctx context.Context, token string) (*SharedContentDraft, error) {
	draft, err := sharedDraftByToken(ctx, c.client, token)
	if err != nil {
		return nil, err
	}
	result := &SharedContentDraft{Body: nonNilBody(draft.Body), GuestComments: nonNilComments(draft.GuestComments),
		PlainText: draft.PlainText, Title: draft.Title, UpdatedAt: draft.UpdatedAt}
	imageIDs := draft.AssetIds
	// A published unroll uses immutable delivered copy. Later edits must not
	// replace what readers are told was published; only confirmed replies appear.
	post, err := c.client.ScheduledPost.Query().Where(scheduledpost.ContentDraftID(draft.ID), scheduledpost.OrganizationID(draft.OrganizationID), scheduledpost.StatusEQ(scheduledpost.StatusPUBLISHED), scheduledpost.ReplyToIsNil()).WithChannelConnection().Order(scheduledpost.ByPublishedAt(entsql.OrderDesc(), entsql.OrderNullsLast()), ent.Desc(scheduledpost.FieldCreatedAt)).First(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	if post != nil {
		imageIDs = post.AssetIds
		texts := []string{post.Caption}
		for _, reply := range post.Replies[:min(len(post.Replies), max(0, post.ThreadProgress.Posted))] {
			texts = append(texts, reply.Caption)
		}
		// Resume receipts belong to the same draft/channel and must extend the
		// last confirmed provider reply. Unsent snapshots never enter this view.
		resumed, err := c.client.ScheduledPost.Query().Where(scheduledpost.ContentDraftID(draft.ID), scheduledpost.OrganizationID(draft.OrganizationID), scheduledpost.ChannelConnectionID(post.ChannelConnectionID), scheduledpost.StatusEQ(scheduledpost.StatusPUBLISHED), scheduledpost.ReplyToNotNil(), scheduledpost.CreatedAtGTE(post.CreatedAt)).Order(ent.Asc(scheduledpost.FieldCreatedAt)).Limit(1000).All(ctx)
		if err != nil {
			return nil, err
		}
		tail := post.ThreadProgress.LastReplyID
		if tail == "" && post.RemotePostID != nil {
			tail = *post.RemotePostID
		}
		seen := map[string]bool{post.ID: true}
		for tail != "" {
			var next *ent.ScheduledPost
			for _, candidate := range resumed {
				if !seen[candidate.ID] && candidate.ReplyTo != nil && *candidate.ReplyTo == tail {
					next = candidate
					break
				}
			}
			if next == nil {
				break
			}
			seen[next.ID] = true
			texts = append(texts, next.Caption)
			for _, reply := range next.Replies[:min(len(next.Replies), max(0, next.ThreadProgress.Posted))] {
				texts = append(texts, reply.Caption)
			}
			tail = next.ThreadProgress.LastReplyID
			if tail == "" && next.RemotePostID != nil {
				tail = *next.RemotePostID
			}
		}
		result.Title = string([]rune(post.Caption)[:min(120, len([]rune(post.Caption)))])
		if post.PublishedAt != nil {
			result.UpdatedAt = *post.PublishedAt
		}
		result.Published = true
		result.PublishedURL = postoptions.LivePostURL(post.Edges.ChannelConnection.Platform, post.RemotePostID)
		if receipt := post.ThreadProgress.Publication; receipt != nil && receipt.URL != "" {
			result.PublishedURL = &receipt.URL
		}
		result.PlainText = strings.Join(texts, "\n\n")
		result.Body = []any{}
	}
	if len(imageIDs) > 0 {
		images, err := c.client.Asset.Query().Where(asset.IDIn(imageIDs...), asset.OrganizationID(draft.OrganizationID), asset.StatusEQ(asset.StatusUPLOADED), asset.MediaTypeIn("image/jpeg", "image/png", "image/webp", "image/gif")).All(ctx)
		if err != nil {
			return nil, err
		}
		for _, id := range imageIDs {
			for _, image := range images {
				if image.ID == id {
					result.ImageAssetID = &id
					break
				}
			}
			if result.ImageAssetID != nil {
				break
			}
		}
	}
	return result, nil
}

// ReadSharedDraftImage releases only the first shared image and rechecks revocation
// after storage completes. Published shares use the immutable root's assets.
func (c *Configuration) ReadSharedDraftImage(ctx context.Context, token string) ([]byte, string, error) {
	shared, err := c.GetSharedContentDraft(ctx, token)
	if err != nil {
		return nil, "", err
	}
	if shared.ImageAssetID == nil {
		return nil, "", publishing.ErrNotFound
	}
	draft, err := sharedDraftByToken(ctx, c.client, token)
	if err != nil {
		return nil, "", err
	}
	body, mime, err := c.ReadAsset(ctx, Actor{Kind: "service", OrganizationID: draft.OrganizationID}, *shared.ImageAssetID)
	if err != nil {
		return nil, "", err
	}
	current, err := c.GetSharedContentDraft(ctx, token)
	if err != nil {
		return nil, "", err
	}
	if current.ImageAssetID == nil || *current.ImageAssetID != *shared.ImageAssetID {
		return nil, "", publishing.ErrNotFound
	}
	return body, mime, nil
}

func nonNilComments(comments []map[string]string) []map[string]string {
	if comments == nil {
		return []map[string]string{}
	}
	return comments
}

// GuestCommentInput is a comment left through a share link.
type GuestCommentInput struct {
	Name string `json:"name"`
	Text string `json:"text"`
}

// AddGuestComment keeps a guest's comment with the draft: at most 200, each
// with a name under 80 characters and text under 2,000.
func (c *Configuration) AddGuestComment(ctx context.Context, token string, input GuestCommentInput) (*SharedContentDraft, error) {
	name, text := strings.TrimSpace(input.Name), strings.TrimSpace(input.Text)
	if name == "" || text == "" || utf8.RuneCountInString(name) > 80 || utf8.RuneCountInString(text) > 2000 {
		return nil, invalid("Add your name (under 80 characters) and a comment (under 2,000).")
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = tx.PlatformExec(ctx, `SELECT id FROM content_draft WHERE "shareToken"=$1 FOR UPDATE`, token); err != nil {
		return nil, err
	}
	draft, err := sharedDraftByToken(ctx, tx.Client(), token)
	if err != nil {
		return nil, err
	}
	comments := nonNilComments(draft.GuestComments)
	if len(comments) >= 200 {
		return nil, conflict("This draft has as many guest comments as it can keep.")
	}
	commentID := cuid.New()
	comments = append(comments, map[string]string{
		"id":        commentID,
		"createdAt": time.Now().UTC().Format(time.RFC3339), "name": name, "text": text,
	})
	// A guest comment leaves the draft's version alone: writers keep saving.
	if _, err := tx.ContentDraft.UpdateOneID(draft.ID).SetGuestComments(comments).Save(ctx); err != nil {
		return nil, err
	}
	if err = activity.Emit(ctx, tx, draft.OrganizationID, "comment.created", "content_draft", draft.ID, "", commentID, map[string]any{"commentId": commentID}); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return c.GetSharedContentDraft(ctx, token)
}

// contentDraftRevisionEvery is how often editing keeps a revision.
const contentDraftRevisionEvery = 10 * time.Minute

// recordContentDraftRevision keeps the draft as it is now when the last
// revision is older than contentDraftRevisionEvery, or always when forced.
// The reason says why: edit, schedule, plan, publish or recovery.
func recordContentDraftRevision(ctx context.Context, tx *ent.Tx, actor Actor, draft *ent.ContentDraft, force bool, reason string) error {
	if !force {
		recent, err := tx.ContentDraftRevision.Query().Where(contentdraftrevision.ContentDraftID(draft.ID),
			contentdraftrevision.CreatedAtGT(time.Now().Add(-contentDraftRevisionEvery))).Exist(ctx)
		if err != nil || recent {
			return err
		}
	}
	create := tx.ContentDraftRevision.Create().SetID(cuid.New()).SetOrganizationID(draft.OrganizationID).
		SetContentDraftID(draft.ID).SetVersion(draft.Version).SetTitle(draft.Title).SetBody(nonNilBody(draft.Body)).
		SetPlainText(draft.PlainText).SetPlatformVersions(nonNilVersions(draft.PlatformVersions)).
		SetReason(reason).SetNillableCreatedByUserID(projectActor(actor))
	if draft.Article != nil {
		create.SetArticle(draft.Article)
	}
	if err := create.Exec(ctx); err != nil {
		return err
	}
	return pruneContentDraftRevisions(ctx, tx, draft.ID)
}

// pruneContentDraftRevisions applies the backup retention (RFC 025): every
// backup from the last 30 days, then the last one of each day for a year,
// then none. It runs as a draft gains a backup, so a draft nobody edits
// keeps what it had.
func pruneContentDraftRevisions(ctx context.Context, tx *ent.Tx, draftID string) error {
	_, err := tx.PlatformExec(ctx, `
		DELETE FROM content_draft_revision r
		WHERE r."contentDraftId" = $1 AND (
			r."createdAt" < now() - interval '365 days'
			OR (r."createdAt" < now() - interval '30 days' AND EXISTS (
				SELECT 1 FROM content_draft_revision later
				WHERE later."contentDraftId" = r."contentDraftId"
					AND date_trunc('day', later."createdAt") = date_trunc('day', r."createdAt")
					AND (later."createdAt", later.id) > (r."createdAt", r.id))))`, draftID)
	return err
}

// ContentDraftRevisionRecord is a revision as the API returns it. The body is
// only in a single revision's read.
type ContentDraftRevisionRecord struct {
	Body            []any     `json:"body,omitempty"`
	CreatedAt       time.Time `json:"createdAt"`
	CreatedByUserID *string   `json:"createdByUserId"`
	ID              string    `json:"id"`
	PlainText       string    `json:"plainText"`
	Title           string    `json:"title"`
	Version         int       `json:"version"`
	// Write (RFC 025): why the backup was kept, and, in a single read, the
	// platform versions and article as they were.
	Article          *draftdoc.Article          `json:"article,omitempty"`
	PlatformVersions *draftdoc.PlatformVersions `json:"platformVersions,omitempty"`
	Reason           string                     `json:"reason"`
}

// ListContentDraftRevisions lists a draft's revisions, newest first.
func (c *Configuration) ListContentDraftRevisions(ctx context.Context, actor Actor, draftID string) ([]ContentDraftRevisionRecord, error) {
	if err := c.authorizeContentDrafts(ctx, actor, false); err != nil {
		return nil, err
	}
	if _, err := visibleContentDraft(ctx, c.client, actor, draftID); err != nil {
		return nil, err
	}
	rows, err := c.client.ContentDraftRevision.Query().Where(contentdraftrevision.ContentDraftID(draftID),
		contentdraftrevision.OrganizationID(actor.OrganizationID)).
		Order(ent.Desc(contentdraftrevision.FieldCreatedAt), ent.Desc(contentdraftrevision.FieldID)).Limit(200).All(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]ContentDraftRevisionRecord, 0, len(rows))
	for _, row := range rows {
		text := row.PlainText
		if utf8.RuneCountInString(text) > 280 {
			text = string([]rune(text)[:280])
		}
		items = append(items, ContentDraftRevisionRecord{CreatedAt: row.CreatedAt, CreatedByUserID: row.CreatedByUserID,
			ID: row.ID, PlainText: text, Reason: row.Reason, Title: row.Title, Version: row.Version})
	}
	return items, nil
}

// GetContentDraftRevision reads one revision with its body, to restore it.
func (c *Configuration) GetContentDraftRevision(ctx context.Context, actor Actor, draftID, revisionID string) (*ContentDraftRevisionRecord, error) {
	if err := c.authorizeContentDrafts(ctx, actor, false); err != nil {
		return nil, err
	}
	if _, err := visibleContentDraft(ctx, c.client, actor, draftID); err != nil {
		return nil, err
	}
	row, err := c.client.ContentDraftRevision.Query().Where(contentdraftrevision.ID(revisionID),
		contentdraftrevision.ContentDraftID(draftID), contentdraftrevision.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	record := &ContentDraftRevisionRecord{Body: nonNilBody(row.Body), CreatedAt: row.CreatedAt, Article: row.Article,
		CreatedByUserID: row.CreatedByUserID, ID: row.ID, PlainText: row.PlainText, Reason: row.Reason, Title: row.Title, Version: row.Version}
	if row.PlatformVersions.SchemaVersion != 0 {
		versions := nonNilVersions(row.PlatformVersions)
		record.PlatformVersions = &versions
	}
	return record, nil
}

// ResumeContentDraftThread posts the rest of a thread that stopped partway:
// a new post answering the last live part, carrying the replies that did not
// go out. It goes out now.
func (c *Configuration) ResumeContentDraftThread(ctx context.Context, actor Actor, postID string) (*MovedDraftPost, error) {
	if err := c.authorizeScheduling(ctx, actor); err != nil {
		return nil, err
	}
	if err := c.requireWorkspaceFeature(ctx, actor.OrganizationID, contentDraftFeature); err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	post, err := tx.ScheduledPost.Query().Where(scheduledpost.ID(postID), scheduledpost.OrganizationID(actor.OrganizationID),
		scheduledpost.ContentDraftIDNotNil()).WithChannelConnection().Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := requireVisibleDraftPost(ctx, tx.Client(), actor, post); err != nil {
		return nil, err
	}
	progress := post.ThreadProgress
	if post.Status != scheduledpost.StatusPUBLISHED || progress.Total == 0 || progress.Posted >= progress.Total {
		return nil, conflict("This post's thread went out in full; there is nothing to resume.")
	}
	answer := progress.LastReplyID
	if answer == "" && post.RemotePostID != nil {
		answer = *post.RemotePostID
	}
	if answer == "" {
		return nil, conflict("The live post this thread continues is unknown, so it cannot resume.")
	}
	rest := post.Replies[progress.Posted:]
	create := tx.ScheduledPost.Create().SetID(cuid.New()).SetOrganizationID(post.OrganizationID).
		SetNillableContentDraftID(post.ContentDraftID).SetChannelConnectionID(post.ChannelConnectionID).
		SetScheduledFor(time.Now().UTC()).SetStatus(scheduledpost.StatusSCHEDULED).SetCaption(rest[0].Caption).
		SetNillableSocialSetID(post.SocialSetID).SetScheduleMode(scheduledpost.ScheduleModeExplicit).
		SetSlotAt(time.Now().UTC()).SetNaturalOffsetSeconds(0).SetNillableScheduleTimeZone(post.ScheduleTimeZone).
		SetReplyTo(answer).SetIdempotencyKey(fmt.Sprintf("%s:resume:%d", post.IdempotencyKey, progress.Posted))
	if len(rest[0].AssetIDs) > 0 {
		create.SetAssetID(rest[0].AssetIDs[0]).SetAssetIds(rest[0].AssetIDs)
	}
	if rest[0].Options != nil && !rest[0].Options.Empty() {
		options := *rest[0].Options
		if options.QuoteFirstPost && post.RemotePostID != nil {
			// The first post is live: the quote can name it now.
			options.QuoteFirstPost, options.QuoteRemoteID = false, *post.RemotePostID
		}
		create.SetPublishOptions(options)
	}
	if len(rest) > 1 {
		create.SetReplies(append([]thread.Reply{}, rest[1:]...))
	}
	resumed, err := create.Save(ctx)
	if ent.IsConstraintError(err) {
		return nil, conflict("This thread is already resuming.")
	}
	if err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "post.thread_resumed", "scheduled_post", resumed.ID,
		map[string]any{"from": post.ID, "posted": progress.Posted}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &MovedDraftPost{Post: contentDraftPost(resumed, post.Edges.ChannelConnection.Platform), Scheduled: resumed}, nil
}

// PostMetricsReader reads a live post's engagement from its platform.
type PostMetricsReader interface {
	PostMetrics(ctx context.Context, organizationID, destinationID, platform, secretReference, remotePostID string) (postoptions.Metrics, error)
}

// WithPostMetrics sets the engagement reader (the direct social publisher).
func (c *Configuration) WithPostMetrics(reader PostMetricsReader) *Configuration {
	c.postMetrics = reader
	return c
}

// RefreshDraftPostMetrics reads a live draft post's engagement from its
// platform now and keeps it.
func (c *Configuration) RefreshDraftPostMetrics(ctx context.Context, actor Actor, postID string) (*ContentDraftPost, error) {
	ref, err := c.LiveDraftPost(ctx, actor, postID)
	if err != nil {
		return nil, err
	}
	if c.postMetrics == nil {
		return nil, conflict("Engagement is not available on this server.")
	}
	metrics, err := c.postMetrics.PostMetrics(ctx, ref.OrganizationID, ref.ConnectionExternalID, ref.Platform,
		ref.SecretReference, ref.RemotePostID)
	if err != nil {
		return nil, conflict("The platform did not return this post's engagement; try again later.")
	}
	return c.RecordDraftPostMetrics(ctx, actor, postID, metrics)
}

// LivePostRef is what reading a live post's engagement needs.
type LivePostRef struct {
	ConnectionExternalID string
	OrganizationID       string
	Platform             string
	PostID               string
	RemotePostID         string
	SecretReference      string
}

// LiveDraftPost finds a live draft post to read its engagement.
func (c *Configuration) LiveDraftPost(ctx context.Context, actor Actor, postID string) (*LivePostRef, error) {
	if err := c.authorizeContentDrafts(ctx, actor, false); err != nil {
		return nil, err
	}
	post, err := c.client.ScheduledPost.Query().Where(scheduledpost.ID(postID), scheduledpost.OrganizationID(actor.OrganizationID),
		scheduledpost.ContentDraftIDNotNil()).WithChannelConnection().Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := requireVisibleDraftPost(ctx, c.client, actor, post); err != nil {
		return nil, err
	}
	if post.Status != scheduledpost.StatusPUBLISHED || post.RemotePostID == nil {
		return nil, conflict("Engagement is read once the post is live.")
	}
	connection := post.Edges.ChannelConnection
	return &LivePostRef{ConnectionExternalID: connection.ExternalAccountID, OrganizationID: post.OrganizationID,
		Platform: connection.Platform, PostID: post.ID, RemotePostID: *post.RemotePostID,
		SecretReference: connection.SecretReference}, nil
}

// RecordDraftPostMetrics keeps a live post's engagement as just read.
func (c *Configuration) RecordDraftPostMetrics(ctx context.Context, actor Actor, postID string, metrics postoptions.Metrics) (*ContentDraftPost, error) {
	if _, err := c.LiveDraftPost(ctx, actor, postID); err != nil {
		return nil, err
	}
	if !validMetrics(metrics) || len(metrics) == 0 {
		return nil, invalid("Provider returned no valid metrics.")
	}
	post, err := c.client.ScheduledPost.Query().Where(scheduledpost.ID(postID), scheduledpost.OrganizationID(actor.OrganizationID)).
		WithChannelConnection().Only(ctx)
	if err != nil {
		return nil, err
	}
	if err := saveSocialObservation(ctx, c.client, post.Edges.ChannelConnection, "post", post.ID, time.Now().UTC(), metrics, nil, nil); err != nil {
		return nil, err
	}
	saved, err := c.client.ScheduledPost.Get(ctx, post.ID)
	if err != nil {
		return nil, err
	}
	result := contentDraftPost(saved, post.Edges.ChannelConnection.Platform)
	return &result, nil
}
