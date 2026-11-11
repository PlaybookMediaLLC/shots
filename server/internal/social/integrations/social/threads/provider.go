// Package threads is the Threads provider.
package threads

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/helpers"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ids"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ssrf"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
)

const identifier = "threads"

// Overridden by tests.
var (
	graphURL     = "https://graph.threads.net"
	loadedDelay  = 2000 * time.Millisecond
	pollInterval = 2200 * time.Millisecond
	plugDelay    = 2000 * time.Millisecond
)

var scopes = []string{
	"threads_basic",
	"threads_content_publish",
	"threads_manage_replies",
	"threads_manage_insights",
	// "threads_profile_discovery",
}

type Provider struct {
	*integrations.Base
}

var (
	_ integrations.Provider      = (*Provider)(nil)
	_ integrations.PendingPoster = (*Provider)(nil)
	_ integrations.Commenter     = (*Provider)(nil)
	_ integrations.Analytics     = (*Provider)(nil)
	_ integrations.PostAnalytics = (*Provider)(nil)
)

func New() *Provider {
	return &Provider{Base: integrations.NewBase(identifier, handleErrors)}
}

func (p *Provider) Info() integrations.Info {
	return integrations.Info{
		Identifier:  identifier,
		Name:        "Threads",
		Editor:      "normal",
		Scopes:      scopes,
		RefreshCron: true,
		// Threads limits are per profile
		MaxConcurrentJob: 20,
	}
}

func (p *Provider) MaxLength([]integrations.AdditionalSetting, json.RawMessage) int { return 500 }

func handleErrors(body string, _ int) *integrations.HandledError {
	switch {
	case strings.Contains(body, "Error validating access token"):
		return &integrations.HandledError{Type: "refresh-token", Value: "Threads access token expired"}
	case strings.Contains(body, "2207051"):
		return &integrations.HandledError{Type: "bad-body", Value: "Error from Meta: We restrict certain activity to protect our community"}
	case strings.Contains(body, "4279013"):
		return &integrations.HandledError{Type: "bad-body", Value: "User restricted"}
	case strings.Contains(body, "The media could not be fetched from this URI"):
		return &integrations.HandledError{Type: "bad-body", Value: "One of the media URLs is invalid or inaccessible, make sure it's being upload to Shots first"}
	case strings.Contains(body, "4279009"):
		return &integrations.HandledError{Type: "retry", Value: "Threads could not find the media container yet, please try again in a few seconds"}
	case strings.Contains(body, "text must be at most 500 characters"):
		return &integrations.HandledError{Type: "bad-body", Value: "Post text exceeds 500 characters limit"}
	}
	return nil
}

// getJSON is `(await this.fetch(url, {method})).json()`.
func (p *Provider) getJSON(ctx context.Context, method, rawURL string, body []byte, contentType string, out any) error {
	// A container (/threads?) stays invisible until threads_publish, so it may
	// be resent after a server error; threads_publish may not.
	req := integrations.Request{Method: method, Body: body, Retryable: strings.Contains(rawURL, "/threads?")}
	if contentType != "" {
		req.Headers = map[string]string{"Content-Type": contentType}
	}
	res, err := p.Fetch(ctx, rawURL, req)
	if err != nil {
		return err
	}
	return res.JSON(out)
}

// expiresIn is dayjs().add(58, 'days').unix() - dayjs().unix().
func expiresIn() int64 {
	now := time.Now()
	return now.AddDate(0, 0, 58).Unix() - now.Unix()
}

func (p *Provider) RefreshToken(ctx context.Context, refreshToken string) (*integrations.AuthTokenDetails, error) {
	var token struct {
		AccessToken string `json:"access_token"`
	}
	if err := p.getJSON(ctx, http.MethodGet, graphURL+"/refresh_access_token?grant_type=th_refresh_token&access_token="+refreshToken, nil, "", &token); err != nil {
		return nil, err
	}
	user, err := p.fetchUserInfo(ctx, token.AccessToken)
	if err != nil {
		return nil, err
	}
	return &integrations.AuthTokenDetails{
		ID: user.ID, Name: user.Name, AccessToken: token.AccessToken, RefreshToken: token.AccessToken,
		ExpiresIn: expiresIn(), Picture: user.Picture, Username: "",
	}, nil
}

