package product

import (
	"context"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
)

// PinterestBoard is one of a Pinterest account's boards, as Pinterest names it.
type PinterestBoard struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// BoardFinder reads a Pinterest account's boards with its own authorization.
type BoardFinder interface {
	PinterestBoards(ctx context.Context, organizationID, destinationID, secretReference string) ([]PinterestBoard, error)
}

// LookupPinterestBoards lists the boards of the visible social set's Pinterest
// account, for choosing where a pin is saved.
func (c *Configuration) LookupPinterestBoards(ctx context.Context, actor Actor, setID string) ([]PinterestBoard, error) {
	if err := c.authorizeContentDrafts(ctx, actor, true); err != nil {
		return nil, err
	}
	set, err := visibleSocialSet(ctx, c.client, actor, setID)
	if err != nil {
		return nil, err
	}
	connection, err := setAccount(ctx, c.client, set, "pinterest")
	if ent.IsNotFound(err) {
		return nil, conflict("Connect Pinterest to this social set to choose a board.")
	}
	if err != nil {
		return nil, err
	}
	finder, ok := c.accounts.(BoardFinder)
	if !ok {
		return nil, conflict("Pinterest boards are unavailable on this server.")
	}
	return finder.PinterestBoards(ctx, actor.OrganizationID, connection.ExternalAccountID, connection.SecretReference)
}
