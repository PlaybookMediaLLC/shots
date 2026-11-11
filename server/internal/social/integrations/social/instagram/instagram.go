// Package instagram is the Instagram provider: Instagram business accounts
// linked to a Facebook page, published through the Graph API with media
// containers (pending -> ready -> finalize), plus comments, insights and the
// Reel audio search. The instagram-standalone provider reuses it with the
// graph.instagram.com host (the *On methods).
package instagram

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/helpers"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ids"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations/social/facebook"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
)

// FacebookHost is the default graph host (Facebook Login).
const FacebookHost = "graph.facebook.com"

// origin turns a graph host into a URL origin; tests point it at an
// httptest server.
var origin = func(host string) string { return "https://" + host }

func graph(host string) string { return origin(host) + "/" + facebook.MetaGraphAPIVersion }

const Rules = "Instagram should have at least one attachment, if it's a story, it can have only one picture"

var scopes = []string{
	"instagram_basic",
	"pages_show_list",
	"pages_read_engagement",
	"business_management",
	"instagram_content_publish",
	"instagram_manage_comments",
	"instagram_manage_insights",
}

var _ interface {
	integrations.Provider
	integrations.PendingPoster
	integrations.Commenter
	integrations.Reconnector
	integrations.Analytics
	integrations.PostAnalytics
	integrations.PageInformationFetcher
} = (*Provider)(nil)

type Provider struct {
	*integrations.Base
}

func New() *Provider {
	return &Provider{Base: integrations.NewBase("instagram", HandleErrors)}
}

func (p *Provider) Info() integrations.Info {
	return integrations.Info{
		Identifier:       "instagram",
		Name:             "Instagram\n(Facebook Business)",
		Editor:           "normal",
		Scopes:           scopes,
		IsBetweenSteps:   true,
		ToolTip:          "Instagram must be business and connected to a Facebook page",
		MaxConcurrentJob: 400,
		ConvertToJPEG:    true,
		Rules:            Rules,
	}
}

func (p *Provider) MaxLength([]integrations.AdditionalSetting, json.RawMessage) int { return 2200 }

func (p *Provider) SettingsDTO() any { return &InstagramDTO{} }

func (p *Provider) Functions() map[string]integrations.Function {
	return map[string]integrations.Function{
		"pages": func(ctx context.Context, token string, _ json.RawMessage, _ string, _ *ent.Integration) (any, error) {
			return p.Pages(ctx, token)
		},
		"fetchPageInformation": func(ctx context.Context, token string, data json.RawMessage, _ string, _ *ent.Integration) (any, error) {
			return p.FetchPageInformation(ctx, token, data)
		},
		"music": func(ctx context.Context, token string, data json.RawMessage, _ string, _ *ent.Integration) (any, error) {
			return p.Music(ctx, token, data)
		},
		"audioSearch": func(ctx context.Context, token string, data json.RawMessage, internalID string, _ *ent.Integration) (any, error) {
			return p.AudioSearch(ctx, token, data, internalID)
		},
	}
}

func (p *Provider) Tools() []integrations.Tool {
	return []integrations.Tool{{
		MethodName:  "audioSearch",
		Description: `Search audio (music or original sounds) to attach to a Reel via the "audio" setting, an empty query returns trending audio`,
		DataSchema: []integrations.ToolField{
			{Key: "q", Type: "string", Description: "Search query, leave empty for trending audio"},
			{Key: "type", Type: "string", Description: `Either "music" or "original_sound", defaults to "music"`},
		},
	}}
}

// SettingsOf decodes a post's settings leniently (they are free-form JSON).
func SettingsOf(raw json.RawMessage) InstagramDTO {
	var s InstagramDTO
	_ = json.Unmarshal(raw, &s)
	return s
}

func (s InstagramDTO) isStory() bool { return s.PostType != nil && *s.PostType == "story" }

// HasVideo is `firstPost.some(f => f.path.indexOf('mp4') > -1)`.
func HasVideo(media []integrations.ValidityMedia) bool {
	for _, f := range media {
		if strings.Contains(f.Path, "mp4") {
			return true
		}
	}
	return false
}

func (p *Provider) CheckValidity(_ context.Context, posts [][]integrations.ValidityMedia, raw json.RawMessage, _ []integrations.AdditionalSetting) (string, error) {
	var firstPost []integrations.ValidityMedia
	if len(posts) > 0 {
		firstPost = posts[0]
	}
	settings := SettingsOf(raw)
	if len(firstPost) == 0 {
		return "Should have at least one media", nil
	}
	if len(firstPost) > 10 {
		return "Instagram carousel only supports up to 10 media attachments", nil
	}
	if integrations.AssetBoolean(settings.IsTrialReel) {
		if len(firstPost) > 1 {
			return "Trial Reels can only have one video", nil
		}
		if !HasVideo(firstPost) {
			return "Trial Reels must be a video", nil
		}
	}
	if settings.Audio != nil && settings.Audio.ID != nil && *settings.Audio.ID != "" {
		if settings.isStory() {
			return "Audio can only be added to Reels, not to Stories", nil
		}
		if len(firstPost) > 1 {
			return "Audio can only be added to a single video Reel", nil
		}
		if !HasVideo(firstPost) {
			return "Audio can only be added to a video Reel", nil
		}
	}
	return "", nil
}

func (p *Provider) RefreshToken(context.Context, string) (*integrations.AuthTokenDetails, error) {
	return &integrations.AuthTokenDetails{}, nil
}