func redirectURI() string {
	frontend := os.Getenv("FRONTEND_URL")
	if !strings.Contains(frontend, "https") {
		frontend = "https://redirectmeto.com/" + frontend
	}
	return url.QueryEscape(frontend + "/integrations/social/threads")
}

func (p *Provider) GenerateAuthURL(context.Context, *integrations.ClientInformation) (*integrations.GenerateAuthURLResponse, error) {
	state := ids.Secure(6)
	return &integrations.GenerateAuthURLResponse{
		URL: "https://www.threads.net/oauth/authorize" +
			"?client_id=" + os.Getenv("THREADS_APP_ID") +
			"&redirect_uri=" + redirectURI() +
			"&state=" + state +
			"&scope=" + url.QueryEscape(strings.Join(scopes, ",")),
		CodeVerifier: ids.Secure(10),
		State:        state,
	}, nil
}

func (p *Provider) Authenticate(ctx context.Context, params integrations.AuthenticateParams, _ *integrations.ClientInformation) (*integrations.AuthTokenDetails, error) {
	var short struct {
		AccessToken string `json:"access_token"`
	}
	if err := p.getJSON(ctx, http.MethodGet, graphURL+"/oauth/access_token"+
		"?client_id="+os.Getenv("THREADS_APP_ID")+
		"&redirect_uri="+redirectURI()+
		"&grant_type=authorization_code"+
		"&client_secret="+os.Getenv("THREADS_APP_SECRET")+
		"&code="+params.Code, nil, "", &short); err != nil {
		return nil, err
	}

	var long struct {
		AccessToken string `json:"access_token"`
	}
	if err := p.getJSON(ctx, http.MethodGet, graphURL+"/access_token"+
		"?grant_type=th_exchange_token"+
		"&client_secret="+os.Getenv("THREADS_APP_SECRET")+
		"&access_token="+short.AccessToken, nil, "", &long); err != nil {
		return nil, err
	}

	user, err := p.fetchUserInfo(ctx, long.AccessToken)
	if err != nil {
		return nil, err
	}
	return &integrations.AuthTokenDetails{
		ID: user.ID, Name: user.Name, AccessToken: long.AccessToken, RefreshToken: long.AccessToken,
		ExpiresIn: expiresIn(), Picture: user.Picture, Username: user.Username,
	}, nil
}

// checkContainerStatus is a single, read-only status check of a media
// container - no loops and no timers, so the post workflow can poll it with
// durable timers. It answers FINISHED, PUBLISHED or IN_PROGRESS.
func (p *Provider) checkContainerStatus(ctx context.Context, mediaContainerID, accessToken string) (string, error) {
	var res struct {
		Status       string `json:"status"`
		ErrorMessage string `json:"error_message"`
	}
	if err := p.getJSON(ctx, http.MethodGet, graphURL+"/v1.0/"+mediaContainerID+"?fields=status,error_message&access_token="+accessToken, nil, "", &res); err != nil {
		return "", err
	}

	if res.Status == "ERROR" || res.Status == "EXPIRED" {
		details := map[string]any{"status": res.Status}
		if res.ErrorMessage != "" {
			details["error_message"] = res.ErrorMessage
		}
		message := "Threads could not process the media, please check the media format and try again"
		if res.ErrorMessage != "" && res.ErrorMessage != "UNKNOWN" {
			message = res.ErrorMessage
		}
		raw, _ := json.Marshal(details)
		return "", temporalx.BadBody(identifier, string(raw), "{}", message)
	}
	if res.Status == "FINISHED" || res.Status == "PUBLISHED" {
		return res.Status, nil
	}
	return "IN_PROGRESS", nil
}

func (p *Provider) checkLoaded(ctx context.Context, mediaContainerID, accessToken string) error {
	// Bounded (the old version recursed forever and could hang the activity
	// into a timeout): ~5.5 minutes at 2.2s intervals.
	for i := 0; i < 150; i++ {
		status, err := p.checkContainerStatus(ctx, mediaContainerID, accessToken)
		if err != nil {
			return err
		}
		if status == "FINISHED" || status == "PUBLISHED" {
			return p.Sleep(ctx, loadedDelay)
		}
		if err := p.Sleep(ctx, pollInterval); err != nil {
			return err
		}
	}
	return temporalx.BadBody(identifier, "{}", "{}", "Threads took too long to process the media, please try again")
}

