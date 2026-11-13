package product

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"slices"
	"sort"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/calendarmutation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentdraft"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

// CalendarPlacement names the exact content and calendar revisions being moved.
type CalendarPlacement struct {
	DraftID         string     `json:"draftId"`
	Version         int        `json:"version"`
	CalendarVersion int        `json:"calendarVersion"`
	PostID          string     `json:"postId,omitempty"`
	At              *time.Time `json:"at"`
	TimeZone        string     `json:"timeZone"`
}

// CalendarCommand changes one placement or swaps two compatible placements atomically.
type CalendarCommand struct {
	Key    string              `json:"key"`
	Action string              `json:"action"`
	Items  []CalendarPlacement `json:"items"`
}

// CalendarResult is durable even when a workflow wakeup fails. The existing dispatcher
// recovers scheduled rows; cancelled rows cannot be claimed. Undo is another CAS command.
type CalendarResult struct {
	Drafts    []ContentDraftRecord `json:"drafts"`
	Posts     []ContentDraftPost   `json:"posts"`
	Undo      []CalendarPlacement  `json:"undo"`
	Cancelled []string             `json:"-"`
	Scheduled []*ent.ScheduledPost `json:"-"`
}

// Receipt keys are scoped to the authenticated principal, never globally reserved by client input.
func calendarReceiptID(actor Actor, key string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(actor.OrganizationID+"\x00"+actor.UserID+"\x00"+key)))
}

// beginDraftCreation shares the calendar receipt ledger so a lost creation response
// can be retried without making another draft. Visibility is rechecked on replay.
func beginDraftCreation(ctx context.Context, tx *ent.Tx, actor Actor, input ContentDraftInput) (*ContentDraftRecord, string, error) {
	if input.RequestKey == "" {
		return nil, "", nil
	}
	if !contentDraftRefPattern.MatchString(input.RequestKey) {
		return nil, "", invalid("Invalid creation request key.")
	}
	raw, _ := json.Marshal(input)
	hash := fmt.Sprintf("create:%x", sha256.Sum256(raw))
	if _, err := tx.PlatformExec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "calendar:"+actor.OrganizationID+":"+input.RequestKey); err != nil {
		return nil, "", err
	}
	receipt, err := tx.CalendarMutation.Query().Where(calendarmutation.ID(calendarReceiptID(actor, input.RequestKey)), calendarmutation.OrganizationID(actor.OrganizationID), calendarmutation.ActorID(actor.UserID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, hash, nil
	}
	if err != nil {
		return nil, "", err
	}
	if receipt.InputHash != hash {
		return nil, "", conflict("This request key was already used for different content.")
	}
	id, _ := receipt.Result["draftId"].(string)
	row, err := visibleContentDraft(ctx, tx.Client(), actor, id)
	if err != nil {
		return nil, "", err
	}
	result := contentDraftRecord(row)
	return &result, hash, nil
}

// beginDraftReuse protects published-content reuse against lost responses.
func beginDraftReuse(ctx context.Context, tx *ent.Tx, actor Actor, source, key string) (*ContentDraftCopyResult, string, error) {
	if key == "" {
		return nil, "", nil
	}
	if !contentDraftRefPattern.MatchString(key) {
		return nil, "", invalid("Invalid reuse request key.")
	}
	hash := fmt.Sprintf("duplicate:%x", sha256.Sum256([]byte(source)))
	if _, err := tx.PlatformExec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "calendar:"+actor.OrganizationID+":"+key); err != nil {
		return nil, "", err
	}
	receipt, err := tx.CalendarMutation.Query().Where(calendarmutation.ID(calendarReceiptID(actor, key)), calendarmutation.OrganizationID(actor.OrganizationID), calendarmutation.ActorID(actor.UserID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, hash, nil
	}
	if err != nil {
		return nil, "", err
	}
	if receipt.InputHash != hash {
		return nil, "", conflict("This reuse request key was already used for different content.")
	}
	var result ContentDraftCopyResult
	data, _ := json.Marshal(receipt.Result)
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, "", err
	}
	row, err := visibleContentDraft(ctx, tx.Client(), actor, result.Draft.ID)
	if err != nil {
		return nil, "", err
	}
	result.Draft = contentDraftRecord(row)
	return &result, hash, nil
}

func hasDraftPublicationCommitment(ctx context.Context, client *ent.Client, id string) (bool, error) {
	return client.ScheduledPost.Query().Where(scheduledpost.ContentDraftID(id), scheduledpost.Or(
		scheduledpost.StatusIn(scheduledpost.StatusSCHEDULED, scheduledpost.StatusPROCESSING, scheduledpost.StatusUNKNOWN_DELIVERY, scheduledpost.StatusPUBLISHED),
		scheduledpost.RemotePostIDNEQ(""),
	)).Exist(ctx)
}

