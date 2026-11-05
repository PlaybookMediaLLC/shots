// Package githubapp calls GitHub as the platform's GitHub App: an App JWT for
// installation metadata, short-lived installation tokens for repository reads,
// and the user OAuth exchange that proves who installed the App.
package githubapp

import (
	"bytes"
	"context"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// ErrNotConfigured means the deployment has no GitHub App credentials.
var ErrNotConfigured = errors.New("github app is not configured")

// Installation is an App installation as GitHub reports it.
type Installation struct {
	ID                  int64  `json:"id"`
	AccountLogin        string `json:"accountLogin"`
	AccountType         string `json:"accountType"`
	RepositorySelection string `json:"repositorySelection"`
	Suspended           bool   `json:"suspended"`
}

// Repository is a repository an installation can read.
type Repository struct {
	ID            int64  `json:"id"`
	FullName      string `json:"fullName"`
	DefaultBranch string `json:"defaultBranch"`
	Private       bool   `json:"private"`
}

// Release is a published GitHub release.
type Release struct {
	ID          int64     `json:"id"`
	Name        string    `json:"name"`
	TagName     string    `json:"tag_name"`
	Body        string    `json:"body"`
	HTMLURL     string    `json:"html_url"`
	Draft       bool      `json:"draft"`
	Prerelease  bool      `json:"prerelease"`
	PublishedAt time.Time `json:"published_at"`
}

// PullRequest is a pull request with what a release brief needs.
type PullRequest struct {
	ChangedFiles *int       `json:"changed_files"`
	Number       int        `json:"number"`
	Title        string     `json:"title"`
	Body         string     `json:"body"`
	BodyHTML     string     `json:"body_html"`
	HTMLURL      string     `json:"html_url"`
	MergedAt     *time.Time `json:"merged_at"`
	Base         struct {
		Ref string `json:"ref"`
	} `json:"base"`
	User struct {
		Login string `json:"login"`
		Type  string `json:"type"`
	} `json:"user"`
	Labels []struct {
		Name string `json:"name"`
	} `json:"labels"`
}

// App is the platform's GitHub App.
type App struct {
	ID           string
	ClientID     string
	ClientSecret string
	Key          *rsa.PrivateKey
	HTTP         *http.Client
	API          string
	Web          string
	Now          func() time.Time

	mu     sync.Mutex
	tokens map[int64]cachedToken
}

type cachedToken struct {
	value   string
	expires time.Time
}

// FromEnvironment reads GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY (PEM, raw or
// base64), GITHUB_APP_CLIENT_ID, and GITHUB_APP_CLIENT_SECRET. It returns nil
// when the App is not configured.
func FromEnvironment() (*App, error) {
	id := os.Getenv("GITHUB_APP_ID")
	if id == "" {
		return nil, nil
	}
	pem := strings.ReplaceAll(os.Getenv("GITHUB_APP_PRIVATE_KEY"), `\n`, "\n")
	if !strings.Contains(pem, "BEGIN") {
		decoded, err := base64.StdEncoding.DecodeString(pem)
		if err != nil {
			return nil, fmt.Errorf("GITHUB_APP_PRIVATE_KEY is neither PEM nor base64 PEM")
		}
		pem = string(decoded)
	}
	key, err := jwt.ParseRSAPrivateKeyFromPEM([]byte(pem))
	if err != nil {
		return nil, fmt.Errorf("GITHUB_APP_PRIVATE_KEY is not an RSA private key")
	}
	return &App{ID: id, ClientID: os.Getenv("GITHUB_APP_CLIENT_ID"), ClientSecret: os.Getenv("GITHUB_APP_CLIENT_SECRET"),
		Key: key, HTTP: &http.Client{Timeout: 20 * time.Second}, API: envOr("GITHUB_API_URL", "https://api.github.com"),
		Web: envOr("GITHUB_WEB_URL", "https://github.com")}, nil
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return strings.TrimRight(value, "/")
	}
	return fallback
}

func (a *App) now() time.Time {
	if a.Now != nil {
		return a.Now()
	}
	return time.Now()
}

