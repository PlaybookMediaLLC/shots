package tenantpublishing

import (
	"context"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialapi"
)

// DeleteRemote removes one part of a published post from its platform: it
// deletes a record, or undoes the account's repost. A platform without the
// call reports socialapi.ErrUnsupported; the provider's error is returned
// as is, so the caller can classify it by its HTTP status.
func (p *Publisher) DeleteRemote(ctx context.Context, input socialapi.DeleteInput) error {
	account, provider, _, err := p.account(ctx, input.OrganizationID, input.DestinationID, input.Platform, input.SecretReference, nil)
	if err != nil {
		return err
	}
	if input.Kind == "repost" {
		reposts, ok := provider.(reposter)
		if !ok {
			return socialapi.ErrUnsupported
		}
		return reposts.UnretweetPost(ctx, account, input.RemoteID)
	}
	deleter, ok := provider.(integrations.PostDeleter)
	if !ok {
		return socialapi.ErrUnsupported
	}
	return deleter.DeletePost(ctx, account, input.RemoteID)
}
