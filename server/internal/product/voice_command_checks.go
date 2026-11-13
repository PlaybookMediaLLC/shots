package product

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
)

// The plain-code checks of a voice command (plan 5.4, step 4). A model works
// out what the speaker meant; these decide whether it is allowed and exactly
// when. They run on the model's reply at proposal and again on the card's
// values at confirm; nothing here trusts either.

// voiceCommandHorizon is how far ahead a voice command may schedule. The
// scheduler itself has no maximum, so this is the voice command's own bound.
const voiceCommandHorizon = 365 * 24 * time.Hour

// voiceCommandAskWindow is how long a proposal whose time must be asked again
// (missing, skipped, repeated or already past) stays open for the card.
const voiceCommandAskWindow = 24 * time.Hour

// Flags the card acts on. Each names a check that did not pass cleanly.
const (
	voiceFlagTimeMissing    = "time_missing"
	voiceFlagTimeInvalid    = "time_invalid"
	voiceFlagTimeGap        = "time_gap"
	voiceFlagTimeAmbiguous  = "time_ambiguous"
	voiceFlagTimePast       = "time_past"
	voiceFlagTimeTooFar     = "time_too_far"
	voiceFlagRelativeDay    = "time_relative_day"
	voiceFlagAfterMidnight  = "tomorrow_after_midnight"
	voiceFlagPlatformChoice = "platform_ambiguous"
	voiceFlagNotConnected   = "platform_not_connected"
	voiceFlagTextTooLong    = "text_too_long"
	voiceFlagAddedWords     = "text_added_words"
	voiceFlagCannotSchedule = "cannot_schedule"
	voiceFlagSecondRequest  = "second_request"
	voiceFlagUnsupported    = "unsupported"
)

// voiceParse is the model's reply in the fixed schema (plan 5.4, step 3).
// SecondRequest and Unsupported carry K19 and K20 to the card.
type voiceParse struct {
	Action        string   `json:"action"`
	Platform      *string  `json:"platform"`
	Text          *string  `json:"text"`
	LocalTime     *string  `json:"local_time"`
	Guessed       []string `json:"guessed"`
	SecondRequest bool     `json:"second_request"`
	Unsupported   *string  `json:"unsupported"`
}

// voiceCheckInput is what the checks need besides the reply. Channels are the
// accounts the member may post to; RecordedAt is the phone's recording time.
type voiceCheckInput struct {
	Transcript  string
	RecordedAt  time.Time
	TimeZone    string
	Now         time.Time
	Channels    []*ent.ChannelConnection
	CanSchedule bool
}

// voiceProposal is the checked proposal. Status is proposed, or failed (not
// understood, or only an unsupported request), or withdrawn (not a command).
type voiceProposal struct {
	Status              string
	Action              string
	Platform            *string
	Text                *string
	LocalTime           *string
	ScheduledFor        *time.Time
	ChannelConnectionID *string
	Guessed             []string
	Flags               []string
	Notice              *string
	ExpiresAt           *time.Time
}

const voiceNotUnderstood = "Shots could not understand this as a command. The note is kept as an ordinary note."

