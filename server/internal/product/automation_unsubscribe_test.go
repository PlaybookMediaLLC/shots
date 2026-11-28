package product

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/config"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/maintenance"
)

func signRawPayload(payload, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func TestVerifyAutomationUnsubscribeToken(t *testing.T) {
	const secret = "test-unsubscribe-secret-value"

	// Round-trip directly against the maintenance signer so both sides cannot drift.
	token := maintenance.AutomationUnsubscribeToken("user_123", secret)
	gotUserID, ok := verifyAutomationUnsubscribeToken(token, secret)
	if !ok {
		t.Fatalf("expected valid token from maintenance.AutomationUnsubscribeToken to verify")
	}
	if gotUserID != "user_123" {
		t.Fatalf("got userID %q, want %q", gotUserID, "user_123")
	}

	// Tampered signature must fail.
	if _, ok := verifyAutomationUnsubscribeToken(token+"x", secret); ok {
		t.Fatalf("expected tampered token to fail verification")
	}

	// Wrong secret must fail.
	wrongSecretToken := maintenance.AutomationUnsubscribeToken("user_123", "different-secret")
	if _, ok := verifyAutomationUnsubscribeToken(wrongSecretToken, secret); ok {
		t.Fatalf("expected token signed with wrong secret to fail")
	}

	// Wrong prefix or empty userID must fail even with a valid signature.
	if _, ok := verifyAutomationUnsubscribeToken(signRawPayload("org:user@example.com", secret), secret); ok {
		t.Fatalf("expected non-automation prefix to fail verification")
	}
	if _, ok := verifyAutomationUnsubscribeToken(signRawPayload("automation:", secret), secret); ok {
		t.Fatalf("expected empty userID to fail verification")
	}

	// Malformed or empty secret must fail.
	if _, ok := verifyAutomationUnsubscribeToken("not-a-valid-token", secret); ok {
		t.Fatalf("expected malformed token to fail")
	}
	if _, ok := verifyAutomationUnsubscribeToken(token, ""); ok {
		t.Fatalf("expected empty secret to fail")
	}
}

func TestEmailUnsubscribeSecretPrecedence(t *testing.T) {
	t.Setenv("EMAIL_UNSUBSCRIBE_SECRET", "")
	t.Setenv("BETTER_AUTH_SECRET", "")
	t.Setenv("PUBLISHING_SERVICE_TOKEN", "service-token-must-never-be-used")
	if got := config.EmailUnsubscribeSecret(); got != "" {
		t.Fatalf("expected empty secret when only PUBLISHING_SERVICE_TOKEN is set, got %q", got)
	}

	t.Setenv("BETTER_AUTH_SECRET", "auth-secret-fallback")
	if got := config.EmailUnsubscribeSecret(); got != "auth-secret-fallback" {
		t.Fatalf("expected BETTER_AUTH_SECRET fallback, got %q", got)
	}

	t.Setenv("EMAIL_UNSUBSCRIBE_SECRET", "dedicated-unsubscribe-secret")
	if got := config.EmailUnsubscribeSecret(); got != "dedicated-unsubscribe-secret" {
		t.Fatalf("expected EMAIL_UNSUBSCRIBE_SECRET precedence, got %q", got)
	}
}
