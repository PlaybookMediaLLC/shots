package product

import (
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
)

func TestVoiceCommandAddedWords(t *testing.T) {
	const spoken = "Shots, post the following tweet at 10 am tomorrow: entrepreneurship, um, is hard."
	for _, c := range []struct {
		name, transcript, text string
		want                   []string
	}{
		{"exact words", spoken, "Entrepreneurship is hard.", []string{}},
		{"filler removed", "entrepreneurship, um, is hard", "Entrepreneurship is hard", []string{}},
		{"case and punctuation ignored", "dont STOP believing", "Don't stop, believing!", []string{}},
		{"a word the speaker did not say", spoken, "Entrepreneurship is really hard!", []string{"really"}},
		{"order matters", "a b c", "c a b", []string{"c"}},
		{"nothing spoken", "hello", "goodbye world", []string{"goodbye", "world"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := voiceAddedWords(c.transcript, c.text); !slices.Equal(got, c.want) {
				t.Fatalf("added=%q, want %q", got, c.want)
			}
		})
	}
}

func TestVoiceCommandInstant(t *testing.T) {
	now := time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC)
	for _, c := range []struct {
		name, local, zone, flag string
		want                    time.Time
	}{
		{"one instant", "2026-11-12T10:00", "America/New_York", "", time.Date(2026, 11, 12, 15, 0, 0, 0, time.UTC)},
		{"clocks skip it (K4)", "2027-03-14T02:30", "America/New_York", voiceFlagTimeGap, time.Time{}},
		{"clocks repeat it (K4)", "2027-11-07T01:30", "America/New_York", voiceFlagTimeAmbiguous, time.Time{}},
		{"already passed (K2)", "2026-11-11T06:59", "America/New_York", voiceFlagTimePast, time.Time{}},
		{"beyond the horizon (K2)", "2027-11-12T10:00", "America/New_York", voiceFlagTimeTooFar, time.Time{}},
		{"not a zone", "2026-11-12T10:00", "Mars/Olympus", voiceFlagTimeInvalid, time.Time{}},
		{"not a wall time", "10am", "America/New_York", voiceFlagTimeInvalid, time.Time{}},
		{"not the stored form", "2026-11-12T9:00", "America/New_York", voiceFlagTimeInvalid, time.Time{}},
	} {
		t.Run(c.name, func(t *testing.T) {
			at, flag := voiceInstant(c.local, c.zone, now)
			if flag != c.flag || !at.Equal(c.want) {
				t.Fatalf("at=%v flag=%q, want %v %q", at, flag, c.want, c.flag)
			}
			_, err := voiceInstantError(c.local, c.zone, now)
			if (err == nil) != (c.flag == "") {
				t.Fatalf("confirm err=%v for flag %q", err, c.flag)
			}
		})
	}
}

func TestVoiceCommandRelativeDays(t *testing.T) {
	zone, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	lateEvening := time.Date(2026, 11, 10, 23, 50, 0, 0, zone)
	afterMidnight := time.Date(2026, 11, 11, 1, 30, 0, 0, zone)
	wall := func(value string) time.Time {
		at, err := time.Parse("2006-01-02T15:04", value)
		if err != nil {
			t.Fatal(err)
		}
		return at
	}
	for _, c := range []struct {
		name, transcript, local string
		recorded                time.Time
		mismatch, early         bool
	}{
		{"tomorrow from the recording time (K1)", "post this tomorrow at 10", "2026-11-11T10:00", lateEvening, false, false},
		{"tomorrow from the sync time is caught (K1)", "post this tomorrow at 10", "2026-11-12T10:00", lateEvening, true, false},
		{"tonight is the recording's date", "post this tonight at 11:55", "2026-11-10T23:55", lateEvening, false, false},
		{"no relative word", "post this on the 14th", "2026-11-14T10:00", lateEvening, false, false},
		{"both words are left to the model", "today, no, tomorrow", "2026-11-12T10:00", lateEvening, false, false},
		{"tomorrow after midnight, meaning after sleep (K16)", "post this tomorrow at 10", "2026-11-11T10:00", afterMidnight, true, true},
		{"tomorrow after midnight, meaning the next date (K16)", "post this tomorrow at 10", "2026-11-12T10:00", afterMidnight, false, true},
		{"at 4 am tomorrow is the next day", "post this tomorrow", "2026-11-12T10:00", afterMidnight.Add(150 * time.Minute), false, false},
		{"after midnight without tomorrow", "post this at 10", "2026-11-11T10:00", afterMidnight, false, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := voiceRelativeDayMismatch(c.transcript, c.recorded, wall(c.local)); got != c.mismatch {
				t.Fatalf("mismatch=%v, want %v", got, c.mismatch)
			}
			if got := voiceAfterMidnightTomorrow(c.transcript, c.recorded); got != c.early {
				t.Fatalf("after midnight=%v, want %v", got, c.early)
			}
		})
	}
}