// checkVoiceProposal turns a reply into a proposal (plan 5.4 table).
func checkVoiceProposal(reply voiceParse, in voiceCheckInput) voiceProposal {
	result := voiceProposal{Status: "proposed", Action: reply.Action, Guessed: []string{}, Flags: []string{}}
	notices := []string{}
	if reply.Unsupported != nil && strings.TrimSpace(*reply.Unsupported) != "" {
		part := strings.TrimSpace(*reply.Unsupported)
		if len([]rune(part)) > 120 {
			part = string([]rune(part)[:120])
		}
		result.Flags = append(result.Flags, voiceFlagUnsupported)
		notices = append(notices, "Only scheduling and drafting a text post are supported, so “"+part+"” was not acted on.")
	}
	text := ""
	if reply.Text != nil {
		text = strings.TrimSpace(*reply.Text)
	}
	switch {
	case reply.Action == "none" && len(notices) == 0:
		return voiceProposal{Status: "withdrawn", Action: "none", Guessed: []string{}, Flags: []string{}}
	case reply.Action == "none":
		result.Status = "failed"
		result.Notice = &notices[0]
		return result
	case reply.Action != "schedule_post" && reply.Action != "create_draft", text == "", len([]rune(text)) > voiceCommandTextLimit:
		notice := voiceNotUnderstood
		return voiceProposal{Status: "failed", Action: "none", Guessed: []string{}, Flags: []string{}, Notice: &notice}
	}
	result.Text = &text
	guess := func(field string) {
		if !slices.Contains(result.Guessed, field) {
			result.Guessed = append(result.Guessed, field)
		}
	}
	for _, field := range reply.Guessed {
		if field == "platform" || field == "text" || field == "local_time" {
			guess(field)
		}
	}
	if added := voiceAddedWords(in.Transcript, text); len(added) > 0 {
		result.Flags = append(result.Flags, voiceFlagAddedWords)
		guess("text")
	}
	if reply.SecondRequest {
		result.Flags = append(result.Flags, voiceFlagSecondRequest)
		notices = append(notices, "A second request was heard in this note and was not acted on.")
	}

	// Which account: exactly one the member may post to (K5).
	// A platform Shots cannot post to is kept, short, for the card to name.
	platform := ""
	if reply.Platform != nil {
		named := strings.ToLower(strings.TrimSpace(*reply.Platform))
		if platform = draftPlatformChannels[named]; platform == "" && utf8.RuneCountInString(named) <= 40 {
			platform = named
		}
	}
	if platform != "" {
		result.Platform = &platform
	}
	candidates := voiceCandidates(in.Channels, platform)
	switch {
	case len(candidates) == 0:
		result.Flags = append(result.Flags, voiceFlagNotConnected)
		notices = append(notices, "No account you can post to is connected for this, so it will be saved as a draft. Connect the account to schedule it.")
		result.Action = "create_draft"
	case len(candidates) == 1:
		result.ChannelConnectionID = &candidates[0].ID
		if platform == "" {
			guess("platform")
			channel := draftPlatformChannels[candidates[0].Platform]
			result.Platform = &channel
		}
	default:
		result.Flags = append(result.Flags, voiceFlagPlatformChoice)
	}
	if result.Platform != nil {
		// Text too complex to count is flagged too; scheduling refuses it.
		if limit, ok := draftChannelLimits[*result.Platform]; ok {
			if length, err := draftPostLength(*result.Platform, text, nil); err != nil || length > limit {
				result.Flags = append(result.Flags, voiceFlagTextTooLong)
			}
		}
	}

	// When: a wall-clock time in the recording's zone, resolved from the
	// recording time, that names exactly one future instant (K1, K2, K4, K16).
	recorded := voiceRecordedClock(in.RecordedAt, in.TimeZone)
	if reply.LocalTime != nil && strings.TrimSpace(*reply.LocalTime) != "" {
		local := strings.TrimSpace(*reply.LocalTime)
		at, flag := voiceInstant(local, in.TimeZone, in.Now)
		if flag != "" {
			result.Flags = append(result.Flags, flag)
			guess("local_time")
		} else {
			result.ScheduledFor = &at
		}
		// Only a well-formed wall time is kept; the card asks for any other.
		if wall, ok := voiceWallTime(local); ok {
			result.LocalTime = &local
			if voiceAfterMidnightTomorrow(in.Transcript, recorded) {
				result.Flags = append(result.Flags, voiceFlagAfterMidnight)
				guess("local_time")
				notices = append(notices, fmt.Sprintf("You recorded this after midnight: “tomorrow” may mean %s or %s.",
					recorded.Format("Monday 2 January"), recorded.AddDate(0, 0, 1).Format("Monday 2 January")))
			} else if voiceRelativeDayMismatch(in.Transcript, recorded, wall) {
				result.Flags = append(result.Flags, voiceFlagRelativeDay)
				guess("local_time")
			}
		}
	} else if result.Action == "schedule_post" {
		result.Flags = append(result.Flags, voiceFlagTimeMissing)
		guess("local_time")
	}

	// The role decides last: a member who cannot schedule gets a draft (K10).
	if result.Action == "schedule_post" && !in.CanSchedule {
		result.Flags = append(result.Flags, voiceFlagCannotSchedule)
		notices = append(notices, "Your role cannot schedule posts, so this will be saved as a draft.")
		result.Action = "create_draft"
	}
	switch {
	case result.ScheduledFor != nil:
		result.ExpiresAt = result.ScheduledFor
	case result.Action == "schedule_post":
		expires := in.Now.Add(voiceCommandAskWindow)
		result.ExpiresAt = &expires
	}
	if len(notices) > 0 {
		notice := strings.Join(notices, " ")
		result.Notice = &notice
	}
	return result
}

// voiceCommandTextLimit is the longest post text a command carries; the
// table's check holds the same number.
const voiceCommandTextLimit = 2000

// voiceRecordedClock is the recording time on its zone's wall clock, which
// the model and the relative-day checks count from (K1, K3); UTC when the
// zone is unknown.
func voiceRecordedClock(at time.Time, zone string) time.Time {
	if location, err := time.LoadLocation(zone); err == nil {
		return at.In(location)
	}
	return at.UTC()
}

// voiceWallTime parses a wall time written exactly as YYYY-MM-DDTHH:MM, the
// only form a command stores.
func voiceWallTime(local string) (time.Time, bool) {
	wall, err := time.Parse("2006-01-02T15:04", local)
	return wall, err == nil && wall.Format("2006-01-02T15:04") == local
}

