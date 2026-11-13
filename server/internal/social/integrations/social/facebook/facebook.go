// Package facebook is the Facebook provider: Facebook Pages through the Graph
// API (feed posts, videos/reels, stories with a pending -> finalize flow,
// comments, page insights and post insights).
package facebook

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/helpers"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ids"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
	"go.temporal.io/sdk/temporal"
)

const MetaGraphAPIVersion = "v25.0"

// graphURL is the Graph API origin; tests point it at an httptest server.
var graphURL = "https://graph.facebook.com"

func graph() string { return graphURL + "/" + MetaGraphAPIVersion }

var scopes = []string{
	"pages_show_list",
	"business_management",
	"pages_manage_posts",
	"pages_manage_engagement",
	"pages_read_engagement",
	"read_insights",
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
	return &Provider{Base: integrations.NewBase("facebook", HandleErrors)}
}

func (p *Provider) Info() integrations.Info {
	return integrations.Info{
		Identifier:       "facebook",
		Name:             "Facebook Page",
		Editor:           "normal",
		Scopes:           scopes,
		IsBetweenSteps:   true,
		MaxConcurrentJob: 500, // Facebook has reasonable rate limits
		Rules:            "Facebook posts can be text only, or include photos or a video. If it's a story, it must have at least one attachment (photo or video), and each media is published as a separate story. Video posts (not stories) can carry an optional title.",
	}
}

func (p *Provider) MaxLength([]integrations.AdditionalSetting, json.RawMessage) int { return 63206 }

func (p *Provider) SettingsDTO() any { return &FacebookDTO{} }

func (p *Provider) Functions() map[string]integrations.Function {
	return map[string]integrations.Function{
		"pages": func(ctx context.Context, accessToken string, _ json.RawMessage, _ string, _ *ent.Integration) (any, error) {
			return p.Pages(ctx, accessToken)
		},
		"fetchPageInformation": func(ctx context.Context, accessToken string, data json.RawMessage, _ string, _ *ent.Integration) (any, error) {
			return p.FetchPageInformation(ctx, accessToken, data)
		},
	}
}

func settingsOf(raw json.RawMessage) FacebookDTO {
	var s FacebookDTO
	_ = json.Unmarshal(raw, &s) // settings are free-form JSON; read what matches
	return s
}

func (s FacebookDTO) isStory() bool { return s.PostType != nil && *s.PostType == "story" }

func (p *Provider) CheckValidity(_ context.Context, posts [][]integrations.ValidityMedia, settings json.RawMessage, _ []integrations.AdditionalSetting) (string, error) {
	if settingsOf(settings).isStory() && (len(posts) == 0 || len(posts[0]) == 0) {
		return "Story should have at least one media", nil
	}
	return "", nil
}

var (
	subcode459 = regexp.MustCompile(`"error_subcode":459\b`)
	subcode492 = regexp.MustCompile(`"error_subcode":492\b`)
	subcode33  = regexp.MustCompile(`"error_subcode":33\b`)
)

// HandleErrors is FacebookProvider.handleErrors.
func HandleErrors(body string, status int) *integrations.HandledError {
	has := func(s string) bool { return strings.Contains(body, s) }
	h := func(kind, value string) *integrations.HandledError {
		return &integrations.HandledError{Type: kind, Value: value}
	}
	switch {
	// Access token validation errors - require re-authentication
	case has("Error validating access token"):
		return h("refresh-token", "Please re-authenticate your Facebook account")
	case has("REVOKED_ACCESS_TOKEN"):
		return h("refresh-token", "Access token has been revoked, please re-authenticate")
	// The token is valid but belongs to the user, not to the page - the page
	// was never granted to the app, so only reconnecting can fix it
	case has("Unpublished posts must be posted to a page as the page itself"):
		return h("refresh-token", "Shots is not authorized to publish as this page, please reconnect the channel")
	case has("(#200)"):
		return h("bad-body", "Facebook rejected the post due to missing permissions. Make sure your Facebook account has full content access to the Page, then reconnect the channel.")
	case has("1366046"):
		return h("bad-body", "Photos should be smaller than 4 MB and saved as JPG, PNG")
	// code 368 "Temporarily blocked for policies violations" (subcode
	// 1390008): Meta documents it as temporary, "wait and retry the operation"
	case has("1390008"):
		return h("retry", "You are posting too fast, please slow down")
	// Content policy violations
	case has("1346003"):
		return h("bad-body", "Content flagged as abusive by Facebook")
	case has("1404006"):
		return h("bad-body", "We couldn't post your comment, A security check in facebook required to proceed.")
	case has("2069019"):
		return h("bad-body", "Invalid file")
	case has("1404102"):
		return h("bad-body", "Content violates Facebook Community Standards")
	// Permission errors
	case has("1404078"):
		return h("refresh-token", "Page publishing authorization required, please re-authenticate")
	case has("1366051"):
		return h("bad-body", "These photos were already posted.")
	case has("1609008"):
		return h("bad-body", "Cannot post Facebook.com links")
	// Parameter validation errors
	case has("2061006"):
		return h("bad-body", "Invalid URL format in post content")
	case has("1349125"):
		return h("bad-body", "Invalid content format")
	case has("1404112"):
		return h("bad-body", "For security reasons, your account has limited access to the site for a few days")
	case has("Name parameter too long"):
		return h("bad-body", "Post content is too long")
	// Service errors - checking specific subcodes first
	case has("1363047"):
		return h("bad-body", "Facebook service temporarily unavailable")
	case has("1609010"):
		return h("bad-body", "Facebook service temporarily unavailable")
	case has("4854002"):
		return h("bad-body", "Confirm your identity before you can publish as this Page. Open the Facebook app on your phone and follow the instructions")
	case has("(#100) No permission to publish the video"):
		return h("bad-body", "Facebook return: No permission to publish the video")
	case subcode459.MatchString(body):
		return h("bad-body", "Facebook is asking you to resolve a security check. Log in at facebook.com, complete it, then try again")
	case subcode492.MatchString(body):
		return h("bad-body", "Your Facebook user no longer has a role on this Page. Ask a Page admin to grant you a role, then reconnect the channel")
	case has("must be granted before impersonating"):
		return h("refresh-token", "Facebook Page permissions are missing, please reconnect the channel and allow all permissions")
	case subcode33.MatchString(body) && has("does not exist"):
		return h("bad-body", "The Facebook Page or post this was targeting no longer exists, please reconnect the channel and schedule again")
	case has("Sorry, something went wrong"):
		return h("retry", "Facebook is temporarily unavailable, please try again later")
	case has("490"):
		return h("refresh-token", "Access token expired, please re-authenticate")
	case status == 401:
		return h("bad-body", "An unknown error occurred, please try again later or contact support")
	}
	return nil
}