type userInfo struct {
	ID, Name, Picture, Username string
}

func (p *Provider) fetchUserInfo(ctx context.Context, accessToken string) (*userInfo, error) {
	var res struct {
		ID                       string `json:"id"`
		Username                 string `json:"username"`
		ThreadsProfilePictureURL string `json:"threads_profile_picture_url"`
	}
	if err := p.getJSON(ctx, http.MethodGet, graphURL+"/v1.0/me?fields=id,username,threads_profile_picture_url&access_token="+accessToken, nil, "", &res); err != nil {
		return nil, err
	}
	return &userInfo{ID: res.ID, Name: res.Username, Picture: res.ThreadsProfilePictureURL, Username: res.Username}, nil
}

type idResponse struct {
	ID string `json:"id"`
}

// params encodes pairs in order, like URLSearchParams.
func params(pairs ...string) string {
	var b strings.Builder
	for i := 0; i+1 < len(pairs); i += 2 {
		if i > 0 {
			b.WriteByte('&')
		}
		b.WriteString(url.QueryEscape(pairs[i]) + "=" + url.QueryEscape(pairs[i+1]))
	}
	return b.String()
}

func (p *Provider) createSingleMediaContent(ctx context.Context, userID, accessToken string, media integrations.MediaContent, message string, isCarouselItem bool, replyToID string) (string, error) {
	var pairs []string
	mediaType := "IMAGE"
	if media.Type == "video" || helpers.HasExtension(media.Path, "mp4") {
		mediaType = "VIDEO"
		pairs = append(pairs, "video_url", media.Path)
	} else {
		pairs = append(pairs, "image_url", media.Path)
	}
	if isCarouselItem {
		pairs = append(pairs, "is_carousel_item", "true")
	}
	if replyToID != "" {
		pairs = append(pairs, "reply_to_id", replyToID)
	}
	pairs = append(pairs, "media_type", mediaType, "text", message, "access_token", accessToken)

	var res idResponse
	if err := p.getJSON(ctx, http.MethodPost, graphURL+"/v1.0/"+userID+"/threads?"+params(pairs...), nil, "", &res); err != nil {
		return "", err
	}
	return res.ID, nil
}

func (p *Provider) createCarouselContent(ctx context.Context, userID, accessToken string, media []integrations.MediaContent, message, replyToID string) (string, error) {
	// Create each media item
	var mediaIDs []string
	for _, item := range media {
		mediaID, err := p.createSingleMediaContent(ctx, userID, accessToken, item, message, true, "")
		if err != nil {
			return "", err
		}
		mediaIDs = append(mediaIDs, mediaID)
	}

	// Wait for all media to be loaded (Promise.all: the first error wins)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var (
		wg       sync.WaitGroup
		once     sync.Once
		firstErr error
	)
	for _, id := range mediaIDs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := p.checkLoaded(ctx, id, accessToken); err != nil {
				once.Do(func() { firstErr = err; cancel() })
			}
		}()
	}
	wg.Wait()
	if firstErr != nil {
		return "", firstErr
	}

	// Create carousel container
	pairs := []string{"text", message, "media_type", "CAROUSEL", "children", strings.Join(mediaIDs, ",")}
	if replyToID != "" {
		pairs = append(pairs, "reply_to_id", replyToID)
	}
	pairs = append(pairs, "access_token", accessToken)
	var res idResponse
	if err := p.getJSON(ctx, http.MethodPost, graphURL+"/v1.0/"+userID+"/threads?"+params(pairs...), nil, "", &res); err != nil {
		return "", err
	}
	return res.ID, nil
}

// multipartForm builds a FormData body from ordered pairs.
func multipartForm(pairs ...string) ([]byte, string) {
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	for i := 0; i+1 < len(pairs); i += 2 {
		_ = w.WriteField(pairs[i], pairs[i+1])
	}
	_ = w.Close()
	return buf.Bytes(), w.FormDataContentType()
}

