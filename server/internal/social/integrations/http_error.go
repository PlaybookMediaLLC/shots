package integrations

import (
	"fmt"
	"net/http"
	"strconv"
	"time"
)

// HTTPError preserves response status and retry guidance without retaining tokens or response bodies.
type HTTPError struct {
	Status int
	Retry  time.Time
}

func (e *HTTPError) Error() string      { return fmt.Sprintf("provider returned HTTP %d", e.Status) }
func (e *HTTPError) HTTPStatus() int    { return e.Status }
func (e *HTTPError) RetryAt() time.Time { return e.Retry }

// CheckResponse distinguishes an unavailable metric from a failed provider request.
func CheckResponse(response *http.Response) error {
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return nil
	}
	return &HTTPError{Status: response.StatusCode, Retry: RetryAt(response.Header, time.Now())}
}

// RetryAt reads a provider's retry guidance: Retry-After in seconds or as a
// date, else X's x-rate-limit-reset epoch. Zero when the provider gave none.
func RetryAt(header http.Header, now time.Time) time.Time {
	if seconds, err := strconv.Atoi(header.Get("Retry-After")); err == nil && seconds >= 0 {
		return now.Add(time.Duration(min(seconds, 86400)) * time.Second)
	}
	if date, err := http.ParseTime(header.Get("Retry-After")); err == nil {
		return date
	}
	if epoch, err := strconv.ParseInt(header.Get("x-rate-limit-reset"), 10, 64); err == nil && epoch > 0 {
		return time.Unix(epoch, 0)
	}
	return time.Time{}
}
