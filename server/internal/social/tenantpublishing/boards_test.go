package tenantpublishing

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	socialent "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
)

type boardsPoster struct{ *fakePoster }

func (boardsPoster) Functions() map[string]integrations.Function {
	return map[string]integrations.Function{"boards": func(_ context.Context, token string, _ json.RawMessage, _ string, _ *socialent.Integration) (any, error) {
		if token != "private-token" {
			return nil, errors.New("the account's own token was not used")
		}
		return []map[string]string{{"id": "1001", "name": "Launch ideas", "privacy": "PUBLIC"}}, nil
	}}
}

func TestPinterestBoardsUseTheAccountsOwnAuthorization(t *testing.T) {
	p, _, base, input := directFixture()
	p.integrations = fakeIntegrations{&socialent.Integration{ID: "destination", OrganizationID: "social-org", ProviderIdentifier: "pinterest", InternalID: "remote-user", Token: "private-token"}}
	p.resolve = func(string) poster { return boardsPoster{base} }
	boards, err := p.PinterestBoards(context.Background(), input.OrganizationID, input.DestinationID, input.SecretReference)
	if err != nil || !reflect.DeepEqual(boards, []product.PinterestBoard{{ID: "1001", Name: "Launch ideas"}}) {
		t.Fatalf("boards=%+v err=%v", boards, err)
	}
	if _, err := p.PinterestBoards(context.Background(), input.OrganizationID, input.DestinationID, "another-tenant-secret"); err == nil {
		t.Fatal("boards listed through another workspace's binding")
	}
	p.resolve = func(string) poster { return base }
	if _, err := p.PinterestBoards(context.Background(), input.OrganizationID, input.DestinationID, input.SecretReference); err == nil {
		t.Fatal("a provider without a board list answered with no boards")
	}
}
