package publishing

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"

	entsql "entgo.io/ent/dialect/sql"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/activity"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/approval"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/auditlog"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentdraft"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/creativevariant"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/postautomationrun"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/publicationattempt"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/socialset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/socialtenantbinding"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/workspacedeletion"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/telemetry"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/workspaceplan"
	"github.com/lucsky/cuid"
)

type Repository struct{ client *ent.Client }

func NewRepository(client *ent.Client) *Repository { return &Repository{client: client} }

func (r *Repository) Ping(ctx context.Context) error {
	_, err := r.client.ChannelConnection.Query().Limit(1).IDs(ctx)
	return err
}

func (r *Repository) Binding(ctx context.Context, organizationID string) (*ent.SocialTenantBinding, error) {
	binding, err := r.client.SocialTenantBinding.Query().Where(socialtenantbinding.ID(organizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, ErrNotFound
	}
	return binding, err
}

func (r *Repository) CreateConnection(ctx context.Context, actor Actor, input CreateConnectionInput) (*ent.ChannelConnection, error) {
	tx, err := r.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if found, err := workspaceplan.LockWorkspace(ctx, tx, actor.Organization); err != nil {
		return nil, err
	} else if !found {
		return nil, ErrNotFound
	}
	if err := workspaceplan.RequireChannel(ctx, tx.Client(), actor.Organization, input.ExternalAccountID); err != nil {
		return nil, err
	}
	setID, err := targetSocialSet(ctx, tx, actor.Organization, input.Platform, input.SocialSetID)
	if err != nil {
		return nil, err
	}
	connection, err := tx.ChannelConnection.Create().
		SetID(cuid.New()).
		SetOrganizationID(actor.Organization).
		SetProvider("social").
		SetExternalAccountID(input.ExternalAccountID).
		SetPlatform(input.Platform).
		SetProviderSettings(input.ProviderSettings).
		SetSecretReference(input.SecretReference).
		SetStatus(channelconnection.StatusACTIVE).
		SetNillableSocialSetID(setID).
		SetCreatedByUserID(actor.UserID).
		Save(ctx)
	if err != nil {
		if ent.IsConstraintError(err) {
			return nil, ErrConflict
		}
		return nil, err
	}
	if err := enableDefaultPlatform(ctx, tx, setID, input.Platform); err != nil {
		return nil, err
	}
	if err := activity.Emit(ctx, tx, actor.Organization, "integration.connected", "channel_connection", connection.ID, actor.UserID, "connected:"+connection.ID, map[string]any{"ownerUserId": actor.UserID}); err != nil {
		return nil, err
	}
	if err := appendAudit(ctx, tx, auditInput{
		Action: "post.connection_created", Actor: actor, EntityID: connection.ID,
		EntityType: "channel_connection", Organization: actor.Organization, Outcome: auditlog.OutcomeSUCCEEDED,
	}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return connection.Unwrap(), nil
}

// SetConnectionProfile records how the account shows on its platform.
func (r *Repository) SetConnectionProfile(ctx context.Context, id, name, handle, avatar string) (*ent.ChannelConnection, error) {
	update := r.client.ChannelConnection.UpdateOneID(id)
	if name != "" {
		update.SetDisplayName(name)
	}
	if handle != "" {
		update.SetHandle(handle)
	}
	if avatar != "" {
		update.SetAvatarURL(avatar)
	}
	return update.Save(ctx)
}

func (r *Repository) ListConnections(ctx context.Context, organizationID string) ([]*ent.ChannelConnection, error) {
	return r.client.ChannelConnection.Query().
		Where(channelconnection.OrganizationID(organizationID)).
		Order(ent.Desc(channelconnection.FieldCreatedAt)).
		All(ctx)
}

func (r *Repository) CreateScheduledPost(ctx context.Context, actor Actor, input CreateScheduledPostInput) (CreateScheduledPostResult, error) {
	existing, err := r.client.ScheduledPost.Query().Where(
		scheduledpost.OrganizationID(actor.Organization),
		scheduledpost.ChannelConnectionID(input.ChannelConnectionID),
		scheduledpost.IdempotencyKey(input.IdempotencyKey),
	).Only(ctx)
	if err == nil {
		return replayScheduledPost(existing, input)
	}
	if !ent.IsNotFound(err) {
		return CreateScheduledPostResult{}, err
	}

	connectionExists, err := r.client.ChannelConnection.Query().Where(
		channelconnection.ID(input.ChannelConnectionID),
		channelconnection.OrganizationID(actor.Organization),
	).Exist(ctx)
	if err != nil {
		return CreateScheduledPostResult{}, err
	}
	if (input.VariantID == "") == (input.ContentDraftID == "") {
		return CreateScheduledPostResult{}, ErrNotEligible
	}
	var sourceExists bool
	if input.ContentDraftID != "" {
		sourceExists, err = r.client.ContentDraft.Query().Where(contentdraft.ID(input.ContentDraftID),
			contentdraft.OrganizationID(actor.Organization), contentdraft.StatusNEQ(contentdraft.StatusArchived)).Exist(ctx)
	} else {
		sourceExists, err = r.client.CreativeVariant.Query().Where(
			creativevariant.ID(input.VariantID),
			creativevariant.OrganizationID(actor.Organization),
		).Exist(ctx)
	}
	if err != nil {
		return CreateScheduledPostResult{}, err
	}
	if !connectionExists || !sourceExists {
		return CreateScheduledPostResult{}, ErrNotFound
	}

	eligible, err := r.isEligible(ctx, actor.Organization, input.VariantID, input.ChannelConnectionID)
	if err != nil {
		return CreateScheduledPostResult{}, err
	}
	if !eligible {
		return CreateScheduledPostResult{}, ErrNotEligible
	}

	tx, err := r.client.Tx(ctx)
	if err != nil {
		return CreateScheduledPostResult{}, err
	}
	defer tx.Rollback()
	post, err := tx.ScheduledPost.Create().
		SetID(cuid.New()).
		SetOrganizationID(actor.Organization).
		SetNillableVariantID(nonEmpty(input.VariantID)).
		SetNillableContentDraftID(nonEmpty(input.ContentDraftID)).
		SetChannelConnectionID(input.ChannelConnectionID).
		SetScheduledFor(input.ScheduledFor.UTC()).
		SetStatus(scheduledpost.StatusSCHEDULED).
		SetCaption(input.Caption).
		SetIdempotencyKey(input.IdempotencyKey).
		SetNillableScheduledByUserID(input.ScheduledBy).
		Save(ctx)
	if err != nil {
		if ent.IsConstraintError(err) {
			existing, findErr := r.client.ScheduledPost.Query().Where(
				scheduledpost.ChannelConnectionID(input.ChannelConnectionID),
				scheduledpost.IdempotencyKey(input.IdempotencyKey),
			).Only(ctx)
			if findErr == nil {
				return replayScheduledPost(existing, input)
			}
			return CreateScheduledPostResult{}, ErrConflict
		}
		return CreateScheduledPostResult{}, err
	}
	if err := recordPostActivity(ctx, tx, "post.scheduled", auditInput{
		Action: "post.scheduled", Actor: actor, EntityID: post.ID, EntityType: "scheduled_post",
		Organization: actor.Organization, Outcome: auditlog.OutcomeSUCCEEDED,
	}); err != nil {
		return CreateScheduledPostResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return CreateScheduledPostResult{}, err
	}
	return CreateScheduledPostResult{Created: true, Post: post.Unwrap()}, nil
}

// replayScheduledPost returns the post a key first scheduled. A caller's key
// names its request, so a retry gets the first post even when it recomputed
// the time or edited the caption (it never posts twice).
func replayScheduledPost(post *ent.ScheduledPost, input CreateScheduledPostInput) (CreateScheduledPostResult, error) {
	// A content key names a request, not a post: once that post was cancelled
	// or failed, answering with it would queue nothing. The caller sends a key.
	settled := post.Status == scheduledpost.StatusCANCELLED || post.Status == scheduledpost.StatusFAILED
	if settled && strings.HasPrefix(input.IdempotencyKey, "content:") {
		return CreateScheduledPostResult{}, ErrConflict
	}
	return CreateScheduledPostResult{Created: false, Post: post}, nil
}

// platformOf is a loaded post's platform, or empty when its connection is gone.
func platformOf(post *ent.ScheduledPost) string {
	if post.Edges.ChannelConnection == nil {
		return ""
	}
	return post.Edges.ChannelConnection.Platform
}

const maxMessageLen = 500

// RedactProviderMessage keeps a provider's failure message for support while
// dropping what must not be stored (telemetry.Scrub: signed URLs, tokens,
// credentials), bounded in size. It is never shown raw to members.
func RedactProviderMessage(message string) string {
	message = strings.Join(strings.Fields(telemetry.Scrub(message)), " ")
	if runes := []rune(message); len(runes) > maxMessageLen {
		message = string(runes[:maxMessageLen]) + "…"
	}
	return message
}

// ContentIdempotencyKey names a schedule request by its content, so a retry
// sent without an Idempotency-Key replays instead of posting twice.
func ContentIdempotencyKey(input CreateScheduledPostInput) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{input.VariantID, input.ContentDraftID, input.ChannelConnectionID,
		strings.TrimSpace(input.Caption), input.ScheduledFor.UTC().Truncate(time.Millisecond).Format(time.RFC3339Nano)}, "\x00")))
	return "content:" + hex.EncodeToString(sum[:])
}

