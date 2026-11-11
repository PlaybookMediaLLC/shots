package product

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	"image/png"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/captureattempt"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/capturejob"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/deploymentevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/outboxevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformappconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseautomationrun"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasesourceevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/surfacecapture"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/capture/browser"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/capture/sessionstate"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/githubapp"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	automation "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releaseautomation"
	"github.com/go-rod/rod/lib/proto"
)

const captureSecret = "dummy-session-secret"

// scriptedBrowser stands in for the provider. The real runner is proven against
// Chrome in the browser package; this one scripts what each attempt finds.
type scriptedBrowser struct {
	mu        sync.Mutex
	sessions  map[string]bool
	allocated [][]string
	closed    []string
	links     int
	exported  error
	verify    error
	run       func(browser.RunInput) (*browser.RunResult, error)
	runs      atomic.Int32
	seenState []*browser.State
	during    func()
}

func newScriptedBrowser(t *testing.T) *scriptedBrowser {
	var shot bytes.Buffer
	if err := png.Encode(&shot, image.NewRGBA(image.Rect(0, 0, 800, 600))); err != nil {
		t.Fatal(err)
	}
	s := &scriptedBrowser{sessions: map[string]bool{}}
	s.run = func(input browser.RunInput) (*browser.RunResult, error) {
		return &browser.RunResult{Image: shot.Bytes(), Width: 800, Height: 600, ObservedRevision: input.ExpectedRevision}, nil
	}
	return s
}

func (s *scriptedBrowser) Allocate(_ context.Context, hosts []string, _ time.Duration) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := fmt.Sprintf("session-%d", len(s.allocated)+1)
	s.allocated = append(s.allocated, hosts)
	s.sessions[id] = true
	return id, nil
}
func (s *scriptedBrowser) LiveView(context.Context, string, time.Duration) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.links++
	return fmt.Sprintf("https://live.example/view?jwt=dummy-live-view-%d", s.links), nil
}
func (s *scriptedBrowser) Close(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, id)
	s.closed = append(s.closed, id)
	return nil
}
func (s *scriptedBrowser) OpenLogin(context.Context, string, browser.Target) error { return nil }
func (s *scriptedBrowser) Export(context.Context, string, browser.Target) (*browser.State, error) {
	if s.exported != nil {
		return nil, s.exported
	}
	return &browser.State{Cookies: []*proto.NetworkCookieParam{{Name: "session", Value: captureSecret, Domain: "app.example.com"}}}, nil
}
func (s *scriptedBrowser) Verify(context.Context, string, browser.Target, *browser.State) error {
	return s.verify
}
func (s *scriptedBrowser) Run(_ context.Context, _ string, input browser.RunInput) (*browser.RunResult, error) {
	s.runs.Add(1)
	s.mu.Lock()
	s.seenState = append(s.seenState, input.State)
	s.mu.Unlock()
	if s.during != nil {
		s.during()
	}
	return s.run(input)
}
func (s *scriptedBrowser) open() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sessions)
}

type captureWorld struct {
	*automationFixture
	browser *scriptedBrowser
	keys    *sessionstate.Keys
	surface string
}

func newCaptureWorld(t *testing.T) *captureWorld {
	t.Helper()
	f := newAutomationFixture(t)
	keys, err := sessionstate.NewKeys(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	w := &captureWorld{automationFixture: f, browser: newScriptedBrowser(t), keys: keys, surface: "surface" + f.id}
	f.repo.WithObjectStore(&recordingAssetObjects{}).WithAuthenticatedCapture(w.browser, keys)
	f.exec(t, `INSERT INTO product_surface (id,"organizationId",name,slug,url,"featureTags","screenshotAssetIds","createdAt","updatedAt") VALUES ($1,$2,'App','app','https://app.example.com/dashboard','[]','[]',now(),now())`, w.surface, f.org)
	return w
}

func (w *captureWorld) connection(t *testing.T) *CaptureConnectionRecord {
	t.Helper()
	source := w.source.ID
	record, err := w.repo.CreateCaptureConnection(w.ctx, w.owner, CreateCaptureConnectionInput{Name: "Demo app", SourceAppID: &source, Environment: "production", Origin: "https://app.example.com",
		Hosts: []string{"app.example.com"}, LoginHosts: []string{"accounts.example.com"}, ProtectedPath: "/dashboard", IdentitySelector: "[data-testid=account]", ExpectedAccount: "demo"})
	if err != nil {
		t.Fatal(err)
	}
	return record
}

// signIn is a person using Live View and pressing Done, then the worker's half.
func (w *captureWorld) signIn(t *testing.T, id string) *CaptureConnectStart {
	t.Helper()
	start, err := w.repo.StartCaptureConnect(w.ctx, w.owner, id)
	if err != nil {
		t.Fatal(err)
	}
	if err := w.repo.FinishCaptureConnect(w.ctx, w.owner, id, start.IntentID); err != nil {
		t.Fatal(err)
	}
	if err := w.repo.CompleteCaptureConnection(w.ctx, w.org, id); err != nil {
		t.Fatal(err)
	}
	return start
}

func (w *captureWorld) recipe(t *testing.T, connection string, change ...func(*browser.Recipe)) *CaptureRecipeRecord {
	t.Helper()
	definition := browser.Recipe{SchemaVersion: 1, Viewport: browser.Viewport{Width: 800, Height: 600}, Steps: []browser.Step{{Kind: browser.StepNavigate, Path: "/dashboard"}},
		Markers: []string{"[data-testid=ready]"}, Version: &browser.VersionCheck{Path: "/api/version"}}
	for _, apply := range change {
		apply(&definition)
	}
	record, err := w.repo.CreateCaptureRecipe(w.ctx, w.owner, CreateCaptureRecipeInput{Name: "Dashboard", SurfaceID: w.surface, ConnectionID: connection, Definition: definition})
	if err != nil {
		t.Fatal(err)
	}
	return record
}

// ready connects, tests, and activates, as the normal customer journey does.
func (w *captureWorld) ready(t *testing.T) (*CaptureConnectionRecord, *CaptureRecipeRecord) {
	t.Helper()
	connection := w.connection(t)
	w.signIn(t, connection.ID)
	recipe := w.recipe(t, connection.ID)
	test, err := w.repo.RequestCaptureJob(w.ctx, w.owner, recipe.ID, CaptureJobRequest{Test: true})
	if err != nil {
		t.Fatal(err)
	}
	if outcome, err := w.repo.RunCaptureJob(w.ctx, w.org, test.ID); err != nil || !outcome.Done {
		t.Fatalf("test capture: %+v %v", outcome, err)
	}
	if recipe, err = w.repo.ActivateCaptureRecipe(w.ctx, w.owner, recipe.ID); err != nil {
		t.Fatal(err)
	}
	return connection, recipe
}

func (w *captureWorld) deployment(t *testing.T, external, sha string) *CaptureJobRecord {
	t.Helper()
	result, err := w.repo.IngestDeployment(w.ctx, Actor{OrganizationID: w.org, Kind: "webhook", Display: w.source.ID}, IngestDeploymentInput{Environment: "production", EventID: "d" + external, ExternalID: external, SourceAppID: w.source.ID, SHA: &sha})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.repo.HandleOutboxEvent(w.ctx, "unused", w.org, EventDeploymentSucceeded, result.DeploymentID); err != nil {
		t.Fatal(err)
	}
	row, err := w.db.Client.CaptureJob.Query().Where(capturejob.OrganizationID(w.org), capturejob.DeploymentEventID(result.DeploymentID)).Only(w.ctx)
	if err != nil {
		t.Fatalf("deployment job: %v", err)
	}
	record := captureJobRecord(row)
	return &record
}

func (w *captureWorld) job(t *testing.T, id string) *CaptureJobRecord {
	t.Helper()
	record, err := w.repo.GetCaptureJob(w.ctx, w.owner, id)
	if err != nil {
		t.Fatal(err)
	}
	return record
}

func (w *captureWorld) run(t *testing.T, id string) *CaptureJobOutcome {
	t.Helper()
	outcome, err := w.repo.RunCaptureJob(w.ctx, w.org, id)
	if err != nil {
		t.Fatal(err)
	}
	return outcome
}

// request asks for a capture now, as a person does; no deployment supersedes it.
func (w *captureWorld) request(t *testing.T, recipeID string) *CaptureJobRecord {
	t.Helper()
	record, err := w.repo.RequestCaptureJob(w.ctx, w.owner, recipeID, CaptureJobRequest{})
	if err != nil {
		t.Fatal(err)
	}
	return record
}

func TestCaptureConnectJourneyProvesAFreshSession(t *testing.T) {
	w := newCaptureWorld(t)
	connection := w.connection(t)
	if connection.Status != "CONNECTING" {
		t.Fatalf("status=%s", connection.Status)
	}
	start, err := w.repo.StartCaptureConnect(w.ctx, w.owner, connection.ID)
	if err != nil {
		t.Fatal(err)
	}
	// The login browser may reach sign-in hosts; it is the only one that may.
	if !slices.Equal(w.browser.allocated[0], []string{"app.example.com", "accounts.example.com"}) {
		t.Fatalf("login hosts=%v", w.browser.allocated[0])
	}
	// Done alone proves nothing: not ready until the worker's fresh browser agrees.
	if err := w.repo.FinishCaptureConnect(w.ctx, w.owner, connection.ID, start.IntentID); err != nil {
		t.Fatal(err)
	}
	row := w.db.Client.PlatformAppConnection.GetX(w.ctx, connection.ID)
	if row.Status == platformappconnection.StatusREADY {
		t.Fatal("Done made the connection ready")
	}
	// A replayed Done, and a Done from a stale intent, are refused.
	if err := w.repo.FinishCaptureConnect(w.ctx, w.owner, connection.ID, start.IntentID); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("replayed finish: %v", err)
	}
	if err := w.repo.CompleteCaptureConnection(w.ctx, w.org, connection.ID); err != nil {
		t.Fatal(err)
	}
	row = w.db.Client.PlatformAppConnection.GetX(w.ctx, connection.ID)
	if row.Status != platformappconnection.StatusREADY || row.StateCiphertext == nil || row.ValidatedAt == nil || row.StateExpiresAt == nil || row.ConnectSessionID != nil || row.ConnectIntentID != nil {
		t.Fatalf("after validation: %+v", row)
	}
	// The verifying browser could reach only the capture hosts, and both closed.
	if !slices.Equal(w.browser.allocated[1], []string{"app.example.com"}) || w.browser.open() != 0 {
		t.Fatalf("verify hosts=%v open=%d", w.browser.allocated[1], w.browser.open())
	}
	// State at rest is an envelope bound to this connection and generation.
	if strings.Contains(*row.StateCiphertext, captureSecret) {
		t.Fatal("session state stored readable")
	}
	binding := sessionstate.Binding{Organization: w.org, Connection: connection.ID, Environment: "production", Generation: row.Generation}
	opened, _, err := w.keys.Open(*row.StateCiphertext, binding)
	if err != nil || !strings.Contains(string(opened), captureSecret) {
		t.Fatalf("open: %v", err)
	}
	binding.Organization = "another-org"
	if _, _, err := w.keys.Open(*row.StateCiphertext, binding); !errors.Is(err, sessionstate.ErrRefused) {
		t.Fatalf("another tenant opened the state: %v", err)
	}
	// A sign-in that does not reach the protected page never becomes ready.
	w.browser.verify = &browser.Failure{Code: browser.WrongAccount}
	second := w.connection2(t)
	w.signIn(t, second.ID)
	failed := w.db.Client.PlatformAppConnection.GetX(w.ctx, second.ID)
	if failed.Status == platformappconnection.StatusREADY || failed.StateCiphertext != nil || failed.FailureCode == nil || *failed.FailureCode != "wrong_account" {
		t.Fatalf("failed validation: %+v", failed)
	}
	if w.browser.open() != 0 {
		t.Fatalf("browsers left open: %d", w.browser.open())
	}
}

func (w *captureWorld) connection2(t *testing.T) *CaptureConnectionRecord {
	t.Helper()
	record, err := w.repo.CreateCaptureConnection(w.ctx, w.owner, CreateCaptureConnectionInput{Name: "Second", Environment: "staging", Origin: "https://app.example.com",
		Hosts: []string{"app.example.com"}, ProtectedPath: "/dashboard", IdentitySelector: "[data-testid=account]", ExpectedAccount: "demo"})
	if err != nil {
		t.Fatal(err)
	}
	return record
}

