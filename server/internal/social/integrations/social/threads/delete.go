package threads

import (
	"context"
	"net/url"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
)

// DeletePost deletes a post the account published. Threads needs the
// threads_delete permission and allows 100 deletes per account per day. Shots
// does not ask for the permission yet (it needs Meta's approval for the app),
// so Threads refuses the call and the part records the refusal.
func (p *Provider) DeletePost(ctx context.Context, integration *ent.Integration, id string) error {
	endpoint := graphURL + "/v1.0/" + url.PathEscape(id)
	return integrations.SendDelete(ctx, nil, endpoint, map[string]string{"Authorization": "Bearer " + integration.Token})
}
