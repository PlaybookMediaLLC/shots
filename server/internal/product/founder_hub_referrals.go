package product

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"

	entsql "entgo.io/ent/dialect/sql"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

type FounderHubReferralClaim struct {
	Claimed bool `json:"claimed"`
}

func (c *Configuration) FounderHubReferralSummary(ctx context.Context, actor Actor) (json.RawMessage, error) {
	tx, _, err := c.founderHubAuthenticatedTx(ctx, actor)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var result json.RawMessage
	if err := tx.PlatformQuery(ctx, `SELECT founder_hub.get_referral_summary()`, nil, func(row entsql.ColumnScanner) error { return row.Scan(&result) }); err != nil {
		return nil, founderHubFunctionError(err)
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return result, nil
}

func (c *Configuration) ClaimFounderHubReferral(ctx context.Context, actor Actor, code string) (*FounderHubReferralClaim, error) {
	decoded, err := hex.DecodeString(code)
	if err != nil || len(decoded) != 12 || strings.ToLower(code) != code {
		return nil, ErrInvalidInput
	}
	tx, _, err := c.founderHubAuthenticatedTx(ctx, actor)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var result FounderHubReferralClaim
	if err := tx.PlatformQuery(ctx, `SELECT founder_hub.claim_referral($1)`, []any{code}, func(row entsql.ColumnScanner) error { return row.Scan(&result.Claimed) }); err != nil {
		return nil, founderHubFunctionError(err)
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &result, nil
}

func founderHubFunctionError(err error) error {
	var state interface{ SQLState() string }
	if errors.As(err, &state) {
		switch state.SQLState() {
		case "42501":
			return publishing.ErrForbidden
		case "22023", "22P02":
			return ErrInvalidInput
		case "40001":
			return publishing.ErrConflict
		}
	}
	return err
}
