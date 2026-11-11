// Package temporalx holds the Temporal pieces the backend and
// orchestrator share: connection,
// search attributes, task queues, heartbeat details, and the provider failure
// types the post workflows branch on.
package temporalx

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/temporalpublishing"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/temporal"
)

// MainQueue runs every workflow; provider queues only run activities.
const MainQueue = "main"

// Email task queues are rate limited server side to stay under Resend's limit.
var EmailQueues = struct {
	Priority, Bulk EmailQueue
}{
	Priority: EmailQueue{TaskQueue: "email", PerSecond: 3},
	Bulk:     EmailQueue{TaskQueue: "email-bulk", PerSecond: 2},
}

type EmailQueue struct {
	TaskQueue string
	PerSecond float64
}

var (
	OrganizationID = temporal.NewSearchAttributeKeyString("organizationId")
	PostID         = temporal.NewSearchAttributeKeyString("postId")
)

func Namespace() string {
	if ns := os.Getenv("TEMPORAL_NAMESPACE"); ns != "" {
		return ns
	}
	return "default"
}

// Dial connects with TEMPORAL_ADDRESS, TEMPORAL_TLS, TEMPORAL_API_KEY and
// TEMPORAL_NAMESPACE, like getTemporalModule.
func Dial(ctx context.Context) (client.Client, error) {
	address := os.Getenv("TEMPORAL_ADDRESS")
	if address == "" {
		address = "localhost:7233"
	}
	return temporalpublishing.Dial(ctx, temporalpublishing.ConnectionConfig{
		APIKey: os.Getenv("TEMPORAL_API_KEY"), Address: address, Namespace: Namespace(),
		TLS: os.Getenv("TEMPORAL_TLS") == "true",
	})
}

// RegisterSearchAttributes adds organizationId and postId when missing
// (TemporalRegister); skipped on TLS (Temporal Cloud) connections.
func RegisterSearchAttributes(ctx context.Context, c client.Client) error {
	if os.Getenv("TEMPORAL_TLS") == "true" {
		return nil
	}
	return temporalpublishing.RegisterSearchAttributes(ctx, c, Namespace())
}

// Failure types thrown by providers. They are
// non-retryable: the post workflow decides what to do with each.
const (
	TypeRefreshToken        = "refresh_token"
	TypeBadBody             = "bad_body"
	TypePublicationRejected = "publication_rejected"
	TypeDisconnect          = "disconnect"
	TypeUnknownDelivery     = temporalpublishing.FailureUnknownDelivery
	// TypeRateLimited is a refusal the provider asked to retry later; nothing was created.
	TypeRateLimited = "rate_limited"
	// TypeDailyLimit is a posting cap that will not clear today; nothing was created.
	TypeDailyLimit = "daily_limit"
)

// Temporal ships failures through gRPC with a 4MB frame limit, so every
// provider string is capped.
const (
	maxFailureMessage = 2000
	maxFailureField   = 4000
)

// Truncate caps a value for a Temporal failure (truncateForTemporal).
func Truncate(value any, limit int) string {
	var s string
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		s = v
	case []byte:
		s = string(v)
	default:
		data, err := json.Marshal(v)
		if err != nil {
			s = fmt.Sprint(v)
		} else {
			s = string(data)
		}
	}
	if len([]rune(s)) <= limit {
		return s
	}
	r := []rune(s)
	return fmt.Sprintf("%s… [truncated %d chars]", string(r[:limit]), len(r)-limit)
}

// FailureDetails is the details payload of a provider failure.
type FailureDetails struct {
	Identifier string `json:"identifier"`
	JSON       string `json:"json"`
	Body       string `json:"body"`
	// RetryAfter is the provider's retry guidance on a rate limit; zero when none.
	RetryAfter time.Duration `json:"retryAfter,omitempty"`
}

func failure(kind, identifier string, jsonBody, body any, message string) error {
	return temporal.NewNonRetryableApplicationError(Truncate(message, maxFailureMessage), kind, nil, FailureDetails{
		Identifier: identifier, JSON: Truncate(jsonBody, maxFailureField), Body: Truncate(body, maxFailureField),
	})
}

// RefreshToken asks the workflow to refresh the channel token and retry.
func RefreshToken(identifier string, jsonBody, body any, message string) error {
	return failure(TypeRefreshToken, identifier, jsonBody, body, message)
}

