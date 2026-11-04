//go:build e2e

// Package e2eprovider is a fake social provider linked only into e2e builds.
// It lets the API and orchestrator execute their real scheduling paths against
// a controlled HTTP peer without routing a test post to a customer account.
package e2eprovider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ids"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
)

const identifier = "e2e"

type Provider struct {
	*integrations.Base
	endpoint string
}

func New(endpoint string) *Provider {
	base := integrations.NewBase(identifier, nil)
	base.RetryDelay = 100 * time.Millisecond
	return &Provider{Base: base, endpoint: strings.TrimRight(endpoint, "/")}
}

func (p *Provider) Info() integrations.Info {
	return integrations.Info{Identifier: identifier, Name: "E2E fake social", Editor: "normal"}
}

func (p *Provider) MaxLength([]integrations.AdditionalSetting, json.RawMessage) int { return 2000 }

func (p *Provider) GenerateAuthURL(context.Context, *integrations.ClientInformation) (*integrations.GenerateAuthURLResponse, error) {
	state := ids.Secure(12)
	return &integrations.GenerateAuthURLResponse{
		URL:          p.endpoint + "/oauth/authorize?state=" + url.QueryEscape(state),
		CodeVerifier: ids.Secure(12),
		State:        state,
	}, nil
}

func (p *Provider) Authenticate(_ context.Context, params integrations.AuthenticateParams, _ *integrations.ClientInformation) (*integrations.AuthTokenDetails, error) {
	if params.Code != "valid" && params.Code != "expired" {
		return nil, errors.New("the fake account denied authorization")
	}
	return &integrations.AuthTokenDetails{
		ID:          "e2e-" + params.CodeVerifier,
		Name:        "Isolated social test",
		Username:    "e2e-test",
		AccessToken: params.Code,
	}, nil
}

func (p *Provider) RefreshToken(context.Context, string) (*integrations.AuthTokenDetails, error) {
	return nil, errors.New("the fake account credential cannot be refreshed")
}

func (p *Provider) Post(ctx context.Context, id, accessToken string, posts []integrations.PostDetails, account *ent.Integration) ([]integrations.PostResponse, error) {
	if len(posts) != 1 {
		return nil, fmt.Errorf("fake social expects one post, got %d", len(posts))
	}
	body, err := json.Marshal(struct {
		Platform    string                   `json:"platform"`
		ID          string                   `json:"id"`
		AccessToken string                   `json:"accessToken"`
		Post        integrations.PostDetails `json:"post"`
	}{Platform: account.ProviderIdentifier, ID: id, AccessToken: accessToken, Post: posts[0]})
	if err != nil {
		return nil, err
	}
	response, err := p.Fetch(ctx, p.endpoint+"/posts", integrations.Request{
		Method:  http.MethodPost,
		Body:    body,
		Headers: map[string]string{"Content-Type": "application/json"},
		Client:  &http.Client{Timeout: 30 * time.Second},
	})
	if err != nil {
		return nil, err
	}
	var result struct {
		PostID     string `json:"postId"`
		ReleaseURL string `json:"releaseURL"`
	}
	if err := response.JSON(&result); err != nil {
		return nil, err
	}
	if result.PostID == "" {
		return nil, errors.New("fake social returned no post ID")
	}
	return []integrations.PostResponse{{
		ID: posts[0].ID, PostID: result.PostID, ReleaseURL: result.ReleaseURL, Status: "success",
	}}, nil
}

// action asks the fake to record a follow-up (RFC 025) and returns the id it
// gives the result, if any.
func (p *Provider) action(ctx context.Context, kind, postID, text string) (string, error) {
	body, err := json.Marshal(map[string]string{"kind": kind, "postId": postID, "text": text})
	if err != nil {
		return "", err
	}
	response, err := p.Fetch(ctx, p.endpoint+"/actions", integrations.Request{
		Method: http.MethodPost, Body: body, Headers: map[string]string{"Content-Type": "application/json"},
		Client: &http.Client{Timeout: 30 * time.Second},
	})
	if err != nil {
		return "", err
	}
	var result struct {
		ID string `json:"id"`
	}
	if err := response.JSON(&result); err != nil {
		return "", err
	}
	return result.ID, nil
}

// Comment answers a post: a thread's next post or a first comment.
func (p *Provider) Comment(ctx context.Context, _, postID, _, _ string, posts []integrations.PostDetails, _ *ent.Integration) ([]integrations.PostResponse, error) {
	responses := make([]integrations.PostResponse, 0, len(posts))
	for _, post := range posts {
		id, err := p.action(ctx, "comment", postID, post.Message)
		if err != nil {
			return nil, err
		}
		responses = append(responses, integrations.PostResponse{ID: post.ID, PostID: id, Status: "success"})
	}
	return responses, nil
}

func (p *Provider) RetweetPost(ctx context.Context, _ *ent.Integration, postID string) error {
	_, err := p.action(ctx, "retweet", postID, "")
	return err
}

func (p *Provider) UnretweetPost(ctx context.Context, _ *ent.Integration, postID string) error {
	_, err := p.action(ctx, "unretweet", postID, "")
	return err
}

func (p *Provider) ReplyTo(ctx context.Context, _ *ent.Integration, postID, text string) (string, error) {
	return p.action(ctx, "reply", postID, text)
}

// PostEngagement is the fake's configured like and repost counts.
func (p *Provider) PostEngagement(ctx context.Context, _ *ent.Integration, postID string) (int, int, error) {
	response, err := p.Fetch(ctx, p.endpoint+"/engagement?postId="+url.QueryEscape(postID), integrations.Request{
		Method: http.MethodGet, Client: &http.Client{Timeout: 30 * time.Second},
	})
	if err != nil {
		return 0, 0, err
	}
	var result struct {
		Likes   int `json:"likes"`
		Reposts int `json:"reposts"`
	}
	if err := response.JSON(&result); err != nil {
		return 0, 0, err
	}
	return result.Likes, result.Reposts, nil
}
