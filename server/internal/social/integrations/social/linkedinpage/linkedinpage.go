// Package linkedinpage is the LinkedIn Page provider: LinkedinPageProvider
// extends LinkedinProvider, so Provider embeds *linkedin.Provider and
// overrides what the TypeScript class overrides. Posts, comments and plugs
// act as the organization (company) instead of the member.
package linkedinpage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ids"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations/social/linkedin"
)

const identifier = "linkedin-page"

// plugDelay is the pause before a plug acts (timer(2000)).
var plugDelay = 2 * time.Second

type Provider struct {
	*linkedin.Provider
}

func New() *Provider { return &Provider{Provider: linkedin.WithIdentifier(identifier)} }

func (p *Provider) Info() integrations.Info {
	info := p.Provider.Info()
	info.Identifier = identifier
	info.Name = "LinkedIn Page"
	info.Scopes = linkedin.PageOAuthScopes()
	info.IsBetweenSteps = true
	info.MaxConcurrentJob = 2 // LinkedIn Page has professional posting limits
	return info
}

// RefreshToken is inherited: the TypeScript override only differs in not
// defaulting a missing picture to '', which serializes the same.

func (p *Provider) GenerateAuthURL(context.Context, *integrations.ClientInformation) (*integrations.GenerateAuthURLResponse, error) {
	state := ids.Secure(6)
	clientID, _ := p.Credentials()
	return &integrations.GenerateAuthURLResponse{
		URL: "https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=" + clientID +
			"&redirect_uri=" + linkedin.EncodeURIComponent(os.Getenv("FRONTEND_URL")+"/integrations/social/linkedin-page") +
			"&state=" + state + "&scope=" + linkedin.EncodeURIComponent(strings.Join(linkedin.PageOAuthScopes(), " ")),
		CodeVerifier: ids.Secure(30),
		State:        state,
	}, nil
}

func (p *Provider) Authenticate(ctx context.Context, params integrations.AuthenticateParams, _ *integrations.ClientInformation) (*integrations.AuthTokenDetails, error) {
	details, err := p.ExchangeCodeForScopes(ctx, params.Code, os.Getenv("FRONTEND_URL")+"/integrations/social/linkedin-page", linkedin.PageOAuthScopes())
	if err != nil {
		return nil, err
	}
	// LinkedIn answers an unreadable profile (no r_basicprofile) without an id.
	if details.ID == "" {
		return nil, errors.New("linkedin page connection could not read the member profile")
	}
	// namespaced placeholder so the in-between row never collides with the
	// personal LinkedIn channel row (same org + same member sub)
	details.ID = identifier + "_" + details.ID
	return details, nil
}

type Company struct {
	ID       string `json:"id"`
	Page     string `json:"page"`
	Username string `json:"username"`
	Name     string `json:"name"`
	Picture  string `json:"picture,omitempty"`
}

// Companies lists the organizations the member administers (page selection
// between steps).
func (p *Provider) Companies(ctx context.Context, accessToken string) ([]Company, error) {
	var out struct {
		Elements []struct {
			Role                 string `json:"role"`
			OrganizationalTarget string `json:"organizationalTarget"`
			Target               *struct {
				LocalizedName string           `json:"localizedName"`
				VanityName    string           `json:"vanityName"`
				LogoV2        *linkedin.LogoV2 `json:"logoV2"`
			} `json:"organizationalTarget~"`
		} `json:"elements"`
	}
	if err := linkedin.FetchJSON(ctx, http.MethodGet,
		linkedin.APIURL+"/v2/organizationalEntityAcls?q=roleAssignee&state=APPROVED&projection=(elements*(role,organizationalTarget~(localizedName,vanityName,logoV2(original~:playableStreams))))",
		linkedin.Headers(accessToken, ""), nil, &out); err != nil {
		return nil, err
	}
	companies := []Company{}
	for _, e := range out.Elements {
		if e.Target == nil || (e.Role != "ADMINISTRATOR" && e.Role != "CONTENT_ADMINISTRATOR") {
			continue
		}
		parts := strings.Split(e.OrganizationalTarget, ":")
		id := parts[len(parts)-1]
		companies = append(companies, Company{
			ID: id, Page: id, Username: e.Target.VanityName, Name: e.Target.LocalizedName, Picture: e.Target.LogoV2.URL(),
		})
	}
	return companies, nil
}

