package integrations

import (
	"context"
	"io"
	"net/http"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ssrf"
)

// PostDeleter deletes a record that the connected account published: a post,
// a thread part or a reply. A record that is already gone returns an error
// whose HTTPStatus is 404 or 410; a delete is safe to repeat.
type PostDeleter interface {
	DeletePost(ctx context.Context, integration *ent.Integration, remoteID string) error
}

// SendDelete sends one delete request and keeps only the HTTP status of a
// failure, never the response body, which can quote the post. A nil client
// uses the SSRF-guarded default.
func SendDelete(ctx context.Context, client *http.Client, url string, headers map[string]string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, url, nil)
	if err != nil {
		return err
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	if client == nil {
		client = ssrf.Client()
	}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<20))
	return CheckResponse(res)
}
