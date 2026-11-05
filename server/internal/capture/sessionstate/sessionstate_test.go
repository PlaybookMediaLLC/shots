package sessionstate

import (
	"bytes"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
)

func TestSessionStateRefusesEverythingButItsOwnEnvelope(t *testing.T) {
	key, other := bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{2}, 32)
	keys, err := NewKeys(key)
	if err != nil {
		t.Fatal(err)
	}
	binding := Binding{Organization: "org-a", Connection: "conn-a", Environment: "staging", Generation: 2}
	secret := []byte(`{"cookies":[{"name":"session","value":"dummy-secret"}]}`)
	sealed, err := keys.Seal(secret, binding)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(sealed, "dummy-secret") {
		t.Fatal("the envelope contains the secret")
	}
	if again, _ := keys.Seal(secret, binding); again == sealed {
		t.Fatal("the nonce repeated")
	}
	opened, stale, err := keys.Open(sealed, binding)
	if err != nil || stale || !bytes.Equal(opened, secret) {
		t.Fatalf("open=%q stale=%v err=%v", opened, stale, err)
	}
	wrong := func(change func(*Binding)) Binding { b := binding; change(&b); return b }
	tampered := sealed[:len(sealed)-2] + map[bool]string{true: "AA", false: "BB"}[!strings.HasSuffix(sealed, "AA")]
	for name, attempt := range map[string]struct {
		value   string
		binding Binding
	}{
		"plaintext":          {string(secret), binding},
		"unprefixed":         {strings.TrimPrefix(sealed, prefix), binding},
		"unknown version":    {"scs2." + strings.TrimPrefix(sealed, prefix), binding},
		"altered ciphertext": {tampered, binding},
		"empty":              {"", binding},
		"wrong tenant":       {sealed, wrong(func(b *Binding) { b.Organization = "org-b" })},
		"wrong connection":   {sealed, wrong(func(b *Binding) { b.Connection = "conn-b" })},
		"wrong environment":  {sealed, wrong(func(b *Binding) { b.Environment = "production" })},
		"stale grant":        {sealed, wrong(func(b *Binding) { b.Generation = 1 })},
		"unbound":            {sealed, Binding{}},
		"unknown key id":     {prefix + strings.Repeat("0", 24) + "." + strings.SplitN(sealed, ".", 3)[2], binding},
		"truncated":          {prefix + strings.SplitN(sealed, ".", 3)[1] + ".AA", binding},
	} {
		if _, _, err := keys.Open(attempt.value, attempt.binding); !errors.Is(err, ErrRefused) {
			t.Errorf("%s: err=%v", name, err)
		}
	}
	// The other key cannot read it until it is configured, and then asks for re-encryption.
	otherOnly, _ := NewKeys(other)
	if _, _, err := otherOnly.Open(sealed, binding); !errors.Is(err, ErrRefused) {
		t.Fatalf("missing key: %v", err)
	}
	rotated, _ := NewKeys(other, key)
	if opened, stale, err := rotated.Open(sealed, binding); err != nil || !stale || !bytes.Equal(opened, secret) {
		t.Fatalf("rotated open=%q stale=%v err=%v", opened, stale, err)
	}
	if _, err := NewKeys(); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("no key: %v", err)
	}
	if _, err := NewKeys([]byte("short")); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("short key: %v", err)
	}
}

func TestFromEnvironment(t *testing.T) {
	t.Setenv("PLATFORM_CAPTURE_STATE_KEY", "")
	if keys, err := FromEnvironment(); keys != nil || err != nil {
		t.Fatalf("no key must leave capture off: %v %v", keys, err)
	}
	t.Setenv("PLATFORM_CAPTURE_STATE_KEY", "not base64!")
	if _, err := FromEnvironment(); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("bad key: %v", err)
	}
	t.Setenv("PLATFORM_CAPTURE_STATE_KEY", base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{3}, 32)))
	if keys, err := FromEnvironment(); keys == nil || err != nil {
		t.Fatalf("key: %v %v", keys, err)
	}
}
