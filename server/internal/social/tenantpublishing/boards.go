package tenantpublishing

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
)

// PinterestBoards lists the account's boards through its adapter's boards
// function, for the composer's board picker.
func (p *Publisher) PinterestBoards(ctx context.Context, org, destination, secret string) ([]product.PinterestBoard, error) {
	account, provider, _, err := p.account(ctx, org, destination, "pinterest", secret, nil)
	if err != nil {
		return nil, err
	}
	functions, ok := provider.(interface {
		Functions() map[string]integrations.Function
	})
	var list integrations.Function
	if ok {
		list = functions.Functions()["boards"]
	}
	if list == nil {
		return nil, fmt.Errorf("board listing is unavailable for this connection")
	}
	found, err := list(ctx, account.Token, nil, "", account)
	if err != nil {
		return nil, err
	}
	boards := []product.PinterestBoard{}
	if data, err := json.Marshal(found); err != nil || json.Unmarshal(data, &boards) != nil {
		return nil, fmt.Errorf("pinterest returned boards Shots cannot read")
	}
	return boards, nil
}
