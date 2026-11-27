package webhooks

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"testing"
	"time"
)

type fakeResolver map[string][]string

func (f fakeResolver) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	values, ok := f[host]
	if !ok {
		return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
	}
	addresses := []netip.Addr{}
	for _, value := range values {
		addresses = append(addresses, netip.MustParseAddr(value))
	}
	return addresses, nil
}

// RFC 024: an endpoint must be HTTPS, carry no credentials and resolve only to
// public addresses.
func TestValidateEndpointRefusesUnsafeDestinations(t *testing.T) {
	resolver := fakeResolver{
		"hooks.example.com":    {"93.184.216.34"},
		"private.example.com":  {"10.0.0.8"},
		"metadata.example.com": {"169.254.169.254"},
		"mixed.example.com":    {"93.184.216.34", "127.0.0.1"},
		"shared.example.com":   {"100.64.1.2"},
		"v6.example.com":       {"::1"},
		"mapped.example.com":   {"::ffff:192.168.1.1"},
	}
	ok, err := ValidateEndpoint(context.Background(), resolver, "https://Hooks.Example.com/shots?x=1")
	if err != nil || ok != "https://hooks.example.com/shots?x=1" {
		t.Fatalf("a public endpoint was refused: %q %v", ok, err)
	}
	for _, raw := range []string{
		"http://hooks.example.com/",
		"https://user:secret@hooks.example.com/",
		"https://hooks.example.com/#frag",
		"https://93.184.216.34/",
		"https://[::1]/",
		"https://localhost/",
		"https://intranet/",
		"https://service.internal/",
		"https://private.example.com/",
		"https://metadata.example.com/",
		"https://mixed.example.com/",
		"https://shared.example.com/",
		"https://v6.example.com/",
		"https://mapped.example.com/",
		"https://missing.example.com/",
		"ftp://hooks.example.com/",
	} {
		if _, err := ValidateEndpoint(context.Background(), resolver, raw); err == nil {
			t.Errorf("%s was accepted", raw)
		}
	}
}

// The delivery client refuses to dial a private address even when DNS says so
// only at delivery time.
func TestHTTPClientRefusesPrivateDial(t *testing.T) {
	client := NewHTTPClient()
	_, err := client.Get("https://127.0.0.1:1/")
	if err == nil || classify(err) != ErrorBlockedDestination || !errors.Is(err, errBlockedDestination) {
		t.Fatalf("loopback dial: %v (%s)", err, classify(err))
	}
	if client.CheckRedirect(&http.Request{}, nil) != http.ErrUseLastResponse {
		t.Fatal("redirects are followed")
	}
}

func TestSignatureAndSealing(t *testing.T) {
	key := make([]byte, 32)
	secret, err := NewSecret()
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := Seal(key, secret)
	if err != nil {
		t.Fatal(err)
	}
	opened, err := Open(key, sealed)
	if err != nil || opened != secret {
		t.Fatalf("round trip: %v", err)
	}
	if _, err := Open(make([]byte, 31), sealed); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("a short key opened a secret: %v", err)
	}
	body := []byte(`{"id":"evt_1"}`)
	header := Sign("other", "evt_1", "2026-10-20T10:00:00Z", body) + "," + Sign(secret, "evt_1", "2026-10-20T10:00:00Z", body)
	if !Verify(secret, "evt_1", "2026-10-20T10:00:00Z", body, header) {
		t.Fatal("a rotated header did not verify with the new secret")
	}
	if Verify(secret, "evt_2", "2026-10-20T10:00:00Z", body, header) || Verify(secret, "evt_1", "2026-10-20T10:00:01Z", body, header) {
		t.Fatal("the signature does not bind the event ID and timestamp")
	}
	if Verify(secret, "evt_1", "2026-10-20T10:00:00Z", []byte(`{"id":"evt_x"}`), header) {
		t.Fatal("the signature does not bind the body")
	}
}

func TestJitteredDurationBounds(t *testing.T) {
	if jitteredDuration(0) != 0 || jitteredDuration(-time.Second) != -time.Second {
		t.Fatal("non-positive durations must pass through unchanged")
	}
	if jitteredDuration(3*time.Nanosecond) != 3*time.Nanosecond {
		t.Fatal("sub-4ns duration must pass through unchanged")
	}
	base := 2 * time.Minute
	minWant, maxWant := 90*time.Second, 150*time.Second
	seen := map[time.Duration]bool{}
	for range 100 {
		got := jitteredDuration(base)
		if got < minWant || got > maxWant {
			t.Fatalf("jitteredDuration(%s) = %s, want [%s, %s]", base, got, minWant, maxWant)
		}
		seen[got] = true
	}
	if len(seen) < 2 {
		t.Fatalf("expected jittered spread, got only %d distinct value(s)", len(seen))
	}
}
