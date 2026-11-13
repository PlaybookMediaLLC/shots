package mastodon

import (
	"context"
	"net/http"
	"net/url"
	"strings"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
)

// DeletePost deletes a status the account published on the default instance.
func (p *Provider) DeletePost(ctx context.Context, integration *ent.Integration, id string) error {
	return DeleteStatus(ctx, nil, DefaultURL(), integration.Token, id)
}

// DeleteStatus deletes a status on an instance (DELETE /api/v1/statuses/:id)
// through client; nil uses the SSRF-guarded default.
func DeleteStatus(ctx context.Context, client *http.Client, instanceURL, token, id string) error {
	endpoint := strings.TrimRight(instanceURL, "/") + "/api/v1/statuses/" + url.PathEscape(id)
	return integrations.SendDelete(ctx, client, endpoint, map[string]string{"Authorization": "Bearer " + token})
}
