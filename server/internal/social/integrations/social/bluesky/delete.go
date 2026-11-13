package bluesky

import (
	"context"
	"errors"
	"strings"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
)

// HTTPStatus lets a delete classify the PDS's answer by its status.
func (e *XRPCError) HTTPStatus() int { return e.Status }

// DeletePost deletes a record the account published, named by its AT URI
// (com.atproto.repo.deleteRecord). Only the account's own repo is touched;
// deleting a record that is already gone succeeds.
func (p *Provider) DeletePost(ctx context.Context, integration *ent.Integration, id string) error {
	parts := strings.Split(strings.TrimPrefix(id, "at://"), "/")
	if !strings.HasPrefix(id, "at://") || len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return errors.New("not a Bluesky record")
	}
	a, err := p.loginAgent(ctx, integration)
	if err != nil {
		return err
	}
	did, err := a.accountDid()
	if err != nil {
		return err
	}
	if parts[0] != did {
		return errors.New("the record belongs to another Bluesky account")
	}
	return a.call(ctx, xrpcRequest{
		nsid:        "com.atproto.repo.deleteRecord",
		body:        jsonBody(map[string]any{"repo": did, "collection": parts[1], "rkey": parts[2]}),
		contentType: "application/json",
	}, nil)
}