// appJWT authenticates as the App itself; GitHub accepts at most ten minutes.
func (a *App) appJWT() (string, error) {
	now := a.now()
	claims := jwt.RegisteredClaims{Issuer: a.ID, IssuedAt: jwt.NewNumericDate(now.Add(-time.Minute)),
		ExpiresAt: jwt.NewNumericDate(now.Add(9 * time.Minute))}
	return jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(a.Key)
}

// InstallationToken returns a token for one installation, reused until five
// minutes before GitHub expires it.
func (a *App) InstallationToken(ctx context.Context, installationID int64) (string, error) {
	a.mu.Lock()
	cached, ok := a.tokens[installationID]
	a.mu.Unlock()
	if ok && a.now().Before(cached.expires.Add(-5*time.Minute)) {
		return cached.value, nil
	}
	appToken, err := a.appJWT()
	if err != nil {
		return "", err
	}
	var out struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	path := "/app/installations/" + strconv.FormatInt(installationID, 10) + "/access_tokens"
	if err := a.do(ctx, http.MethodPost, a.API+path, "Bearer "+appToken, nil, &out); err != nil {
		return "", err
	}
	a.mu.Lock()
	if a.tokens == nil {
		a.tokens = map[int64]cachedToken{}
	}
	a.tokens[installationID] = cachedToken{value: out.Token, expires: out.ExpiresAt}
	a.mu.Unlock()
	return out.Token, nil
}

// Installation reads an installation's account and repository selection.
func (a *App) Installation(ctx context.Context, installationID int64) (Installation, error) {
	appToken, err := a.appJWT()
	if err != nil {
		return Installation{}, err
	}
	var out installationJSON
	if err := a.do(ctx, http.MethodGet, a.API+"/app/installations/"+strconv.FormatInt(installationID, 10),
		"Bearer "+appToken, nil, &out); err != nil {
		return Installation{}, err
	}
	return out.installation(), nil
}

// installationJSON is an installation as GitHub's API returns it.
type installationJSON struct {
	ID      int64 `json:"id"`
	Account struct {
		Login string `json:"login"`
		Type  string `json:"type"`
	} `json:"account"`
	RepositorySelection string     `json:"repository_selection"`
	SuspendedAt         *time.Time `json:"suspended_at"`
}

func (out installationJSON) installation() Installation {
	return Installation{ID: out.ID, AccountLogin: out.Account.Login, AccountType: out.Account.Type,
		RepositorySelection: out.RepositorySelection, Suspended: out.SuspendedAt != nil}
}

// ExchangeCode turns the OAuth code GitHub sent back after an install into a
// user access token.
func (a *App) ExchangeCode(ctx context.Context, code string) (string, error) {
	if a.ClientID == "" || a.ClientSecret == "" {
		return "", ErrNotConfigured
	}
	body, _ := json.Marshal(map[string]string{"client_id": a.ClientID, "client_secret": a.ClientSecret, "code": code})
	var out struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
	}
	if err := a.do(ctx, http.MethodPost, a.Web+"/login/oauth/access_token", "", body, &out); err != nil {
		return "", err
	}
	if out.AccessToken == "" {
		return "", fmt.Errorf("github refused the code: %s", out.Error)
	}
	return out.AccessToken, nil
}

// UserInstallations lists this App's installations the user can access.
func (a *App) UserInstallations(ctx context.Context, userToken string) ([]Installation, error) {
	installations := []Installation{}
	for page := 1; page <= 10; page++ {
		var out struct {
			Installations []installationJSON `json:"installations"`
		}
		if err := a.do(ctx, http.MethodGet, fmt.Sprintf("%s/user/installations?per_page=100&page=%d", a.API, page),
			"Bearer "+userToken, nil, &out); err != nil {
			return nil, err
		}
		for _, installation := range out.Installations {
			installations = append(installations, installation.installation())
		}
		if len(out.Installations) < 100 {
			return installations, nil
		}
	}
	return nil, ErrIncompleteEvidence
}

