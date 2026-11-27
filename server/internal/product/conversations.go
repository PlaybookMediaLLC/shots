package product

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	entsql "entgo.io/ent/dialect/sql"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaign"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/conversation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/conversationmessage"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/launchrun"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/launchrunstep"
	"github.com/lucsky/cuid"
)

// Conversations (docs/rfcs/028-conversational-campaign-creation.md) are
// visible to the whole workspace. Any member reads them, starts one, and
// sends plain user messages. Recording agent output (assistant, tool, or
// clarification messages) needs a role that can start agent runs, or the
// conversation's author citing a conversation run they started. Renaming,
// linking, and archiving is for the author or an owner or admin. Another
// workspace's conversation is not found.

const (
	conversationContentMax  = 20_000
	conversationTitleMax    = 200
	conversationMessagesMax = 200
)

var errConversationArchived = conflict("This conversation is archived.")

// ConversationRecord is a conversation without its messages.
type ConversationRecord struct {
	CampaignID      *string   `json:"campaignId"`
	CreatedAt       time.Time `json:"createdAt"`
	CreatedByUserID *string   `json:"createdByUserId"`
	ID              string    `json:"id"`
	Status          string    `json:"status"`
	Title           string    `json:"title"`
	UpdatedAt       time.Time `json:"updatedAt"`
}

// ConversationMessageRecord is one persisted message.
type ConversationMessageRecord struct {
	Content        string          `json:"content"`
	ConversationID string          `json:"conversationId"`
	CreatedAt      time.Time       `json:"createdAt"`
	ID             string          `json:"id"`
	Kind           string          `json:"kind"`
	LaunchRunID    *string         `json:"launchRunId"`
	Metadata       json.RawMessage `json:"metadata"`
	Role           string          `json:"role"`
	ToolName       *string         `json:"toolName"`
}

// ConversationDetail is a conversation with its newest messages, oldest first.
type ConversationDetail struct {
	Conversation ConversationRecord          `json:"conversation"`
	Messages     []ConversationMessageRecord `json:"messages"`
}

// CreateConversationInput starts a conversation; an empty title gets a default.
type CreateConversationInput struct {
	CampaignID *string `json:"campaignId"`
	Title      string  `json:"title"`
}

// ListConversationsInput filters a workspace's conversations, newest first.
type ListConversationsInput struct {
	CampaignID *string
	Limit      int
	Status     string
}

// AppendConversationMessageInput is one message to add to a conversation.
type AppendConversationMessageInput struct {
	Content     string          `json:"content"`
	Kind        string          `json:"kind"`
	LaunchRunID *string         `json:"launchRunId"`
	Metadata    json.RawMessage `json:"metadata"`
	Role        string          `json:"role"`
	ToolName    *string         `json:"toolName"`
}

// UpdateConversationInput changes a conversation. An omitted field is kept;
// campaignId null unlinks the campaign.
type UpdateConversationInput struct {
	CampaignID NullableString `json:"campaignId"`
	Status     *string        `json:"status"`
	Title      *string        `json:"title"`
}

func conversationRecord(row *ent.Conversation) ConversationRecord {
	return ConversationRecord{CampaignID: row.CampaignID, CreatedAt: row.CreatedAt, CreatedByUserID: row.CreatedByUserID,
		ID: row.ID, Status: string(row.Status), Title: row.Title, UpdatedAt: row.UpdatedAt}
}

func conversationMessageRecord(row *ent.ConversationMessage) ConversationMessageRecord {
	return ConversationMessageRecord{Content: row.Content, ConversationID: row.ConversationID, CreatedAt: row.CreatedAt,
		ID: row.ID, Kind: string(row.Kind), LaunchRunID: row.LaunchRunID, Metadata: nullJSON(row.Metadata),
		Role: string(row.Role), ToolName: row.ToolName}
}

func conversationTitle(title string) (string, bool) {
	title = strings.TrimSpace(title)
	return title, title != "" && utf8.RuneCountInString(title) <= conversationTitleMax
}

// conversationCampaign answers not found unless the campaign is the workspace's.
func conversationCampaign(ctx context.Context, tx *ent.Tx, actor Actor, id string) error {
	exists, err := tx.Campaign.Query().Where(campaign.ID(id), campaign.OrganizationID(actor.OrganizationID)).Exist(ctx)
	if err != nil {
		return err
	}
	if !exists {
		return launchNotFound("Campaign")
	}
	return nil
}

