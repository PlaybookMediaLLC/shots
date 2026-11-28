package notifications

import (
	"strings"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/activity"
)

func TestPersonalDecisionEmailPreferenceGates(t *testing.T) {
	policy := Policy{
		Availability: &Channels{InApp: true, Email: true},
		Events: map[string]Channels{
			"post.publish_failed":            {InApp: true, Email: true},
			"post.publish_recovery_required": {InApp: true, Email: true},
			"post.publish_summary":           {InApp: true, Email: true},
		},
	}
	pref := defaultPreferences()

	failDef, ok := activity.Lookup("post.publish_failed")
	if !ok {
		t.Fatalf("missing post.publish_failed definition")
	}
	recoveryDef, ok := activity.Lookup("post.publish_recovery_required")
	if !ok {
		t.Fatalf("missing post.publish_recovery_required definition")
	}
	summaryDef, ok := activity.Lookup("post.publish_summary")
	if !ok {
		t.Fatalf("missing post.publish_summary definition")
	}

	// Post failure alerts off suppresses failure EMAIL for both mandatory failure kinds while preserving IN-APP.
	for _, def := range []activity.Definition{failDef, recoveryDef} {
		deliver, code := personalDecisionWithEmailPrefs(policy, pref, def, "email", UserEmailPreferences{
			EmailNotifications: true,
			PostFailureAlerts:  false,
			PostSummaryEmails:  false,
		})
		if deliver || code != "POST_FAILURE_ALERTS_OFF" {
			t.Fatalf("%s: expected failure email skipped with POST_FAILURE_ALERTS_OFF, got deliver=%v code=%q", def.ID, deliver, code)
		}
		deliver, code = personalDecisionWithEmailPrefs(policy, pref, def, "in_app", UserEmailPreferences{
			EmailNotifications: true,
			PostFailureAlerts:  false,
			PostSummaryEmails:  false,
		})
		if !deliver || code != "REQUIRED_FAILURE_ALERT" {
			t.Fatalf("%s: expected failure in_app still delivered as REQUIRED_FAILURE_ALERT, got deliver=%v code=%q", def.ID, deliver, code)
		}
	}

	// Post summary emails default off -> POST_SUMMARY_EMAILS_OFF; opt-in on -> SELECTED.
	deliver, code := personalDecisionWithEmailPrefs(policy, pref, summaryDef, "email", UserEmailPreferences{
		EmailNotifications: true,
		PostFailureAlerts:  true,
		PostSummaryEmails:  false,
	})
	if deliver || code != "POST_SUMMARY_EMAILS_OFF" {
		t.Fatalf("expected summary email skipped with POST_SUMMARY_EMAILS_OFF, got deliver=%v code=%q", deliver, code)
	}
	deliver, code = personalDecisionWithEmailPrefs(policy, pref, summaryDef, "email", UserEmailPreferences{
		EmailNotifications: true,
		PostFailureAlerts:  true,
		PostSummaryEmails:  true,
	})
	if !deliver || code != "SELECTED" {
		t.Fatalf("expected opted-in summary email delivered with SELECTED, got deliver=%v code=%q", deliver, code)
	}

	// Master email toggle off and workspace policy off still override PostSummaryEmails=true.
	deliver, code = personalDecisionWithEmailPrefs(policy, pref, summaryDef, "email", UserEmailPreferences{
		EmailNotifications: false,
		PostFailureAlerts:  true,
		PostSummaryEmails:  true,
	})
	if deliver || code != "EMAIL_TURNED_OFF" {
		t.Fatalf("expected EMAIL_TURNED_OFF precedence, got deliver=%v code=%q", deliver, code)
	}
	disabledPolicy := Policy{
		Availability: &Channels{InApp: true, Email: true},
		Events:       map[string]Channels{"post.publish_summary": {InApp: true, Email: false}},
	}
	deliver, code = personalDecisionWithEmailPrefs(disabledPolicy, pref, summaryDef, "email", UserEmailPreferences{
		EmailNotifications: true,
		PostFailureAlerts:  true,
		PostSummaryEmails:  true,
	})
	if deliver || code != "WORKSPACE_EVENT_DISABLED" {
		t.Fatalf("expected WORKSPACE_EVENT_DISABLED precedence, got deliver=%v code=%q", deliver, code)
	}

	// Per-workspace opt-out of post.publish_summary is respected even when personal PostSummaryEmails=true.
	optedOutPref := defaultPreferences()
	optedOutPref.Events["post.publish_summary"] = Channels{InApp: true, Email: false}
	deliver, code = personalDecisionWithEmailPrefs(policy, optedOutPref, summaryDef, "email", UserEmailPreferences{
		EmailNotifications: true,
		PostFailureAlerts:  true,
		PostSummaryEmails:  true,
	})
	if deliver || code != "CATEGORY_DISABLED" {
		t.Fatalf("expected per-workspace opt-out to yield CATEGORY_DISABLED, got deliver=%v code=%q", deliver, code)
	}

	// effectiveSettings reflects personal PostFailureAlerts and PostSummaryEmails gates.
	eff := effectiveSettings(policy, pref, true, UserEmailPreferences{
		EmailNotifications: true,
		PostFailureAlerts:  false,
		PostSummaryEmails:  false,
	}, nil)
	if eff["post.publish_failed"]["email"].Enabled {
		t.Fatalf("expected effectiveSettings to disable post.publish_failed email when PostFailureAlerts=false")
	}
	if eff["post.publish_summary"]["email"].Enabled {
		t.Fatalf("expected effectiveSettings to disable post.publish_summary email when PostSummaryEmails=false")
	}
}

