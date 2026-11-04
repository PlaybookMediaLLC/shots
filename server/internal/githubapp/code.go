package githubapp

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Code reads for Code Studio imports (RFC 053). Each runs only on a member's
// explicit request: a link they paste. An installation ID of 0 reads
// anonymously, which works for public repositories and gists.

// MaxCodeBytes bounds one file or patch read; larger answers fail.
const MaxCodeBytes = 1 << 20

// MaxChangedFiles bounds a pull request or commit import.
const MaxChangedFiles = 20

// ChangedFile is one file of a pull request or commit, with its unified patch.
// Patch is empty for binary files and for changes GitHub will not inline.
type ChangedFile struct {
	Filename string `json:"filename"`
	Status   string `json:"status"`
	Patch    string `json:"patch"`
}

// GistFile is one file of a gist.
type GistFile struct {
	Filename  string `json:"filename"`
	Language  string `json:"language"`
	Content   string `json:"content"`
	Truncated bool   `json:"truncated"`
}

// ErrTooLarge means GitHub answered with more code than an import takes.
var ErrTooLarge = fmt.Errorf("the code is larger than %d bytes", MaxCodeBytes)

// NewPublic reads public repositories and gists without App credentials.
func NewPublic() *App {
	return &App{HTTP: &http.Client{Timeout: 20 * time.Second}, API: envOr("GITHUB_API_URL", "https://api.github.com")}
}

func (a *App) authorization(ctx context.Context, installationID int64) (string, error) {
	if installationID == 0 || a.Key == nil {
		return "", nil
	}
	token, err := a.InstallationToken(ctx, installationID)
	if err != nil {
		return "", err
	}
	return "token " + token, nil
}

func repoPath(owner, repo string) string {
	return "/repos/" + url.PathEscape(owner) + "/" + url.PathEscape(repo)
}

// FileText reads one file at a ref as text.
func (a *App) FileText(ctx context.Context, installationID int64, owner, repo, ref, path string) (string, error) {
	authorization, err := a.authorization(ctx, installationID)
	if err != nil {
		return "", err
	}
	escaped := make([]string, 0)
	for _, part := range strings.Split(strings.Trim(path, "/"), "/") {
		escaped = append(escaped, url.PathEscape(part))
	}
	target := a.API + repoPath(owner, repo) + "/contents/" + strings.Join(escaped, "/") + "?ref=" + url.QueryEscape(ref)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("Accept", "application/vnd.github.raw")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	request.Header.Set("User-Agent", "shots-github-app")
	if authorization != "" {
		request.Header.Set("Authorization", authorization)
	}
	response, err := a.HTTP.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<16))
		return "", StatusError{Status: response.StatusCode, RateLimited: response.StatusCode == 429 || response.Header.Get("X-RateLimit-Remaining") == "0"}
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, MaxCodeBytes+1))
	if err != nil {
		return "", err
	}
	if len(body) > MaxCodeBytes {
		return "", ErrTooLarge
	}
	return string(body), nil
}

func (a *App) read(ctx context.Context, installationID int64, path string, out any) error {
	authorization, err := a.authorization(ctx, installationID)
	if err != nil {
		return err
	}
	return a.request(ctx, http.MethodGet, a.API+path, authorization, "", nil, out)
}

// PullRequestChanges reads a pull request's title and its first changed files with patches.
func (a *App) PullRequestChanges(ctx context.Context, installationID int64, owner, repo string, number int) (string, []ChangedFile, error) {
	var pr struct {
		Title string `json:"title"`
	}
	if err := a.read(ctx, installationID, fmt.Sprintf("%s/pulls/%d", repoPath(owner, repo), number), &pr); err != nil {
		return "", nil, err
	}
	var files []ChangedFile
	if err := a.read(ctx, installationID, fmt.Sprintf("%s/pulls/%d/files?per_page=%d", repoPath(owner, repo), number, MaxChangedFiles), &files); err != nil {
		return "", nil, err
	}
	return pr.Title, boundFiles(files), nil
}

// CommitChanges reads a commit's message and its first changed files with patches.
func (a *App) CommitChanges(ctx context.Context, installationID int64, owner, repo, sha string) (string, []ChangedFile, error) {
	var commit struct {
		Commit struct {
			Message string `json:"message"`
		} `json:"commit"`
		Files []ChangedFile `json:"files"`
	}
	if err := a.read(ctx, installationID, repoPath(owner, repo)+"/commits/"+url.PathEscape(sha), &commit); err != nil {
		return "", nil, err
	}
	title, _, _ := strings.Cut(commit.Commit.Message, "\n")
	return title, boundFiles(commit.Files), nil
}

func boundFiles(files []ChangedFile) []ChangedFile {
	if len(files) > MaxChangedFiles {
		files = files[:MaxChangedFiles]
	}
	return files
}

// Gist reads a gist's description and files.
func (a *App) Gist(ctx context.Context, id string) (string, []GistFile, error) {
	var gist struct {
		Description string              `json:"description"`
		Files       map[string]GistFile `json:"files"`
	}
	if err := a.read(ctx, 0, "/gists/"+url.PathEscape(id), &gist); err != nil {
		return "", nil, err
	}
	files := make([]GistFile, 0, len(gist.Files))
	for _, file := range gist.Files {
		files = append(files, file)
	}
	if len(files) > MaxChangedFiles {
		files = files[:MaxChangedFiles]
	}
	return gist.Description, files, nil
}
