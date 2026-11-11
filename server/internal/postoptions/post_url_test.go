package postoptions

import "testing"

// A live post's address: the provider's own link first, then one built from
// its id, and none when neither exists.
func TestPostURLPrefersTheProvidersLink(t *testing.T) {
	id := "urn:li:share:7"
	receipt := ThreadProgress{Publication: &PublicationReceipt{URL: "https://www.threads.net/@shots/post/1"}}
	if got := PostURL("threads", &id, receipt); got == nil || *got != "https://www.threads.net/@shots/post/1" {
		t.Fatalf("receipt link = %v", got)
	}
	if got := PostURL("linkedin", &id, ThreadProgress{}); got == nil || *got != "https://www.linkedin.com/feed/update/urn:li:share:7" {
		t.Fatalf("built link = %v", got)
	}
	if got := PostURL("instagram", &id, ThreadProgress{}); got != nil {
		t.Fatalf("an id that makes no link gave %v", *got)
	}
}
