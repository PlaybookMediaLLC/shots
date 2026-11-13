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

// VideoProvider substitutes only the remote peer in the isolated social gate,
// standing in for a platform the gate connects by name: TikTok, YouTube, a
// Facebook Page or Pinterest.
type VideoProvider struct {
	*Provider
	platform string
}

func NewVideo(endpoint, platform string) *VideoProvider {
	return &VideoProvider{Provider: New(endpoint), platform: platform}
}

// fixturePages are the destinations a platform with page selection offers.
var fixturePages = map[string]string{"youtube": "Fixture YouTube channel", "facebook": "Fixture Facebook Page", "gmb": "Fixture business location"}

func (p *VideoProvider) Info() integrations.Info {
	_, pages := fixturePages[p.platform]
	return integrations.Info{Identifier: p.platform, Name: "Fixture " + p.platform, Editor: "normal", IsBetweenSteps: pages}
}

func (p *VideoProvider) Functions() map[string]integrations.Function {
	if p.platform == "pinterest" {
		return map[string]integrations.Function{"boards": func(context.Context, string, json.RawMessage, string, *ent.Integration) (any, error) {
			return []map[string]string{{"id": "1001", "name": "Launch ideas"}, {"id": "1002", "name": "Office"}}, nil
		}}
	}
	name, ok := fixturePages[p.platform]
	if !ok {
		return nil
	}
	return map[string]integrations.Function{"pages": func(context.Context, string, json.RawMessage, string, *ent.Integration) (any, error) {
		return []map[string]string{{"id": "fixture-channel", "name": name}}, nil
	}}
}

func (p *VideoProvider) FetchPageInformation(_ context.Context, token string, data json.RawMessage) (*integrations.FetchPageInformationResult, error) {
	var selection struct {
		ID string `json:"id"`
	}
	name, ok := fixturePages[p.platform]
	if !ok || json.Unmarshal(data, &selection) != nil || selection.ID != "fixture-channel" {
		return nil, errors.New("unknown fixture channel")
	}
	return &integrations.FetchPageInformationResult{ID: selection.ID, Name: name, Username: "fixture", AccessToken: token}, nil
}

func (p *VideoProvider) CreatorInfo(context.Context, string) (*postoptions.TikTokCreator, error) {
	return &postoptions.TikTokCreator{Nickname: "Fixture TikTok creator", PrivacyLevels: []string{"SELF_ONLY"}, MaxDurationSeconds: 60}, nil
}

func (p *VideoProvider) ConfirmVideo(context.Context, string, string, string) (string, error) {
	return "private", nil
}

// SetThumbnail asks the fake to set a live video's thumbnail; the fake may
// refuse it, as an unverified channel would.
func (p *VideoProvider) SetThumbnail(ctx context.Context, _, videoID, thumbnail string) error {
	_, err := p.action(ctx, "thumbnail", videoID, thumbnail)
	return err
}