// Repositories lists the repositories an installation can read.
func (a *App) Repositories(ctx context.Context, installationID int64) ([]Repository, error) {
	token, err := a.InstallationToken(ctx, installationID)
	if err != nil {
		return nil, err
	}
	repositories := []Repository{}
	for page := 1; page <= 10; page++ {
		var out struct {
			Repositories []struct {
				ID            int64  `json:"id"`
				FullName      string `json:"full_name"`
				DefaultBranch string `json:"default_branch"`
				Private       bool   `json:"private"`
			} `json:"repositories"`
		}
		if err := a.do(ctx, http.MethodGet, fmt.Sprintf("%s/installation/repositories?per_page=100&page=%d", a.API, page),
			"token "+token, nil, &out); err != nil {
			return nil, err
		}
		for _, r := range out.Repositories {
			repositories = append(repositories, Repository{ID: r.ID, FullName: r.FullName, DefaultBranch: r.DefaultBranch, Private: r.Private})
		}
		if len(out.Repositories) < 100 {
			return repositories, nil
		}
	}
	return nil, ErrIncompleteEvidence
}

// Repository reads one repository by its immutable ID.
func (a *App) Repository(ctx context.Context, installationID int64, repositoryID string) (Repository, error) {
	var out struct {
		ID            int64  `json:"id"`
		FullName      string `json:"full_name"`
		DefaultBranch string `json:"default_branch"`
		Private       bool   `json:"private"`
	}
	if err := a.get(ctx, installationID, "/repositories/"+url.PathEscape(repositoryID), "", &out); err != nil {
		return Repository{}, err
	}
	return Repository{ID: out.ID, FullName: out.FullName, DefaultBranch: out.DefaultBranch, Private: out.Private}, nil
}

// Releases lists a repository's latest published releases, newest first.
func (a *App) Releases(ctx context.Context, installationID int64, repositoryID string, limit int) ([]Release, error) {
	var out []Release
	if err := a.get(ctx, installationID, fmt.Sprintf("/repositories/%s/releases?per_page=%d", url.PathEscape(repositoryID), limit), "", &out); err != nil {
		return nil, err
	}
	published := []Release{}
	for _, release := range out {
		if !release.Draft {
			published = append(published, release)
		}
	}
	return published, nil
}

// MergedPullRequests lists PRs merged into base, most recently updated first.
func (a *App) MergedPullRequests(ctx context.Context, installationID int64, repositoryID, base string, limit int) ([]PullRequest, error) {
	var out []PullRequest
	path := fmt.Sprintf("/repositories/%s/pulls?state=closed&base=%s&sort=updated&direction=desc&per_page=%d",
		url.PathEscape(repositoryID), url.QueryEscape(base), limit)
	if err := a.get(ctx, installationID, path, "", &out); err != nil {
		return nil, err
	}
	merged := []PullRequest{}
	for _, pr := range out {
		if pr.MergedAt != nil {
			merged = append(merged, pr)
		}
	}
	return merged, nil
}

// PullRequest reads one PR with its rendered body, whose image URLs are signed
// so images in a private repository download without a session.
func (a *App) PullRequest(ctx context.Context, installationID int64, repositoryID string, number int) (PullRequest, error) {
	var out PullRequest
	err := a.get(ctx, installationID, fmt.Sprintf("/repositories/%s/pulls/%d", url.PathEscape(repositoryID), number),
		"application/vnd.github.full+json", &out)
	return out, err
}

// ReleaseHTML reads a release's rendered body, for its signed image URLs.
// CommitForRef resolves a tag or branch to its immutable commit.
func (a *App) CommitForRef(ctx context.Context, installationID int64, repositoryID, ref string) (string, error) {
	var out struct {
		SHA string `json:"sha"`
	}
	err := a.get(ctx, installationID, fmt.Sprintf("/repositories/%s/commits/%s", url.PathEscape(repositoryID), url.PathEscape(ref)), "application/vnd.github+json", &out)
	return out.SHA, err
}

func (a *App) ReleaseHTML(ctx context.Context, installationID int64, repositoryID string, releaseID int64) (string, error) {
	var out struct {
		BodyHTML string `json:"body_html"`
	}
	err := a.get(ctx, installationID, fmt.Sprintf("/repositories/%s/releases/%d", url.PathEscape(repositoryID), releaseID),
		"application/vnd.github.full+json", &out)
	return out.BodyHTML, err
}

