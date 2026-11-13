package product

import (
	"encoding/json"
	"fmt"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/draftdoc"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
)

// Checks for the structured parts of a draft (RFC 025): its platform
// versions and their options, its target, its article. Pure functions, so
// the rules are tested without a database.

const (
	contentDraftScratchpadLimit = 20_000
	contentDraftTagLimit        = 20
	articleTitleLimit           = 200
	firstCommentLimit           = 1250
	linkedInDocumentTitleLimit  = 200
	xCommunityIDPattern         = `^[0-9]{1,30}$`
)

var (
	xCommunityID = regexp.MustCompile(xCommunityIDPattern)
	// x.com/<handle>/status/<id> and its twitter.com form.
	xStatusURL = regexp.MustCompile(`^https://(?:www\.|mobile\.)?(?:x|twitter)\.com/(?:[A-Za-z0-9_]{1,15}|i(?:/web)?)/status/([0-9]{1,30})(?:[/?#].*)?$`)
	// A LinkedIn post: its feed URL or a share, post or activity URN.
	linkedInFeedPath  = regexp.MustCompile(`^/feed/update/(urn:li:(?:share|ugcPost|activity):[0-9]{1,30})/?$`)
	linkedInSharePath = regexp.MustCompile(`^/posts/[A-Za-z0-9_-]+-activity-([0-9]{1,30})(?:-[A-Za-z0-9_-]+)?/?$`)
	// The kinds of draft and the channels each can be written for.
	draftKindChannels = map[string][]string{
		"standard": {"x", "linkedin", "instagram", "threads", "bluesky", "mastodon", "tiktok", "youtube"},
		"reply":    {"x"},
		"quote":    {"x", "linkedin", "bluesky", "mastodon"},
		// A repurposed draft is a new post made from a published one.
		"repurpose": {"x", "linkedin", "instagram", "threads", "bluesky", "mastodon"},
		"article":   {"x"},
	}
)

// draftKindChannel checks that a kind can be written for its primary channel.
func draftKindChannel(kind, channel string) error {
	channels, ok := draftKindChannels[kind]
	if !ok {
		return invalid("A draft is a standard post, a reply, a quote, a repurposed post, or an article.")
	}
	if !slices.Contains(channels, channel) {
		return invalid(fmt.Sprintf("A %s draft is written for %s, not %s.", kind, strings.Join(channels, " or "), channel))
	}
	return nil
}

// draftTarget checks the target a kind needs: a reply or quote names the
// post by URL, from which its id is read; a repurposed draft names its source.
func draftTarget(kind string, target *draftdoc.Target) (*draftdoc.Target, error) {
	switch kind {
	case "standard", "article":
		if target != nil {
			return nil, invalid("Only a reply, a quote or a repurposed draft has a target.")
		}
		return nil, nil
	case "repurpose":
		if target == nil || target.SourceDraftID == "" && target.URL == "" {
			return nil, invalid("A repurposed draft names the published post it comes from.")
		}
		if target.SourceDraftID != "" && !contentDraftRefPattern.MatchString(target.SourceDraftID) ||
			target.SourcePostID != "" && !contentDraftRefPattern.MatchString(target.SourcePostID) {
			return nil, invalid("The source must be a draft and post of this workspace.")
		}
	case "reply", "quote":
		if target == nil || strings.TrimSpace(target.URL) == "" {
			return nil, invalid(fmt.Sprintf("A %s names the post it answers by its URL.", kind))
		}
	}
	clean := *target
	clean.Kind = kind
	clean.URL = strings.TrimSpace(clean.URL)
	if utf8.RuneCountInString(clean.Text) > 1000 || utf8.RuneCountInString(clean.Author) > 200 {
		return nil, invalid("Keep the target's preview under 1,000 characters.")
	}
	if clean.URL == "" {
		return &clean, nil
	}
	if len(clean.URL) > 2048 {
		return nil, invalid("The post's URL is too long.")
	}
	if match := xStatusURL.FindStringSubmatch(clean.URL); match != nil {
		clean.Platform, clean.RemoteID = "x", match[1]
		return &clean, nil
	}
	if parsed, err := url.Parse(clean.URL); err == nil && parsed.Scheme == "https" &&
		(parsed.Host == "www.linkedin.com" || parsed.Host == "linkedin.com") {
		unescaped, _ := url.PathUnescape(parsed.EscapedPath())
		if match := linkedInFeedPath.FindStringSubmatch(unescaped); match != nil {
			clean.Platform, clean.RemoteID = "linkedin", match[1]
			return &clean, nil
		}
		if match := linkedInSharePath.FindStringSubmatch(unescaped); match != nil {
			clean.Platform, clean.RemoteID = "linkedin", "urn:li:activity:"+match[1]
			return &clean, nil
		}
	}
	if socialidentity.MastodonStatusURL(clean.URL) {
		clean.Platform, clean.RemoteID = "mastodon", clean.URL
		return &clean, nil
	}
	if uri, err := socialidentity.BlueskyPostURI(clean.URL); err == nil {
		clean.Platform, clean.RemoteID = "bluesky", uri
		return &clean, nil
	}
	if kind == "repurpose" {
		// A repurposed post may come from anywhere; it is only a reference.
		if parsed, err := url.Parse(clean.URL); err != nil || parsed.Scheme != "https" || parsed.Host == "" {
			return nil, invalid("Use the published post's https URL.")
		}
		return &clean, nil
	}
	return nil, invalid("Use the URL of an X post (x.com/…/status/…) a LinkedIn post, a Bluesky post, or a Mastodon post.")
}