// HandleErrors is InstagramProvider.handleErrors (the standalone provider
// uses it too).
func HandleErrors(body string, status int) *integrations.HandledError {
	has := func(s string) bool { return strings.Contains(body, s) }
	lower := strings.ToLower(body)
	h := func(kind, value string) *integrations.HandledError {
		return &integrations.HandledError{Type: kind, Value: value}
	}
	switch {
	case has("An unknown error occurred"):
		return h("retry", "An unknown error occurred, please try again later")
	case has("2207081"):
		return h("bad-body", "This account doesn't support Trial Reels")
	case has("2207078"):
		return h("bad-body", "Instagram Trial Reel publish limit reached for this account, please try again later or publish the post as a regular Reel")
	case has("REVOKED_ACCESS_TOKEN") || has(`"error_subcode":33`):
		return h("refresh-token", "Something is wrong with your connected user, please re-authenticate")
	case strings.Contains(lower, "the user is not an instagram business"):
		return h("refresh-token", "Your Instagram account is not a business account, please convert it to a business account")
	case strings.Contains(lower, "session has been invalidated"):
		return h("refresh-token", "You session has been invalidated, this can usually happen from frequent posting, please re-authenticate, and wait 1-2 days before posting again")
	case has("2207050"):
		return h("bad-body", "Instagram user is restricted")
	// Media download/upload errors
	case has("2207003"):
		return h("bad-body", "Timeout downloading media, please try again")
	case has("2207020"):
		return h("bad-body", "Media expired, please upload again")
	case has("2207032"):
		return h("bad-body", "Failed to create media, please try again")
	case has("2207053"):
		return h("bad-body", "Unknown upload error, please try again")
	case has("2207052"):
		return h("bad-body", "Media fetch failed, please try again")
	case has("2207057"):
		return h("bad-body", "Invalid thumbnail offset for video")
	case has("2207026"):
		return h("bad-body", "Unsupported video format")
	case has("2207023"):
		return h("bad-body", "Unknown media type")
	case has("2207006"):
		return h("bad-body", "Media not found, please upload again")
	case has("2207008"):
		return h("bad-body", "Media builder expired, please try again")
	// Content validation errors
	case has("2207028"):
		return h("bad-body", "Carousel validation failed")
	case has("2207010"):
		return h("bad-body", "Caption is too long")
	// Product tagging errors
	case has("2207035"):
		return h("bad-body", "Product tag positions not supported for videos")
	case has("2207036"):
		return h("bad-body", "Product tag positions required for photos")
	case has("2207037"):
		return h("bad-body", "Product tag validation failed")
	case has("2207040"):
		return h("bad-body", "Too many product tags")
	// Image format/size errors
	case has("2207004"):
		return h("bad-body", "Image is too large")
	case has("2207005"):
		return h("bad-body", "Unsupported image format")
	case has("2207009"):
		return h("bad-body", "Aspect ratio not supported, must be between 4:5 to 1.91:1")
	case has("Page request limit reached"):
		return h("limit", "Page posting for today is limited, please try again tomorrow")
	case has("2207042"):
		return h("limit", "You have reached the maximum of 25 posts per day, allowed for your account")
	case has("(#200)"):
		return h("bad-body", "Facebook rejected the post due to missing permissions. Make sure your Facebook account has full content access to the Page linked to this Instagram account, then reconnect the channel.")
	case has("Not enough permissions to post"):
		return h("bad-body", "Not enough permissions to post")
	case has("36003"):
		return h("bad-body", "Aspect ratio not supported, must be between 4:5 to 1.91:1")
	// Meta put the account behind a checkpoint: the token is still valid, so a
	// refresh cannot help and every post fails until the user logs in on
	// Instagram and re-connects the channel.
	case has("You cannot access the app till you log in to") || has("Session key is malformed"):
		return h("disconnect", "Instagram requires you to log in at instagram.com and follow its instructions before posting can resume. After that, please reconnect this channel.")
	case has("190,"):
		return h("bad-body", "The account is missing some permissions to perform this action, please re-add the account and allow all permissions")
	case has("36001"):
		return h("bad-body", "Invalid Instagram image resolution max: 1920x1080px")
	case has("2207051"):
		return h("bad-body", "Instagram blocked your request")
	case has("2207001"):
		return h("bad-body", "Instagram detected that your post is spam, please try again with different content")
	case has("2207082"):
		return h("retry", "Instagram could not process this video. If you attached audio to a video that has no sound track, set the original video volume to 0 and try again")
	case has("2207085"):
		return h("bad-body", "Instagram could not process the video, please check the video format, duration and resolution and try again")
	case has("2207077"):
		return h("bad-body", "Instagram Video download failed")
	case has("too little or too many attachments"):
		return h("bad-body", "Instagram carousel should have between 2 and 10 media attachments")
	case has("2207027"):
		return h("bad-body", "Unknown error, please try again later or contact support")
	case has("param collaborators is not allowed"):
		return h("bad-body", "Collaborators are not allowed for carousel")
	}
	return nil
}

// splitToken splits the stored "pageToken___userToken".
func splitToken(token string) (accessToken, userToken string) {
	parts := strings.Split(token, "___")
	accessToken = parts[0]
	if len(parts) > 1 {
		userToken = parts[1]
	}
	return accessToken, userToken
}

