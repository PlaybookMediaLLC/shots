// Package gmb is the Google Business Profile provider.
package gmb

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ids"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations/social/youtube/googleapi"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ssrf"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
)

const identifier = "gmb"

// API roots. Tests point them at an httptest server.
var (
	accountsAPI    = "https://mybusinessaccountmanagement.googleapis.com"
	informationAPI = "https://mybusinessbusinessinformation.googleapis.com"
	localPostsAPI  = "https://mybusiness.googleapis.com"
	performanceAPI = "https://businessprofileperformance.googleapis.com"
)

var scopes = []string{
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/business.manage",
}

type Provider struct {
	*integrations.Base
}

func New() *Provider {
	return &Provider{Base: integrations.NewBase(identifier, handleErrors)}
}

func (p *Provider) Info() integrations.Info {
	return integrations.Info{
		Identifier:       identifier,
		Name:             "Google My Business",
		Editor:           "normal",
		Scopes:           scopes,
		IsBetweenSteps:   true,
		MaxConcurrentJob: 3,
		Rules:            "Google My Business posts can have text content and optionally one image. Posts can be updates, events, or offers.",
	}
}

func (p *Provider) MaxLength([]integrations.AdditionalSetting, json.RawMessage) int { return 1500 }

func (p *Provider) SettingsDTO() any { return &SettingsDTO{} }

func (p *Provider) Functions() map[string]integrations.Function {
	return map[string]integrations.Function{
		"pages": func(ctx context.Context, token string, _ json.RawMessage, _ string, _ *ent.Integration) (any, error) {
			return p.Pages(ctx, token)
		},
		"fetchPageInformation": func(ctx context.Context, token string, data json.RawMessage, _ string, _ *ent.Integration) (any, error) {
			return p.FetchPageInformation(ctx, token, data)
		},
	}
}

func client() googleapi.OAuth2Client {
	id := os.Getenv("GOOGLE_GMB_CLIENT_ID")
	if id == "" {
		id = os.Getenv("YOUTUBE_CLIENT_ID")
	}
	secret := os.Getenv("GOOGLE_GMB_CLIENT_SECRET")
	if secret == "" {
		secret = os.Getenv("YOUTUBE_CLIENT_SECRET")
	}
	return googleapi.OAuth2Client{
		ClientID:     id,
		ClientSecret: secret,
		RedirectURI:  os.Getenv("FRONTEND_URL") + "/integrations/social/gmb",
	}
}

func decodeSettings(raw json.RawMessage) SettingsDTO {
	var settings SettingsDTO
	_ = json.Unmarshal(raw, &settings)
	return settings
}

