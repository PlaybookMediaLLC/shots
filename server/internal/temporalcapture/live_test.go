package temporalcapture

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	_ "image/png"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/captureattempt"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/capturejob"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/surfacecapture"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/capture/browser"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/capture/sessionstate"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/database"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/maintenance"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/lucsky/cuid"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/worker"
)

// syntheticApp is the RFC's synthetic protected app: a real sign-in, a session
// token that rotates, an app-owned identity signal, a version report, and probes
// that record what reaches it. Served to the real provider through a tunnel.
type syntheticApp struct {
	mu      sync.Mutex
	tokens  map[string]bool
	next    int
	rotate  atomic.Bool
	commit  atomic.Value
	socket  atomic.Int32
	mutate  atomic.Int32
	logins  atomic.Int32
	signins atomic.Int32
}

func (a *syntheticApp) issue() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.next++
	token := fmt.Sprintf("synthetic-session-secret-%d", a.next)
	a.tokens[token] = true
	return token
}

func (a *syntheticApp) valid(token string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.tokens[token]
}

func (a *syntheticApp) revokeAll() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.tokens = map[string]bool{}
}

func (a *syntheticApp) setSession(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{Name: "demo_session", Value: token, Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode})
}

func (a *syntheticApp) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Upgrade") != "" {
		a.socket.Add(1)
		http.Error(w, "no", http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "text/html")
	switch r.URL.Path {
	case "/login":
		a.logins.Add(1)
		fmt.Fprint(w, `<title>Sign in</title><form method="post" action="/session"><input id="email" name="email"><input id="password" type="password" name="password"><button id="go">Sign in</button></form>`)
	case "/session":
		a.signins.Add(1)
		a.setSession(w, a.issue())
		fmt.Fprint(w, `<script>localStorage.setItem('demo_device','synthetic-local-secret');location='/dashboard'</script>`)
	case "/dashboard":
		cookie, err := r.Cookie("demo_session")
		if err != nil || !a.valid(cookie.Value) {
			http.Redirect(w, r, "/login", http.StatusFound)
			return
		}
		// A rotating refresh token: the old value stops working at once.
		if a.rotate.Load() {
			a.mu.Lock()
			delete(a.tokens, cookie.Value)
			a.mu.Unlock()
			a.setSession(w, a.issue())
		}
		fmt.Fprintf(w, `<body style="margin:0;background:#fff"><script>if(!localStorage.getItem('demo_device'))location='/login'</script>
<div data-testid="account">demo@synthetic.example</div><div data-testid="ready">Dashboard ready</div>
<div data-testid="secret" style="position:absolute;left:100px;top:100px;width:200px;height:100px;background:#0f0">private@synthetic.example</div>
<img src="https://example.com/blocked.png" alt=""><meta name="build" content="%s">
<script>try{new WebSocket('wss://'+location.host+'/socket')}catch(e){};fetch('/mutate',{method:'POST'}).catch(()=>{})</script></body>`, a.commit.Load())
	case "/mutate":
		a.mutate.Add(1)
	case "/api/version":
		fmt.Fprintf(w, `{"commit":%q}`, a.commit.Load())
	default:
		fmt.Fprint(w, "<html>synthetic</html>")
	}
}

// memoryObjects is object storage for this test; the real store is S3.
type memoryObjects struct {
	mu   sync.Mutex
	data map[string][]byte
}

func (m *memoryObjects) SignUpload(_ context.Context, key, _ string) (string, error) {
	return "https://objects.test/" + key, nil
}
func (m *memoryObjects) SignDownload(_ context.Context, key string) (string, error) {
	return "https://objects.test/" + key, nil
}
func (m *memoryObjects) Exists(_ context.Context, key string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.data[key]
	return ok, nil
}
func (m *memoryObjects) Put(_ context.Context, key, _ string, body io.Reader) error {
	data, err := io.ReadAll(body)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.data[key] = data
	return nil
}
func (m *memoryObjects) Read(_ context.Context, key string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.data[key], nil
}
func (m *memoryObjects) Delete(_ context.Context, key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.data, key)
	return nil
}

