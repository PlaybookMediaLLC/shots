package maintenance

import (
	"context"
	"os"
)

// Notifications runs notification fanout and delivery by default, unless legacy
// senders are explicitly enabled.
func (s *Store) Notifications(ctx context.Context) (int, error) {
	if os.Getenv("PLATFORM_ACTIVITY_LEGACY_PAUSED") == "false" || s.Activity == nil {
		return 0, nil
	}
	return 0, s.Activity.Process(ctx)
}

// NotificationsMaintain cleans up expired OAuth starts, orphaned delivery rows,
// and performs hourly Slack installation health checks.
func (s *Store) NotificationsMaintain(ctx context.Context) (int, error) {
	if os.Getenv("PLATFORM_ACTIVITY_LEGACY_PAUSED") == "false" || s.Activity == nil {
		return 0, nil
	}
	return 0, s.Activity.Maintain(ctx)
}