func (p *Provider) ReConnect(ctx context.Context, id, requiredID, token string) (*integrations.AuthTokenDetails, error) {
	accessToken, _ := splitToken(token)
	pages, err := p.Pages(ctx, accessToken)
	if err != nil {
		return nil, err
	}
	pageID := ""
	for _, page := range pages {
		if page.ID == requiredID {
			pageID = page.PageID
			break
		}
	}
	data, _ := json.Marshal(map[string]string{"id": requiredID, "pageId": pageID})
	information, err := p.FetchPageInformation(ctx, accessToken, data)
	if err != nil {
		return nil, err
	}
	return &integrations.AuthTokenDetails{
		ID:          information.ID,
		Name:        information.Name,
		AccessToken: information.AccessToken,
		Picture:     information.Picture,
		Username:    information.Username,
	}, nil
}

func (p *Provider) GenerateAuthURL(context.Context, *integrations.ClientInformation) (*integrations.GenerateAuthURLResponse, error) {
	state := ids.Secure(6)
	return &integrations.GenerateAuthURLResponse{
		URL: "https://www.facebook.com/" + facebook.MetaGraphAPIVersion + "/dialog/oauth" +
			"?client_id=" + os.Getenv("FACEBOOK_APP_ID") +
			"&redirect_uri=" + facebook.EncodeURIComponent(os.Getenv("FRONTEND_URL")+"/integrations/social/instagram") +
			"&state=" + state +
			"&scope=" + facebook.EncodeURIComponent(strings.Join(scopes, ",")),
		CodeVerifier: ids.Secure(10),
		State:        state,
	}, nil
}

func (p *Provider) Authenticate(ctx context.Context, params integrations.AuthenticateParams, _ *integrations.ClientInformation) (*integrations.AuthTokenDetails, error) {
	base := graph(FacebookHost)
	refresh := ""
	if params.Refresh != "" {
		refresh = "?refresh=" + params.Refresh
	}
	var getAccessToken struct {
		AccessToken string `json:"access_token"`
	}
	if err := facebook.GetJSON(ctx, base+"/oauth/access_token"+
		"?client_id="+os.Getenv("FACEBOOK_APP_ID")+
		"&redirect_uri="+facebook.EncodeURIComponent(os.Getenv("FRONTEND_URL")+"/integrations/social/instagram"+refresh)+
		"&client_secret="+os.Getenv("FACEBOOK_APP_SECRET")+
		"&code="+params.Code, &getAccessToken); err != nil {
		return nil, err
	}

	var exchanged struct {
		AccessToken string `json:"access_token"`
	}
	if err := facebook.GetJSON(ctx, base+"/oauth/access_token"+
		"?grant_type=fb_exchange_token"+
		"&client_id="+os.Getenv("FACEBOOK_APP_ID")+
		"&client_secret="+os.Getenv("FACEBOOK_APP_SECRET")+
		"&fb_exchange_token="+getAccessToken.AccessToken, &exchanged); err != nil {
		return nil, err
	}
	accessToken := exchanged.AccessToken

	if err := facebook.CheckPermissions(ctx, p.Base, base, accessToken, scopes); err != nil {
		return nil, err
	}

	var me struct {
		ID      string `json:"id"`
		Name    string `json:"name"`
		Picture *struct {
			Data struct {
				URL string `json:"url"`
			} `json:"data"`
		} `json:"picture"`
	}
	if err := facebook.GetJSON(ctx, base+"/me?fields=id,name,picture&access_token="+accessToken, &me); err != nil {
		return nil, err
	}
	pic := ""
	if me.Picture != nil {
		pic = me.Picture.Data.URL
	}
	return &integrations.AuthTokenDetails{
		ID:           me.ID,
		Name:         me.Name,
		AccessToken:  accessToken,
		RefreshToken: accessToken,
		ExpiresIn:    facebook.ExpiresInDays(59),
		Picture:      pic,
		Username:     "",
	}, nil
}

// Page is one Instagram business account found through a Facebook page.
type Page struct {
	PageID  string      `json:"pageId"`
	ID      string      `json:"id"`
	Name    *string     `json:"name,omitempty"`
	Picture pagePicture `json:"picture"`
}

type pagePicture struct {
	Data struct {
		URL *string `json:"url,omitempty"`
	} `json:"data"`
}

// Pages lists the Instagram business accounts of the user's pages (the
// between-steps picker).
func (p *Provider) Pages(ctx context.Context, token string) ([]Page, error) {
	accessToken, _ := splitToken(token)
	base := graph(FacebookHost)
	seen := map[string]bool{}
	type fbPage struct {
		ID                       string `json:"id"`
		InstagramBusinessAccount *struct {
			ID string `json:"id"`
		} `json:"instagram_business_account"`
	}
	var allFacebookPages []fbPage
	collect := func(item json.RawMessage) bool {
		var page fbPage
		_ = json.Unmarshal(item, &page)
		if !seen[page.ID] {
			seen[page.ID] = true
			allFacebookPages = append(allFacebookPages, page)
		}
		return false
	}
	const fields = "fields=id,instagram_business_account,username,name,picture.type(large)&limit=100&access_token="

	// Fetch pages the user explicitly shared during the OAuth dialog
	if err := facebook.EachPage(ctx, base+"/me/accounts?"+fields+accessToken, collect); err != nil {
		return nil, err
	}

	// Also fetch pages via Business Manager API to discover pages
	// not selected during the OAuth page selection step
	facebook.EachBusiness(ctx, base, accessToken, func(businessID string) bool {
		// Continue with other businesses on error
		_ = facebook.EachPage(ctx, base+"/"+businessID+"/owned_pages?"+fields+accessToken, collect)
		_ = facebook.EachPage(ctx, base+"/"+businessID+"/client_pages?"+fields+accessToken, collect)
		return false
	})

	var connected []fbPage
	for _, page := range allFacebookPages {
		if page.InstagramBusinessAccount != nil {
			connected = append(connected, page)
		}
	}
	pages, err := facebook.All(connected, func(page fbPage) (Page, error) {
		var account struct {
			Name              *string `json:"name"`
			ProfilePictureURL *string `json:"profile_picture_url"`
		}
		err := facebook.GetJSON(ctx, base+"/"+page.InstagramBusinessAccount.ID+"?fields=name,profile_picture_url&access_token="+accessToken, &account)
		out := Page{PageID: page.ID, ID: page.InstagramBusinessAccount.ID, Name: account.Name}
		out.Picture.Data.URL = account.ProfilePictureURL
		return out, err
	})
	if err != nil {
		return nil, err
	}
	if pages == nil {
		pages = []Page{}
	}
	return pages, nil
}