func (p *Provider) RefreshToken(context.Context, string) (*integrations.AuthTokenDetails, error) {
	return &integrations.AuthTokenDetails{}, nil
}

func (p *Provider) GenerateAuthURL(context.Context, *integrations.ClientInformation) (*integrations.GenerateAuthURLResponse, error) {
	state := ids.Secure(6)
	return &integrations.GenerateAuthURLResponse{
		URL: "https://www.facebook.com/" + MetaGraphAPIVersion + "/dialog/oauth" +
			"?client_id=" + os.Getenv("FACEBOOK_APP_ID") +
			"&redirect_uri=" + EncodeURIComponent(os.Getenv("FRONTEND_URL")+"/integrations/social/facebook") +
			"&state=" + state +
			"&scope=" + strings.Join(scopes, ","),
		CodeVerifier: ids.Secure(10),
		State:        state,
	}, nil
}

func (p *Provider) ReConnect(ctx context.Context, id, requiredID, accessToken string) (*integrations.AuthTokenDetails, error) {
	data, _ := json.Marshal(map[string]string{"page": requiredID})
	information, err := p.FetchPageInformation(ctx, accessToken, data)
	if err != nil {
		return nil, err
	}
	return &integrations.AuthTokenDetails{
		ID:          information.ID,
		Name:        information.Name,
		AccessToken: information.AccessToken,
		NonExpiring: true,
		Picture:     information.Picture,
		Username:    information.Username,
	}, nil
}

type picture struct {
	Data struct {
		URL string `json:"url"`
	} `json:"data"`
}

func (p *Provider) Authenticate(ctx context.Context, params integrations.AuthenticateParams, _ *integrations.ClientInformation) (*integrations.AuthTokenDetails, error) {
	refresh := ""
	if params.Refresh != "" {
		refresh = "?refresh=" + params.Refresh
	}
	var getAccessToken struct {
		AccessToken string `json:"access_token"`
	}
	if err := GetJSON(ctx, graph()+"/oauth/access_token"+
		"?client_id="+os.Getenv("FACEBOOK_APP_ID")+
		"&redirect_uri="+EncodeURIComponent(os.Getenv("FRONTEND_URL")+"/integrations/social/facebook"+refresh)+
		"&client_secret="+os.Getenv("FACEBOOK_APP_SECRET")+
		"&code="+params.Code, &getAccessToken); err != nil {
		return nil, err
	}

	var exchanged struct {
		AccessToken string `json:"access_token"`
	}
	if err := GetJSON(ctx, graph()+"/oauth/access_token"+
		"?grant_type=fb_exchange_token"+
		"&client_id="+os.Getenv("FACEBOOK_APP_ID")+
		"&client_secret="+os.Getenv("FACEBOOK_APP_SECRET")+
		"&fb_exchange_token="+getAccessToken.AccessToken+"&fields=access_token,expires_in", &exchanged); err != nil {
		return nil, err
	}
	accessToken := exchanged.AccessToken

	if err := CheckPermissions(ctx, p.Base, graph(), accessToken, scopes); err != nil {
		return nil, err
	}

	var me struct {
		ID      string   `json:"id"`
		Name    string   `json:"name"`
		Picture *picture `json:"picture"`
	}
	if err := GetJSON(ctx, graph()+"/me?fields=id,name,picture&access_token="+accessToken, &me); err != nil {
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
		// The long-lived user token only lists Pages; the Page token chosen
		// next replaces it and, minted from a long-lived token, never expires.
		NonExpiring: true,
		Picture:     pic,
		Username:    "",
	}, nil
}

// CheckPermissions reads /me/permissions and checks the granted ones cover
// required (shared with the Instagram provider).
func CheckPermissions(ctx context.Context, b *integrations.Base, graphBase, accessToken string, required []string) error {
	var permissions struct {
		Data []struct {
			Permission string `json:"permission"`
			Status     string `json:"status"`
		} `json:"data"`
	}
	if err := GetJSON(ctx, graphBase+"/me/permissions?access_token="+accessToken, &permissions); err != nil {
		return err
	}
	if permissions.Data == nil {
		return errors.New("Cannot read properties of undefined (reading 'filter')")
	}
	granted := []string{}
	for _, d := range permissions.Data {
		if d.Status == "granted" {
			granted = append(granted, d.Permission)
		}
	}
	return b.CheckScopes(required, granted)
}

