package product

import (
	"context"
	"errors"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/githubinstallation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/workspacegithubinstallation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/githubapp"
)

// CodeReader reads code from GitHub for an import. Installation ID 0 reads anonymously.
type CodeReader interface {
	FileText(ctx context.Context, installationID int64, owner, repo, ref, path string) (string, error)
	PullRequestChanges(ctx context.Context, installationID int64, owner, repo string, number int) (string, []githubapp.ChangedFile, error)
	CommitChanges(ctx context.Context, installationID int64, owner, repo, sha string) (string, []githubapp.ChangedFile, error)
	Gist(ctx context.Context, id string) (string, []githubapp.GistFile, error)
}

// WithCodeReader enables Code Studio imports from GitHub links (RFC 053).
func (c *Configuration) WithCodeReader(reader CodeReader) *Configuration {
	c.codeReader = reader
	return c
}

// Bounds on what one import returns.
const (
	codeImportFileLimit  = 100_000
	codeImportTotalLimit = 1 << 20
)

// CodeImportFile is one imported file: whole code, or a unified patch to apply.
type CodeImportFile struct {
	Name   string `json:"name"`
	Code   string `json:"code,omitempty"`
	Patch  string `json:"patch,omitempty"`
	Status string `json:"status,omitempty"`
}

// CodeImport is what a link holds. Nothing of it is stored: the member decides
// what reaches a project, and only that project keeps it.
type CodeImport struct {
	Kind      string           `json:"kind"`
	URL       string           `json:"url"`
	Repo      string           `json:"repo,omitempty"`
	Ref       string           `json:"ref,omitempty"`
	Path      string           `json:"path,omitempty"`
	Title     string           `json:"title,omitempty"`
	StartLine int              `json:"startLine,omitempty"`
	Files     []CodeImportFile `json:"files"`
}

// codeLink is a parsed GitHub link.
type codeLink struct {
	kind               string
	owner, repo        string
	ref, path, sha     string
	number             int
	gist               string
	startLine, endLine int
}

