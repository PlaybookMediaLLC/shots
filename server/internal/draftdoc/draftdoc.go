// Package draftdoc holds the structured parts of a content draft that Go
// stores and checks (RFC 025): its platform versions and their options, the
// post it replies to or quotes, and an article's title and cover. A leaf
// package, so the ent schema can use its types.
package draftdoc

import "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
import "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/autodm"

// SchemaVersion is the platform versions document this backend writes.
const SchemaVersion = 1

// Platform version modes.
const (
	// ModeSynced versions have no text of their own: they are serialized
	// from the primary body each time, so the primary never overwrites them.
	ModeSynced = "synced"
	// ModeManual versions keep their own body, which primary edits leave alone.
	ModeManual = "manual"
)

// PlatformVersions is every platform version of a draft beside its primary.
type PlatformVersions struct {
	SchemaVersion int               `json:"schemaVersion"`
	Versions      []PlatformVersion `json:"versions"`
}

// PlatformVersion is one channel's version of the draft.
type PlatformVersion struct {
	Channel string `json:"channel"`
	Mode    string `json:"mode"`
	// Body is the version's own Plate value, for a manual version only.
	Body []any `json:"body,omitempty"`
	// ForkedFromVersion is the draft version the manual body was copied at.
	ForkedFromVersion int `json:"forkedFromVersion,omitempty"`
	// SourceHash identifies the primary's text when the body was copied,
	// so the composer can say the primary has changed since.
	SourceHash string          `json:"sourceHash,omitempty"`
	Options    *VersionOptions `json:"options,omitempty"`
}

// VersionOptions are a platform version's settings. Each field belongs to
// the platforms that support it; the backend refuses it anywhere else.
type VersionOptions struct {
	YouTube *postoptions.YouTubeOptions `json:"youtube,omitempty"`
	TikTok  *postoptions.TikTokOptions  `json:"tiktok,omitempty"`
	// Instagram: collaborators, tags, and a reel's cover, grid and trial.
	Instagram *postoptions.InstagramOptions `json:"instagram,omitempty"`
	// Pinterest: the pin's board, title and link.
	Pinterest    *postoptions.PinterestOptions `json:"pinterest,omitempty"`
	LinkPreviews []postoptions.LinkPreview     `json:"linkPreviews,omitempty"`
	AutoDM       *autodm.Config                `json:"autoDm,omitempty"`
	// Preferred length when making a thread; publication still checks account limits.
	SplitLimit   int  `json:"splitLimit,omitempty"`
	SplitOnPaste bool `json:"splitOnPaste,omitempty"`
	// X: post to a community instead of the timeline.
	Community *Community `json:"community,omitempty"`
	// X: number a thread's posts when it is serialized.
	Numbering *Numbering `json:"numbering,omitempty"`
	// LinkedIn: who can see the post, PUBLIC or CONNECTIONS.
	Visibility string `json:"visibility,omitempty"`
	// LinkedIn: a comment posted under the post once it is live.
	FirstComment string `json:"firstComment,omitempty"`
	// LinkedIn: a PDF document shown as a carousel.
	Document *Document `json:"document,omitempty"`
	// X: follow-ups once the post is live (Auto-RT, Auto-Plug).
	Automation *postoptions.AutoActions `json:"automation,omitempty"`
}

// Community is an X community and whether the post is also shown to followers.
type Community struct {
	ID                 string `json:"id"`
	Name               string `json:"name,omitempty"`
	ShareWithFollowers *bool  `json:"shareWithFollowers,omitempty"`
}

// NumberingStyles are the numbering formats: #1, 1️⃣, 1., 1/, /1, 1/9, 1 of 9.
var NumberingStyles = []string{"hash", "emoji", "dot", "slash", "leading", "fraction", "of"}

// NumberingPositions put the number before or after a post's text.
var NumberingPositions = []string{"start", "end"}

// Numbering numbers a thread's posts when serialized; the text never holds it.
type Numbering struct {
	Enabled   bool   `json:"enabled"`
	Position  string `json:"position"`
	Style     string `json:"style"`
	SkipFirst int    `json:"skipFirst,omitempty"`
	SkipLast  int    `json:"skipLast,omitempty"`
}

// Document is a PDF workspace asset posted as a LinkedIn document.
type Document struct {
	AssetID string `json:"assetId"`
	Title   string `json:"title,omitempty"`
}

// Target kinds.
const (
	TargetReply     = "reply"
	TargetQuote     = "quote"
	TargetRepurpose = "repurpose"
)

// Target is the post a reply answers, a quote embeds, or a repurposed draft
// came from. It is stored as data, never inferred from a URL in the text.
type Target struct {
	Kind     string `json:"kind"`
	Platform string `json:"platform,omitempty"`
	URL      string `json:"url,omitempty"`
	// RemoteID is the post's id on its platform.
	RemoteID string `json:"remoteId,omitempty"`
	// For a repurposed draft: the draft and post it came from.
	SourceDraftID string `json:"sourceDraftId,omitempty"`
	SourcePostID  string `json:"sourcePostId,omitempty"`
	// What the composer shows of the target: author and text, as read.
	Author string `json:"author,omitempty"`
	Text   string `json:"text,omitempty"`
}

// Article is an X article's title and cover; its body is the draft's body.
type Article struct {
	Title        string `json:"title"`
	CoverAssetID string `json:"coverAssetId,omitempty"`
}
