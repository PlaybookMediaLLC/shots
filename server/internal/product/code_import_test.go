package product

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/auditlog"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/githubapp"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

func TestParseCodeLink(t *testing.T) {
	cases := map[string]codeLink{
		"https://github.com/acme/api/blob/3f2a9c1/src/server.ts#L10-L20": {kind: "github-file", owner: "acme", repo: "api", ref: "3f2a9c1", path: "src/server.ts", startLine: 10, endLine: 20},
		"https://github.com/acme/api/blob/main/README.md#L7":             {kind: "github-file", owner: "acme", repo: "api", ref: "main", path: "README.md", startLine: 7, endLine: 7},
		"https://github.com/acme/api/blob/main/a.go#L9-L3":               {kind: "github-file", owner: "acme", repo: "api", ref: "main", path: "a.go", startLine: 3, endLine: 9},
		"https://github.com/acme/api/pull/42/files":                      {kind: "github-pull", owner: "acme", repo: "api", number: 42},
		"https://github.com/acme/api/pull/42/commits/abcdef1":            {kind: "github-commit", owner: "acme", repo: "api", number: 42, sha: "abcdef1"},
		"https://github.com/acme/api/commit/0123456789abcdef":            {kind: "github-commit", owner: "acme", repo: "api", sha: "0123456789abcdef"},
		"https://gist.github.com/someone/aa5a315d61ae9438b18d":           {kind: "gist", gist: "aa5a315d61ae9438b18d"},
	}
	for raw, want := range cases {
		got, err := parseCodeLink(raw)
		if err != nil || got != want {
			t.Errorf("%s: got %+v %v, want %+v", raw, got, err, want)
		}
	}
	for _, raw := range []string{
		"http://github.com/acme/api/pull/1",
		"https://gitlab.com/acme/api/-/blob/main/a.go",
		"https://github.com/acme/api",
		"https://github.com/acme/api/issues/1",
		"https://github.com/acme/api/pull/zero",
		"https://github.com/acme/api/commit/not-a-sha",
		"https://gist.github.com/someone/not-hex",
		"https://github.com/../api/pull/1",
	} {
		if _, err := parseCodeLink(raw); !errors.Is(err, ErrInvalidInput) {
			t.Errorf("%s accepted: %v", raw, err)
		}
	}
}

type fakeCodeReader struct {
	installations []int64
	file          string
	err           error
}

func (f *fakeCodeReader) FileText(_ context.Context, installation int64, _, _, _, _ string) (string, error) {
	f.installations = append(f.installations, installation)
	return f.file, f.err
}

func (f *fakeCodeReader) PullRequestChanges(_ context.Context, installation int64, _, _ string, _ int) (string, []githubapp.ChangedFile, error) {
	f.installations = append(f.installations, installation)
	return "Faster cold starts", []githubapp.ChangedFile{
		{Filename: "a.go", Status: "modified", Patch: "@@ -1 +1 @@\n-old\n+new"},
		{Filename: "logo.png", Status: "added"},
	}, f.err
}

func (f *fakeCodeReader) CommitChanges(context.Context, int64, string, string, string) (string, []githubapp.ChangedFile, error) {
	return "", nil, f.err
}

func (f *fakeCodeReader) Gist(context.Context, string) (string, []githubapp.GistFile, error) {
	return "", []githubapp.GistFile{{Filename: "hello.py", Content: "print('hi')"}}, f.err
}

func TestImportCode(t *testing.T) {
	w := newTestWorkspace(t)
	subscribe(t, w.ctx, w.repo, w.org, "pro")
	w.addMember(t, "viewer", "viewer")
	reader := &fakeCodeReader{file: "one\ntwo\nthree\nfour"}
	w.repo.WithCodeReader(reader)

	got, err := w.repo.ImportCode(w.ctx, w.owner, "https://github.com/acme/api/blob/main/src/x.ts#L2-L3")
	if err != nil || len(got.Files) != 1 || got.Files[0].Code != "two\nthree" || got.Files[0].Name != "x.ts" || got.StartLine != 2 || got.Repo != "acme/api" {
		t.Fatalf("file import=%+v err=%v", got, err)
	}
	// Without a linked installation for the account, reads are anonymous.
	if reader.installations[0] != 0 {
		t.Fatalf("read with installation %d", reader.installations[0])
	}
	pr, err := w.repo.ImportCode(w.ctx, w.owner, "https://github.com/acme/api/pull/7")
	if err != nil || len(pr.Files) != 1 || pr.Files[0].Patch == "" || pr.Title != "Faster cold starts" {
		t.Fatalf("pull import=%+v err=%v", pr, err)
	}
	if _, err := w.repo.ImportCode(w.ctx, w.actor("viewer"), "https://gist.github.com/x/aa5a315d61ae9438b18d"); err == nil {
		t.Fatal("a viewer imported code")
	}
	reader.err = githubapp.StatusError{Status: 404}
	if _, err := w.repo.ImportCode(w.ctx, w.owner, "https://github.com/acme/private/blob/main/a.go"); !errors.Is(err, publishing.ErrNotFound) || !strings.Contains(err.Error(), "connect GitHub") {
		t.Fatalf("private repo error=%v", err)
	}
	reader.err = nil
	reader.file = "binary\x00data"
	if _, err := w.repo.ImportCode(w.ctx, w.owner, "https://github.com/acme/api/blob/main/a.bin"); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("binary import=%v", err)
	}
	events, err := w.db.Client.AuditLog.Query().Where(auditlog.OrganizationID(w.org), auditlog.Action("product.code_imported")).All(w.ctx)
	if err != nil || len(events) != 2 {
		t.Fatalf("audit=%d %v", len(events), err)
	}
	for _, event := range events {
		for _, value := range event.Metadata {
			if text, ok := value.(string); ok && strings.Contains(text, "two") {
				t.Fatal("the audit log kept imported code")
			}
		}
	}
}
