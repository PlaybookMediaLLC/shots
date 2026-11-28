package publishing

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/activity"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
)

// PublishSummaryOutcome is the redacted per-platform outcome stored in the
// post.publish_summary activity payload (no post copy, tokens, or raw errors).
type PublishSummaryOutcome struct {
	Platform    string `json:"platform"`
	Handle      string `json:"handle,omitempty"`
	Status      string `json:"status"`
	RemoteURL   string `json:"remoteUrl,omitempty"`
	FailureCode string `json:"failureCode,omitempty"`
}

// EmitPublishGroupSummary checks whether every sibling ScheduledPost sharing a
// publishGroupId has reached a terminal status, and if so emits exactly one
// post.publish_summary outbox event inside tx. Must be called inside the
// terminal state-transition transaction before Commit.
func EmitPublishGroupSummary(ctx context.Context, tx *ent.Tx, organizationID, postID string) error {
	return emitPublishGroupSummary(ctx, tx, organizationID, postID)
}

func emitPublishGroupSummary(ctx context.Context, tx *ent.Tx, organizationID, postID string) error {
	post, err := tx.ScheduledPost.Query().
		Where(scheduledpost.ID(postID), scheduledpost.OrganizationID(organizationID)).
		Select(
			scheduledpost.FieldID,
			scheduledpost.FieldOrganizationID,
			scheduledpost.FieldPublishGroupID,
			scheduledpost.FieldContentDraftID,
		).
		Only(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return nil
		}
		return err
	}
	if post.PublishGroupID == nil || *post.PublishGroupID == "" {
		return nil
	}
	groupID := *post.PublishGroupID
	// 64-bit transaction-scoped advisory lock serializes concurrent sibling settlements.
	if _, err := tx.PlatformExec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('publish-summary:' || $1, 0))`, groupID); err != nil {
		return err
	}
	siblings, err := tx.ScheduledPost.Query().
		Where(
			scheduledpost.OrganizationID(organizationID),
			scheduledpost.PublishGroupID(groupID),
		).
		Select(
			scheduledpost.FieldID,
			scheduledpost.FieldStatus,
			scheduledpost.FieldChannelConnectionID,
			scheduledpost.FieldRemotePostID,
			scheduledpost.FieldThreadProgress,
			scheduledpost.FieldFailureCode,
			scheduledpost.FieldScheduledByUserID,
		).
		All(ctx)
	if err != nil || len(siblings) == 0 {
		return err
	}

	// Fast check: wait if any sibling is still pending or in flight.
	for _, sibling := range siblings {
		switch sibling.Status {
		case scheduledpost.StatusDRAFT, scheduledpost.StatusSCHEDULED, scheduledpost.StatusPROCESSING:
			return nil
		}
	}

	// Only load channel connections once every sibling is settled.
	connIDs := make([]string, 0, len(siblings))
	connSeen := map[string]struct{}{}
	for _, sibling := range siblings {
		if sibling.ChannelConnectionID != "" {
			if _, ok := connSeen[sibling.ChannelConnectionID]; !ok {
				connSeen[sibling.ChannelConnectionID] = struct{}{}
				connIDs = append(connIDs, sibling.ChannelConnectionID)
			}
		}
	}
	connByID := map[string]*ent.ChannelConnection{}
	if len(connIDs) > 0 {
		conns, err := tx.ChannelConnection.Query().
			Where(channelconnection.OrganizationID(organizationID), channelconnection.IDIn(connIDs...)).
			Select(channelconnection.FieldID, channelconnection.FieldPlatform, channelconnection.FieldHandle, channelconnection.FieldDisplayName).
			All(ctx)
		if err != nil {
			return err
		}
		for _, conn := range conns {
			connByID[conn.ID] = conn
		}
	}

	outcomes := make([]PublishSummaryOutcome, 0, len(siblings))
	recipientSet := map[string]struct{}{}
	succeeded, sentToApp, failed, unknown, cancelled := 0, 0, 0, 0, 0
	for _, sibling := range siblings {
		if sibling.ScheduledByUserID != nil {
			uid := strings.TrimSpace(*sibling.ScheduledByUserID)
			if uid != "" && !strings.HasPrefix(uid, "api-key:") {
				recipientSet[uid] = struct{}{}
			}
		}
		switch sibling.Status {
		case scheduledpost.StatusPUBLISHED:
			succeeded++
		case scheduledpost.StatusSENT_TO_APP:
			sentToApp++
		case scheduledpost.StatusFAILED:
			failed++
		case scheduledpost.StatusUNKNOWN_DELIVERY:
			unknown++
		case scheduledpost.StatusCANCELLED:
			cancelled++
			continue
		}
		platform := "unknown"
		handle := ""
		if conn := connByID[sibling.ChannelConnectionID]; conn != nil {
			platform = conn.Platform
			if conn.Handle != nil && *conn.Handle != "" {
				handle = *conn.Handle
			} else if conn.DisplayName != nil {
				handle = *conn.DisplayName
			}
		}
		remoteURL := ""
		if sibling.RemotePostID != nil {
			if resolved := postoptions.PostURL(platform, sibling.RemotePostID, sibling.ThreadProgress); resolved != nil {
				remoteURL = *resolved
			}
		}
		failureCode := ""
		if sibling.FailureCode != nil {
			failureCode = *sibling.FailureCode
		}
		outcomes = append(outcomes, PublishSummaryOutcome{
			Platform:    platform,
			Handle:      handle,
			Status:      string(sibling.Status),
			RemoteURL:   remoteURL,
			FailureCode: failureCode,
		})
	}
	// If every sibling was cancelled before publishing, do not send a summary email.
	if len(outcomes) == 0 && cancelled > 0 {
		return nil
	}
	sort.Slice(outcomes, func(i, j int) bool {
		if outcomes[i].Platform != outcomes[j].Platform {
			return outcomes[i].Platform < outcomes[j].Platform
		}
		return outcomes[i].Handle < outcomes[j].Handle
	})
	recipientUserIDs := make([]string, 0, len(recipientSet))
	for uid := range recipientSet {
		recipientUserIDs = append(recipientUserIDs, uid)
	}
	sort.Strings(recipientUserIDs)

	entityType := "scheduled_post"
	entityID := post.ID
	if post.ContentDraftID != nil && *post.ContentDraftID != "" {
		entityType = "content_draft"
		entityID = *post.ContentDraftID
	}
	payload := map[string]any{
		"publishGroupId": groupID,
		"publishedCount": succeeded,
		"sentToAppCount": sentToApp,
		"failedCount":    failed,
		"unknownCount":   unknown,
		"cancelledCount": cancelled,
		"outcomes":       outcomes,
	}
	if len(recipientUserIDs) > 0 {
		payload["recipientUserIds"] = recipientUserIDs
	}
	return activity.Emit(
		ctx,
		tx,
		organizationID,
		"post.publish_summary",
		entityType,
		entityID,
		"",
		fmt.Sprintf("publish-group:%s", groupID),
		payload,
	)
}
