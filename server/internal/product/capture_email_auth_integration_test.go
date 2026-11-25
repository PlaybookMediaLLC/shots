package product

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/auditlog"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/captureauthattempt"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/captureinboundreceipt"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/capturejob"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/outboxevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformappconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/capture/browser"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/capture/emailauth"
)

const testEmailDomain = "capture-mail.example.test"

var testWebhookSecret = "whsec_" + base64.StdEncoding.EncodeToString([]byte("integration-signing-key-32-bytes"))

// emailBrowser adds the email sign-in steps to the scripted provider. It
// records what each step received so a test can prove the link or code
// reached only the browser.
type emailBrowser struct {
	*scriptedBrowser
	mu        sync.Mutex
	requested int
	links     []string
	codes     []string
	request   error
	apply     error
	// duringRequest runs inside the request, after the attempt is durably waiting.
	duringRequest func()
	// applyHook runs while the browser uses the link or code.
	applyHook func()
}

func (b *emailBrowser) RequestEmailChallenge(_ context.Context, session string, _ browser.Target, _ []string, _ browser.LoginRecipe, _ string, beforeSubmit func() error) error {
	if b.request != nil {
		return b.request
	}
	if err := beforeSubmit(); err != nil {
		return err
	}
	b.mu.Lock()
	b.requested++
	b.mu.Unlock()
	if b.duringRequest != nil {
		b.duringRequest()
	}
	return nil
}

func (b *emailBrowser) ApplyMagicLink(_ context.Context, _ string, _ browser.Target, _ []string, recipe browser.LoginRecipe, link browser.SecretURL) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.links = append(b.links, fmt.Sprint(link))
	if b.applyHook != nil {
		b.mu.Unlock()
		b.applyHook()
		b.mu.Lock()
	}
	return b.apply
}

func (b *emailBrowser) ApplyEmailCode(_ context.Context, _ string, _ browser.Target, _ []string, _ browser.LoginRecipe, code browser.SecretCode) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.codes = append(b.codes, fmt.Sprint(code))
	return b.apply
}

// fakeInbox serves received emails by provider ID.
type fakeInbox struct {
	mu     sync.Mutex
	emails map[string]*emailauth.Email
	reads  int
}

func (f *fakeInbox) RecentEmails(_ context.Context, _ int) ([]emailauth.Received, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []emailauth.Received{}
	for _, email := range f.emails {
		out = append(out, emailauth.Received{ID: email.ID, From: email.From, To: email.To, CreatedAt: email.CreatedAt})
	}
	return out, nil
}

func (f *fakeInbox) ReceivedEmail(_ context.Context, id string) (*emailauth.Email, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reads++
	if email, ok := f.emails[id]; ok {
		copied := *email
		return &copied, nil
	}
	return nil, emailauth.ErrProviderRead
}

type emailAuthWorld struct {
	*captureWorld
	email    *emailBrowser
	inbox    *fakeInbox
	settings *emailauth.Settings
}

func newEmailAuthWorld(t *testing.T) *emailAuthWorld {
	t.Helper()
	w := newCaptureWorld(t)
	email := &emailBrowser{scriptedBrowser: w.browser}
	inbox := &fakeInbox{emails: map[string]*emailauth.Email{}}
	settings := &emailauth.Settings{AutoReconnect: true, Domain: testEmailDomain, WebhookSecret: testWebhookSecret, Reader: inbox,
		AttemptTTL: 3 * time.Minute, DailyAttempts: 3, MaxActive: 1000}
	w.repo.WithAuthenticatedCapture(email, w.keys).WithEmailAuth(settings)
	return &emailAuthWorld{captureWorld: w, email: email, inbox: inbox, settings: settings}
}

func (w *emailAuthWorld) magicRecipe() browser.LoginRecipe {
	return browser.LoginRecipe{SchemaVersion: 1, Method: browser.MagicLink, StartPath: "/login", EmailInput: "[data-testid=email]", RequestChallenge: "[data-testid=send]",
		SubmitPaths: []string{"/api/auth/email"}, LinkHosts: []string{"accounts.example.com"}, LinkPaths: []string{"/auth/callback"}}
}

