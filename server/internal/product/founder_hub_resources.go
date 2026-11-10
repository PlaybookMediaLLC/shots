package product

import (
	"context"
	"encoding/json"
	"errors"
	"slices"

	entsql "entgo.io/ent/dialect/sql"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/google/uuid"
)

type FounderHubResourceAction struct {
	Action       string          `json:"action"`
	ResourceType string          `json:"resourceType"`
	SourceID     string          `json:"sourceId"`
	Title        string          `json:"title"`
	Payload      json.RawMessage `json:"payload"`
	WorkspaceID  *uuid.UUID      `json:"workspaceId"`
	ShareID      *uuid.UUID      `json:"shareId"`
	GuestID      *uuid.UUID      `json:"guestId"`
	Email        string          `json:"email"`
}

type FounderHubShareWorkspace struct {
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name"`
}

func (c *Configuration) FounderHubShareWorkspaces(ctx context.Context, actor Actor) ([]FounderHubShareWorkspace, error) {
	if !actor.IsSession() {
		return nil, publishing.ErrForbidden
	}
	if err := c.AuthorizeSession(ctx, actor); err != nil {
		return nil, err
	}
	profile, err := c.GetFounderHubProfile(ctx, actor.UserID)
	if err != nil {
		return nil, err
	}
	result := []FounderHubShareWorkspace{}
	for _, workspace := range profile.Workspaces {
		if slices.Contains(workspace.Permissions, "workspace:read") {
			result = append(result, FounderHubShareWorkspace{ID: workspace.WorkspaceID, Name: workspace.Name})
		}
	}
	return result, nil
}

// The original resource-sharing functions keep their plan, guest and workspace rules in Shots' namespaced database.
func (c *Configuration) FounderHubResourceAction(ctx context.Context, actor Actor, input FounderHubResourceAction) (json.RawMessage, error) {
	if !actor.IsSession() {
		return nil, publishing.ErrForbidden
	}
	session, err := c.auth.AuthorizeSession(ctx, actor.UserID, actor.SessionID)
	if err != nil {
		return nil, err
	}
	var query string
	var args []any
	switch input.Action {
	case "list":
		query, args = `SELECT coalesce(jsonb_agg(item), '[]'::jsonb) FROM founder_hub.list_shared_resources($1) item`, []any{input.ResourceType}
	case "publish":
		if !json.Valid(input.Payload) || len(input.Payload) > 1_900_000 {
			return nil, ErrInvalidInput
		}
		query, args = `SELECT coalesce(jsonb_agg(item), '[]'::jsonb) FROM founder_hub.upsert_shared_resource($1,$2,$3,$4::jsonb,$5::uuid) item`, []any{input.ResourceType, input.SourceID, input.Title, string(input.Payload), input.WorkspaceID}
	case "guests":
		if input.ShareID == nil {
			return nil, ErrInvalidInput
		}
		query, args = `SELECT coalesce(jsonb_agg(item), '[]'::jsonb) FROM founder_hub.list_shared_resource_guests($1) item`, []any{*input.ShareID}
	case "invite":
		if input.ShareID == nil || len(input.Email) > 320 {
			return nil, ErrInvalidInput
		}
		query, args = `SELECT coalesce(jsonb_agg(item), '[]'::jsonb) FROM founder_hub.grant_shared_resource_access($1,$2) item`, []any{*input.ShareID, input.Email}
	case "revoke":
		if input.GuestID == nil {
			return nil, ErrInvalidInput
		}
		query, args = `SELECT coalesce(jsonb_agg(item), '[]'::jsonb) FROM founder_hub.revoke_shared_resource_access($1) item`, []any{*input.GuestID}
	case "delete":
		if input.ShareID == nil {
			return nil, ErrInvalidInput
		}
		query, args = `SELECT coalesce(jsonb_agg(item), '[]'::jsonb) FROM founder_hub.delete_shared_resource($1) item`, []any{*input.ShareID}
	default:
		return nil, ErrInvalidInput
	}
	if (input.Action == "list" || input.Action == "publish") && !slices.Contains([]string{"folder", "template", "automation"}, input.ResourceType) {
		return nil, ErrInvalidInput
	}
	profile, err := c.GetFounderHubProfile(ctx, actor.UserID)
	if err != nil {
		return nil, err
	}
	snapshot, err := json.Marshal(FounderHubSession{FounderHubProfile: profile, SessionID: session.ID, ExpiresAt: session.ExpiresAt})
	if err != nil {
		return nil, err
	}
	entitlements := []string{}
	for _, workspace := range profile.Workspaces {
		if workspace.Features["workspace:paid"] && slices.Contains(workspace.Permissions, "workspace:read") {
			entitlements = []string{"hyprnote_pro"}
			break
		}
	}
	claims, err := json.Marshal(map[string]any{"sub": profile.AccountUserID, "role": "shots_hub_authenticated", "aud": "authenticated", "email": profile.User.Email, "shots_revision": profile.Revision, "shots_session_id": session.ID, "entitlements": entitlements})
	if err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := tx.PlatformExec(ctx, `SELECT founder_hub.project_shots_authority($1::jsonb)`, string(snapshot)); err != nil {
		return nil, err
	}
	if _, err := tx.PlatformExec(ctx, `SELECT set_config('request.jwt.claims',$1,true)`, string(claims)); err != nil {
		return nil, err
	}
	if _, err := tx.PlatformExec(ctx, `SET LOCAL ROLE shots_hub_authenticated`); err != nil {
		return nil, err
	}
	var result json.RawMessage
	if err := tx.PlatformQuery(ctx, query, args, func(row entsql.ColumnScanner) error { return row.Scan(&result) }); err != nil {
		var state interface{ SQLState() string }
		if errors.As(err, &state) {
			switch state.SQLState() {
			case "42501":
				return nil, publishing.ErrForbidden
			case "22023", "22P02":
				return nil, ErrInvalidInput
			case "40001":
				return nil, publishing.ErrConflict
			}
		}
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return result, nil
}