func nonEmpty(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// isEligible checks the destination is active and, for a variant post, that
// the variant is approved. A content draft's approval is the product layer's:
// where a workspace requires one, drafts schedule only through its check.
func (r *Repository) isEligible(ctx context.Context, organizationID, variantID, connectionID string) (bool, error) {
	connectionExists, err := r.client.ChannelConnection.Query().Where(
		channelconnection.ID(connectionID),
		channelconnection.OrganizationID(organizationID),
		channelconnection.Provider("social"),
		channelconnection.StatusEQ(channelconnection.StatusACTIVE),
	).Exist(ctx)
	if err != nil || !connectionExists || variantID == "" {
		return connectionExists, err
	}
	return r.client.CreativeVariant.Query().Where(
		creativevariant.ID(variantID),
		creativevariant.OrganizationID(organizationID),
		creativevariant.StatusEQ(creativevariant.StatusAPPROVED),
		creativevariant.HasApprovalWith(approval.StatusEQ(approval.StatusAPPROVED)),
	).Exist(ctx)
}

// IsEligible rechecks the approved variant and active destination before a
// product campaign atomically links its post to a canonical scheduled post.
func (r *Repository) IsEligible(ctx context.Context, organizationID, variantID, connectionID string) (bool, error) {
	return r.isEligible(ctx, organizationID, variantID, connectionID)
}

// ListScheduledPosts reads the schedule, newest first, as viewer may see it:
// a person sees their own private sets; an API key (viewer "") sees none.
func (r *Repository) ListScheduledPosts(ctx context.Context, organizationID, viewer string, limit int) ([]*ent.ScheduledPost, error) {
	query := r.client.ScheduledPost.Query().Where(scheduledpost.OrganizationID(organizationID))
	if err := keepVisiblePosts(ctx, r.client, query, organizationID, viewer); err != nil {
		return nil, err
	}
	return query.WithChannelConnection().
		Order(ent.Desc(scheduledpost.FieldScheduledFor), ent.Desc(scheduledpost.FieldID)).
		Limit(limit).
		All(ctx)
}

// keepVisiblePosts limits query to posts outside the private sets viewer does
// not own, by the post's set and by its account's, which a campaign post
// without a set still has. An API key (viewer "") sees no private set.
func keepVisiblePosts(ctx context.Context, client *ent.Client, query *ent.ScheduledPostQuery, organizationID, viewer string) error {
	sets := client.SocialSet.Query().Where(socialset.OrganizationID(organizationID), socialset.VisibilityEQ(socialset.VisibilityPRIVATE))
	if viewer != "" {
		sets.Where(socialset.Or(socialset.OwnerUserIDIsNil(), socialset.OwnerUserIDNEQ(viewer)))
	}
	private, err := sets.IDs(ctx)
	if err != nil || len(private) == 0 {
		return err
	}
	query.Where(scheduledpost.Or(scheduledpost.SocialSetIDIsNil(), scheduledpost.SocialSetIDNotIn(private...)),
		scheduledpost.HasChannelConnectionWith(channelconnection.Or(channelconnection.SocialSetIDIsNil(), channelconnection.SocialSetIDNotIn(private...))))
	return nil
}

func (r *Repository) ListRecoverablePosts(ctx context.Context, since, dueBefore time.Time, limit int) ([]RecoverablePost, error) {
	posts, err := r.client.ScheduledPost.Query().Where(
		scheduledpost.StatusEQ(scheduledpost.StatusSCHEDULED),
		scheduledpost.ScheduledForGTE(since),
		scheduledpost.ScheduledForLTE(dueBefore),
	).Order(ent.Asc(scheduledpost.FieldScheduledFor)).Limit(limit).All(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]RecoverablePost, 0, len(posts))
	for _, post := range posts {
		result = append(result, RecoverablePost{
			ID: post.ID, OrganizationID: post.OrganizationID, ScheduledFor: post.ScheduledFor,
		})
	}
	return result, nil
}

