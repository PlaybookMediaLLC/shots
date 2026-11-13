package autodm

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

func fixture() (Campaign, Recipient, time.Time) {
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	return Campaign{ID: "campaign", OrganizationID: "org", AccountID: "account", PostID: "123", PostText: "Reply guide and I will send you a DM", PublishedAt: now.Add(-time.Hour), Config: Config{Match: "all", Replies: true, Reposts: true, ReplyText: "guide", RequireFollow: true, Message: "Hi {{first_name}}, {{post_url}}"}}, Recipient{ID: "recipient", FirstName: "A", Replied: true, Reposted: true, Follows: true, ReplyText: "Guide please", ConsentPostID: "123", ConsentEvidenceID: "explicit-opt-in-event", ConsentAt: now.Add(-time.Minute)}, now
}
func TestEligibilityNeverInfersConsentAndStopsAtExpiryOrOptOut(t *testing.T) {
	c, r, now := fixture()
	if !Eligible(c, r, now) {
		t.Fatal("eligible consent refused")
	}
	for name, change := range map[string]func(*Campaign, *Recipient){
		"consent":      func(_ *Campaign, r *Recipient) { r.ConsentEvidenceID = "" },
		"other offer":  func(_ *Campaign, r *Recipient) { r.ConsentPostID = "999" },
		"opt out":      func(_ *Campaign, r *Recipient) { r.OptedOut = true },
		"removed":      func(c *Campaign, _ *Recipient) { c.SourceRemoved = true },
		"disabled":     func(c *Campaign, _ *Recipient) { c.Disabled = true },
		"no offer":     func(c *Campaign, _ *Recipient) { c.PostText = "Follow me" },
		"follow":       func(_ *Campaign, r *Recipient) { r.Follows = false },
		"all":          func(_ *Campaign, r *Recipient) { r.Reposted = false },
		"reply filter": func(_ *Campaign, r *Recipient) { r.ReplyText = "unrelated" },
	} {
		cc, rr := c, r
		change(&cc, &rr)
		if Eligible(cc, rr, now) {
			t.Errorf("accepted %s", name)
		}
	}
	if Eligible(c, r, c.PublishedAt.Add(Window)) {
		t.Fatal("accepted expired campaign")
	}
	c.Config.Match = "any"
	r.Reposted = false
	if !Eligible(c, r, now) {
		t.Fatal("any refused reply")
	}
}

func TestConfigRefusesUnknownVariablesAndEmptyMessages(t *testing.T) {
	c, _, _ := fixture()
	if err := c.Config.Validate(); err != nil {
		t.Fatalf("valid config refused: %v", err)
	}
	// Lengths count runes, as the web's zod schema counts code points: an emoji
	// counts once though it is two UTF-16 units.
	for name, accept := range map[string]func(*Config){
		"10,000 emoji": func(c *Config) { c.Message = strings.Repeat("😀", 10000) },
		"100 emoji":    func(c *Config) { c.ReplyText = strings.Repeat("😀", 100) },
	} {
		cc := c.Config
		accept(&cc)
		if err := cc.Validate(); err != nil {
			t.Errorf("refused %s: %v", name, err)
		}
	}
	for name, refuse := range map[string]func(*Config){
		"unknown variable":  func(c *Config) { c.Message = "Hi {{email}}" },
		"empty message":     func(c *Config) { c.Message = "" },
		"blank message":     func(c *Config) { c.Message = " \n\t" },
		"10,001 emoji":      func(c *Config) { c.Message = strings.Repeat("😀", 10001) },
		"101 emoji filter":  func(c *Config) { c.ReplyText = strings.Repeat("😀", 101) },
		"filter on reposts": func(c *Config) { c.Replies = false },
	} {
		cc := c.Config
		refuse(&cc)
		if cc.Validate() == nil {
			t.Errorf("accepted %s", name)
		}
	}
}

type testLedger struct {
	mu       sync.Mutex
	claims   map[string]bool
	statuses []string
}

func (l *testLedger) Claim(_ context.Context, c Campaign, r Recipient, _ time.Time, _ Limits) (bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	key := c.OrganizationID + "/" + c.AccountID + "/" + c.ID + "/" + r.ID
	if l.claims[key] {
		return false, nil
	}
	l.claims[key] = true
	return true, nil
}
func (l *testLedger) Complete(_ context.Context, _ Campaign, _ Recipient, _ string, status string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.statuses = append(l.statuses, status)
	return nil
}

type testSender struct {
	mu    sync.Mutex
	count int
	fail  bool
}

func (s *testSender) Send(context.Context, string, string, string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.count++
	if s.fail {
		return "", errors.New("timeout")
	}
	return "remote-id", nil
}
func TestDeliveryGateConcurrentDedupeAndUnknownOutcome(t *testing.T) {
	c, r, now := fixture()
	l := &testLedger{claims: map[string]bool{}}
	s := &testSender{}
	if err := Deliver(context.Background(), c, r, now, false, ProductLimits, l, s); !errors.Is(err, ErrUnavailable) || s.count != 0 {
		t.Fatal("gate bypassed")
	}
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := Deliver(context.Background(), c, r, now, true, ProductLimits, l, s); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if s.count != 1 || len(l.statuses) != 1 || l.statuses[0] != "sent" {
		t.Fatalf("count=%d statuses=%v", s.count, l.statuses)
	}
	c.ID = "another"
	s.fail = true
	if Deliver(context.Background(), c, r, now, true, ProductLimits, l, s) == nil {
		t.Fatal("unknown send not surfaced")
	}
	if err := Deliver(context.Background(), c, r, now, true, ProductLimits, l, s); err != nil || s.count != 2 || l.statuses[1] != "unknown" {
		t.Fatal("uncertain send retried")
	}
}
