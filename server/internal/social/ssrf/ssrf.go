// Package ssrf is the SSRF guard for webhooks and other user-supplied
// URLs. Every outbound request whose URL a user can
// influence goes through Client, which checks the address actually dialed,
// so DNS rebinding cannot slip past a check done earlier.
package ssrf

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"syscall"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publicnet"
)

// ErrBlocked is returned when a request would reach a private address.
var ErrBlocked = errors.New("Blocked IP")

// IsBlockedIP reports loopback, private, link-local, CGNAT, benchmark,
// multicast, reserved and unparseable addresses.
func IsBlockedIP(ip string) bool {
	addr, err := netip.ParseAddr(strings.Trim(ip, "[]"))
	if err != nil {
		return true
	}
	return !publicnet.IsPublic(addr)
}

// IsSafePublicHTTPSURL is the IsSafeWebhookUrl validator.
func IsSafePublicHTTPSURL(ctx context.Context, value string) bool {
	if strings.TrimSpace(value) == "" {
		return false
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	if host == "localhost" {
		return false
	}
	if _, err := netip.ParseAddr(host); err == nil {
		return !IsBlockedIP(host)
	}
	addrs, err := net.DefaultResolver.LookupHost(ctx, host)
	if err != nil || len(addrs) == 0 {
		return false
	}
	for _, addr := range addrs {
		if IsBlockedIP(addr) {
			return false
		}
	}
	return true
}

// Disabled reports DISABLE_SSRF_PROTECTION=true (self-hosters reaching
// services on a private network).
func Disabled() bool { return os.Getenv("DISABLE_SSRF_PROTECTION") == "true" }

// DefaultTimeout bounds ordinary outbound API and webhook requests.
const DefaultTimeout = 30 * time.Second

var guardedTransport = newGuardedTransport()

var guarded = &http.Client{
	Transport: guardedTransport,
	Timeout:   DefaultTimeout,
}

var unguarded = &http.Client{
	Timeout: DefaultTimeout,
}

var guardedStreaming = &http.Client{
	Transport: guardedTransport,
}

var unguardedStreaming = &http.Client{}

var publicOnly = &http.Client{
	Transport: guardedTransport,
	Timeout:   10 * time.Second,
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return errors.New("instance redirects are not allowed")
	},
}

// PublicClient keeps public instance discovery and credentials off private
// networks even when a self-hosted deployment disables the general guard.
// Redirects are refused so credentials cannot leave the chosen instance.
func PublicClient() *http.Client { return publicOnly }

func newGuardedTransport() *http.Transport {
	dialer := &net.Dialer{
		Timeout:   30 * time.Second,
		KeepAlive: 30 * time.Second,
		Control: func(_, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return err
			}
			if IsBlockedIP(host) {
				return ErrBlocked
			}
			return nil
		},
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = dialer.DialContext
	transport.ResponseHeaderTimeout = 30 * time.Second
	transport.MaxIdleConnsPerHost = 16
	transport.Proxy = nil
	return transport
}

// Client returns the SSRF-safe client (or a bounded unguarded client when
// protection is disabled), with a 30-second total timeout.
func Client() *http.Client {
	if Disabled() {
		return unguarded
	}
	return guarded
}

// StreamingClient returns the SSRF-safe client (or unguarded when disabled)
// with bounded dial and response-header timeouts but no overall body-transfer
// deadline, for large media uploads and downloads bounded by ctx.
func StreamingClient() *http.Client {
	if Disabled() {
		return unguardedStreaming
	}
	return guardedStreaming
}