func str(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func (p *Provider) CheckValidity(_ context.Context, items [][]integrations.ValidityMedia, raw json.RawMessage, _ []integrations.AdditionalSetting) (string, error) {
	// GMB posts can have text only, or text with one image
	if len(items) > 0 && len(items[0]) > 1 {
		return "Google My Business posts can only have one image", nil
	}
	// Check for video - GMB doesn't support video in local posts
	if len(items) > 0 && len(items[0]) > 0 && strings.Contains(items[0][0].Path, "mp4") {
		return "Google My Business posts do not support video attachments", nil
	}
	// Event posts require a title
	settings := decodeSettings(raw)
	if str(settings.TopicType) == "EVENT" && settings.EventTitle == "" {
		return "Event posts require an event title", nil
	}
	return "", nil
}

func handleErrors(body string, _ int) *integrations.HandledError {
	switch {
	case strings.Contains(body, "UNAUTHENTICATED") || strings.Contains(body, "invalid_grant"):
		return &integrations.HandledError{Type: "refresh-token", Value: "Please re-authenticate your Google My Business account"}
	case strings.Contains(body, "Unauthorized"):
		return &integrations.HandledError{Type: "refresh-token", Value: "Token expired or invalid, please reconnect your YouTube account."}
	case strings.Contains(body, "PERMISSION_DENIED"):
		return &integrations.HandledError{Type: "refresh-token", Value: "Permission denied. Please ensure you have access to this business location."}
	case strings.Contains(body, "NOT_FOUND"):
		return &integrations.HandledError{Type: "bad-body", Value: "Business location not found. It may have been deleted."}
	case strings.Contains(body, "INVALID_ARGUMENT"):
		return &integrations.HandledError{Type: "bad-body", Value: "Invalid post content. Please check your post details."}
	case strings.Contains(body, "RESOURCE_EXHAUSTED"):
		return &integrations.HandledError{Type: "bad-body", Value: "Rate limit exceeded. Please try again later."}
	}
	return nil
}

func (p *Provider) RefreshToken(ctx context.Context, refreshToken string) (*integrations.AuthTokenDetails, error) {
	tokens, err := client().RefreshAccessToken(ctx, refreshToken)
	if err != nil {
		return nil, err
	}
	user, err := googleapi.GetUserInfo(ctx, tokens.AccessToken)
	if err != nil {
		return nil, err
	}
	refresh := tokens.RefreshToken
	if refresh == "" {
		refresh = refreshToken
	}
	return &integrations.AuthTokenDetails{
		AccessToken:  tokens.AccessToken,
		ExpiresIn:    tokens.ExpiresIn,
		RefreshToken: refresh,
		ID:           user.ID,
		Name:         user.Name,
		Picture:      user.Picture,
		Username:     "",
	}, nil
}

func (p *Provider) GenerateAuthURL(context.Context, *integrations.ClientInformation) (*integrations.GenerateAuthURLResponse, error) {
	state := ids.Secure(7)
	return &integrations.GenerateAuthURLResponse{
		URL:          client().GenerateAuthURL(state, scopes),
		CodeVerifier: ids.Secure(11),
		State:        state,
	}, nil
}

func (p *Provider) Authenticate(ctx context.Context, params integrations.AuthenticateParams, _ *integrations.ClientInformation) (*integrations.AuthTokenDetails, error) {
	tokens, err := client().GetToken(ctx, params.Code)
	if err != nil {
		return nil, err
	}
	granted, err := googleapi.GetTokenScopes(ctx, tokens.AccessToken)
	if err != nil {
		return nil, err
	}
	if err := p.CheckScopes(scopes, granted); err != nil {
		return nil, err
	}
	user, err := googleapi.GetUserInfo(ctx, tokens.AccessToken)
	if err != nil {
		return nil, err
	}
	return &integrations.AuthTokenDetails{
		AccessToken:  tokens.AccessToken,
		ExpiresIn:    tokens.ExpiresIn,
		RefreshToken: tokens.RefreshToken,
		ID:           user.ID,
		Name:         user.Name,
		Picture:      user.Picture,
		Username:     "",
	}, nil
}

// errLocationNotFound is a location the account no longer offers.
var errLocationNotFound = errors.New("Location not found")

// statusError is a Google answer outside 2xx: its JSON is an error, never data.
type statusError struct{ status int }

func (e statusError) Error() string { return fmt.Sprintf("google business answered %d", e.status) }

// getJSON reads a JSON answer and refuses one outside 2xx, so an error body
// never reads as no accounts or no locations.
func getJSON(ctx context.Context, rawURL, accessToken string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	res, err := ssrf.Client().Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return statusError{res.StatusCode}
	}
	return json.NewDecoder(res.Body).Decode(out)
}

// profilePhoto returns the location's PROFILE photo, else its first media item.
func profilePhoto(ctx context.Context, accessToken, locationName string) string {
	var media struct {
		MediaItems []struct {
			MediaFormat         string `json:"mediaFormat"`
			GoogleURL           string `json:"googleUrl"`
			LocationAssociation *struct {
				Category string `json:"category"`
			} `json:"locationAssociation"`
		} `json:"mediaItems"`
	}
	if err := getJSON(ctx, informationAPI+"/v1/"+locationName+"/media", accessToken, &media); err != nil {
		return "" // Ignore media fetch errors
	}
	if len(media.MediaItems) == 0 {
		return ""
	}
	for _, m := range media.MediaItems {
		if m.MediaFormat == "PHOTO" && m.LocationAssociation != nil && m.LocationAssociation.Category == "PROFILE" {
			if m.GoogleURL != "" {
				return m.GoogleURL
			}
			break
		}
	}
	return media.MediaItems[0].GoogleURL
}