func TestVoiceCommandProposalChecks(t *testing.T) {
	zone := "America/New_York"
	// Recorded at 11:50 pm on 10 November; the card appears the next morning.
	recorded := time.Date(2026, 11, 11, 4, 50, 0, 0, time.UTC)
	now := time.Date(2026, 11, 11, 13, 0, 0, 0, time.UTC)
	x1 := &ent.ChannelConnection{ID: "x1", Platform: "x"}
	x2 := &ent.ChannelConnection{ID: "x2", Platform: "twitter"}
	linkedin := &ent.ChannelConnection{ID: "li", Platform: "linkedin"}
	text := func(value string) *string { return &value }
	const spoken = "Shots, post the following tweet at 10 am tomorrow: entrepreneurship is hard."
	tweet := voiceParse{Action: "schedule_post", Platform: text("x"), Text: text("Entrepreneurship is hard."), LocalTime: text("2026-11-11T10:00"), Guessed: []string{}}
	with := func(change func(*voiceParse)) voiceParse {
		reply := tweet
		change(&reply)
		return reply
	}
	at := time.Date(2026, 11, 11, 15, 0, 0, 0, time.UTC)
	long := strings.Repeat("hard ", 57)
	for _, c := range []struct {
		name        string
		reply       voiceParse
		transcript  string
		recorded    time.Time
		channels    []*ent.ChannelConnection
		cannot      bool
		status      string
		action      string
		channel     string
		flags       []string
		guessed     []string
		notice      string
		scheduled   *time.Time
		expires     *time.Time
		noLocalTime bool
	}{
		{name: "the plan's example", reply: tweet, channels: []*ent.ChannelConnection{x1, linkedin}, status: "proposed", action: "schedule_post",
			channel: "x1", scheduled: &at, expires: &at},
		{name: "several X accounts ask which (K5)", reply: tweet, channels: []*ent.ChannelConnection{x1, x2}, status: "proposed",
			action: "schedule_post", flags: []string{voiceFlagPlatformChoice}, scheduled: &at, expires: &at},
		{name: "no X account becomes a draft (K5)", reply: tweet, channels: []*ent.ChannelConnection{linkedin}, status: "proposed",
			action: "create_draft", flags: []string{voiceFlagNotConnected}, notice: "Connect the account", scheduled: &at, expires: &at},
		{name: "a platform Shots cannot post to becomes a draft (K5)", reply: with(func(r *voiceParse) { r.Platform = text("Facebook") }),
			channels: []*ent.ChannelConnection{x1}, status: "proposed", action: "create_draft", flags: []string{voiceFlagNotConnected},
			notice: "Connect the account", scheduled: &at, expires: &at},
		{name: "one account when none was named", reply: with(func(r *voiceParse) { r.Platform = nil }), channels: []*ent.ChannelConnection{linkedin},
			status: "proposed", action: "schedule_post", channel: "li", guessed: []string{"platform"}, scheduled: &at, expires: &at},
		{name: "over the platform's limit (K6)", reply: with(func(r *voiceParse) { r.Text = text(long) }), transcript: long,
			channels: []*ent.ChannelConnection{x1}, status: "proposed", action: "schedule_post", channel: "x1",
			flags: []string{voiceFlagTextTooLong}, scheduled: &at, expires: &at},
		{name: "a role that cannot schedule gets a draft (K10)", reply: tweet, channels: []*ent.ChannelConnection{x1}, cannot: true,
			status: "proposed", action: "create_draft", channel: "x1", flags: []string{voiceFlagCannotSchedule}, notice: "saved as a draft",
			scheduled: &at, expires: &at},
		{name: "a second request is named (K19)", reply: with(func(r *voiceParse) { r.SecondRequest = true }), channels: []*ent.ChannelConnection{x1},
			status: "proposed", action: "schedule_post", channel: "x1", flags: []string{voiceFlagSecondRequest}, notice: "second request",
			scheduled: &at, expires: &at},
		{name: "an unsupported part is named (K20)", reply: with(func(r *voiceParse) { r.Unsupported = text("with my latest screenshot") }),
			channels: []*ent.ChannelConnection{x1}, status: "proposed", action: "schedule_post", channel: "x1", flags: []string{voiceFlagUnsupported},
			notice: "with my latest screenshot", scheduled: &at, expires: &at},
		{name: "an unsupported request alone is a notice (K13)", reply: voiceParse{Action: "none", Unsupported: text("delete my last tweet")},
			channels: []*ent.ChannelConnection{x1}, status: "failed", action: "none", flags: []string{voiceFlagUnsupported}, notice: "delete my last tweet",
			noLocalTime: true},
		{name: "not a command", reply: voiceParse{Action: "none"}, channels: []*ent.ChannelConnection{x1}, status: "withdrawn", action: "none", noLocalTime: true},
		{name: "nothing usable (K12)", reply: with(func(r *voiceParse) { r.Text = text("  ") }), channels: []*ent.ChannelConnection{x1},
			status: "failed", action: "none", notice: "could not understand", noLocalTime: true},
		{name: "an unknown action (K12)", reply: with(func(r *voiceParse) { r.Action = "publish_now" }), channels: []*ent.ChannelConnection{x1},
			status: "failed", action: "none", notice: "could not understand", noLocalTime: true},
		{name: "added words are flagged (K17)", reply: with(func(r *voiceParse) { r.Text = text("Entrepreneurship is really hard.") }),
			channels: []*ent.ChannelConnection{x1}, status: "proposed", action: "schedule_post", channel: "x1", flags: []string{voiceFlagAddedWords},
			guessed: []string{"text"}, scheduled: &at, expires: &at},
		{name: "tomorrow after midnight asks (K16)", reply: with(func(r *voiceParse) { r.LocalTime = text("2026-11-12T10:00") }),
			recorded: time.Date(2026, 11, 11, 6, 30, 0, 0, time.UTC), channels: []*ent.ChannelConnection{x1}, status: "proposed",
			action: "schedule_post", channel: "x1", flags: []string{voiceFlagAfterMidnight}, guessed: []string{"local_time"},
			notice: "Wednesday 11 November or Thursday 12 November", scheduled: timePointer(time.Date(2026, 11, 12, 15, 0, 0, 0, time.UTC)),
			expires: timePointer(time.Date(2026, 11, 12, 15, 0, 0, 0, time.UTC))},
		{name: "a date counted from the sync time is flagged (K1)", reply: with(func(r *voiceParse) { r.LocalTime = text("2026-11-12T10:00") }),
			channels: []*ent.ChannelConnection{x1}, status: "proposed", action: "schedule_post", channel: "x1", flags: []string{voiceFlagRelativeDay},
			guessed: []string{"local_time"}, scheduled: timePointer(time.Date(2026, 11, 12, 15, 0, 0, 0, time.UTC)),
			expires: timePointer(time.Date(2026, 11, 12, 15, 0, 0, 0, time.UTC))},
		{name: "a time already passed asks again (K2)", reply: with(func(r *voiceParse) { r.LocalTime = text("2026-11-11T07:00") }),
			channels: []*ent.ChannelConnection{x1}, status: "proposed", action: "schedule_post", channel: "x1", flags: []string{voiceFlagTimePast},
			guessed: []string{"local_time"}, expires: timePointer(now.Add(voiceCommandAskWindow))},
		{name: "a time the clocks skip asks (K4)", reply: with(func(r *voiceParse) { r.LocalTime = text("2027-03-14T02:30") }), transcript: "post at 2:30 on March 14",
			channels: []*ent.ChannelConnection{x1}, status: "proposed", action: "schedule_post", channel: "x1", flags: []string{voiceFlagAddedWords, voiceFlagTimeGap},
			guessed: []string{"text", "local_time"}, expires: timePointer(now.Add(voiceCommandAskWindow))},
		{name: "no time said asks for one", reply: with(func(r *voiceParse) { r.LocalTime = nil }), channels: []*ent.ChannelConnection{x1},
			status: "proposed", action: "schedule_post", channel: "x1", flags: []string{voiceFlagTimeMissing}, guessed: []string{"local_time"},
			expires: timePointer(now.Add(voiceCommandAskWindow)), noLocalTime: true},
		{name: "a malformed time is never stored", reply: with(func(r *voiceParse) { r.LocalTime = text("10am tomorrow") }),
			channels: []*ent.ChannelConnection{x1}, status: "proposed", action: "schedule_post", channel: "x1", flags: []string{voiceFlagTimeInvalid},
			guessed: []string{"local_time"}, expires: timePointer(now.Add(voiceCommandAskWindow)), noLocalTime: true},
		{name: "only known guesses are kept", reply: with(func(r *voiceParse) { r.Guessed = []string{"local_time", "action", "local_time"} }),
			channels: []*ent.ChannelConnection{x1}, status: "proposed", action: "schedule_post", channel: "x1", guessed: []string{"local_time"},
			scheduled: &at, expires: &at},
		{name: "a draft without a time never expires", reply: with(func(r *voiceParse) { r.Action, r.LocalTime = "create_draft", nil }),
			channels: []*ent.ChannelConnection{x1}, status: "proposed", action: "create_draft", channel: "x1", noLocalTime: true},
	} {
		t.Run(c.name, func(t *testing.T) {
			transcript, when := spoken, recorded
			if c.transcript != "" {
				transcript = c.transcript
			}
			if !c.recorded.IsZero() {
				when = c.recorded
			}
			got := checkVoiceProposal(c.reply, voiceCheckInput{Transcript: transcript, RecordedAt: when, TimeZone: zone, Now: now,
				Channels: c.channels, CanSchedule: !c.cannot})
			if got.Status != c.status || got.Action != c.action {
				t.Fatalf("status=%s action=%s, want %s %s", got.Status, got.Action, c.status, c.action)
			}
			if channel := deref(got.ChannelConnectionID); channel != c.channel {
				t.Fatalf("channel=%q, want %q", channel, c.channel)
			}
			if !slices.Equal(got.Flags, nonNilStrings(c.flags)) || !slices.Equal(got.Guessed, nonNilStrings(c.guessed)) {
				t.Fatalf("flags=%q guessed=%q, want %q %q", got.Flags, got.Guessed, c.flags, c.guessed)
			}
			if !strings.Contains(deref(got.Notice), c.notice) || (c.notice == "") != (got.Notice == nil) {
				t.Fatalf("notice=%q, want %q", deref(got.Notice), c.notice)
			}
			if !sameTime(got.ScheduledFor, c.scheduled) || !sameTime(got.ExpiresAt, c.expires) {
				t.Fatalf("scheduled=%v expires=%v, want %v %v", got.ScheduledFor, got.ExpiresAt, c.scheduled, c.expires)
			}
			if (got.LocalTime == nil) != c.noLocalTime {
				t.Fatalf("local time=%v", got.LocalTime)
			}
		})
	}
}

func deref(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func timePointer(at time.Time) *time.Time { return &at }

func sameTime(a, b *time.Time) bool { return (a == nil) == (b == nil) && (a == nil || a.Equal(*b)) }
