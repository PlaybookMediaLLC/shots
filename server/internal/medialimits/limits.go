// Package medialimits shares upload ceilings with the web. Provider limits are
// checked separately; a Shots subscription never grants a social entitlement.
package medialimits

import (
	_ "embed"
	"encoding/json"
	"strings"
)

//go:embed limits.json
var document []byte

// ImageProfile defines persisted static-image derivatives; MaxEdge is the
// application's conservative processing size, not an account entitlement.
type ImageProfile struct {
	MaxBytes int      `json:"maxBytes"`
	MaxEdge  int      `json:"maxEdge"`
	Formats  []string `json:"formats"`
}

// VideoRules are a destination's published video limits. Zero means unbounded
// by Shots; the account or the provider may still refuse.
type VideoRules struct {
	Formats  []string `json:"formats"`
	Alone    bool     `json:"alone"`
	MinMs    int      `json:"minMs"`
	MaxMs    int      `json:"maxMs"`
	MaxBytes int      `json:"maxBytes"`
	// Accounts holds the provider's own limits per verified account tier;
	// MaxBytes above stays Shots' upload ceiling.
	Accounts struct {
		Standard AccountVideo `json:"standard"`
		Premium  AccountVideo `json:"premium"`
	} `json:"accounts"`
}

// AccountVideo is one account tier's video limit at the provider. Stored X
// capability snapshots must match it exactly (socialidentity XCapabilities.Validate),
// so changing a value sends every connected X account back through reconnect.
type AccountVideo struct {
	MaxMs    int   `json:"maxMs"`
	MaxBytes int64 `json:"maxBytes"`
}

// CoverRules are the images a destination takes as a video's cover.
type CoverRules struct {
	Formats  []string `json:"formats"`
	MaxBytes int      `json:"maxBytes"`
}

// Destination is one draft channel's media rules, shared with the composer
// (lib/write/capabilities.ts). Docs and VerifiedOn record where each number was
// read. Account-specific limits are checked separately.
type Destination struct {
	MaxMedia      int  `json:"maxMedia"`
	RequiresMedia bool `json:"requiresMedia"`
	// Mixed allows images and videos in one post (a carousel).
	Mixed  bool     `json:"mixed"`
	Images []string `json:"images"`
	// Converts names the formats Shots sends as another (Instagram takes JPEG only).
	Converts      map[string]string `json:"converts"`
	ImageMaxBytes int               `json:"imageMaxBytes"`
	MinImageWidth int               `json:"minImageWidth"`
	Aspect        *struct {
		Min float64 `json:"min"`
		Max float64 `json:"max"`
	} `json:"aspect"`
	GIF *struct {
		Alone    bool `json:"alone"`
		MaxBytes int  `json:"maxBytes"`
	} `json:"gif"`
	Video *VideoRules `json:"video"`
	// Cover is the image a video post takes as its cover or thumbnail.
	Cover *CoverRules `json:"cover"`
	// Story is what one story takes, where the destination has stories.
	Story      *Destination `json:"story"`
	Docs       []string     `json:"docs"`
	VerifiedOn string       `json:"verifiedOn"`
}

var Limits struct {
	Destinations   map[string]Destination  `json:"destinations"`
	ImageProfiles  map[string]ImageProfile `json:"imageProfiles"`
	FreeImageBytes int                     `json:"freeImageBytes"`
	PaidImageBytes int                     `json:"paidImageBytes"`
	VideoBytes     int                     `json:"videoBytes"`
	PDFBytes       int                     `json:"pdfBytes"`
	OtherBytes     int                     `json:"otherBytes"`
	ImagePixels    int                     `json:"imagePixels"`
	PDFPages       int                     `json:"pdfPages"`
}

func init() {
	if err := json.Unmarshal(document, &Limits); err != nil {
		panic(err)
	}
}

// UploadBytes is the ingestion ceiling, independent of publication eligibility.
func UploadBytes(mime, plan string) int {
	if strings.HasPrefix(mime, "image/") {
		if plan == "pro" || plan == "business" || plan == "enterprise" {
			return Limits.PaidImageBytes
		}
		return Limits.FreeImageBytes
	}
	if strings.HasPrefix(mime, "video/") {
		return Limits.VideoBytes
	}
	if mime == "application/pdf" {
		return Limits.PDFBytes
	}
	return Limits.OtherBytes
}