type Picture struct {
	Data struct {
		URL string `json:"url"`
	} `json:"data"`
}

// Page is one location offered by pages().
type Page struct {
	// ID is the full resource path for the v4 API: accounts/{accountId}/locations/{locationId}
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	Picture      Picture `json:"picture"`
	AccountName  string  `json:"accountName"`
	LocationName string  `json:"locationName"`
}

func (p *Provider) Pages(ctx context.Context, accessToken string) ([]Page, error) {
	// Get all accounts with pagination
	var accounts []string
	pageToken := ""
	for {
		u := accountsAPI + "/v1/accounts"
		if pageToken != "" {
			u += "?pageToken=" + url.QueryEscape(pageToken)
		}
		var data struct {
			Accounts []struct {
				Name string `json:"name"`
			} `json:"accounts"`
			NextPageToken string `json:"nextPageToken"`
		}
		if err := getJSON(ctx, u, accessToken, &data); err != nil {
			return nil, err
		}
		for _, a := range data.Accounts {
			accounts = append(accounts, a.Name)
		}
		pageToken = data.NextPageToken
		if pageToken == "" {
			break
		}
	}

	allLocations := []Page{}
	if len(accounts) == 0 {
		return allLocations, nil
	}

	// Get locations for each account
	for _, accountName := range accounts { // format: accounts/{accountId}
		locations, err := p.accountLocations(ctx, accessToken, accountName)
		allLocations = append(allLocations, locations...)
		if err != nil {
			// Continue with other accounts if one fails
			log.Printf("Failed to fetch locations for account %s: %v", accountName, err)
		}
	}
	return allLocations, nil
}

func (p *Provider) accountLocations(ctx context.Context, accessToken, accountName string) ([]Page, error) {
	var out []Page
	pageToken := ""
	for {
		query := "readMask=" + url.QueryEscape("name,title,storefrontAddress,metadata")
		if pageToken != "" {
			query += "&pageToken=" + url.QueryEscape(pageToken)
		}
		var data struct {
			Locations []struct {
				Name  string `json:"name"`
				Title string `json:"title"`
			} `json:"locations"`
			NextPageToken string `json:"nextPageToken"`
		}
		if err := getJSON(ctx, informationAPI+"/v1/"+accountName+"/locations?"+query, accessToken, &data); err != nil {
			return out, err
		}
		for _, location := range data.Locations {
			// location.name is in format: locations/{locationId}
			// We need the full path: accounts/{accountId}/locations/{locationId}
			locationID := strings.Replace(location.Name, "locations/", "", 1)
			page := Page{
				ID:           accountName + "/locations/" + locationID,
				Name:         location.Title,
				AccountName:  accountName,
				LocationName: location.Name,
			}
			if page.Name == "" {
				page.Name = "Unnamed Location"
			}
			page.Picture.Data.URL = profilePhoto(ctx, accessToken, location.Name)
			out = append(out, page)
		}
		pageToken = data.NextPageToken
		if pageToken == "" {
			return out, nil
		}
	}
}

func (p *Provider) FetchPageInformation(ctx context.Context, accessToken string, raw json.RawMessage) (*integrations.FetchPageInformationResult, error) {
	// data.id is the full resource path: accounts/{accountId}/locations/{locationId}
	// data.locationName is the v1 API format: locations/{locationId}
	var data struct {
		ID           string `json:"id"`
		AccountName  string `json:"accountName"`
		LocationName string `json:"locationName"`
	}
	_ = json.Unmarshal(raw, &data)
	// A choice made in Shots carries only the id; its location is in the path.
	if _, location, ok := strings.Cut(data.ID, "/locations/"); data.LocationName == "" && ok && location != "" && !strings.Contains(location, "/") {
		data.LocationName = "locations/" + location
	}
	if data.LocationName == "" {
		return nil, errLocationNotFound
	}

	var location struct {
		Title string `json:"title"`
	}
	if err := getJSON(ctx, informationAPI+"/v1/"+data.LocationName+"?readMask=name,title,storefrontAddress,metadata", accessToken, &location); err != nil {
		return nil, err
	}
	name := location.Title
	if name == "" {
		name = "Unnamed Location"
	}
	return &integrations.FetchPageInformationResult{
		// Return the full resource path as id (for v4 Local Posts API)
		ID:          data.ID,
		Name:        name,
		AccessToken: accessToken,
		Picture:     profilePhoto(ctx, accessToken, data.LocationName),
		Username:    "",
	}, nil
}

