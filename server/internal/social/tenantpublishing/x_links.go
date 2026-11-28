package tenantpublishing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/helpers"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialapi"
)

// XLinkDecision mirrors product.XLinkSendDecision without importing internal/product.
type XLinkDecision struct {
	AllowLinks    bool
	Limit         int
	NextSlotAt    *time.Time
	QuotaConsumed bool
	Reason        string
	Refund        func()
}

// XLinkPolicy evaluates whether a workspace may publish an outbound X tweet
// with links and reserves one rolling 30-day ledger slot when permitted.
type XLinkPolicy interface {
	PrepareXLinkSend(ctx context.Context, orgID string, scheduledPostID *string, partKey, idempotencyKey string, linkCount int) (XLinkDecision, error)
}

// XLinkOutcomeRecorder persists stripped-link and quota-consumption metadata
// on the scheduled post and its open publication attempt after a send succeeds.
type XLinkOutcomeRecorder interface {
	RecordXLinkOutcome(ctx context.Context, scheduledPostID string, linksStripped int, quotaConsumed bool) error
}

// WithXLinkPolicy equips the publisher to enforce default X link stripping and
// paid rolling 30-day link allowances on every outbound X tweet.
func (p *Publisher) WithXLinkPolicy(policy XLinkPolicy) *Publisher {
	p.xLinks = policy
	return p
}

// WithXLinkRecorder equips the publisher to record stripped-link counts and
// link-quota usage on published posts and attempts.
func (p *Publisher) WithXLinkRecorder(recorder XLinkOutcomeRecorder) *Publisher {
	p.xLinkRecorder = recorder
	return p
}

func isXPlatform(platform string) bool {
	return platform == "x" || platform == "twitter"
}

func isXArticleSettings(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return false
	}
	var parsed struct {
		PostType string `json:"post_type"`
	}
	return json.Unmarshal(raw, &parsed) == nil && parsed.PostType == "article"
}

type preparedXText struct {
	text          string
	plainText     bool
	strippedCount int
	quotaConsumed bool
	refund        func()
}

func (p *Publisher) prepareXText(ctx context.Context, platform, orgID, scheduledPostID, partKey, idempotencyKey, text string, hasMedia bool) (preparedXText, error) {
	if !isXPlatform(platform) || p.xLinks == nil {
		return preparedXText{text: text}, nil
	}
	plain := helpers.FlattenXTweetText(text)
	spans, err := helpers.XLinkSpans(plain)
	if err != nil {
		return preparedXText{}, publicationOutcome(err)
	}
	if len(spans) == 0 {
		return preparedXText{text: text}, nil
	}
	var postIDPtr *string
	if scheduledPostID != "" {
		postIDPtr = &scheduledPostID
	}
	decision, err := p.xLinks.PrepareXLinkSend(ctx, orgID, postIDPtr, partKey, idempotencyKey, len(spans))
	if err != nil {
		slog.ErrorContext(ctx, "x link policy check failed", "organizationId", orgID, "postId", scheduledPostID, "partKey", partKey, "error", err)
		return preparedXText{}, socialapi.NewCodedError(http.StatusTooManyRequests, publishing.FailurePublisherUnavailable,
			"Could not verify the workspace's X link allowance, so nothing was sent. It will retry.")
	}
	if decision.AllowLinks {
		return preparedXText{
			text:          text,
			quotaConsumed: decision.QuotaConsumed,
			refund:        decision.Refund,
		}, nil
	}
	if decision.Reason == "quota_exceeded" {
		limit := decision.Limit
		if limit <= 0 {
			limit = 40
		}
		msg := fmt.Sprintf("This workspace has used all %d X link posts in the last 30 days. Wait for the next slot to open or remove the link and retry.", limit)
		if decision.NextSlotAt != nil {
			msg = fmt.Sprintf("This workspace has used all %d X link posts in the last 30 days. The next slot opens on %s, or remove the link and retry.",
				limit, decision.NextSlotAt.UTC().Format("Jan 2, 2006 at 15:04 UTC"))
		}
		return preparedXText{}, socialapi.NewCodedError(http.StatusForbidden, publishing.FailureXLinkQuotaExceeded, msg)
	}
	stripped, removed := helpers.StripXLinkSpans(plain, spans)
	if stripped == "" && !hasMedia {
		return preparedXText{}, socialapi.NewCodedError(http.StatusBadRequest, publishing.FailureXLinkStrippedEmpty,
			"This X post only contained a link and no media. Turn on Links in X posts in Billing settings or add text or media.")
	}
	return preparedXText{
		text:          stripped,
		plainText:     true,
		strippedCount: removed,
	}, nil
}

func (p *Publisher) recordXOutcome(ctx context.Context, scheduledPostID string, prepared preparedXText) {
	if p.xLinkRecorder == nil || scheduledPostID == "" || (prepared.strippedCount == 0 && !prepared.quotaConsumed) {
		return
	}
	if err := p.xLinkRecorder.RecordXLinkOutcome(ctx, scheduledPostID, prepared.strippedCount, prepared.quotaConsumed); err != nil {
		slog.WarnContext(ctx, "could not record x link publication metadata", "postId", scheduledPostID, "error", err)
	}
}

// refundXLinkOnDefiniteFailure fails closed: it ONLY refunds a reserved rolling
// 30-day X link slot when err is classified as a definite pre-send failure.
// Ambiguous transport/5xx/bad-body errors never refund.
func refundXLinkOnDefiniteFailure(err error, refund func()) {
	if err == nil || refund == nil {
		return
	}
	var apiErr *socialapi.Error
	if errors.As(err, &apiErr) {
		if !apiErr.UnknownDelivery {
			refund()
		}
		return
	}
	mapped := publicationOutcome(err)
	if errors.As(mapped, &apiErr) && !apiErr.UnknownDelivery {
		refund()
	}
}