// ExpiresInDays is dayjs().add(days, 'days').unix() - dayjs().unix().
func ExpiresInDays(days int) int64 {
	now := time.Now()
	return now.AddDate(0, 0, days).Unix() - now.Unix()
}

type listPage struct {
	Data   []json.RawMessage `json:"data"`
	Paging *struct {
		Next string `json:"next"`
	} `json:"paging"`
}

func (l listPage) next() string {
	if l.Paging == nil {
		return ""
	}
	return l.Paging.Next
}

// EachPage walks a paginated Graph edge with plain fetches, calling fn for
// every item until fn returns true.
func EachPage(ctx context.Context, startURL string, fn func(item json.RawMessage) bool) error {
	for next := startURL; next != ""; {
		var page listPage
		if err := GetJSON(ctx, next, &page); err != nil {
			return err
		}
		for _, item := range page.Data {
			if fn(item) {
				return nil
			}
		}
		next = page.next()
	}
	return nil
}

// EachBusiness walks /me/businesses, calling fn with every business id
// until it returns true. Errors stop the walk silently: the Business Manager
// API is not available for all users.
func EachBusiness(ctx context.Context, graphBase, accessToken string, fn func(businessID string) bool) {
	_ = EachPage(ctx, graphBase+"/me/businesses?access_token="+accessToken, func(item json.RawMessage) bool {
		var business struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(item, &business)
		return fn(business.ID)
	})
}

func itemID(item json.RawMessage) string {
	var v struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(item, &v)
	return v.ID
}

// Pages lists every page the user can publish to (the between-steps picker).
func (p *Provider) Pages(ctx context.Context, accessToken string) ([]json.RawMessage, error) {
	seen := map[string]bool{}
	allPages := []json.RawMessage{}
	collect := func(item json.RawMessage) bool {
		if id := itemID(item); !seen[id] {
			seen[id] = true
			allPages = append(allPages, item)
		}
		return false
	}
	const fields = "fields=id,username,name,access_token,picture.type(large)&limit=100&access_token="

	// Fetch pages the user explicitly shared during the OAuth dialog
	if err := EachPage(ctx, graph()+"/me/accounts?"+fields+accessToken, collect); err != nil {
		return nil, err
	}

	// Also fetch pages via Business Manager API to discover pages
	// not selected during the OAuth page selection step
	EachBusiness(ctx, graph(), accessToken, func(businessID string) bool {
		// Continue with other businesses on error
		_ = EachPage(ctx, graph()+"/"+businessID+"/owned_pages?"+fields+accessToken, collect)
		_ = EachPage(ctx, graph()+"/"+businessID+"/client_pages?"+fields+accessToken, collect)
		return false
	})

	return allPages, nil
}

func (p *Provider) FetchPageInformation(ctx context.Context, accessToken string, data json.RawMessage) (*integrations.FetchPageInformationResult, error) {
	var input struct {
		Page any `json:"page"`
	}
	_ = json.Unmarshal(data, &input)
	pageID := JSString(input.Page)
	const fields = "id,username,name,access_token,picture.type(large)"
	foundWithoutToken := false

	search := func(startURL string) (*integrations.FetchPageInformationResult, error) {
		var found *integrations.FetchPageInformationResult
		err := EachPage(ctx, startURL, func(item json.RawMessage) bool {
			var page struct {
				ID          any      `json:"id"`
				Name        string   `json:"name"`
				AccessToken string   `json:"access_token"`
				Username    string   `json:"username"`
				Picture     *picture `json:"picture"`
			}
			_ = json.Unmarshal(item, &page)
			if JSString(page.ID) != pageID {
				return false
			}
			// A page listed through a business the user has no role on comes
			// back without a page token, keep looking for a listing that has one
			if page.AccessToken == "" {
				foundWithoutToken = true
				return false
			}
			pic := ""
			if page.Picture != nil {
				pic = page.Picture.Data.URL
			}
			found = &integrations.FetchPageInformationResult{
				ID: JSString(page.ID), Name: page.Name, AccessToken: page.AccessToken, Picture: pic, Username: page.Username,
			}
			return true
		})
		return found, err
	}

	// 1. Check /me/accounts
	fromAccounts, err := search(graph() + "/me/accounts?fields=" + fields + "&limit=100&access_token=" + accessToken)
	if err != nil {
		return nil, err
	}
	if fromAccounts != nil {
		return fromAccounts, nil
	}

	// 2. Check Business Manager owned_pages and client_pages
	var result *integrations.FetchPageInformationResult
	EachBusiness(ctx, graph(), accessToken, func(businessID string) bool {
		for _, edge := range []string{"owned_pages", "client_pages"} {
			// Continue with other businesses on error
			if found, _ := search(graph() + "/" + businessID + "/" + edge + "?fields=" + fields + "&limit=100&access_token=" + accessToken); found != nil {
				result = found
				return true
			}
		}
		return false
	})
	if result != nil {
		return result, nil
	}

	if foundWithoutToken {
		return nil, errors.New("Your Facebook user has no permission to manage this page. Ask a page admin for full content access, then reconnect the channel")
	}
	return nil, errors.New("Page not found in your accounts")
}