func TestRenderPostSummaryHTMLAndText(t *testing.T) {
	env := &Envelope{
		Subject:   "Post publish summary",
		Workspace: "Acme",
		Href:      "https://app.shots.example/plan",
	}
	renderPostSummary(env, map[string]any{
		"publishedCount": 1,
		"sentToAppCount": 1,
		"failedCount":    1,
		"unknownCount":   1,
		"outcomes": []any{
			map[string]any{"platform": "x", "handle": "@shots", "status": "PUBLISHED", "remoteUrl": "https://x.com/shots/status/1"},
			map[string]any{"platform": "instagram", "handle": "@ig", "status": "SENT_TO_APP", "remoteUrl": "javascript:alert(1)"},
			map[string]any{"platform": "linkedin", "handle": "<script>alert(1)</script>", "status": "FAILED", "failureCode": "TOKEN_EXPIRED"},
			map[string]any{"platform": "threads", "handle": "@th", "status": "UNKNOWN_DELIVERY"},
		},
	})

	if !strings.Contains(env.Subject, "1 published") || !strings.Contains(env.Subject, "1 failed") || !strings.Contains(env.Subject, "1 sent to app") {
		t.Fatalf("unexpected summary subject: %q", env.Subject)
	}
	if !strings.Contains(env.Text, "https://x.com/shots/status/1") || !strings.Contains(env.Text, "token expired") {
		t.Fatalf("unexpected summary text: %q", env.Text)
	}
	if strings.Contains(env.HTML, "<script>") {
		t.Fatalf("expected HTML to escape untrusted handle, got %q", env.HTML)
	}
	if strings.Contains(env.HTML, `href="javascript:`) {
		t.Fatalf("expected javascript: remoteUrl to never be rendered as an anchor href, got %q", env.HTML)
	}
	if !strings.Contains(env.HTML, "&lt;script&gt;alert(1)&lt;/script&gt;") {
		t.Fatalf("expected escaped script tag in HTML, got %q", env.HTML)
	}

	// Empty outcomes payload should still produce valid subject/text/HTML without panicking.
	emptyEnv := &Envelope{Subject: "Post publish summary", Workspace: "Acme"}
	renderPostSummary(emptyEnv, map[string]any{})
	if emptyEnv.Subject == "" || emptyEnv.HTML == "" {
		t.Fatalf("expected non-empty fallback for empty summary payload")
	}
}