// draftTargetChannel checks a reply or quote target suits the draft's channel:
// a reply answers an X post; a quote quotes an X post on X or reshares a
// LinkedIn post on LinkedIn.
func draftTargetChannel(kind, channel string, target *draftdoc.Target) error {
	if target == nil || kind != "reply" && kind != "quote" {
		return nil
	}
	if target.Platform != channel {
		return invalid(fmt.Sprintf("A %s on %s answers a %s post.", kind, channel, channel))
	}
	return nil
}

// draftArticle checks an article's title; only an article draft has one.
func draftArticle(kind string, article *draftdoc.Article) (*draftdoc.Article, error) {
	if kind != "article" {
		if article != nil {
			return nil, invalid("Only an article draft has an article title.")
		}
		return nil, nil
	}
	if article == nil {
		return &draftdoc.Article{}, nil
	}
	clean := *article
	clean.Title = strings.TrimSpace(clean.Title)
	if utf8.RuneCountInString(clean.Title) > articleTitleLimit {
		return nil, invalid(fmt.Sprintf("Keep the article title under %d characters.", articleTitleLimit))
	}
	if clean.CoverAssetID != "" && !contentDraftRefPattern.MatchString(clean.CoverAssetID) {
		return nil, invalid("The cover must be a workspace asset.")
	}
	return &clean, nil
}

// draftPlatformVersions checks a platform versions document: the schema
// version this backend writes, one entry per draft channel other than the
// primary, a synced entry without a body and a manual one with a body
// within the draft's size, and options the channel supports.
func draftPlatformVersions(doc draftdoc.PlatformVersions, primary string) (draftdoc.PlatformVersions, error) {
	if doc.SchemaVersion == 0 && len(doc.Versions) == 0 {
		return draftdoc.PlatformVersions{SchemaVersion: draftdoc.SchemaVersion, Versions: []draftdoc.PlatformVersion{}}, nil
	}
	if doc.SchemaVersion != draftdoc.SchemaVersion {
		return doc, invalid(fmt.Sprintf("This server reads platform versions schema %d; reload to get the current composer.", draftdoc.SchemaVersion))
	}
	seen := map[string]bool{}
	out := draftdoc.PlatformVersions{SchemaVersion: draftdoc.SchemaVersion, Versions: []draftdoc.PlatformVersion{}}
	for _, version := range doc.Versions {
		if _, ok := draftChannelLimits[version.Channel]; !ok {
			return doc, invalid("A platform version is for a draft channel: x, linkedin, instagram, threads, bluesky or mastodon.")
		}
		if seen[version.Channel] {
			return doc, invalid("A draft has one version per platform; " + version.Channel + " appears twice.")
		}
		seen[version.Channel] = true
		switch version.Mode {
		case draftdoc.ModeSynced:
			if len(version.Body) > 0 {
				return doc, invalid("A synced version has no text of its own; switch it to manual to edit it.")
			}
			version.Body, version.ForkedFromVersion, version.SourceHash = nil, 0, ""
		case draftdoc.ModeManual:
			if version.Channel == primary {
				return doc, invalid("The primary platform's version is the draft's body.")
			}
			body, err := contentDraftBody(version.Body)
			if err != nil {
				return doc, err
			}
			version.Body = body
			if version.ForkedFromVersion < 0 || len(version.SourceHash) > 128 {
				return doc, invalid("A manual version's source is a draft version and a hash.")
			}
		default:
			return doc, invalid("A platform version is synced or manual.")
		}
		options, err := versionOptions(version.Channel, version.Options)
		if err != nil {
			return doc, err
		}
		version.Options = options
		out.Versions = append(out.Versions, version)
	}
	encoded, err := json.Marshal(out)
	if err != nil || len(encoded) > 2*contentDraftBodyLimit {
		return doc, invalid("Keep the draft's platform versions under 2 MB.")
	}
	return out, nil
}