// BadBody reports a request the platform rejected; message is shown to users.
func BadBody(identifier string, jsonBody, body any, message string) error {
	return failure(TypeBadBody, identifier, jsonBody, body, message)
}

// PublicationRejected means validation or a definite rejection proves no post was created.
// Legacy BadBody is not sufficient evidence: some adapters use it for ambiguity.
func PublicationRejected(identifier, message string) error {
	return failure(TypePublicationRejected, identifier, "{}", "{}", message)
}

// UnknownDelivery stops retries when a mutation may have committed remotely.
// It carries only a safe explanation; reconcile the account before resending.
func UnknownDelivery(identifier, message string) error {
	return failure(TypeUnknownDelivery, identifier, "{}", "{}", message)
}

// RateLimited reports a provider that kept refusing with a rate limit after the
// client's short retries. The post was not created, so a durable retry is safe.
func RateLimited(identifier string, retryAfter time.Duration, message string) error {
	return temporal.NewNonRetryableApplicationError(Truncate(message, maxFailureMessage), TypeRateLimited, nil, FailureDetails{
		Identifier: identifier, JSON: "{}", Body: "{}", RetryAfter: max(retryAfter, 0),
	})
}

// DailyLimit reports a posting cap that clears only tomorrow; message is shown to users.
func DailyLimit(identifier, message string) error {
	return failure(TypeDailyLimit, identifier, "{}", "{}", message)
}

// RetryAfter is a rate-limit failure's retry guidance, or zero.
func RetryAfter(err error) time.Duration {
	var app *temporal.ApplicationError
	var details FailureDetails
	if errors.As(err, &app) && app.Type() == TypeRateLimited && app.Details(&details) == nil {
		return details.RetryAfter
	}
	return 0
}

// Disconnect means the channel must be reconnected by the user.
func Disconnect(identifier string, jsonBody, body any, message string) error {
	return failure(TypeDisconnect, identifier, jsonBody, body, message)
}

// FailureType returns the application failure type anywhere in err's chain
// ("" when there is none). It sees through ActivityError wrapping.
func FailureType(err error) string {
	var app *temporal.ApplicationError
	if errors.As(err, &app) {
		return app.Type()
	}
	return ""
}

// FailureMessage returns the application failure message, or err.Error().
func FailureMessage(err error) string {
	var app *temporal.ApplicationError
	if errors.As(err, &app) {
		return app.Message()
	}
	if err == nil {
		return ""
	}
	return err.Error()
}

// heartbeat details live per activity invocation, keyed by its context.
type detailsKey struct{}

type details struct {
	mu    sync.Mutex
	value string
}

// SetHeartbeatDetails records what the activity is about to wait on, so a
// start-to-close timeout failure names the stalled call. Outside a
// WithHeartbeat activity it does nothing.
func SetHeartbeatDetails(ctx context.Context, value string) {
	if d, ok := ctx.Value(detailsKey{}).(*details); ok {
		d.mu.Lock()
		d.value = value
		d.mu.Unlock()
	}
}

// HeartbeatInterval matches withHeartbeat's 15s keepalive.
const HeartbeatInterval = 15 * time.Second

// WithHeartbeat runs fn inside an activity, heartbeating the last recorded
// details every 15 seconds. The first details are "<activityType>: entered" so
// a timeout with no details at all proves the activity never ran.
func WithHeartbeat[T any](ctx context.Context, fn func(context.Context) (T, error)) (T, error) {
	if !activity.IsActivity(ctx) {
		return fn(ctx)
	}
	d := &details{value: activity.GetInfo(ctx).ActivityType.Name + ": entered"}
	ctx = context.WithValue(ctx, detailsKey{}, d)
	stop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(HeartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				d.mu.Lock()
				value := d.value
				d.mu.Unlock()
				activity.RecordHeartbeat(ctx, value)
			}
		}
	}()
	defer close(stop)
	return fn(ctx)
}

// StripQuery drops a URL's query string before it is recorded (some
// providers put access tokens there).
func StripQuery(raw string) string {
	if i := strings.IndexAny(raw, "?#"); i >= 0 {
		return raw[:i]
	}
	return raw
}
