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

func TestDrainLoop(t *testing.T) {
	t.Run("exits immediately when idle", func(t *testing.T) {
		passes := 0
		start := time.Now()
		n, err := drainLoop(context.Background(), 5*time.Second,
			func(context.Context) (int, error) { passes++; return 0, nil },
			func(context.Context) (int, int, error) { return 0, 0, nil },
		)
		if err != nil || n != 0 || passes != 1 {
			t.Fatalf("got n=%d passes=%d err=%v, want 0, 1, nil", n, passes, err)
		}
		if elapsed := time.Since(start); elapsed > time.Second {
			t.Fatalf("idle drain slept for %v", elapsed)
		}
	})

	t.Run("drains multiple batches including failed deliveries followed by healthy ones", func(t *testing.T) {
		fanoutCounts := []int{2, 0, 0, 0}
		attemptedCounts := []int{2, 50, 3, 0}
		sentCounts := []int{2, 0, 3, 0}
		pass := 0
		n, err := drainLoop(context.Background(), 5*time.Second,
			func(context.Context) (int, error) { return fanoutCounts[pass], nil },
			func(context.Context) (int, int, error) {
				a, s := attemptedCounts[pass], sentCounts[pass]
				pass++
				return a, s, nil
			},
		)
		if err != nil || n != 7 || pass != 4 {
			t.Fatalf("got n=%d pass=%d err=%v, want 7, 4, nil", n, pass, err)
		}
	})

	t.Run("stops at maxDuration without error", func(t *testing.T) {
		passes := 0
		n, err := drainLoop(context.Background(), 0,
			func(context.Context) (int, error) { passes++; return 1, nil },
			func(context.Context) (int, int, error) { return 1, 1, nil },
		)
		if err != nil || n != 2 || passes != 1 {
			t.Fatalf("got n=%d passes=%d err=%v, want 2, 1, nil", n, passes, err)
		}
	})

	t.Run("propagates context cancellation", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		n, err := drainLoop(ctx, 5*time.Second,
			func(context.Context) (int, error) { return 1, nil },
			func(context.Context) (int, int, error) { cancel(); return 1, 1, nil },
		)
		if !errors.Is(err, context.Canceled) || n != 2 {
			t.Fatalf("got n=%d err=%v, want 2, context.Canceled", n, err)
		}
	})

	t.Run("aborts on fanout error without calling deliver", func(t *testing.T) {
		boom := errors.New("fanout failed")
		deliverCalled := false
		n, err := drainLoop(context.Background(), 5*time.Second,
			func(context.Context) (int, error) { return 0, boom },
			func(context.Context) (int, int, error) { deliverCalled = true; return 0, 0, nil },
		)
		if !errors.Is(err, boom) || n != 0 || deliverCalled {
			t.Fatalf("got n=%d deliverCalled=%v err=%v", n, deliverCalled, err)
		}
	})

	t.Run("aborts on deliver error", func(t *testing.T) {
		boom := errors.New("deliver failed")
		n, err := drainLoop(context.Background(), 5*time.Second,
			func(context.Context) (int, error) { return 1, nil },
			func(context.Context) (int, int, error) { return 1, 0, boom },
		)
		if !errors.Is(err, boom) || n != 0 {
			t.Fatalf("got n=%d err=%v, want 0, boom", n, err)
		}
	})
}