func (p *Provider) FetchPageInformation(ctx context.Context, token string, data json.RawMessage) (*integrations.FetchPageInformationResult, error) {
	accessToken, _ := splitToken(token)
	var input struct {
		PageID string `json:"pageId"`
		ID     string `json:"id"`
	}
	_ = json.Unmarshal(data, &input)
	base := graph(FacebookHost)

	var page struct {
		AccessToken string `json:"access_token"`
	}
	if err := facebook.GetJSON(ctx, base+"/"+input.PageID+"?fields=access_token,name,picture.type(large)&access_token="+accessToken, &page); err != nil {
		return nil, err
	}

	var account struct {
		ID                string `json:"id"`
		Name              string `json:"name"`
		ProfilePictureURL string `json:"profile_picture_url"`
		Username          string `json:"username"`
	}
	if err := facebook.GetJSON(ctx, base+"/"+input.ID+"?fields=username,name,profile_picture_url&access_token="+accessToken, &account); err != nil {
		return nil, err
	}

	return &integrations.FetchPageInformationResult{
		ID:          account.ID,
		Name:        account.Name,
		Picture:     account.ProfilePictureURL,
		AccessToken: page.AccessToken + "___" + accessToken,
		Username:    account.Username,
	}, nil
}

var leadingAt = regexp.MustCompile(`^@+`)

// Instagram rejects collaborator handles that carry a leading @ with
// error_subcode 2207018, and the tag input stores whatever the user typed.
func stripHandle(handle string) string { return leadingAt.ReplaceAllString(handle, "") }

// Single, read-only status check of a media container - the polling loops
// that used to live inside post() are now driven by the post workflow.
func (p *Provider) igContainerStatus(ctx context.Context, containerID, checkToken, host string) (string, error) {
	res, err := p.Fetch(ctx, graph(host)+"/"+containerID+"?access_token="+checkToken+"&fields=status_code,status", integrations.Request{})
	if err != nil {
		return "", err
	}
	var body struct {
		StatusCode string  `json:"status_code"`
		Status     *string `json:"status,omitempty"`
	}
	if err := res.JSON(&body); err != nil {
		return "", err
	}

	if body.StatusCode == "ERROR" || body.StatusCode == "EXPIRED" {
		status := ""
		if body.Status != nil {
			status = *body.Status
		}
		details, _ := json.Marshal(body)
		handled := p.HandleErrors(status, 200)
		if handled != nil && handled.Type == "disconnect" {
			return "", temporalx.Disconnect("instagram", string(details), "{}", handled.Value)
		}
		message := status
		if handled != nil && handled.Value != "" {
			message = handled.Value
		}
		if message == "" {
			message = "Instagram could not process the media"
		}
		return "", temporalx.BadBody("instagram", string(details), "{}", message)
	}
	return body.StatusCode, nil
}

// profileURL is `https://www.instagram.com/${integration.profile}`.
func profileURL(integration *ent.Integration) string {
	profile := "null"
	if integration != nil && integration.Profile != nil {
		profile = *integration.Profile
	}
	return "https://www.instagram.com/" + profile
}

// The post is live, the permalink is only cosmetic: never fail (and risk
// re-publishing) a live post over it.
func (p *Provider) igPermalink(ctx context.Context, mediaID, checkToken, host string, integration *ent.Integration) string {
	res, err := p.Fetch(ctx, graph(host)+"/"+mediaID+"?fields=permalink&access_token="+checkToken, integrations.Request{})
	if err != nil {
		return profileURL(integration)
	}
	var body struct {
		Permalink string `json:"permalink"`
	}
	if err := res.JSON(&body); err != nil {
		return profileURL(integration)
	}
	return body.Permalink
}

func (p *Provider) postID(ctx context.Context, rawURL string) (string, error) {
	res, err := p.Fetch(ctx, rawURL, integrations.Request{Method: http.MethodPost})
	if err != nil {
		return "", err
	}
	var body struct {
		ID string `json:"id"`
	}
	err = res.JSON(&body)
	return body.ID, err
}

// PendingData is what postPending hands to the workflow; the graph host
// travels inside it, so checkPostStatus/finalizePost need no host argument.
type PendingData struct {
	Type          string   `json:"type"`
	PostType      string   `json:"postType"` // stories | single | carousel
	Containers    []string `json:"containers"`
	Message       string   `json:"message"`
	Collaborators []string `json:"collaborators,omitempty"`
	CarouselID    string   `json:"carouselId,omitempty"`
}