// setup is the owner's journey: a connection with a Shots test address, a
// login recipe, and senders.
func (w *emailAuthWorld) setup(t *testing.T) (*CaptureConnectionRecord, *CaptureEmailAuthRecord) {
	t.Helper()
	source := w.source.ID
	connection, err := w.repo.CreateCaptureConnection(w.ctx, w.owner, CreateCaptureConnectionInput{Name: "Email app", SourceAppID: &source, Environment: "staging", Origin: "https://app.example.com",
		Hosts: []string{"app.example.com"}, LoginHosts: []string{"accounts.example.com"}, ProtectedPath: "/dashboard", AssignTestEmail: true})
	if err != nil {
		t.Fatal(err)
	}
	record, err := w.repo.GetCaptureEmailAuth(w.ctx, w.owner, connection.ID)
	if err != nil {
		t.Fatal(err)
	}
	if record.TestEmail != connection.ExpectedAccount || record.Status != "DRAFT" || record.AutoReconnect {
		t.Fatalf("new setup %+v for %s", record, connection.ExpectedAccount)
	}
	record, err = w.repo.SaveCaptureEmailAuthRecipe(w.ctx, w.owner, connection.ID, SaveCaptureEmailAuthRecipeInput{ExpectedRevision: record.Revision, Recipe: w.magicRecipe(), ExpectedSenders: []string{"login@example.com"}})
	if err != nil {
		t.Fatal(err)
	}
	return connection, record
}

func (w *emailAuthWorld) deliver(t *testing.T, eventID, emailID, to, from string, at time.Time) (*InboundEmailResult, error) {
	t.Helper()
	// Provider IDs are global; a workspace-unique prefix keeps reruns apart.
	eventID, emailID = w.id+eventID, w.id+emailID
	body, _ := json.Marshal(map[string]any{"type": "email.received", "created_at": at.Format(time.RFC3339Nano),
		"data": map[string]any{"email_id": emailID, "from": from, "to": []string{to}, "created_at": at.Format(time.RFC3339Nano)}})
	stamp := strconv.FormatInt(time.Now().Unix(), 10)
	return w.repo.ReceiveCaptureAuthEmail(w.ctx, InboundEmailHeaders{ID: eventID, Timestamp: stamp, Signature: emailauth.Sign(testWebhookSecret, eventID, stamp, body)}, body)
}

func (w *emailAuthWorld) attempt(t *testing.T, id string) *ent.CaptureAuthAttempt {
	t.Helper()
	return w.db.Client.CaptureAuthAttempt.GetX(w.ctx, id)
}

// runAttempt plays the workflow: request, the email arrives, check, apply.
func (w *emailAuthWorld) runAttempt(t *testing.T, id, to string) {
	t.Helper()
	if step, err := w.repo.RequestCaptureAuthChallenge(w.ctx, w.org, id); err != nil || step.Done {
		t.Fatalf("request: %+v %v (state %s)", step, err, w.attempt(t, id).State)
	}
	emailID := "em_" + id
	w.inbox.emails[w.id+emailID] = &emailauth.Email{ID: emailID, From: "Example <login@example.com>", To: []string{to}, CreatedAt: time.Now().UTC(),
		HTML: `<a href="https://accounts.example.com/auth/callback?token=one-time-secret">Sign in</a><a href="https://example.com/help">Help</a>`}
	if result, err := w.deliver(t, "evt_"+id, emailID, to, "login@example.com", time.Now().UTC()); err != nil || result.Outcome != "matched" {
		t.Fatalf("deliver: %+v %v", result, err)
	}
	if step, err := w.repo.CheckCaptureAuthAttempt(w.ctx, w.org, id); err != nil || !step.Matched {
		t.Fatalf("check: %+v %v", step, err)
	}
	if err := w.repo.ApplyCaptureAuthChallenge(w.ctx, w.org, id); err != nil {
		t.Fatalf("apply: %v", err)
	}
}

func TestEmailAuthTestSignsInAndRecordsNoSecrets(t *testing.T) {
	w := newEmailAuthWorld(t)
	connection, record := w.setup(t)
	attempt, err := w.repo.TestCaptureEmailAuth(w.ctx, w.owner, connection.ID)
	if err != nil {
		t.Fatal(err)
	}
	if n := w.db.Client.OutboxEvent.Query().Where(outboxevent.OrganizationID(w.org), outboxevent.Type(EventCaptureAuthDispatch), outboxevent.AggregateID(attempt.ID)).CountX(w.ctx); n != 1 {
		t.Fatalf("dispatch events=%d", n)
	}
	w.runAttempt(t, attempt.ID, record.TestEmail)
	row := w.attempt(t, attempt.ID)
	if row.State != captureauthattempt.StateSUCCEEDED || row.BrowserClosedAt == nil || row.FailureCode != nil {
		t.Fatalf("attempt %+v", row)
	}
	if len(w.email.links) != 1 || w.email.links[0] != "<redacted>" || w.email.requested != 1 {
		t.Fatalf("links=%v requested=%d", w.email.links, w.email.requested)
	}
	conn := w.db.Client.PlatformAppConnection.GetX(w.ctx, connection.ID)
	if conn.Status != platformappconnection.StatusREADY || conn.StateCiphertext == nil || conn.ValidatedAt == nil || conn.LastAutoAuthenticatedAt == nil {
		t.Fatalf("connection %+v", conn)
	}
	updated, err := w.repo.GetCaptureEmailAuth(w.ctx, w.owner, connection.ID)
	if err != nil || updated.TestedRevision == nil || *updated.TestedRevision != updated.Revision || updated.LatestAttempt.State != "SUCCEEDED" {
		t.Fatalf("setup %+v %v", updated, err)
	}
	if w.browser.open() != 0 {
		t.Fatalf("%d browsers left open", w.browser.open())
	}
	// No table, audit entry, or outbox payload holds the link, the token, or the body.
	var leaked int
	w.db.SQL.QueryRowContext(w.ctx, `SELECT
	  (SELECT count(*) FROM capture_auth_attempt a WHERE a::text LIKE '%one-time-secret%') +
	  (SELECT count(*) FROM capture_inbound_receipt r WHERE r::text LIKE '%one-time-secret%' OR r::text LIKE '%login@example.com%' OR r::text LIKE $1) +
	  (SELECT count(*) FROM outbox_event o WHERE o.payload::text LIKE '%one-time-secret%') +
	  (SELECT count(*) FROM audit_log l WHERE l::text LIKE '%one-time-secret%')`, "%"+record.TestEmail+"%").Scan(&leaked)
	if leaked != 0 {
		t.Fatalf("%d rows hold a secret or an address", leaked)
	}
	if n := w.db.Client.AuditLog.Query().Where(auditlog.Action("product.capture_connection_email_authenticated"), auditlog.OrganizationID(w.org)).CountX(w.ctx); n != 1 {
		t.Fatalf("audit entries=%d", n)
	}
}

