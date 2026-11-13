package postoptions

import (
	"encoding/json"
	"testing"
)

// A same-day wall-clock rule keeps days: 0, so the web can read it back;
// a duration rule stays without days.
func TestRetweetRuleJSONKeepsSameDay(t *testing.T) {
	data, err := json.Marshal(AutoActions{Retweets: []RetweetRule{
		{At: "02:16", TimeZone: "UTC"},
		{AfterMinutes: 60},
	}})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"retweets":[{"at":"02:16","timeZone":"UTC","days":0},{"afterMinutes":60}]}`
	if string(data) != want {
		t.Fatalf("got %s, want %s", data, want)
	}
	var back AutoActions
	if err := json.Unmarshal(data, &back); err != nil || back.Retweets[0] != (RetweetRule{At: "02:16", TimeZone: "UTC"}) {
		t.Fatalf("round trip: %+v %v", back, err)
	}
}
