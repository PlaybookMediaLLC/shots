package publishing

import (
	"context"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/lucsky/cuid"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/postautomationrun"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/postdeletion"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
)

// DeletionPart is one record to remove from the platform, in removal order:
// thread parts last first, then follow-up replies, reposts to undo, the root.
type DeletionPart struct {
	Key      string
	Kind     string // post or repost
	RemoteID string
	Status   string
}

// DeletionPlan is a published post's parts and the connection that removes them.
type DeletionPlan struct {
	OrganizationID  string
	PostID          string
	DestinationID   string
	Platform        string
	SecretReference string
	Parts           []DeletionPart
}

// PlanDeletion records a pending receipt for each part of a live post (once)
// and cancels its pending follow-ups, so none runs after the delete. A
// replayed plan keeps the receipts it finds, so the workflow plans again to
// catch a follow-up that landed during the first pass. Only a PUBLISHED post
// with a remote ID qualifies.
func (r *Repository) PlanDeletion(ctx context.Context, organizationID, postID, requestedBy string) (*DeletionPlan, error) {
	post, err := r.client.ScheduledPost.Query().
		Where(scheduledpost.ID(postID), scheduledpost.OrganizationID(organizationID)).
		WithChannelConnection().Only(ctx)
	if ent.IsNotFound(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	connection := post.Edges.ChannelConnection
	if post.Status != scheduledpost.StatusPUBLISHED || post.RemotePostID == nil || *post.RemotePostID == "" || connection == nil {
		return nil, ErrInvalidState
	}
	if _, err := r.client.PostAutomationRun.Update().
		Where(postautomationrun.ScheduledPostID(postID), postautomationrun.StatusEQ(postautomationrun.StatusPending)).
		SetStatus(postautomationrun.StatusCancelled).Save(ctx); err != nil {
		return nil, err
	}
	runs, err := r.client.PostAutomationRun.Query().
		Where(postautomationrun.ScheduledPostID(postID), postautomationrun.StatusEQ(postautomationrun.StatusDone)).All(ctx)
	if err != nil {
		return nil, err
	}
	parts := deletionParts(*post.RemotePostID, post.ThreadProgress.Receipts, runs)
	for _, part := range parts {
		err := r.client.PostDeletion.Create().
			SetID(cuid.New()).SetOrganizationID(organizationID).SetScheduledPostID(postID).
			SetKey(part.Key).SetKind(postdeletion.Kind(part.Kind)).SetRemoteID(part.RemoteID).
			SetRequestedBy(requestedBy).Exec(ctx)
		if err != nil && !ent.IsConstraintError(err) {
			return nil, err
		}
	}
	rows, err := r.client.PostDeletion.Query().Where(postdeletion.ScheduledPostID(postID)).All(ctx)
	if err != nil {
		return nil, err
	}
	status := make(map[string]string, len(rows))
	for _, row := range rows {
		status[row.Key] = string(row.Status)
	}
	for i := range parts {
		parts[i].Status = status[parts[i].Key]
	}
	return &DeletionPlan{
		// The social account, as the publish job names it, not the connection row.
		OrganizationID: organizationID, PostID: postID, DestinationID: connection.ExternalAccountID,
		Platform: connection.Platform, SecretReference: connection.SecretReference, Parts: parts,
	}, nil
}

// deletionParts orders what Shots published for a post. A repost that its
// removal already undid is skipped; the root goes last.
func deletionParts(rootID string, thread []postoptions.ThreadReceipt, runs []*ent.PostAutomationRun) []DeletionPart {
	var parts []DeletionPart
	receipts := append([]postoptions.ThreadReceipt(nil), thread...)
	sort.Slice(receipts, func(i, j int) bool { return receipts[i].Position > receipts[j].Position })
	for _, receipt := range receipts {
		if receipt.RemoteID != "" && receipt.RemoteID != rootID {
			parts = append(parts, DeletionPart{Key: "thread:" + strconv.Itoa(receipt.Position), Kind: "post", RemoteID: receipt.RemoteID})
		}
	}
	undone := map[string]bool{}
	for _, run := range runs {
		if run.Kind == postautomationrun.KindUnretweet {
			undone[strings.TrimPrefix(run.Key, "un")] = true
		}
	}
	sort.Slice(runs, func(i, j int) bool { return runs[i].Key < runs[j].Key })
	for _, run := range runs {
		switch run.Kind {
		case postautomationrun.KindFirstComment, postautomationrun.KindPlug, postautomationrun.KindQuote:
			if run.RemoteID != nil && *run.RemoteID != "" {
				parts = append(parts, DeletionPart{Key: run.Key, Kind: "post", RemoteID: *run.RemoteID})
			}
		case postautomationrun.KindRetweet, postautomationrun.KindRepostAtLikes:
			if !undone[run.Key] {
				parts = append(parts, DeletionPart{Key: "repost:" + run.Key, Kind: "repost", RemoteID: rootID})
			}
		}
	}
	return append(parts, DeletionPart{Key: "root", Kind: "post", RemoteID: rootID})
}

// RecordDeletion counts a try of a pending part and settles it with status
// unless that is pending. It changes only a pending receipt.
func (r *Repository) RecordDeletion(ctx context.Context, postID, key, status, failureCode string) error {
	update := r.client.PostDeletion.Update().
		Where(postdeletion.ScheduledPostID(postID), postdeletion.Key(key), postdeletion.StatusEQ(postdeletion.StatusPending)).
		AddAttempts(1).SetStatus(postdeletion.Status(status))
	if failureCode != "" {
		update.SetFailureCode(failureCode)
	} else {
		update.ClearFailureCode()
	}
	_, err := update.Save(ctx)
	return err
}

// SettleDeletion marks the post deleted once its root part is done, and
// reports whether it is.
func (r *Repository) SettleDeletion(ctx context.Context, postID string) (bool, error) {
	root, err := r.client.PostDeletion.Query().
		Where(postdeletion.ScheduledPostID(postID), postdeletion.Key("root")).Only(ctx)
	if ent.IsNotFound(err) {
		return false, nil
	}
	if err != nil || root.Status != postdeletion.StatusDone {
		return false, err
	}
	_, err = r.client.ScheduledPost.Update().
		Where(scheduledpost.ID(postID), scheduledpost.DeletedAtIsNil()).
		SetDeletedAt(time.Now()).Save(ctx)
	return err == nil, err
}