var (
	githubName   = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,100}$`)
	gistID       = regexp.MustCompile(`^[0-9a-fA-F]{8,64}$`)
	commitSHA    = regexp.MustCompile(`^[0-9a-fA-F]{7,40}$`)
	lineFragment = regexp.MustCompile(`^L(\d+)(?:C\d+)?(?:-L(\d+)(?:C\d+)?)?$`)
)

// parseCodeLink reads a GitHub file permalink (with an optional #L10-L20),
// pull request, commit or gist link.
func parseCodeLink(raw string) (codeLink, error) {
	bad := invalid("Paste a GitHub file, pull request, commit or gist link.")
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "https" || len(raw) > 2_000 {
		return codeLink{}, bad
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	switch strings.ToLower(parsed.Host) {
	case "gist.github.com":
		id := parts[len(parts)-1]
		if !gistID.MatchString(id) {
			return codeLink{}, bad
		}
		return codeLink{kind: "gist", gist: id}, nil
	case "github.com", "www.github.com":
	default:
		return codeLink{}, bad
	}
	dots := func(name string) bool { return strings.Trim(name, ".") == "" }
	if len(parts) < 4 || !githubName.MatchString(parts[0]) || !githubName.MatchString(parts[1]) || dots(parts[0]) || dots(parts[1]) {
		return codeLink{}, bad
	}
	link := codeLink{owner: parts[0], repo: strings.TrimSuffix(parts[1], ".git")}
	switch parts[2] {
	case "blob":
		if len(parts) < 5 {
			return codeLink{}, bad
		}
		// shortcut: a branch name with "/" reads as ref plus path; permalinks use a commit, which never does.
		link.kind, link.ref, link.path = "github-file", parts[3], strings.Join(parts[4:], "/")
		if match := lineFragment.FindStringSubmatch(parsed.Fragment); match != nil {
			link.startLine, _ = strconv.Atoi(match[1])
			link.endLine = link.startLine
			if match[2] != "" {
				link.endLine, _ = strconv.Atoi(match[2])
			}
			if link.endLine < link.startLine {
				link.startLine, link.endLine = link.endLine, link.startLine
			}
		}
	case "pull":
		number, err := strconv.Atoi(parts[3])
		if err != nil || number < 1 {
			return codeLink{}, bad
		}
		link.kind, link.number = "github-pull", number
		if len(parts) >= 6 && parts[4] == "commits" && commitSHA.MatchString(parts[5]) {
			link.kind, link.sha = "github-commit", parts[5]
		}
	case "commit":
		if !commitSHA.MatchString(parts[3]) {
			return codeLink{}, bad
		}
		link.kind, link.sha = "github-commit", parts[3]
	default:
		return codeLink{}, bad
	}
	return link, nil
}

// codeInstallation finds the workspace's active GitHub installation for an
// account, or 0 to read anonymously.
func (c *Configuration) codeInstallation(ctx context.Context, organizationID, owner string) (int64, error) {
	links, err := c.client.WorkspaceGitHubInstallation.Query().Where(workspacegithubinstallation.OrganizationID(organizationID)).All(ctx)
	if err != nil {
		return 0, err
	}
	for _, link := range links {
		row, err := c.client.GitHubInstallation.Get(ctx, link.GithubInstallationID)
		if err != nil {
			return 0, err
		}
		if row.Status == githubinstallation.StatusACTIVE && strings.EqualFold(row.AccountLogin, owner) {
			return row.InstallationID, nil
		}
	}
	return 0, nil
}

// codeImportError turns a GitHub refusal into what the member can act on.
func codeImportError(err error, private bool) error {
	var status githubapp.StatusError
	switch {
	case errors.Is(err, githubapp.ErrTooLarge):
		return invalid("That file is over 1 MB. Link to a line range instead.")
	case errors.As(err, &status) && status.RateLimited:
		return ErrRateLimited
	case errors.As(err, &status) && (status.Status == 404 || status.Status == 403 || status.Status == 401):
		if private {
			return notFound("Shots cannot read that link. Check that the workspace's GitHub connection includes the repository.")
		}
		return notFound("Shots cannot read that link. For a private repository, connect GitHub in Workspace settings first.")
	}
	return ErrGitHubUnavailable
}

// ImportCode reads the code a GitHub link points to, for a member building a
// code project (RFC 053). Reading code happens only on this explicit request;
// the result is returned, never stored, and the audit log records the link's
// repository and kind but no code.
func (c *Configuration) ImportCode(ctx context.Context, actor Actor, raw string) (*CodeImport, error) {
	if c.codeReader == nil {
		return nil, ErrGitHubUnavailable
	}
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	if err := c.authorizeRoles(ctx, actor, creativeSetEditRoles...); err != nil {
		return nil, err
	}
	link, err := parseCodeLink(raw)
	if err != nil {
		return nil, err
	}
	result := &CodeImport{Kind: link.kind, URL: strings.TrimSpace(raw), Files: []CodeImportFile{}}
	var installation int64
	if link.kind != "gist" {
		result.Repo = link.owner + "/" + link.repo
		if installation, err = c.codeInstallation(ctx, actor.OrganizationID, link.owner); err != nil {
			return nil, err
		}
	}
	switch link.kind {
	case "github-file":
		text, err := c.codeReader.FileText(ctx, installation, link.owner, link.repo, link.ref, link.path)
		if err != nil {
			return nil, codeImportError(err, installation != 0)
		}
		if !utf8.ValidString(text) || strings.ContainsRune(text, 0) {
			return nil, invalid("That file is not text.")
		}
		if link.startLine > 0 {
			lines := strings.Split(text, "\n")
			start := min(link.startLine, len(lines))
			end := min(link.endLine, len(lines))
			text = strings.Join(lines[start-1:end], "\n")
			result.StartLine = start
		}
		name := link.path[strings.LastIndex(link.path, "/")+1:]
		result.Ref, result.Path = link.ref, link.path
		result.Files = append(result.Files, CodeImportFile{Name: name, Code: text})
	case "github-pull", "github-commit":
		var title string
		var files []githubapp.ChangedFile
		if link.kind == "github-pull" {
			title, files, err = c.codeReader.PullRequestChanges(ctx, installation, link.owner, link.repo, link.number)
			result.Ref = "#" + strconv.Itoa(link.number)
		} else {
			title, files, err = c.codeReader.CommitChanges(ctx, installation, link.owner, link.repo, link.sha)
			result.Ref = link.sha
		}
		if err != nil {
			return nil, codeImportError(err, installation != 0)
		}
		result.Title = title
		for _, file := range files {
			if file.Patch == "" {
				continue
			}
			result.Files = append(result.Files, CodeImportFile{Name: file.Filename, Patch: file.Patch, Status: file.Status})
		}
	case "gist":
		title, files, err := c.codeReader.Gist(ctx, link.gist)
		if err != nil {
			return nil, codeImportError(err, false)
		}
		result.Title = title
		for _, file := range files {
			result.Files = append(result.Files, CodeImportFile{Name: file.Filename, Code: file.Content})
		}
	}
	total := 0
	kept := result.Files[:0]
	for _, file := range result.Files {
		size := utf8.RuneCountInString(file.Code) + utf8.RuneCountInString(file.Patch)
		if size > codeImportFileLimit || total+size > codeImportTotalLimit {
			continue
		}
		total += size
		kept = append(kept, file)
	}
	result.Files = kept
	if len(result.Files) == 0 {
		return nil, invalid("That link has no text changes or files small enough to import.")
	}
	metadata := map[string]any{"kind": link.kind, "files": len(result.Files)}
	if result.Repo != "" {
		metadata["repo"] = result.Repo
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	entity := result.Repo
	if link.kind == "gist" {
		entity = "gist:" + link.gist
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.code_imported", "codeImport", entity, metadata); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return result, nil
}
