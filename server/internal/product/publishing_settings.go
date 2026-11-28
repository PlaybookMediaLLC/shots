package product

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"strings"
	"time"

	entsql "entgo.io/ent/dialect/sql"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/organization"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/socialset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/workspacesettings"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

// NullableInt distinguishes an omitted integer field from an explicit null.
type NullableInt struct {
	Set   bool
	Value *int
}

func (n *NullableInt) UnmarshalJSON(data []byte) error {
	n.Set = true
	if bytes.Equal(data, []byte("null")) {
		n.Value = nil
		return nil
	}
	return json.Unmarshal(data, &n.Value)
}

// VideoProcessingAvailable reports whether this deployment has server-side
// video transcoding enabled (VIDEO_PROCESSING_ENABLED=true or 1).
func VideoProcessingAvailable() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("VIDEO_PROCESSING_ENABLED")))
	return v == "true" || v == "1"
}

// UpdateWorkspacePublishingSettingsInput updates workspace-wide publishing
// preferences without touching organization identity fields.
type UpdateWorkspacePublishingSettingsInput struct {
	WeeklyPostingGoal     NullableInt `json:"weeklyPostingGoal"`
	ProcessVideosOnServer *bool       `json:"processVideosOnServer"`
}

// UpdateWorkspacePublishingSettings persists workspace weekly posting goal and
// server-side video processing defaults for future posts.
func (c *Configuration) UpdateWorkspacePublishingSettings(ctx context.Context, actor Actor, input UpdateWorkspacePublishingSettingsInput) (*Workspace, error) {
	if input.WeeklyPostingGoal.Set && input.WeeklyPostingGoal.Value != nil {
		goal := *input.WeeklyPostingGoal.Value
		if goal < 1 || goal > 1000 {
			return nil, invalid("Weekly posting goal must be between 1 and 1000 posts per week.")
		}
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := workspaceAdministrator(ctx, tx, actor, "workspace:update"); err != nil {
		return nil, err
	}
	org, err := tx.Organization.Query().Where(organization.ID(actor.OrganizationID), func(s *entsql.Selector) { s.ForUpdate() }).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	settings, err := tx.WorkspaceSettings.Query().Where(workspacesettings.ID(org.ID), func(s *entsql.Selector) { s.ForUpdate() }).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	if settings == nil {
		settings, err = tx.WorkspaceSettings.Create().SetID(org.ID).Save(ctx)
		if err != nil {
			return nil, err
		}
	}
	settingsUpdate := tx.WorkspaceSettings.UpdateOneID(org.ID)
	goalChanged := false
	videoChanged := false
	if input.WeeklyPostingGoal.Set {
		if input.WeeklyPostingGoal.Value == nil {
			goalChanged = settings.WeeklyPostingGoal != nil
			settingsUpdate.ClearWeeklyPostingGoal()
		} else {
			goalChanged = settings.WeeklyPostingGoal == nil || *settings.WeeklyPostingGoal != *input.WeeklyPostingGoal.Value
			settingsUpdate.SetWeeklyPostingGoal(*input.WeeklyPostingGoal.Value)
		}
	}
	if input.ProcessVideosOnServer != nil {
		videoChanged = *input.ProcessVideosOnServer != settings.ProcessVideosOnServer
		settingsUpdate.SetProcessVideosOnServer(*input.ProcessVideosOnServer)
	}
	settings, err = settingsUpdate.Save(ctx)
	if err != nil {
		return nil, err
	}
	if goalChanged {
		meta := map[string]any{"weeklyPostingGoal": settings.WeeklyPostingGoal}
		if err := appendConfigurationAudit(ctx, tx, actor, "product.workspace_weekly_goal_updated", "organization", org.ID, meta); err != nil {
			return nil, err
		}
	}
	if videoChanged {
		meta := map[string]any{"processVideosOnServer": settings.ProcessVideosOnServer}
		if err := appendConfigurationAudit(ctx, tx, actor, "product.workspace_video_processing_updated", "organization", org.ID, meta); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &Workspace{ID: org.ID, CreatedAt: org.CreatedAt, Logo: org.Logo, Name: org.Name, Slug: org.Slug, WorkspaceSettings: settings.Unwrap()}, nil
}

// WeeklyGoalProgress summarizes the workspace's current-week publishing volume
// against its configured weekly posting goal.
type WeeklyGoalProgress struct {
	Goal           *int      `json:"goal"`
	PublishedCount int       `json:"publishedCount"`
	ScheduledCount int       `json:"scheduledCount"`
	TotalCount     int       `json:"totalCount"`
	WeekStart      time.Time `json:"weekStart"`
	WeekEnd        time.Time `json:"weekEnd"`
	TimeZone       string    `json:"timeZone"`
}

// localWeekBounds returns the [start, end) UTC instants for the week containing
// now in zone, starting on Monday (default) or Sunday. Computing endLocal via
// calendar components avoids 1-hour overlaps across midnight DST transitions.
func localWeekBounds(now time.Time, zone *time.Location, weekStart string) (time.Time, time.Time) {
	local := now.In(zone)
	offsetDays := (int(local.Weekday()) + 6) % 7 // Monday = 0
	if weekStart == "sunday" {
		offsetDays = int(local.Weekday()) // Sunday = 0
	}
	startDay := local.Day() - offsetDays
	startLocal := time.Date(local.Year(), local.Month(), startDay, 0, 0, 0, 0, zone)
	endLocal := time.Date(local.Year(), local.Month(), startDay+7, 0, 0, 0, 0, zone)
	return startLocal.UTC(), endLocal.UTC()
}

// GetWeeklyGoalProgress counts published and scheduled posts in the current
// workspace week, respecting private social-set visibility boundaries.
func (c *Configuration) GetWeeklyGoalProgress(ctx context.Context, actor Actor, weekStart string) (*WeeklyGoalProgress, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	if err := requireNotDenied(ctx, c.client, actor, "workspace:read"); err != nil {
		return nil, err
	}
	if err := requireNotDenied(ctx, c.client, actor, "artifact:read"); err != nil {
		return nil, err
	}
	if weekStart != "sunday" {
		weekStart = "monday"
	}
	settings, err := c.client.WorkspaceSettings.Query().Where(workspacesettings.ID(actor.OrganizationID)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	tzName := "UTC"
	var goal *int
	if settings != nil {
		if settings.TimeZone != "" {
			tzName = settings.TimeZone
		}
		goal = settings.WeeklyPostingGoal
	}
	zone, err := time.LoadLocation(tzName)
	if err != nil {
		zone = time.UTC
		tzName = "UTC"
	}
	start, end := localWeekBounds(time.Now().UTC(), zone, weekStart)
	if goal == nil {
		return &WeeklyGoalProgress{
			Goal:      nil,
			WeekStart: start,
			WeekEnd:   end,
			TimeZone:  tzName,
		}, nil
	}

	// Collect private social sets owned by OTHER users (or orphaned with NULL
	// owner) so neither draft posts nor campaign posts on those channels leak.
	privateQuery := c.client.SocialSet.Query().Where(
		socialset.OrganizationID(actor.OrganizationID),
		socialset.VisibilityEQ(socialset.VisibilityPRIVATE),
	)
	if actor.IsSession() && actor.UserID != "" {
		privateQuery = privateQuery.Where(socialset.Or(
			socialset.OwnerUserIDIsNil(),
			socialset.OwnerUserIDNEQ(actor.UserID),
		))
	}
	hiddenSetIDs, err := privateQuery.IDs(ctx)
	if err != nil {
		return nil, err
	}

	postQuery := c.client.ScheduledPost.Query().Where(
		scheduledpost.OrganizationID(actor.OrganizationID),
		scheduledpost.StatusIn(
			scheduledpost.StatusSCHEDULED,
			scheduledpost.StatusPROCESSING,
			scheduledpost.StatusPUBLISHED,
			scheduledpost.StatusSENT_TO_APP,
		),
		scheduledpost.ScheduledForGTE(start),
		scheduledpost.ScheduledForLT(end),
	)
	if len(hiddenSetIDs) > 0 {
		postQuery = postQuery.Where(
			scheduledpost.Or(
				scheduledpost.SocialSetIDIsNil(),
				scheduledpost.SocialSetIDNotIn(hiddenSetIDs...),
			),
			scheduledpost.HasChannelConnectionWith(
				channelconnection.Or(
					channelconnection.SocialSetIDIsNil(),
					channelconnection.SocialSetIDNotIn(hiddenSetIDs...),
				),
			),
		)
	}
	rows, err := postQuery.Select(
		scheduledpost.FieldID,
		scheduledpost.FieldContentDraftID,
		scheduledpost.FieldStatus,
	).All(ctx)
	if err != nil {
		return nil, err
	}

	// Count distinct publishing intents (one draft counts once even across multiple platforms).
	publishedUnits := map[string]struct{}{}
	scheduledUnits := map[string]struct{}{}
	for _, row := range rows {
		unitKey := "post:" + row.ID
		if row.ContentDraftID != nil && *row.ContentDraftID != "" {
			unitKey = "draft:" + *row.ContentDraftID
		}
		switch row.Status {
		case scheduledpost.StatusPUBLISHED, scheduledpost.StatusSENT_TO_APP:
			publishedUnits[unitKey] = struct{}{}
		case scheduledpost.StatusSCHEDULED, scheduledpost.StatusPROCESSING:
			scheduledUnits[unitKey] = struct{}{}
		}
	}
	// If a draft has both a published platform and a still-scheduled platform, count it once as published.
	for k := range publishedUnits {
		delete(scheduledUnits, k)
	}
	return &WeeklyGoalProgress{
		Goal:           goal,
		PublishedCount: len(publishedUnits),
		ScheduledCount: len(scheduledUnits),
		TotalCount:     len(publishedUnits) + len(scheduledUnits),
		WeekStart:      start,
		WeekEnd:        end,
		TimeZone:       tzName,
	}, nil
}