// TestLiveProviderWorkerAndSignedInCapture is the RFC's gate on the real
// provider: a sign-in, a fresh browser restoring it, a signed-in capture through
// the real Temporal worker and outbox dispatcher, version proof, an expired session
// and a reconnect, token rotation, and revocation. Automation plays the person.
func TestLiveProviderWorkerAndSignedInCapture(t *testing.T) {
	raw, port, address, dsn, dir := os.Getenv("CAPTURE_LIVE_SYNTHETIC_ORIGIN"), os.Getenv("CAPTURE_LIVE_SYNTHETIC_PORT"), os.Getenv("TEMPORAL_ADDRESS"), os.Getenv("PUBLISHING_TEST_DATABASE_URL"), os.Getenv("CAPTURE_LIVE_DIR")
	provider := browser.FromEnvironment()
	if raw == "" || port == "" || address == "" || dsn == "" || dir == "" || provider == nil {
		t.Skip("needs the provider, a tunnel, Temporal, and a test database")
	}
	origin, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 14*time.Minute)
	defer cancel()

	app := &syntheticApp{tokens: map[string]bool{}}
	app.commit.Store("1111111111111111111111111111111111111111")
	listener, err := net.Listen("tcp", "127.0.0.1:"+port)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: app}
	go func() { _ = server.Serve(listener) }()
	defer server.Close()

	db, err := database.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	id := cuid.New()
	org, user, session := "org_"+id, "user_"+id, "session_"+id
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.SQL.ExecContext(ctx, query, args...); err != nil {
			t.Fatalf("%v\n%s", err, query)
		}
	}
	exec(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Owner',$2,true,now(),now())`, user, user+"@example.test")
	exec(`INSERT INTO organization (id,name,slug,"createdAt") VALUES ($1,$1,$1,now())`, org)
	exec(`INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,'owner',now())`, "member_"+id, org, user)
	exec(`INSERT INTO session (id,"expiresAt",token,"createdAt","updatedAt","userId","activeOrganizationId") VALUES ($1,now()+interval '1 hour',$1,now(),now(),$2,$3)`, session, user, org)
	exec(`INSERT INTO workspace_entitlement ("organizationId",plan,status,"createdAt","updatedAt") VALUES ($1,'pro','active',now(),now())`, org)
	exec(`INSERT INTO source_app (id,"organizationId",name,provider,"allowedHosts",status,"createdAt","updatedAt") VALUES ($1,$2,'synthetic','generic','[]','ACTIVE',now(),now())`, "source_"+id, org)
	exec(`INSERT INTO product_surface (id,"organizationId",name,slug,url,"featureTags","screenshotAssetIds","createdAt","updatedAt") VALUES ($1,$2,'Dashboard','dashboard',$3,'[]','[]',now(),now())`, "surface_"+id, org, raw+"/dashboard")
	t.Cleanup(func() {
		_, _ = db.SQL.ExecContext(context.Background(), `DELETE FROM organization WHERE id=$1`, org)
		_, _ = db.SQL.ExecContext(context.Background(), `DELETE FROM "user" WHERE id=$1`, user)
	})

	key := bytes.Repeat([]byte{9}, 32)
	keys, err := sessionstate.NewKeys(key)
	if err != nil {
		t.Fatal(err)
	}
	objects := &memoryObjects{data: map[string][]byte{}}
	temporal, err := client.DialContext(ctx, client.Options{HostPort: address})
	if err != nil {
		t.Fatal(err)
	}
	defer temporal.Close()
	repo := product.NewConfiguration(db.Client).WithObjectStore(objects).WithAuthenticatedCapture(browser.Runner{Provider: provider}, keys).WithCaptureDispatcher(&Client{Temporal: temporal})
	w := worker.New(temporal, TaskQueue, worker.Options{MaxConcurrentActivityExecutionSize: 3})
	Register(w, &Activities{Store: repo})
	if err := w.Start(); err != nil {
		t.Fatal(err)
	}
	defer w.Stop()
	dispatcher := &maintenance.Store{DB: db.SQL, Events: repo}
	owner := product.Actor{OrganizationID: org, UserID: user, SessionID: session, RequestID: "live-" + id}
	waitFor := func(what string, limit time.Duration, done func() bool) time.Duration {
		t.Helper()
		started := time.Now()
		for time.Since(started) < limit {
			if _, err := dispatcher.Outbox(ctx); err != nil {
				t.Fatalf("outbox: %v", err)
			}
			if done() {
				t.Logf("%s after %s", what, time.Since(started).Round(100*time.Millisecond))
				return time.Since(started)
			}
			time.Sleep(time.Second)
		}
		t.Fatalf("timed out waiting: %s", what)
		return 0
	}
	connection := func(id string) *ent.PlatformAppConnection { return db.Client.PlatformAppConnection.GetX(ctx, id) }

	source := "source_" + id
	created, err := repo.CreateCaptureConnection(ctx, owner, product.CreateCaptureConnectionInput{Name: "Synthetic", SourceAppID: &source, Environment: "production", Origin: raw,
		Hosts: []string{origin.Hostname()}, ProtectedPath: "/dashboard", IdentitySelector: "[data-testid=account]", ExpectedAccount: "demo@synthetic.example"})
	if err != nil {
		t.Fatal(err)
	}
	// However this test ends, nothing stays open on the provider.
	t.Cleanup(func() {
		if err := repo.RevokeCaptureConnection(context.Background(), owner, created.ID); err != nil {
			t.Logf("cleanup revoke: %v", err)
		}
		if err := repo.ReclaimCaptureResources(context.Background()); err != nil {
			t.Logf("cleanup reclaim: %v", err)
		}
	})
	// The person's sign-in browser runs the app normally. Only capture runs are
	// locked down, so the probes count from after each sign-in.
	var socketBaseline, mutateBaseline int32
	// signIn plays the person: the product opens a real browser and issues a Live
	// View link, and the person's form submission happens in that same browser.
	signIn := func() {
		t.Helper()
		start, err := repo.StartCaptureConnect(ctx, owner, created.ID)
		if err != nil {
			t.Fatalf("start: %v", err)
		}
		if !strings.HasPrefix(start.LiveViewURL, "https://") {
			t.Fatal("no Live View link")
		}
		session := *connection(created.ID).ConnectSessionID
		personCtx, disconnect := context.WithCancel(ctx)
		defer disconnect()
		person, err := provider.Connect(personCtx, session)
		if err != nil {
			t.Fatalf("connect: %v", err)
		}
		pages, err := person.Pages()
		if err != nil || len(pages) == 0 {
			t.Fatalf("pages=%d err=%v", len(pages), err)
		}
		page := pages.First().Context(personCtx)
		if err := page.Navigate(raw + "/login"); err != nil {
			t.Fatalf("navigate: %v", err)
		}
		// Bounded waits, reporting where the browser is rather than hanging.
		waitElement := func(selector string) {
			t.Helper()
			if _, err := page.Timeout(45 * time.Second).Element(selector); err != nil {
				info, _ := page.Info()
				title, url := "", ""
				if info != nil {
					title, url = info.Title, info.URL
				}
				text := ""
				if body, evalErr := pages.First().Context(ctx).Eval(`() => document.body ? document.body.innerText.slice(0, 300) : ''`); evalErr == nil {
					text = body.Value.Str()
				}
				t.Fatalf("no %s: title=%q url=%q signins=%d logins=%d text=%q err=%v", selector, title, url, app.signins.Load(), app.logins.Load(), text, err)
			}
		}
		waitElement("#email")
		if _, err := page.Eval(`() => document.querySelector('form').submit()`); err != nil {
			t.Fatal(err)
		}
		waitElement("[data-testid=ready]")
		time.Sleep(2 * time.Second)
		socketBaseline, mutateBaseline = app.socket.Load(), app.mutate.Load()
		disconnect()
		if err := repo.FinishCaptureConnect(ctx, owner, created.ID, start.IntentID); err != nil {
			t.Fatalf("finish: %v", err)
		}
	}
	signIn()
	if row := connection(created.ID); row.Status == "READY" {
		t.Fatal("pressing Done made the connection ready")
	}
	waitFor("the worker's verdict on the sign-in", 3*time.Minute, func() bool {
		row := connection(created.ID)
		return row.Status == "READY" || row.FailureCode != nil
	})
	if row := connection(created.ID); row.Status != "READY" {
		t.Fatalf("a fresh browser did not restore the sign-in: status=%s code=%v", row.Status, *row.FailureCode)
	}
	row := connection(created.ID)
	if row.StateCiphertext == nil || strings.Contains(*row.StateCiphertext, "synthetic-session-secret") || strings.Contains(*row.StateCiphertext, base64.StdEncoding.EncodeToString([]byte("synthetic-session-secret"))) {
		t.Fatal("session state stored readable")
	}
	binding := sessionstate.Binding{Organization: org, Connection: created.ID, Environment: "production", Generation: row.Generation}
	opened, _, err := keys.Open(*row.StateCiphertext, binding)
	if err != nil {
		t.Fatal(err)
	}
	var exported browser.State
	if err := json.Unmarshal(opened, &exported); err != nil || len(exported.Cookies) == 0 || exported.LocalStorage[raw]["demo_device"] != "synthetic-local-secret" {
		t.Fatalf("exported cookies=%d storage=%d err=%v", len(exported.Cookies), len(exported.LocalStorage), err)
	}

	recipe, err := repo.CreateCaptureRecipe(ctx, owner, product.CreateCaptureRecipeInput{Name: "Dashboard", SurfaceID: "surface_" + id, ConnectionID: created.ID, Definition: browser.Recipe{SchemaVersion: 1,
		Viewport: browser.Viewport{Width: 1280, Height: 800}, Steps: []browser.Step{{Kind: browser.StepNavigate, Path: "/dashboard", TimeoutMs: 20000}, {Kind: browser.StepWaitFor, Selector: "[data-testid=ready]"}},
		Markers: []string{"[data-testid=ready]"}, Masks: []string{"[data-testid=secret]"}, Version: &browser.VersionCheck{Path: "/api/version"}}})
	if err != nil {
		t.Fatal(err)
	}
	test, err := repo.RequestCaptureJob(ctx, owner, recipe.ID, product.CaptureJobRequest{Test: true})
	if err != nil {
		t.Fatal(err)
	}
	job := func(id string) *ent.CaptureJob { return db.Client.CaptureJob.GetX(ctx, id) }
	settled := func(id string) func() bool {
		return func() bool {
			switch job(id).Phase {
			case capturejob.PhaseSUCCEEDED, capturejob.PhaseFAILED, capturejob.PhaseCANCELLED, capturejob.PhaseNEEDS_AUTH:
				return true
			}
			return false
		}
	}
	waitFor("a signed-in test capture through the worker", 3*time.Minute, settled(test.ID))
	tested := job(test.ID)
	if tested.Phase != capturejob.PhaseSUCCEEDED || tested.AssetID == nil {
		t.Fatalf("test job=%+v failure=%v", tested.Phase, tested.FailureCode)
	}
	asset := db.Client.Asset.GetX(ctx, *tested.AssetID)
	shot, _ := objects.Read(ctx, asset.ObjectKey)
	picture, _, err := image.Decode(bytes.NewReader(shot))
	if err != nil {
		t.Fatalf("image: %v", err)
	}
	if bounds := picture.Bounds(); bounds.Dx() != 1280 || bounds.Dy() != 800 {
		t.Fatalf("bounds=%v", bounds)
	}
	for x := 110; x < 290; x += 30 {
		if r, g, b, _ := picture.At(x, 150).RGBA(); g > r+1000 || g > b+1000 {
			t.Fatalf("the mask leaked at %d: %d %d %d", x, r, g, b)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "signed-in-capture.png"), shot, 0o644); err != nil {
		t.Fatal(err)
	}
	attempt := db.Client.CaptureAttempt.Query().Where(captureattempt.CaptureJobID(test.ID)).OnlyX(ctx)
	if attempt.BrowserClosedAt == nil || attempt.RefusedRequests == 0 {
		t.Fatalf("attempt closed=%v refused=%d", attempt.BrowserClosedAt, attempt.RefusedRequests)
	}
	t.Logf("signed-in capture: %d bytes, refused requests=%d", len(shot), attempt.RefusedRequests)
	time.Sleep(time.Second)
	if n := app.socket.Load() - socketBaseline; n != 0 {
		t.Fatalf("a capture run's WebSocket reached the app %d times", n)
	}
	if n := app.mutate.Load() - mutateBaseline; n != 0 {
		t.Fatalf("a capture run's unapproved POST reached the app %d times", n)
	}
	if _, err := repo.ActivateCaptureRecipe(ctx, owner, recipe.ID); err != nil {
		t.Fatal(err)
	}

	// Release before deployment: the app still reports the old commit, so the job
	// waits through real workflow timers and records nothing, then finishes.
	deploy := func(external, sha string) string {
		t.Helper()
		result, err := repo.IngestDeployment(ctx, product.Actor{OrganizationID: org, Kind: "webhook", Display: source}, product.IngestDeploymentInput{Environment: "production", EventID: external, ExternalID: external, SourceAppID: source, SHA: &sha})
		if err != nil {
			t.Fatal(err)
		}
		var jobID string
		waitFor("the deployment admitted a job", time.Minute, func() bool {
			found, err := db.Client.CaptureJob.Query().Where(capturejob.OrganizationID(org), capturejob.DeploymentEventID(result.DeploymentID)).Only(ctx)
			if err != nil {
				return false
			}
			jobID = found.ID
			return true
		})
		return jobID
	}
	sha := "abcdef1234567890abcdef1234567890abcdef12"
	deployed := deploy("live-1", sha)
	waitFor("the job saw the old commit", 2*time.Minute, func() bool { return job(deployed).Phase == capturejob.PhaseWAITING_DEPLOYMENT })
	if n := db.Client.SurfaceCapture.Query().Where(surfacecapture.SurfaceID("surface_" + id)).CountX(ctx); n != 0 {
		t.Fatal("the old page was recorded as this deployment")
	}
	app.commit.Store(sha)
	waitFor("the job finished after the commit went live", 4*time.Minute, settled(deployed))
	done := job(deployed)
	if done.Phase != capturejob.PhaseSUCCEEDED || done.SurfaceCaptureID == nil {
		t.Fatalf("job=%s failure=%v", done.Phase, done.FailureCode)
	}
	if receipt := db.Client.SurfaceCapture.GetX(ctx, *done.SurfaceCaptureID); receipt.ObservedRevision == nil || *receipt.ObservedRevision != sha {
		t.Fatalf("receipt=%+v", receipt)
	}
	t.Logf("version-proven capture took %d attempts", done.Attempts)

	// Token rotation: each visit invalidates the last token, so this next job can
	// pass only if the state saved by the previous one was the rotated token.
	app.rotate.Store(true)
	revision := connection(created.ID).StateRevision
	rotated := deploy("live-2", sha)
	waitFor("a capture rotated the session token", 3*time.Minute, settled(rotated))
	if job(rotated).Phase != capturejob.PhaseSUCCEEDED || connection(created.ID).StateRevision <= revision {
		t.Fatalf("rotated job=%s failure=%v revision=%d", job(rotated).Phase, job(rotated).FailureCode, connection(created.ID).StateRevision)
	}
	again := deploy("live-3", sha)
	waitFor("the next capture used the rotated token", 3*time.Minute, settled(again))
	if job(again).Phase != capturejob.PhaseSUCCEEDED {
		t.Fatalf("after rotation job=%s failure=%v", job(again).Phase, job(again).FailureCode)
	}
	app.rotate.Store(false)

	// The app ends every session: the job asks for a person, records no login
	// screen, and a reconnect resumes that same job.
	app.revokeAll()
	captures := db.Client.SurfaceCapture.Query().Where(surfacecapture.SurfaceID("surface_" + id)).CountX(ctx)
	expired := deploy("live-4", sha)
	waitFor("an expired session parked the job", 3*time.Minute, settled(expired))
	if job(expired).Phase != capturejob.PhaseNEEDS_AUTH || connection(created.ID).Status != "NEEDS_AUTH" {
		t.Fatalf("expired job=%s status=%s", job(expired).Phase, connection(created.ID).Status)
	}
	if n := db.Client.SurfaceCapture.Query().Where(surfacecapture.SurfaceID("surface_" + id)).CountX(ctx); n != captures {
		t.Fatal("a login screen was recorded")
	}
	generation := connection(created.ID).Generation
	signIn()
	waitFor("the reconnect resumed the parked job", 4*time.Minute, func() bool { return job(expired).Phase == capturejob.PhaseSUCCEEDED })
	if connection(created.ID).Generation != generation+1 || job(expired).ResumeCount != 1 {
		t.Fatalf("generation=%d resume=%d", connection(created.ID).Generation, job(expired).ResumeCount)
	}

	// Revocation deletes the state and stops new work.
	if err := repo.RevokeCaptureConnection(ctx, owner, created.ID); err != nil {
		t.Fatal(err)
	}
	if row := connection(created.ID); row.Status != "REVOKED" || row.StateCiphertext != nil {
		t.Fatalf("revoked=%+v", row.Status)
	}
	// Nothing reached the app that should not have, across the whole run.
	if app.socket.Load() != socketBaseline || app.mutate.Load() != mutateBaseline {
		t.Fatalf("socket=%d mutate=%d, baselines %d and %d", app.socket.Load(), app.mutate.Load(), socketBaseline, mutateBaseline)
	}
	// Every browser this run opened is closed.
	var open int
	waitFor("every provider session closed", 90*time.Second, func() bool {
		request, _ := http.NewRequestWithContext(ctx, http.MethodGet, provider.Base+"/devtools/session", nil)
		request.Header.Set("Authorization", "Bearer "+provider.Token)
		response, err := provider.HTTP.Do(request)
		if err != nil {
			return false
		}
		defer response.Body.Close()
		var out struct {
			Result []struct {
				SessionID string `json:"sessionId"`
			} `json:"result"`
		}
		body, _ := io.ReadAll(response.Body)
		if json.Unmarshal(body, &out) != nil {
			var list []json.RawMessage
			if json.Unmarshal(body, &list) != nil {
				return false
			}
			open = len(list)
			return open == 0
		}
		open = len(out.Result)
		return open == 0
	})
}
