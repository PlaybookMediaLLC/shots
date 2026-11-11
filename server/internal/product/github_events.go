package product

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/activity"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/deploymentevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/githubinstallation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/outboxevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/predicate"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/productsurface"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/release"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/sourceapp"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/sourcechange"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/surfacecapture"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/capture"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/githubapp"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publicnet"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasenotes"
)

// Product events the worker hands back to the product, because doing them
// takes GitHub, storage, or capture rather than SQL alone.
const (
	EventSourceChangeCollected = "source_change.collected"
	EventReleaseIngested       = "release.ingested"
	EventSourceAppConnected    = "source_app.connected"
	EventDeploymentSucceeded   = "deployment.succeeded"
)

// GitHubReader is what the worker reads from GitHub as the App.
type GitHubReader interface {
	Repository(ctx context.Context, installationID int64, repositoryID string) (githubapp.Repository, error)
	Releases(ctx context.Context, installationID int64, repositoryID string, limit int) ([]githubapp.Release, error)
	MergedPullRequests(ctx context.Context, installationID int64, repositoryID, base string, limit int) ([]githubapp.PullRequest, error)
	PullRequest(ctx context.Context, installationID int64, repositoryID string, number int) (githubapp.PullRequest, error)
	PullRequestFiles(ctx context.Context, installationID int64, repositoryID string, number int) ([]string, error)
	MilestonePullRequests(ctx context.Context, installationID int64, repositoryID string, milestone int) ([]int, error)
	ReleaseHTML(ctx context.Context, installationID int64, repositoryID string, releaseID int64) (string, error)
	InstallationToken(ctx context.Context, installationID int64) (string, error)
	CommitForRef(ctx context.Context, installationID int64, repositoryID, ref string) (string, error)
}

// Capturer takes a screenshot of a public page.
type Capturer interface {
	Capture(ctx context.Context, pageURL string) ([]byte, error)
}

// WithCapturer enables capturing the product after production deployments.
func (c *Configuration) WithCapturer(capturer Capturer) *Configuration {
	c.capture = capturer
	return c
}

// ErrNotEligible means the event's record is gone or cancelled; the worker
// retries, then dead-letters it, as it does for every release event.
var ErrNotEligible = errors.New("tenant resource is no longer eligible for dispatch")

// HandleOutboxEvent does a product event's side effect. It reports false for
// an event it does not own. Each handler is safe to run again after a crash.
func (c *Configuration) HandleOutboxEvent(ctx context.Context, eventID, organizationID, eventType, aggregateID string) (bool, error) {
	switch eventType {
	case EventGitHubObservation:
		return true, c.processGitHubObservation(ctx, organizationID, aggregateID)
	case EventReleaseAutomationDispatch:
		return true, c.dispatchReleaseAutomation(ctx, organizationID, aggregateID, false)
	case EventReleaseAutomationCancel:
		return true, c.dispatchReleaseAutomation(ctx, organizationID, aggregateID, true)
	case EventSourceChangeCollected:
		return true, c.enrichChange(ctx, organizationID, aggregateID)
	case EventReleaseIngested:
		return true, c.releaseScreenshots(ctx, eventID, organizationID, aggregateID)
	case EventSourceAppConnected:
		return true, c.backfillSource(ctx, organizationID, aggregateID)
	case EventDeploymentSucceeded:
		return true, c.captureDeployment(ctx, organizationID, aggregateID)
	case EventCaptureJobDispatch:
		return true, c.dispatchCaptureJob(ctx, organizationID, aggregateID)
	case EventCaptureConnectionFinish:
		return true, c.dispatchCaptureConnection(ctx, organizationID, aggregateID)
	case EventCampaignPostsSubmitted, EventCampaignPostsDecided:
		// Personal deliveries are claimed independently by the notification dispatcher.
		return true, nil
	}
	return false, nil
}

