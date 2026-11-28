package notifications

import "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/activity"

// UserEmailPreferences holds the person's cross-workspace email toggles read
// from user_preference. Zero values are NOT defaults; use defaultUserEmailPrefs.
type UserEmailPreferences struct {
	EmailNotifications bool
	PostFailureAlerts  bool
	PostSummaryEmails  bool
}

func defaultUserEmailPrefs() UserEmailPreferences {
	return UserEmailPreferences{
		EmailNotifications: true,
		PostFailureAlerts:  true,
		PostSummaryEmails:  false,
	}
}

// personalDecision is evaluated only after recipient/resource authorization. Required
// publishing failures bypass category choices, never workspace ceilings or masters.
func personalDecision(p Policy, pref Preferences, d activity.Definition, channel string, emailOn bool, setIDs ...string) (bool, string) {
	return personalDecisionWithEmailPrefs(p, pref, d, channel, UserEmailPreferences{
		EmailNotifications: emailOn,
		PostFailureAlerts:  true,
		PostSummaryEmails:  false,
	}, setIDs...)
}

func personalDecisionWithEmailPrefs(p Policy, pref Preferences, d activity.Definition, channel string, emailPrefs UserEmailPreferences, setIDs ...string) (bool, string) {
	if !availableChannel(p, channel) {
		return false, "WORKSPACE_CHANNEL_DISABLED"
	}
	policy := p.Events[d.ID]
	if channel == "in_app" && !policy.InApp || channel == "email" && !policy.Email {
		return false, "WORKSPACE_EVENT_DISABLED"
	}
	if channel == "email" && !emailPrefs.EmailNotifications {
		return false, "EMAIL_TURNED_OFF"
	}
	if channel == "email" && d.MandatoryFailure && !emailPrefs.PostFailureAlerts {
		return false, "POST_FAILURE_ALERTS_OFF"
	}
	if channel == "email" && d.ID == "post.publish_summary" && !emailPrefs.PostSummaryEmails {
		return false, "POST_SUMMARY_EMAILS_OFF"
	}
	if channel == "slack_dm" && pref.SlackEnabled != nil && !*pref.SlackEnabled {
		return false, "SLACK_TURNED_OFF"
	}
	if d.MandatoryFailure {
		return true, "REQUIRED_FAILURE_ALERT"
	}
	if !pref.selected(d.ID, channel, setIDs...) {
		return false, "CATEGORY_DISABLED"
	}
	return true, "SELECTED"
}

func notifyActor(d activity.Definition, background bool) bool {
	return background || d.MandatoryFailure
}