// CreateConversation starts a conversation; any member may.
func (c *Configuration) CreateConversation(ctx context.Context, actor Actor, input CreateConversationInput) (*ConversationRecord, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	if strings.TrimSpace(input.Title) == "" {
		input.Title = "New conversation"
	}
	title, ok := conversationTitle(input.Title)
	if !ok {
		return nil, ErrInvalidInput
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if input.CampaignID != nil {
		if err := conversationCampaign(ctx, tx, actor, *input.CampaignID); err != nil {
			return nil, err
		}
	}
	now := time.Now().UTC()
	row, err := tx.Conversation.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).
		SetNillableCreatedByUserID(launchUserID(actor)).SetNillableCampaignID(input.CampaignID).SetTitle(title).
		SetCreatedAt(now).SetUpdatedAt(now).Save(ctx)
	if err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.conversation_created", "conversation", row.ID,
		map[string]any{"campaignId": input.CampaignID}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := conversationRecord(row)
	return &result, nil
}

// ListConversations returns the workspace's conversations, most recently
// active first. Status defaults to ACTIVE; limit to 20, at most 100.
func (c *Configuration) ListConversations(ctx context.Context, actor Actor, input ListConversationsInput) ([]ConversationRecord, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	status := conversation.StatusACTIVE
	if input.Status != "" {
		status = conversation.Status(input.Status)
	}
	if conversation.StatusValidator(status) != nil || input.Limit < 0 || input.Limit > 100 {
		return nil, ErrInvalidInput
	}
	if input.Limit == 0 {
		input.Limit = 20
	}
	query := c.client.Conversation.Query().Where(conversation.OrganizationID(actor.OrganizationID), conversation.StatusEQ(status))
	if input.CampaignID != nil {
		query.Where(conversation.CampaignID(*input.CampaignID))
	}
	rows, err := query.Order(ent.Desc(conversation.FieldUpdatedAt), ent.Desc(conversation.FieldID)).Limit(input.Limit).All(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]ConversationRecord, 0, len(rows))
	for _, row := range rows {
		items = append(items, conversationRecord(row))
	}
	return items, nil
}

// GetConversation returns a conversation with its 200 newest messages.
func (c *Configuration) GetConversation(ctx context.Context, actor Actor, id string) (*ConversationDetail, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	row, err := c.client.Conversation.Query().Where(conversation.ID(id), conversation.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, launchNotFound("Conversation")
	}
	if err != nil {
		return nil, err
	}
	messages, err := c.client.ConversationMessage.Query().Where(conversationmessage.OrganizationID(actor.OrganizationID),
		conversationmessage.ConversationID(id)).
		Order(ent.Desc(conversationmessage.FieldCreatedAt), ent.Desc(conversationmessage.FieldID)).Limit(conversationMessagesMax).All(ctx)
	if err != nil {
		return nil, err
	}
	result := &ConversationDetail{Conversation: conversationRecord(row), Messages: make([]ConversationMessageRecord, 0, len(messages))}
	for _, message := range slices.Backward(messages) {
		result.Messages = append(result.Messages, conversationMessageRecord(message))
	}
	return result, nil
}

// ConversationRunView pairs a launch run with its ordered trace steps.
type ConversationRunView struct {
	Run   LaunchRunRecord       `json:"run"`
	Steps []LaunchRunStepRecord `json:"steps"`
}

// ConversationView returns a conversation, its newest messages, and the newest
// traced launch runs with their steps in a single round-trip.
type ConversationView struct {
	Conversation ConversationRecord          `json:"conversation"`
	Messages     []ConversationMessageRecord `json:"messages"`
	Runs         []ConversationRunView       `json:"runs"`
}

const (
	conversationTracedRunsMax = 10
	conversationRunStepsMax   = 500
)

