package postoptions

import (
	"strings"
	"testing"
)

func TestPinterestOptionsNeedABoardOnlyWhenScheduled(t *testing.T) {
	if err := ValidatePinterestOptions("pinterest", nil, false); err != nil {
		t.Fatalf("a pin being written needs no board yet: %v", err)
	}
	for _, o := range []*PinterestOptions{nil, {Title: "Launch"}} {
		if err := ValidatePinterestOptions("pinterest", o, true); err == nil || !strings.Contains(err.Error(), "board") {
			t.Fatalf("a scheduled pin without a board: %v", err)
		}
	}
	ok := &PinterestOptions{BoardID: "1001", Title: strings.Repeat("é", PinterestTitleLimit), Link: "https://shots.example/launch?ref=pin"}
	if err := ValidatePinterestOptions("pinterest", ok, true); err != nil {
		t.Fatalf("valid pin refused: %v", err)
	}
}

func TestPinterestOptionsRefuseWhatPinterestWould(t *testing.T) {
	for name, o := range map[string]PinterestOptions{
		"board name":      {BoardID: "Launch ideas"},
		"long title":      {BoardID: "1", Title: strings.Repeat("a", PinterestTitleLimit+1)},
		"no scheme":       {BoardID: "1", Link: "shots.example"},
		"javascript link": {BoardID: "1", Link: "javascript:alert(1)"},
		"credentials":     {BoardID: "1", Link: "https://user:pass@shots.example"},
		"padded link":     {BoardID: "1", Link: " https://shots.example"},
		"long link":       {BoardID: "1", Link: "https://shots.example/" + strings.Repeat("a", PinterestLinkLimit)},
	} {
		if err := o.Validate(true); err == nil {
			t.Fatalf("%s accepted", name)
		}
	}
	if err := ValidatePinterestOptions("facebook", &PinterestOptions{BoardID: "1"}, false); err == nil {
		t.Fatal("Pinterest settings accepted on another channel")
	}
}