func (p *Provider) PostPending(ctx context.Context, id, token string, posts []integrations.PostDetails, integration *ent.Integration) ([]integrations.PostResponse, error) {
	return p.PostPendingOn(ctx, id, token, posts, integration, FacebookHost)
}

// PostPendingOn is postPending with an explicit graph host.
func (p *Provider) PostPendingOn(ctx context.Context, id, token string, posts []integrations.PostDetails, _ *ent.Integration, host string) ([]integrations.PostResponse, error) {
	accessToken, _ := splitToken(token)
	firstPost := posts[0]
	settings := SettingsOf(firstPost.Settings)
	isStory := settings.isStory()

	var labels []string
	for _, c := range settings.Collaborators {
		label := ""
		if c.Label != nil {
			label = *c.Label
		}
		labels = append(labels, stripHandle(label))
	}
	collaborators := ""
	if len(settings.Collaborators) > 0 && !isStory {
		data, _ := json.Marshal(labels)
		collaborators = "&collaborators=" + facebook.EncodeURIComponent(string(data))
	}
	isTrialReel := integrations.AssetBoolean(settings.IsTrialReel)
	single := len(firstPost.Media) == 1

	medias, err := facebook.All(firstPost.Media, func(m integrations.MediaContent) (string, error) {
		caption := ""
		if single {
			caption = "&caption=" + facebook.EncodeURIComponent(firstPost.Message)
		}
		isCarousel := ""
		if len(firstPost.Media) > 1 && !isStory {
			isCarousel = "&is_carousel_item=true"
		}
		thumbOffset := "0"
		if m.ThumbnailTimestamp != nil && *m.ThumbnailTimestamp != 0 {
			thumbOffset = strconv.FormatInt(*m.ThumbnailTimestamp, 10)
		}
		isVideo := m.Type == "video" || helpers.HasExtension(m.Path, "mp4")
		// Private media URLs carry their own query parameters. Encode the entire
		// URL as one Graph API parameter so its signature reaches Meta intact.
		mediaURL := facebook.EncodeURIComponent(m.Path)
		var mediaType string
		switch {
		case isVideo && isStory:
			mediaType = "video_url=" + mediaURL + "&media_type=STORIES"
		case isVideo && single && m.Thumbnail != "":
			mediaType = "video_url=" + mediaURL + "&media_type=REELS&cover_url=" + facebook.EncodeURIComponent(m.Thumbnail)
		case isVideo && single:
			mediaType = "video_url=" + mediaURL + "&media_type=REELS&thumb_offset=" + thumbOffset
		case isVideo:
			mediaType = "video_url=" + mediaURL + "&media_type=VIDEO&thumb_offset=" + thumbOffset
		case isStory:
			mediaType = "image_url=" + mediaURL + "&media_type=STORIES"
		default:
			mediaType = "image_url=" + mediaURL
		}

		trialParams := ""
		if isTrialReel {
			strategy := "MANUAL"
			if settings.GraduationStrategy != nil && *settings.GraduationStrategy != "" {
				strategy = *settings.GraduationStrategy
			}
			data, _ := json.Marshal(map[string]string{"graduation_strategy": strategy})
			trialParams = "&trial_params=" + facebook.EncodeURIComponent(string(data))
		}

		// collaborators are not allowed on carousel child items,
		// they go on the carousel container instead
		itemCollaborators := ""
		if single {
			itemCollaborators = collaborators
		}

		// audio_configuration is only supported for Reels (single video, not a story)
		// and only with Facebook Login (not Instagram Login / graph.instagram.com)
		audioConfiguration := ""
		if settings.Audio != nil && settings.Audio.ID != nil && *settings.Audio.ID != "" &&
			host == FacebookHost && !isStory && single && isVideo {
			data, _ := json.Marshal(struct {
				AudioID     string          `json:"audio_id"`
				AudioVolume json.RawMessage `json:"audio_volume,omitempty"`
				VideoVolume json.RawMessage `json:"video_volume,omitempty"`
			}{*settings.Audio.ID, jsonNumber(settings.Audio.AudioVolume), jsonNumber(settings.Audio.VideoVolume)})
			audioConfiguration = "&audio_configuration=" + facebook.EncodeURIComponent(string(data))
		}

		return p.postID(ctx, graph(host)+"/"+id+"/media?"+mediaType+isCarousel+itemCollaborators+trialParams+audioConfiguration+"&access_token="+accessToken+caption)
	})
	if err != nil {
		return nil, err
	}
	if medias == nil {
		medias = []string{}
	}

	// Containers are invisible until media_publish runs: the processing wait
	// and the publish itself move to checkPostStatus / finalizePost so a
	// failure there can never re-create (and re-publish) the whole post.
	pending := PendingData{Type: host, Containers: medias, Message: firstPost.Message}
	switch {
	case isStory && len(medias) > 1:
		pending.PostType = "stories"
	case len(medias) == 1:
		pending.PostType = "single"
	default:
		pending.PostType = "carousel"
	}
	if collaborators != "" {
		pending.Collaborators = labels
	}
	data, _ := json.Marshal(pending)
	return []integrations.PostResponse{{ID: firstPost.ID, Status: "pending", PendingData: data}}, nil
}

