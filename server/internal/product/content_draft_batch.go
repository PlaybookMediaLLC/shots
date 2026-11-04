package product

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentdraft"
)

// DraftBatchTimesInput previews up to contentBatchItemLimit instants without reserving or publishing.
type DraftBatchTimesInput struct {
	SocialSetID    string `json:"socialSetId"`
	Count          int    `json:"count"`
	Mode           string `json:"mode"`
	LocalTime      string `json:"localTime"`
	PostsPerDay    int    `json:"postsPerDay"`
	SpacingMinutes int    `json:"spacingMinutes"`
	ShiftMinutes   int    `json:"shiftMinutes"`
	Seed           string `json:"seed"`
}

func spreadTimes(input DraftBatchTimesInput, zone string, now time.Time) ([]time.Time, error) {
	if input.PostsPerDay < 1 || input.PostsPerDay > 24 || input.SpacingMinutes < 1 || input.SpacingMinutes > 1440 || input.ShiftMinutes < 0 || input.ShiftMinutes > 55 || input.ShiftMinutes%5 != 0 || len(input.Seed) < 16 || len(input.Seed) > 128 {
		return nil, invalid("Choose 1–24 posts per day, a positive spacing, and a shift from 0 to 55 minutes in 5-minute steps.")
	}
	start, err := time.Parse("2006-01-02T15:04", input.LocalTime)
	if err != nil {
		return nil, invalid("Start is a local date and time.")
	}
	// A day's posts may run past midnight, but must end before the next day's first post.
	if input.PostsPerDay*input.SpacingMinutes > 1440 {
		return nil, invalid("Space a day's posts so they fit in 24 hours.")
	}
	result := make([]time.Time, 0, input.Count)
	for i := 0; i < input.Count; i++ {
		shift := 0
		if input.ShiftMinutes > 0 {
			hash := sha256.Sum256([]byte(fmt.Sprintf("%s/%d", input.Seed, i)))
			shift = int(binary.BigEndian.Uint32(hash[:4])%uint32(input.ShiftMinutes/5+1)) * 5
		}
		wall := start.AddDate(0, 0, i/input.PostsPerDay).Add(time.Duration((i%input.PostsPerDay)*input.SpacingMinutes+shift) * time.Minute)
		at, err := resolveLocalTime(wall.Format("2006-01-02T15:04"), zone, "")
		var clocks *LocalTimeError
		if errors.As(err, &clocks) {
			// Name the post rather than guess which side of a clock change was meant.
			what := "a time the clocks skip"
			if clocks.Kind == "ambiguous" {
				what = "a time that happens twice as the clocks go back"
			}
			return nil, invalid(fmt.Sprintf("Post %d would be at %s, %s in %s. Choose another start time or spacing.", i+1, wall.Format("Jan 2 15:04"), what, zone))
		}
		if err != nil {
			return nil, err
		}
		if !at.After(now.Add(time.Minute)) {
			return nil, invalid("Every batch time must be in the future.")
		}
		if len(result) > 0 && !at.After(result[len(result)-1]) {
			return nil, invalid("Increase spacing or reduce the random shift so posts remain in order.")
		}
		result = append(result, at.UTC())
	}
	return result, nil
}

// PreviewDraftBatchTimes uses the same queue allocator and zone resolver as
// individual scheduling. Queue instants must be rechecked when committed.
func (c *Configuration) PreviewDraftBatchTimes(ctx context.Context, actor Actor, input DraftBatchTimesInput) ([]time.Time, error) {
	if err := c.authorizeContentDrafts(ctx, actor, false); err != nil {
		return nil, err
	}
	if input.Count < 1 || input.Count > contentBatchItemLimit {
		return nil, invalid(fmt.Sprintf("Select between 1 and %d drafts.", contentBatchItemLimit))
	}
	set, err := c.resolveSocialSet(ctx, actor, input.SocialSetID)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	if input.Mode == "spread" {
		return spreadTimes(input, set.TimeZone, now)
	}
	if input.Mode != "queue" {
		return nil, invalid("Choose queue or spread.")
	}
	free, err := freeQueueSlots(ctx, c.client, set, now)
	if err != nil {
		return nil, err
	}
	if len(free) < input.Count {
		return nil, conflict(fmt.Sprintf("The queue has %d free slots in the next twelve weeks. Select fewer drafts or add posting times.", len(free)))
	}
	return free[:input.Count], nil
}

// ValidateContentDraftSchedule checks a batch row without quota charges,
// revisions, queue mutations or provider writes. Scheduling rechecks all gates.
func (c *Configuration) ValidateContentDraftSchedule(ctx context.Context, actor Actor, id string, input ScheduleContentDraftInput) error {
	if err := c.authorizeDecision(ctx, actor, "owner", "admin", "publisher"); err != nil {
		return err
	}
	if err := c.requireWorkspaceFeature(ctx, actor.OrganizationID, contentDraftFeature); err != nil {
		return err
	}
	if err := validateDraftTargets(input); err != nil {
		return err
	}
	loaded, err := c.loadDraft(ctx, actor, id)
	if err != nil {
		return err
	}
	// Check what scheduling would send: oriented, provider-sized images too.
	if loaded.Version == input.Version {
		if err := c.prepareDraftMedia(ctx, actor, &input, loaded.AssetIds); err != nil {
			return err
		}
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	draft, err := visibleContentDraft(ctx, tx.Client(), actor, id)
	if err != nil {
		return err
	}
	if draft.Status == contentdraft.StatusArchived {
		return conflict("Restore this draft before scheduling.")
	}
	if draft.Version != input.Version {
		return &ContentDraftVersionConflictError{Current: draft.Version}
	}
	if err := c.requireDraftApproval(ctx, draft); err != nil {
		return err
	}
	if _, _, err := c.draftTargetConnections(ctx, tx, draft, input.Targets, draft.AssetIds); err != nil {
		return err
	}
	captions := []string{}
	for _, target := range input.Targets {
		captions = append(captions, target.Caption)
		for _, reply := range target.Replies {
			captions = append(captions, reply.Caption)
		}
	}
	return requireAllowedCopy(ctx, tx.BrandProfile, actor.OrganizationID, captions...)
}