// readerFor returns the App and installation that deliver a source, or nil
// when the source is a hand-made webhook or its installation is not active.
func (c *Configuration) readerFor(ctx context.Context, source *ent.SourceApp) (GitHubReader, int64, error) {
	reader, ok := c.github.(GitHubReader)
	if !ok || source.GithubInstallationID == nil {
		return nil, 0, nil
	}
	row, err := c.client.GitHubInstallation.Get(ctx, *source.GithubInstallationID)
	if ent.IsNotFound(err) {
		return nil, 0, nil
	}
	if err != nil {
		return nil, 0, err
	}
	if row.Status != githubinstallation.StatusACTIVE {
		return nil, 0, nil
	}
	return reader, row.InstallationID, nil
}

// enrichChange records the paths a collected PR changed, never their contents.
func (c *Configuration) enrichChange(ctx context.Context, organizationID, changeID string) error {
	change, err := c.client.SourceChange.Query().Where(sourcechange.ID(changeID), sourcechange.OrganizationID(organizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return ErrNotEligible
	}
	if err != nil {
		return err
	}
	source, err := c.client.SourceApp.Get(ctx, change.SourceAppID)
	if err != nil {
		return err
	}
	reader, installation, err := c.readerFor(ctx, source)
	if err != nil || reader == nil || len(change.Files) > 0 {
		return err
	}
	files, err := reader.PullRequestFiles(ctx, installation, change.RepositoryID, change.Number)
	if err != nil {
		return err
	}
	if len(files) > 300 {
		files = files[:300]
	}
	return change.Update().SetFiles(files).Exec(ctx)
}

// releaseScreenshots stores the images a release and its merged changes show
// as workspace assets. GitHub signs images in private repositories with
// short-lived URLs, so they are read through the App at download time.
func (c *Configuration) releaseScreenshots(ctx context.Context, eventID, organizationID, releaseID string) error {
	row, err := c.client.Release.Query().Where(release.ID(releaseID), release.OrganizationID(organizationID),
		release.StatusNEQ(release.StatusCANCELLED)).Only(ctx)
	if ent.IsNotFound(err) {
		return ErrNotEligible
	}
	if err != nil || len(row.ScreenshotAssetIds) > 0 || c.objects == nil {
		return err
	}
	event, err := c.client.OutboxEvent.Query().Where(outboxevent.ID(eventID), outboxevent.OrganizationID(organizationID)).Only(ctx)
	if err != nil {
		return err
	}
	sourceID, _ := event.Payload["sourceAppId"].(string)
	source, err := c.client.SourceApp.Query().Where(sourceapp.ID(sourceID), sourceapp.OrganizationID(organizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	changes, err := c.client.SourceChange.Query().Where(sourcechange.OrganizationID(organizationID),
		sourcechange.ReleaseID(releaseID)).Order(ent.Asc(sourcechange.FieldMergedAt)).Limit(releasenotes.MaxImages).All(ctx)
	if err != nil {
		return err
	}
	var images []string
	reader, installation, err := c.readerFor(ctx, source)
	if err != nil {
		return err
	}
	if reader != nil {
		if githubReleaseID, ok := payloadInt(event.Payload["githubReleaseId"]); ok && source.ExternalID != nil {
			html, err := reader.ReleaseHTML(ctx, installation, *source.ExternalID, githubReleaseID)
			if err != nil {
				return err
			}
			images = append(images, releasenotes.Images(html)...)
		}
		for _, change := range changes {
			pr, err := reader.PullRequest(ctx, installation, change.RepositoryID, change.Number)
			if err != nil {
				return err
			}
			images = append(images, releasenotes.Images(pr.BodyHTML)...)
		}
	} else {
		if row.Notes != nil {
			images = append(images, releasenotes.Images(*row.Notes)...)
		}
		for _, change := range changes {
			images = append(images, change.ImageUrls...)
		}
	}
	// An image stored in a private repository is private too: it is read from
	// GitHub's raw host with the installation token, which goes nowhere else.
	private, token := map[string]bool{}, ""
	if reader != nil && source.ExternalID != nil && len(images) > 0 {
		repository, err := reader.Repository(ctx, installation, *source.ExternalID)
		if err != nil {
			return err
		}
		for i, imageURL := range images {
			if raw, ok := repositoryFile(imageURL, repository.FullName); ok {
				images[i], private[raw] = raw, true
			}
		}
		if len(private) > 0 {
			if token, err = reader.InstallationToken(ctx, installation); err != nil {
				return err
			}
		}
	}
	actor := Actor{OrganizationID: organizationID, Kind: "service", Display: "github", RequestID: eventID}
	if source.PlatformOwnerUserID != nil {
		actor.UserID = *source.PlatformOwnerUserID
	}
	assets := []string{}
	for i, imageURL := range dedupe(images, releasenotes.MaxImages) {
		authorization := ""
		if private[imageURL] {
			authorization = "Bearer " + token
		}
		body, contentType, err := c.fetchImage(ctx, imageURL, authorization)
		if err != nil {
			slog.Info("release screenshot skipped", "release", releaseID, "reason", err.Error())
			continue
		}
		stored, err := c.storeImage(ctx, actor, body, contentType, fmt.Sprintf("release-%d", i+1))
		if err != nil {
			slog.Info("release screenshot not stored", "release", releaseID, "reason", err.Error())
			continue
		}
		assets = append(assets, stored)
	}
	if len(assets) == 0 {
		return nil
	}
	return row.Update().SetScreenshotAssetIds(assets).Exec(ctx)
}

func payloadInt(value any) (int64, bool) {
	switch number := value.(type) {
	case float64:
		return int64(number), number > 0
	case string:
		parsed, err := strconv.ParseInt(number, 10, 64)
		return parsed, err == nil && parsed > 0
	}
	return 0, false
}

func dedupe(values []string, max int) []string {
	result := []string{}
	for _, value := range values {
		if !slices.Contains(result, value) && len(result) < max {
			result = append(result, value)
		}
	}
	return result
}

// maxImageBytes bounds one downloaded screenshot.
const maxImageBytes = 10 << 20

// githubImageHost admits GitHub's own image hosts only: a URL in third-party
// text must never make the worker fetch an internal address.
func githubImageHost(host string) bool {
	host = strings.ToLower(host)
	return host == "github.com" || strings.HasSuffix(host, ".githubusercontent.com")
}

func (c *Configuration) imageHTTP() *http.Client {
	allowed := c.imageHost
	if allowed == nil {
		allowed = githubImageHost
	}
	client := &http.Client{Timeout: 20 * time.Second}
	if c.web != nil {
		client.Transport = c.web.Transport
	}
	// Every redirect hop is checked again: a hop to an internal address is refused.
	client.CheckRedirect = func(request *http.Request, via []*http.Request) error {
		if len(via) >= 5 || request.URL.Scheme != "https" || !allowed(request.URL.Hostname()) {
			return errors.New("image redirect refused")
		}
		return nil
	}
	return client
}

// repositoryFile maps an image stored in the repository (a blob, raw, or
// raw.githubusercontent.com URL) to its address on GitHub's raw host.
func repositoryFile(imageURL, repositoryName string) (string, bool) {
	parsed, err := url.Parse(imageURL)
	if err != nil || parsed.Scheme != "https" || repositoryName == "" {
		return "", false
	}
	parts := strings.Split(strings.TrimPrefix(parsed.EscapedPath(), "/"), "/")
	switch strings.ToLower(parsed.Host) {
	case "github.com":
		if len(parts) < 5 || (parts[2] != "blob" && parts[2] != "raw") {
			return "", false
		}
		parts = append(parts[:2:2], parts[3:]...)
	case "raw.githubusercontent.com":
		if len(parts) < 4 {
			return "", false
		}
	default:
		return "", false
	}
	for _, part := range parts {
		// A dot segment could walk to another repository the token can read.
		if segment, err := url.PathUnescape(part); err != nil || segment == "" || segment == "." || segment == ".." {
			return "", false
		}
	}
	if !strings.EqualFold(parts[0]+"/"+parts[1], repositoryName) {
		return "", false
	}
	return "https://raw.githubusercontent.com/" + strings.Join(parts, "/"), true
}

// fetchImage downloads a PNG, JPEG, or WebP image from an allowed host. A
// request carrying credentials never follows a redirect.
func (c *Configuration) fetchImage(ctx context.Context, imageURL, authorization string) ([]byte, string, error) {
	allowed := c.imageHost
	if allowed == nil {
		allowed = githubImageHost
	}
	parsed, err := url.Parse(imageURL)
	if err != nil || parsed.Scheme != "https" || !allowed(parsed.Hostname()) {
		return nil, "", errors.New("image host refused")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, imageURL, nil)
	if err != nil {
		return nil, "", err
	}
	client := c.imageHTTP()
	if authorization != "" {
		request.Header.Set("Authorization", authorization)
		client.CheckRedirect = func(*http.Request, []*http.Request) error { return errors.New("image redirect refused") }
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("image returned %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxImageBytes+1))
	if err != nil {
		return nil, "", err
	}
	if len(body) > maxImageBytes {
		return nil, "", errors.New("image too large")
	}
	contentType := http.DetectContentType(body)
	if contentType != "image/png" && contentType != "image/jpeg" && contentType != "image/webp" {
		return nil, "", errors.New("not a PNG, JPEG, or WebP image")
	}
	return body, contentType, nil
}

func (c *Configuration) storeImage(ctx context.Context, actor Actor, body []byte, contentType, name string) (string, error) {
	config, _, err := image.DecodeConfig(bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	extension := map[string]string{"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}[contentType]
	stored, err := c.StoreGeneratedAsset(ctx, actor, GeneratedAssetInput{Body: body, Classification: "capture",
		ContentType: contentType, FileName: name + "." + extension, Height: config.Height, Width: config.Width})
	if err != nil {
		return "", err
	}
	return stored.ID, nil
}

// backfillLimits bound what connecting a repository imports. GitHub lists
// releases by their commit's date, not when they were published, so a page is
// scanned for the most recently published ones.
const (
	backfillReleases = 5
	backfillScan     = 30
	backfillMerges   = 30
)

// backfillSource imports a newly connected repository's recent releases, then
// holds the merges since the latest one for the next release. It goes through
// the same idempotent ingestion as live webhooks, so a delivery that races it
// is a no-op.
func (c *Configuration) backfillSource(ctx context.Context, organizationID, sourceAppID string) error {
	source, err := c.client.SourceApp.Query().Where(sourceapp.ID(sourceAppID), sourceapp.OrganizationID(organizationID),
		sourceapp.StatusEQ(sourceapp.StatusACTIVE)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil
	}
	if err != nil || source.ExternalID == nil {
		return err
	}
	reader, installation, err := c.readerFor(ctx, source)
	if err != nil || reader == nil {
		return err
	}
	repositoryID := *source.ExternalID
	repository, err := reader.Repository(ctx, installation, repositoryID)
	if err != nil {
		return err
	}
	releases, err := reader.Releases(ctx, installation, repositoryID, backfillScan)
	if err != nil {
		return err
	}
	releases = slices.DeleteFunc(releases, func(item githubapp.Release) bool {
		return source.SkipPrereleases && item.Prerelease
	})
	slices.SortStableFunc(releases, func(a, b githubapp.Release) int { return b.PublishedAt.Compare(a.PublishedAt) })
	releases = releases[:min(len(releases), backfillReleases)]
	actor := Actor{OrganizationID: organizationID, Kind: "webhook", Display: source.ID, RequestID: "backfill:" + source.ID}
	var latest time.Time
	for i := len(releases) - 1; i >= 0; i-- {
		item := releases[i]
		if err := c.recordHistoricalRelease(ctx, source, repository, item); err != nil {
			return err
		}
		notes := releasenotes.Clean(item.Body, MaxReleaseNotesRunes)
		title := releasenotes.Clean(firstNonEmpty(item.Name, item.TagName), 160)
		repositoryName := repository.FullName
		input := IngestSourceReleaseInput{BenefitStatement: releasenotes.Clean(firstNonEmpty(notes, item.TagName), 500),
			EventID: "release:" + repositoryID + ":" + strconv.FormatInt(item.ID, 10), Notes: &notes, RepositoryID: &repositoryID,
			RepositoryName: &repositoryName, SourceAppID: source.ID, SourceURLs: []string{}, Title: title}
		if item.HTMLURL != "" {
			input.SourceURLs = []string{item.HTMLURL}
		}
		owner, repo, _ := strings.Cut(repository.FullName, "/")
		numbers := releasenotes.PullRequests(notes, owner, repo)
		for _, feature := range releasenotes.Features(notes) {
			if feature.Number > 0 && !slices.Contains(numbers, feature.Number) {
				numbers = append(numbers, feature.Number)
			}
		}
		input.automationAssociation = &sourceReleaseAssociation{Numbers: numbers, Cutoff: item.PublishedAt}
		imported, err := c.IngestSourceRelease(ctx, actor, input)
		if err != nil && !errors.Is(err, ErrInvalidInput) {
			return err
		}
		if err == nil {
			if err := c.recordHistoricalReleaseOutput(ctx, organizationID, source.ID, input.EventID, imported.ReleaseID); err != nil {
				return err
			}
		}
		if item.PublishedAt.After(latest) {
			latest = item.PublishedAt
		}
	}
	branch := repository.DefaultBranch
	if source.Branch != nil {
		branch = *source.Branch
	}
	merged, err := reader.MergedPullRequests(ctx, installation, repositoryID, branch, backfillMerges)
	if err != nil {
		return err
	}
	for _, pr := range merged {
		if pr.MergedAt == nil || !pr.MergedAt.After(latest) || ignoresPullRequestAuthor(source, pr.User.Login, pr.User.Type) {
			continue
		}
		if err := c.recordHistoricalPR(ctx, source, repository, pr); err != nil {
			return err
		}
		labels := []string{}
		for _, label := range pr.Labels {
			if label.Name != "" && len(labels) < 50 {
				labels = append(labels, label.Name)
			}
		}
		author := pr.User.Login
		input := CollectSourceChangeInput{AuthorLogin: &author, Body: pr.Body, EventID: "backfill", Labels: labels,
			MergedAt: *pr.MergedAt, Number: pr.Number, RepositoryID: repositoryID, SourceAppID: source.ID,
			Title: pr.Title, URL: pr.HTMLURL}
		if author == "" {
			input.AuthorLogin = nil
		}
		if _, err := c.CollectSourceChange(ctx, actor, input); err != nil && !errors.Is(err, ErrInvalidInput) {
			return err
		}
	}
	return nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

// ignoresPullRequestAuthor applies a source's author rules with GitHub's
// account type, which only the API (not release notes) reports.
func ignoresPullRequestAuthor(source *ent.SourceApp, login, accountType string) bool {
	if source.IgnoreBotPullRequests && accountType == "Bot" {
		return true
	}
	return ignoresAuthor(source, login)
}

// maxCapturedSurfaces bounds the pages one deployment captures.
const maxCapturedSurfaces = 10

// captureDeployment captures the workspace's registered production pages on
// the deployed origin once the deployment answers. Only registered product
// surfaces are captured, never a URL taken from the payload. Each page's
// capture is a receipt: a retried run captures only the pages still missing,
// and the deployment is CAPTURED only when every page has one.
func (c *Configuration) captureDeployment(ctx context.Context, organizationID, deploymentID string) error {
	row, err := c.client.DeploymentEvent.Query().Where(deploymentevent.ID(deploymentID), deploymentevent.OrganizationID(organizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return ErrNotEligible
	}
	if err != nil || row.Status != deploymentevent.StatusRECEIVED {
		return err
	}
	skip := func(code string) error {
		return row.Update().SetStatus(deploymentevent.StatusSKIPPED).SetFailureCode(code).Exec(ctx)
	}
	// The source may have been archived since the deployment arrived.
	active, err := c.client.SourceApp.Query().Where(sourceapp.ID(row.SourceAppID), sourceapp.OrganizationID(organizationID),
		sourceapp.StatusEQ(sourceapp.StatusACTIVE)).Exist(ctx)
	if err != nil {
		return err
	}
	if !active {
		return skip("source_inactive")
	}
	already, err := capturedBefore(ctx, c.client, row)
	if err != nil {
		return err
	}
	// A page behind a login is a durable job's, not a public screenshot's.
	jobOwned, err := c.admitDeploymentCaptures(ctx, row, already)
	if err != nil {
		return err
	}
	// The page now shows a newer deployment, which captures it as its own.
	superseded, err := deploymentSuperseded(ctx, c.client, row)
	if err != nil {
		return err
	}
	if superseded {
		return skip(captureSuperseded)
	}
	if row.URL == nil {
		return skip("deployment_url_missing")
	}
	deployed, err := url.Parse(*row.URL)
	if err != nil {
		return skip("deployment_url_invalid")
	}
	if !capture.PublicPageURL(*row.URL) {
		return skip("deployment_url_refused")
	}
	candidates, err := c.client.ProductSurface.Query().Where(productsurface.OrganizationID(organizationID),
		productsurface.Environment("production")).Order(ent.Asc(productsurface.FieldName)).All(ctx)
	if err != nil {
		return err
	}
	var surfaces []*ent.ProductSurface
	unchanged := false
	for _, surface := range candidates {
		parsed, err := url.Parse(surface.URL)
		if err != nil || jobOwned[surface.ID] || !sameOrigin(parsed, deployed) || !capture.PublicPageURL(surface.URL) {
			continue
		}
		if already[surface.ID] {
			unchanged = true
		} else if len(surfaces) < maxCapturedSurfaces {
			surfaces = append(surfaces, surface)
		}
	}
	if len(surfaces) == 0 {
		switch {
		case len(jobOwned) > 0:
			return skip("capture_jobs_admitted")
		case unchanged:
			return skip("already_captured")
		}
		return skip("deployment_host_rejected")
	}
	if c.capture == nil || c.objects == nil {
		return skip("capture_unavailable")
	}
	// Not live yet: fail so the worker retries on its next run, the readiness
	// window. A private destination is refused for good.
	if err := c.ready(ctx, surfaces[0].URL); errors.Is(err, errUnsafeDeploymentURL) || errors.Is(err, publicnet.ErrBlocked) {
		return skip("deployment_url_refused")
	} else if err != nil {
		return err
	}
	receipts, err := c.client.SurfaceCapture.Query().Where(surfacecapture.OrganizationID(organizationID),
		surfacecapture.SourceEQ(surfacecapture.SourceDeployment), surfacecapture.SourceID(row.ID)).All(ctx)
	if err != nil {
		return err
	}
	captured := map[string]string{}
	for _, receipt := range receipts {
		captured[receipt.SurfaceID] = receipt.AssetID
	}
	failed := func(surface *ent.ProductSurface, code string, err error) error {
		slog.Info("deployment capture failed", "surface", surface.ID, "code", code, "reason", err.Error())
		tx, txErr := c.client.Tx(ctx)
		if txErr != nil {
			return txErr
		}
		defer tx.Rollback()
		if txErr = tx.ProductSurface.UpdateOneID(surface.ID).SetLastCaptureFailureCode(code).Exec(ctx); txErr != nil {
			return txErr
		}
		if txErr = activity.Emit(ctx, tx, organizationID, "capture.failed", "product_surface", surface.ID, "", deploymentID+":"+surface.ID, map[string]any{"background": true}); txErr != nil {
			return txErr
		}
		return tx.Commit()
	}
	assets := []string{}
	for i, surface := range surfaces {
		if asset, ok := captured[surface.ID]; ok {
			assets = append(assets, asset)
			continue
		}
		receipt, code, err := c.captureDeploymentSurface(ctx, row, surface, fmt.Sprintf("deployment-%d", i+1), nil)
		if code != "" {
			if err := failed(surface, code, err); err != nil {
				return err
			}
			continue
		}
		if err != nil {
			return err
		}
		assets = append(assets, receipt.AssetID)
	}
	update := row.Update().SetAssetIds(assets).SetStatus(deploymentevent.StatusCAPTURED)
	switch {
	case len(assets) == 0:
		update.SetStatus(deploymentevent.StatusFAILED).SetFailureCode("capture_failed")
	case len(assets) < len(surfaces):
		update.SetStatus(deploymentevent.StatusPARTIAL).SetFailureCode("capture_incomplete")
	}
	return update.Exec(ctx)
}

// captureSuperseded ends a capture whose deployment a newer one replaced.
const captureSuperseded = "superseded"

// deploymentKind compares a deployment with the earlier ones of its source and
// environment, by the provider's time. Only a new commit is a release.
// shortcut: it knows only deployments Shots saw, so a rollback to a commit never
// deployed here is new; asking GitHub whether the commit is an ancestor of the
// live one closes that, if it matters.
func deploymentKind(ctx context.Context, tx *ent.Tx, source *ent.SourceApp, environment string, sha *string, externalID string, at time.Time) (deploymentevent.Kind, error) {
	earlier := tx.DeploymentEvent.Query().Where(deploymentevent.OrganizationID(source.OrganizationID), deploymentevent.SourceAppID(source.ID),
		deploymentevent.Environment(environment), deploymentevent.DeployedAtLTE(at))
	live, err := earlier.Clone().Order(ent.Desc(deploymentevent.FieldDeployedAt), ent.Desc(deploymentevent.FieldCreatedAt), ent.Desc(deploymentevent.FieldID)).First(ctx)
	if ent.IsNotFound(err) {
		return deploymentevent.KindNew, nil
	}
	if err != nil {
		return "", err
	}
	same := sameDeployedVersion(sha, externalID)
	if redeploy, err := earlier.Clone().Where(deploymentevent.ID(live.ID), same).Exist(ctx); err != nil {
		return "", err
	} else if redeploy {
		return deploymentevent.KindRedeploy, nil
	}
	if rollback, err := earlier.Where(same).Exist(ctx); err != nil {
		return "", err
	} else if rollback {
		return deploymentevent.KindRollback, nil
	}
	return deploymentevent.KindNew, nil
}

// sameDeployedVersion matches deployments of one commit, and every activation
// of one provider deployment, which is how a provider without commits rolls back.
func sameDeployedVersion(sha *string, root string) predicate.DeploymentEvent {
	same := []predicate.DeploymentEvent{deploymentevent.ExternalID(root), deploymentevent.ExternalIDHasPrefix(root + "@")}
	if sha != nil && *sha != "" {
		same = append(same, deploymentevent.Sha(*sha))
	}
	return deploymentevent.Or(same...)
}

// capturedBefore lists the surfaces a redeploy need not capture again: those an
// earlier deployment of the same commit captured.
func capturedBefore(ctx context.Context, client *ent.Client, deployment *ent.DeploymentEvent) (map[string]bool, error) {
	captured := map[string]bool{}
	if deployment.Kind != deploymentevent.KindRedeploy {
		return captured, nil
	}
	root, _, _ := strings.Cut(deployment.ExternalID, "@")
	earlier, err := client.DeploymentEvent.Query().Where(deploymentevent.OrganizationID(deployment.OrganizationID), deploymentevent.SourceAppID(deployment.SourceAppID),
		deploymentevent.Environment(deployment.Environment), deploymentevent.IDNEQ(deployment.ID), sameDeployedVersion(deployment.Sha, root)).IDs(ctx)
	if err != nil || len(earlier) == 0 {
		return captured, err
	}
	surfaces, err := client.SurfaceCapture.Query().Where(surfacecapture.OrganizationID(deployment.OrganizationID), surfacecapture.SourceEQ(surfacecapture.SourceDeployment),
		surfacecapture.SourceIDIn(earlier...)).Select(surfacecapture.FieldSurfaceID).Strings(ctx)
	for _, surface := range surfaces {
		captured[surface] = true
	}
	return captured, err
}

// deploymentSuperseded reports whether the provider has since deployed the same
// source and environment again, which makes this deployment's captures moot.
func deploymentSuperseded(ctx context.Context, client *ent.Client, deployment *ent.DeploymentEvent) (bool, error) {
	return client.DeploymentEvent.Query().Where(deploymentevent.OrganizationID(deployment.OrganizationID), deploymentevent.SourceAppID(deployment.SourceAppID),
		deploymentevent.Environment(deployment.Environment), deploymentevent.DeployedAtGT(deployment.DeployedAt)).Exist(ctx)
}

// captureDeploymentSurface takes a page's capture for a deployment and records
// it as the deployment's receipt for that page, with the commit the app reported
// when there is one. A failure the page itself caused returns a safe code.
func (c *Configuration) captureDeploymentSurface(ctx context.Context, deployment *ent.DeploymentEvent, surface *ent.ProductSurface, name string, revision *string) (*ent.SurfaceCapture, string, error) {
	page, err := c.probePage(ctx, surface.URL)
	if errors.Is(err, errUnsafeDeploymentURL) || errors.Is(err, publicnet.ErrBlocked) {
		return nil, "deployment_url_refused", err
	}
	if err == nil && page.signIn(surface.URL) {
		return nil, "capture_login_page", errors.New("the page asks visitors to sign in")
	}
	actor := Actor{OrganizationID: deployment.OrganizationID, Kind: "service", Display: "deployment", RequestID: deployment.ID}
	if surface.PlatformOwnerUserID != nil {
		actor.UserID = *surface.PlatformOwnerUserID
	}
	shot, err := c.capture.Capture(ctx, surface.URL)
	if err != nil {
		return nil, "capture_failed", err
	}
	stored, err := c.storeImage(ctx, actor, shot, http.DetectContentType(shot), name)
	if err != nil {
		return nil, "asset_unavailable", err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, "", err
	}
	defer tx.Rollback()
	receipt, err := recordCapture(ctx, tx, actor, surface, stored, surfacecapture.SourceDeployment, &deployment.ID, revision)
	if err != nil {
		return nil, "", err
	}
	return receipt, "", tx.Commit()
}

// sameOrigin compares scheme, host, and effective port, so an HTTPS
// deployment never selects an HTTP page or another port on its host.
func sameOrigin(a, b *url.URL) bool {
	port := func(u *url.URL) string {
		if p := u.Port(); p != "" {
			return p
		}
		return map[string]string{"http": "80", "https": "443"}[strings.ToLower(u.Scheme)]
	}
	return strings.EqualFold(a.Scheme, b.Scheme) && strings.EqualFold(a.Hostname(), b.Hostname()) && port(a) == port(b)
}

// errUnsafeDeploymentURL refuses a request to a private or credentialed
// address, or a redirect to one.
var errUnsafeDeploymentURL = errors.New("deployment address refused")

// probedPage is what the backend saw when it requested a customer page.
type probedPage struct {
	status int
	final  *url.URL
	body   []byte
}

// maxProbedBytes bounds how much of a customer page the backend reads.
const maxProbedBytes = 256 << 10

// customerPages carries every request the backend makes to a customer's page.
var customerPages = publicnet.Transport()

// probePage requests a customer page from the backend itself, so it dials
// public addresses only, follows at most three redirects, and checks each
// hop's scheme and credentials again.
func (c *Configuration) probePage(ctx context.Context, pageURL string) (*probedPage, error) {
	page, err := url.Parse(pageURL)
	if err != nil || !capture.PublicPageURL(pageURL) || page.User != nil {
		return nil, errUnsafeDeploymentURL
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, pageURL, nil)
	if err != nil {
		return nil, err
	}
	// The customer's page is not a dependency: it gets no trace headers.
	client := &http.Client{Timeout: 15 * time.Second, Transport: customerPages}
	if c.web != nil {
		client.Transport = c.web.Transport
	}
	client.CheckRedirect = func(next *http.Request, via []*http.Request) error {
		if len(via) >= 3 || next.URL.User != nil || !capture.PublicPageURL(next.URL.String()) {
			return errUnsafeDeploymentURL
		}
		return nil
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxProbedBytes))
	if err != nil {
		return nil, err
	}
	return &probedPage{status: response.StatusCode, final: response.Request.URL, body: body}, nil
}

var passwordField = regexp.MustCompile(`(?i)<input\b[^>]*\btype\s*=\s*["']?password`)

// signIn reports whether a request for a page ended on a sign-in form or a
// sign-in path instead. A surface registered at a sign-in path is that page,
// not a redirect to it. A form an app renders in the browser cannot be seen
// here; only version proof or an authenticated capture can rule it out.
func (p *probedPage) signIn(requested string) bool {
	page, err := url.Parse(requested)
	if err == nil && capture.IsSignInPath(page.Path) {
		return false
	}
	return passwordField.Match(p.body) || capture.IsSignInPath(p.final.Path)
}

// ready reports whether the deployed page answers successfully.
func (c *Configuration) ready(ctx context.Context, pageURL string) error {
	page, err := c.probePage(ctx, pageURL)
	if err != nil {
		return fmt.Errorf("deployment not ready: %w", err)
	}
	if page.status >= 400 {
		return fmt.Errorf("deployment not ready: %d", page.status)
	}
	return nil
}