func TestEmailAuthAutomaticRecoveryRenewsWithoutExtendingTheHumanCap(t *testing.T) {
	w := newEmailAuthWorld(t)
	connection, record := w.setup(t)
	test, err := w.repo.TestCaptureEmailAuth(w.ctx, w.owner, connection.ID)
	if err != nil {
		t.Fatal(err)
	}
	w.runAttempt(t, test.ID, record.TestEmail)
	record, _ = w.repo.GetCaptureEmailAuth(w.ctx, w.owner, connection.ID)
	if _, err := w.repo.EnableCaptureEmailAuth(w.ctx, w.owner, connection.ID, EnableCaptureEmailAuthInput{ExpectedRevision: record.Revision}); err != nil {
		t.Fatal(err)
	}
	// The person authorized 29 days ago; the saved session then lapsed.
	authorized := time.Now().UTC().Add(-29 * 24 * time.Hour)
	w.exec(t, `UPDATE platform_app_connection SET "validatedAt"=$1 WHERE id=$2`, authorized, connection.ID)
	if c := w.db.Client.PlatformAppConnection.GetX(w.ctx, connection.ID); c.Status != platformappconnection.StatusREADY {
		t.Fatalf("connection %s before the recipe", c.Status)
	}
	recipe := w.recipe(t, connection.ID)
	if probe, err := w.repo.RequestCaptureJob(w.ctx, w.owner, recipe.ID, CaptureJobRequest{Test: true}); err != nil || !w.run(t, probe.ID).Done {
		t.Fatalf("test capture: %v", err)
	}
	if _, err := w.repo.ActivateCaptureRecipe(w.ctx, w.owner, recipe.ID); err != nil {
		t.Fatal(err)
	}
	w.browser.run = func(browser.RunInput) (*browser.RunResult, error) {
		return nil, &browser.Failure{Code: browser.NeedsAuth}
	}
	job := w.request(t, recipe.ID)
	w.run(t, job.ID)
	parked := w.db.Client.CaptureJob.GetX(w.ctx, job.ID)
	if parked.Phase != capturejob.PhaseNEEDS_AUTH {
		t.Fatalf("job phase %s", parked.Phase)
	}
	recovery, err := w.db.Client.CaptureAuthAttempt.Query().Where(captureauthattempt.ConnectionID(connection.ID), captureauthattempt.ModeEQ(captureauthattempt.ModeAUTO_RECOVER)).Only(w.ctx)
	if err != nil {
		t.Fatalf("recovery attempt: %v", err)
	}
	if recovery.TriggerCaptureJobID == nil || *recovery.TriggerCaptureJobID != job.ID {
		t.Fatal("recovery is not tied to the parked job")
	}
	// A second parked job shares the one attempt.
	second := w.request(t, recipe.ID)
	w.run(t, second.ID)
	if n := w.db.Client.CaptureAuthAttempt.Query().Where(captureauthattempt.ConnectionID(connection.ID), captureauthattempt.ModeEQ(captureauthattempt.ModeAUTO_RECOVER)).CountX(w.ctx); n != 1 {
		t.Fatalf("recovery attempts=%d", n)
	}
	w.runAttempt(t, recovery.ID, record.TestEmail)
	conn := w.db.Client.PlatformAppConnection.GetX(w.ctx, connection.ID)
	if conn.Status != platformappconnection.StatusREADY || !conn.ValidatedAt.Equal(authorized.Truncate(time.Millisecond)) && conn.ValidatedAt.Sub(authorized).Abs() > time.Millisecond {
		t.Fatalf("validatedAt moved: %v, want %v", conn.ValidatedAt, authorized)
	}
	if limit := authorized.Add(30 * 24 * time.Hour); conn.StateExpiresAt == nil || conn.StateExpiresAt.After(limit.Add(time.Second)) {
		t.Fatalf("state expires %v, past the human cap %v", conn.StateExpiresAt, limit)
	}
	resumed := w.db.Client.CaptureJob.GetX(w.ctx, job.ID)
	if resumed.Phase != capturejob.PhaseQUEUED || resumed.ConnectionGeneration != conn.Generation {
		t.Fatalf("parked job not resumed: %s gen %d/%d", resumed.Phase, resumed.ConnectionGeneration, conn.Generation)
	}
	// Past 30 days no automatic attempt starts: a person must sign in.
	w.exec(t, `UPDATE platform_app_connection SET "validatedAt"=$1, status='NEEDS_AUTH', "stateCiphertext"=NULL WHERE id=$2`, time.Now().Add(-31*24*time.Hour), connection.ID)
	late := w.request(t, recipe.ID)
	w.run(t, late.ID)
	if n := w.db.Client.CaptureAuthAttempt.Query().Where(captureauthattempt.ConnectionID(connection.ID), captureauthattempt.ModeEQ(captureauthattempt.ModeAUTO_RECOVER)).CountX(w.ctx); n != 1 {
		t.Fatalf("an attempt started past the human cap: %d", n)
	}
}