func conversationRunStepsLimitPredicate(organizationID string, runIDs []string, maxPerRun int) func(*entsql.Selector) {
	return func(s *entsql.Selector) {
		runArgs := make([]any, len(runIDs))
		for i, runID := range runIDs {
			runArgs[i] = runID
		}
		d := entsql.Dialect(s.Dialect())
		ranked := d.Select(
			launchrunstep.FieldID,
			fmt.Sprintf(
				"ROW_NUMBER() OVER (PARTITION BY %s ORDER BY %s ASC, %s ASC) AS rn",
				s.Quote(launchrunstep.FieldRunID),
				s.Quote(launchrunstep.FieldIndex),
				s.Quote(launchrunstep.FieldID),
			),
		).
			From(entsql.Table(launchrunstep.Table)).
			Where(entsql.And(
				entsql.EQ(launchrunstep.FieldOrganizationID, organizationID),
				entsql.In(launchrunstep.FieldRunID, runArgs...),
			))
		limited := d.Select(launchrunstep.FieldID).
			From(ranked.As("ranked_steps")).
			Where(entsql.LTE("rn", maxPerRun))
		s.Where(entsql.In(s.C(launchrunstep.FieldID), limited))
	}
}

// GetConversationView loads a conversation, its newest messages, and up to 10
// newest referenced launch runs and their trace steps in batched queries.
func (c *Configuration) GetConversationView(ctx context.Context, actor Actor, id string) (*ConversationView, error) {
	detail, err := c.GetConversation(ctx, actor, id)
	if err != nil {
		return nil, err
	}
	seen := make(map[string]struct{}, conversationTracedRunsMax)
	orderedIDs := make([]string, 0, conversationTracedRunsMax)
	for _, message := range detail.Messages {
		if message.LaunchRunID == nil || *message.LaunchRunID == "" {
			continue
		}
		runID := *message.LaunchRunID
		if _, ok := seen[runID]; ok {
			continue
		}
		seen[runID] = struct{}{}
		orderedIDs = append(orderedIDs, runID)
	}
	if len(orderedIDs) > conversationTracedRunsMax {
		orderedIDs = orderedIDs[len(orderedIDs)-conversationTracedRunsMax:]
	}
	view := &ConversationView{
		Conversation: detail.Conversation,
		Messages:     detail.Messages,
		Runs:         make([]ConversationRunView, 0, len(orderedIDs)),
	}
	if len(orderedIDs) == 0 {
		return view, nil
	}
	runRows, err := c.client.LaunchRun.Query().
		Where(launchrun.OrganizationID(actor.OrganizationID), launchrun.IDIn(orderedIDs...)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	runByID := make(map[string]LaunchRunRecord, len(runRows))
	foundIDs := make([]string, 0, len(runRows))
	for _, row := range runRows {
		runByID[row.ID] = launchRunRecord(row)
		foundIDs = append(foundIDs, row.ID)
	}
	if len(foundIDs) == 0 {
		return view, nil
	}
	stepRows, err := c.client.LaunchRunStep.Query().
		Where(
			launchrunstep.OrganizationID(actor.OrganizationID),
			launchrunstep.RunIDIn(foundIDs...),
			conversationRunStepsLimitPredicate(actor.OrganizationID, foundIDs, conversationRunStepsMax),
		).
		Order(ent.Asc(launchrunstep.FieldRunID), ent.Asc(launchrunstep.FieldIndex)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	stepsByRun := make(map[string][]LaunchRunStepRecord, len(foundIDs))
	for _, row := range stepRows {
		stepsByRun[row.RunID] = append(stepsByRun[row.RunID], launchRunStepRecord(row))
	}
	for _, runID := range orderedIDs {
		run, ok := runByID[runID]
		if !ok {
			continue
		}
		steps := stepsByRun[runID]
		if steps == nil {
			steps = []LaunchRunStepRecord{}
		}
		view.Runs = append(view.Runs, ConversationRunView{Run: run, Steps: steps})
	}
	return view, nil
}

// AppendConversationMessage adds a message to an active conversation.
func (c *Configuration) AppendConversationMessage(ctx context.Context, actor Actor, id string, input AppendConversationMessageInput) (*ConversationMessageRecord, error) {
	role, kind := conversationmessage.Role(input.Role), conversationmessage.Kind(input.Kind)
	// asStarter: the caller may record agent output only as the cited run's starter.
	asStarter := false
	if role == conversationmessage.RoleUser && kind == conversationmessage.KindText {
		if err := c.AuthorizeRead(ctx, actor); err != nil {
			return nil, err
		}
	} else if input.LaunchRunID == nil {
		if err := c.authorizeRoles(ctx, actor, launchEditRoles...); err != nil {
			return nil, err
		}
	} else {
		var err error
		if asStarter, err = c.authorizeLaunchRun(ctx, actor, *input.LaunchRunID); err != nil {
			return nil, err
		}
	}
	if conversationmessage.RoleValidator(role) != nil || conversationmessage.KindValidator(kind) != nil ||
		strings.TrimSpace(input.Content) == "" || utf8.RuneCountInString(input.Content) > conversationContentMax ||
		(input.ToolName != nil && !launchToolName.MatchString(*input.ToolName)) {
		return nil, ErrInvalidInput
	}
	metadata, ok := redactLaunchSummary(input.Metadata)
	if !ok {
		return nil, ErrInvalidInput
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	parent, err := tx.Conversation.Query().Where(conversation.ID(id), conversation.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, launchNotFound("Conversation")
	}
	if err != nil {
		return nil, err
	}
	if parent.Status == conversation.StatusARCHIVED {
		return nil, errConversationArchived
	}
	if asStarter && (parent.CreatedByUserID == nil || *parent.CreatedByUserID != actor.UserID) {
		return nil, forbidden("Only the conversation's author records its agent output.")
	}
	if input.LaunchRunID != nil {
		exists, err := tx.LaunchRun.Query().Where(launchrun.ID(*input.LaunchRunID), launchrun.OrganizationID(actor.OrganizationID)).Exist(ctx)
		if err != nil {
			return nil, err
		}
		if !exists {
			return nil, launchNotFound("Run")
		}
	}
	now := time.Now().UTC()
	create := tx.ConversationMessage.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetConversationID(id).
		SetRole(role).SetKind(kind).SetContent(input.Content).SetNillableLaunchRunID(input.LaunchRunID).
		SetNillableToolName(input.ToolName).SetCreatedAt(now)
	if metadata != nil {
		create.SetMetadata(metadata)
	}
	row, err := create.Save(ctx)
	if err != nil {
		return nil, err
	}
	if err := tx.Conversation.UpdateOneID(id).SetUpdatedAt(now).Exec(ctx); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := conversationMessageRecord(row)
	return &result, nil
}

// UpdateConversation renames, links, archives, or restores a conversation.
// Archiving and restoring are audited.
func (c *Configuration) UpdateConversation(ctx context.Context, actor Actor, id string, input UpdateConversationInput) (*ConversationRecord, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	var title string
	if input.Title != nil {
		var ok bool
		if title, ok = conversationTitle(*input.Title); !ok {
			return nil, ErrInvalidInput
		}
	}
	if input.Status != nil && conversation.StatusValidator(conversation.Status(*input.Status)) != nil {
		return nil, ErrInvalidInput
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	row, err := tx.Conversation.Query().Where(conversation.ID(id), conversation.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, launchNotFound("Conversation")
	}
	if err != nil {
		return nil, err
	}
	author := actor.IsSession() && row.CreatedByUserID != nil && *row.CreatedByUserID == actor.UserID
	if !author {
		if err := c.Authorize(ctx, actor); err != nil {
			return nil, err
		}
	}
	update := tx.Conversation.UpdateOneID(id).SetUpdatedAt(time.Now().UTC())
	if input.Title != nil {
		update.SetTitle(title)
	}
	if input.CampaignID.Set {
		if input.CampaignID.Value == nil {
			update.ClearCampaignID()
		} else {
			if err := conversationCampaign(ctx, tx, actor, *input.CampaignID.Value); err != nil {
				return nil, err
			}
			update.SetCampaignID(*input.CampaignID.Value)
		}
	}
	var action string
	if input.Status != nil && conversation.Status(*input.Status) != row.Status {
		update.SetStatus(conversation.Status(*input.Status))
		action = "product.conversation_restored"
		if conversation.Status(*input.Status) == conversation.StatusARCHIVED {
			action = "product.conversation_archived"
		}
	}
	updated, err := update.Save(ctx)
	if err != nil {
		return nil, err
	}
	if action != "" {
		if err := appendConfigurationAudit(ctx, tx, actor, action, "conversation", id); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := conversationRecord(updated)
	return &result, nil
}
