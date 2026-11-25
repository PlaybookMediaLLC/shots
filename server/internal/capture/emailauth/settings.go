package emailauth

import (
	"errors"
	"os"
	"strconv"
	"strings"
	"time"
)

// Defaults from RFC 007A section 3.3.
const (
	DefaultAttemptTTL    = 3 * time.Minute
	MaxAttemptTTL        = 4 * time.Minute
	DefaultDailyAttempts = 3
	DefaultMaxActive     = 5
	// MaxActivePerOrganization is one automatic sign-in per workspace in v1.
	MaxActivePerOrganization = 1
)

// Settings turn unattended email sign-in on. Nil means off: every connection
// keeps the person-driven Live View sign-in only.
type Settings struct {
	// AutoReconnect allows attempts no person started, from a parked job.
	// Each connection still needs its owner's opt-in.
	AutoReconnect bool
	// Domain is the verified Resend receiving domain test addresses live on.
	Domain string
	// WebhookSecret verifies Resend's email.received deliveries.
	WebhookSecret string
	// Reader fetches a received email's content.
	Reader Reader
	// AttemptTTL bounds the wait for one sign-in email.
	AttemptTTL time.Duration
	// DailyAttempts caps attempts per connection per day, tests included.
	DailyAttempts int
	// MaxActive caps attempts running at once across all workspaces.
	MaxActive int
}

// SettingsFromEnvironment reads PLATFORM_CAPTURE_EMAIL_AUTH_* and the
// dedicated Resend receiving settings. It refuses a half-configured feature
// rather than letting an enabled flag run without its provider.
func SettingsFromEnvironment() (*Settings, error) {
	if !envTrue("PLATFORM_CAPTURE_EMAIL_AUTH_ENABLED") {
		return nil, nil
	}
	settings := &Settings{
		AutoReconnect: envTrue("PLATFORM_CAPTURE_EMAIL_AUTH_AUTO_RECONNECT"),
		Domain:        strings.ToLower(strings.TrimSpace(os.Getenv("PLATFORM_CAPTURE_RESEND_DOMAIN"))),
		WebhookSecret: strings.TrimSpace(os.Getenv("PLATFORM_CAPTURE_RESEND_WEBHOOK_SECRET")),
		AttemptTTL:    DefaultAttemptTTL,
		DailyAttempts: DefaultDailyAttempts,
		MaxActive:     DefaultMaxActive,
	}
	key := strings.TrimSpace(os.Getenv("PLATFORM_CAPTURE_RESEND_API_KEY"))
	if settings.Domain == "" || settings.WebhookSecret == "" || key == "" {
		return nil, errors.New("PLATFORM_CAPTURE_EMAIL_AUTH_ENABLED needs PLATFORM_CAPTURE_RESEND_DOMAIN, PLATFORM_CAPTURE_RESEND_WEBHOOK_SECRET and PLATFORM_CAPTURE_RESEND_API_KEY")
	}
	if _, ok := Canonical("x@" + settings.Domain); !ok || strings.ContainsAny(settings.Domain, "@* ") {
		return nil, errors.New("PLATFORM_CAPTURE_RESEND_DOMAIN must be a host name")
	}
	if raw := os.Getenv("PLATFORM_CAPTURE_AUTH_ATTEMPT_TTL"); raw != "" {
		ttl, err := time.ParseDuration(raw)
		if err != nil || ttl < 30*time.Second || ttl > MaxAttemptTTL {
			return nil, errors.New("PLATFORM_CAPTURE_AUTH_ATTEMPT_TTL must be between 30s and 4m")
		}
		settings.AttemptTTL = ttl
	}
	for name, target := range map[string]*int{"PLATFORM_CAPTURE_AUTH_RATE_PER_CONNECTION": &settings.DailyAttempts, "PLATFORM_CAPTURE_AUTH_MAX_ACTIVE_GLOBAL": &settings.MaxActive} {
		if raw := os.Getenv(name); raw != "" {
			n, err := strconv.Atoi(raw)
			if err != nil || n < 1 || n > 100 {
				return nil, errors.New(name + " must be a whole number from 1 to 100")
			}
			*target = n
		}
	}
	settings.Reader = &Resend{APIKey: key, BaseURL: os.Getenv("PLATFORM_CAPTURE_RESEND_API_URL")}
	return settings, nil
}

func envTrue(name string) bool {
	value, _ := strconv.ParseBool(strings.TrimSpace(os.Getenv(name)))
	return value
}