func (r *Repository) CancelScheduledPost(ctx context.Context, actor Actor, id string) (*ent.ScheduledPost, error) {
	tx, err := r.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	query := tx.ScheduledPost.Query().Where(scheduledpost.ID(id), scheduledpost.OrganizationID(actor.Organization))
	if actor.Type != "SUPPORT" {
		viewer := ""
		if actor.Type == "USER" {
			viewer = actor.UserID
		}
		if err := keepVisiblePosts(ctx, tx.Client(), query, actor.Organization, viewer); err != nil {
			return nil, err
		}
	}
	post, err := query.Only(ctx)
	if ent.IsNotFound(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if post.Status == scheduledpost.StatusPUBLISHED || post.Status == scheduledpost.StatusSENT_TO_APP || post.Status == scheduledpost.StatusPROCESSING {
		return nil, ErrInvalidState
	}
	if post.Status != scheduledpost.StatusCANCELLED {
		updated, updateErr := tx.ScheduledPost.Update().Where(
			scheduledpost.ID(post.ID),
			scheduledpost.OrganizationID(actor.Organization),
			scheduledpost.StatusIn(scheduledpost.StatusDRAFT, scheduledpost.StatusSCHEDULED, scheduledpost.StatusFAILED),
		).SetStatus(scheduledpost.StatusCANCELLED).Save(ctx)
		if updateErr != nil {
			return nil, updateErr
		}
		if updated != 1 {
			return nil, ErrInvalidState
		}
		post, err = tx.ScheduledPost.Query().Where(scheduledpost.ID(post.ID)).Only(ctx)
		if err != nil {
			return nil, err
		}
		if err := recordPostActivity(ctx, tx, "post.cancelled", auditInput{
			Action: "post.cancelled", Actor: actor, EntityID: post.ID, EntityType: "scheduled_post",
			Organization: actor.Organization, Outcome: auditlog.OutcomeSUCCEEDED,
		}); err != nil {
			return nil, err
		}
		if err := reopenCancelledDraft(ctx, tx, post); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return post.Unwrap(), nil
}

// reopenCancelledDraft puts a draft back to a draft once every post from it is
// cancelled. A failed or live post keeps it scheduled: someone must still act.
func reopenCancelledDraft(ctx context.Context, tx *ent.Tx, post *ent.ScheduledPost) error {
	if post.ContentDraftID == nil {
		return nil
	}
	remaining, err := tx.ScheduledPost.Query().Where(scheduledpost.ContentDraftID(*post.ContentDraftID),
		scheduledpost.StatusNEQ(scheduledpost.StatusCANCELLED)).Exist(ctx)
	if err != nil || remaining {
		return err
	}
	_, err = tx.ContentDraft.Update().Where(contentdraft.ID(*post.ContentDraftID), contentdraft.OrganizationID(post.OrganizationID),
		contentdraft.StatusEQ(contentdraft.StatusScheduled)).SetStatus(contentdraft.StatusDraft).AddCalendarVersion(1).Save(ctx)
	return err
}

func (r *Repository) Claim(ctx context.Context, id, runID string, now time.Time) (bool, error) {
	count, err := r.client.ScheduledPost.Update().Where(
		scheduledpost.ID(id),
		scheduledpost.StatusEQ(scheduledpost.StatusSCHEDULED),
		scheduledpost.ScheduledForLTE(now),
	).SetStatus(scheduledpost.StatusPROCESSING).SetTriggerRunID(runID).Save(ctx)
	if err != nil || count == 1 {
		return count == 1, err
	}
	return r.client.ScheduledPost.Query().Where(
		scheduledpost.ID(id),
		scheduledpost.StatusEQ(scheduledpost.StatusPROCESSING),
		scheduledpost.TriggerRunIDEQ(runID),
	).Exist(ctx)
}

// PostScheduledFor is when a post is due, read again just before it is sent.
func (r *Repository) PostScheduledFor(ctx context.Context, organizationID, id string) (time.Time, error) {
	post, err := r.client.ScheduledPost.Query().Where(
		scheduledpost.ID(id), scheduledpost.OrganizationID(organizationID),
	).Only(ctx)
	if err != nil {
		return time.Time{}, err
	}
	return post.ScheduledFor, nil
}

func (r *Repository) LoadPublishJob(ctx context.Context, id, runID string) (PublishJob, error) {
	post, err := r.client.ScheduledPost.Query().Where(
		scheduledpost.ID(id),
		scheduledpost.StatusEQ(scheduledpost.StatusPROCESSING),
		scheduledpost.TriggerRunIDEQ(runID),
	).WithChannelConnection().Only(ctx)
	if ent.IsNotFound(err) {
		return PublishJob{}, ErrNotFound
	}
	if err != nil {
		return PublishJob{}, err
	}
	connection, err := post.Edges.ChannelConnectionOrErr()
	if err != nil {
		return PublishJob{Post: post, WorkspaceActive: false, Ineligible: FailureAccountUnavailable}, nil
	}
	if post.ContentDraftID != nil {
		return r.loadDraftPublishJob(ctx, post, connection)
	}
	if post.VariantID == nil {
		return PublishJob{Post: post, Connection: connection, WorkspaceActive: false, Ineligible: FailureWorkspaceInactive}, nil
	}
	variant, err := r.client.CreativeVariant.Query().Where(
		creativevariant.ID(*post.VariantID), creativevariant.OrganizationID(post.OrganizationID),
	).WithApproval().WithSourceAsset().Only(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return PublishJob{Post: post, Connection: connection, WorkspaceActive: false, Ineligible: FailureWorkspaceInactive}, nil
		}
		return PublishJob{}, err
	}
	approved := variant.Status == creativevariant.StatusAPPROVED
	if approvalEntity, edgeErr := variant.Edges.ApprovalOrErr(); edgeErr != nil || approvalEntity.Status != approval.StatusAPPROVED {
		approved = false
	}
	workspaceActive, err := r.workspaceActive(ctx, post.OrganizationID)
	if err != nil {
		return PublishJob{}, err
	}
	authorized, err := r.schedulerMayPublish(ctx, post, connection)
	if err != nil {
		return PublishJob{}, err
	}
	asset, err := variant.Edges.SourceAssetOrErr()
	if err != nil {
		reason := ineligibility(workspaceActive, connection, authorized, variantApproval(approved))
		if reason == "" {
			reason = FailureMediaUnavailable
		}
		return PublishJob{Post: post, Connection: connection, WorkspaceActive: false, Ineligible: reason}, nil
	}
	approved = approved && asset.OrganizationID == post.OrganizationID
	reason := ineligibility(workspaceActive, connection, authorized, variantApproval(approved))
	return PublishJob{
		AssetObjectKey: asset.ObjectKey, AssetMediaType: asset.MediaType,
		Assets:     []MediaAsset{{MediaType: asset.MediaType, ObjectKey: asset.ObjectKey}},
		Connection: connection, Post: post, WorkspaceActive: reason == "", Ineligible: reason,
	}, nil
}

// ineligibility is the first reason a job may not publish, or "". approval
// is the review's reason, or "" when the content may publish.
func ineligibility(workspaceActive bool, connection *ent.ChannelConnection, schedulerAuthorized bool, approval string) string {
	switch {
	case !workspaceActive:
		return FailureWorkspaceInactive
	case connection.Status != channelconnection.StatusACTIVE:
		return FailureAccountUnavailable
	case !schedulerAuthorized:
		return FailureSchedulerUnauthorized
	}
	return approval
}

// schedulerMayPublish rechecks, when a post is due, whoever queued it: a
// person must still be an active member whose role publishes, and own the
// account's set when that set is private (RFC 024); an API key
// ("api-key:<id>") must still be enabled and unexpired in this workspace, and
// never reaches a private set. A post that records neither, from before
// schedulers were recorded, publishes as it did.
func (r *Repository) schedulerMayPublish(ctx context.Context, post *ent.ScheduledPost, connection *ent.ChannelConnection) (bool, error) {
	if post.ScheduledByUserID == nil {
		return true, nil
	}
	scheduler := *post.ScheduledByUserID
	var err error
	if key, ok := strings.CutPrefix(scheduler, "api-key:"); ok {
		err = r.AuthorizeAPIKey(ctx, post.OrganizationID, key)
	} else {
		err = r.AuthorizePublishing(ForStartedRun(ctx), post.OrganizationID, scheduler, "")
	}
	if errors.Is(err, ErrForbidden) || errors.Is(err, ErrUnauthorized) {
		return false, nil
	}
	// The account's set, not the post's: a campaign post records none.
	if err != nil || connection.SocialSetID == nil {
		return err == nil, err
	}
	foreign, err := r.client.SocialSet.Query().Where(socialset.ID(*connection.SocialSetID), socialset.VisibilityEQ(socialset.VisibilityPRIVATE),
		socialset.Or(socialset.OwnerUserIDIsNil(), socialset.OwnerUserIDNEQ(scheduler))).Exist(ctx)
	return !foreign, err
}

// variantApproval is a campaign variant's review reason for ineligibility.
func variantApproval(approved bool) string {
	if approved {
		return ""
	}
	return FailureApprovalRequired
}

// draftSentBack reports whether a workspace that approves drafts has a
// reviewer's request for changes on this post's draft (RFC 013): a draft sent
// back after scheduling stops its queued posts. Approving a newer version or
// asking for review does not withdraw the approval the snapshot was queued with.
func (r *Repository) draftSentBack(ctx context.Context, post *ent.ScheduledPost) (bool, error) {
	settings, err := r.client.ContentDraftSettings.Get(ctx, post.OrganizationID)
	if ent.IsNotFound(err) {
		return false, nil
	}
	if err != nil || !settings.RequireApproval {
		return false, err
	}
	return r.client.ContentDraft.Query().Where(contentdraft.ID(*post.ContentDraftID),
		contentdraft.ReviewStatusEQ(contentdraft.ReviewStatusChangesRequested)).Exist(ctx)
}

// loadDraftPublishJob publishes a content draft's post: its caption was
// snapshotted when it was scheduled, and its media is the post's own assets,
// if any. A draft post without an asset publishes as text.
func (r *Repository) loadDraftPublishJob(ctx context.Context, post *ent.ScheduledPost, connection *ent.ChannelConnection) (PublishJob, error) {
	inactive := PublishJob{Post: post, Connection: connection, WorkspaceActive: false, Ineligible: FailureMediaUnavailable}
	owned, err := r.client.ContentDraft.Query().Where(contentdraft.ID(*post.ContentDraftID),
		contentdraft.OrganizationID(post.OrganizationID)).Exist(ctx)
	if err != nil {
		return PublishJob{}, err
	}
	if !owned {
		return PublishJob{Post: post, Connection: connection, WorkspaceActive: false, Ineligible: FailureWorkspaceInactive}, nil
	}
	// An ineligible post is cancelled for that reason, whatever its media.
	workspaceActive, err := r.workspaceActive(ctx, post.OrganizationID)
	if err != nil {
		return PublishJob{}, err
	}
	sentBack, err := r.draftSentBack(ctx, post)
	if err != nil {
		return PublishJob{}, err
	}
	approval := ""
	if sentBack {
		approval = FailureChangesRequested
	}
	authorized, err := r.schedulerMayPublish(ctx, post, connection)
	if err != nil {
		return PublishJob{}, err
	}
	if reason := ineligibility(workspaceActive, connection, authorized, approval); reason != "" {
		return PublishJob{Post: post, Connection: connection, WorkspaceActive: false, Ineligible: reason}, nil
	}
	job := PublishJob{Connection: connection, Post: post, WorkspaceActive: true}
	ids := post.AssetIds
	if len(ids) == 0 && post.AssetID != nil {
		ids = []string{*post.AssetID}
	}
	// A missing image cancels the post rather than publishing it without one.
	assets, missing, err := r.draftMedia(ctx, post.OrganizationID, ids)
	if err != nil || missing {
		return inactive, err
	}
	job.Assets = assets
	job.AutoActions, job.Poll, job.Options = post.AutoActions, post.Poll, post.PublishOptions
	if post.ReplyTo != nil {
		job.ReplyTo = *post.ReplyTo
	}
	// A document or cover that was deleted cancels the post too. A YouTube
	// thumbnail does not: it is a follow-up, and its step reports it missing.
	options := post.PublishOptions
	thumbnail := options.YouTube != nil && options.YouTube.ThumbnailAssetID != ""
	for _, id := range []string{options.DocumentAssetID, options.ArticleCoverAssetID, postoptions.CoverAsset(options.YouTube, options.Instagram)} {
		if id == "" {
			continue
		}
		media, missing, err := r.draftMedia(ctx, post.OrganizationID, []string{id})
		if err != nil {
			return inactive, err
		}
		if missing && thumbnail && id == options.YouTube.ThumbnailAssetID {
			continue
		}
		if missing {
			return inactive, nil
		}
		if id == options.DocumentAssetID {
			job.Document = &media[0]
		} else {
			job.Cover = &media[0]
		}
	}
	for _, reply := range post.Replies {
		media, missing, err := r.draftMedia(ctx, post.OrganizationID, reply.AssetIDs)
		if err != nil || missing {
			return inactive, err
		}
		job.Replies = append(job.Replies, PublishReply{Assets: media, Caption: reply.Caption, Options: reply.Options, Poll: reply.Poll})
	}
	if len(job.Assets) > 0 {
		job.AssetObjectKey, job.AssetMediaType = job.Assets[0].ObjectKey, job.Assets[0].MediaType
	}
	return job, nil
}

// RecordThread keeps how far a published post's thread got.
func (r *Repository) RecordThread(ctx context.Context, postID string, progress postoptions.ThreadProgress) error {
	return r.client.ScheduledPost.UpdateOneID(postID).SetThreadProgress(progress).Exec(ctx)
}

// draftMedia loads a draft post's images in order; missing reports one that
// is gone from the workspace.
func (r *Repository) draftMedia(ctx context.Context, organizationID string, ids []string) ([]MediaAsset, bool, error) {
	media := make([]MediaAsset, 0, len(ids))
	for _, id := range ids {
		row, err := r.client.Asset.Query().Where(asset.ID(id), asset.OrganizationID(organizationID),
			asset.StatusEQ(asset.StatusUPLOADED)).Only(ctx)
		if ent.IsNotFound(err) {
			return nil, true, nil
		}
		if err != nil {
			return nil, false, err
		}
		alt := ""
		if row.AltText != nil {
			alt = *row.AltText
		}
		media = append(media, MediaAsset{DurationMs: row.DurationMs, AssetID: row.ID, Alt: alt, MediaType: row.MediaType, ObjectKey: row.ObjectKey})
	}
	return media, false, nil
}

// workspaceActive reports whether the workspace is not being deleted.
func (r *Repository) workspaceActive(ctx context.Context, organizationID string) (bool, error) {
	deletion, err := r.client.WorkspaceDeletion.Query().Where(
		workspacedeletion.OrganizationID(organizationID),
	).Only(ctx)
	if ent.IsNotFound(err) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	return deletion.Status == workspacedeletion.StatusCANCELLED, nil
}

func (r *Repository) StartAttempt(ctx context.Context, post *ent.ScheduledPost, runID string, attemptNumber int) (Attempt, error) {
	tx, err := r.client.Tx(ctx)
	if err != nil {
		return Attempt{}, err
	}
	defer tx.Rollback()
	owned, err := tx.ScheduledPost.Update().Where(
		scheduledpost.ID(post.ID),
		scheduledpost.StatusEQ(scheduledpost.StatusPROCESSING),
		scheduledpost.TriggerRunIDEQ(runID),
	).SetUpdatedAt(time.Now().UTC()).Save(ctx)
	if err != nil {
		return Attempt{}, err
	}
	if owned != 1 {
		return Attempt{}, ErrInvalidState
	}
	// A retried start finds this run's open attempt. A run that took over a
	// post an earlier run attempted numbers after those attempts, so their
	// outcomes are never reused or overwritten.
	attempts, err := tx.PublicationAttempt.Query().Where(publicationattempt.ScheduledPostID(post.ID)).All(ctx)
	if err != nil {
		return Attempt{}, err
	}
	number := attemptNumber
	for _, existing := range attempts {
		if existing.CompletedAt == nil {
			if err := tx.Commit(); err != nil {
				return Attempt{}, err
			}
			return Attempt{ID: existing.ID, Number: existing.AttemptNumber}, nil
		}
		number = max(number, existing.AttemptNumber+1)
	}
	attempt, err := tx.PublicationAttempt.Create().
		SetID(cuid.New()).
		SetOrganizationID(post.OrganizationID).
		SetScheduledPostID(post.ID).
		SetAttemptNumber(number).
		Save(ctx)
	if err != nil {
		return Attempt{}, err
	}
	if err := tx.Commit(); err != nil {
		return Attempt{}, err
	}
	return Attempt{ID: attempt.ID, Number: attempt.AttemptNumber}, nil
}

// FailUnknown records that the provider may have published the post. It
// closes the post's open attempt, whose number may follow an earlier run's.
func (r *Repository) FailUnknown(ctx context.Context, postID, runID string, _ int, providerMessage string) error {
	tx, err := r.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	post, err := tx.ScheduledPost.Query().Where(scheduledpost.ID(postID)).Only(ctx)
	if ent.IsNotFound(err) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if post.Status == scheduledpost.StatusPUBLISHED || post.Status == scheduledpost.StatusSENT_TO_APP || post.Status == scheduledpost.StatusFAILED || post.Status == scheduledpost.StatusCANCELLED || post.Status == scheduledpost.StatusUNKNOWN_DELIVERY {
		return nil
	}
	updated, err := tx.ScheduledPost.Update().Where(
		scheduledpost.ID(postID),
		scheduledpost.StatusEQ(scheduledpost.StatusPROCESSING),
		scheduledpost.TriggerRunIDEQ(runID),
	).SetStatus(scheduledpost.StatusUNKNOWN_DELIVERY).SetFailureCode(FailureUnknownDelivery).Save(ctx)
	if err != nil || updated != 1 {
		if err == nil {
			err = ErrInvalidState
		}
		return err
	}
	updatedAttempts, err := tx.PublicationAttempt.Update().Where(
		publicationattempt.ScheduledPostID(postID),
		publicationattempt.CompletedAtIsNil(),
	).SetCompletedAt(time.Now().UTC()).SetOutcome(publicationattempt.OutcomeFAILED).SetFailureCode("UNKNOWN_DELIVERY").
		SetNillableProviderMessage(nonEmpty(RedactProviderMessage(providerMessage))).Save(ctx)
	if err != nil || updatedAttempts != 1 {
		if err == nil {
			err = ErrInvalidState
		}
		return err
	}
	if err := recordPostActivity(ctx, tx, "post.publish_recovery_required", auditInput{
		Action: "post.publish_recovery_required", Actor: serviceActor(post), EntityID: post.ID,
		EntityType: "scheduled_post", Organization: post.OrganizationID, Outcome: auditlog.OutcomeFAILED,
		Metadata: map[string]any{"failureCode": "UNKNOWN_DELIVERY"},
	}); err != nil {
		return err
	}
	return tx.Commit()
}

func (r *Repository) Complete(ctx context.Context, post *ent.ScheduledPost, attempt Attempt, providerPostID, runID string) error {
	tx, err := r.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	options, err := tx.ScheduledPost.Query().Where(scheduledpost.ID(post.ID)).Select(scheduledpost.FieldPublishOptions).Only(ctx)
	if err != nil {
		return err
	}
	// A TikTok app draft reached the person's TikTok app, where they finish
	// and post it: delivered, never published from here.
	inApp := options.PublishOptions.TikTok != nil && options.PublishOptions.TikTok.SendToApp
	status, event := scheduledpost.StatusPUBLISHED, "post.published"
	update := tx.ScheduledPost.Update().Where(
		scheduledpost.ID(post.ID),
		scheduledpost.StatusEQ(scheduledpost.StatusPROCESSING),
		scheduledpost.TriggerRunIDEQ(runID),
	).SetRemotePostID(providerPostID)
	if inApp {
		status, event = scheduledpost.StatusSENT_TO_APP, "post.sent_to_app"
	} else {
		update.SetPublishedAt(time.Now().UTC())
	}
	updated, err := update.SetStatus(status).Save(ctx)
	if err != nil || updated != 1 {
		if err != nil {
			return err
		}
		published, queryErr := tx.ScheduledPost.Query().Where(
			scheduledpost.ID(post.ID), scheduledpost.StatusEQ(status),
		).Exist(ctx)
		if queryErr != nil {
			return queryErr
		}
		completed, queryErr := tx.PublicationAttempt.Query().Where(
			publicationattempt.ID(attempt.ID),
			publicationattempt.OutcomeEQ(publicationattempt.OutcomeSUCCEEDED),
			publicationattempt.ProviderPostID(providerPostID),
			publicationattempt.CompletedAtNotNil(),
		).Exist(ctx)
		if queryErr != nil {
			return queryErr
		}
		if published && completed {
			return nil
		}
		return ErrInvalidState
	}
	// The worker passes a partial post; the draft event needs the stored one.
	live, err := tx.ScheduledPost.Query().Where(scheduledpost.ID(post.ID)).
		Select(scheduledpost.FieldID, scheduledpost.FieldOrganizationID, scheduledpost.FieldContentDraftID,
			scheduledpost.FieldThreadProgress, scheduledpost.FieldChannelConnectionID).
		WithChannelConnection(func(q *ent.ChannelConnectionQuery) {
			q.Select(channelconnection.FieldID, channelconnection.FieldPlatform)
		}).Only(ctx)
	if err != nil {
		return err
	}
	if _, err = tx.PublicationAttempt.UpdateOneID(attempt.ID).
		SetCompletedAt(time.Now()).SetOutcome(publicationattempt.OutcomeSUCCEEDED).SetProviderPostID(providerPostID).
		SetNillableRemoteURL(postoptions.PostURL(platformOf(live), &providerPostID, live.ThreadProgress)).Save(ctx); err != nil {
		return err
	}
	if err := recordPostActivity(ctx, tx, event, auditInput{
		Action: event, Actor: serviceActor(post), EntityID: post.ID,
		EntityType: "scheduled_post", Organization: post.OrganizationID, Outcome: auditlog.OutcomeSUCCEEDED,
		Metadata: map[string]any{"providerPostId": providerPostID},
	}); err != nil {
		return err
	}
	if inApp {
		return tx.Commit()
	}
	if err := EmitDraftPublished(ctx, tx, live, providerPostID); err != nil {
		return err
	}
	return tx.Commit()
}

func (r *Repository) Fail(ctx context.Context, post *ent.ScheduledPost, attempt Attempt, failureCode string, retryAt *time.Time, runID string) error {
	tx, err := r.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	postUpdate := tx.ScheduledPost.Update().Where(
		scheduledpost.ID(post.ID),
		scheduledpost.StatusEQ(scheduledpost.StatusPROCESSING),
		scheduledpost.TriggerRunIDEQ(runID),
	)
	retry := retryAt != nil
	if retry {
		postUpdate.SetStatus(scheduledpost.StatusSCHEDULED).SetScheduledFor(retryAt.UTC()).ClearTriggerRunID()
	} else {
		postUpdate.SetStatus(scheduledpost.StatusFAILED).SetFailureCode(failureCode)
	}
	updated, err := postUpdate.Save(ctx)
	if err != nil || updated != 1 {
		if err != nil {
			return err
		}
		status := scheduledpost.StatusFAILED
		if retry {
			status = scheduledpost.StatusSCHEDULED
		}
		postMatches, queryErr := tx.ScheduledPost.Query().Where(
			scheduledpost.ID(post.ID), scheduledpost.StatusEQ(status),
		).Exist(ctx)
		if queryErr != nil {
			return queryErr
		}
		attemptMatches, queryErr := tx.PublicationAttempt.Query().Where(
			publicationattempt.ID(attempt.ID),
			publicationattempt.OutcomeEQ(publicationattempt.OutcomeFAILED),
			publicationattempt.FailureCode(failureCode),
			publicationattempt.CompletedAtNotNil(),
		).Exist(ctx)
		if queryErr != nil {
			return queryErr
		}
		if postMatches && attemptMatches {
			return nil
		}
		return ErrInvalidState
	}
	if _, err = tx.PublicationAttempt.UpdateOneID(attempt.ID).
		SetCompletedAt(time.Now()).SetOutcome(publicationattempt.OutcomeFAILED).SetFailureCode(failureCode).
		SetNillableProviderMessage(nonEmpty(RedactProviderMessage(attempt.ProviderMessage))).Save(ctx); err != nil {
		return err
	}
	failed := auditInput{
		Action: "post.publish_failed", Actor: serviceActor(post), EntityID: post.ID,
		EntityType: "scheduled_post", Organization: post.OrganizationID, Outcome: auditlog.OutcomeFAILED,
		Metadata: map[string]any{"failureCode": failureCode, "retry": retry},
	}
	// An automatic retry needs no one yet: only the attempt that gives up alerts.
	if retry {
		err = appendAudit(ctx, tx, failed)
	} else {
		err = recordPostActivity(ctx, tx, "post.publish_failed", failed)
	}
	if err != nil {
		return err
	}
	return tx.Commit()
}

// CancelIneligible cancels a claimed post that may no longer publish; reason
// is one of the Failure codes, kept on the post for the person to act on.
func (r *Repository) CancelIneligible(ctx context.Context, post *ent.ScheduledPost, reason, runID string) error {
	tx, err := r.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	updated, err := tx.ScheduledPost.Update().Where(
		scheduledpost.ID(post.ID),
		scheduledpost.StatusEQ(scheduledpost.StatusPROCESSING),
		scheduledpost.TriggerRunIDEQ(runID),
	).SetStatus(scheduledpost.StatusCANCELLED).SetFailureCode(reason).Save(ctx)
	if err != nil || updated == 0 {
		if err == nil {
			err = ErrInvalidState
		}
		return err
	}
	if err := recordPostActivity(ctx, tx, "post.cancelled", auditInput{
		Action: "post.cancelled", Actor: serviceActor(post), EntityID: post.ID,
		EntityType: "scheduled_post", Organization: post.OrganizationID, Outcome: auditlog.OutcomeSUCCEEDED,
		Metadata: map[string]any{"reason": reason},
	}); err != nil {
		return err
	}
	return tx.Commit()
}

// FailUnsent fails a claimed post that was never sent to its provider: its
// media is gone, or it missed its late publication window. Nothing reached
// the provider, so a person may retry or reschedule it.
func (r *Repository) FailUnsent(ctx context.Context, post *ent.ScheduledPost, code, runID string) error {
	tx, err := r.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	updated, err := tx.ScheduledPost.Update().Where(
		scheduledpost.ID(post.ID),
		scheduledpost.StatusEQ(scheduledpost.StatusPROCESSING),
		scheduledpost.TriggerRunIDEQ(runID),
	).SetStatus(scheduledpost.StatusFAILED).SetFailureCode(code).Save(ctx)
	if err != nil || updated == 0 {
		if err == nil {
			err = ErrInvalidState
		}
		return err
	}
	if err := recordPostActivity(ctx, tx, "post.publish_failed", auditInput{
		Action: "post.publish_failed", Actor: serviceActor(post), EntityID: post.ID,
		EntityType: "scheduled_post", Organization: post.OrganizationID, Outcome: auditlog.OutcomeFAILED,
		Metadata: map[string]any{"failureCode": code, "sent": false},
	}); err != nil {
		return err
	}
	return tx.Commit()
}

// ListStalledPosts lists claimed posts that have made no progress since
// before, for the sweep that checks whether their workflow still runs. The
// sample is random, so posts whose workflows still run (and are skipped)
// cannot keep the sweep from reaching the rest.
func (r *Repository) ListStalledPosts(ctx context.Context, before time.Time, limit int) ([]StalledPost, error) {
	posts, err := r.client.ScheduledPost.Query().Where(scheduledpost.StatusEQ(scheduledpost.StatusPROCESSING),
		scheduledpost.UpdatedAtLT(before), scheduledpost.TriggerRunIDNotNil()).
		Order(func(s *entsql.Selector) { s.OrderExpr(entsql.Expr("random()")) }).Limit(limit).All(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]StalledPost, 0, len(posts))
	for _, post := range posts {
		result = append(result, StalledPost{ID: post.ID, OrganizationID: post.OrganizationID, RunID: *post.TriggerRunID})
	}
	return result, nil
}

