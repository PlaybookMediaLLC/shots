package product

import (
	"strings"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
)

func TestXPollAdmissionKeepsExactValues(t *testing.T) {
	poll := &postoptions.Poll{Options: []string{" A ", strings.Repeat("界", 25)}, DurationMinutes: 6}
	if err := checkPoll("x", poll, nil, 0); err != nil {
		t.Fatal(err)
	}
	if poll.DurationMinutes != 6 || poll.Options[0] != " A " {
		t.Fatal("poll rewritten")
	}
	for _, option := range []string{string([]byte{0xff}), strings.Repeat("界", 26), "   "} {
		poll.Options[0] = option
		if checkPoll("x", poll, nil, 0) == nil {
			t.Fatal("invalid option admitted")
		}
	}
}

func TestPollAndOptionFieldsCannotSilentlyDisappear(t *testing.T) {
	if checkPoll("x", &postoptions.Poll{DurationMinutes: 60}, nil, 0) == nil {
		t.Fatal("empty poll silently accepted")
	}
	for _, options := range []postoptions.PublishOptions{{ShareWithFollowers: true}, {DocumentTitle: "orphan title"}} {
		if checkPostOptions("mastodon", &options, true) == nil {
			t.Fatalf("unsupported option accepted: %+v", options)
		}
	}
	if checkPostOptions("linkedin", &postoptions.PublishOptions{DocumentTitle: "orphan"}, true) == nil {
		t.Fatal("orphan document title accepted")
	}
	comment := postoptions.PublishOptions{FirstComment: "#launch"}
	for _, channel := range []string{"linkedin", "instagram"} {
		if err := checkPostOptions(channel, &comment, true); err != nil {
			t.Fatalf("%s first comment refused: %v", channel, err)
		}
	}
	for _, channel := range []string{"x", "threads", "tiktok", "youtube", "bluesky", "mastodon"} {
		if checkPostOptions(channel, &comment, true) == nil {
			t.Fatalf("%s first comment accepted", channel)
		}
	}
	long := postoptions.PublishOptions{FirstComment: strings.Repeat("a", firstCommentLimit+1)}
	if checkPostOptions("instagram", &long, true) == nil {
		t.Fatal("overlong Instagram first comment accepted")
	}
}

func TestBlueskyNativeQuoteOptions(t *testing.T) {
	uri := "at://did:plc:abcdefghijklmnopqrstuvwx/app.bsky.feed.post/source"
	if err := checkPostOptions("bluesky", &postoptions.PublishOptions{QuoteRemoteID: uri}, true); err != nil {
		t.Fatal(err)
	}
	if err := checkPostOptions("bluesky", &postoptions.PublishOptions{QuoteFirstPost: true}, false); err != nil {
		t.Fatal(err)
	}
	if err := checkPostOptions("bluesky", &postoptions.PublishOptions{QuoteRemoteID: "123"}, true); err == nil {
		t.Fatal("X id accepted for Bluesky")
	}
	if err := checkPostOptions("bluesky", &postoptions.PublishOptions{QuoteFirstPost: true}, true); err == nil {
		t.Fatal("self-quote accepted")
	}
}

func TestThreadsPollValidation(t *testing.T) {
	poll := &postoptions.Poll{Options: []string{"Yes", "No"}, DurationMinutes: 1440}
	if err := checkPoll("threads", poll, nil, 0); err != nil {
		t.Fatal(err)
	}
	poll.DurationMinutes = 60
	if err := checkPoll("threads", poll, nil, 0); err == nil {
		t.Fatal("unsupported duration")
	}
	poll.DurationMinutes = 1440
	if err := checkPoll("threads", poll, nil, 1); err == nil {
		t.Fatal("poll with media")
	}
	poll.Multiple = true
	if err := checkPoll("threads", poll, nil, 0); err == nil {
		t.Fatal("multiple choice")
	}
}
