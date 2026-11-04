package httpapi

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
)

// channelConfiguration answers the Channels page's reads and records its removals.
type channelConfiguration struct {
	fakeConfiguration
	removed string
}

func (c *channelConfiguration) ChannelAccountStates(_ context.Context, _ string, connections []*ent.ChannelConnection) (map[string]product.ChannelAccountState, error) {
	states := map[string]product.ChannelAccountState{}
	for _, connection := range connections {
		states[connection.ID] = product.ChannelAccountState{Health: "reconnect_required", QueuedPosts: 2}
	}
	return states, nil
}

func (c *channelConfiguration) RemoveChannelAccount(_ context.Context, _ product.Actor, id string) (*product.SocialSetRemoval, error) {
	c.removed = id
	return &product.SocialSetRemoval{CancelledPostIDs: []string{"post-9"}}, nil
}

func (c *channelConfiguration) AuthorizeChannelManage(context.Context, product.Actor) error {
	return nil
}

func TestChannelConnectionsListBrandHealthAndQueue(t *testing.T) {
	brand, name := "set-1", "Named already"
	store := &fakeStore{connections: []*ent.ChannelConnection{{ID: "connection01", DisplayName: &name, ExternalAccountID: "social-x",
		Platform: "x", Status: "ACTIVE", SocialSetID: &brand}}}
	handler := NewWithConfiguration(store, &fakeScheduler{}, &fakeVerifier{}, "secret", &channelConfiguration{})
	response := configurationRequest(handler, http.MethodGet, "/v1/channel-connections", "")
	body := response.Body.String()
	for _, want := range []string{`"socialSetId":"set-1"`, `"health":"reconnect_required"`, `"queuedPosts":2`} {
		if response.Code != http.StatusOK || !strings.Contains(body, want) {
			t.Fatalf("status=%d, want %s in %s", response.Code, want, body)
		}
	}
}

func TestChannelConnectionRemovalStopsCancelledPosts(t *testing.T) {
	config := &channelConfiguration{}
	scheduler := &fakeScheduler{}
	handler := NewWithConfiguration(&fakeStore{}, scheduler, &fakeVerifier{}, "secret", config)
	response := configurationRequest(handler, http.MethodDelete, "/v1/channel-connections/connection01", "")
	if response.Code != http.StatusOK || config.removed != "connection01" || scheduler.cancelled != "post-9" {
		t.Fatalf("status=%d removed=%q cancelled=%q body=%s", response.Code, config.removed, scheduler.cancelled, response.Body.String())
	}
}

func TestChannelConnectionRefreshReadsTheProfileAgain(t *testing.T) {
	store := &fakeStore{connections: []*ent.ChannelConnection{{ID: "connection01", ExternalAccountID: "social-x", Platform: "x", Status: "ACTIVE"}}}
	handler := NewWithConfiguration(store, &fakeScheduler{}, &fakeVerifier{}, "secret", &channelConfiguration{})
	response := configurationRequest(handler, http.MethodPost, "/v1/channel-connections/connection01/refresh", "")
	body := response.Body.String()
	if response.Code != http.StatusOK || !strings.Contains(body, `"displayName":"Shots"`) || !strings.Contains(body, `"health":"reconnect_required"`) {
		t.Fatalf("status=%d body=%s", response.Code, body)
	}
	if missing := configurationRequest(handler, http.MethodPost, "/v1/channel-connections/connection02/refresh", ""); missing.Code != http.StatusNotFound {
		t.Fatalf("an unknown account refreshed: %d", missing.Code)
	}
}
