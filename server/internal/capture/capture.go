// Package capture takes product screenshots through a Microlink-compatible
// API, the same service and request the web's screenshot capture uses.
package capture

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	goimage "image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	_ "golang.org/x/image/webp"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publicnet"
)

// maxScreenshotBytes bounds one downloaded screenshot, and
// maxScreenshotSide each of its decoded dimensions.
const (
	maxScreenshotBytes = 20 << 20
	maxScreenshotSide  = 16384
)

// ErrUnsafeURL refuses a page or image address the capture will not reach.
var ErrUnsafeURL = errors.New("capture address refused")

// Client calls the screenshot API.
type Client struct {
	API  string
	Key  string
	HTTP *http.Client
}

// FromEnvironment reads SCREENSHOT_API_URL (default Microlink) and the
// optional SCREENSHOT_API_KEY.
func FromEnvironment() *Client {
	api := strings.TrimRight(os.Getenv("SCREENSHOT_API_URL"), "/")
	if api == "" {
		api = "https://api.microlink.io"
	}
	return &Client{API: api, Key: os.Getenv("SCREENSHOT_API_KEY"), HTTP: &http.Client{Timeout: 45 * time.Second, Transport: publicnet.Transport()}}
}

// Options choose the viewport and color scheme, as the web's
// POST /api/screenshot does.
type Options struct {
	Mobile bool
	// ColorScheme is "light" or "dark"; empty leaves the page's default.
	ColorScheme string
	// Fresh bypasses the service's cache, which otherwise answers a repeated
	// URL with an image up to a day old.
	Fresh bool
}

// Capture screenshots a public page as it is now, at a desktop viewport, and
// returns the image. A deployment must show what it shipped, not a cached copy.
func (c *Client) Capture(ctx context.Context, pageURL string) ([]byte, error) {
	return c.CaptureWith(ctx, pageURL, Options{Fresh: true})
}

// CaptureWith screenshots a public page with the given viewport and color
// scheme. A mobile capture is a current iPhone viewport, like the web's.
// Every caller gets the same refusal of local and private pages.
func (c *Client) CaptureWith(ctx context.Context, pageURL string, options Options) ([]byte, error) {
	if !PublicPageURL(pageURL) {
		return nil, ErrUnsafeURL
	}
	query := url.Values{"meta": {"false"}, "screenshot": {"true"}, "url": {pageURL},
		"viewport.height": {"1080"}, "viewport.isMobile": {"false"}, "viewport.width": {"1920"}}
	if options.Mobile {
		query.Set("viewport.height", "844")
		query.Set("viewport.isMobile", "true")
		query.Set("viewport.width", "390")
	}
	if options.ColorScheme != "" {
		query.Set("colorScheme", options.ColorScheme)
	}
	if options.Fresh {
		query.Set("force", "true")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.API+"/?"+query.Encode(), nil)
	if err != nil {
		return nil, err
	}
	if c.Key != "" {
		request.Header.Set("x-api-key", c.Key)
	}
	response, err := c.HTTP.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	var out struct {
		Data struct {
			Message    string `json:"message"`
			Screenshot struct {
				URL string `json:"url"`
			} `json:"screenshot"`
		} `json:"data"`
		Status string `json:"status"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&out); err != nil {
		return nil, err
	}
	if response.StatusCode != http.StatusOK || out.Status != "success" || out.Data.Screenshot.URL == "" {
		return nil, fmt.Errorf("screenshot API returned %d %s", response.StatusCode, out.Data.Message)
	}
	return c.download(ctx, out.Data.Screenshot.URL)
}

// imageHost reports whether an image address is on the API's own host or,
// over HTTPS, Microlink's CDN.
func (c *Client) imageHost(image *url.URL) bool {
	api, err := url.Parse(c.API)
	if err != nil || image.User != nil {
		return false
	}
	if image.Host == api.Host {
		return image.Scheme == api.Scheme
	}
	return image.Scheme == "https" && image.Port() == "" && strings.HasSuffix(strings.ToLower(image.Hostname()), ".microlink.io")
}

// download fetches the image only from the API's own host or Microlink's CDN,
// checked again on every redirect hop, so a hostile answer cannot point the
// worker at another host. The transport refuses private addresses besides.
func (c *Client) download(ctx context.Context, imageURL string) ([]byte, error) {
	image, err := url.Parse(imageURL)
	if err != nil || !c.imageHost(image) {
		return nil, ErrUnsafeURL
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, imageURL, nil)
	if err != nil {
		return nil, err
	}
	client := *c.HTTP
	client.CheckRedirect = func(next *http.Request, via []*http.Request) error {
		if len(via) >= 3 || !c.imageHost(next.URL) {
			return ErrUnsafeURL
		}
		return nil
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("screenshot download returned %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxScreenshotBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxScreenshotBytes {
		return nil, errors.New("screenshot too large")
	}
	if kind := http.DetectContentType(body); kind != "image/png" && kind != "image/jpeg" && kind != "image/webp" {
		return nil, errors.New("screenshot is not a PNG, JPEG, or WebP image")
	}
	config, _, err := goimage.DecodeConfig(bytes.NewReader(body))
	if err != nil || config.Width < 1 || config.Height < 1 || config.Width > maxScreenshotSide || config.Height > maxScreenshotSide {
		return nil, errors.New("screenshot dimensions refused")
	}
	return body, nil
}

// PublicPageURL reports whether raw is an http(s) URL whose host is not
// local or private: the web's assertPublicCaptureUrl, so a capture through
// any transport refuses the same addresses.
func PublicPageURL(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" {
		return false
	}
	host := strings.ToLower(strings.Trim(parsed.Hostname(), "[]"))
	if host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") {
		return false
	}
	address, err := netip.ParseAddr(host)
	if err != nil {
		return true
	}
	address = address.Unmap()
	return !(address.IsLoopback() || address.IsPrivate() || address.IsLinkLocalUnicast() ||
		address.IsLinkLocalMulticast() || address.IsUnspecified() || address.IsMulticast() ||
		(address.Is4() && (address.As4()[0] == 0 || (address.As4()[0] == 100 && address.As4()[1]&0xc0 == 64))))
}

var (
	revisionToken = regexp.MustCompile(`(?i)\b[0-9a-f]{7,64}\b`)
	signInPath    = regexp.MustCompile(`(?i)(^|/)(log[-_]?in|sign[-_]?in|sign[-_]?on|sso|oauth2?|authorize)(/|$)`)
)

// IsSignInPath reports whether a URL path is a sign-in page.
func IsSignInPath(path string) bool { return signInPath.MatchString(path) }

// RevisionAnswer is what an app's version report says about a commit.
type RevisionAnswer int

const (
	// RevisionUnreported means the text names no commit at all.
	RevisionUnreported RevisionAnswer = iota
	// RevisionOther means it names only other commits.
	RevisionOther
	// RevisionMatches means it names this commit, full or at least seven characters.
	RevisionMatches
)

// CompareRevision reads a version report against the expected commit.
func CompareRevision(report, sha string) RevisionAnswer {
	tokens := revisionToken.FindAllString(report, -1)
	if len(tokens) == 0 {
		return RevisionUnreported
	}
	for _, token := range tokens {
		if strings.HasPrefix(strings.ToLower(sha), strings.ToLower(token)) {
			return RevisionMatches
		}
	}
	return RevisionOther
}
