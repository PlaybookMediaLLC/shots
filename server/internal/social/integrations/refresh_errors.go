package integrations

import "errors"

// ErrRefreshUnavailable indicates a temporary failure, not a revoked grant.
// Refresh callers must preserve credentials and health and retry later. The
// fixed message deliberately excludes provider responses and credentials.
var ErrRefreshUnavailable = errors.New("the provider is temporarily unavailable; retry credential renewal later")

// ErrAppCredentialsRefused means the provider refused Shots' own app
// credentials or app access, not an account's token: every account fails the
// same way, and none is the account's to reconnect.
var ErrAppCredentialsRefused = errors.New("the provider refused the app credentials")