// storyItem is one uploaded story media waiting to be published.
type storyItem struct {
	Kind    string `json:"kind"` // video | photo
	MediaID string `json:"mediaId"`
}

// storyPending is the pendingData of a story post.
type storyPending struct {
	PostType       string      `json:"postType"`
	Items          []storyItem `json:"items"`
	PublishedCount int         `json:"publishedCount"`
	LastPostID     string      `json:"lastPostId"`
	Attempting     *int        `json:"attempting,omitempty"`
	Confirmed      bool        `json:"confirmed,omitempty"`
}

func (p *Provider) postJSON(ctx context.Context, rawURL string, body any, v any) error {
	req := integrations.Request{Method: http.MethodPost}
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		req.Body = data
		req.Headers = map[string]string{"Content-Type": "application/json"}
	}
	res, err := p.Fetch(ctx, rawURL, req)
	if err != nil {
		return err
	}
	if v == nil {
		return nil
	}
	return res.JSON(v)
}

// Single, read-only status check of a story video - the polling loop that
// used to live inside post() is now driven by the post workflow.
func (p *Provider) fbVideoStatus(ctx context.Context, videoID, accessToken string) (bool, error) {
	res, err := p.Fetch(ctx, graph()+"/"+videoID+"?fields=status&access_token="+accessToken, integrations.Request{})
	if err != nil {
		return false, err
	}
	var body struct {
		Status json.RawMessage `json:"status"`
	}
	if err := res.JSON(&body); err != nil {
		return false, err
	}
	var status struct {
		VideoStatus string `json:"video_status"`
	}
	_ = json.Unmarshal(body.Status, &status)
	videoStatus := status.VideoStatus
	if videoStatus == "" {
		videoStatus = "in_progress"
	}
	if videoStatus == "error" {
		details := "{}"
		if len(body.Status) > 0 {
			details = `{"status":` + string(body.Status) + `}`
		}
		return false, temporalx.BadBody("facebook", details, "{}", "Video processing failed")
	}
	return videoStatus == "upload_complete" || videoStatus == "ready", nil
}

func (p *Provider) PostPending(ctx context.Context, id, accessToken string, posts []integrations.PostDetails, integration *ent.Integration) ([]integrations.PostResponse, error) {
	firstPost := posts[0]
	if !settingsOf(firstPost.Settings).isStory() {
		return p.postNonStory(ctx, id, accessToken, posts)
	}

	// Only upload the media here - uploads are invisible until the
	// publish calls, which run one at a time in finalizePost so a failure
	// can never re-publish the stories that already went out.
	items := []storyItem{}
	for _, media := range firstPost.Media {
		if helpers.HasExtension(media.Path, "mp4") {
			var start struct {
				VideoID   string `json:"video_id"`
				UploadURL string `json:"upload_url"`
			}
			if err := p.postJSON(ctx, graph()+"/"+id+"/video_stories?upload_phase=start&access_token="+accessToken, nil, &start); err != nil {
				return nil, err
			}
			if _, err := p.Fetch(ctx, start.UploadURL, integrations.Request{
				Method: http.MethodPost,
				Headers: map[string]string{
					"Authorization": "OAuth " + accessToken,
					"file_url":      media.Path,
				},
			}); err != nil {
				return nil, err
			}
			items = append(items, storyItem{Kind: "video", MediaID: start.VideoID})
			continue
		}
		var photo struct {
			ID string `json:"id"`
		}
		if err := p.postJSON(ctx, graph()+"/"+id+"/photos?access_token="+accessToken, unpublishedPhoto{URL: media.Path}, &photo); err != nil {
			return nil, err
		}
		items = append(items, storyItem{Kind: "photo", MediaID: photo.ID})
	}

	pending, _ := json.Marshal(storyPending{PostType: "story", Items: items})
	return []integrations.PostResponse{{ID: firstPost.ID, Status: "pending", PendingData: pending}}, nil
}

func (p *Provider) CheckPostStatus(ctx context.Context, accessToken string, raw json.RawMessage, _ *ent.Integration) (*integrations.PendingCheckResponse, error) {
	var pending storyPending
	if err := json.Unmarshal(raw, &pending); err != nil {
		return nil, err
	}

	// A confirmed publish attempt died without reporting its result: Facebook
	// has no API to ask whether a story was published, so never publish that
	// item again - stop with an explicit warning instead.
	if pending.Attempting != nil && pending.Confirmed {
		return nil, temporalx.BadBody("facebook", "{}", "{}", "Facebook may have already published part of the story, please check your page before posting again to avoid duplicates")
	}

	// wait for every not-yet-published video to finish processing, photos are
	// ready as soon as they are uploaded
	if pending.PublishedCount < len(pending.Items) {
		for _, item := range pending.Items[pending.PublishedCount:] {
			if item.Kind != "video" {
				continue
			}
			ready, err := p.fbVideoStatus(ctx, item.MediaID, accessToken)
			if err != nil {
				return nil, err
			}
			if !ready {
				return &integrations.PendingCheckResponse{Status: "pending", PendingData: raw}, nil
			}
		}
	}

	// witness the armed publish so finalizePost knows the attempt is uniquely
	// accounted for before it mutates anything
	if pending.Attempting != nil && !pending.Confirmed {
		pending.Confirmed = true
		data, _ := json.Marshal(pending)
		return &integrations.PendingCheckResponse{Status: "ready", PendingData: data}, nil
	}

	return &integrations.PendingCheckResponse{Status: "ready", PendingData: raw}, nil
}

