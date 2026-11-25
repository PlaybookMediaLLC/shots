// Package emailauth holds the provider-neutral parts of unattended email
// sign-in (RFC 007A): webhook signature checks, test-address routing, the
// Resend Receiving client, and the deterministic challenge parser. Email
// content is hostile input: nothing here renders it, runs it, or sends it to
// a model, and no function returns a link or code except as a redacted secret.
package emailauth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strconv"
	"strings"
	"time"
)

// SignatureTolerance bounds how old or early a signed delivery may be.
const SignatureTolerance = 5 * time.Minute

// ErrSignature is any webhook that does not verify. Its text is fixed, so it
// can never echo a header or body.
var ErrSignature = errors.New("webhook signature did not verify")

// VerifySignature checks a Resend (Svix) webhook over its exact body bytes:
// base64 HMAC-SHA256 of "id.timestamp.body" with the endpoint secret, within
// the timestamp tolerance. Any of several space-separated v1 signatures may
// match, which lets a secret rotate.
func VerifySignature(secret, id, timestamp, signatures string, body []byte, now time.Time) error {
	key, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(strings.TrimSpace(secret), "whsec_"))
	if err != nil || len(key) == 0 || id == "" || timestamp == "" || signatures == "" {
		return ErrSignature
	}
	seconds, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil {
		return ErrSignature
	}
	if delta := now.Sub(time.Unix(seconds, 0)); delta > SignatureTolerance || delta < -SignatureTolerance {
		return ErrSignature
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(id + "." + timestamp + "."))
	mac.Write(body)
	expected := mac.Sum(nil)
	for _, candidate := range strings.Fields(signatures) {
		version, value, ok := strings.Cut(candidate, ",")
		if !ok || version != "v1" {
			continue
		}
		decoded, err := base64.StdEncoding.DecodeString(value)
		if err == nil && hmac.Equal(decoded, expected) {
			return nil
		}
	}
	return ErrSignature
}

// Sign makes a v1 signature header value, for tests and local fixtures.
func Sign(secret, id, timestamp string, body []byte) string {
	key, _ := base64.StdEncoding.DecodeString(strings.TrimPrefix(secret, "whsec_"))
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(id + "." + timestamp + "."))
	mac.Write(body)
	return "v1," + base64.StdEncoding.EncodeToString(mac.Sum(nil))
}