func (p *Provider) createTextContent(ctx context.Context, userID, accessToken, message, replyToID, quoteID string, poll string) (string, error) {
	pairs := []string{"media_type", "TEXT", "text", message, "access_token", accessToken}
	if poll != "" {
		pairs = append(pairs, "poll_attachment", poll)
	}
	if replyToID != "" {
		pairs = append(pairs, "reply_to_id", replyToID)
	}
	if quoteID != "" {
		pairs = append(pairs, "quote_post_id", quoteID)
	}
	body, contentType := multipartForm(pairs...)
	var res idResponse
	if err := p.getJSON(ctx, http.MethodPost, graphURL+"/v1.0/"+userID+"/threads", body, contentType, &res); err != nil {
		return "", err
	}
	return res.ID, nil
}

func (p *Provider) publishThread(ctx context.Context, userID, accessToken, creationID string, integration *ent.Integration) (threadID, permalink string, err error) {
	if err := p.checkLoaded(ctx, creationID, accessToken); err != nil {
		return "", "", err
	}
	var published idResponse
	if err := p.getJSON(ctx, http.MethodPost, graphURL+"/v1.0/"+userID+"/threads_publish?creation_id="+creationID+"&access_token="+accessToken, nil, "", &published); err != nil {
		return "", "", err
	}
	return published.ID, p.threadPermalink(ctx, published.ID, accessToken, integration), nil
}

func (p *Provider) createThreadContent(ctx context.Context, userID, accessToken string, post integrations.PostDetails, replyToID, quoteID string) (string, error) {
	poll, err := pollAttachment(post)
	if err != nil {
		return "", err
	}
	switch len(post.Media) {
	case 0:
		// Text-only content
		return p.createTextContent(ctx, userID, accessToken, post.Message, replyToID, quoteID, poll)
	case 1:
		// Single media content
		return p.createSingleMediaContent(ctx, userID, accessToken, post.Media[0], post.Message, false, replyToID)
	default:
		// Carousel content
		return p.createCarouselContent(ctx, userID, accessToken, post.Media, post.Message, replyToID)
	}
}

func profileURL(integration *ent.Integration) string {
	profile := "null"
	if integration != nil && integration.Profile != nil {
		profile = *integration.Profile
	}
	return "https://www.threads.net/@" + profile
}

// threadPermalink: the thread is live, the permalink is only cosmetic: never
// fail (and risk re-publishing) a live post over it.
func (p *Provider) threadPermalink(ctx context.Context, threadID, accessToken string, integration *ent.Integration) string {
	var link struct {
		Permalink string `json:"permalink"`
	}
	if err := p.getJSON(ctx, http.MethodGet, graphURL+"/v1.0/"+threadID+"?fields=id,permalink&access_token="+accessToken, nil, "", &link); err != nil {
		return profileURL(integration)
	}
	return link.Permalink
}

// PendingData travels through the workflow between postPending,
// checkPostStatus and finalizePost.
type PendingData struct {
	Step        string   `json:"step"` // children | container
	ChildIDs    []string `json:"childIds,omitempty"`
	ContainerID string   `json:"containerId,omitempty"`
	Message     string   `json:"message,omitempty"`
}

func marshalPending(status string, data PendingData) (*integrations.PendingCheckResponse, error) {
	raw, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	return &integrations.PendingCheckResponse{Status: status, PendingData: raw}, nil
}

func (p *Provider) PostPending(ctx context.Context, userID, accessToken string, posts []integrations.PostDetails, _ *ent.Integration) ([]integrations.PostResponse, error) {
	if len(posts) == 0 {
		return []integrations.PostResponse{}, nil
	}
	firstPost := posts[0]
	poll, pollErr := pollAttachment(firstPost)
	if pollErr != nil {
		return nil, pollErr
	}

	// Carousels: only create the child containers here, the carousel container
	// itself is created by finalizePost once the children are processed.
	if len(firstPost.Media) > 1 {
		childIDs := []string{}
		for _, item := range firstPost.Media {
			id, err := p.createSingleMediaContent(ctx, userID, accessToken, item, firstPost.Message, true, "")
			if err != nil {
				return nil, err
			}
			childIDs = append(childIDs, id)
		}
		raw, err := json.Marshal(PendingData{Step: "children", ChildIDs: childIDs, Message: firstPost.Message})
		if err != nil {
			return nil, err
		}
		return []integrations.PostResponse{{ID: firstPost.ID, Status: "pending", PendingData: raw}}, nil
	}

	// Text / single media: one container, nothing is visible until
	// threads_publish runs in finalizePost.
	var (
		containerID string
		err         error
	)
	if len(firstPost.Media) == 0 {
		containerID, err = p.createTextContent(ctx, userID, accessToken, firstPost.Message, "", "", poll)
	} else {
		containerID, err = p.createSingleMediaContent(ctx, userID, accessToken, firstPost.Media[0], firstPost.Message, false, "")
	}
	if err != nil {
		return nil, err
	}
	raw, err := json.Marshal(PendingData{Step: "container", ContainerID: containerID})
	if err != nil {
		return nil, err
	}
	return []integrations.PostResponse{{ID: firstPost.ID, Status: "pending", PendingData: raw}}, nil
}