func (p *Provider) FinalizePost(ctx context.Context, accessToken string, raw json.RawMessage, integration *ent.Integration) (*integrations.PendingCheckResponse, error) {
	var pending storyPending
	if err := json.Unmarshal(raw, &pending); err != nil {
		return nil, err
	}

	// Publish exactly one story per call, with an arm -> confirm -> publish
	// handshake: the publish only runs after checkPostStatus witnessed the
	// intent, so a run that dies mid-publish is detectable and the item is
	// never published twice.
	if pending.Attempting == nil || !pending.Confirmed {
		attempting := pending.PublishedCount
		pending.Attempting = &attempting
		pending.Confirmed = false
		data, _ := json.Marshal(pending)
		return &integrations.PendingCheckResponse{Status: "pending", PendingData: data}, nil
	}

	if pending.PublishedCount >= len(pending.Items) {
		return nil, errors.New("Cannot read properties of undefined (reading 'kind')")
	}
	item := pending.Items[pending.PublishedCount]

	publishURL := graph() + "/" + integration.InternalID + "/photo_stories?photo_id=" + item.MediaID + "&access_token=" + accessToken
	if item.Kind == "video" {
		publishURL = graph() + "/" + integration.InternalID + "/video_stories?upload_phase=finish&video_id=" + item.MediaID + "&access_token=" + accessToken
	}
	var story struct {
		PostID string `json:"post_id"`
	}
	if err := p.postJSON(ctx, publishURL, nil, &story); err != nil {
		return nil, err
	}

	publishedCount := pending.PublishedCount + 1
	if publishedCount < len(pending.Items) {
		pending.PublishedCount = publishedCount
		pending.LastPostID = story.PostID
		pending.Attempting = nil
		pending.Confirmed = false
		data, _ := json.Marshal(pending)
		return &integrations.PendingCheckResponse{Status: "pending", PendingData: data}, nil
	}

	return &integrations.PendingCheckResponse{
		Status:     "completed",
		PostID:     story.PostID,
		ReleaseURL: "https://www.facebook.com/stories/" + story.PostID,
	}, nil
}

// Post is the old blocking behavior, kept for workflow versions before v1.0.6
// that don't know how to resolve a `pending` response.
func (p *Provider) Post(ctx context.Context, id, accessToken string, posts []integrations.PostDetails, integration *ent.Integration) ([]integrations.PostResponse, error) {
	responses, err := p.PostPending(ctx, id, accessToken, posts, integration)
	if err != nil {
		return nil, err
	}
	response := responses[0]
	if response.Status != "pending" {
		return []integrations.PostResponse{response}, nil
	}

	pendingData := response.PendingData
	started := time.Now()
	for {
		// Cap below the 10-minute activity timeout of the old workflows using
		// this method: failing here (non-retryable) is safe, timing the
		// activity out is not - a retried activity would publish again.
		if time.Since(started) > 8*time.Minute {
			return nil, temporalx.BadBody("facebook", "{}", "{}", "Video processing timed out")
		}

		check, err := p.CheckPostStatus(ctx, accessToken, pendingData, integration)
		if err != nil {
			return nil, err
		}
		if check.Status == "pending" {
			pendingData = check.PendingData
			if err := p.Sleep(ctx, 10*time.Second); err != nil {
				return nil, err
			}
			continue
		}

		result := check
		if check.Status == "ready" {
			if result, err = p.FinalizePost(ctx, accessToken, check.PendingData, integration); err != nil {
				return nil, err
			}
		}
		if result.Status == "completed" {
			return []integrations.PostResponse{{ID: posts[0].ID, PostID: result.PostID, ReleaseURL: result.ReleaseURL, Status: "success"}}, nil
		}
		pendingData = result.PendingData
	}
}

// unpublishedPhoto is the {url, published: false} photo upload body.
type unpublishedPhoto struct {
	URL       string `json:"url"`
	Published bool   `json:"published"`
}

type mediaFBID struct {
	MediaFBID string `json:"media_fbid"`
}

