package main

import (
	"context"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/tenantpublishing"
)

type xLinkPolicyAdapter struct{ store *product.Configuration }

func (a xLinkPolicyAdapter) PrepareXLinkSend(ctx context.Context, orgID string, scheduledPostID *string, partKey, idempotencyKey string, linkCount int) (tenantpublishing.XLinkDecision, error) {
	decision, err := a.store.PrepareXLinkSend(ctx, orgID, scheduledPostID, partKey, idempotencyKey, linkCount)
	if err != nil {
		return tenantpublishing.XLinkDecision{}, err
	}
	return tenantpublishing.XLinkDecision{
		AllowLinks:    decision.AllowLinks,
		Limit:         decision.Limit,
		NextSlotAt:    decision.NextSlotAt,
		QuotaConsumed: decision.QuotaConsumed,
		Reason:        decision.Reason,
		Refund:        decision.Refund,
	}, nil
}