func TestCaptureHandoffBelongsToTheUserWhoStartedIt(t *testing.T) {
	w := newCaptureWorld(t)
	connection := w.connection(t)
	first, err := w.repo.StartCaptureConnect(w.ctx, w.owner, connection.ID)
	if err != nil {
		t.Fatal(err)
	}
	// A second admin's sign-in replaces the first and closes its browser.
	second, err := w.repo.StartCaptureConnect(w.ctx, w.owner, connection.ID)
	if err != nil {
		t.Fatal(err)
	}
	if w.browser.open() != 1 {
		t.Fatalf("the replaced login browser is still open: %d", w.browser.open())
	}
	if err := w.repo.FinishCaptureConnect(w.ctx, w.owner, connection.ID, first.IntentID); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("a replaced sign-in finished: %v", err)
	}
	// Another signed-in person cannot complete it, even with the intent.
	f := w.automationFixture
	f.addMember(t, "other", "admin")
	if err := f.repo.FinishCaptureConnect(f.ctx, f.actor("other"), connection.ID, second.IntentID); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("another user finished the sign-in: %v", err)
	}
	// An expired window is refused, and cleanup closes its browser.
	f.exec(t, `UPDATE platform_app_connection SET "connectExpiresAt"=now()-interval '1 minute' WHERE id=$1`, connection.ID)
	if err := w.repo.FinishCaptureConnect(w.ctx, w.owner, connection.ID, second.IntentID); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("an expired sign-in finished: %v", err)
	}
	if err := w.repo.ReclaimCaptureResources(w.ctx); err != nil {
		t.Fatal(err)
	}
	if row := w.db.Client.PlatformAppConnection.GetX(w.ctx, connection.ID); w.browser.open() != 0 || row.ConnectSessionID != nil || row.FailureCode == nil || *row.FailureCode != "connect_expired" {
		t.Fatalf("expired sign-in: open=%d row=%+v", w.browser.open(), row)
	}
}

func TestCaptureOtherTenantsAreDenied(t *testing.T) {
	w := newCaptureWorld(t)
	connection, recipe := w.ready(t)
	job := w.deployment(t, "tenant-1", "abcdef1234567890")
	w.run(t, job.ID)
	other := newTestWorkspace(t)
	subscribe(t, other.ctx, other.repo, other.org, "pro")
	other.repo.WithAuthenticatedCapture(w.browser, w.keys)
	stranger := other.owner
	checks := map[string]func() error{
		"start":  func() error { _, err := other.repo.StartCaptureConnect(other.ctx, stranger, connection.ID); return err },
		"finish": func() error { return other.repo.FinishCaptureConnect(other.ctx, stranger, connection.ID, "x") },
		"revoke": func() error { return other.repo.RevokeCaptureConnection(other.ctx, stranger, connection.ID) },
		"recipe": func() error {
			_, err := other.repo.RequestCaptureJob(other.ctx, stranger, recipe.ID, CaptureJobRequest{Test: true})
			return err
		},
		"activate": func() error { _, err := other.repo.ActivateCaptureRecipe(other.ctx, stranger, recipe.ID); return err },
		"job":      func() error { _, err := other.repo.GetCaptureJob(other.ctx, stranger, job.ID); return err },
		"cancel":   func() error { return other.repo.CancelCaptureJob(other.ctx, stranger, job.ID) },
		"use connection": func() error {
			_, err := other.repo.CreateCaptureRecipe(other.ctx, stranger, CreateCaptureRecipeInput{Name: "X", SurfaceID: w.surface, ConnectionID: connection.ID, Definition: browser.Recipe{SchemaVersion: 1, Viewport: browser.Viewport{Width: 800, Height: 600}, Steps: []browser.Step{{Kind: browser.StepNavigate, Path: "/"}}, Markers: []string{"a"}}})
			return err
		},
	}
	for name, check := range checks {
		if err := check(); !errors.Is(err, publishing.ErrNotFound) {
			t.Errorf("%s: %v", name, err)
		}
	}
	for name, list := range map[string]func() (int, error){
		"connections": func() (int, error) {
			r, err := other.repo.ListCaptureConnections(other.ctx, stranger)
			return len(r), err
		},
		"recipes": func() (int, error) { r, err := other.repo.ListCaptureRecipes(other.ctx, stranger); return len(r), err },
		"jobs":    func() (int, error) { r, err := other.repo.ListCaptureJobs(other.ctx, stranger); return len(r), err },
	} {
		if n, err := list(); err != nil || n != 0 {
			t.Errorf("%s: %d %v", name, n, err)
		}
	}
	// Another workspace cannot read the captured image.
	done := w.job(t, job.ID)
	if _, _, err := other.repo.ReadAsset(other.ctx, stranger, *done.AssetID); !errors.Is(err, publishing.ErrNotFound) {
		t.Errorf("another workspace read a capture: %v", err)
	}
	// A running job cannot be run through another organization's ID.
	if outcome, err := other.repo.RunCaptureJob(other.ctx, other.org, job.ID); err != nil || !outcome.Done {
		t.Errorf("cross-tenant run: %+v %v", outcome, err)
	}
	// An ordinary member reads status but cannot manage a connection or test.
	f := w.automationFixture
	f.addMember(t, "reader", "member")
	reader := f.actor("reader")
	if _, err := f.repo.StartCaptureConnect(f.ctx, reader, connection.ID); !errors.Is(err, publishing.ErrForbidden) {
		t.Errorf("member started a sign-in: %v", err)
	}
	if err := f.repo.RevokeCaptureConnection(f.ctx, reader, connection.ID); !errors.Is(err, publishing.ErrForbidden) {
		t.Errorf("member revoked: %v", err)
	}
	// An API key cannot start a human handoff.
	if _, err := f.repo.StartCaptureConnect(f.ctx, Actor{OrganizationID: f.org, Kind: "api_key"}, connection.ID); !errors.Is(err, publishing.ErrForbidden) {
		t.Errorf("api key started a sign-in: %v", err)
	}
}

func TestCaptureDeploymentJobIsOneCanonicalResult(t *testing.T) {
	w := newCaptureWorld(t)
	w.ready(t)
	sha := "abcdef1234567890"
	job := w.deployment(t, "release-1", sha)
	if job.ExpectedRevision == nil || *job.ExpectedRevision != sha || job.Phase != "QUEUED" {
		t.Fatalf("job=%+v", job)
	}
	// Dispatch carries only IDs.
	dispatch := w.db.Client.OutboxEvent.Query().Where(outboxevent.OrganizationID(w.org), outboxevent.Type(EventCaptureJobDispatch), outboxevent.AggregateID(job.ID)).OnlyX(w.ctx)
	if len(dispatch.Payload) != 1 || dispatch.Payload["id"] != job.ID {
		t.Fatalf("payload=%v", dispatch.Payload)
	}
	// Duplicate delivery of the same deployment finds the same job.
	result, err := w.repo.IngestDeployment(w.ctx, Actor{OrganizationID: w.org, Kind: "webhook", Display: w.source.ID}, IngestDeploymentInput{Environment: "production", EventID: "again", ExternalID: "release-1", SourceAppID: w.source.ID, SHA: &sha})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.repo.HandleOutboxEvent(w.ctx, "unused", w.org, EventDeploymentSucceeded, result.DeploymentID); err != nil {
		t.Fatal(err)
	}
	if n := w.db.Client.CaptureJob.Query().Where(capturejob.OrganizationID(w.org), capturejob.KindEQ(capturejob.KindDeployment)).CountX(w.ctx); n != 1 {
		t.Fatalf("jobs=%d", n)
	}
	before := w.browser.runs.Load()
	if outcome := w.run(t, job.ID); !outcome.Done {
		t.Fatalf("outcome=%+v", outcome)
	}
	done := w.job(t, job.ID)
	if done.Phase != "SUCCEEDED" || done.SurfaceCaptureID == nil || done.AssetID == nil || done.FailureCode != nil {
		t.Fatalf("done=%+v", done)
	}
	receipt := w.db.Client.SurfaceCapture.GetX(w.ctx, *done.SurfaceCaptureID)
	if receipt.Source != surfacecapture.SourceDeployment || receipt.ObservedRevision == nil || *receipt.ObservedRevision != sha || receipt.AssetID != *done.AssetID || receipt.SupersededAt != nil {
		t.Fatalf("receipt=%+v", receipt)
	}
	// A repeated workflow does no more work and leaves one result.
	if outcome := w.run(t, job.ID); !outcome.Done || w.browser.runs.Load() != before+1 {
		t.Fatalf("repeat ran the browser: %+v runs=%d", outcome, w.browser.runs.Load())
	}
	if n := w.db.Client.SurfaceCapture.Query().Where(surfacecapture.SurfaceID(w.surface)).CountX(w.ctx); n != 1 {
		t.Fatalf("captures=%d", n)
	}
	// Every browser this job opened is closed.
	if w.browser.open() != 0 {
		t.Fatalf("open browsers=%d", w.browser.open())
	}
	attempt := w.db.Client.CaptureAttempt.Query().Where(captureattempt.CaptureJobID(job.ID)).OnlyX(w.ctx)
	if attempt.BrowserClosedAt == nil || attempt.Status != captureattempt.StatusSUCCEEDED || attempt.ObservedRevision == nil {
		t.Fatalf("attempt=%+v", attempt)
	}
	// Public capture never touches a page a job owns.
	if row := w.db.Client.DeploymentEvent.Query().Where(deploymentevent.ID(*done.DeploymentEventID)).OnlyX(w.ctx); row.Status != deploymentevent.StatusSKIPPED || *row.FailureCode != "deployment_url_missing" {
		t.Fatalf("deployment=%+v", row)
	}
}

