package socialconnect

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"testing"
)

func signMeta(payload, secret string) string {
	encoded := base64.RawURLEncoding.EncodeToString([]byte(payload))
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(encoded))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)) + "." + encoded
}

func TestSignedRequestProvesMetaSentIt(t *testing.T) {
	valid := signMeta(`{"algorithm":"HMAC-SHA256","issued_at":1,"user_id":"178414"}`, "app-secret")
	for name, request := range map[string]string{
		"string id": valid,
		"number id": signMeta(`{"algorithm":"HMAC-SHA256","issued_at":1,"user_id":178414}`, "app-secret"),
	} {
		if user, err := signedRequestUser(request, "app-secret"); err != nil || user != "178414" {
			t.Errorf("%s: user=%q err=%v", name, user, err)
		}
	}
	tamperedPayload := base64.RawURLEncoding.EncodeToString([]byte(`{"algorithm":"HMAC-SHA256","user_id":"999"}`))
	signature, _, _ := cutSigned(valid)
	for name, request := range map[string]string{
		"another app's secret": signMeta(`{"algorithm":"HMAC-SHA256","user_id":"178414"}`, "other-secret"),
		"changed payload":      signature + "." + tamperedPayload,
		"another algorithm":    signMeta(`{"algorithm":"none","user_id":"178414"}`, "app-secret"),
		"no user":              signMeta(`{"algorithm":"HMAC-SHA256"}`, "app-secret"),
		"not json":             signMeta(`nope`, "app-secret"),
		"no separator":         "abc",
		"empty signature":      "." + tamperedPayload,
		"empty":                "",
	} {
		if user, err := signedRequestUser(request, "app-secret"); !errors.Is(err, ErrInvalidSignedRequest) || user != "" {
			t.Errorf("%s accepted: user=%q err=%v", name, user, err)
		}
	}
}

func cutSigned(request string) (string, string, bool) {
	for i := range request {
		if request[i] == '.' {
			return request[:i], request[i+1:], true
		}
	}
	return request, "", false
}

func TestMetaCallbackUsesEachProvidersOwnSecret(t *testing.T) {
	t.Setenv("INSTAGRAM_APP_SECRET", "instagram-secret")
	t.Setenv("THREADS_APP_SECRET", "threads-secret")
	connector := &Connector{}
	payload := `{"algorithm":"HMAC-SHA256","user_id":"7"}`
	if user, err := connector.VerifyMetaCallback("threads", signMeta(payload, "threads-secret")); err != nil || user != "7" {
		t.Fatalf("user=%q err=%v", user, err)
	}
	if _, err := connector.VerifyMetaCallback("threads", signMeta(payload, "instagram-secret")); !errors.Is(err, ErrInvalidSignedRequest) {
		t.Fatalf("Threads accepted Instagram's signature: %v", err)
	}
	if _, err := connector.VerifyMetaCallback("x", signMeta(payload, "threads-secret")); !errors.Is(err, ErrInvalidSignedRequest) {
		t.Fatalf("an unsupported provider was accepted: %v", err)
	}
	t.Setenv("THREADS_APP_SECRET", "")
	// An empty secret must never verify a request signed with an empty key.
	if _, err := connector.VerifyMetaCallback("threads", signMeta(payload, "")); !errors.Is(err, ErrMetaCallbackNotConfigured) {
		t.Fatalf("a missing secret verified a request: %v", err)
	}
}
