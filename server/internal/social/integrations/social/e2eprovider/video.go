//go:build e2e

package e2eprovider

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
)

// VideoProvider substitutes only the remote peer in the isolated social gate.
type VideoProvider struct {
	*Provider
	platform string
}

func NewVideo(endpoint, platform string) *VideoProvider {
	return &VideoProvider{Provider: New(endpoint), platform: platform}
}

func (p *VideoProvider) Info() integrations.Info {
	return integrations.Info{Identifier: p.platform, Name: "Fixture " + p.platform, Editor: "normal", IsBetweenSteps: p.platform == "youtube"}
}

func (p *VideoProvider) Functions() map[string]integrations.Function {
	return map[string]integrations.Function{"pages": func(context.Context, string, json.RawMessage, string, *ent.Integration) (any, error) {
		return []map[string]string{{"id": "fixture-channel", "name": "Fixture YouTube channel"}}, nil
	}}
}

func (p *VideoProvider) FetchPageInformation(_ context.Context, token string, data json.RawMessage) (*integrations.FetchPageInformationResult, error) {
	var selection struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(data, &selection) != nil || selection.ID != "fixture-channel" {
		return nil, errors.New("unknown fixture channel")
	}
	return &integrations.FetchPageInformationResult{ID: selection.ID, Name: "Fixture YouTube channel", Username: "fixture", AccessToken: token}, nil
}

func (p *VideoProvider) CreatorInfo(context.Context, string) (*postoptions.TikTokCreator, error) {
	return &postoptions.TikTokCreator{Nickname: "Fixture TikTok creator", PrivacyLevels: []string{"SELF_ONLY"}, MaxDurationSeconds: 60}, nil
}

func (p *VideoProvider) ConfirmVideo(context.Context, string, string, string) (string, error) {
	return "private", nil
}
