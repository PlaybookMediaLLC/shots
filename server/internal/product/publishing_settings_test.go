package product

import (
	"encoding/json"
	"testing"
	"time"
)

func TestNullableIntUnmarshalJSON(t *testing.T) {
	type payload struct {
		Goal NullableInt `json:"goal"`
	}

	var absent payload
	if err := json.Unmarshal([]byte(`{}`), &absent); err != nil {
		t.Fatalf("unmarshal absent: %v", err)
	}
	if absent.Goal.Set {
		t.Fatalf("expected absent Set=false, got true")
	}

	var cleared payload
	if err := json.Unmarshal([]byte(`{"goal":null}`), &cleared); err != nil {
		t.Fatalf("unmarshal null: %v", err)
	}
	if !cleared.Goal.Set || cleared.Goal.Value != nil {
		t.Fatalf("expected null Set=true Value=nil, got Set=%v Value=%v", cleared.Goal.Set, cleared.Goal.Value)
	}

	var populated payload
	if err := json.Unmarshal([]byte(`{"goal":14}`), &populated); err != nil {
		t.Fatalf("unmarshal int: %v", err)
	}
	if !populated.Goal.Set || populated.Goal.Value == nil || *populated.Goal.Value != 14 {
		t.Fatalf("expected Set=true Value=14, got Set=%v Value=%v", populated.Goal.Set, populated.Goal.Value)
	}

	var invalid payload
	if err := json.Unmarshal([]byte(`{"goal":"seven"}`), &invalid); err == nil {
		t.Fatalf("expected error for string value")
	}
}

func TestLocalWeekBounds(t *testing.T) {
	// Wednesday, 2026-11-25 15:30 UTC
	now := time.Date(2026, 11, 25, 15, 30, 0, 0, time.UTC)

	monStart, monEnd := localWeekBounds(now, time.UTC, "monday")
	wantMonStart := time.Date(2026, 11, 23, 0, 0, 0, 0, time.UTC)
	wantMonEnd := time.Date(2026, 11, 30, 0, 0, 0, 0, time.UTC)
	if !monStart.Equal(wantMonStart) || !monEnd.Equal(wantMonEnd) {
		t.Fatalf("monday week bounds = [%v, %v), want [%v, %v)", monStart, monEnd, wantMonStart, wantMonEnd)
	}

	sunStart, sunEnd := localWeekBounds(now, time.UTC, "sunday")
	wantSunStart := time.Date(2026, 11, 22, 0, 0, 0, 0, time.UTC)
	wantSunEnd := time.Date(2026, 11, 29, 0, 0, 0, 0, time.UTC)
	if !sunStart.Equal(wantSunStart) || !sunEnd.Equal(wantSunEnd) {
		t.Fatalf("sunday week bounds = [%v, %v), want [%v, %v)", sunStart, sunEnd, wantSunStart, wantSunEnd)
	}

	// Sunday with weekStart="monday" must wrap back 6 days to Monday.
	sunday := time.Date(2026, 11, 29, 10, 0, 0, 0, time.UTC)
	wrapStart, wrapEnd := localWeekBounds(sunday, time.UTC, "monday")
	wantWrapStart := time.Date(2026, 11, 23, 0, 0, 0, 0, time.UTC)
	wantWrapEnd := time.Date(2026, 11, 30, 0, 0, 0, 0, time.UTC)
	if !wrapStart.Equal(wantWrapStart) || !wrapEnd.Equal(wantWrapEnd) {
		t.Fatalf("sunday wraparound bounds = [%v, %v), want [%v, %v)", wrapStart, wrapEnd, wantWrapStart, wantWrapEnd)
	}

	// DST spring-forward week (America/New_York springs forward on 2026-03-08 -> 167h week, contiguous next week).
	ny, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatalf("load America/New_York: %v", err)
	}
	dstWeek := time.Date(2026, 3, 10, 12, 0, 0, 0, ny)
	nyStart, nyEnd := localWeekBounds(dstWeek, ny, "sunday")
	if nyEnd.Sub(nyStart) != 167*time.Hour {
		t.Fatalf("DST spring-forward week duration = %v, want 167h", nyEnd.Sub(nyStart))
	}
	nextStart, _ := localWeekBounds(nyEnd, ny, "sunday")
	if !nextStart.Equal(nyEnd) {
		t.Fatalf("next week start %v != previous week end %v (gap/overlap)", nextStart, nyEnd)
	}
}

func TestNaturalOffsetConfigurableWindow(t *testing.T) {
	slot := time.Date(2026, 12, 1, 14, 0, 0, 0, time.UTC)
	for _, windowSeconds := range []int{240, 600, 900} {
		for _, draftID := range []string{"draft-a", "draft-b", "draft-c", "draft-d", "draft-e"} {
			offset1 := naturalOffset(draftID, 1, slot, windowSeconds)
			offset2 := naturalOffset(draftID, 1, slot, windowSeconds)
			if offset1 != offset2 {
				t.Fatalf("naturalOffset not deterministic for %s: %d vs %d", draftID, offset1, offset2)
			}
			if offset1 < -windowSeconds || offset1 > windowSeconds {
				t.Fatalf("offset %d outside [-%d, +%d]", offset1, windowSeconds, windowSeconds)
			}
		}
	}
}

func TestVideoProcessingAvailableEnvFlag(t *testing.T) {
	t.Setenv("VIDEO_PROCESSING_ENABLED", "")
	if VideoProcessingAvailable() {
		t.Fatalf("expected VideoProcessingAvailable=false when env unset")
	}
	t.Setenv("VIDEO_PROCESSING_ENABLED", "true")
	if !VideoProcessingAvailable() {
		t.Fatalf("expected VideoProcessingAvailable=true when env=true")
	}
	t.Setenv("VIDEO_PROCESSING_ENABLED", "1")
	if !VideoProcessingAvailable() {
		t.Fatalf("expected VideoProcessingAvailable=true when env=1")
	}
	t.Setenv("VIDEO_PROCESSING_ENABLED", "false")
	if VideoProcessingAvailable() {
		t.Fatalf("expected VideoProcessingAvailable=false when env=false")
	}
}
