package product

import (
	"context"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"testing"
	"time"
)

func TestNaturalTimeNeverTurnsANearFutureScheduleIntoImmediatePublication(t *testing.T) {
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	base := now.Add(time.Second)
	draft := &ent.ContentDraft{ID: "draft-natural-boundary", NaturalPostingTime: true}
	// Default window is ±10 minutes when NaturalPostingWindowMinutes is unset (0).
	sawBeyondFourMin := false
	for version := 1; version <= 500; version++ {
		input := ScheduleContentDraftInput{ScheduledFor: base, Version: version}
		placed, err := placeDraftSchedule(context.Background(), nil, &ent.SocialSet{}, draft, input, now)
		if err != nil || !placed.at.After(now.Add(30*time.Second)) || placed.at.Sub(base) > 10*time.Minute || placed.at.Sub(base) < -10*time.Minute || !placed.base.Equal(base) {
			t.Fatalf("unsafe default natural placement: %+v %v", placed, err)
		}
		if placed.at.Sub(base) > 4*time.Minute {
			sawBeyondFourMin = true
		}
		again, err := placeDraftSchedule(context.Background(), nil, &ent.SocialSet{}, draft, input, now)
		if err != nil || !placed.at.Equal(again.at) {
			t.Fatal("same request produced different time")
		}
	}
	if !sawBeyondFourMin {
		t.Fatal("expected default ±10m window to produce placements beyond 4 minutes")
	}
	// Configured window (e.g., migrated ±4 minutes) stays bounded to ±4 minutes.
	for version := 1; version <= 200; version++ {
		input := ScheduleContentDraftInput{ScheduledFor: base, Version: version}
		placed, err := placeDraftSchedule(context.Background(), nil, &ent.SocialSet{NaturalPostingWindowMinutes: 4}, draft, input, now)
		if err != nil || !placed.at.After(now.Add(30*time.Second)) || placed.at.Sub(base) > 4*time.Minute || placed.at.Sub(base) < -4*time.Minute || !placed.base.Equal(base) {
			t.Fatalf("unsafe ±4m natural placement: %+v %v", placed, err)
		}
	}
	draft.NaturalPostingTime = false
	if _, err := placeDraftSchedule(context.Background(), nil, &ent.SocialSet{}, draft, ScheduleContentDraftInput{ScheduledFor: base, Version: 1}, now); err == nil {
		t.Fatal("non-natural near-immediate schedule accepted")
	}
}
