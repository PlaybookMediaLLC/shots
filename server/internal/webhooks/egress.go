package webhooks

import (
	"context"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publicnet"
)

// ErrUnsafeEndpoint refuses an endpoint the platform will not call.
type ErrUnsafeEndpoint struct{ Reason string }

func (e *ErrUnsafeEndpoint) Error() string { return e.Reason }

// PublicAddress reports whether an address is one a customer endpoint may
// resolve to: global unicast, and not private, loopback, link-local (which
// includes cloud metadata at 169.254.169.254), shared or reserved.
func PublicAddress(address netip.Addr) bool {
	return publicnet.IsPublic(address)
}

// Resolver looks up a host's addresses; tests replace it.
type Resolver interface {
	LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error)
}

// ValidateEndpoint checks a destination when it is saved: HTTPS, no
// credentials, no fragment, a host name rather than an address, and every
// address it resolves to public. Delivery checks the dialed address again,
// because DNS can change between now and then.
func ValidateEndpoint(ctx context.Context, resolver Resolver, raw string) (string, error) {
	if len(raw) > 2048 {
		return "", &ErrUnsafeEndpoint{"Keep the URL under 2,048 characters."}
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return "", &ErrUnsafeEndpoint{"Enter a full URL, such as https://example.com/hooks."}
	}
	if u.Scheme != "https" {
		return "", &ErrUnsafeEndpoint{"Webhook URLs must use https."}
	}
	if u.User != nil {
		return "", &ErrUnsafeEndpoint{"Remove the user name or password from the URL; use the signing secret instead."}
	}
	if u.Fragment != "" {
		return "", &ErrUnsafeEndpoint{"Remove the #fragment from the URL."}
	}
	host := u.Hostname()
	if _, err := netip.ParseAddr(host); err == nil {
		return "", &ErrUnsafeEndpoint{"Use a host name, not an IP address."}
	}
	lower := strings.ToLower(strings.TrimSuffix(host, "."))
	if lower == "localhost" || strings.HasSuffix(lower, ".localhost") || strings.HasSuffix(lower, ".internal") ||
		strings.HasSuffix(lower, ".local") || !strings.Contains(lower, ".") {
		return "", &ErrUnsafeEndpoint{"Use a public host name."}
	}
	lookupCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	addresses, err := resolver.LookupNetIP(lookupCtx, "ip", lower)
	if err != nil || len(addresses) == 0 {
		return "", &ErrUnsafeEndpoint{"The host name does not resolve."}
	}
	for _, address := range addresses {
		if !PublicAddress(address) {
			return "", &ErrUnsafeEndpoint{"The host resolves to a private or reserved address."}
		}
	}
	u.Host = lower + portSuffix(u)
	return u.String(), nil
}

func portSuffix(u *url.URL) string {
	if port := u.Port(); port != "" {
		return ":" + port
	}
	return ""
}

// errBlockedDestination marks a dial refused because the address is not public.
var errBlockedDestination = publicnet.ErrBlocked

// NewHTTPClient is the delivery client: it dials only public addresses
// (checked on the address actually dialed, so DNS rebinding cannot reach a
// private one), uses no environment proxy, never follows a redirect, and
// gives up after ten seconds.
func NewHTTPClient() *http.Client {
	return &http.Client{Transport: publicnet.Transport(), Timeout: 10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}