// voiceInstant resolves a wall-clock time in a zone to the one instant it
// names, and checks it is in the future and within the horizon. The flag is
// empty when it passes; otherwise it says why, for the card to ask.
func voiceInstant(local, zone string, now time.Time) (time.Time, string) {
	if _, ok := voiceWallTime(local); !ok {
		return time.Time{}, voiceFlagTimeInvalid
	}
	at, err := resolveLocalTime(local, zone, "")
	var localErr *LocalTimeError
	switch {
	case errors.As(err, &localErr) && localErr.Kind == "gap":
		return time.Time{}, voiceFlagTimeGap
	case errors.As(err, &localErr):
		return time.Time{}, voiceFlagTimeAmbiguous
	case err != nil:
		return time.Time{}, voiceFlagTimeInvalid
	case !at.After(now):
		return time.Time{}, voiceFlagTimePast
	case at.After(now.Add(voiceCommandHorizon)):
		return time.Time{}, voiceFlagTimeTooFar
	}
	return at, ""
}

// voiceInstantError is voiceInstant at confirm: the card's time is refused
// with the reason, never moved (K2, K4, K22).
func voiceInstantError(local, zone string, now time.Time) (time.Time, error) {
	at, flag := voiceInstant(local, zone, now)
	switch flag {
	case "":
		return at, nil
	case voiceFlagTimePast:
		return time.Time{}, invalid("That time has passed. Pick a time in the future.")
	case voiceFlagTimeTooFar:
		return time.Time{}, invalid("Pick a time within a year.")
	case voiceFlagTimeInvalid:
		if _, ok := voiceWallTime(local); !ok {
			return time.Time{}, invalid("Give the local time as YYYY-MM-DDTHH:MM.")
		}
	}
	// A skipped or repeated time, or an unknown zone, says which.
	_, err := resolveLocalTime(local, zone, "")
	return time.Time{}, err
}

// voiceCandidates are the channels on the named platform, or all of them when
// no platform was named.
func voiceCandidates(channels []*ent.ChannelConnection, platform string) []*ent.ChannelConnection {
	out := []*ent.ChannelConnection{}
	for _, channel := range channels {
		if platform == "" || draftPlatformChannels[channel.Platform] == platform {
			out = append(out, channel)
		}
	}
	return out
}

// voiceWords splits text into words, lowercased with punctuation dropped for
// comparison, alongside each word as written.
func voiceWords(text string) (normalized, written []string) {
	for _, field := range strings.FieldsFunc(text, func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '\'' && r != '’'
	}) {
		word := strings.Map(func(r rune) rune {
			if r == '\'' || r == '’' {
				return -1
			}
			return unicode.ToLower(r)
		}, field)
		if word != "" {
			normalized = append(normalized, word)
			written = append(written, strings.Trim(field, "'’"))
		}
	}
	return normalized, written
}

// voiceAddedWords is the post text's words that are not in the transcript,
// word for word in order, ignoring case and punctuation (K17). The longest
// common subsequence keeps the most spoken words, so removed filler words are
// allowed and only words the speaker did not say are returned.
func voiceAddedWords(transcript, text string) []string {
	spoken, _ := voiceWords(transcript)
	words, written := voiceWords(text)
	// One flat table of 16-bit lengths: both texts are at most 2,000
	// characters, so at most 1,000 words each and about 2 MB at worst.
	width := len(spoken) + 1
	lcs := make([]uint16, (len(words)+1)*width)
	// at(i, j) is the common length of words[i:] and spoken[j:].
	at := func(i, j int) uint16 { return lcs[i*width+j] }
	for i := len(words) - 1; i >= 0; i-- {
		for j := len(spoken) - 1; j >= 0; j-- {
			if words[i] == spoken[j] {
				lcs[i*width+j] = at(i+1, j+1) + 1
			} else {
				lcs[i*width+j] = max(at(i+1, j), at(i, j+1))
			}
		}
	}
	added := []string{}
	for i, j := 0, 0; i < len(words); {
		switch {
		case j < len(spoken) && words[i] == spoken[j]:
			i, j = i+1, j+1
		case j < len(spoken) && at(i, j+1) >= at(i+1, j):
			j++
		default:
			added = append(added, written[i])
			i++
		}
	}
	return added
}

// voiceSaysWord reports whether the transcript holds the word.
func voiceSaysWord(transcript string, word ...string) bool {
	words, _ := voiceWords(transcript)
	return slices.ContainsFunc(words, func(w string) bool { return slices.Contains(word, w) })
}

// voiceAfterMidnightTomorrow reports "tomorrow" said between midnight and
// 4 am, where the speaker may mean the day that has just begun (K16).
func voiceAfterMidnightTomorrow(transcript string, recorded time.Time) bool {
	return recorded.Hour() < 4 && voiceSaysWord(transcript, "tomorrow")
}

// voiceRelativeDayMismatch reports a time whose date does not follow from the
// relative day spoken, counted from the recording time, not the sync time
// (K1): "today" or "tonight" is the recording's date, "tomorrow" the next.
func voiceRelativeDayMismatch(transcript string, recorded, local time.Time) bool {
	today, tomorrow := voiceSaysWord(transcript, "today", "tonight"), voiceSaysWord(transcript, "tomorrow")
	if today == tomorrow {
		return false
	}
	want := recorded
	if tomorrow {
		want = recorded.AddDate(0, 0, 1)
	}
	return local.Format("2006-01-02") != want.Format("2006-01-02")
}
