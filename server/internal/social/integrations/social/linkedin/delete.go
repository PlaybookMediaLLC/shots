package linkedin

import (
	"context"
	"errors"
	"strings"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
)

// DeletePost deletes a post or a comment the account published. A comment
// URN names its post and its own id; the comment is deleted as its author,
// the member or, on a Page connection, the organization.
func (p *Provider) DeletePost(ctx context.Context, integration *ent.Integration, id string) error {
	headers := Headers(integration.Token, "")
	headers["X-RestLi-Method"] = "DELETE"
	if postURN.MatchString(id) {
		return integrations.SendDelete(ctx, nil, APIURL+"/rest/posts/"+EncodeURIComponent(id), headers)
	}
	if !commentURN.MatchString(id) {
		return errors.New("not a LinkedIn post or comment")
	}
	parent, comment, _ := strings.Cut(strings.TrimSuffix(strings.TrimPrefix(id, "urn:li:comment:("), ")"), ",")
	postType := Personal
	if p.identifier == "linkedin-page" {
		postType = Company
	}
	endpoint := APIURL + "/rest/socialActions/" + EncodeURIComponent(parent) + "/comments/" + comment +
		"?actor=" + EncodeURIComponent(authorURN(postType, integration.InternalID))
	return integrations.SendDelete(ctx, nil, endpoint, headers)
}