func (p *Provider) CheckPostStatus(ctx context.Context, accessToken string, pendingData json.RawMessage, integration *ent.Integration) (*integrations.PendingCheckResponse, error) {
	var data PendingData
	if err := json.Unmarshal(pendingData, &data); err != nil {
		return nil, err
	}

	// waiting for the carousel children to be processed
	if data.Step == "children" {
		for _, childID := range data.ChildIDs {
			status, err := p.checkContainerStatus(ctx, childID, accessToken)
			if err != nil {
				return nil, err
			}
			if status == "IN_PROGRESS" {
				return &integrations.PendingCheckResponse{Status: "pending", PendingData: pendingData}, nil
			}
		}
		// all children processed, finalizePost creates the carousel container
		return &integrations.PendingCheckResponse{Status: "ready", PendingData: pendingData}, nil
	}

	status, err := p.checkContainerStatus(ctx, data.ContainerID, accessToken)
	if err != nil {
		return nil, err
	}
	if status == "IN_PROGRESS" {
		return &integrations.PendingCheckResponse{Status: "pending", PendingData: pendingData}, nil
	}

	// a previous finalizePost published but died before reporting: the post is
	// live, never publish again
	if status == "PUBLISHED" {
		return &integrations.PendingCheckResponse{Status: "completed", PostID: data.ContainerID, ReleaseURL: profileURL(integration)}, nil
	}
	return &integrations.PendingCheckResponse{Status: "ready", PendingData: pendingData}, nil
}

func (p *Provider) FinalizePost(ctx context.Context, accessToken string, pendingData json.RawMessage, integration *ent.Integration) (*integrations.PendingCheckResponse, error) {
	var data PendingData
	if err := json.Unmarshal(pendingData, &data); err != nil {
		return nil, err
	}

	// the carousel children are processed: create the carousel container and
	// hand back to the workflow to wait for it (an orphan container from a
	// crashed run is invisible, so re-running this is safe)
	if data.Step == "children" {
		var res idResponse
		if err := p.getJSON(ctx, http.MethodPost, graphURL+"/v1.0/"+integration.InternalID+"/threads?"+params(
			"text", data.Message,
			"media_type", "CAROUSEL",
			"children", strings.Join(data.ChildIDs, ","),
			"access_token", accessToken,
		), nil, "", &res); err != nil {
			return nil, err
		}
		return marshalPending("pending", PendingData{Step: "container", ContainerID: res.ID})
	}

	var published idResponse
	if err := p.getJSON(ctx, http.MethodPost, graphURL+"/v1.0/"+integration.InternalID+"/threads_publish?creation_id="+data.ContainerID+"&access_token="+accessToken, nil, "", &published); err != nil {
		return nil, err
	}
	return &integrations.PendingCheckResponse{
		Status:     "completed",
		PostID:     published.ID,
		ReleaseURL: p.threadPermalink(ctx, published.ID, accessToken, integration),
	}, nil
}

// Post is the old blocking behavior, kept for workflow versions before v1.0.6
// that don't know how to resolve a `pending` response.
func (p *Provider) Post(ctx context.Context, userID, accessToken string, posts []integrations.PostDetails, integration *ent.Integration) ([]integrations.PostResponse, error) {
	if len(posts) == 0 {
		return []integrations.PostResponse{}, nil
	}
	responses, err := p.PostPending(ctx, userID, accessToken, posts, integration)
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
			return nil, temporalx.BadBody(identifier, "{}", "{}", "Threads took too long to process the media, please try again")
		}

		check, err := p.CheckPostStatus(ctx, accessToken, pendingData, integration)
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
			if result, err = p.FinalizePost(ctx, accessToken, check.PendingData, integration); err != nil {
				return nil, err
			}
		}
		if result.Status == "completed" {
			return []integrations.PostResponse{{ID: posts[0].ID, PostID: result.PostID, Status: "success", ReleaseURL: result.ReleaseURL}}, nil
		}

		pendingData = result.PendingData
		if err := p.Sleep(ctx, pollInterval); err != nil {
			return nil, err
		}
	}
}