func TestEmailAuthWebhookIsIdempotentAndIgnoresStrangers(t *testing.T) {
	w := newEmailAuthWorld(t)
	connection, record := w.setup(t)
	attempt, err := w.repo.TestCaptureEmailAuth(w.ctx, w.owner, connection.ID)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	// Before the request nothing waits: the email is ignored, not queued.
	if result, err := w.deliver(t, "evt_early", "em_early", record.TestEmail, "login@example.com", now); err != nil || result.Outcome != "ignored" {
		t.Fatalf("early: %+v %v", result, err)
	}
	if _, err := w.repo.RequestCaptureAuthChallenge(w.ctx, w.org, attempt.ID); err != nil {
		t.Fatal(err)
	}
	// A bad signature never reaches the database.
	body := []byte(`{"type":"email.received"}`)
	if _, err := w.repo.ReceiveCaptureAuthEmail(w.ctx, InboundEmailHeaders{ID: "evt_forged", Timestamp: strconv.FormatInt(now.Unix(), 10), Signature: "v1,Zm9yZ2Vk"}, body); !errors.Is(err, ErrInboundSignature) {
		t.Fatalf("forged: %v", err)
	}
	// A stranger mailing the address is ignored and cannot fail the attempt.
	if result, _ := w.deliver(t, "evt_spoof", "em_spoof", record.TestEmail, "attacker@evil.test", time.Now().UTC()); result.Outcome != "ignored" {
		t.Fatalf("spoof: %+v", result)
	}
	if result, _ := w.deliver(t, "evt_other", "em_other", "c-unknown@"+testEmailDomain, "login@example.com", time.Now().UTC()); result.Outcome != "ignored" {
		t.Fatalf("unknown address: %+v", result)
	}
	first, err := w.deliver(t, "evt_1", "em_1", record.TestEmail, "login@example.com", time.Now().UTC())
	if err != nil || first.Outcome != "matched" {
		t.Fatalf("first: %+v %v", first, err)
	}
	for _, retry := range [][2]string{{"evt_1", "em_1"}, {"evt_1b", "em_1"}} {
		if again, err := w.deliver(t, retry[0], retry[1], record.TestEmail, "login@example.com", time.Now().UTC()); err != nil || again.Outcome != "duplicate" {
			t.Fatalf("retry %v: %+v %v", retry, again, err)
		}
	}
	if n := w.db.Client.OutboxEvent.Query().Where(outboxevent.Type(EventCaptureAuthEmail), outboxevent.AggregateID(attempt.ID)).CountX(w.ctx); n != 1 {
		t.Fatalf("wake events=%d", n)
	}
	// A second plausible email before the first is used: neither is chosen.
	if second, _ := w.deliver(t, "evt_2", "em_2", record.TestEmail, "login@example.com", time.Now().UTC()); second.Outcome != "ambiguous" {
		t.Fatalf("second: %+v", second)
	}
	row := w.attempt(t, attempt.ID)
	if row.State != captureauthattempt.StateFAILED || row.FailureCode == nil || *row.FailureCode != authChallengeAmbiguous {
		t.Fatalf("attempt %s %v", row.State, row.FailureCode)
	}
	if err := w.repo.ApplyCaptureAuthChallenge(w.ctx, w.org, attempt.ID); err != nil || len(w.email.links) != 0 || w.inbox.reads != 0 {
		t.Fatalf("an ambiguous attempt applied a challenge: %v links=%d reads=%d", err, len(w.email.links), w.inbox.reads)
	}
	if n := w.db.Client.CaptureInboundReceipt.Query().Where(captureinboundreceipt.StateEQ(captureinboundreceipt.StateIGNORED), captureinboundreceipt.ProviderEventIDHasPrefix(w.id)).CountX(w.ctx); n < 4 {
		t.Fatalf("ignored receipts=%d", n)
	}
}

