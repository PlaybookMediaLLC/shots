package maintenance

import (
	"context"
	"os"
	"time"
)

const notificationMaintainInterval = 10 * time.Minute

// Notifications runs by default, unless legacy senders are explicitly enabled.
func (s *Store) Notifications(ctx context.Context) (int, error) {
	if os.Getenv("PLATFORM_ACTIVITY_LEGACY_PAUSED") == "false" || s.Activity == nil {
		return 0, nil
	}
	if err := s.Activity.Process(ctx); err != nil {
		return 0, err
	}
	now := time.Now().UnixNano()
	last := s.lastNotificationMaintain.Load()
	if (last == 0 || time.Duration(now-last) >= notificationMaintainInterval) && s.lastNotificationMaintain.CompareAndSwap(last, now) {
		if err := s.Activity.Maintain(ctx); err != nil {
			// Restore previous timestamp so the next run retries Maintain promptly.
			s.lastNotificationMaintain.CompareAndSwap(now, last)
			return 0, err
		}
	}
	return 0, nil
}
