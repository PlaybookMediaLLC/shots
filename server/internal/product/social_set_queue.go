package product

import (
	"context"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/schema"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

// SocialSetQueueUpdate changes future slot suggestions only. It cannot change
// approval requirements, connected identities, or an existing publication time.
type SocialSetQueueUpdate struct {
	BaseVersion         int                 `json:"baseVersion"`
	TimeZone            *string             `json:"timeZone,omitempty"`
	PostingSlots        *[]schema.QueueSlot `json:"postingSlots,omitempty"`
	NaturalPostingTimes *bool               `json:"naturalPostingTimes,omitempty"`
}

func (c *Configuration) authorizeSocialSetQueue(ctx context.Context, actor Actor) error {
	if actor.Kind != "api_key" {
		return c.authorizeSocialSetManage(ctx, actor)
	}
	if actor.KeyID == "" || actor.UserID != "" {
		return publishing.ErrForbidden
	}
	if err := c.auth.AuthorizeAPIKeyScope(ctx, actor.OrganizationID, actor.KeyID, "queue:write"); err != nil {
		return err
	}
	return c.requireWorkspaceFeature(ctx, actor.OrganizationID, contentDraftFeature)
}

// UpdateSocialSetQueue exposes the queue subset of the canonical settings save.
// Keys need a separate opt-in scope; draft:write alone grants no queue authority.
func (c *Configuration) UpdateSocialSetQueue(ctx context.Context, actor Actor, id string, input SocialSetQueueUpdate) (*SocialSetRecord, error) {
	if input.TimeZone == nil && input.PostingSlots == nil && input.NaturalPostingTimes == nil {
		return nil, invalid("Choose at least one queue setting to change.")
	}
	return c.updateSocialSet(ctx, actor, id, SocialSetUpdate{BaseVersion: input.BaseVersion, TimeZone: input.TimeZone, PostingSlots: input.PostingSlots, NaturalPostingTimes: input.NaturalPostingTimes}, true)
}

// lockSocialSetAuthority makes permission and visibility rechecks atomic with a
// settings save. Revoking identity, membership or subscription cannot race it.
func lockSocialSetAuthority(ctx context.Context, tx *ent.Tx, actor Actor, id string) error {
	queries := []struct {
		sql  string
		args []any
	}{
		{`SELECT id FROM organization WHERE id=$1 FOR SHARE`, []any{actor.OrganizationID}},
		{`SELECT "organizationId" FROM workspace_entitlement WHERE "organizationId"=$1 FOR SHARE`, []any{actor.OrganizationID}},
	}
	if actor.Kind == "api_key" {
		queries = append(queries, struct {
			sql  string
			args []any
		}{`SELECT id FROM apikey WHERE id=$1 AND "referenceId"=$2 FOR SHARE`, []any{actor.KeyID, actor.OrganizationID}})
	} else {
		queries = append(queries, struct {
			sql  string
			args []any
		}{`SELECT id FROM session WHERE id=$1 FOR SHARE`, []any{actor.SessionID}}, struct {
			sql  string
			args []any
		}{`SELECT id FROM "user" WHERE id=$1 FOR SHARE`, []any{actor.UserID}}, struct {
			sql  string
			args []any
		}{`SELECT id FROM member WHERE "organizationId"=$1 AND "userId"=$2 FOR SHARE`, []any{actor.OrganizationID, actor.UserID}})
	}
	queries = append(queries, struct {
		sql  string
		args []any
	}{`SELECT id FROM social_set WHERE id=$1 AND "organizationId"=$2 FOR UPDATE`, []any{id, actor.OrganizationID}})
	for _, query := range queries {
		if _, err := tx.PlatformExec(ctx, query.sql, query.args...); err != nil {
			return err
		}
	}
	return nil
}