// ReleaseStalled settles a claimed post whose workflow stopped without
// recording an outcome. An attempt without an outcome may have reached the
// provider, so the post becomes UNKNOWN_DELIVERY for a person to reconcile;
// without one nothing was sent, so it is queued again for the dispatcher.
// It reports "unknown_delivery", "requeued", or "" when the post moved on.
func (r *Repository) ReleaseStalled(ctx context.Context, postID, runID string) (string, error) {
	tx, err := r.client.Tx(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	if _, err := tx.PlatformExec(ctx, `SELECT id FROM scheduled_post WHERE id=$1 FOR UPDATE`, postID); err != nil {
		return "", err
	}
	post, err := tx.ScheduledPost.Query().Where(scheduledpost.ID(postID), scheduledpost.StatusEQ(scheduledpost.StatusPROCESSING),
		scheduledpost.TriggerRunIDEQ(runID)).Only(ctx)
	if ent.IsNotFound(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	open, err := tx.PublicationAttempt.Query().Where(publicationattempt.ScheduledPostID(postID),
		publicationattempt.CompletedAtIsNil()).Order(ent.Desc(publicationattempt.FieldAttemptNumber)).First(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return "", err
	}
	outcome, action := "requeued", "post.publish_requeued"
	update := tx.ScheduledPost.UpdateOneID(postID)
	if open != nil {
		outcome, action = "unknown_delivery", "post.publish_recovery_required"
		update.SetStatus(scheduledpost.StatusUNKNOWN_DELIVERY).SetFailureCode(FailureUnknownDelivery)
		if err := tx.PublicationAttempt.UpdateOneID(open.ID).SetCompletedAt(time.Now().UTC()).
			SetOutcome(publicationattempt.OutcomeFAILED).SetFailureCode(FailureUnknownDelivery).Exec(ctx); err != nil {
			return "", err
		}
	} else {
		update.SetStatus(scheduledpost.StatusSCHEDULED).ClearTriggerRunID()
	}
	if err := update.Exec(ctx); err != nil {
		return "", err
	}
	audit := auditInput{
		Action: action, Actor: serviceActor(post), EntityID: post.ID,
		EntityType: "scheduled_post", Organization: post.OrganizationID, Outcome: auditlog.OutcomeFAILED,
		Metadata: map[string]any{"reason": "workflow_stopped"},
	}
	// Only a post that may be live needs a person; a requeue is audit only.
	if open != nil {
		err = recordPostActivity(ctx, tx, action, audit)
	} else {
		err = AppendAudit(ctx, tx, audit)
	}
	if err != nil {
		return "", err
	}
	return outcome, tx.Commit()
}

func serviceActor(post *ent.ScheduledPost) Actor {
	requestID := post.ID
	if post.TriggerRunID != nil && *post.TriggerRunID != "" {
		requestID = *post.TriggerRunID
	}
	return Actor{Display: "publishing-orchestrator", Organization: post.OrganizationID, RequestID: requestID, Source: "workflow", Type: "SERVICE"}
}

func ProviderFailureCode(status int, unknown bool) string {
	if unknown {
		return "UNKNOWN_DELIVERY"
	}
	if status == 0 {
		return "NETWORK"
	}
	return strconv.Itoa(status)
}

var secretReferencePattern = regexp.MustCompile(`^SOCIAL_(?:API_KEY|OAUTH_TOKEN)(?:_[A-Z0-9_]+)?$`)

func IsSecretReference(value string) bool {
	return secretReferencePattern.MatchString(value)
}

// PlanAutomations records a pending receipt for each follow-up not yet
// recorded and returns every one's status by key; a replayed plan keeps the
// receipts it finds.
func (r *Repository) PlanAutomations(ctx context.Context, organizationID, postID string, receipts []AutomationReceipt) (map[string]string, error) {
	tx, err := r.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	// A move either sees these pending receipts, or finishes before this plan.
	if _, err := tx.PlatformExec(ctx, `SELECT c.id FROM channel_connection c JOIN scheduled_post p ON p."channelConnectionId"=c.id AND p."organizationId"=c."organizationId" WHERE p.id=$1 AND p."organizationId"=$2 FOR UPDATE OF c`, postID, organizationID); err != nil {
		return nil, err
	}
	post, err := tx.ScheduledPost.Query().Where(scheduledpost.ID(postID), scheduledpost.OrganizationID(organizationID)).WithChannelConnection().Only(ctx)
	if err != nil {
		return nil, err
	}
	connection := post.Edges.ChannelConnection
	if connection == nil {
		return nil, ErrNotFound
	}
	sameProfile := post.SocialSetID == nil && connection.SocialSetID == nil ||
		post.SocialSetID != nil && connection.SocialSetID != nil && *post.SocialSetID == *connection.SocialSetID
	if !sameProfile {
		// A moved account must not acquire new work from its former profile.
		return map[string]string{}, nil
	}
	rows, err := tx.PostAutomationRun.Query().Where(postautomationrun.ScheduledPostID(postID), postautomationrun.OrganizationID(organizationID)).All(ctx)
	if err != nil {
		return nil, err
	}
	statuses := make(map[string]string, len(rows)+len(receipts))
	for _, row := range rows {
		statuses[row.Key] = string(row.Status)
	}
	for _, receipt := range receipts {
		if _, exists := statuses[receipt.Key]; exists {
			continue
		}
		if err := tx.PostAutomationRun.Create().
			SetID(cuid.New()).SetOrganizationID(organizationID).SetScheduledPostID(postID).
			SetKey(receipt.Key).SetKind(postautomationrun.Kind(receipt.Kind)).SetDueAt(receipt.DueAt).
			Exec(ctx); err != nil {
			return nil, err
		}
		statuses[receipt.Key] = string(postautomationrun.StatusPending)
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return statuses, nil
}

// AutomationReceipt is a follow-up's status and what it posted; a missing
// receipt reads as skipped, so a step without one never acts.
func (r *Repository) AutomationReceipt(ctx context.Context, postID, key string) (string, string, error) {
	row, err := r.client.PostAutomationRun.Query().
		Where(postautomationrun.ScheduledPostID(postID), postautomationrun.Key(key)).Only(ctx)
	if ent.IsNotFound(err) {
		return string(postautomationrun.StatusSkipped), "", nil
	}
	if err != nil {
		return "", "", err
	}
	remoteID := ""
	if row.RemoteID != nil {
		remoteID = *row.RemoteID
	}
	return string(row.Status), remoteID, nil
}

// RecordAutomation counts a try of a pending follow-up and settles it with
// status unless that is pending. It changes only a pending receipt (false:
// settled meanwhile, nothing changed), except that a step that acted is
// recorded done even if it was cancelled while in flight: the receipt says
// what is on the platform.
func (r *Repository) RecordAutomation(ctx context.Context, postID, key, status, remoteID, failureCode, providerMessage string) (bool, error) {
	open := []postautomationrun.Status{postautomationrun.StatusPending}
	if status == string(postautomationrun.StatusDone) {
		open = append(open, postautomationrun.StatusCancelled)
	}
	update := r.client.PostAutomationRun.Update().
		Where(postautomationrun.ScheduledPostID(postID), postautomationrun.Key(key), postautomationrun.StatusIn(open...)).
		AddAttempts(1).SetStatus(postautomationrun.Status(status))
	if remoteID != "" {
		update.SetRemoteID(remoteID)
	}
	if failureCode != "" {
		update.SetFailureCode(failureCode)
	}
	if providerMessage != "" {
		update.SetProviderMessage(RedactProviderMessage(providerMessage))
	}
	changed, err := update.Save(ctx)
	return changed > 0, err
}
