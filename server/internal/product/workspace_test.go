package product

import (
	"errors"
	"strings"
	"testing"
)

func TestWorkspaceAIProviderKeyCryptoAndHelpers(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	otherKey := []byte("fedcba9876543210fedcba9876543210")
	const secret = "sk-or-v1-secretkey1234567890abcd"

	sealedA, err := sealWorkspaceAIKey(key, "org_a", secret)
	if err != nil {
		t.Fatalf("seal failed: %v", err)
	}
	sealedB, err := sealWorkspaceAIKey(key, "org_a", secret)
	if err != nil {
		t.Fatalf("second seal failed: %v", err)
	}
	if sealedA == sealedB {
		t.Fatal("fresh nonces must produce distinct ciphertexts")
	}
	if strings.Contains(sealedA, secret) {
		t.Fatal("sealed output must not contain plaintext")
	}
	opened, err := openWorkspaceAIKey(key, "org_a", sealedA)
	if err != nil || opened != secret {
		t.Fatalf("open=%q err=%v", opened, err)
	}
	if _, err := openWorkspaceAIKey(key, "org_b", sealedA); !errors.Is(err, ErrAIKeyDecryptionFailed) {
		t.Fatalf("wrong org AAD expected ErrAIKeyDecryptionFailed got %v", err)
	}
	if _, err := openWorkspaceAIKey(otherKey, "org_a", sealedA); !errors.Is(err, ErrAIKeyDecryptionFailed) {
		t.Fatalf("wrong key expected ErrAIKeyDecryptionFailed got %v", err)
	}
	for _, malformed := range []string{"", "nodot", "a.b.c", "!!!.abc", "abc.!!!", "AAAA.BBBB"} {
		if _, err := openWorkspaceAIKey(key, "org_a", malformed); !errors.Is(err, ErrAIKeyDecryptionFailed) {
			t.Fatalf("malformed %q expected ErrAIKeyDecryptionFailed got %v", malformed, err)
		}
	}
	if _, err := sealWorkspaceAIKey(nil, "org_a", secret); !errors.Is(err, ErrAIKeyEncryptionUnavailable) {
		t.Fatalf("missing key seal expected ErrAIKeyEncryptionUnavailable got %v", err)
	}
	if _, err := openWorkspaceAIKey([]byte("short"), "org_a", sealedA); !errors.Is(err, ErrAIKeyEncryptionUnavailable) {
		t.Fatalf("short key open expected ErrAIKeyEncryptionUnavailable got %v", err)
	}

	if got := formatAPIKeyHint("sk-or-v1-1234567890abcd"); got != "sk-or-…abcd" {
		t.Fatalf("sk-or hint=%q", got)
	}
	if got := formatAPIKeyHint("sk-proj-1234567890wxyz"); got != "sk-…wxyz" {
		t.Fatalf("sk hint=%q", got)
	}
	if got := formatAPIKeyHint("opaque-key-1234567890efgh"); got != "…efgh" {
		t.Fatalf("opaque hint=%q", got)
	}

	for _, valid := range []string{strings.Repeat("a", 16), strings.Repeat("z", 512), secret} {
		if !validAIProviderAPIKey(valid) {
			t.Fatalf("expected valid key len=%d", len(valid))
		}
	}
	for _, invalid := range []string{strings.Repeat("a", 15), strings.Repeat("a", 513), "sk-or-v1-has space 123456", "sk-or-v1-newline\n12345678", "sk-or-v1-utf8-é-12345678"} {
		if validAIProviderAPIKey(invalid) {
			t.Fatalf("expected invalid key %q", invalid)
		}
	}

	defaults := map[string]any{
		"default": map[string]any{"tier": "balanced", "effort": "medium"},
		"editors": map[string]any{"tier": "fast", "effort": "low"},
		"writing": map[string]any{"tier": "deep", "effort": "high"},
	}
	if !aiDefaultsContainBYOKTier(defaults) {
		t.Fatal("expected BYOK tier detection")
	}
	stripped := stripBYOKTiersFromDefaults(defaults)
	if aiDefaultsContainBYOKTier(stripped) || len(stripped) != 1 || stripped["editors"] == nil {
		t.Fatalf("unexpected stripped defaults: %+v", stripped)
	}
}