// A draft flag alone is never evidence that a publication commitment disappeared.
func ensureDraftCanPlan(ctx context.Context, client *ent.Client, id string) error {
	committed, err := hasDraftPublicationCommitment(ctx, client, id)
	if err != nil {
		return err
	}
	if committed {
		return conflict("Unschedule active publications or duplicate published content before planning it.")
	}
	return nil
}

func ensurePlanningDestinations(ctx context.Context, client *ent.Client, draft *ent.ContentDraft) error {
	if len(draft.ChannelConnectionIds) == 0 {
		return conflict("Select a connected destination in the editor before planning.")
	}
	count, err := client.ChannelConnection.Query().Where(channelconnection.IDIn(draft.ChannelConnectionIds...), channelconnection.OrganizationID(draft.OrganizationID), channelconnection.StatusEQ(channelconnection.StatusACTIVE)).Count(ctx)
	if err != nil {
		return err
	}
	if count != len(draft.ChannelConnectionIds) {
		return conflict("A selected account is disconnected. Reconnect it or update the draft's destinations in the editor.")
	}
	return nil
}

// MutateCalendar preserves publication state on movement and rejects stale inverse moves.
func (c *Configuration) MutateCalendar(ctx context.Context, actor Actor, input CalendarCommand) (*CalendarResult, error) {
	if err := c.authorizeContentDrafts(ctx, actor, false); err != nil {
		return nil, err
	}
	if len(input.Items) < 1 || len(input.Items) > 2 || !contentDraftRefPattern.MatchString(input.Key) {
		return nil, invalid("A calendar change needs a unique key and one or two placements.")
	}
	if !oneOf(input.Action, "move", "swap", "unschedule", "remove_date") {
		return nil, invalid("Unknown calendar action.")
	}
	if input.Action == "swap" && len(input.Items) != 2 || input.Action != "swap" && len(input.Items) != 1 {
		return nil, invalid("Only a swap changes two placements.")
	}
	needsPublish := input.Action == "unschedule"
	for _, item := range input.Items {
		if item.PostID != "" {
			needsPublish = true
		}
	}
	needsEdit := false
	for _, item := range input.Items {
		if item.PostID == "" {
			needsEdit = true
		}
	}
	if needsEdit {
		if err := c.authorizeContentDrafts(ctx, actor, true); err != nil {
			return nil, err
		}
	}
	if needsPublish {
		if err := c.authorizeScheduling(ctx, actor); err != nil {
			return nil, err
		}
	}
	if input.Action == "swap" {
		if err := c.requireWorkspaceFeature(ctx, actor.OrganizationID, advancedSchedulingFeature); err != nil {
			return nil, err
		}
	}
	encoded, _ := json.Marshal(input)
	hash := fmt.Sprintf("%x", sha256.Sum256(encoded))
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	// Lock the command key before checking replay, including first use.
	if _, err = tx.PlatformExec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "calendar:"+actor.OrganizationID+":"+input.Key); err != nil {
		return nil, err
	}
	receipt, err := tx.CalendarMutation.Query().Where(calendarmutation.ID(calendarReceiptID(actor, input.Key)), calendarmutation.OrganizationID(actor.OrganizationID), calendarmutation.ActorID(actor.UserID)).Only(ctx)
	if err == nil {
		for _, item := range input.Items {
			if _, e := visibleContentDraft(ctx, tx.Client(), actor, item.DraftID); e != nil {
				return nil, e
			}
		}
		if receipt.InputHash != hash {
			return nil, conflict("This calendar request key was already used for another change.")
		}
		var result CalendarResult
		b, _ := json.Marshal(receipt.Result)
		if err = json.Unmarshal(b, &result); err != nil {
			return nil, err
		}
		return &result, nil
	}
	if !ent.IsNotFound(err) {
		return nil, err
	}
	ordered := append([]CalendarPlacement(nil), input.Items...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].DraftID < ordered[j].DraftID })
	if len(ordered) == 2 && ordered[0].DraftID == ordered[1].DraftID {
		return nil, invalid("Swap different drafts from the same social set.")
	}
	drafts := map[string]*ent.ContentDraft{}
	for _, item := range ordered {
		if _, err = tx.PlatformExec(ctx, `SELECT id FROM content_draft WHERE id=$1 AND "organizationId"=$2 FOR UPDATE`, item.DraftID, actor.OrganizationID); err != nil {
			return nil, err
		}
		d, e := visibleContentDraft(ctx, tx.Client(), actor, item.DraftID)
		if e != nil {
			return nil, e
		}
		if d.Version != item.Version || d.CalendarVersion != item.CalendarVersion {
			return nil, conflict("This content changed. Reload before moving or undoing it.")
		}
		if d.Status == contentdraft.StatusArchived {
			return nil, conflict("Restore this draft first.")
		}
		drafts[d.ID] = d
	}
	if len(ordered) == 2 && !sameString(drafts[ordered[0].DraftID].SocialSetID, drafts[ordered[1].DraftID].SocialSetID) {
		return nil, invalid("Only content from the same social set can swap positions.")
	}
	if input.Action == "swap" {
		originals := make([]time.Time, 2)
		connections := make([]string, 2)
		for i, item := range input.Items {
			d := drafts[item.DraftID]
			if item.At == nil {
				return nil, invalid("A swap requires two dated placements.")
			}
			if item.PostID != "" {
				p, e := tx.ScheduledPost.Query().Where(scheduledpost.ID(item.PostID), scheduledpost.ContentDraftID(d.ID), scheduledpost.OrganizationID(actor.OrganizationID)).Only(ctx)
				if e != nil {
					return nil, notFound("Post not found.")
				}
				originals[i], connections[i] = p.ScheduledFor, p.ChannelConnectionID
				if p.SlotAt != nil {
					originals[i] = *p.SlotAt
				}
			} else if d.PlannedFor != nil {
				originals[i] = *d.PlannedFor
			} else {
				return nil, invalid("An undated draft has no position to swap.")
			}
		}
		if !input.Items[0].At.Equal(originals[1]) || !input.Items[1].At.Equal(originals[0]) {
			return nil, conflict("The positions changed. Reload before swapping.")
		}
		if connections[0] != "" && connections[1] != "" && connections[0] != connections[1] {
			return nil, invalid("Scheduled posts must belong to the same provider account to swap.")
		}
		for i, connection := range connections {
			if connection != "" && connections[1-i] == "" && !slices.Contains(drafts[input.Items[1-i].DraftID].ChannelConnectionIds, connection) {
				return nil, invalid("The planned draft must include the scheduled provider account to swap.")
			}
		}
	}
	result := &CalendarResult{Drafts: []ContentDraftRecord{}, Posts: []ContentDraftPost{}, Undo: []CalendarPlacement{}}
	for _, item := range input.Items {
		d := drafts[item.DraftID]
		update := tx.ContentDraft.Update().Where(contentdraft.ID(d.ID), contentdraft.CalendarVersion(item.CalendarVersion), contentdraft.Version(item.Version)).AddCalendarVersion(1).SetUpdatedAt(d.UpdatedAt)
		inverse := CalendarPlacement{DraftID: d.ID, Version: d.Version, CalendarVersion: d.CalendarVersion + 1, At: d.PlannedFor, TimeZone: item.TimeZone}
		if d.PlanTimeZone != nil {
			inverse.TimeZone = *d.PlanTimeZone
		}
		if input.Action == "unschedule" {
			if item.PostID == "" {
				return nil, invalid("Select the scheduled post to unschedule.")
			}
			posts, e := tx.ScheduledPost.Query().Where(scheduledpost.OrganizationID(actor.OrganizationID), scheduledpost.ContentDraftID(d.ID), scheduledpost.StatusIn(scheduledpost.StatusSCHEDULED, scheduledpost.StatusPROCESSING, scheduledpost.StatusUNKNOWN_DELIVERY)).All(ctx)
			if e != nil {
				return nil, e
			}
			var selected *ent.ScheduledPost
			for _, p := range posts {
				if p.ID == item.PostID {
					selected = p
				}
				if p.Status != scheduledpost.StatusSCHEDULED {
					return nil, conflict("Publication has started or needs reconciliation. Check its provider receipt first.")
				}
			}
			if selected == nil {
				return nil, conflict("This post is no longer scheduled.")
			}
			for _, p := range posts {
				count, e := tx.ScheduledPost.Update().Where(scheduledpost.ID(p.ID), scheduledpost.StatusEQ(scheduledpost.StatusSCHEDULED)).SetStatus(scheduledpost.StatusCANCELLED).Save(ctx)
				if e != nil {
					return nil, e
				}
				if count != 1 {
					return nil, publishing.ErrConflict
				}
				if e := recordProductActivity(ctx, tx, actor, "post.cancelled", "post.cancelled", "scheduled_post", p.ID,
					map[string]any{"contentDraftId": d.ID, "reason": "unscheduled"}); e != nil {
					return nil, e
				}
				result.Cancelled = append(result.Cancelled, p.ID)
			}
			published, e := tx.ScheduledPost.Query().Where(scheduledpost.OrganizationID(actor.OrganizationID), scheduledpost.ContentDraftID(d.ID), scheduledpost.RemotePostIDNotNil()).Exist(ctx)
			if e != nil {
				return nil, e
			}
			if published {
				return nil, conflict("This content has published results. Cancel its remaining targets in the editor and duplicate it to create a new plan.")
			}
			update.SetStatus(contentdraft.StatusDraft).SetPlannedFor(selected.ScheduledFor).SetPlanTimeZone("UTC")
			if selected.ScheduleTimeZone != nil {
				update.SetPlanTimeZone(*selected.ScheduleTimeZone)
			}
		} else if item.PostID != "" {
			if input.Action == "remove_date" || item.At == nil {
				return nil, conflict("Unschedule this content before removing its date.")
			}
			if !item.At.After(time.Now().Add(time.Minute)) {
				return nil, invalid("Pick a time at least one minute in the future.")
			}
			old, e := tx.ScheduledPost.Query().Where(scheduledpost.ID(item.PostID), scheduledpost.ContentDraftID(d.ID), scheduledpost.OrganizationID(actor.OrganizationID)).Only(ctx)
			if e != nil {
				return nil, notFound("Post not found.")
			}
			if _, e = time.LoadLocation(item.TimeZone); item.TimeZone == "" || e != nil {
				return nil, invalid("Choose an IANA scheduling timezone.")
			}
			moved, e := c.moveDraftPostTx(ctx, tx, actor, item.PostID, *item.At, item.TimeZone)
			if e != nil {
				return nil, e
			}
			moved.Post.ScheduleTimeZone = &item.TimeZone
			if old.ScheduleTimeZone != nil {
				inverse.TimeZone = *old.ScheduleTimeZone
			}
			inverse.PostID = moved.Post.ID
			inverse.At = &old.ScheduledFor
			if old.SlotAt != nil {
				inverse.At = old.SlotAt
			}
			result.Posts = append(result.Posts, moved.Post)
			result.Cancelled = append(result.Cancelled, moved.Cancelled)
			result.Scheduled = append(result.Scheduled, moved.Scheduled)
			if inverse.At == nil || inverse.At.After(time.Now().Add(time.Minute)) {
				result.Undo = append(result.Undo, inverse)
			}
		} else {
			if err := ensureDraftCanPlan(ctx, tx.Client(), d.ID); err != nil {
				return nil, err
			}
			if d.Status != contentdraft.StatusDraft {
				return nil, conflict("Unschedule or duplicate this content before planning it.")
			}
			if item.At == nil {
				update.ClearPlannedFor().ClearPlanTimeZone()
			} else {
				if err := ensurePlanningDestinations(ctx, tx.Client(), d); err != nil {
					return nil, err
				}
				if !item.At.After(time.Now()) {
					return nil, invalid("Plan for a future time.")
				}
				if _, e := time.LoadLocation(item.TimeZone); item.TimeZone == "" || e != nil {
					return nil, invalid("Choose an IANA scheduling timezone.")
				}
				update.SetPlannedFor(item.At.UTC()).SetPlanTimeZone(item.TimeZone)
			}
			if inverse.At == nil || inverse.At.After(time.Now().Add(time.Minute)) {
				result.Undo = append(result.Undo, inverse)
			}
		}
		count, e := update.Save(ctx)
		if e != nil {
			return nil, e
		}
		if count != 1 {
			return nil, publishing.ErrConflict
		}
		row, e := tx.ContentDraft.Get(ctx, d.ID)
		if e != nil {
			return nil, e
		}
		if e = recordContentDraftRevision(ctx, tx, actor, row, true, "calendar."+input.Action); e != nil {
			return nil, e
		}
		if e = appendConfigurationAudit(ctx, tx, actor, "product.content_draft_planned", "content_draft", d.ID, map[string]any{"action": input.Action, "key": input.Key, "at": item.At}); e != nil {
			return nil, e
		}
		if e = emitDraftChanges(ctx, tx, d, row); e != nil {
			return nil, e
		}
		result.Drafts = append(result.Drafts, contentDraftRecord(row))
	}
	if input.Action == "swap" && len(result.Undo) != 2 {
		result.Undo = []CalendarPlacement{}
	}
	raw, _ := json.Marshal(result)
	saved := map[string]any{}
	_ = json.Unmarshal(raw, &saved)
	if _, err = tx.CalendarMutation.Create().SetID(calendarReceiptID(actor, input.Key)).SetOrganizationID(actor.OrganizationID).SetActorID(actor.UserID).SetInputHash(hash).SetResult(saved).Save(ctx); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return result, nil
}