func TestEmailAuthPersonReconnectingWins(t *testing.T) {
	w := newEmailAuthWorld(t)
	connection, record := w.setup(t)
	attempt, err := w.repo.TestCaptureEmailAuth(w.ctx, w.owner, connection.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.repo.RequestCaptureAuthChallenge(w.ctx, w.org, attempt.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := w.deliver(t, "evt_h", "em_h", record.TestEmail, "login@example.com", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	// A person starts Live View while the email waits to be used.
	if _, err := w.repo.StartCaptureConnect(w.ctx, w.owner, connection.ID); err != nil {
		t.Fatal(err)
	}
	row := w.attempt(t, attempt.ID)
	if row.State != captureauthattempt.StateCANCELLED || *row.FailureCode != authHumanReconnect {
		t.Fatalf("attempt %s %v", row.State, row.FailureCode)
	}
	if err := w.repo.ApplyCaptureAuthChallenge(w.ctx, w.org, attempt.ID); err != nil || len(w.email.links) != 0 {
		t.Fatalf("a cancelled attempt applied the link: %v %d", err, len(w.email.links))
	}
	// While the person's sign-in is open, no test can start.
	if _, err := w.repo.TestCaptureEmailAuth(w.ctx, w.owner, connection.ID); err == nil {
		t.Fatal("a test started during a person's sign-in")
	}
}

func TestEmailAuthRevokeStopsRoutingAndWork(t *testing.T) {
	w := newEmailAuthWorld(t)
	connection, record := w.setup(t)
	attempt, err := w.repo.TestCaptureEmailAuth(w.ctx, w.owner, connection.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.repo.RequestCaptureAuthChallenge(w.ctx, w.org, attempt.ID); err != nil {
		t.Fatal(err)
	}
	if err := w.repo.RevokeCaptureConnection(w.ctx, w.owner, connection.ID); err != nil {
		t.Fatal(err)
	}
	row := w.attempt(t, attempt.ID)
	if row.State != captureauthattempt.StateCANCELLED || w.browser.open() != 0 {
		t.Fatalf("attempt %s open=%d", row.State, w.browser.open())
	}
	if result, _ := w.deliver(t, "evt_r", "em_r", record.TestEmail, "login@example.com", time.Now().UTC()); result.Outcome != "ignored" {
		t.Fatalf("revoked address routed: %+v", result)
	}
	if _, err := w.repo.GetCaptureEmailAuth(w.ctx, w.owner, connection.ID); err != nil {
		t.Fatal(err)
	}
	if setup, _ := w.repo.GetCaptureEmailAuth(w.ctx, w.owner, connection.ID); setup.Status != "REVOKED" || setup.AutoReconnect {
		t.Fatalf("setup %+v", setup)
	}
}

func TestEmailAuthGuardsSetupAndAdmission(t *testing.T) {
	w := newEmailAuthWorld(t)
	connection, record := w.setup(t)
	// Turning on automatic reconnects needs a passing test of this revision.
	if _, err := w.repo.EnableCaptureEmailAuth(w.ctx, w.owner, connection.ID, EnableCaptureEmailAuthInput{ExpectedRevision: record.Revision}); err == nil {
		t.Fatal("enabled without a test")
	}
	// A stale revision and a link host outside the connection are refused.
	if _, err := w.repo.SaveCaptureEmailAuthRecipe(w.ctx, w.owner, connection.ID, SaveCaptureEmailAuthRecipeInput{ExpectedRevision: record.Revision - 1, Recipe: w.magicRecipe(), ExpectedSenders: []string{"login@example.com"}}); err == nil {
		t.Fatal("stale revision accepted")
	}
	wide := w.magicRecipe()
	wide.LinkHosts = []string{"evil.test"}
	if _, err := w.repo.SaveCaptureEmailAuthRecipe(w.ctx, w.owner, connection.ID, SaveCaptureEmailAuthRecipeInput{ExpectedRevision: record.Revision, Recipe: wide, ExpectedSenders: []string{"login@example.com"}}); err == nil {
		t.Fatal("unapproved link host accepted")
	}
	if _, err := w.repo.SaveCaptureEmailAuthRecipe(w.ctx, w.owner, connection.ID, SaveCaptureEmailAuthRecipeInput{ExpectedRevision: record.Revision, Recipe: w.magicRecipe(), ExpectedSenders: []string{"*@example.com"}}); err == nil {
		t.Fatal("wildcard sender accepted")
	}
	// A connection that expects another email cannot be repurposed.
	other := w.connection(t)
	w.exec(t, `UPDATE platform_app_connection SET "expectedAccount"='someone@example.com' WHERE id=$1`, other.ID)
	if _, err := w.repo.CreateCaptureEmailAuth(w.ctx, w.owner, other.ID); err == nil {
		t.Fatal("repurposed a connection that expects another account")
	}
	// Another workspace sees nothing.
	stranger := newEmailAuthWorld(t)
	if _, err := stranger.repo.GetCaptureEmailAuth(stranger.ctx, stranger.owner, connection.ID); err == nil {
		t.Fatal("another workspace read the setup")
	}
	if _, err := stranger.repo.GetCaptureAuthAttempt(stranger.ctx, stranger.owner, "missing"); err == nil {
		t.Fatal("missing attempt found")
	}
	// The daily budget counts tests, and a test failure ends the attempt safely.
	w.email.request = &browser.Failure{Code: browser.UnsupportedFactor}
	for i := 0; i < 3; i++ {
		attempt, err := w.repo.TestCaptureEmailAuth(w.ctx, w.owner, connection.ID)
		if err != nil {
			t.Fatalf("test %d: %v", i, err)
		}
		if step, err := w.repo.RequestCaptureAuthChallenge(w.ctx, w.org, attempt.ID); err != nil || !step.Done {
			t.Fatalf("request %d: %+v %v", i, step, err)
		}
		if row := w.attempt(t, attempt.ID); row.State != captureauthattempt.StateHUMAN_REQUIRED || w.browser.open() != 0 {
			t.Fatalf("attempt %s open=%d", row.State, w.browser.open())
		}
	}
	if _, err := w.repo.TestCaptureEmailAuth(w.ctx, w.owner, connection.ID); err == nil {
		t.Fatal("the daily budget did not hold")
	}
	if w.email.requested != 0 {
		t.Fatal("an email was requested")
	}
}

func TestEmailAuthExpiresWithoutAnEmailAndCleansUp(t *testing.T) {
	w := newEmailAuthWorld(t)
	connection, _ := w.setup(t)
	attempt, err := w.repo.TestCaptureEmailAuth(w.ctx, w.owner, connection.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.repo.RequestCaptureAuthChallenge(w.ctx, w.org, attempt.ID); err != nil {
		t.Fatal(err)
	}
	if w.browser.open() != 1 {
		t.Fatalf("open=%d while waiting", w.browser.open())
	}
	w.exec(t, `UPDATE capture_auth_attempt SET "deadlineAt"=now() - interval '2 minutes' WHERE id=$1`, attempt.ID)
	if err := w.repo.ReclaimCaptureAuthResources(w.ctx); err != nil {
		t.Fatal(err)
	}
	row := w.attempt(t, attempt.ID)
	if row.State != captureauthattempt.StateEXPIRED || *row.FailureCode != authDeliveryTimeout || row.BrowserClosedAt == nil || w.browser.open() != 0 {
		t.Fatalf("attempt %s %v closed=%v open=%d", row.State, row.FailureCode, row.BrowserClosedAt, w.browser.open())
	}
	if step, err := w.repo.CheckCaptureAuthAttempt(w.ctx, w.org, attempt.ID); err != nil || !step.Done {
		t.Fatalf("check after expiry: %+v %v", step, err)
	}
}

func TestEmailAuthFailedApplyOrRestoreSavesNothing(t *testing.T) {
	for name, fail := range map[string]func(*emailAuthWorld){
		"link refused":    func(w *emailAuthWorld) { w.email.apply = &browser.Failure{Code: browser.SignInIncomplete} },
		"wrong account":   func(w *emailAuthWorld) { w.email.apply = &browser.Failure{Code: browser.WrongAccount} },
		"fresh restore":   func(w *emailAuthWorld) { w.browser.verify = &browser.Failure{Code: browser.NeedsAuth} },
		"export unusable": func(w *emailAuthWorld) { w.browser.exported = &browser.Failure{Code: browser.SessionRestoreFailed} },
	} {
		t.Run(name, func(t *testing.T) {
			w := newEmailAuthWorld(t)
			connection, record := w.setup(t)
			attempt, err := w.repo.TestCaptureEmailAuth(w.ctx, w.owner, connection.ID)
			if err != nil {
				t.Fatal(err)
			}
			fail(w)
			w.runAttempt(t, attempt.ID, record.TestEmail)
			row := w.attempt(t, attempt.ID)
			if row.State == captureauthattempt.StateSUCCEEDED || row.FailureCode == nil {
				t.Fatalf("attempt %s %v", row.State, row.FailureCode)
			}
			conn := w.db.Client.PlatformAppConnection.GetX(w.ctx, connection.ID)
			if conn.Status == platformappconnection.StatusREADY || conn.StateCiphertext != nil || w.browser.open() != 0 {
				t.Fatalf("connection %s state=%v open=%d", conn.Status, conn.StateCiphertext != nil, w.browser.open())
			}
			if setup, _ := w.repo.GetCaptureEmailAuth(w.ctx, w.owner, connection.ID); setup.TestedRevision != nil {
				t.Fatal("a failed test counted as passing")
			}
		})
	}
}

func TestEmailAuthRevokeDuringApplySavesNothing(t *testing.T) {
	w := newEmailAuthWorld(t)
	connection, record := w.setup(t)
	attempt, err := w.repo.TestCaptureEmailAuth(w.ctx, w.owner, connection.ID)
	if err != nil {
		t.Fatal(err)
	}
	// The owner revokes while the browser is using the link.
	w.browser.verify = nil
	w.email.apply = nil
	w.browser.during = nil
	revoked := false
	w.email.applyHook = func() {
		if err := w.repo.RevokeCaptureConnection(w.ctx, w.owner, connection.ID); err != nil {
			t.Error(err)
		}
		revoked = true
	}
	w.runAttempt(t, attempt.ID, record.TestEmail)
	conn := w.db.Client.PlatformAppConnection.GetX(w.ctx, connection.ID)
	if !revoked || conn.Status != platformappconnection.StatusREVOKED || conn.StateCiphertext != nil {
		t.Fatalf("connection %s state=%v", conn.Status, conn.StateCiphertext != nil)
	}
	if row := w.attempt(t, attempt.ID); row.State == captureauthattempt.StateSUCCEEDED || w.browser.open() != 0 {
		t.Fatalf("attempt %s open=%d", row.State, w.browser.open())
	}
}

func TestEmailAuthEmailsNeverCrossWorkspacesOrTime(t *testing.T) {
	a, b := newEmailAuthWorld(t), newEmailAuthWorld(t)
	connA, recordA := a.setup(t)
	connB, _ := b.setup(t)
	attemptA, err := a.repo.TestCaptureEmailAuth(a.ctx, a.owner, connA.ID)
	if err != nil {
		t.Fatal(err)
	}
	attemptB, err := b.repo.TestCaptureEmailAuth(b.ctx, b.owner, connB.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, w := range []*emailAuthWorld{a, b} {
		id := attemptA.ID
		if w == b {
			id = attemptB.ID
		}
		if _, err := w.repo.RequestCaptureAuthChallenge(w.ctx, w.org, id); err != nil {
			t.Fatal(err)
		}
	}
	// Mail sent before the request belongs to no attempt.
	if result, _ := a.deliver(t, "evt_old", "em_old", recordA.TestEmail, "login@example.com", time.Now().Add(-10*time.Minute)); result.Outcome != "ignored" {
		t.Fatalf("old email: %+v", result)
	}
	if result, _ := a.deliver(t, "evt_a", "em_a", recordA.TestEmail, "login@example.com", time.Now().UTC()); result.Outcome != "matched" {
		t.Fatalf("A: %+v", result)
	}
	if a.attempt(t, attemptA.ID).State != captureauthattempt.StateEMAIL_MATCHED {
		t.Fatal("A did not match")
	}
	if b.attempt(t, attemptB.ID).State != captureauthattempt.StateWAITING_FOR_EMAIL {
		t.Fatalf("B moved on A's email: %s", b.attempt(t, attemptB.ID).State)
	}
	if err := b.repo.CancelCaptureAuthAttempt(b.ctx, b.owner, attemptA.ID); err == nil || a.attempt(t, attemptA.ID).State == captureauthattempt.StateCANCELLED {
		t.Fatalf("another workspace cancelled the attempt: %v", err)
	}
}

func TestEmailAuthPausedSetupCanBeFixedAndTested(t *testing.T) {
	w := newEmailAuthWorld(t)
	connection, record := w.setup(t)
	paused, err := w.repo.PauseCaptureEmailAuth(w.ctx, w.owner, connection.ID)
	if err != nil || paused.Status != "PAUSED" {
		t.Fatalf("pause: %+v %v", paused, err)
	}
	saved, err := w.repo.SaveCaptureEmailAuthRecipe(w.ctx, w.owner, connection.ID, SaveCaptureEmailAuthRecipeInput{ExpectedRevision: paused.Revision, Recipe: w.magicRecipe(), ExpectedSenders: []string{"login@example.com"}})
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := w.repo.TestCaptureEmailAuth(w.ctx, w.owner, connection.ID)
	if err != nil {
		t.Fatalf("a paused setup could not be tested: %v", err)
	}
	w.runAttempt(t, attempt.ID, record.TestEmail)
	if _, err := w.repo.EnableCaptureEmailAuth(w.ctx, w.owner, connection.ID, EnableCaptureEmailAuthInput{ExpectedRevision: saved.Revision}); err != nil {
		t.Fatalf("enable after a passing test: %v", err)
	}
}

func TestEmailAuthRecoversALostWebhookFromTheInbox(t *testing.T) {
	w := newEmailAuthWorld(t)
	connection, record := w.setup(t)
	attempt, err := w.repo.TestCaptureEmailAuth(w.ctx, w.owner, connection.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.repo.RequestCaptureAuthChallenge(w.ctx, w.org, attempt.ID); err != nil {
		t.Fatal(err)
	}
	emailID := w.id + "em_lost"
	w.inbox.emails[emailID] = &emailauth.Email{ID: emailID, From: "login@example.com", To: []string{record.TestEmail}, CreatedAt: time.Now().UTC(),
		Text: "Sign in: https://accounts.example.com/auth/callback?token=lost-webhook."}
	// Within the webhook's grace the check waits for the webhook.
	if step, err := w.repo.CheckCaptureAuthAttempt(w.ctx, w.org, attempt.ID); err != nil || step.Matched {
		t.Fatalf("early check: %+v %v", step, err)
	}
	w.exec(t, `UPDATE capture_auth_attempt SET "emailRequestedAt"=now() - interval '1 minute' WHERE id=$1`, attempt.ID)
	w.inbox.emails[emailID].CreatedAt = time.Now().UTC().Add(-30 * time.Second)
	if step, err := w.repo.CheckCaptureAuthAttempt(w.ctx, w.org, attempt.ID); err != nil || !step.Matched {
		t.Fatalf("reconciling check: %+v %v", step, err)
	}
	// The webhook arriving late for the same email is a duplicate.
	if result, err := w.deliver(t, "evt_late", "em_lost", record.TestEmail, "login@example.com", time.Now().UTC()); err != nil || result.Outcome != "duplicate" {
		t.Fatalf("late webhook: %+v %v", result, err)
	}
	if err := w.repo.ApplyCaptureAuthChallenge(w.ctx, w.org, attempt.ID); err != nil {
		t.Fatal(err)
	}
	if row := w.attempt(t, attempt.ID); row.State != captureauthattempt.StateSUCCEEDED || len(w.email.links) != 1 {
		t.Fatalf("attempt %s links=%d", row.State, len(w.email.links))
	}
}

func TestEmailAuthTestsNeverRenewTheHumanCapAndOptInEndsWithItsOwner(t *testing.T) {
	w := newEmailAuthWorld(t)
	connection, record := w.setup(t)
	first, err := w.repo.TestCaptureEmailAuth(w.ctx, w.owner, connection.ID)
	if err != nil {
		t.Fatal(err)
	}
	w.runAttempt(t, first.ID, record.TestEmail)
	anchor := time.Now().UTC().Add(-20 * 24 * time.Hour)
	w.exec(t, `UPDATE platform_app_connection SET "validatedAt"=$1 WHERE id=$2`, anchor, connection.ID)
	second, err := w.repo.TestCaptureEmailAuth(w.ctx, w.owner, connection.ID)
	if err != nil {
		t.Fatal(err)
	}
	w.runAttempt(t, second.ID, record.TestEmail)
	if conn := w.db.Client.PlatformAppConnection.GetX(w.ctx, connection.ID); conn.ValidatedAt.Sub(anchor).Abs() > time.Millisecond {
		t.Fatalf("a test moved the human anchor to %v", conn.ValidatedAt)
	}
	setup, _ := w.repo.GetCaptureEmailAuth(w.ctx, w.owner, connection.ID)
	if _, err := w.repo.EnableCaptureEmailAuth(w.ctx, w.owner, connection.ID, EnableCaptureEmailAuthInput{ExpectedRevision: setup.Revision}); err != nil {
		t.Fatal(err)
	}
	// The approving owner is demoted: no automatic attempt starts.
	w.exec(t, `UPDATE member SET role='member' WHERE "organizationId"=$1 AND "userId"=$2`, w.org, w.owner.UserID)
	w.exec(t, `UPDATE platform_app_connection SET status='NEEDS_AUTH', "stateCiphertext"=NULL WHERE id=$1`, connection.ID)
	conn := w.db.Client.PlatformAppConnection.GetX(w.ctx, connection.ID)
	tx, err := w.db.Client.Tx(w.ctx)
	if err != nil {
		t.Fatal(err)
	}
	attempt, code, err := w.repo.admitAuthAttempt(w.ctx, tx, conn, w.db.Client.CaptureEmailAuthConfig.GetX(w.ctx, setup.ID), captureauthattempt.ModeAUTO_RECOVER, nil, nil)
	_ = tx.Rollback()
	if err != nil || attempt != nil || code != authPolicyReview {
		t.Fatalf("admitted after the owner left: %v %q %v", attempt, code, err)
	}
}