// jsonNumber is JSON.stringify(+value) for a present volume (NaN -> null).
func jsonNumber(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	n := JSNumber(raw)
	if math.IsNaN(n) || math.IsInf(n, 0) {
		return json.RawMessage("null")
	}
	return json.RawMessage(facebook.FormatNumber(n))
}

func (p *Provider) CheckPostStatus(ctx context.Context, token string, raw json.RawMessage, integration *ent.Integration) (*integrations.PendingCheckResponse, error) {
	var pending PendingData
	if err := json.Unmarshal(raw, &pending); err != nil {
		return nil, err
	}
	accessToken, userToken := splitToken(token)
	checkToken := userToken
	if checkToken == "" {
		checkToken = accessToken
	}

	// the carousel container was already created: wait for it
	if pending.CarouselID != "" {
		status, err := p.igContainerStatus(ctx, pending.CarouselID, checkToken, pending.Type)
		if err != nil {
			return nil, err
		}
		switch status {
		case "IN_PROGRESS":
			return &integrations.PendingCheckResponse{Status: "pending", PendingData: raw}, nil
		case "PUBLISHED":
			// a previous finalizePost published but died before reporting: the
			// post is live, never publish again
			return &integrations.PendingCheckResponse{Status: "completed", PostID: pending.CarouselID, ReleaseURL: profileURL(integration)}, nil
		}
		return &integrations.PendingCheckResponse{Status: "ready", PendingData: raw}, nil
	}

	for _, containerID := range pending.Containers {
		status, err := p.igContainerStatus(ctx, containerID, checkToken, pending.Type)
		if err != nil {
			return nil, err
		}
		if status == "IN_PROGRESS" {
			return &integrations.PendingCheckResponse{Status: "pending", PendingData: raw}, nil
		}
		// a previous finalizePost died mid-way: a single post is fully live,
		// stories are resumed by finalizePost (it skips published containers)
		if status == "PUBLISHED" && pending.PostType == "single" {
			return &integrations.PendingCheckResponse{Status: "completed", PostID: containerID, ReleaseURL: profileURL(integration)}, nil
		}
	}

	return &integrations.PendingCheckResponse{Status: "ready", PendingData: raw}, nil
}

func (p *Provider) FinalizePost(ctx context.Context, token string, raw json.RawMessage, integration *ent.Integration) (*integrations.PendingCheckResponse, error) {
	var pending PendingData
	if err := json.Unmarshal(raw, &pending); err != nil {
		return nil, err
	}
	accessToken, userToken := splitToken(token)
	checkToken := userToken
	if checkToken == "" {
		checkToken = accessToken
	}
	igID := integration.InternalID
	base := graph(pending.Type)

	if pending.PostType == "stories" {
		// Stories don't support carousels - publish each media as a separate
		// story, skipping containers a previous (crashed) run already published
		lastMediaID := ""
		for _, mediaCreationID := range pending.Containers {
			status, err := p.igContainerStatus(ctx, mediaCreationID, checkToken, pending.Type)
			if err != nil {
				return nil, err
			}
			if status == "PUBLISHED" {
				continue
			}
			mediaID, err := p.postID(ctx, base+"/"+igID+"/media_publish?creation_id="+mediaCreationID+"&access_token="+accessToken+"&field=id")
			if err != nil {
				return nil, err
			}
			lastMediaID = mediaID
		}

		if lastMediaID == "" {
			postID := ""
			if n := len(pending.Containers); n > 0 {
				postID = pending.Containers[n-1]
			}
			return &integrations.PendingCheckResponse{Status: "completed", PostID: postID, ReleaseURL: profileURL(integration)}, nil
		}
		return &integrations.PendingCheckResponse{
			Status:     "completed",
			PostID:     lastMediaID,
			ReleaseURL: p.igPermalink(ctx, lastMediaID, checkToken, pending.Type, integration),
		}, nil
	}

	if pending.PostType == "carousel" && pending.CarouselID == "" {
		// create the carousel container and hand back to the workflow to wait
		// for it (an orphan container from a crashed run is invisible, so
		// re-running this is safe)
		collaborators := ""
		if len(pending.Collaborators) > 0 {
			data, _ := json.Marshal(pending.Collaborators)
			collaborators = "&collaborators=" + facebook.EncodeURIComponent(string(data))
		}
		containerID, err := p.postID(ctx, base+"/"+igID+"/media?caption="+facebook.EncodeURIComponent(pending.Message)+
			"&media_type=CAROUSEL&children="+facebook.EncodeURIComponent(strings.Join(pending.Containers, ","))+
			collaborators+"&access_token="+accessToken)
		if err != nil {
			return nil, err
		}
		pending.CarouselID = containerID
		data, _ := json.Marshal(pending)
		return &integrations.PendingCheckResponse{Status: "pending", PendingData: data}, nil
	}

	creationID := pending.CarouselID
	if pending.PostType != "carousel" {
		if len(pending.Containers) > 0 {
			creationID = pending.Containers[0]
		} else {
			creationID = ""
		}
	}
	mediaID, err := p.postID(ctx, base+"/"+igID+"/media_publish?creation_id="+creationID+"&access_token="+accessToken+"&field=id")
	if err != nil {
		return nil, err
	}
	return &integrations.PendingCheckResponse{
		Status:     "completed",
		PostID:     mediaID,
		ReleaseURL: p.igPermalink(ctx, mediaID, checkToken, pending.Type, integration),
	}, nil
}