func (p *Provider) ReConnect(ctx context.Context, id, requiredID, accessToken string) (*integrations.AuthTokenDetails, error) {
	data, _ := json.Marshal(map[string]string{"page": requiredID})
	information, err := p.FetchPageInformation(ctx, accessToken, data)
	if err != nil {
		return nil, err
	}
	return &integrations.AuthTokenDetails{
		ID: information.ID, Name: information.Name, AccessToken: information.AccessToken,
		Picture: information.Picture, Username: information.Username,
	}, nil
}

func (p *Provider) FetchPageInformation(ctx context.Context, accessToken string, params json.RawMessage) (*integrations.FetchPageInformationResult, error) {
	var in struct {
		Page any `json:"page"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(params)))
	decoder.UseNumber()
	_ = decoder.Decode(&in)
	var data struct {
		ID            json.Number      `json:"id"`
		LocalizedName string           `json:"localizedName"`
		VanityName    string           `json:"vanityName"`
		LogoV2        *linkedin.LogoV2 `json:"logoV2"`
	}
	if err := linkedin.FetchJSON(ctx, http.MethodGet,
		fmt.Sprintf("%s/v2/organizations/%v?projection=(id,localizedName,vanityName,logoV2(original~:playableStreams))", linkedin.APIURL, in.Page),
		map[string]string{"Authorization": "Bearer " + accessToken}, nil, &data); err != nil {
		return nil, err
	}
	return &integrations.FetchPageInformationResult{
		ID: data.ID.String(), Name: data.LocalizedName, AccessToken: accessToken, Picture: data.LogoV2.URL(), Username: data.VanityName,
	}, nil
}

func (p *Provider) Functions() map[string]integrations.Function {
	functions := p.Provider.Functions()
	functions["companies"] = func(ctx context.Context, token string, _ json.RawMessage, _ string, _ *ent.Integration) (any, error) {
		return p.Companies(ctx, token)
	}
	functions["fetchPageInformation"] = func(ctx context.Context, token string, data json.RawMessage, _ string, _ *ent.Integration) (any, error) {
		return p.FetchPageInformation(ctx, token, data)
	}
	return functions
}

// Post and PostPending publish as the organization; CheckPostStatus and
// FinalizePost are inherited as-is since the company context travels inside
// the pending data.
func (p *Provider) Post(ctx context.Context, id, accessToken string, posts []integrations.PostDetails, integration *ent.Integration) ([]integrations.PostResponse, error) {
	return p.PostAs(ctx, id, accessToken, posts, integration, linkedin.Company)
}

func (p *Provider) PostPending(ctx context.Context, id, accessToken string, posts []integrations.PostDetails, _ *ent.Integration) ([]integrations.PostResponse, error) {
	return p.PostPendingAs(ctx, id, accessToken, posts, linkedin.Company)
}

func (p *Provider) Comment(ctx context.Context, id, postID, _ string, accessToken string, posts []integrations.PostDetails, _ *ent.Integration) ([]integrations.PostResponse, error) {
	return p.CommentAs(ctx, id, postID, accessToken, posts, linkedin.Company)
}

// The @PostPlug overrides of addComment / repostPostUsers act as the organization.
func (p *Provider) InternalPlugs() []integrations.InternalPlug { return p.PostPlugs(false) }

func (p *Provider) Plugs() []integrations.Plug {
	likesAmount := integrations.PlugField{
		Name: "likesAmount", Type: "number", Placeholder: "Amount of likes",
		Description: "The amount of likes to trigger the repost", Validation: `/^\d+$/`,
	}
	return []integrations.Plug{
		{
			MethodName:           "autoRepostPost",
			Identifier:           "linkedin-page-autoRepostPost",
			Title:                "Auto Repost Posts",
			Description:          "When a post reached a certain number of likes, repost it to increase engagement (1 week old posts)",
			RunEveryMilliseconds: 21600000,
			TotalRuns:            3,
			Fields:               []integrations.PlugField{likesAmount},
			Run:                  p.AutoRepostPost,
		},
		{
			MethodName:           "autoPlugPost",
			Identifier:           "linkedin-page-autoPlugPost",
			Title:                "Auto plug post",
			Description:          "When a post reached a certain number of likes, add another post to it so you followers get a notification about your promotion",
			RunEveryMilliseconds: 21600000,
			TotalRuns:            3,
			Fields: []integrations.PlugField{likesAmount, {
				Name: "post", Type: "richtext", Placeholder: "Post to plug",
				Description: "Message content to plug", Validation: `/^[\s\S]{3,}$/g`,
			}},
			Run: p.AutoPlugPost,
		},
	}
}

// jsNumber is JavaScript's unary + on a string (NaN when not numeric).
func jsNumber(s string) (float64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, true
	}
	n, err := strconv.ParseFloat(s, 64)
	return n, err == nil
}

func (p *Provider) reachedLikes(ctx context.Context, integration *ent.Integration, id, likesAmount string) (bool, error) {
	res, err := p.Fetch(ctx, linkedin.APIURL+"/v2/socialActions/"+linkedin.EncodeURIComponent(id), integrations.Request{
		Method: http.MethodGet, Headers: linkedin.Headers(integration.Token, "application/json"),
	})
	if err != nil {
		return false, err
	}
	var actions struct {
		LikesSummary *struct {
			TotalLikes float64 `json:"totalLikes"`
		} `json:"likesSummary"`
	}
	if err := res.JSON(&actions); err != nil {
		return false, err
	}
	if actions.LikesSummary == nil {
		return false, errors.New("Cannot destructure property 'totalLikes' of 'undefined'")
	}
	threshold, ok := jsNumber(likesAmount)
	return ok && actions.LikesSummary.TotalLikes >= threshold, nil
}

// AutoRepostPost reshares the post as the organization once it reached likesAmount likes.
func (p *Provider) AutoRepostPost(ctx context.Context, integration *ent.Integration, id string, fields map[string]string) (bool, error) {
	reached, err := p.reachedLikes(ctx, integration, id, fields["likesAmount"])
	if err != nil || !reached {
		return false, err
	}
	if err := p.Sleep(ctx, plugDelay); err != nil {
		return false, err
	}
	if err := p.Repost(ctx, integration.Token, "urn:li:organization:"+integration.InternalID, id); err != nil {
		return false, err
	}
	return true, nil
}

// AutoPlugPost comments fields["post"] on the post once it reached likesAmount likes.
func (p *Provider) AutoPlugPost(ctx context.Context, integration *ent.Integration, id string, fields map[string]string) (bool, error) {
	reached, err := p.reachedLikes(ctx, integration, id, fields["likesAmount"])
	if err != nil || !reached {
		return false, err
	}
	if err := p.Sleep(ctx, plugDelay); err != nil {
		return false, err
	}
	decoded, err := url.PathUnescape(id) // decodeURIComponent
	if err != nil {
		return false, err
	}
	body, _ := json.Marshal(map[string]any{
		"actor":   "urn:li:organization:" + integration.InternalID,
		"object":  id,
		"message": map[string]string{"text": linkedin.FixText(fields["post"])},
	})
	if _, err := p.Fetch(ctx, linkedin.APIURL+"/v2/socialActions/"+decoded+"/comments", integrations.Request{
		Method:  http.MethodPost,
		Headers: map[string]string{"Content-Type": "application/json", "Authorization": "Bearer " + integration.Token},
		Body:    body,
	}); err != nil {
		return false, err
	}
	return true, nil
}
