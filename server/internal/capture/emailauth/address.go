package emailauth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/hex"
	"net/mail"
	"strings"
)

// localPartBytes is 130 bits of randomness, over the RFC's 128-bit floor.
const localPartBytes = 17

var lowerBase32 = base32.NewEncoding("abcdefghijklmnopqrstuvwxyz234567").WithPadding(base32.NoPadding)

// NewLocalPart makes a random, unguessable routing name for one connection,
// such as c-k5q.... It routes mail; it is not a credential.
func NewLocalPart() (string, error) {
	buf := make([]byte, localPartBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return "c-" + lowerBase32.EncodeToString(buf), nil
}

// Canonical reads one address and lower-cases it. It strips a display name
// but never a plus tag or dots: providers treat those differently, so only
// an exact match routes.
func Canonical(raw string) (string, bool) {
	parsed, err := mail.ParseAddress(strings.TrimSpace(raw))
	if err != nil {
		return "", false
	}
	local, domain, ok := strings.Cut(parsed.Address, "@")
	if !ok || local == "" || domain == "" || strings.Contains(domain, "@") {
		return "", false
	}
	return strings.ToLower(local) + "@" + strings.ToLower(strings.TrimSuffix(domain, ".")), true
}

// RecipientHash keys a receipt to its address without storing the address.
func RecipientHash(key, canonical string) string {
	mac := hmac.New(sha256.New, []byte("shots-capture-recipient:"+key))
	mac.Write([]byte(canonical))
	return hex.EncodeToString(mac.Sum(nil))
}

// SenderAllowed matches a sender against the owner's list: an exact address,
// or "@example.com" for one exact domain. There are no wildcards. A From
// header is spoofable, so a match is one check among several, never proof.
func SenderAllowed(from string, allowed []string) bool {
	sender, ok := Canonical(from)
	if !ok {
		return false
	}
	_, domain, _ := strings.Cut(sender, "@")
	for _, rule := range allowed {
		rule = strings.ToLower(strings.TrimSpace(rule))
		if rule == sender || (strings.HasPrefix(rule, "@") && rule[1:] == domain) {
			return true
		}
	}
	return false
}

// ValidSenderRule accepts an exact address or "@domain".
func ValidSenderRule(rule string) bool {
	rule = strings.TrimSpace(rule)
	if strings.Contains(rule, "*") {
		return false
	}
	if domain, ok := strings.CutPrefix(rule, "@"); ok {
		_, valid := Canonical("x@" + domain)
		return valid && !strings.ContainsAny(domain, "*@ ")
	}
	canonical, ok := Canonical(rule)
	return ok && canonical == strings.ToLower(rule)
}