func (p *Provider) Comment(ctx context.Context, userID, postID, lastCommentID, accessToken string, posts []integrations.PostDetails, integration *ent.Integration) ([]integrations.PostResponse, error) {
	if len(posts) == 0 {
		return []integrations.PostResponse{}, nil
	}
	commentPost := posts[0]
	replyToID := lastCommentID
	if replyToID == "" {
		replyToID = postID
	}

	// Create reply content
	replyContentID, err := p.createThreadContent(ctx, userID, accessToken, commentPost, replyToID, "")
	if err != nil {
		return nil, err
	}

	// Publish the reply
	replyThreadID, permalink, err := p.publishThread(ctx, userID, accessToken, replyContentID, integration)
	if err != nil {
		return nil, err
	}
	return []integrations.PostResponse{{ID: commentPost.ID, PostID: replyThreadID, Status: "success", ReleaseURL: permalink}}, nil
}

// rawJSON is the global fetch() (no retry/classification) followed by .json().
func rawJSON(ctx context.Context, rawURL string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	res, err := ssrf.Client().Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if err := integrations.CheckResponse(res); err != nil {
		return err
	}
	data, err := io.ReadAll(res.Body)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, out)
}

// number renders a JSON number like JavaScript's String(n).
func number(v any) string {
	switch t := v.(type) {
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case string:
		return t
	case nil:
		return "undefined"
	}
	return fmt.Sprint(v)
}

// capitalize is lodash capitalize.
func capitalize(s string) string {
	r := []rune(strings.ToLower(s))
	if len(r) == 0 {
		return ""
	}
	return strings.ToUpper(string(r[0])) + string(r[1:])
}

// dayjsDate formats a Graph API end_time in local time (dayjs(v).format).
func dayjsDate(value string) string {
	for _, layout := range []string{"2006-01-02T15:04:05-0700", time.RFC3339} {
		if t, err := time.Parse(layout, value); err == nil {
			return t.Local().Format("2006-01-02")
		}
	}
	return "Invalid Date"
}

func (p *Provider) Analytics(ctx context.Context, id, accessToken string, date int) ([]integrations.AnalyticsData, error) {
	now := time.Now()
	until := time.Date(now.Year(), now.Month(), now.Day(), 23, 59, 59, 999e6, now.Location()).Unix()
	since := now.AddDate(0, 0, -date).Unix()

	var res struct {
		Data []struct {
			Name       string `json:"name"`
			TotalValue *struct {
				Value any `json:"value"`
			} `json:"total_value"`
			Values []struct {
				Value   any    `json:"value"`
				EndTime string `json:"end_time"`
			} `json:"values"`
		} `json:"data"`
	}
	if err := integrations.ReadInsightsJSON(ctx, fmt.Sprintf("%s/v1.0/%s/threads_insights?metric=views,likes,replies,reposts,quotes&access_token=%s&period=day&since=%d&until=%d", graphURL, id, accessToken, since, until), &res); err != nil {
		return nil, err
	}

	out := []integrations.AnalyticsData{}
	for _, d := range res.Data {
		item := integrations.AnalyticsData{Label: capitalize(d.Name), Data: []integrations.AnalyticsItem{}}
		if d.TotalValue != nil {
			item.Data = append(item.Data, integrations.AnalyticsItem{Total: number(d.TotalValue.Value), Date: now.Format("2006-01-02")})
		} else {
			for _, v := range d.Values {
				item.Data = append(item.Data, integrations.AnalyticsItem{Total: number(v.Value), Date: dayjsDate(v.EndTime)})
			}
		}
		out = append(out, item)
	}
	return out, nil
}

var postMetricLabels = map[string]string{
	"views": "Views", "likes": "Likes", "replies": "Replies", "reposts": "Reposts", "quotes": "Quotes",
}

