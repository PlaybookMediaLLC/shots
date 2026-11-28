package product

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"strings"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/userpreference"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/config"
)

// verifyAutomationUnsubscribeToken checks the HMAC-SHA256 signature in constant
// time and extracts the user ID from a token issued by maintenance.AutomationUnsubscribeToken.
func verifyAutomationUnsubscribeToken(token, secret string) (string, bool) {
	if token == "" || secret == "" {
		return "", false
	}
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return "", false
	}
	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", false
	}
	sigBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(payloadBytes)
	if !hmac.Equal(sigBytes, mac.Sum(nil)) {
		return "", false
	}
	payload := string(payloadBytes)
	userID, ok := strings.CutPrefix(payload, "automation:")
	if !ok || userID == "" {
		return "", false
	}
	return userID, true
}

// UnsubscribeAutomationEmails verifies a signed one-click unsubscribe token and
// sets user_preference.automation_emails = false for the bound user.
func (c *Configuration) UnsubscribeAutomationEmails(ctx context.Context, token string) error {
	userID, ok := verifyAutomationUnsubscribeToken(token, config.EmailUnsubscribeSecret())
	if !ok {
		return invalid("This unsubscribe link is invalid or expired.")
	}
	row, err := c.client.UserPreference.Get(ctx, userID)
	if ent.IsNotFound(err) {
		_, err = c.client.UserPreference.Create().
			SetID(userID).
			SetNavigation(userpreference.Navigation(defaultUserPreferences().Navigation)).
			SetAutomationEmails(false).
			Save(ctx)
		if ent.IsConstraintError(err) {
			_, err = c.client.UserPreference.Update().Where(userpreference.ID(userID)).SetAutomationEmails(false).AddVersion(1).Save(ctx)
		}
		return err
	}
	if err != nil {
		return err
	}
	if !row.AutomationEmails {
		return nil
	}
	_, err = c.client.UserPreference.Update().Where(userpreference.ID(userID)).SetAutomationEmails(false).AddVersion(1).Save(ctx)
	return err
}
