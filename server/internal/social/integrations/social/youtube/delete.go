package youtube

import (
	"context"
	"net/url"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
)

// DeletePost deletes a video the channel uploaded (videos.delete).
func (p *Provider) DeletePost(ctx context.Context, integration *ent.Integration, id string) error {
	endpoint := youtubeAPI + "/youtube/v3/videos?id=" + url.QueryEscape(id)
	return integrations.SendDelete(ctx, nil, endpoint, map[string]string{"Authorization": "Bearer " + integration.Token})
}