// versionOptions checks a version's options against what its channel takes.
func versionOptions(channel string, options *draftdoc.VersionOptions) (*draftdoc.VersionOptions, error) {
	if options != nil && options.SplitLimit != 0 && (options.SplitLimit < 25 || options.SplitLimit > 25000) {
		return nil, invalid("Choose a post length from 25 to 25,000.")
	}
	if options == nil {
		return nil, nil
	}
	clean := *options
	if err := postoptions.ValidateVideoOptions(channel, clean.YouTube, clean.TikTok, false); err != nil {
		return nil, invalid(err.Error())
	}
	if clean.Instagram != nil {
		if channel != "instagram" {
			return nil, invalid("Collaborators, tags, covers and trial reels are Instagram settings.")
		}
		if err := clean.Instagram.Validate(); err != nil {
			return nil, invalid(err.Error())
		}
	}
	if len(clean.LinkPreviews) > 25 {
		return nil, invalid("A draft can store at most 25 link previews.")
	}
	for _, preview := range clean.LinkPreviews {
		if err := preview.Validate(); err != nil {
			return nil, invalid(err.Error())
		}
	}
	if clean.AutoDM != nil {
		if channel != "x" {
			return nil, invalid("Auto-DM settings belong to X.")
		}
		if err := clean.AutoDM.Validate(); err != nil {
			return nil, invalid(err.Error())
		}
	}
	if clean.Community != nil {
		if channel != "x" {
			return nil, invalid("Communities are for X posts.")
		}
		if !xCommunityID.MatchString(clean.Community.ID) || utf8.RuneCountInString(clean.Community.Name) > 200 {
			return nil, invalid("Pick an X community by its numeric id.")
		}
	}
	if clean.Numbering != nil {
		if channel != "x" && channel != "threads" && channel != "bluesky" && channel != "mastodon" {
			return nil, invalid("Numbering is for platforms that post threads.")
		}
		numbering := *clean.Numbering
		if !slices.Contains(draftdoc.NumberingStyles, numbering.Style) || !slices.Contains(draftdoc.NumberingPositions, numbering.Position) {
			return nil, invalid("Number posts at the start or end, as #1, 1️⃣, 1., 1/, /1, 1/9 or 1 of 9.")
		}
		if numbering.SkipFirst < 0 || numbering.SkipLast < 0 || numbering.SkipFirst > contentDraftReplyLimit || numbering.SkipLast > contentDraftReplyLimit {
			return nil, invalid("Skip between 0 and 24 posts at either end.")
		}
	}
	if clean.Visibility != "" {
		if channel != "linkedin" {
			return nil, invalid("Visibility is a LinkedIn setting.")
		}
		if clean.Visibility != "PUBLIC" && clean.Visibility != "CONNECTIONS" {
			return nil, invalid("A LinkedIn post is visible to anyone (PUBLIC) or connections (CONNECTIONS).")
		}
	}
	clean.FirstComment = strings.TrimSpace(clean.FirstComment)
	if clean.FirstComment != "" {
		if channel != "linkedin" && channel != "instagram" {
			return nil, invalid("First comments are for LinkedIn and Instagram posts.")
		}
		if utf8.RuneCountInString(clean.FirstComment) > firstCommentLimit {
			return nil, invalid(fmt.Sprintf("Keep the first comment under %d characters.", firstCommentLimit))
		}
	}
	if clean.Document != nil {
		if channel != "linkedin" {
			return nil, invalid("PDF documents are for LinkedIn posts.")
		}
		if !contentDraftRefPattern.MatchString(clean.Document.AssetID) || utf8.RuneCountInString(clean.Document.Title) > linkedInDocumentTitleLimit {
			return nil, invalid("A document is an uploaded PDF of this workspace, with a title under 200 characters.")
		}
	}
	if clean.Automation != nil {
		if err := checkDraftExtras(channel, ContentDraftScheduleTarget{AutoActions: clean.Automation}); err != nil {
			return nil, err
		}
	}
	return &clean, nil
}

// versionDocumentAssets lists the assets a draft's versions refer to, so the
// backend can check they are the workspace's.
func versionDocumentAssets(doc draftdoc.PlatformVersions) []string {
	ids := []string{}
	for _, version := range doc.Versions {
		if version.Options != nil && version.Options.Document != nil {
			ids = append(ids, version.Options.Document.AssetID)
		}
		if version.Options != nil {
			if id := postoptions.CoverAsset(version.Options.YouTube, version.Options.Instagram); id != "" {
				ids = append(ids, id)
			}
		}
	}
	return ids
}

// draftScratchpad checks the internal notes kept beside a draft.
func draftScratchpad(text string) (string, error) {
	if utf8.RuneCountInString(text) > contentDraftScratchpadLimit {
		return "", invalid("Keep the scratchpad under 20,000 characters.")
	}
	return text, nil
}
