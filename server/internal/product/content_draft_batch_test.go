package product

import (
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestSpreadTimes(t *testing.T) {
	input := DraftBatchTimesInput{Count: 6, LocalTime: "2027-03-13T09:00", PostsPerDay: 2, SpacingMinutes: 240, ShiftMinutes: 15, Seed: "a-stable-batch-seed"}
	now := time.Date(2027, 3, 1, 0, 0, 0, 0, time.UTC)
	first, err := spreadTimes(input, "America/New_York", now)
	if err != nil {
		t.Fatal(err)
	}
	second, err := spreadTimes(input, "America/New_York", now)
	if err != nil || !reflect.DeepEqual(first, second) {
		t.Fatal("a repeated preview moved times")
	}
	zone, _ := time.LoadLocation("America/New_York")
	for i, at := range first {
		local := at.In(zone)
		if local.Day() != 13+i/2 {
			t.Fatal("spread moved day across DST", first)
		}
		minutes := local.Hour()*60 + local.Minute()
		expected := 9*60 + (i%2)*240
		if minutes < expected || minutes > expected+15 || minutes%5 != 0 {
			t.Fatal("shift outside configured bounds", first)
		}
	}
	input.LocalTime = "2027-03-14T02:30"
	input.ShiftMinutes = 0
	if _, err := spreadTimes(input, "America/New_York", now); err == nil || !strings.Contains(err.Error(), "Post 1 would be at Mar 14 02:30, a time the clocks skip") {
		t.Fatal("DST gap accepted or not named:", err)
	}
	input.LocalTime = "2027-11-06T01:30"
	if _, err := spreadTimes(input, "America/New_York", now); err == nil || !strings.Contains(err.Error(), "Post 3 would be at Nov 7 01:30, a time that happens twice") {
		t.Fatal("ambiguous DST time accepted or not named:", err)
	}
	// A day's posts carry past midnight, as Bulk Tools' executed examples do.
	wall := func(times []time.Time) []string {
		out := []string{}
		for _, at := range times {
			out = append(out, at.UTC().Format("2006-01-02T15:04"))
		}
		return out
	}
	for name, tt := range map[string]struct {
		input DraftBatchTimesInput
		want  []string
	}{
		"three a day six hours apart": {DraftBatchTimesInput{Count: 4, LocalTime: "2027-10-13T08:00", PostsPerDay: 3, SpacingMinutes: 360, Seed: "a-stable-batch-seed"},
			[]string{"2027-10-13T08:00", "2027-10-13T14:00", "2027-10-13T20:00", "2027-10-14T08:00"}},
		"four a day six hours apart carry to 02:00": {DraftBatchTimesInput{Count: 5, LocalTime: "2027-11-13T08:00", PostsPerDay: 4, SpacingMinutes: 360, Seed: "a-stable-batch-seed"},
			[]string{"2027-11-13T08:00", "2027-11-13T14:00", "2027-11-13T20:00", "2027-11-14T02:00", "2027-11-14T08:00"}},
		"a late start runs into the next day": {DraftBatchTimesInput{Count: 3, LocalTime: "2027-03-15T23:30", PostsPerDay: 2, SpacingMinutes: 60, Seed: "a-stable-batch-seed"},
			[]string{"2027-03-15T23:30", "2027-03-16T00:30", "2027-03-16T23:30"}},
	} {
		got, err := spreadTimes(tt.input, "UTC", now)
		if err != nil || !reflect.DeepEqual(wall(got), tt.want) {
			t.Fatalf("%s: %v %v", name, wall(got), err)
		}
	}
	// A shift only moves a post later, and the most it can add keeps hourly posts in order.
	shifted, err := spreadTimes(DraftBatchTimesInput{Count: 100, LocalTime: "2027-03-15T00:00", PostsPerDay: 24, SpacingMinutes: 60, ShiftMinutes: 55, Seed: "a-stable-batch-seed"}, "UTC", now)
	if err != nil || len(shifted) != 100 {
		t.Fatalf("hourly with the largest shift: %d %v", len(shifted), err)
	}
	if _, err := spreadTimes(DraftBatchTimesInput{Count: 2, LocalTime: "2027-03-15T08:00", PostsPerDay: 4, SpacingMinutes: 480, Seed: "a-stable-batch-seed"}, "UTC", now); err == nil {
		t.Fatal("a day of posts longer than 24 hours was accepted")
	}
	input.LocalTime = "2027-03-15T09:00"
	input.ShiftMinutes = 4
	if _, err := spreadTimes(input, "UTC", now); err == nil {
		t.Fatal("non-five-minute shift accepted")
	}
}
