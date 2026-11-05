package browser

import (
	"context"
	"time"

	"github.com/go-rod/rod"
)

// Runner attaches to a provider session for one operation at a time. Dropping
// the connection leaves the session open; only Close ends it.
type Runner struct{ Provider Provider }

func (r Runner) attached(ctx context.Context, sessionID string, use func(context.Context, *rod.Browser) error) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	browser, err := r.Provider.Connect(ctx, sessionID)
	if err != nil {
		return err
	}
	return use(ctx, browser)
}

// Allocate starts a browser limited to these hosts.
func (r Runner) Allocate(ctx context.Context, hosts []string, keepAlive time.Duration) (string, error) {
	return r.Provider.Allocate(ctx, hosts, keepAlive)
}

// LiveView returns the bearer link a person signs in through.
func (r Runner) LiveView(ctx context.Context, sessionID string, connectWithin time.Duration) (string, error) {
	return r.Provider.LiveView(ctx, sessionID, connectWithin)
}

// Close ends a session and any viewer attached to it.
func (r Runner) Close(ctx context.Context, sessionID string) error {
	return r.Provider.Close(ctx, sessionID)
}

// OpenLogin points the session at the app for the person to sign in.
func (r Runner) OpenLogin(ctx context.Context, sessionID string, target Target) error {
	return r.attached(ctx, sessionID, func(ctx context.Context, browser *rod.Browser) error { return OpenLogin(ctx, browser, target) })
}

// Export reads the state the person's sign-in left in the session.
func (r Runner) Export(ctx context.Context, sessionID string, target Target) (*State, error) {
	var state *State
	err := r.attached(ctx, sessionID, func(ctx context.Context, browser *rod.Browser) error {
		var err error
		state, err = ExportConnected(ctx, browser, target)
		return err
	})
	return state, err
}

// Verify proves state reaches the protected page as the expected account.
func (r Runner) Verify(ctx context.Context, sessionID string, target Target, state *State) error {
	return r.attached(ctx, sessionID, func(ctx context.Context, browser *rod.Browser) error { return Verify(ctx, browser, target, state) })
}

// Run executes a recipe in the session.
func (r Runner) Run(ctx context.Context, sessionID string, input RunInput) (*RunResult, error) {
	var result *RunResult
	err := r.attached(ctx, sessionID, func(ctx context.Context, browser *rod.Browser) error {
		var err error
		result, err = Run(ctx, browser, input)
		return err
	})
	return result, err
}
