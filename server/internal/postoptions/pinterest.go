package postoptions

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"
)

// PinterestOptions are a pin's settings beyond its description, sent as the
// Pins API's board_id, title and link.
type PinterestOptions struct {
	// BoardID is one of the account's boards, from its boards list.
	BoardID string `json:"boardId,omitempty"`
	Title   string `json:"title,omitempty"`
	// Link is the page the pin leads to.
	Link string `json:"link,omitempty"`
}

// Pinterest's documented limits (POST /v5/pins).
const (
	PinterestTitleLimit = 100
	PinterestLinkLimit  = 2048
)

var pinterestBoardID = regexp.MustCompile(`^[0-9]{1,30}$`)

// Validate checks the settings on their own. Complete is scheduling, where a
// pin needs its board; a draft being written may not have one yet.
func (o *PinterestOptions) Validate(complete bool) error {
	if o == nil {
		if complete {
			return fmt.Errorf("choose the Pinterest board to save the pin to")
		}
		return nil
	}
	switch {
	case o.BoardID == "" && complete:
		return fmt.Errorf("choose the Pinterest board to save the pin to")
	case o.BoardID != "" && !pinterestBoardID.MatchString(o.BoardID):
		return fmt.Errorf("a Pinterest board is one of the account's boards, by its numeric id")
	case utf8.RuneCountInString(o.Title) > PinterestTitleLimit:
		return fmt.Errorf("keep the pin's title to %d characters", PinterestTitleLimit)
	case o.Link != "" && !pinterestLink(o.Link):
		return fmt.Errorf("a pin's link is a web address of up to %d characters, starting with https:// or http://", PinterestLinkLimit)
	}
	return nil
}

func pinterestLink(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && len(raw) <= PinterestLinkLimit && strings.TrimSpace(raw) == raw &&
		(u.Scheme == "https" || u.Scheme == "http") && u.Host != "" && u.User == nil
}

// ValidatePinterestOptions checks Pinterest settings belong to a pin and hold
// on their own; a pin always needs its board when it is scheduled.
func ValidatePinterestOptions(channel string, o *PinterestOptions, complete bool) error {
	if channel != "pinterest" {
		if o != nil {
			return fmt.Errorf("boards, pin titles and pin links are Pinterest settings")
		}
		return nil
	}
	return o.Validate(complete)
}
