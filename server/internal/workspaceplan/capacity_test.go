package workspaceplan

import (
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
)

func TestResolveSubscriptionStanding(t *testing.T) {
	now := time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)
	past, future := now.Add(-time.Second), now.Add(time.Second)
	for _, test := range []struct {
		name   string
		row    *ent.WorkspaceEntitlement
		plan   string
		active bool
	}{
		{"unsubscribed", nil, "free", true},
		{"active", &ent.WorkspaceEntitlement{Plan: "pro", Status: "active"}, "pro", true},
		{"trial", &ent.WorkspaceEntitlement{Plan: "business", Status: "trialing", ValidUntil: &future}, "business", true},
		{"cancelled", &ent.WorkspaceEntitlement{Plan: "pro", Status: "cancelled"}, "pro", false},
		{"suspended", &ent.WorkspaceEntitlement{Plan: "enterprise", Status: "suspended"}, "enterprise", false},
		{"expired", &ent.WorkspaceEntitlement{Plan: "pro", Status: "active", ValidUntil: &past}, "pro", false},
		{"expires now", &ent.WorkspaceEntitlement{Plan: "pro", Status: "active", ValidUntil: &now}, "pro", false},
		{"past due without grace", &ent.WorkspaceEntitlement{Plan: "pro", Status: "past_due"}, "pro", false},
		{"grace expires now", &ent.WorkspaceEntitlement{Plan: "pro", Status: "past_due", GraceUntil: &now}, "pro", false},
		{"grace", &ent.WorkspaceEntitlement{Plan: "pro", Status: "past_due", GraceUntil: &future}, "pro", true},
		{"grace cannot extend validity", &ent.WorkspaceEntitlement{Plan: "pro", Status: "past_due", GraceUntil: &future, ValidUntil: &past}, "pro", false},
		{"unknown plan", &ent.WorkspaceEntitlement{Plan: "unexpected", Status: "active"}, "free", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			plan, _, active := Resolve(test.row, now)
			if plan != test.plan || active != test.active {
				t.Fatalf("plan=%s active=%t", plan, active)
			}
		})
	}
}

// Plans limit seats and social channels only. A team is a workspace with its
// own subscription; no plan limits how many teams a person creates or joins,
// and there is no Agency plan or team quota (Teams spec §8).
func TestPlansLimitOnlySeatsAndChannels(t *testing.T) {
	if len(limits) != 4 {
		t.Fatalf("plans=%v", limits)
	}
	for plan, named := range limits {
		if len(named) != 2 || named[Seats] == 0 && plan != "free" {
			t.Fatalf("%s limits %v", plan, named)
		}
		for name := range named {
			if name != Seats && name != Channels {
				t.Fatalf("%s limits %s", plan, name)
			}
		}
	}
}