func (p *Provider) postNonStory(ctx context.Context, id, accessToken string, posts []integrations.PostDetails) ([]integrations.PostResponse, error) {
	firstPost := posts[0]
	settings := settingsOf(firstPost.Settings)

	var finalID, finalURL string
	if len(firstPost.Media) > 0 && helpers.HasExtension(firstPost.Media[0].Path, "mp4") {
		var video struct {
			ID string `json:"id"`
		}
		if err := p.postJSON(ctx, graph()+"/"+id+"/videos?access_token="+accessToken+"&fields=id,permalink_url", struct {
			FileURL     string `json:"file_url"`
			Description string `json:"description"`
			Title       string `json:"title,omitempty"`
			Published   bool   `json:"published"`
		}{firstPost.Media[0].Path, firstPost.Message, settings.Title, true}, &video); err != nil {
			return nil, err
		}
		finalURL = "https://www.facebook.com/reel/" + video.ID
		finalID = video.ID
	} else {
		uploadPhotos, err := All(firstPost.Media, func(media integrations.MediaContent) (mediaFBID, error) {
			var photo struct {
				ID string `json:"id"`
			}
			err := p.postJSON(ctx, graph()+"/"+id+"/photos?access_token="+accessToken, unpublishedPhoto{URL: media.Path}, &photo)
			return mediaFBID{MediaFBID: photo.ID}, err
		})
		if err != nil {
			return nil, err
		}

		// Background presets are only valid on text-only posts (no media) and
		// Facebook caps them at ~130 chars, so we only attach the preset when it
		// can apply.
		presetID := ""
		if len(uploadPhotos) == 0 && settings.TextFormatPresetID != "" && jsLength(firstPost.Message) <= FacebookPresetMaxChars {
			presetID = settings.TextFormatPresetID
		}

		publishFeed := func(withPreset bool) (feedResult, error) {
			body := struct {
				AttachedMedia      []mediaFBID `json:"attached_media,omitempty"`
				Link               string      `json:"link,omitempty"`
				TextFormatPresetID string      `json:"text_format_preset_id,omitempty"`
				Message            string      `json:"message"`
				Published          bool        `json:"published"`
			}{AttachedMedia: uploadPhotos, Link: settings.URL, Message: firstPost.Message, Published: true}
			if withPreset {
				body.TextFormatPresetID = presetID
			}
			var result feedResult
			err := p.postJSON(ctx, graph()+"/"+id+"/feed?access_token="+accessToken+"&fields=id,permalink_url", body, &result)
			return result, err
		}

		// Facebook exposes no official preset list and adds/retires backgrounds
		// over time, so a stale text_format_preset_id can make FB reject the whole
		// post. Observed Graph API responses for a bad preset:
		//   - malformed id  -> HTTP 400, code 100, message names
		//                      "text_format_preset_id" explicitly
		//   - retired numeric id -> HTTP 500, code 1, generic "unknown error"
		//     (a 500 to a publish is UNKNOWN_DELIVERY and is never resent: the
		//     post may exist, so it is not retried without the preset either)
		// So retry once without the preset on a refusal that names the preset or
		// is generic, but never on a recognized auth/token error (dropping the
		// background can't fix that). A retry that only succeeds once the preset
		// is removed confirms the preset was the cause.
		result, err := publishFeed(presetID != "")
		if err != nil {
			if presetID == "" || !isPresetRejection(err) {
				return nil, err
			}
			// Surface the (recovered) rejection in the logs, since the fallback
			// below makes the activity succeed and Facebook's error would otherwise
			// be swallowed silently.
			slog.Warn("Facebook rejected text_format_preset_id — dropping the background and publishing as plain text",
				"preset", presetID, "facebook", failureJSON(err), "message", temporalx.FailureMessage(err))
			if result, err = publishFeed(false); err != nil {
				return nil, err
			}
		}
		finalURL = result.PermalinkURL
		finalID = result.ID
	}

	return []integrations.PostResponse{{ID: firstPost.ID, PostID: finalID, ReleaseURL: finalURL, Status: "success"}}, nil
}

type feedResult struct {
	ID           string `json:"id"`
	PermalinkURL string `json:"permalink_url"`
}

var (
	authRejection   = regexp.MustCompile(`(?i)access token|re-authenticate|revoked|"code":\s*190\b`)
	presetRejection = regexp.MustCompile(`(?i)text_format_preset_id`)
	codeOne         = regexp.MustCompile(`"code":\s*1\b`)
)

func failureJSON(err error) string {
	var app *temporal.ApplicationError
	if !errors.As(err, &app) || !app.HasDetails() {
		return ""
	}
	var details temporalx.FailureDetails
	if app.Details(&details) != nil {
		return ""
	}
	return details.JSON
}

func isPresetRejection(err error) bool {
	message := temporalx.FailureMessage(err)
	detail := failureJSON(err) + " " + message
	if authRejection.MatchString(detail) {
		return false
	}
	return presetRejection.MatchString(detail) || codeOne.MatchString(detail) || message == "Unknown Error"
}

func (p *Provider) Comment(ctx context.Context, id, postID, lastCommentID, accessToken string, posts []integrations.PostDetails, _ *ent.Integration) ([]integrations.PostResponse, error) {
	commentPost := posts[0]
	replyToID := lastCommentID
	if replyToID == "" {
		replyToID = postID
	}
	body := struct {
		AttachmentURL string `json:"attachment_url,omitempty"`
		Message       string `json:"message"`
	}{Message: commentPost.Message}
	if len(commentPost.Media) > 0 {
		body.AttachmentURL = commentPost.Media[0].Path
	}
	var data feedResult
	if err := p.postJSON(ctx, graph()+"/"+replyToID+"/comments?access_token="+accessToken+"&fields=id,permalink_url", body, &data); err != nil {
		return nil, err
	}
	return []integrations.PostResponse{{ID: commentPost.ID, PostID: data.ID, ReleaseURL: data.PermalinkURL, Status: "success"}}, nil
}

type insightValue struct {
	Value   json.RawMessage `json:"value"`
	EndTime string          `json:"end_time"`
}

type insight struct {
	Name   string         `json:"name"`
	Values []insightValue `json:"values"`
}