func (p *Provider) Post(ctx context.Context, id, token string, posts []integrations.PostDetails, integration *ent.Integration) ([]integrations.PostResponse, error) {
	return p.PostOn(ctx, id, token, posts, integration, FacebookHost)
}

// PostOn is the old blocking behavior, kept for workflow versions before
// v1.0.6 that don't know how to resolve a `pending` response.
func (p *Provider) PostOn(ctx context.Context, id, token string, posts []integrations.PostDetails, integration *ent.Integration, host string) ([]integrations.PostResponse, error) {
	responses, err := p.PostPendingOn(ctx, id, token, posts, integration, host)
	if err != nil {
		return nil, err
	}
	pendingData := responses[0].PendingData
	started := time.Now()
	for {
		// Cap below the 10-minute activity timeout of the old workflows using
		// this method: failing here (non-retryable) is safe, timing the
		// activity out is not - a retried activity would publish again.
		if time.Since(started) > 8*time.Minute {
			return nil, temporalx.BadBody("instagram", "{}", "{}", "Media processing timed out")
		}

		check, err := p.CheckPostStatus(ctx, token, pendingData, integration)
		if err != nil {
			return nil, err
		}
		if check.Status == "pending" {
			pendingData = check.PendingData
			if err := p.Sleep(ctx, pollInterval); err != nil {
				return nil, err
			}
			continue
		}

		result := check
		if check.Status == "ready" {
			if result, err = p.FinalizePost(ctx, token, check.PendingData, integration); err != nil {
				return nil, err
			}
		}
		if result.Status == "completed" {
			return []integrations.PostResponse{{ID: posts[0].ID, PostID: result.PostID, ReleaseURL: result.ReleaseURL, Status: "success"}}, nil
		}
		pendingData = result.PendingData
		if err := p.Sleep(ctx, pollInterval); err != nil {
			return nil, err
		}
	}
}

// pollInterval is the blocking Post's wait between checks (timer(30000)).
var pollInterval = 30 * time.Second

func (p *Provider) Comment(ctx context.Context, id, postID, lastCommentID, token string, posts []integrations.PostDetails, integration *ent.Integration) ([]integrations.PostResponse, error) {
	return p.CommentOn(ctx, id, postID, lastCommentID, token, posts, integration, FacebookHost)
}

// CommentOn is comment with an explicit graph host.
func (p *Provider) CommentOn(ctx context.Context, _, postID, _, token string, posts []integrations.PostDetails, _ *ent.Integration, host string) ([]integrations.PostResponse, error) {
	accessToken, userToken := splitToken(token)
	commentPost := posts[0]

	commentID, err := p.postID(ctx, graph(host)+"/"+postID+"/comments?message="+facebook.EncodeURIComponent(commentPost.Message)+"&access_token="+accessToken)
	if err != nil {
		return nil, err
	}

	// Get the permalink from the parent post
	readToken := userToken
	if readToken == "" {
		readToken = accessToken
	}
	res, err := p.Fetch(ctx, graph(host)+"/"+postID+"?fields=permalink&access_token="+readToken, integrations.Request{})
	if err != nil {
		return nil, err
	}
	var parent struct {
		Permalink string `json:"permalink"`
	}
	if err := res.JSON(&parent); err != nil {
		return nil, err
	}
	return []integrations.PostResponse{{ID: commentPost.ID, PostID: commentID, ReleaseURL: parent.Permalink, Status: "success"}}, nil
}

func setTitle(name string) string {
	switch name {
	case "likes":
		return "Likes"
	case "followers":
		return "Followers"
	case "reach":
		return "Reach"
	case "follower_count":
		return "Follower Count"
	case "views":
		return "Views"
	case "comments":
		return "Comments"
	case "shares":
		return "Shares"
	case "saves":
		return "Saves"
	case "replies":
		return "Replies"
	}
	return ""
}

func (p *Provider) Analytics(ctx context.Context, id, token string, days int) ([]integrations.AnalyticsData, error) {
	return p.AnalyticsOn(ctx, id, token, days, FacebookHost)
}

// AnalyticsOn is analytics with an explicit graph host.
func (p *Provider) AnalyticsOn(ctx context.Context, id, token string, days int, host string) ([]integrations.AnalyticsData, error) {
	accessToken, _ := splitToken(token)
	now := time.Now()
	until := strconv.FormatInt(time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location()).Unix(), 10)
	since := strconv.FormatInt(now.AddDate(0, 0, -days).Unix(), 10)

	var first struct {
		Data []struct {
			Name   string `json:"name"`
			Values []struct {
				Value   any    `json:"value"`
				EndTime string `json:"end_time"`
			} `json:"values"`
		} `json:"data"`
	}
	if err := integrations.ReadInsightsJSON(ctx, graph(host)+"/"+id+"/insights?metric=follower_count,reach&access_token="+accessToken+"&period=day&since="+since+"&until="+until, &first); err != nil {
		return nil, err
	}

	var second struct {
		Data []struct {
			Name       string `json:"name"`
			TotalValue struct {
				Value any `json:"value"`
			} `json:"total_value"`
		} `json:"data"`
	}
	if err := integrations.ReadInsightsJSON(ctx, graph(host)+"/"+id+"/insights?metric_type=total_value&metric=likes,views,comments,shares,saves,replies&access_token="+accessToken+"&period=day&since="+since+"&until="+until, &second); err != nil {
		return nil, err
	}
	if second.Data == nil {
		// An absent data envelope is not a measured zero.
		return nil, errors.New("Instagram insights data unavailable")
	}

	analytics := []integrations.AnalyticsData{}
	for _, d := range first.Data {
		items := []integrations.AnalyticsItem{}
		for _, v := range d.Values {
			items = append(items, integrations.AnalyticsItem{Total: facebook.JSString(v.Value), Date: facebook.DayOf(v.EndTime)})
		}
		analytics = append(analytics, integrations.AnalyticsData{Label: setTitle(d.Name), Data: items})
	}
	today := now.Format("2006-01-02")
	for _, d := range second.Data {
		analytics = append(analytics, integrations.AnalyticsData{
			Label: setTitle(d.Name),
			Data:  []integrations.AnalyticsItem{{Total: facebook.JSString(d.TotalValue.Value), Date: today}},
		})
	}
	return analytics, nil
}