// PullRequestFiles returns complete path evidence or fails closed. GitHub caps
// this endpoint at 3000 files; a truncated list cannot decide a false branch.
func (a *App) PullRequestFiles(ctx context.Context, installationID int64, repositoryID string, number int) ([]string, error) {
	pr, err := a.PullRequest(ctx, installationID, repositoryID, number)
	if err != nil {
		return nil, err
	}
	if pr.ChangedFiles == nil || *pr.ChangedFiles < 0 || *pr.ChangedFiles > 3000 {
		return nil, ErrIncompleteFiles
	}
	files := make([]string, 0, *pr.ChangedFiles)
	seen := map[string]bool{}
	for page := 1; len(files) < *pr.ChangedFiles; page++ {
		var out []struct {
			Filename string `json:"filename"`
		}
		if err := a.get(ctx, installationID, fmt.Sprintf("/repositories/%s/pulls/%d/files?per_page=100&page=%d", url.PathEscape(repositoryID), number, page), "", &out); err != nil {
			return nil, err
		}
		if len(out) == 0 || len(out) > 100 || page > 30 {
			return nil, ErrIncompleteFiles
		}
		for _, file := range out {
			if file.Filename == "" || seen[file.Filename] {
				return nil, ErrIncompleteFiles
			}
			seen[file.Filename] = true
			files = append(files, file.Filename)
		}
	}
	if len(files) != *pr.ChangedFiles {
		return nil, ErrIncompleteFiles
	}
	return files, nil
}

var ErrIncompleteFiles = errors.New("complete GitHub pull request file evidence unavailable")

// MaxMilestonePullRequests bounds a milestone release's pull requests.
const MaxMilestonePullRequests = 500

// MilestonePullRequests lists the pull request numbers assigned to a
// milestone through the issues API, which returns pull requests with a
// pull_request key. A milestone over the bound fails closed.
func (a *App) MilestonePullRequests(ctx context.Context, installationID int64, repositoryID string, milestone int) ([]int, error) {
	numbers := []int{}
	for page := 1; ; page++ {
		var out []struct {
			Number      int             `json:"number"`
			PullRequest json.RawMessage `json:"pull_request"`
		}
		if err := a.get(ctx, installationID, fmt.Sprintf("/repositories/%s/issues?milestone=%d&state=all&per_page=100&page=%d", url.PathEscape(repositoryID), milestone, page), "", &out); err != nil {
			return nil, err
		}
		for _, item := range out {
			if len(item.PullRequest) > 0 && string(item.PullRequest) != "null" && item.Number > 0 {
				numbers = append(numbers, item.Number)
			}
		}
		if len(numbers) > MaxMilestonePullRequests {
			return nil, ErrIncompleteMilestone
		}
		if len(out) < 100 {
			return numbers, nil
		}
		if page == MaxMilestonePullRequests/100 {
			return nil, ErrIncompleteMilestone
		}
	}
}

var ErrIncompleteMilestone = errors.New("the milestone has more pull requests than a release takes")

func (a *App) get(ctx context.Context, installationID int64, path, accept string, out any) error {
	token, err := a.InstallationToken(ctx, installationID)
	if err != nil {
		return err
	}
	return a.request(ctx, http.MethodGet, a.API+path, "token "+token, accept, nil, out)
}

func (a *App) do(ctx context.Context, method, target, authorization string, body []byte, out any) error {
	return a.request(ctx, method, target, authorization, "", body, out)
}

// StatusError is a non-2xx GitHub answer; 404 also covers repositories the App cannot see.
type StatusError struct {
	Status      int
	RateLimited bool
}

func (e StatusError) Error() string { return fmt.Sprintf("github returned %d", e.Status) }

func (a *App) request(ctx context.Context, method, target, authorization, accept string, body []byte, out any) error {
	request, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(body))
	if err != nil {
		return err
	}
	if accept == "" {
		accept = "application/vnd.github+json"
	}
	request.Header.Set("Accept", accept)
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	request.Header.Set("User-Agent", "shots-github-app")
	if authorization != "" {
		request.Header.Set("Authorization", authorization)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := a.HTTP.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<16))
		return StatusError{Status: response.StatusCode, RateLimited: response.StatusCode == 429 || response.Header.Get("Retry-After") != "" || response.Header.Get("X-RateLimit-Remaining") == "0"}
	}
	if out == nil {
		_, err := io.Copy(io.Discard, io.LimitReader(response.Body, 1<<16))
		return err
	}
	return json.NewDecoder(io.LimitReader(response.Body, 32<<20)).Decode(out)
}