func (p *Provider) Analytics(ctx context.Context, id, accessToken string, days int) ([]integrations.AnalyticsData, error) {
	now := time.Now()
	until := time.Date(now.Year(), now.Month(), now.Day(), 23, 59, 59, 999999999, now.Location()).Unix()
	since := now.AddDate(0, 0, -days).Unix()

	// Reach/impression metrics (page_impressions_unique, page_posts_impressions_unique,
	// page_video_views) were deprecated by Meta on 2026-06-15 and now return an
	// "invalid metric" error. They are replaced by the Media Views metrics, which
	// require Graph API v23.0+:
	//   - page_total_media_view_unique: total unique views on the page's media (reach)
	//   - page_media_view: total media views, broken down between paid and organic
	var res struct {
		Data  []insight       `json:"data"`
		Error json.RawMessage `json:"error"`
	}
	if err := GetJSON(ctx, graph()+"/"+id+"/insights?metric=page_total_media_view_unique,page_media_view,page_post_engagements,page_daily_follows&access_token="+accessToken+"&period=day&since="+strconv.FormatInt(since, 10)+"&until="+strconv.FormatInt(until, 10), &res); err != nil {
		return nil, err
	}

	// Throw so checkAnalytics doesn't cache the empty result for an hour.
	if len(res.Error) > 0 && string(res.Error) != "null" {
		slog.Warn("Facebook page insights returned an error:", "id", id, "error", string(res.Error))
		var e struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(res.Error, &e)
		return nil, errors.New(e.Message)
	}

	out := []integrations.AnalyticsData{}
	for _, d := range res.Data {
		label := "Media views"
		switch d.Name {
		case "page_total_media_view_unique":
			label = "Page Impressions"
		case "page_post_engagements":
			label = "Posts Engagement"
		case "page_daily_follows":
			label = "Page followers"
		}
		var items []integrations.AnalyticsItem
		for _, v := range d.Values {
			// page_media_view returns paid/organic breakdowns as an object; sum
			// them to keep the single-total UI working.
			items = append(items, integrations.AnalyticsItem{Total: FormatNumber(sumValue(v.Value)), Date: DayOf(v.EndTime)})
		}
		out = append(out, integrations.AnalyticsData{Label: label, PercentageChange: 5, Data: items})
	}
	return out, nil
}

func (p *Provider) PostAnalytics(ctx context.Context, _ string, accessToken, postID string, _ int64) ([]integrations.AnalyticsData, error) {
	today := time.Now().Format("2006-01-02")

	// The stored id (releaseId) shape depends on the post type set in post():
	//   - feed post  -> `{pageid}_{postid}` (contains `_`), has an `insights` edge
	//   - reel/video -> bare numeric video id, NO `insights` edge (only `video_insights`)
	//   - story      -> bare story id, no usable insights via this path
	// There is no separate stored type, so id shape is the discriminator. Calling
	// `/{videoId}/insights` on a video/story node returns
	// `(#100) Tried accessing nonexisting field (insights)`. Route bare ids to
	// the video-only edge instead.
	if !strings.Contains(postID, "_") {
		return p.videoPostAnalytics(ctx, accessToken, postID, today), nil
	}

	// post_impressions_unique was deprecated by Meta on 2026-06-15; it is replaced
	// by post_total_media_view_unique (unique media views = reach), available on
	// Graph API v23.0+. Engagement metrics below are unaffected.
	var res struct {
		Data []insight `json:"data"`
	}
	if err := GetJSON(ctx, graph()+"/"+postID+"/insights?metric=post_total_media_view_unique,post_reactions_by_type_total,post_clicks,post_clicks_by_type&access_token="+accessToken, &res); err != nil {
		slog.Error("Error fetching Facebook post analytics:", "error", err)
		return []integrations.AnalyticsData{}, nil
	}

	result := []integrations.AnalyticsData{}
	for _, metric := range res.Data {
		value, ok := firstValue(metric)
		if !ok {
			continue
		}
		label, total := "", ""
		switch metric.Name {
		case "post_total_media_view_unique":
			label, total = "Impressions", JSString(value)
		case "post_clicks":
			label, total = "Clicks", JSString(value)
		case "post_clicks_by_type":
			// This returns an object with click types
			if obj, isObj := value.(map[string]any); isObj {
				label, total = "Clicks by Type", FormatNumber(sumObject(obj))
			}
		case "post_reactions_by_type_total":
			// This returns an object with reaction types
			if obj, isObj := value.(map[string]any); isObj {
				label, total = "Reactions", FormatNumber(sumObject(obj))
			}
		}
		if label != "" {
			result = append(result, integrations.AnalyticsData{Label: label, Data: []integrations.AnalyticsItem{{Total: total, Date: today}}})
		}
	}
	return result, nil
}