func TestCaptureReleaseBeforeDeploymentWaitsAndNeverRecordsOldUI(t *testing.T) {
	w := newCaptureWorld(t)
	w.ready(t)
	job := w.deployment(t, "slow", "abcdef1234567890")
	live := false
	w.browser.run = func(input browser.RunInput) (*browser.RunResult, error) {
		if !live {
			return nil, &browser.Failure{Code: browser.WaitingForDeployment}
		}
		var shot bytes.Buffer
		_ = png.Encode(&shot, image.NewRGBA(image.Rect(0, 0, 800, 600)))
		return &browser.RunResult{Image: shot.Bytes(), Width: 800, Height: 600, ObservedRevision: input.ExpectedRevision}, nil
	}
	outcome := w.run(t, job.ID)
	if outcome.Done || outcome.RetryAfterSeconds <= 0 {
		t.Fatalf("outcome=%+v", outcome)
	}
	waiting := w.job(t, job.ID)
	if waiting.Phase != "WAITING_DEPLOYMENT" || *waiting.FailureCode != "waiting_for_deployment" || waiting.SurfaceCaptureID != nil {
		t.Fatalf("waiting=%+v", waiting)
	}
	if n := w.db.Client.SurfaceCapture.Query().Where(surfacecapture.SurfaceID(w.surface)).CountX(w.ctx); n != 0 {
		t.Fatal("old UI was recorded")
	}
	// The wait holds no lease and no browser.
	if row := w.db.Client.PlatformAppConnection.GetX(w.ctx, *job.ConnectionID); row.LeaseJobID != nil || w.browser.open() != 0 {
		t.Fatalf("lease=%v open=%d", row.LeaseJobID, w.browser.open())
	}
	live = true
	if outcome := w.run(t, job.ID); !outcome.Done || w.job(t, job.ID).Phase != "SUCCEEDED" {
		t.Fatalf("after live: %+v", outcome)
	}
	// A recipe with no version proof cannot make a deployment job claim one.
	if unknown := w.job(t, job.ID); unknown.ExpectedRevision == nil {
		t.Fatal("the proof was lost")
	}
	// Without a commit to compare, a version recipe fails rather than guessing.
	result, err := w.repo.IngestDeployment(w.ctx, Actor{OrganizationID: w.org, Kind: "webhook", Display: w.source.ID}, IngestDeploymentInput{Environment: "production", EventID: "n", ExternalID: "no-sha", SourceAppID: w.source.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.repo.HandleOutboxEvent(w.ctx, "unused", w.org, EventDeploymentSucceeded, result.DeploymentID); err != nil {
		t.Fatal(err)
	}
	unproven := w.db.Client.CaptureJob.Query().Where(capturejob.DeploymentEventID(result.DeploymentID)).OnlyX(w.ctx)
	if unproven.Phase != capturejob.PhaseFAILED || *unproven.FailureCode != "deployment_unverified" {
		t.Fatalf("unproven=%+v", unproven)
	}
}

func TestCaptureExpiredSessionParksTheJobUntilAPersonReconnects(t *testing.T) {
	w := newCaptureWorld(t)
	connection, _ := w.ready(t)
	job := w.deployment(t, "auth-1", "abcdef1234567890")
	generation := w.db.Client.PlatformAppConnection.GetX(w.ctx, connection.ID).Generation
	normal := w.browser.run
	w.browser.run = func(browser.RunInput) (*browser.RunResult, error) {
		return nil, &browser.Failure{Code: browser.NeedsAuth}
	}
	if outcome := w.run(t, job.ID); !outcome.Done {
		t.Fatalf("outcome=%+v", outcome)
	}
	parked := w.job(t, job.ID)
	row := w.db.Client.PlatformAppConnection.GetX(w.ctx, connection.ID)
	if parked.Phase != "NEEDS_AUTH" || parked.SurfaceCaptureID != nil || row.Status != platformappconnection.StatusNEEDS_AUTH || row.LeaseJobID != nil || w.browser.open() != 0 {
		t.Fatalf("parked=%+v row=%+v open=%d", parked, row, w.browser.open())
	}
	// No login screenshot was accepted, and no browser or lease waits for the person.
	if n := w.db.Client.SurfaceCapture.Query().Where(surfacecapture.SurfaceID(w.surface)).CountX(w.ctx); n != 0 {
		t.Fatal("a login screen was recorded")
	}
	// Running again without a person does nothing.
	runs := w.browser.runs.Load()
	if outcome := w.run(t, job.ID); !outcome.Done || w.browser.runs.Load() != runs {
		t.Fatalf("a parked job ran: %+v", outcome)
	}
	// A reconnect resumes the same authorized job under a new generation, through
	// a new workflow.
	w.browser.run = normal
	w.signIn(t, connection.ID)
	row = w.db.Client.PlatformAppConnection.GetX(w.ctx, connection.ID)
	resumed := w.db.Client.CaptureJob.GetX(w.ctx, job.ID)
	if row.Generation != generation+1 || row.Status != platformappconnection.StatusREADY || resumed.Phase != capturejob.PhaseQUEUED || resumed.ConnectionGeneration != row.Generation || resumed.ResumeCount != 1 {
		t.Fatalf("row=%+v resumed=%+v", row, resumed)
	}
	if n := w.db.Client.OutboxEvent.Query().Where(outboxevent.Type(EventCaptureJobDispatch), outboxevent.AggregateID(job.ID)).CountX(w.ctx); n != 2 {
		t.Fatalf("dispatches=%d", n)
	}
	if outcome := w.run(t, job.ID); !outcome.Done || w.job(t, job.ID).Phase != "SUCCEEDED" {
		t.Fatalf("resumed: %+v", outcome)
	}
	// State past its retention is deleted on sight, and the job asks for a person.
	w.exec(t, `UPDATE platform_app_connection SET "stateExpiresAt"=now()-interval '1 minute' WHERE id=$1`, connection.ID)
	next := w.deployment(t, "auth-2", "fedcba0987654321")
	runs = w.browser.runs.Load()
	if outcome := w.run(t, next.ID); !outcome.Done || w.browser.runs.Load() != runs || w.job(t, next.ID).Phase != "NEEDS_AUTH" {
		t.Fatalf("expired state ran: %+v", outcome)
	}
	if row := w.db.Client.PlatformAppConnection.GetX(w.ctx, connection.ID); row.StateCiphertext != nil || row.Status != platformappconnection.StatusNEEDS_AUTH {
		t.Fatalf("expired state kept: %+v", row)
	}
}

func TestCaptureRevocationStopsQueuedAndInFlightWork(t *testing.T) {
	w := newCaptureWorld(t)
	connection, recipe := w.ready(t)
	queued := w.request(t, recipe.ID)
	flying := w.deployment(t, "revoke-2", "abcdef1234567890")
	// Revocation lands while the browser is running: the result cannot commit,
	// and the provider session closes.
	w.browser.during = func() {
		if err := w.repo.RevokeCaptureConnection(w.ctx, w.owner, connection.ID); err != nil {
			t.Error(err)
		}
	}
	if outcome := w.run(t, flying.ID); !outcome.Done {
		t.Fatalf("outcome=%+v", outcome)
	}
	w.browser.during = nil
	row := w.db.Client.PlatformAppConnection.GetX(w.ctx, connection.ID)
	if row.Status != platformappconnection.StatusREVOKED || row.StateCiphertext != nil || row.ValidatedAt != nil {
		t.Fatalf("revoked=%+v", row)
	}
	for _, id := range []string{queued.ID, flying.ID} {
		job := w.job(t, id)
		if job.Phase != "CANCELLED" || *job.FailureCode != "connection_revoked" || job.SurfaceCaptureID != nil {
			t.Fatalf("job=%+v", job)
		}
	}
	if n := w.db.Client.SurfaceCapture.Query().Where(surfacecapture.SurfaceID(w.surface)).CountX(w.ctx); n != 0 {
		t.Fatal("a result committed after revocation")
	}
	if w.browser.open() != 0 {
		t.Fatalf("open=%d", w.browser.open())
	}
	// Queued work does nothing, a revoked connection stays revoked, and new work is refused.
	runs := w.browser.runs.Load()
	if outcome := w.run(t, queued.ID); !outcome.Done || w.browser.runs.Load() != runs {
		t.Fatalf("queued ran: %+v", outcome)
	}
	if _, err := w.repo.StartCaptureConnect(w.ctx, w.owner, connection.ID); !errors.Is(err, publishing.ErrInvalidState) {
		t.Fatalf("reconnect after revoke: %v", err)
	}
	if err := w.repo.CompleteCaptureConnection(w.ctx, w.org, connection.ID); err != nil {
		t.Fatal(err)
	}
	if row := w.db.Client.PlatformAppConnection.GetX(w.ctx, connection.ID); row.Status != platformappconnection.StatusREVOKED {
		t.Fatalf("restored: %+v", row)
	}
}

func TestCaptureCancellationAndEligibilityStopACommit(t *testing.T) {
	for name, withdraw := range map[string]func(*captureWorld, *CaptureJobRecord){
		"job cancelled": func(w *captureWorld, job *CaptureJobRecord) {
			if err := w.repo.CancelCaptureJob(w.ctx, w.owner, job.ID); err != nil {
				panic(err)
			}
		},
		"source archived": func(w *captureWorld, _ *CaptureJobRecord) {
			w.db.Client.SourceApp.UpdateOneID(w.source.ID).SetStatus("ARCHIVED").ExecX(w.ctx)
		},
		"recipe archived": func(w *captureWorld, job *CaptureJobRecord) {
			if err := w.repo.ArchiveCaptureRecipe(w.ctx, w.owner, job.RecipeID); err != nil {
				panic(err)
			}
		},
	} {
		t.Run(name, func(t *testing.T) {
			w := newCaptureWorld(t)
			w.ready(t)
			job := w.deployment(t, "withdrawn", "abcdef1234567890")
			w.browser.during = func() { withdraw(w, job) }
			if outcome := w.run(t, job.ID); !outcome.Done {
				t.Fatalf("outcome=%+v", outcome)
			}
			after := w.job(t, job.ID)
			if after.Phase != "CANCELLED" || after.SurfaceCaptureID != nil {
				t.Fatalf("after=%+v", after)
			}
			if n := w.db.Client.SurfaceCapture.Query().Where(surfacecapture.SurfaceID(w.surface)).CountX(w.ctx); n != 0 {
				t.Fatal("a result committed after eligibility was lost")
			}
			// A lost attempt frees the lease at once, so the next job need not wait.
			if row := w.db.Client.PlatformAppConnection.GetX(w.ctx, *job.ConnectionID); row.LeaseJobID != nil {
				t.Fatalf("lease still held: %+v", row)
			}
		})
	}
}

func TestCaptureFencingStopsAnExpiredAttemptOverwritingANewerOne(t *testing.T) {
	w := newCaptureWorld(t)
	connection, _ := w.ready(t)
	job := w.deployment(t, "fence", "abcdef1234567890")
	// The first attempt stalls past its lease; a newer attempt takes over and commits.
	stalled := false
	normal := w.browser.run
	var newer *CaptureJobOutcome
	w.browser.run = func(input browser.RunInput) (*browser.RunResult, error) {
		if !stalled {
			stalled = true
			w.exec(t, `UPDATE platform_app_connection SET "leaseExpiresAt"=now()-interval '1 minute' WHERE id=$1`, connection.ID)
			w.exec(t, `UPDATE capture SET "startedAt"=now()-interval '10 minutes' WHERE "captureJobId"=$1`, job.ID)
			var err error
			if newer, err = w.repo.RunCaptureJob(w.ctx, w.org, job.ID); err != nil {
				t.Error(err)
			}
		}
		return normal(input)
	}
	if outcome := w.run(t, job.ID); !outcome.Done {
		t.Fatalf("old attempt: %+v", outcome)
	}
	if newer == nil || !newer.Done {
		t.Fatalf("newer=%+v", newer)
	}
	attempts := w.db.Client.CaptureAttempt.Query().Where(captureattempt.CaptureJobID(job.ID)).Order(captureattempt.ByAttemptNumber()).AllX(w.ctx)
	if len(attempts) != 2 || attempts[0].Status != captureattempt.StatusFAILED || *attempts[0].FailureCode != "fenced" || attempts[1].Status != captureattempt.StatusSUCCEEDED {
		t.Fatalf("attempts=%+v", attempts)
	}
	if n := w.db.Client.SurfaceCapture.Query().Where(surfacecapture.SurfaceID(w.surface)).CountX(w.ctx); n != 1 {
		t.Fatalf("captures=%d", n)
	}
}

// A newer attempt is still running when the older one returns: only the token
// tells them apart, and the older result writes nothing.
func TestCaptureFencingRefusesAnOlderAttemptWhileANewerOneRuns(t *testing.T) {
	w := newCaptureWorld(t)
	connection, _ := w.ready(t)
	job := w.deployment(t, "fence-running", "abcdef1234567890")
	var newer *captureClaim
	w.browser.during = func() {
		w.browser.during = nil
		w.exec(t, `UPDATE platform_app_connection SET "leaseExpiresAt"=now()-interval '1 minute' WHERE id=$1`, connection.ID)
		w.exec(t, `UPDATE capture SET "startedAt"=now()-interval '10 minutes' WHERE "captureJobId"=$1`, job.ID)
		claim, outcome, err := w.repo.claimCaptureJob(w.ctx, w.org, job.ID)
		if err != nil || outcome != nil {
			t.Errorf("newer claim: %+v %v", outcome, err)
		}
		newer = claim
	}
	if outcome := w.run(t, job.ID); !outcome.Done {
		t.Fatalf("older attempt: %+v", outcome)
	}
	attempts := w.db.Client.CaptureAttempt.Query().Where(captureattempt.CaptureJobID(job.ID)).Order(captureattempt.ByAttemptNumber()).AllX(w.ctx)
	if len(attempts) != 2 || attempts[0].Status != captureattempt.StatusFAILED || *attempts[0].FailureCode != "fenced" || attempts[1].Status != captureattempt.StatusRUNNING {
		t.Fatalf("attempts=%+v", attempts)
	}
	if n := w.db.Client.SurfaceCapture.Query().Where(surfacecapture.SurfaceID(w.surface)).CountX(w.ctx); n != 0 || w.job(t, job.ID).Phase != "RUNNING" {
		t.Fatalf("the older attempt wrote a result: captures=%d job=%+v", n, w.job(t, job.ID))
	}
	// The newer attempt still holds the lease, and it commits.
	row := w.db.Client.PlatformAppConnection.GetX(w.ctx, connection.ID)
	if row.LeaseJobID == nil || row.LeaseToken != newer.token {
		t.Fatalf("the older attempt touched the newer lease: %+v", row)
	}
	if outcome, err := w.repo.commitCapture(w.ctx, newer, nil, *attempts[0].AssetID, attempts[0].ObservedRevision, false); err != nil || !outcome.Done {
		t.Fatalf("newer commit: %+v %v", outcome, err)
	}
	if w.job(t, job.ID).Phase != "SUCCEEDED" {
		t.Fatalf("job=%+v", w.job(t, job.ID))
	}
}

// Authority changed under a running attempt, with its lease intact: the pinned
// generation refuses the result, the job ends, and the lease is free at once.
func TestCaptureStaleGenerationRefusesAResult(t *testing.T) {
	w := newCaptureWorld(t)
	connection, _ := w.ready(t)
	job := w.deployment(t, "stale", "abcdef1234567890")
	w.browser.during = func() {
		w.exec(t, `UPDATE platform_app_connection SET generation=generation+1 WHERE id=$1`, connection.ID)
	}
	if outcome := w.run(t, job.ID); !outcome.Done {
		t.Fatalf("outcome=%+v", outcome)
	}
	after := w.job(t, job.ID)
	row := w.db.Client.PlatformAppConnection.GetX(w.ctx, connection.ID)
	if after.Phase != "FAILED" || *after.FailureCode != "stale_authorization" || after.SurfaceCaptureID != nil || row.LeaseJobID != nil {
		t.Fatalf("after=%+v lease=%v", after, row.LeaseJobID)
	}
	if n := w.db.Client.SurfaceCapture.Query().Where(surfacecapture.SurfaceID(w.surface)).CountX(w.ctx); n != 0 {
		t.Fatal("a result committed under stale authorization")
	}
}

func TestCaptureCrashesReconcileToOneResult(t *testing.T) {
	t.Run("after upload, before commit", func(t *testing.T) {
		w := newCaptureWorld(t)
		w.ready(t)
		job := w.deployment(t, "crash-1", "abcdef1234567890")
		w.run(t, job.ID)
		done := w.job(t, job.ID)
		// Rewind to a worker that stored the image and died before committing.
		capture := *done.SurfaceCaptureID
		w.exec(t, `DELETE FROM surface_capture WHERE id=$1`, capture)
		w.exec(t, `UPDATE capture_job SET phase='RUNNING',status='RUNNING',"surfaceCaptureId"=NULL WHERE id=$1`, job.ID)
		w.exec(t, `UPDATE capture SET status='RUNNING',"completedAt"=NULL WHERE "captureJobId"=$1`, job.ID)
		runs := w.browser.runs.Load()
		if outcome := w.run(t, job.ID); !outcome.Done {
			t.Fatalf("outcome=%+v", outcome)
		}
		after := w.job(t, job.ID)
		if after.Phase != "SUCCEEDED" || *after.AssetID != *done.AssetID || w.browser.runs.Load() != runs {
			t.Fatalf("after=%+v runs=%d, want the stored image reused", after, w.browser.runs.Load())
		}
		if n := w.db.Client.SurfaceCapture.Query().Where(surfacecapture.SurfaceID(w.surface)).CountX(w.ctx); n != 1 {
			t.Fatalf("captures=%d", n)
		}
	})
	t.Run("after browser allocation", func(t *testing.T) {
		w := newCaptureWorld(t)
		w.ready(t)
		job := w.deployment(t, "crash-2", "abcdef1234567890")
		// A worker dies mid-run: the attempt names a browser nobody will close.
		leaked, err := w.browser.Allocate(w.ctx, []string{"app.example.com"}, time.Minute)
		if err != nil {
			t.Fatal(err)
		}
		w.exec(t, `INSERT INTO capture (id,"organizationId","captureJobId","recipeId","recipeVersion","sourceUrl",provider,status,"startedAt","attemptNumber","browserSessionId") VALUES ($1,$2,$3,$4,1,'https://app.example.com','browser','RUNNING',now()-interval '10 minutes',99,$5)`,
			"leak"+w.id, w.org, job.ID, job.RecipeID, leaked)
		if err := w.repo.ReclaimCaptureResources(w.ctx); err != nil {
			t.Fatal(err)
		}
		if w.browser.open() != 0 {
			t.Fatalf("the abandoned browser is open: %d", w.browser.open())
		}
		if row := w.db.Client.CaptureAttempt.GetX(w.ctx, "leak"+w.id); row.BrowserClosedAt == nil {
			t.Fatal("the reclaim was not recorded")
		}
	})
	t.Run("past its deadline", func(t *testing.T) {
		w := newCaptureWorld(t)
		w.ready(t)
		job := w.deployment(t, "crash-3", "abcdef1234567890")
		w.exec(t, `UPDATE capture_job SET "deadlineAt"=now()-interval '1 minute' WHERE id=$1`, job.ID)
		if err := w.repo.ReclaimCaptureResources(w.ctx); err != nil {
			t.Fatal(err)
		}
		if after := w.job(t, job.ID); after.Phase != "FAILED" || *after.FailureCode != "deadline_exceeded" {
			t.Fatalf("after=%+v", after)
		}
	})
}

func TestCaptureOutOfOrderDeploymentsKeepTheNewerImage(t *testing.T) {
	w := newCaptureWorld(t)
	w.ready(t)
	// The newer deployment lands while the older one's attempt is in the browser:
	// a running attempt is never superseded, and each keeps its own receipt.
	older := w.deployment(t, "order-1", "1111111111111111")
	var newer *CaptureJobRecord
	w.browser.during = func() {
		w.browser.during = nil
		newer = w.deployment(t, "order-2", "2222222222222222")
	}
	w.run(t, older.ID)
	w.run(t, newer.ID)
	first, second := w.job(t, older.ID), w.job(t, newer.ID)
	if first.AssetID == nil || second.AssetID == nil || *first.AssetID == *second.AssetID {
		t.Fatalf("older=%+v newer=%+v", first, second)
	}
	current := w.db.Client.SurfaceCapture.Query().Where(surfacecapture.SurfaceID(w.surface), surfacecapture.SupersededAtIsNil()).OnlyX(w.ctx)
	if current.ID != *second.SurfaceCaptureID {
		t.Fatalf("the older deployment kept the current image: %+v", current)
	}
	if row := w.db.Client.SurfaceCapture.GetX(w.ctx, *first.SurfaceCaptureID); row.SupersededAt == nil {
		t.Fatalf("older=%+v", row)
	}
	// A deployment the provider made before both, delivered last, is ordered by
	// the provider's time: its image is history, never the current one.
	sha := "0000000000000000"
	late, err := w.repo.IngestDeployment(w.ctx, Actor{OrganizationID: w.org, Kind: "webhook", Display: w.source.ID},
		IngestDeploymentInput{Environment: "production", EventID: "late", ExternalID: "order-0", SourceAppID: w.source.ID, SHA: &sha, DeployedAt: time.Now().Add(-time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	tx, err := w.db.Client.Tx(w.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	surface := tx.ProductSurface.GetX(w.ctx, w.surface)
	receipt, err := recordCapture(w.ctx, tx, Actor{OrganizationID: w.org, Kind: "service"}, surface, *first.AssetID, surfacecapture.SourceDeployment, &late.DeploymentID, &sha)
	if err != nil || receipt.SupersededAt == nil {
		t.Fatalf("a late older deployment became current: %+v %v", receipt, err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if now := w.db.Client.SurfaceCapture.Query().Where(surfacecapture.SurfaceID(w.surface), surfacecapture.SupersededAtIsNil()).OnlyX(w.ctx); now.ID != current.ID {
		t.Fatalf("current=%+v", now)
	}
}

func TestCaptureProtectsSharedCapacityAndRotatesState(t *testing.T) {
	w := newCaptureWorld(t)
	connection, recipe := w.ready(t)
	first, second := w.request(t, recipe.ID), w.request(t, recipe.ID)
	// One active capture per workspace: the second retries later and opens nothing.
	var waited *CaptureJobOutcome
	var waitErr error
	runs := w.browser.runs.Load()
	w.browser.during = func() {
		w.browser.during = nil
		waited, waitErr = w.repo.RunCaptureJob(w.ctx, w.org, second.ID)
	}
	if outcome := w.run(t, first.ID); !outcome.Done {
		t.Fatalf("first=%+v", outcome)
	}
	if waitErr != nil || waited == nil || waited.Done || waited.RetryAfterSeconds <= 0 || w.browser.runs.Load() != runs+1 {
		t.Fatalf("waited=%+v err=%v runs=%d", waited, waitErr, w.browser.runs.Load())
	}
	// The app rotated its token: the next run receives the new state, sealed.
	rotated := &browser.State{Cookies: []*proto.NetworkCookieParam{{Name: "session", Value: "rotated-secret", Domain: "app.example.com"}}}
	normal := w.browser.run
	w.browser.run = func(input browser.RunInput) (*browser.RunResult, error) {
		result, err := normal(input)
		result.State = rotated
		return result, err
	}
	revision := w.db.Client.PlatformAppConnection.GetX(w.ctx, connection.ID).StateRevision
	if outcome := w.run(t, second.ID); !outcome.Done {
		t.Fatalf("second=%+v", outcome)
	}
	row := w.db.Client.PlatformAppConnection.GetX(w.ctx, connection.ID)
	if row.StateRevision != revision+1 || strings.Contains(*row.StateCiphertext, "rotated-secret") {
		t.Fatalf("row revision=%d", row.StateRevision)
	}
	w.browser.run = normal
	third := w.deployment(t, "cap-3", "3333333333333333")
	w.run(t, third.ID)
	last := w.browser.seenState[len(w.browser.seenState)-1]
	if last.Cookies[0].Value != "rotated-secret" {
		t.Fatalf("restored=%v", last.Cookies[0].Value)
	}
	// A key rotation re-encrypts on validated use, so the old key can be retired.
	newest, _ := sessionstate.NewKeys(bytes.Repeat([]byte{8}, 32), bytes.Repeat([]byte{7}, 32))
	w.repo.WithAuthenticatedCapture(w.browser, newest)
	fourth := w.deployment(t, "cap-4", "4444444444444444")
	w.run(t, fourth.ID)
	row = w.db.Client.PlatformAppConnection.GetX(w.ctx, connection.ID)
	onlyNew, _ := sessionstate.NewKeys(bytes.Repeat([]byte{8}, 32))
	if _, stale, err := onlyNew.Open(*row.StateCiphertext, sessionstate.Binding{Organization: w.org, Connection: connection.ID, Environment: "production", Generation: row.Generation}); err != nil || stale {
		t.Fatalf("not re-encrypted: stale=%v err=%v", stale, err)
	}
	// Unreadable state never falls back to anything: a person signs in again.
	w.repo.WithAuthenticatedCapture(w.browser, w.keys)
	w.exec(t, `UPDATE platform_app_connection SET "stateCiphertext"='{"cookies":[]}' WHERE id=$1`, connection.ID)
	plain := w.deployment(t, "cap-5", "5555555555555555")
	runs = w.browser.runs.Load()
	w.run(t, plain.ID)
	if w.job(t, plain.ID).Phase != "NEEDS_AUTH" || w.browser.runs.Load() != runs {
		t.Fatalf("plaintext state ran: %+v", w.job(t, plain.ID))
	}
}

func TestCaptureSafeFailuresAndTestsNeverClaimASuccess(t *testing.T) {
	for _, code := range []browser.Code{browser.MarkerMissing, browser.WrongAccount, browser.MaskMissing, browser.OriginRefused, browser.ForbiddenView} {
		t.Run(string(code), func(t *testing.T) {
			w := newCaptureWorld(t)
			w.ready(t)
			job := w.deployment(t, "fail", "abcdef1234567890")
			w.browser.run = func(browser.RunInput) (*browser.RunResult, error) { return nil, &browser.Failure{Code: code} }
			if outcome := w.run(t, job.ID); !outcome.Done {
				t.Fatalf("outcome=%+v", outcome)
			}
			after := w.job(t, job.ID)
			if after.Phase != "FAILED" || *after.FailureCode != string(code) || after.SurfaceCaptureID != nil {
				t.Fatalf("after=%+v", after)
			}
			surface := w.db.Client.ProductSurface.GetX(w.ctx, w.surface)
			if surface.LastCaptureFailureCode == nil || *surface.LastCaptureFailureCode != string(code) {
				t.Fatalf("surface=%+v", surface)
			}
		})
	}
	t.Run("a test proves the recipe and leaves the current image alone", func(t *testing.T) {
		w := newCaptureWorld(t)
		connection := w.connection(t)
		w.signIn(t, connection.ID)
		recipe := w.recipe(t, connection.ID)
		if _, err := w.repo.ActivateCaptureRecipe(w.ctx, w.owner, recipe.ID); err == nil {
			t.Fatal("an untested recipe was activated")
		}
		if _, err := w.repo.RequestCaptureJob(w.ctx, w.owner, recipe.ID, CaptureJobRequest{}); !errors.Is(err, publishing.ErrInvalidState) {
			t.Fatalf("a draft ran as a real capture: %v", err)
		}
		job, err := w.repo.RequestCaptureJob(w.ctx, w.owner, recipe.ID, CaptureJobRequest{Test: true})
		if err != nil {
			t.Fatal(err)
		}
		w.run(t, job.ID)
		if after := w.job(t, job.ID); after.Phase != "SUCCEEDED" || after.AssetID == nil || after.SurfaceCaptureID != nil {
			t.Fatalf("after=%+v", after)
		}
		if n := w.db.Client.SurfaceCapture.Query().Where(surfacecapture.SurfaceID(w.surface)).CountX(w.ctx); n != 0 {
			t.Fatal("a test replaced the current image")
		}
		active, err := w.repo.ActivateCaptureRecipe(w.ctx, w.owner, recipe.ID)
		if err != nil || active.Status != "ACTIVE" {
			t.Fatalf("activate: %+v %v", active, err)
		}
		// A new version needs its own test, and activating it replaces the old one.
		next := w.recipe(t, connection.ID, func(r *browser.Recipe) { r.Masks = []string{".email"} })
		if next.Version != 2 || next.Status != "DRAFT" || next.TestedAt != nil {
			t.Fatalf("next=%+v", next)
		}
	})
}

func TestCaptureWorkflowActionWaitsForItsExactResult(t *testing.T) {
	w := newCaptureWorld(t)
	_, recipe := w.ready(t)
	renderer := &recordingRenderer{}
	w.repo.WithAutomationRenderer(renderer)
	if err := w.repo.AdvertiseReleaseAutomationExecutor(w.ctx, "browser-worker"+w.id, w.repo.AutomationCapabilities()...); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(w.repo.AutomationCapabilities(), automation.CapabilityBrowser) {
		t.Fatal("this worker can run recipes")
	}
	w.graph.SchemaVersion, w.graph.Family = 3, automation.Deployed
	w.graph.Qualification = automation.Condition{Field: "deployment.environment", Operator: "eq", Values: []string{"production"}}
	w.graph.Nodes[1].Condition = &automation.Condition{Field: "deployment.state", Operator: "eq", Values: []string{"success"}}
	action := automation.Action{Type: "capture_product", Input: &automation.Reference{NodeID: "campaign", Output: "campaignId"}, RecipeID: recipe.ID}
	w.graph.Nodes = append(w.graph.Nodes, automation.Node{ID: "capture", Type: "action", Action: &action},
		automation.Node{ID: "art", Type: "action", Action: &automation.Action{Type: "render_creatives", Input: &automation.Reference{NodeID: "capture", Output: "campaignId"}, TemplateIDs: []string{"layout-browser-launch"}}})
	w.graph.Nodes[4].Action.Input.NodeID = "art"
	w.graph.Edges[4].To = "capture"
	w.graph.Edges = append(w.graph.Edges, automation.Edge{From: "capture", To: "art", Branch: "next"}, automation.Edge{From: "art", To: "review", Branch: "next"})
	active := w.activate(t)
	sha := "abcdef1234567890abcdef1234567890abcdef12"
	body := fmt.Sprintf(`{"installation":{"id":%d},"repository":{"id":1001,"full_name":"acme/app"},"deployment":{"id":801,"sha":%q,"environment":"production"},"deployment_status":{"id":1801,"state":"success","created_at":%q}}`, w.installation, sha, time.Now().Format(time.RFC3339Nano))
	if _, err := w.repo.AcceptGitHubEvent(w.ctx, AcceptGitHubEventInput{DeliveryID: "capture-run", EventName: "deployment_status", Body: []byte(body)}); err != nil {
		t.Fatal(err)
	}
	history, err := w.repo.ListAutomationHistory(w.ctx, w.owner, AutomationHistoryFilter{})
	if err != nil || len(history) == 0 {
		t.Fatalf("history=%d err=%v", len(history), err)
	}
	runID := history[0].Run.ID
	if _, err := w.repo.LoadReleaseAutomation(w.ctx, w.org, runID, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := w.repo.CollectAutomationChange(w.ctx, w.org, runID, 0); err != nil {
		t.Fatal(err)
	}
	if err := w.repo.SelectReleaseAutomation(w.ctx, w.org, runID, *active.ActiveVersionID, 0); err != nil {
		t.Fatal(err)
	}
	for _, node := range []string{"release", "campaign"} {
		if _, err := w.repo.AutomationNode(w.ctx, w.org, runID, node, nil, 0); err != nil {
			t.Fatalf("%s: %v", node, err)
		}
	}
	// The job does not exist or has not finished: the node waits, and the render
	// cannot start from any other image.
	if _, err := w.repo.AutomationNode(w.ctx, w.org, runID, "capture", nil, 0); !errors.Is(err, ErrCapturePending) || PermanentAutomationError(err) {
		t.Fatalf("pending: %v", err)
	}
	job := w.db.Client.CaptureJob.Query().Where(capturejob.OrganizationID(w.org), capturejob.KindEQ(capturejob.KindDeployment)).OnlyX(w.ctx)
	if job.ExpectedRevision == nil || *job.ExpectedRevision != sha {
		t.Fatalf("job=%+v", job)
	}
	// The legacy trigger for the same deployment finds the same job.
	deployment := w.db.Client.DeploymentEvent.Query().Where(deploymentevent.OrganizationID(w.org)).OnlyX(w.ctx)
	if _, err := w.repo.HandleOutboxEvent(w.ctx, "unused", w.org, EventDeploymentSucceeded, deployment.ID); err != nil {
		t.Fatal(err)
	}
	if n := w.db.Client.CaptureJob.Query().Where(capturejob.OrganizationID(w.org), capturejob.KindEQ(capturejob.KindDeployment)).CountX(w.ctx); n != 1 {
		t.Fatalf("two jobs for one deployment: %d", n)
	}
	if outcome := w.run(t, job.ID); !outcome.Done {
		t.Fatalf("outcome=%+v", outcome)
	}
	outputs, err := w.repo.AutomationNode(w.ctx, w.org, runID, "capture", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	finished := w.db.Client.CaptureJob.GetX(w.ctx, job.ID)
	if outputs.CaptureProof != automation.CaptureProofVersion || outputs.CaptureID != *finished.SurfaceCaptureID || outputs.CaptureAssetID != *finished.AssetID {
		t.Fatalf("outputs=%+v job=%+v", outputs, finished)
	}
	if _, err := w.repo.AutomationNode(w.ctx, w.org, runID, "art", nil, 0); err != nil {
		t.Fatal(err)
	}
	if len(renderer.requests) != 1 || renderer.requests[0].CaptureAssetID != *finished.AssetID {
		t.Fatalf("render=%+v", renderer.requests)
	}
	// A successful capture does not approve anything: review still gates it.
	if posts := outputs.PostIDs; len(posts) == 0 {
		t.Fatal("no draft posts")
	}
}

// A published release can arrive before its code is live: the run waits for a
// deployment of the tag's commit, and only then captures.
func TestCaptureReleaseWaitsForItsTagsDeployment(t *testing.T) {
	w := newCaptureWorld(t)
	_, recipe := w.ready(t)
	sha := "abcdef1234567890abcdef1234567890abcdef12"
	reader := w.repo.github.(fakeReader)
	reader.commits = map[string]string{"v7": sha}
	w.repo.WithGitHubApp(reader)
	if err := w.repo.AdvertiseReleaseAutomationExecutor(w.ctx, "browser-worker"+w.id, w.repo.AutomationCapabilities()...); err != nil {
		t.Fatal(err)
	}
	w.graph.SchemaVersion = 3
	action := automation.Action{Type: "capture_product", Input: &automation.Reference{NodeID: "campaign", Output: "campaignId"}, RecipeID: recipe.ID}
	w.graph.Nodes = append(w.graph.Nodes, automation.Node{ID: "capture", Type: "action", Action: &action})
	w.graph.Nodes[4].Action.Input.NodeID = "capture"
	w.graph.Edges[4].To = "capture"
	w.graph.Edges = append(w.graph.Edges, automation.Edge{From: "capture", To: "review", Branch: "next"})
	runID, err := w.runUntil(t, w.activate(t), "release-first", 7, "release", "campaign")
	if err != nil {
		t.Fatal(err)
	}
	// No deployment of this commit yet: wait, and capture nothing.
	if _, err := w.repo.AutomationNode(w.ctx, w.org, runID, "capture", nil, 0); !errors.Is(err, ErrDeploymentNotLive) || PermanentAutomationError(err) {
		t.Fatalf("before deployment: %v", err)
	}
	if n := w.db.Client.CaptureJob.Query().Where(capturejob.OrganizationID(w.org), capturejob.KindEQ(capturejob.KindDeployment)).CountX(w.ctx); n != 0 {
		t.Fatalf("jobs before deployment=%d", n)
	}
	// A deployment of another commit changes nothing.
	w.deployment(t, "other", "1111111111111111")
	if _, err := w.repo.AutomationNode(w.ctx, w.org, runID, "capture", nil, 0); !errors.Is(err, ErrDeploymentNotLive) {
		t.Fatalf("another commit: %v", err)
	}
	// The matching deployment's own job is the one the release uses.
	job := w.deployment(t, "matching", sha)
	if _, err := w.repo.AutomationNode(w.ctx, w.org, runID, "capture", nil, 0); !errors.Is(err, ErrCapturePending) {
		t.Fatalf("pending: %v", err)
	}
	if n := w.db.Client.CaptureJob.Query().Where(capturejob.OrganizationID(w.org), capturejob.DeploymentEventID(*job.DeploymentEventID)).CountX(w.ctx); n != 1 {
		t.Fatalf("jobs for the deployment=%d", n)
	}
	w.run(t, job.ID)
	outputs, err := w.repo.AutomationNode(w.ctx, w.org, runID, "capture", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	if outputs.CaptureProof != automation.CaptureProofVersion || outputs.CaptureAssetID != *w.job(t, job.ID).AssetID {
		t.Fatalf("outputs=%+v", outputs)
	}
	if row := w.db.Client.SurfaceCapture.GetX(w.ctx, outputs.CaptureID); *row.ObservedRevision != sha {
		t.Fatalf("receipt=%+v", row)
	}
}

// One active capture per workspace holds across connections, where no shared
// lease would stop the second job.
func TestCaptureLimitsAWorkspaceAcrossConnections(t *testing.T) {
	w := newCaptureWorld(t)
	first, recipe := w.ready(t)
	source := w.source.ID
	second, err := w.repo.CreateCaptureConnection(w.ctx, w.owner, CreateCaptureConnectionInput{Name: "Other app", SourceAppID: &source, Environment: "staging", Origin: "https://other.example.com",
		Hosts: []string{"other.example.com"}, ProtectedPath: "/dashboard", IdentitySelector: "#me", ExpectedAccount: "demo"})
	if err != nil {
		t.Fatal(err)
	}
	w.signIn(t, second.ID)
	surface := "othersurface" + w.id
	w.exec(t, `INSERT INTO product_surface (id,"organizationId",name,slug,url,"featureTags","screenshotAssetIds","createdAt","updatedAt") VALUES ($1,$2,'Other','other','https://other.example.com/dashboard','[]','[]',now(),now())`, surface, w.org)
	definition := browser.Recipe{SchemaVersion: 1, Viewport: browser.Viewport{Width: 800, Height: 600}, Steps: []browser.Step{{Kind: browser.StepNavigate, Path: "/dashboard"}}, Markers: []string{"#ready"}}
	otherRecipe, err := w.repo.CreateCaptureRecipe(w.ctx, w.owner, CreateCaptureRecipeInput{Name: "Other", SurfaceID: surface, ConnectionID: second.ID, Definition: definition})
	if err != nil {
		t.Fatal(err)
	}
	blocked, err := w.repo.RequestCaptureJob(w.ctx, w.owner, otherRecipe.ID, CaptureJobRequest{Test: true})
	if err != nil {
		t.Fatal(err)
	}
	running, err := w.repo.RequestCaptureJob(w.ctx, w.owner, recipe.ID, CaptureJobRequest{})
	if err != nil {
		t.Fatal(err)
	}
	var waited *CaptureJobOutcome
	runs := w.browser.runs.Load()
	w.browser.during = func() {
		w.browser.during = nil
		var err error
		if waited, err = w.repo.RunCaptureJob(w.ctx, w.org, blocked.ID); err != nil {
			t.Error(err)
		}
	}
	if outcome := w.run(t, running.ID); !outcome.Done {
		t.Fatalf("outcome=%+v", outcome)
	}
	if waited == nil || waited.Done || waited.RetryAfterSeconds <= 0 || w.browser.runs.Load() != runs+1 {
		t.Fatalf("waited=%+v runs=%d, connections=%s", waited, w.browser.runs.Load(), first.ID)
	}
	if outcome := w.run(t, blocked.ID); !outcome.Done || w.job(t, blocked.ID).Phase != "SUCCEEDED" {
		t.Fatalf("after the first finished: %+v", outcome)
	}
}

func TestCaptureActionRefusesWhatItCannotProve(t *testing.T) {
	w := newCaptureWorld(t)
	connection, recipe := w.ready(t)
	job := w.deployment(t, "action", "abcdef1234567890")
	event := &ent.ReleaseSourceEvent{SourceAppID: w.source.ID, Snapshot: automation.Event{Family: automation.Deployed, ObjectID: "action"}}
	input := automation.Outputs{CampaignID: "campaign"}
	attempt := func(action automation.Action) (automation.Outputs, error) {
		return w.repo.automationAuthenticatedCapture(w.ctx, w.org, event, input, &action)
	}
	if _, err := attempt(automation.Action{RecipeID: recipe.ID}); !errors.Is(err, ErrCapturePending) {
		t.Fatalf("pending: %v", err)
	}
	// Another source's real deployment cannot use this connection's account.
	other := w.db.Client.SourceApp.Create().SetID("othersource" + w.id).SetOrganizationID(w.org).SetName("other/app").SetProvider("generic").SetAllowedHosts([]string{}).SetStatus("ACTIVE").SaveX(w.ctx)
	sha := "abcdef1234567890"
	if _, err := w.repo.IngestDeployment(w.ctx, Actor{OrganizationID: w.org, Kind: "webhook", Display: other.ID}, IngestDeploymentInput{Environment: "production", EventID: "o", ExternalID: "foreign", SourceAppID: other.ID, SHA: &sha}); err != nil {
		t.Fatal(err)
	}
	foreign := &ent.ReleaseSourceEvent{SourceAppID: other.ID, Snapshot: automation.Event{Family: automation.Deployed, ObjectID: "foreign"}}
	if _, err := w.repo.automationAuthenticatedCapture(w.ctx, w.org, foreign, input, &automation.Action{RecipeID: recipe.ID}); !errors.Is(err, ErrCaptureRefused) {
		t.Fatalf("foreign source: %v", err)
	}
	if n := w.db.Client.CaptureJob.Query().Where(capturejob.OrganizationID(w.org), capturejob.KindEQ(capturejob.KindDeployment)).CountX(w.ctx); n != 1 {
		t.Fatalf("a foreign deployment admitted a job: %d", n)
	}
	// A deployment that was never recorded has nothing to bind to.
	missing := &ent.ReleaseSourceEvent{SourceAppID: w.source.ID, Snapshot: automation.Event{Family: automation.Deployed, ObjectID: "never"}}
	if _, err := w.repo.automationAuthenticatedCapture(w.ctx, w.org, missing, input, &automation.Action{RecipeID: recipe.ID}); !errors.Is(err, ErrCaptureRefused) {
		t.Fatalf("no deployment: %v", err)
	}
	// An owner activating a newer tested version moves the workflow onto it, while
	// the job already admitted keeps the version it pinned.
	next := w.recipe(t, connection.ID, func(r *browser.Recipe) { r.Masks = []string{".email"} })
	test, err := w.repo.RequestCaptureJob(w.ctx, w.owner, next.ID, CaptureJobRequest{Test: true})
	if err != nil {
		t.Fatal(err)
	}
	w.run(t, job.ID)
	w.run(t, test.ID)
	if _, err := w.repo.ActivateCaptureRecipe(w.ctx, w.owner, next.ID); err != nil {
		t.Fatal(err)
	}
	if err := w.repo.automationResources(w.ctx, w.org, automation.Graph{Nodes: []automation.Node{{Action: &automation.Action{Type: "capture_product", RecipeID: recipe.ID}}}}); err != nil {
		t.Fatalf("a workflow naming the replaced version stopped: %v", err)
	}
	if _, err := attempt(automation.Action{RecipeID: recipe.ID}); !errors.Is(err, ErrCapturePending) {
		t.Fatalf("after a newer version: %v", err)
	}
	moved := w.db.Client.CaptureJob.Query().Where(capturejob.OrganizationID(w.org), capturejob.DeploymentEventID(*job.DeploymentEventID), capturejob.RecipeID(next.ID)).OnlyX(w.ctx)
	if moved.RecipeVersion != next.Version {
		t.Fatalf("moved=%+v", moved)
	}
	// Archiving leaves no active version, so the workflow stops.
	if err := w.repo.ArchiveCaptureRecipe(w.ctx, w.owner, next.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := attempt(automation.Action{RecipeID: recipe.ID}); !errors.Is(err, ErrCaptureRefused) {
		t.Fatalf("archived: %v", err)
	}
	if err := w.repo.automationResources(w.ctx, w.org, automation.Graph{Nodes: []automation.Node{{Action: &automation.Action{Type: "capture_product", RecipeID: recipe.ID}}}}); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("archived resources: %v", err)
	}
	// A recipe without version proof runs only with the explicit current-state choice.
	unproven, err := w.repo.CreateCaptureRecipe(w.ctx, w.owner, CreateCaptureRecipeInput{Name: "No proof", SurfaceID: w.surface, ConnectionID: connection.ID, Definition: browser.Recipe{SchemaVersion: 1, Viewport: browser.Viewport{Width: 800, Height: 600}, Steps: []browser.Step{{Kind: browser.StepNavigate, Path: "/dashboard"}}, Markers: []string{"#ready"}}})
	if err != nil {
		t.Fatal(err)
	}
	test, err = w.repo.RequestCaptureJob(w.ctx, w.owner, unproven.ID, CaptureJobRequest{Test: true})
	if err != nil {
		t.Fatal(err)
	}
	w.run(t, test.ID)
	if _, err := w.repo.ActivateCaptureRecipe(w.ctx, w.owner, unproven.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := attempt(automation.Action{RecipeID: unproven.ID}); !errors.Is(err, ErrCaptureRefused) {
		t.Fatalf("no proof, no choice: %v", err)
	}
	if _, err := attempt(automation.Action{RecipeID: unproven.ID, CurrentState: true}); !errors.Is(err, ErrCapturePending) {
		t.Fatalf("explicit current state: %v", err)
	}
	labeled := w.db.Client.CaptureJob.Query().Where(capturejob.DeploymentEventID(*job.DeploymentEventID), capturejob.RecipeID(unproven.ID)).OnlyX(w.ctx)
	w.run(t, labeled.ID)
	outputs, err := attempt(automation.Action{RecipeID: unproven.ID, CurrentState: true})
	if err != nil || outputs.CaptureProof != automation.CaptureProofCurrentState {
		t.Fatalf("outputs=%+v err=%v", outputs, err)
	}
}

// An agent's capture keeps its attribution through the durable job.
func TestCaptureJobRecordsWhoAskedForIt(t *testing.T) {
	w := newCaptureWorld(t)
	_, recipe := w.ready(t)
	run := "agent-run-1"
	job, err := w.repo.RequestCaptureJob(w.ctx, w.owner, recipe.ID, CaptureJobRequest{Source: "agent", SourceID: &run})
	if err != nil {
		t.Fatal(err)
	}
	w.run(t, job.ID)
	done := w.job(t, job.ID)
	receipt := w.db.Client.SurfaceCapture.GetX(w.ctx, *done.SurfaceCaptureID)
	if done.Kind != "agent" || receipt.Source != surfacecapture.SourceAgent || receipt.SourceID == nil || *receipt.SourceID != run {
		t.Fatalf("done=%+v receipt=%+v", done, receipt)
	}
	for _, bad := range []CaptureJobRequest{{Source: "deployment"}, {Source: "agent", SourceID: new(string)}} {
		if _, err := w.repo.RequestCaptureJob(w.ctx, w.owner, recipe.ID, bad); !errors.Is(err, ErrInvalidInput) {
			t.Errorf("request %+v: %v", bad, err)
		}
	}
}

func TestCaptureSecretsStayOutOfEverythingVisible(t *testing.T) {
	w := newCaptureWorld(t)
	connection, recipe := w.ready(t)
	start, err := w.repo.StartCaptureConnect(w.ctx, w.owner, connection.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(start.LiveViewURL, "dummy-live-view") {
		t.Fatalf("link=%s", start.LiveViewURL)
	}
	if err := w.repo.FinishCaptureConnect(w.ctx, w.owner, connection.ID, start.IntentID); err != nil {
		t.Fatal(err)
	}
	if err := w.repo.CompleteCaptureConnection(w.ctx, w.org, connection.ID); err != nil {
		t.Fatal(err)
	}
	job := w.deployment(t, "secret", "abcdef1234567890")
	w.run(t, job.ID)
	forbidden := []string{captureSecret, "dummy-live-view", start.IntentID, base64.StdEncoding.EncodeToString([]byte(captureSecret))}
	row := w.db.Client.PlatformAppConnection.GetX(w.ctx, connection.ID)
	if row.StateCiphertext != nil {
		forbidden = append(forbidden, *row.StateCiphertext)
	}
	check := func(place, text string) {
		t.Helper()
		for _, secret := range forbidden {
			if strings.Contains(text, secret) {
				t.Errorf("%s leaks %.20s", place, secret)
			}
		}
	}
	// Tables everyone reads: audit, outbox, jobs, attempts, recipes, API records.
	for _, query := range []string{
		`SELECT coalesce(string_agg(payload::text, ' '), '') FROM outbox_event WHERE "organizationId"=$1`,
		`SELECT coalesce(string_agg(metadata::text, ' '), '') FROM audit_log WHERE "organizationId"=$1`,
		`SELECT coalesce(string_agg(row_to_json(capture)::text, ' '), '') FROM capture WHERE "organizationId"=$1`,
		`SELECT coalesce(string_agg(row_to_json(capture_job)::text, ' '), '') FROM capture_job WHERE "organizationId"=$1`,
		`SELECT coalesce(string_agg(row_to_json(capture_recipe)::text, ' '), '') FROM capture_recipe WHERE "organizationId"=$1`,
	} {
		var text string
		if err := w.db.SQL.QueryRowContext(w.ctx, query, w.org).Scan(&text); err != nil {
			t.Fatal(err)
		}
		check(query, text)
	}
	records, err := w.repo.ListCaptureConnections(w.ctx, w.owner)
	if err != nil {
		t.Fatal(err)
	}
	recipes, _ := w.repo.ListCaptureRecipes(w.ctx, w.owner)
	jobs, _ := w.repo.ListCaptureJobs(w.ctx, w.owner)
	check("API", fmt.Sprintf("%+v %+v %+v %+v", records, recipes, jobs, recipe))
	// Ent's own printing hides the state and the intent.
	check("ent", fmt.Sprintf("%v", row))
	// Failure codes are fixed strings: nothing from a page or a provider.
	w.browser.run = func(browser.RunInput) (*browser.RunResult, error) {
		return nil, errors.New("https://user:" + captureSecret + "@provider/session")
	}
	failed := w.deployment(t, "secret-2", "fedcba0987654321")
	w.run(t, failed.ID)
	after := w.job(t, failed.ID)
	if after.FailureCode == nil {
		t.Fatalf("after=%+v", after)
	}
	check("failure code", *after.FailureCode)
}

// F3: deploy A, deploy B, deploy A again. The third is a rollback: its run
// starts no workflow (TestInterpreterRedeploysAndRollbacksStartNoWorkflow reads
// the kind collected here), and its capture is recorded against the rollback as
// the current image. The live commit deployed again opens no browser once it is
// captured. Each environment keeps its own history.
func TestCaptureRedeploysAndRollbacksAreNotReleases(t *testing.T) {
	w := newCaptureWorld(t)
	w.ready(t)
	w.graph.SchemaVersion, w.graph.Family = 3, automation.Deployed
	w.graph.Qualification = automation.Condition{Field: "deployment.environment", Operator: "eq", Values: []string{"production"}}
	w.graph.Nodes[1].Condition = &automation.Condition{Field: "deployment.state", Operator: "eq", Values: []string{"success"}}
	w.activate(t)
	start := time.Now().Add(-time.Hour)
	deploy := func(id int, sha string) (string, *ent.DeploymentEvent) {
		t.Helper()
		delivery := fmt.Sprintf("kind-%d", id)
		body := fmt.Sprintf(`{"installation":{"id":%d},"repository":{"id":1001,"full_name":"acme/app"},"deployment":{"id":%d,"sha":%q,"environment":"production"},"deployment_status":{"id":%d,"state":"success","created_at":%q}}`,
			w.installation, id, sha, id+1000, start.Add(time.Duration(id)*time.Minute).Format(time.RFC3339Nano))
		if _, err := w.repo.AcceptGitHubEvent(w.ctx, AcceptGitHubEventInput{DeliveryID: delivery, EventName: "deployment_status", Body: []byte(body)}); err != nil {
			t.Fatal(err)
		}
		event := w.db.Client.ReleaseSourceEvent.Query().Where(releasesourceevent.OrganizationID(w.org), releasesourceevent.DeliveryID(delivery)).OnlyX(w.ctx)
		run := w.db.Client.ReleaseAutomationRun.Query().Where(releaseautomationrun.OrganizationID(w.org), releaseautomationrun.EventID(event.ID)).OnlyX(w.ctx)
		if _, err := w.repo.LoadReleaseAutomation(w.ctx, w.org, run.ID, 0); err != nil {
			t.Fatal(err)
		}
		kind, err := w.repo.CollectAutomationChange(w.ctx, w.org, run.ID, 0)
		if err != nil {
			t.Fatal(err)
		}
		row := w.db.Client.DeploymentEvent.Query().Where(deploymentevent.OrganizationID(w.org), deploymentevent.ExternalID(strconv.Itoa(id))).OnlyX(w.ctx)
		if string(row.Kind) != kind {
			t.Fatalf("collected %s, stored %+v", kind, row)
		}
		if _, err := w.repo.HandleOutboxEvent(w.ctx, "unused", w.org, EventDeploymentSucceeded, row.ID); err != nil {
			t.Fatal(err)
		}
		return kind, row
	}
	capture := func(row *ent.DeploymentEvent) *ent.CaptureJob {
		t.Helper()
		job := w.db.Client.CaptureJob.Query().Where(capturejob.DeploymentEventID(row.ID)).OnlyX(w.ctx)
		if outcome := w.run(t, job.ID); !outcome.Done {
			t.Fatalf("outcome=%+v", outcome)
		}
		return w.db.Client.CaptureJob.GetX(w.ctx, job.ID)
	}
	shaA, shaB := "aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"
	for i, sha := range []string{shaA, shaB} {
		kind, row := deploy(i+1, sha)
		if kind != "new" {
			t.Fatalf("deployment %d=%s", i+1, kind)
		}
		capture(row)
	}
	kind, back := deploy(3, shaA)
	if kind != "rollback" {
		t.Fatalf("third=%s", kind)
	}
	rolledBack := capture(back)
	current := w.db.Client.SurfaceCapture.Query().Where(surfacecapture.SurfaceID(w.surface), surfacecapture.SupersededAtIsNil()).OnlyX(w.ctx)
	if rolledBack.Phase != capturejob.PhaseSUCCEEDED || current.ID != *rolledBack.SurfaceCaptureID || *current.SourceID != back.ID || *current.ObservedRevision != shaA {
		t.Fatalf("rollback capture=%+v current=%+v", rolledBack, current)
	}
	// The live commit again: every page has its capture, so nothing runs.
	runs, allocated := w.browser.runs.Load(), len(w.browser.allocated)
	kind, again := deploy(4, shaA)
	if kind != "redeploy" {
		t.Fatalf("fourth=%s", kind)
	}
	if n := w.db.Client.CaptureJob.Query().Where(capturejob.DeploymentEventID(again.ID)).CountX(w.ctx); n != 0 || w.browser.runs.Load() != runs || len(w.browser.allocated) != allocated {
		t.Fatalf("a captured redeploy admitted %d jobs, runs=%d", n, w.browser.runs.Load())
	}
	// Another environment of the repository compares only with its own deployments.
	staging, err := w.repo.IngestDeployment(w.ctx, Actor{OrganizationID: w.org, Kind: "webhook", Display: w.source.ID},
		IngestDeploymentInput{Environment: "staging", EventID: "staging", ExternalID: "staging-1", SourceAppID: w.source.ID, SHA: &shaA})
	if err != nil || staging.Kind != "new" {
		t.Fatalf("staging=%+v err=%v", staging, err)
	}
}

// F3 on Vercel, Netlify and Pages: a rollback activates a deployment the
// provider reported before. Ordered by the provider's time, that activation is a
// deployment of its own, compared with what was live; a redelivery is not.
func TestCaptureDeploymentReactivationIsItsOwnDeployment(t *testing.T) {
	f := newAutomationFixture(t)
	start := time.Now().Add(-time.Hour)
	ingest := func(external string, sha *string, minute int) *DeploymentIngest {
		t.Helper()
		result, err := f.repo.IngestDeployment(f.ctx, Actor{OrganizationID: f.org, Kind: "webhook", Display: f.source.ID}, IngestDeploymentInput{Environment: "production",
			EventID: external, ExternalID: external, SourceAppID: f.source.ID, SHA: sha, DeployedAt: start.Add(time.Duration(minute) * time.Minute)})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	x, y := "xxxxxxxxxxxxxxxx", "yyyyyyyyyyyyyyyy"
	first, second, restored := ingest("dpl_1", &x, 1), ingest("dpl_2", &y, 2), ingest("dpl_1", &x, 3)
	if first.Kind != "new" || second.Kind != "new" || !restored.Created || restored.Kind != "rollback" || restored.DeploymentID == first.DeploymentID {
		t.Fatalf("first=%+v second=%+v restored=%+v", first, second, restored)
	}
	// Redeliveries find their own rows.
	if again := ingest("dpl_1", &x, 3); again.Created || again.DeploymentID != restored.DeploymentID {
		t.Fatalf("again=%+v", again)
	}
	if original := ingest("dpl_1", &x, 1); original.Created || original.DeploymentID != first.DeploymentID || original.Kind != "new" {
		t.Fatalf("original=%+v", original)
	}
	// Activating the live deployment again is a redeploy.
	if repeat := ingest("dpl_1", &x, 4); !repeat.Created || repeat.Kind != "redeploy" {
		t.Fatalf("repeat=%+v", repeat)
	}
	// Without commits, the provider's deployment is the version.
	ingest("dpl_3", nil, 5)
	ingest("dpl_4", nil, 6)
	if back := ingest("dpl_3", nil, 7); back.Kind != "rollback" {
		t.Fatalf("back=%+v", back)
	}
	// A provider clock a day ahead is capped at arrival: the deployment after it
	// is not superseded, and a redelivery finds its row.
	ahead := ingest("dpl_ahead", nil, 25*60)
	if row := f.db.Client.DeploymentEvent.GetX(f.ctx, ahead.DeploymentID); !ahead.Created || row.DeployedAt.After(time.Now()) {
		t.Fatalf("ahead=%+v deployedAt=%s", ahead, row.DeployedAt)
	}
	next, err := f.repo.IngestDeployment(f.ctx, Actor{OrganizationID: f.org, Kind: "webhook", Display: f.source.ID}, IngestDeploymentInput{Environment: "production",
		EventID: "dpl_next", ExternalID: "dpl_next", SourceAppID: f.source.ID})
	if err != nil {
		t.Fatal(err)
	}
	if superseded, err := deploymentSuperseded(f.ctx, f.db.Client, f.db.Client.DeploymentEvent.GetX(f.ctx, next.DeploymentID)); err != nil || superseded {
		t.Fatalf("a future deployment time superseded the next deployment: %v %v", superseded, err)
	}
	if again := ingest("dpl_ahead", nil, 25*60); again.Created || again.DeploymentID != ahead.DeploymentID {
		t.Fatalf("redelivered ahead=%+v", again)
	}
}

// F4: a newer deployment cancels the jobs still waiting for an older one, so a
// burst of deployments leaves one waiting job and opens no browser for the
// rest. A person's request is never superseded.
func TestCaptureSupersededDeploymentJobsAreCancelled(t *testing.T) {
	w := newCaptureWorld(t)
	_, recipe := w.ready(t)
	manual := w.request(t, recipe.ID)
	a := w.deployment(t, "sup-a", "aaaaaaaaaaaaaaaa")
	b := w.deployment(t, "sup-b", "bbbbbbbbbbbbbbbb")
	if job := w.job(t, a.ID); job.Phase != "CANCELLED" || *job.FailureCode != "superseded" {
		t.Fatalf("older=%+v", job)
	}
	runs := w.browser.runs.Load()
	if outcome := w.run(t, a.ID); !outcome.Done || w.browser.runs.Load() != runs || w.job(t, a.ID).Attempts != 0 {
		t.Fatalf("a superseded job ran: %+v", outcome)
	}
	// An attempt that finds a newer deployment's commit live ends at once.
	w.browser.run = func(browser.RunInput) (*browser.RunResult, error) {
		return nil, &browser.Failure{Code: browser.WaitingForDeployment}
	}
	var c *CaptureJobRecord
	w.browser.during = func() {
		w.browser.during = nil
		c = w.deployment(t, "sup-c", "cccccccccccccccc")
	}
	if outcome := w.run(t, b.ID); !outcome.Done {
		t.Fatalf("outcome=%+v", outcome)
	}
	if job := w.job(t, b.ID); job.Phase != "CANCELLED" || *job.FailureCode != "superseded" || job.Attempts != 1 {
		t.Fatalf("running=%+v", job)
	}
	// A job parked for sign-in is cancelled too; the newer one waits in its place.
	w.browser.run = func(browser.RunInput) (*browser.RunResult, error) {
		return nil, &browser.Failure{Code: browser.NeedsAuth}
	}
	w.run(t, c.ID)
	if job := w.job(t, c.ID); job.Phase != "NEEDS_AUTH" {
		t.Fatalf("parked=%+v", job)
	}
	d := w.deployment(t, "sup-d", "dddddddddddddddd")
	if job := w.job(t, c.ID); job.Phase != "CANCELLED" || *job.FailureCode != "superseded" {
		t.Fatalf("parked=%+v", job)
	}
	// A deployment made before the newest, delivered late, is admitted already
	// superseded and never dispatched.
	sha := "0000000000000000"
	late, err := w.repo.IngestDeployment(w.ctx, Actor{OrganizationID: w.org, Kind: "webhook", Display: w.source.ID},
		IngestDeploymentInput{Environment: "production", EventID: "late", ExternalID: "sup-late", SourceAppID: w.source.ID, SHA: &sha, DeployedAt: time.Now().Add(-time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.repo.HandleOutboxEvent(w.ctx, "unused", w.org, EventDeploymentSucceeded, late.DeploymentID); err != nil {
		t.Fatal(err)
	}
	lateJob := w.db.Client.CaptureJob.Query().Where(capturejob.DeploymentEventID(late.DeploymentID)).OnlyX(w.ctx)
	if lateJob.Phase != capturejob.PhaseCANCELLED || *lateJob.FailureCode != "superseded" {
		t.Fatalf("late=%+v", lateJob)
	}
	if n := w.db.Client.OutboxEvent.Query().Where(outboxevent.Type(EventCaptureJobDispatch), outboxevent.AggregateID(lateJob.ID)).CountX(w.ctx); n != 0 {
		t.Fatalf("a superseded job was dispatched %d times", n)
	}
	if row := w.db.Client.DeploymentEvent.GetX(w.ctx, late.DeploymentID); row.Status != deploymentevent.StatusSKIPPED || *row.FailureCode != "superseded" {
		t.Fatalf("late deployment=%+v", row)
	}
	if job := w.job(t, d.ID); job.Phase != "QUEUED" {
		t.Fatalf("newest=%+v", job)
	}
	if job := w.job(t, manual.ID); job.Phase != "QUEUED" {
		t.Fatalf("a person's request was superseded: %+v", job)
	}
}

// F4: a workflow run waiting on its deployment's job ends as superseded when a
// newer deployment cancels that job, and when its deployment arrives late.
func TestCaptureActionEndsWhenItsDeploymentIsSuperseded(t *testing.T) {
	w := newCaptureWorld(t)
	_, recipe := w.ready(t)
	w.deployment(t, "run-1", "1111111111111111")
	input := automation.Outputs{CampaignID: "campaign"}
	attempt := func(object string) error {
		event := &ent.ReleaseSourceEvent{ID: "event-" + object, SourceAppID: w.source.ID, Snapshot: automation.Event{Family: automation.Deployed, ObjectID: object}}
		_, err := w.repo.automationAuthenticatedCapture(w.ctx, w.org, event, input, &automation.Action{RecipeID: recipe.ID})
		return err
	}
	if err := attempt("run-1"); !errors.Is(err, ErrCapturePending) {
		t.Fatalf("pending: %v", err)
	}
	w.deployment(t, "run-2", "2222222222222222")
	if err := attempt("run-1"); !errors.Is(err, ErrCaptureSuperseded) || !PermanentAutomationError(err) || automationFailureCode(err) != "superseded" {
		t.Fatalf("superseded: %v", err)
	}
	sha := "0000000000000000"
	if _, err := w.repo.IngestDeployment(w.ctx, Actor{OrganizationID: w.org, Kind: "webhook", Display: w.source.ID},
		IngestDeploymentInput{Environment: "production", EventID: "late", ExternalID: "run-0", SourceAppID: w.source.ID, SHA: &sha, DeployedAt: time.Now().Add(-time.Hour)}); err != nil {
		t.Fatal(err)
	}
	if err := attempt("run-0"); !errors.Is(err, ErrCaptureSuperseded) {
		t.Fatalf("late: %v", err)
	}
}

// C5: a connection serves one environment. A staging connection's recipe never
// captures a production deployment of the same repository, and a release waits
// for its commit's deployment in the recipe's own environment.
func TestCaptureActionUsesOnlyItsEnvironmentsConnection(t *testing.T) {
	w := newCaptureWorld(t)
	_, production := w.ready(t)
	source := w.source.ID
	staging, err := w.repo.CreateCaptureConnection(w.ctx, w.owner, CreateCaptureConnectionInput{Name: "Staging app", SourceAppID: &source, Environment: "staging", Origin: "https://app.example.com",
		Hosts: []string{"app.example.com"}, ProtectedPath: "/dashboard", IdentitySelector: "[data-testid=account]", ExpectedAccount: "demo"})
	if err != nil {
		t.Fatal(err)
	}
	w.signIn(t, staging.ID)
	definition := browser.Recipe{SchemaVersion: 1, Viewport: browser.Viewport{Width: 800, Height: 600}, Steps: []browser.Step{{Kind: browser.StepNavigate, Path: "/dashboard"}},
		Markers: []string{"[data-testid=ready]"}, Version: &browser.VersionCheck{Path: "/api/version"}}
	recipe, err := w.repo.CreateCaptureRecipe(w.ctx, w.owner, CreateCaptureRecipeInput{Name: "Staging dashboard", SurfaceID: w.surface, ConnectionID: staging.ID, Definition: definition})
	if err != nil {
		t.Fatal(err)
	}
	test, err := w.repo.RequestCaptureJob(w.ctx, w.owner, recipe.ID, CaptureJobRequest{Test: true})
	if err != nil {
		t.Fatal(err)
	}
	w.run(t, test.ID)
	if _, err := w.repo.ActivateCaptureRecipe(w.ctx, w.owner, recipe.ID); err != nil {
		t.Fatal(err)
	}
	sha := "abcdef1234567890abcdef1234567890abcdef12"
	ingest := func(environment, external string) {
		t.Helper()
		if _, err := w.repo.IngestDeployment(w.ctx, Actor{OrganizationID: w.org, Kind: "webhook", Display: w.source.ID},
			IngestDeploymentInput{Environment: environment, EventID: external, ExternalID: external, SourceAppID: w.source.ID, SHA: &sha}); err != nil {
			t.Fatal(err)
		}
	}
	ingest("production", "env-prod")
	input := automation.Outputs{CampaignID: "campaign"}
	attempt := func(snapshot automation.Event, recipeID string) error {
		event := &ent.ReleaseSourceEvent{ID: "event" + w.id, SourceAppID: w.source.ID, Snapshot: snapshot}
		_, err := w.repo.automationAuthenticatedCapture(w.ctx, w.org, event, input, &automation.Action{RecipeID: recipeID})
		return err
	}
	deployed := automation.Event{Family: automation.Deployed, ObjectID: "env-prod"}
	if err := attempt(deployed, recipe.ID); !errors.Is(err, ErrCaptureRefused) {
		t.Fatalf("staging connection for production: %v", err)
	}
	if n := w.db.Client.CaptureJob.Query().Where(capturejob.RecipeID(recipe.ID), capturejob.KindEQ(capturejob.KindDeployment)).CountX(w.ctx); n != 0 {
		t.Fatalf("a staging job was admitted for production: %d", n)
	}
	if err := attempt(deployed, production.ID); !errors.Is(err, ErrCapturePending) {
		t.Fatalf("production connection: %v", err)
	}
	reader := w.repo.github.(fakeReader)
	reader.commits = map[string]string{"v9": sha}
	w.repo.WithGitHubApp(reader)
	released := automation.Event{Family: automation.Published, RepositoryID: "1001", Fields: map[string]automation.Value{"release.tag": automation.StringValue("v9")}}
	if err := attempt(released, recipe.ID); !errors.Is(err, ErrDeploymentNotLive) {
		t.Fatalf("before the staging deployment: %v", err)
	}
	ingest("staging", "env-staging")
	if err := attempt(released, recipe.ID); !errors.Is(err, ErrCapturePending) {
		t.Fatalf("staging release: %v", err)
	}
	job := w.db.Client.CaptureJob.Query().Where(capturejob.RecipeID(recipe.ID), capturejob.KindEQ(capturejob.KindDeployment)).OnlyX(w.ctx)
	if row := w.db.Client.DeploymentEvent.GetX(w.ctx, *job.DeploymentEventID); row.Environment != "staging" {
		t.Fatalf("job deployment=%+v", row)
	}
}

// C11: claims on two connections race for the workspace's one capture slot.
// However they interleave, one proceeds and the other waits; neither
// connection's lease could stop that alone.
func TestCaptureConcurrentClaimsTakeOneWorkspaceSlot(t *testing.T) {
	w := newCaptureWorld(t)
	_, recipe := w.ready(t)
	source := w.source.ID
	second, err := w.repo.CreateCaptureConnection(w.ctx, w.owner, CreateCaptureConnectionInput{Name: "Other app", SourceAppID: &source, Environment: "staging", Origin: "https://other.example.com",
		Hosts: []string{"other.example.com"}, ProtectedPath: "/dashboard", IdentitySelector: "#me", ExpectedAccount: "demo"})
	if err != nil {
		t.Fatal(err)
	}
	w.signIn(t, second.ID)
	surface := "othersurface" + w.id
	w.exec(t, `INSERT INTO product_surface (id,"organizationId",name,slug,url,"featureTags","screenshotAssetIds","createdAt","updatedAt") VALUES ($1,$2,'Other','other','https://other.example.com/dashboard','[]','[]',now(),now())`, surface, w.org)
	definition := browser.Recipe{SchemaVersion: 1, Viewport: browser.Viewport{Width: 800, Height: 600}, Steps: []browser.Step{{Kind: browser.StepNavigate, Path: "/dashboard"}}, Markers: []string{"#ready"}}
	other, err := w.repo.CreateCaptureRecipe(w.ctx, w.owner, CreateCaptureRecipeInput{Name: "Other", SurfaceID: surface, ConnectionID: second.ID, Definition: definition})
	if err != nil {
		t.Fatal(err)
	}
	for round := 0; round < 20; round++ {
		test, err := w.repo.RequestCaptureJob(w.ctx, w.owner, other.ID, CaptureJobRequest{Test: true})
		if err != nil {
			t.Fatal(err)
		}
		jobs := []string{w.request(t, recipe.ID).ID, test.ID}
		claims, outcomes, errs := make([]*captureClaim, 2), make([]*CaptureJobOutcome, 2), make([]error, 2)
		start := make(chan struct{})
		var group sync.WaitGroup
		for i, id := range jobs {
			group.Add(1)
			go func() {
				defer group.Done()
				<-start
				claims[i], outcomes[i], errs[i] = w.repo.claimCaptureJob(w.ctx, w.org, id)
			}()
		}
		close(start)
		group.Wait()
		claimed := 0
		for i := range jobs {
			switch {
			case errs[i] != nil:
				t.Fatal(errs[i])
			case claims[i] != nil:
				claimed++
			case outcomes[i] == nil || outcomes[i].Done || outcomes[i].RetryAfterSeconds <= 0:
				t.Fatalf("round %d: claim %d neither ran nor waited: %+v", round, i, outcomes[i])
			}
		}
		if claimed != 1 {
			t.Fatalf("round %d: %d claims took the workspace's one slot", round, claimed)
		}
		// End the round: the attempt finishes and both jobs stop.
		w.db.Client.CaptureAttempt.Update().Where(captureattempt.CaptureJobIDIn(jobs...)).SetStatus(captureattempt.StatusFAILED).ExecX(w.ctx)
		w.db.Client.CaptureJob.Update().Where(capturejob.IDIn(jobs...)).SetPhase(capturejob.PhaseCANCELLED).SetStatus(capturejob.StatusCANCELLED).ExecX(w.ctx)
		w.db.Client.PlatformAppConnection.Update().Where(platformappconnection.OrganizationID(w.org)).ClearLeaseJobID().ClearLeaseExpiresAt().ExecX(w.ctx)
	}
}

// C6: suspending the GitHub App stops its sources' capture jobs. Waiting
// deployment jobs are cancelled, and every other job is refused before a
// browser is allocated.
func TestCaptureSuspendedInstallationOpensNoBrowser(t *testing.T) {
	w := newCaptureWorld(t)
	_, recipe := w.ready(t)
	deployment := w.deployment(t, "suspend-1", "abcdef1234567890")
	manual := w.request(t, recipe.ID)
	w.repo.WithGitHubApp(fakeReader{fakeGitHub: fakeGitHub{installs: map[int64]githubapp.Installation{w.installation: {ID: w.installation, Suspended: true}}}})
	if _, err := w.repo.SetGitHubInstallationStatus(w.ctx, w.installation, GitHubInstallationSuspended); err != nil {
		t.Fatal(err)
	}
	if job := w.job(t, deployment.ID); job.Phase != "CANCELLED" || *job.FailureCode != "installation_suspended" {
		t.Fatalf("deployment job=%+v", job)
	}
	runs, allocated := w.browser.runs.Load(), len(w.browser.allocated)
	for _, id := range []string{deployment.ID, manual.ID} {
		if outcome := w.run(t, id); !outcome.Done {
			t.Fatalf("outcome=%+v", outcome)
		}
	}
	if job := w.job(t, manual.ID); job.Phase != "CANCELLED" || *job.FailureCode != "installation_suspended" {
		t.Fatalf("manual job=%+v", job)
	}
	if w.browser.runs.Load() != runs || len(w.browser.allocated) != allocated || w.browser.open() != 0 {
		t.Fatalf("a suspended installation opened a browser: runs=%d allocated=%d", w.browser.runs.Load(), len(w.browser.allocated))
	}
}