func (p *Provider) PostAnalytics(ctx context.Context, _, accessToken, postID string, _ int64) ([]integrations.AnalyticsData, error) {
	today := time.Now().Format("2006-01-02")

	// Fetch thread insights from Threads API
	var res struct {
		Data []struct {
			Name   string `json:"name"`
			Values []struct {
				Value any `json:"value"`
			} `json:"values"`
			TotalValue *struct {
				Value any `json:"value"`
			} `json:"total_value"`
		} `json:"data"`
	}
	if err := integrations.ReadInsightsJSON(ctx, graphURL+"/v1.0/"+postID+"/insights?metric=views,likes,replies,reposts,quotes&access_token="+accessToken, &res); err != nil {
		return nil, err
	}

	result := []integrations.AnalyticsData{}
	for _, metric := range res.Data {
		var value any
		if len(metric.Values) > 0 && metric.Values[0].Value != nil {
			value = metric.Values[0].Value
		} else if metric.TotalValue != nil {
			value = metric.TotalValue.Value
		}
		if value == nil {
			continue
		}
		if label := postMetricLabels[metric.Name]; label != "" {
			result = append(result, integrations.AnalyticsData{
				Label: label, PercentageChange: 0,
				Data: []integrations.AnalyticsItem{{Total: number(value), Date: today}},
			})
		}
	}
	return result, nil
}

// AutoPlugPost is the threads-autoPlugPost @Plug: once the post reached
// likesAmount likes, reply to it with the plug post.
func (p *Provider) AutoPlugPost(ctx context.Context, integration *ent.Integration, id string, fields map[string]string) (bool, error) {
	var res struct {
		Data []struct {
			Name   string `json:"name"`
			Values []struct {
				Value float64 `json:"value"`
			} `json:"values"`
		} `json:"data"`
	}
	if err := rawJSON(ctx, graphURL+"/v1.0/"+id+"/insights?metric=likes&access_token="+integration.Token, &res); err != nil {
		return false, err
	}

	var likes *float64
	for _, metric := range res.Data {
		if metric.Name == "likes" {
			if len(metric.Values) == 0 {
				return false, fmt.Errorf("threads: likes metric has no values")
			}
			likes = &metric.Values[0].Value
			break
		}
	}
	if likes == nil {
		return false, fmt.Errorf("threads: likes metric not found")
	}

	// JavaScript compares the number with the string field numerically; a
	// non-numeric field is NaN and never matches, an empty one is 0.
	threshold, err := 0.0, error(nil)
	if amount := strings.TrimSpace(fields["likesAmount"]); amount != "" {
		threshold, err = strconv.ParseFloat(amount, 64)
	}
	if err != nil || *likes < threshold {
		return false, nil
	}

	if err := p.Sleep(ctx, plugDelay); err != nil {
		return false, err
	}

	body, contentType := multipartForm(
		"media_type", "TEXT",
		"text", helpers.StripHTMLValidation("normal", fields["post"], helpers.StripOptions{ReplaceBold: true}),
		"reply_to_id", id,
		"access_token", integration.Token,
	)
	var reply idResponse
	if err := p.getJSON(ctx, http.MethodPost, graphURL+"/v1.0/me/threads", body, contentType, &reply); err != nil {
		return false, err
	}
	var published json.RawMessage
	if err := p.getJSON(ctx, http.MethodPost, graphURL+"/v1.0/"+integration.InternalID+"/threads_publish?creation_id="+reply.ID+"&access_token="+integration.Token, nil, "", &published); err != nil {
		return false, err
	}
	return true, nil
}

func (p *Provider) Plugs() []integrations.Plug {
	return []integrations.Plug{{
		MethodName:           "autoPlugPost",
		Identifier:           "threads-autoPlugPost",
		Title:                "Auto plug post",
		Description:          "When a post reached a certain number of likes, add another post to it so you followers get a notification about your promotion",
		RunEveryMilliseconds: 21600000,
		TotalRuns:            3,
		Fields: []integrations.PlugField{
			{Name: "likesAmount", Type: "number", Placeholder: "Amount of likes", Description: "The amount of likes to trigger the repost", Validation: `/^\d+$/`},
			{Name: "post", Type: "richtext", Placeholder: "Post to plug", Description: "Message content to plug", Validation: `/^[\s\S]{3,}$/g`},
		},
		Run: p.AutoPlugPost,
	}}
}