// Video/reel posts store a bare video id whose node has no `insights` edge; their
// analytics live on the `/{videoId}/video_insights` edge instead. Story posts also
// store a bare id but have no usable insights here — the video_insights call comes
// back with an `error` (or empty data), which we swallow to an empty result so a
// single story/video can't break the statistics page.
func (p *Provider) videoPostAnalytics(ctx context.Context, accessToken, videoID, today string) []integrations.AnalyticsData {
	// Metric names verified against the Graph API v23.0 video_insights docs:
	//   - total_video_impressions: times the video was shown
	//   - total_video_views: 3s+ (or full, if shorter) plays
	//   - total_video_reactions_by_type_total: reactions object, keyed by type
	// Reels never return the total_video_* metrics (the edge answers with an
	// empty data array), only the reels ones, so both sets are requested at
	// once and Graph simply omits the metrics that don't apply:
	//   - fb_reels_total_plays: plays including replays
	//   - post_video_likes_by_reaction_type: reactions object, keyed by type
	//   - post_video_social_actions: comments/shares object, keyed by type
	// Use a plain fetch (not p.Fetch) so a `(#100) nonexisting field` / story
	// response doesn't throw an ApplicationFailure — we want a quiet `[]` instead.
	var res struct {
		Data  []insight `json:"data"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := GetJSON(ctx, graph()+"/"+videoID+"/video_insights?metric=total_video_impressions,total_video_views,total_video_reactions_by_type_total,fb_reels_total_plays,post_video_likes_by_reaction_type,post_video_social_actions&access_token="+accessToken, &res); err != nil {
		slog.Error("Error fetching Facebook video post analytics:", "error", err)
		return []integrations.AnalyticsData{}
	}

	// Stories (and videos without this edge) come back with an error / no data —
	// return an empty result quietly. But a `nonexisting field (video_insights)`
	// is the only "expected" error here; any other error (bad metric name, token,
	// permissions) is surfaced as a warning so it's diagnosable without breaking
	// the statistics page.
	if res.Error != nil || len(res.Data) == 0 {
		if res.Error != nil && !strings.Contains(strings.ToLower(res.Error.Message), "nonexisting field") {
			slog.Warn("Facebook video_insights returned an error:", "videoId", videoID, "error", res.Error.Message)
		}
		return []integrations.AnalyticsData{}
	}

	result := []integrations.AnalyticsData{}
	for _, metric := range res.Data {
		value, ok := firstValue(metric)
		if !ok {
			continue
		}
		label, total := "", ""
		switch metric.Name {
		case "total_video_impressions":
			label, total = "Impressions", JSString(value)
		case "total_video_views":
			label, total = "Views", JSString(value)
		case "fb_reels_total_plays":
			label, total = "Plays", JSString(value)
		case "total_video_reactions_by_type_total", "post_video_likes_by_reaction_type":
			// This returns an object with reaction types
			if obj, isObj := value.(map[string]any); isObj {
				label, total = "Reactions", FormatNumber(sumObject(obj))
			}
		case "post_video_social_actions":
			// This returns an object with action types (comments, shares)
			if obj, isObj := value.(map[string]any); isObj {
				label, total = "Engagement", FormatNumber(sumObject(obj))
			}
		}
		if label != "" {
			result = append(result, integrations.AnalyticsData{Label: label, Data: []integrations.AnalyticsItem{{Total: total, Date: today}}})
		}
	}
	return result
}

// firstValue is `metric.values?.[0]?.value`, ok=false when undefined.
func firstValue(metric insight) (any, bool) {
	if len(metric.Values) == 0 || len(metric.Values[0].Value) == 0 {
		return nil, false
	}
	var v any
	_ = json.Unmarshal(metric.Values[0].Value, &v)
	return v, true
}

func sumObject(obj map[string]any) float64 {
	sum := 0.0
	for _, v := range obj {
		sum += jsNumber(v)
	}
	return sum
}

func sumValue(raw json.RawMessage) float64 {
	var v any
	_ = json.Unmarshal(raw, &v)
	if obj, ok := v.(map[string]any); ok {
		return sumObject(obj)
	}
	return jsNumber(v)
}

// jsNumber is `Number(v) || 0`.
func jsNumber(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case bool:
		if n {
			return 1
		}
	case string:
		if f, err := strconv.ParseFloat(strings.TrimSpace(n), 64); err == nil {
			return f
		}
	}
	return 0
}

// JSString is JavaScript's String(v) for JSON values.
func JSString(v any) string {
	switch s := v.(type) {
	case nil:
		return "null"
	case string:
		return s
	case float64:
		return FormatNumber(s)
	case bool:
		return strconv.FormatBool(s)
	case map[string]any:
		return "[object Object]"
	}
	return fmt.Sprint(v)
}

// FormatNumber prints a number like JavaScript does.
func FormatNumber(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

// DayOf is dayjs(endTime).format('YYYY-MM-DD') in the server's time zone.
func DayOf(endTime string) string {
	for _, layout := range []string{"2006-01-02T15:04:05-0700", time.RFC3339Nano, "2006-01-02"} {
		if t, err := time.Parse(layout, endTime); err == nil {
			return t.In(time.Local).Format("2006-01-02")
		}
	}
	return "Invalid Date"
}

// jsLength is a JavaScript string's .length (UTF-16 code units).
func jsLength(s string) int { return len(utf16.Encode([]rune(s))) }

// EncodeURIComponent is JavaScript's encodeURIComponent.
func EncodeURIComponent(s string) string {
	return strings.NewReplacer("+", "%20", "%21", "!", "%27", "'", "%28", "(", "%29", ")", "%2A", "*").Replace(url.QueryEscape(s))
}

// GetJSON is a plain `(await fetch(url)).json()`: no SSRF dispatcher, no
// retries, and HTTP errors are not thrown — the body is decoded either way.
func GetJSON(ctx context.Context, rawURL string, v any) error {
	return getJSON(ctx, rawURL, v, false)
}

// GetJSONChecked propagates HTTP failures for analytics callers.
func GetJSONChecked(ctx context.Context, rawURL string, v any) error {
	return getJSON(ctx, rawURL, v, true)
}

func getJSON(ctx context.Context, rawURL string, v any, checked bool) error {
	temporalx.SetHeartbeatDetails(ctx, "fetch "+temporalx.StripQuery(rawURL))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if checked {
		if err := integrations.CheckResponse(res); err != nil {
			return err
		}
	}
	return json.NewDecoder(res.Body).Decode(v)
}

// All is Promise.all: fn runs for every item concurrently, results keep the
// input order, and the first error (by index) is returned.
func All[T, R any](items []T, fn func(T) (R, error)) ([]R, error) {
	out := make([]R, len(items))
	errs := make([]error, len(items))
	var wg sync.WaitGroup
	for i, item := range items {
		wg.Go(func() { out[i], errs[i] = fn(item) })
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}