// ReConnect renews the chosen location's details with a fresh token. It reads
// that location only: a refresh never lists every location of the account.
func (p *Provider) ReConnect(ctx context.Context, _, requiredID, accessToken string) (*integrations.AuthTokenDetails, error) {
	data, _ := json.Marshal(map[string]string{"id": requiredID})
	information, err := p.FetchPageInformation(ctx, accessToken, data)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		var status statusError
		refused := errors.Is(err, errLocationNotFound) ||
			errors.As(err, &status) && status.status != http.StatusTooManyRequests && status.status < 500
		if !refused {
			// A throttled, failing or unreachable Google retries on the next run.
			return nil, integrations.ErrRefreshUnavailable
		}
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

type date struct {
	Year  *int `json:"year"`
	Month *int `json:"month"`
	Day   *int `json:"day"`
}

type timeOfDay struct {
	Hours   int `json:"hours"`
	Minutes int `json:"minutes"`
	Seconds int `json:"seconds"`
	Nanos   int `json:"nanos"`
}

type localPost struct {
	LanguageCode string `json:"languageCode"`
	Summary      string `json:"summary"`
	TopicType    string `json:"topicType"`
	CallToAction *struct {
		ActionType string `json:"actionType"`
		URL        string `json:"url"`
	} `json:"callToAction,omitempty"`
	Media []struct {
		MediaFormat string `json:"mediaFormat"`
		SourceURL   string `json:"sourceUrl"`
	} `json:"media,omitempty"`
	Event *struct {
		Title    string `json:"title"`
		Schedule struct {
			StartDate date       `json:"startDate"`
			EndDate   date       `json:"endDate"`
			StartTime *timeOfDay `json:"startTime,omitempty"`
			EndTime   *timeOfDay `json:"endTime,omitempty"`
		} `json:"schedule"`
	} `json:"event,omitempty"`
	Offer *struct {
		CouponCode      string `json:"couponCode,omitempty"`
		RedeemOnlineURL string `json:"redeemOnlineUrl,omitempty"`
		TermsConditions string `json:"termsConditions,omitempty"`
	} `json:"offer,omitempty"`
}

func (p *Provider) Post(ctx context.Context, id, accessToken string, posts []integrations.PostDetails, _ *ent.Integration) ([]integrations.PostResponse, error) {
	firstPost := posts[0]
	settings := decodeSettings(firstPost.Settings)

	// Build the local post request body
	postBody := localPost{LanguageCode: "en", Summary: firstPost.Message, TopicType: str(settings.TopicType)}
	if postBody.TopicType == "" {
		postBody.TopicType = "STANDARD"
	}

	// Add call to action if provided (and not NONE)
	if cta := str(settings.CallToActionType); cta != "" && cta != "NONE" && str(settings.CallToActionURL) != "" {
		postBody.CallToAction = &struct {
			ActionType string `json:"actionType"`
			URL        string `json:"url"`
		}{cta, *settings.CallToActionURL}
	}

	// Add media if provided
	if len(firstPost.Media) > 0 {
		mediaItem := firstPost.Media[0]
		format := "PHOTO"
		if mediaItem.Type == "video" {
			format = "VIDEO"
		}
		postBody.Media = []struct {
			MediaFormat string `json:"mediaFormat"`
			SourceURL   string `json:"sourceUrl"`
		}{{format, mediaItem.Path}}
	}

	// Add event details if it's an event post
	if str(settings.TopicType) == "EVENT" && settings.EventTitle != "" {
		postBody.Event = &struct {
			Title    string `json:"title"`
			Schedule struct {
				StartDate date       `json:"startDate"`
				EndDate   date       `json:"endDate"`
				StartTime *timeOfDay `json:"startTime,omitempty"`
				EndTime   *timeOfDay `json:"endTime,omitempty"`
			} `json:"schedule"`
		}{Title: settings.EventTitle}
		postBody.Event.Schedule.StartDate = formatDate(settings.EventStartDate)
		postBody.Event.Schedule.EndDate = formatDate(settings.EventEndDate)
		postBody.Event.Schedule.StartTime = formatTime(settings.EventStartTime)
		postBody.Event.Schedule.EndTime = formatTime(settings.EventEndTime)
	}

	// Add offer details if it's an offer post
	if str(settings.TopicType) == "OFFER" {
		postBody.Offer = &struct {
			CouponCode      string `json:"couponCode,omitempty"`
			RedeemOnlineURL string `json:"redeemOnlineUrl,omitempty"`
			TermsConditions string `json:"termsConditions,omitempty"`
		}{settings.OfferCouponCode, settings.OfferRedeemURL, settings.OfferTerms}
	}

	body, _ := json.Marshal(postBody)

	// Create the local post
	response, err := p.Fetch(ctx, localPostsAPI+"/v4/"+id+"/localPosts", integrations.Request{
		Method: http.MethodPost,
		Headers: map[string]string{
			"Authorization": "Bearer " + accessToken,
			"Content-Type":  "application/json",
		},
		Body: body,
	})
	if err != nil {
		return nil, err
	}

	postData := map[string]any{}
	_ = response.JSON(&postData)
	postJSON, _ := json.Marshal(postData)

	if postData["state"] == "REJECTED" {
		return nil, temporalx.BadBody(identifier, string(postJSON), string(body),
			"Google rejected this post for a content policy violation. Please review the post content and try again.")
	}

	postID, _ := postData["name"].(string)
	if postID == "" {
		return nil, temporalx.BadBody(identifier, string(postJSON), string(body),
			"Google did not confirm the post creation. Please try again.")
	}

	// Extract the post ID and construct the URL
	locationID := id[strings.LastIndex(id, "/")+1:]
	releaseURL, _ := postData["searchUrl"].(string)
	if releaseURL == "" {
		releaseURL = "https://business.google.com/locations/" + locationID
	}

	return []integrations.PostResponse{{
		ID:         firstPost.ID,
		PostID:     postID,
		ReleaseURL: releaseURL,
		Status:     "success",
	}}, nil
}

// dayjsParse is dayjs's REGEX_PARSE: strings without a zone are local time.
var dayjsParse = regexp.MustCompile(`^(\d{4})[-/]?(\d{1,2})?[-/]?(\d{0,2})[Tt\s]*(\d{1,2})?:?(\d{1,2})?:?(\d{1,2})?[.:]?(\d+)?$`)

func parseDate(value string) (time.Time, bool) {
	if m := dayjsParse.FindStringSubmatch(value); m != nil {
		// new Date(y, M - 1 || 0, d || 1, h || 0, ...): missing parts default,
		// out-of-range ones roll over like Date does.
		n := func(s string, def int) int {
			if v, err := strconv.Atoi(s); err == nil {
				return v
			}
			return def
		}
		return time.Date(n(m[1], 0), time.Month(n(m[2], 1)), n(m[3], 1), n(m[4], 0), n(m[5], 0), n(m[6], 0), 0, time.Local), true
	}
	t, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, false
	}
	return t.Local(), true
}