// Music is `music`: the API returns the raw fetch response, which
// serializes as {}.
func (p *Provider) Music(ctx context.Context, accessToken string, data json.RawMessage) (any, error) {
	var input struct {
		Q string `json:"q"`
	}
	_ = json.Unmarshal(data, &input)
	if _, err := p.Fetch(ctx, graph(FacebookHost)+"/music/search?q="+facebook.EncodeURIComponent(input.Q)+"&access_token="+accessToken, integrations.Request{}); err != nil {
		return nil, err
	}
	return map[string]any{}, nil
}

// AudioResult is one audioSearch entry.
type AudioResult struct {
	ID         any    `json:"id"`
	Title      string `json:"title"`
	Artist     string `json:"artist"`
	Image      string `json:"image"`
	Duration   any    `json:"duration"`
	PreviewURL string `json:"previewUrl"`
}

// AudioSearch searches Reel audio; an empty search_query returns trending audio.
// https://developers.facebook.com/docs/instagram-platform/content-publishing/audio-api/
func (p *Provider) AudioSearch(ctx context.Context, token string, data json.RawMessage, internalID string) ([]AudioResult, error) {
	accessToken, userToken := splitToken(token)
	var input struct {
		Q    string `json:"q"`
		Type string `json:"type"`
	}
	_ = json.Unmarshal(data, &input)
	audioType := "music"
	if input.Type == "original_sound" {
		audioType = "original_sound"
	}
	search := ""
	if input.Q != "" {
		search = "&search_query=" + facebook.EncodeURIComponent(input.Q)
	}
	readToken := userToken
	if readToken == "" {
		readToken = accessToken
	}
	res, err := p.Fetch(ctx, graph(FacebookHost)+"/ig_audio?audio_type="+audioType+"&user_id="+internalID+search+"&access_token="+readToken, integrations.Request{})
	if err != nil {
		return nil, err
	}
	var body struct {
		Audio []map[string]any `json:"audio"`
	}
	if err := res.JSON(&body); err != nil {
		return nil, err
	}
	first := func(a map[string]any, keys ...string) string {
		for _, k := range keys {
			if s, ok := a[k].(string); ok && s != "" {
				return s
			}
		}
		return ""
	}
	out := []AudioResult{}
	for _, a := range body.Audio {
		duration := a["duration_in_ms"]
		if duration == nil || duration == 0.0 || duration == "" || duration == false {
			duration = 0
		}
		out = append(out, AudioResult{
			ID:         a["audio_id"],
			Title:      first(a, "title"),
			Artist:     first(a, "display_artist", "ig_username"),
			Image:      first(a, "cover_artwork_thumbnail_uri", "cover_artwork_thumbnail_url", "profile_picture_url"),
			Duration:   duration,
			PreviewURL: first(a, "download_url"),
		})
	}
	return out, nil
}

func (p *Provider) PostAnalytics(ctx context.Context, integrationID, token, postID string, fromDate int64) ([]integrations.AnalyticsData, error) {
	return p.PostAnalyticsOn(ctx, integrationID, token, postID, fromDate, FacebookHost)
}

// PostAnalyticsOn is postAnalytics with an explicit graph host.
func (p *Provider) PostAnalyticsOn(ctx context.Context, _, token, postID string, _ int64, host string) ([]integrations.AnalyticsData, error) {
	accessToken, _ := splitToken(token)
	today := time.Now().Format("2006-01-02")

	// Fetch media insights from Instagram Graph API
	var res struct {
		Data []struct {
			Name   string `json:"name"`
			Values []struct {
				Value json.RawMessage `json:"value"`
			} `json:"values"`
		} `json:"data"`
	}
	if err := integrations.ReadInsightsJSON(ctx, graph(host)+"/"+postID+"/insights?metric=views,reach,saved,likes,comments,shares&access_token="+accessToken, &res); err != nil {
		return nil, err
	}

	result := []integrations.AnalyticsData{}
	for _, metric := range res.Data {
		if len(metric.Values) == 0 || len(metric.Values[0].Value) == 0 {
			continue
		}
		var value any
		_ = json.Unmarshal(metric.Values[0].Value, &value)
		label := ""
		switch metric.Name {
		case "views":
			label = "Views"
		case "reach":
			label = "Reach"
		case "engagement":
			label = "Engagement"
		case "saved":
			label = "Saves"
		case "likes":
			label = "Likes"
		case "comments":
			label = "Comments"
		case "shares":
			label = "Shares"
		}
		if label != "" {
			result = append(result, integrations.AnalyticsData{Label: label, Data: []integrations.AnalyticsItem{{Total: facebook.JSString(value), Date: today}}})
		}
	}
	return result, nil
}