func formatDate(dateString string) date {
	t := time.Now()
	if dateString != "" {
		parsed, ok := parseDate(dateString)
		if !ok {
			return date{} // Invalid Date: NaN fields serialize as null
		}
		t = parsed
	}
	year, month, day := t.Year(), int(t.Month()), t.Day()
	return date{Year: &year, Month: &month, Day: &day}
}

func formatTime(timeString string) *timeOfDay {
	if timeString == "" {
		return nil
	}
	parts := strings.Split(timeString, ":")
	number := func(i int) int {
		if i >= len(parts) {
			return 0
		}
		v, _ := strconv.Atoi(strings.TrimSpace(parts[i])) // NaN || 0
		return v
	}
	return &timeOfDay{Hours: number(0), Minutes: number(1)}
}

func (p *Provider) Analytics(ctx context.Context, id, accessToken string, days int) ([]integrations.AnalyticsData, error) {
	end := time.Now()
	start := end.AddDate(0, 0, -days)

	// id is in format: accounts/{accountId}/locations/{locationId}
	// Business Profile Performance API expects: locations/{locationId}
	locationID := "undefined"
	if parts := strings.Split(id, "/locations/"); len(parts) > 1 {
		locationID = parts[1]
	}
	locationPath := "locations/" + locationID

	// Use the Business Profile Performance API
	u := fmt.Sprintf("%s/v1/%s:fetchMultiDailyMetricsTimeSeries?dailyMetrics=WEBSITE_CLICKS&dailyMetrics=CALL_CLICKS&dailyMetrics=BUSINESS_DIRECTION_REQUESTS&dailyMetrics=BUSINESS_IMPRESSIONS_DESKTOP_MAPS&dailyMetrics=BUSINESS_IMPRESSIONS_MOBILE_MAPS&dailyRange.startDate.year=%d&dailyRange.startDate.month=%d&dailyRange.startDate.day=%d&dailyRange.endDate.year=%d&dailyRange.endDate.month=%d&dailyRange.endDate.day=%d",
		performanceAPI, locationPath, start.Year(), int(start.Month()), start.Day(), end.Year(), int(end.Month()), end.Day())

	// Response structure: { multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [...] }] }
	var data struct {
		MultiDailyMetricTimeSeries []struct {
			DailyMetricTimeSeries []struct {
				DailyMetric string `json:"dailyMetric"`
				TimeSeries  *struct {
					DatedValues []struct {
						Date struct {
							Year  int `json:"year"`
							Month int `json:"month"`
							Day   int `json:"day"`
						} `json:"date"`
						Value string `json:"value"`
					} `json:"datedValues"`
				} `json:"timeSeries"`
			} `json:"dailyMetricTimeSeries"`
		} `json:"multiDailyMetricTimeSeries"`
	}
	if err := getJSON(ctx, u, accessToken, &data); err != nil {
		log.Println("Error fetching GMB analytics:", err)
		return []integrations.AnalyticsData{}, nil
	}
	if len(data.MultiDailyMetricTimeSeries) == 0 || len(data.MultiDailyMetricTimeSeries[0].DailyMetricTimeSeries) == 0 {
		return []integrations.AnalyticsData{}, nil
	}

	metricLabels := map[string]string{
		"WEBSITE_CLICKS":                    "Website Clicks",
		"CALL_CLICKS":                       "Phone Calls",
		"BUSINESS_DIRECTION_REQUESTS":       "Direction Requests",
		"BUSINESS_IMPRESSIONS_DESKTOP_MAPS": "Desktop Map Views",
		"BUSINESS_IMPRESSIONS_MOBILE_MAPS":  "Mobile Map Views",
	}

	analytics := []integrations.AnalyticsData{}
	for _, series := range data.MultiDailyMetricTimeSeries[0].DailyMetricTimeSeries {
		label := metricLabels[series.DailyMetric]
		if label == "" {
			label = series.DailyMetric
		}
		if series.TimeSeries == nil || len(series.TimeSeries.DatedValues) == 0 {
			continue
		}
		points := make([]integrations.AnalyticsItem, 0, len(series.TimeSeries.DatedValues))
		for _, dv := range series.TimeSeries.DatedValues {
			value := dv.Value
			if value == "" {
				value = "0"
			}
			total, _ := strconv.Atoi(value)
			points = append(points, integrations.AnalyticsItem{
				Total: strconv.Itoa(total),
				Date:  fmt.Sprintf("%d-%02d-%02d", dv.Date.Year, dv.Date.Month, dv.Date.Day),
			})
		}
		analytics = append(analytics, integrations.AnalyticsData{Label: label, PercentageChange: 0, Data: points})
	}
	return analytics, nil
}
