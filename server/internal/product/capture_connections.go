package product

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"entgo.io/ent/dialect/sql"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/captureemailauthconfig"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/capturejob"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/capturerecipe"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformappconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/productsurface"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseautomationrun"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasesourceevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/sourceapp"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/capture"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/capture/browser"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/capture/emailauth"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/capture/sessionstate"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publicnet"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

const (
	// A person has ten minutes to sign in; the login browser lives no longer.
	captureConnectWindow = 10 * time.Minute
	captureLiveViewStart = 5 * time.Minute
	captureLoginKeep     = 15 * time.Minute
	// captureDefaultStateAge is RFC 007's retention limit for a first pilot: how
	// long a session stays saved without a successful capture proving it.
	captureDefaultStateAge = 24 * time.Hour
	// captureStateAbsoluteAge caps a person's sign-in however often captures
	// renew it; the app's own session expiry still ends it sooner.
	captureStateAbsoluteAge = 30 * 24 * time.Hour
)

// slidingStateExpiry renews a saved session after a verified capture: another
// idle window, never past the absolute cap from the person's last sign-in, and
// never shorter than it already is.
func slidingStateExpiry(connection *ent.PlatformAppConnection, now time.Time, age time.Duration) *time.Time {
	if connection.ValidatedAt == nil || connection.StateExpiresAt == nil {
		return nil
	}
	next := now.Add(age)
	if limit := connection.ValidatedAt.Add(max(age, captureStateAbsoluteAge)); next.After(limit) {
		next = limit
	}
	if !next.After(*connection.StateExpiresAt) {
		return nil
	}
	return &next
}

// CaptureRunner drives remote browsers; browser.Runner is the real one.
type CaptureRunner interface {
	Allocate(ctx context.Context, hosts []string, keepAlive time.Duration) (string, error)
	LiveView(ctx context.Context, sessionID string, connectWithin time.Duration) (string, error)
	Close(ctx context.Context, sessionID string) error
	OpenLogin(ctx context.Context, sessionID string, target browser.Target) error
	ExportWithRoutes(ctx context.Context, sessionID string, target browser.Target) (*browser.State, []browser.DiscoveredRoute, error)
	Verify(ctx context.Context, sessionID string, target browser.Target, state *browser.State) error
	Run(ctx context.Context, sessionID string, input browser.RunInput) (*browser.RunResult, error)
}

// CaptureDispatcher starts durable capture work. It receives only IDs.
type CaptureDispatcher interface {
	StartCaptureJob(ctx context.Context, org, jobID string, resume int) error
	StartCaptureConnection(ctx context.Context, org, connectionID string) error
	StartDeploymentCapture(ctx context.Context, org, deploymentID string) error
}

// Shared SSRF-guarded HTTP client for customer session bootstrap calls so we
// reuse connection pools rather than leaking a fresh transport per request.
var bootstrapHTTPClient = &http.Client{
	Timeout:   15 * time.Second,
	Transport: publicnet.Transport(),
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

const maxBootstrapBodyBytes = 256 << 10

// WithAuthenticatedCapture enables authenticated capture on this process.
func (c *Configuration) WithAuthenticatedCapture(runner CaptureRunner, keys *sessionstate.Keys) *Configuration {
	c.captureRunner, c.captureKeys = runner, keys
	c.captureStateAge = captureDefaultStateAge
	if age, err := time.ParseDuration(strings.TrimSpace(os.Getenv("PLATFORM_CAPTURE_STATE_MAX_AGE"))); err == nil && age > 0 {
		c.captureStateAge = age
	}
	return c
}

// WithCaptureDispatcher lets the outbox start capture workflows.
func (c *Configuration) WithCaptureDispatcher(dispatcher CaptureDispatcher) *Configuration {
	c.captureDispatcher = dispatcher
	return c
}

// CaptureAvailable reports whether this process can run authenticated capture.
func (c *Configuration) CaptureAvailable() bool {
	return c.captureRunner != nil && c.captureKeys != nil
}

// ErrAuthenticatedCaptureUnavailable means no browser provider or state key is configured.
var ErrAuthenticatedCaptureUnavailable = errors.New("authenticated capture is not configured")

// CaptureConnectionRecord is a connection without any session material.
type CaptureConnectionRecord struct {
	ID               string              `json:"id"`
	Name             string              `json:"name"`
	SourceAppID      *string             `json:"sourceAppId"`
	Environment      string              `json:"environment"`
	Origin           string              `json:"origin"`
	Hosts            []string            `json:"hosts"`
	LoginHosts       []string            `json:"loginHosts"`
	ProtectedPath    string              `json:"protectedPath"`
	IdentitySelector string              `json:"identitySelector"`
	ExpectedAccount  string              `json:"expectedAccount"`
	Status           string              `json:"status"`
	Generation       int                 `json:"generation"`
	ValidatedAt      *time.Time          `json:"validatedAt"`
	StateExpiresAt   *time.Time          `json:"stateExpiresAt"`
	ConnectPhase     *string             `json:"connectPhase"`
	FailureCode      *string             `json:"failureCode"`
	DiscoveredRoutes []map[string]string `json:"discoveredRoutes,omitempty"`
	BootstrapURL     *string             `json:"bootstrapUrl,omitempty"`
	HasBootstrap     bool                `json:"hasBootstrap,omitempty"`
	RevokedAt        *time.Time          `json:"revokedAt"`
	CreatedAt        time.Time           `json:"createdAt"`
	UpdatedAt        time.Time           `json:"updatedAt"`
}

func captureConnectionRecord(row *ent.PlatformAppConnection) CaptureConnectionRecord {
	return CaptureConnectionRecord{ID: row.ID, Name: row.Name, SourceAppID: row.SourceAppID, Environment: row.Environment, Origin: row.Origin, Hosts: row.Hosts, LoginHosts: row.LoginHosts,
		ProtectedPath: row.ProtectedPath, IdentitySelector: row.IdentitySelector, ExpectedAccount: row.ExpectedAccount, Status: string(row.Status), Generation: row.Generation,
		ValidatedAt: row.ValidatedAt, StateExpiresAt: row.StateExpiresAt, ConnectPhase: row.ConnectPhase, FailureCode: row.FailureCode,
		DiscoveredRoutes: row.DiscoveredRoutes, BootstrapURL: row.BootstrapURL, HasBootstrap: row.BootstrapURL != nil && row.BootstrapSecretCiphertext != nil,
		RevokedAt: row.RevokedAt, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}

func captureTarget(row *ent.PlatformAppConnection) browser.Target {
	return browser.Target{Origin: row.Origin, Hosts: row.Hosts, ProtectedPath: row.ProtectedPath, IdentitySelector: row.IdentitySelector, ExpectedAccount: row.ExpectedAccount}
}

func captureBinding(row *ent.PlatformAppConnection) sessionstate.Binding {
	return sessionstate.Binding{Organization: row.OrganizationID, Connection: row.ID, Environment: row.Environment, Generation: row.Generation}
}

// CreateCaptureConnectionInput describes the app. Origins and the expected
// account never change on a connection: new authority needs a new connection.
type CreateCaptureConnectionInput struct {
	Name             string   `json:"name"`
	SourceAppID      *string  `json:"sourceAppId"`
	Environment      string   `json:"environment"`
	Origin           string   `json:"origin"`
	Hosts            []string `json:"hosts"`
	LoginHosts       []string `json:"loginHosts"`
	ProtectedPath    string   `json:"protectedPath"`
	IdentitySelector string   `json:"identitySelector"`
	ExpectedAccount  string   `json:"expectedAccount"`
	BootstrapURL     *string  `json:"bootstrapUrl,omitempty"`
	BootstrapSecret  *string  `json:"bootstrapSecret,omitempty"`
	// AssignTestEmail makes the expected account a new Shots test address
	// that can receive sign-in emails (RFC 007A). ExpectedAccount must be empty.
	AssignTestEmail bool `json:"assignTestEmail,omitempty"`
}

// CreateCaptureConnection registers an app; signing in comes next.
func (c *Configuration) CreateCaptureConnection(ctx context.Context, actor Actor, input CreateCaptureConnectionInput) (*CaptureConnectionRecord, error) {
	if err := c.authorizeAutomationAdmin(ctx, actor); err != nil {
		return nil, err
	}
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" || utf8.RuneCountInString(input.Name) > 160 {
		return nil, invalid("Name the connection.")
	}
	if !slices.Contains([]string{"production", "staging", "demo", "development"}, input.Environment) {
		return nil, invalid("Choose an environment.")
	}
	if input.LoginHosts == nil {
		input.LoginHosts = []string{}
	}
	testLocalPart := ""
	var err error
	if input.AssignTestEmail {
		if c.emailAuth == nil {
			return nil, ErrCaptureEmailAuthUnavailable
		}
		if strings.TrimSpace(input.ExpectedAccount) != "" {
			return nil, invalid("Leave the expected account empty: Shots assigns the test email address.")
		}
		if testLocalPart, err = emailauth.NewLocalPart(); err != nil {
			return nil, err
		}
		input.ExpectedAccount = testLocalPart + "@" + c.emailAuth.Domain
	}
	target := browser.Target{Origin: strings.TrimRight(strings.TrimSpace(input.Origin), "/"), Hosts: input.Hosts, ProtectedPath: input.ProtectedPath, IdentitySelector: input.IdentitySelector, ExpectedAccount: input.ExpectedAccount}
	if err := target.Validate(); err != nil {
		return nil, invalid(err.Error())
	}
	if len(input.LoginHosts)+len(input.Hosts) > browser.MaxHosts+10 {
		return nil, invalid("Approve at most 10 sign-in hosts.")
	}
	for _, host := range input.LoginHosts {
		if !browser.ValidHost(host) {
			return nil, invalid("Sign-in hosts must be public host names, such as accounts.example.com.")
		}
	}
	bootstrapURL, bootstrapSecret, err := validateBootstrapConfig(input.BootstrapURL, input.BootstrapSecret, input.Hosts)
	if err != nil {
		return nil, err
	}
	if bootstrapURL != nil && c.captureKeys == nil {
		return nil, ErrAuthenticatedCaptureUnavailable
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if input.SourceAppID != nil {
		owned, err := tx.SourceApp.Query().Where(sourceapp.ID(*input.SourceAppID), sourceapp.OrganizationID(actor.OrganizationID)).Exist(ctx)
		if err != nil {
			return nil, err
		}
		if !owned {
			return nil, publishing.ErrNotFound
		}
	}
	connID := cuid.New()
	create := tx.PlatformAppConnection.Create().SetID(connID).SetOrganizationID(actor.OrganizationID).SetNillableSourceAppID(input.SourceAppID).SetName(input.Name).
		SetEnvironment(input.Environment).SetOrigin(target.Origin).SetHosts(input.Hosts).SetLoginHosts(input.LoginHosts).SetProtectedPath(input.ProtectedPath).
		SetIdentitySelector(input.IdentitySelector).SetExpectedAccount(input.ExpectedAccount).SetCreatedByUserID(actor.UserID)
	if bootstrapURL != nil {
		sealed, err := c.captureKeys.SealBootstrap([]byte(bootstrapSecret), sessionstate.Binding{Organization: actor.OrganizationID, Connection: connID, Environment: input.Environment})
		if err != nil {
			return nil, err
		}
		create.SetBootstrapURL(*bootstrapURL).SetBootstrapSecretCiphertext(sealed)
	}
	row, err := create.Save(ctx)
	if ent.IsConstraintError(err) {
		return nil, publishing.ErrConflict
	}
	if err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.capture_connection_created", "platform_app_connection", row.ID); err != nil {
		return nil, err
	}
	if testLocalPart != "" {
		if _, err := c.createEmailAuthConfig(ctx, tx, actor, row, testLocalPart); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	record := captureConnectionRecord(row)
	return &record, nil
}

// ListCaptureConnections shows the workspace's connections to any member.
func (c *Configuration) ListCaptureConnections(ctx context.Context, actor Actor) ([]CaptureConnectionRecord, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	rows, err := c.client.PlatformAppConnection.Query().Where(platformappconnection.OrganizationID(actor.OrganizationID)).Order(ent.Asc(platformappconnection.FieldName)).All(ctx)
	if err != nil {
		return nil, err
	}
	records := make([]CaptureConnectionRecord, 0, len(rows))
	for _, row := range rows {
		records = append(records, captureConnectionRecord(row))
	}
	return records, nil
}

// CaptureConnectStart hands the connecting person their Live View link. It is
// returned once, is never stored, and must never reach logs or analytics.
type CaptureConnectStart struct {
	IntentID    string    `json:"intentId"`
	LiveViewURL string    `json:"liveViewUrl"`
	ExpiresAt   time.Time `json:"expiresAt"`
}

// StartCaptureConnect opens a browser for an owner or admin to sign in through.
// A reconnect replaces any unfinished sign-in, whose browser closes.
func (c *Configuration) StartCaptureConnect(ctx context.Context, actor Actor, id string) (*CaptureConnectStart, error) {
	if err := c.authorizeAutomationAdmin(ctx, actor); err != nil {
		return nil, err
	}
	if !c.CaptureAvailable() {
		return nil, ErrAuthenticatedCaptureUnavailable
	}
	row, err := c.client.PlatformAppConnection.Query().Where(platformappconnection.ID(id), platformappconnection.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if row.Status == platformappconnection.StatusREVOKED {
		return nil, publishing.ErrInvalidState
	}
	session, err := c.captureRunner.Allocate(ctx, append(slices.Clone(row.Hosts), row.LoginHosts...), captureLoginKeep)
	if err != nil {
		return nil, captureProviderError(err)
	}
	closeNew := func() { _ = c.captureRunner.Close(context.WithoutCancel(ctx), session) }
	if err := c.captureRunner.OpenLogin(ctx, session, captureTarget(row)); err != nil {
		closeNew()
		return nil, captureProviderError(err)
	}
	link, err := c.captureRunner.LiveView(ctx, session, captureLiveViewStart)
	if err != nil {
		closeNew()
		return nil, captureProviderError(err)
	}
	secret := make([]byte, 24)
	if _, err := rand.Read(secret); err != nil {
		closeNew()
		return nil, err
	}
	intent := hex.EncodeToString(secret)
	expires := time.Now().UTC().Add(captureConnectWindow)
	tx, err := c.client.Tx(ctx)
	if err != nil {
		closeNew()
		return nil, err
	}
	defer tx.Rollback()
	locked, err := lockCaptureConnection(ctx, tx, actor.OrganizationID, id)
	if err == nil && locked.Status == platformappconnection.StatusREVOKED {
		err = publishing.ErrInvalidState
	}
	if err == nil {
		err = locked.Update().SetConnectIntentID(intent).SetConnectUserID(actor.UserID).SetConnectSessionID(session).SetConnectExpiresAt(expires).SetConnectPhase("OPEN").ClearFailureCode().Exec(ctx)
	}
	// A person signing in always wins over an automatic email sign-in.
	var autoSessions []string
	if err == nil {
		autoSessions, err = cancelAuthAttempts(ctx, tx, actor.OrganizationID, id, authHumanReconnect)
	}
	if err == nil {
		err = appendConfigurationAudit(ctx, tx, actor, "product.capture_connect_started", "platform_app_connection", id)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		closeNew()
		return nil, err
	}
	if locked.ConnectSessionID != nil {
		_ = c.captureRunner.Close(context.WithoutCancel(ctx), *locked.ConnectSessionID)
	}
	c.closeAuthSessions(ctx, autoSessions)
	return &CaptureConnectStart{IntentID: intent, LiveViewURL: link, ExpiresAt: expires}, nil
}

// captureProviderError hides provider detail from the caller.
func captureProviderError(err error) error {
	var failure *browser.Failure
	if errors.As(err, &failure) {
		return failure
	}
	// Provider errors here carry only a status, so they are safe to log.
	slog.Warn("browser provider request failed", "reason", err.Error())
	return &browser.Failure{Code: browser.ProviderUnavailable}
}

func lockCaptureConnection(ctx context.Context, tx *ent.Tx, org, id string) (*ent.PlatformAppConnection, error) {
	n, err := tx.PlatformAppConnection.Update().Where(platformappconnection.ID(id), platformappconnection.OrganizationID(org)).SetUpdatedAt(time.Now()).Save(ctx)
	if err != nil {
		return nil, err
	}
	if n != 1 {
		return nil, publishing.ErrNotFound
	}
	return tx.PlatformAppConnection.Query().Where(platformappconnection.ID(id), platformappconnection.OrganizationID(org)).Only(ctx)
}

// RefreshCaptureConnect reopens the same person's unfinished sign-in without
// replacing its browser, intent or deadline. The bearer link is never stored.
func (c *Configuration) RefreshCaptureConnect(ctx context.Context, actor Actor, id string) (*CaptureConnectStart, error) {
	if err := c.authorizeAutomationAdmin(ctx, actor); err != nil {
		return nil, err
	}
	if !c.CaptureAvailable() {
		return nil, ErrAuthenticatedCaptureUnavailable
	}
	row, err := c.client.PlatformAppConnection.Query().Where(platformappconnection.ID(id), platformappconnection.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if row.ConnectUserID == nil || *row.ConnectUserID != actor.UserID {
		return nil, publishing.ErrForbidden
	}
	if row.Status == platformappconnection.StatusREVOKED || row.ConnectPhase == nil || *row.ConnectPhase != "OPEN" || row.ConnectIntentID == nil || row.ConnectSessionID == nil || row.ConnectExpiresAt == nil || !row.ConnectExpiresAt.After(time.Now()) {
		return nil, publishing.ErrConflict
	}
	link, err := c.captureRunner.LiveView(ctx, *row.ConnectSessionID, min(captureLiveViewStart, time.Until(*row.ConnectExpiresAt)))
	if err != nil {
		return nil, captureProviderError(err)
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	locked, err := lockCaptureConnection(ctx, tx, actor.OrganizationID, id)
	if err != nil {
		return nil, err
	}
	if locked.Status == platformappconnection.StatusREVOKED || locked.ConnectPhase == nil || *locked.ConnectPhase != "OPEN" || locked.ConnectIntentID == nil || *locked.ConnectIntentID != *row.ConnectIntentID || locked.ConnectSessionID == nil || *locked.ConnectSessionID != *row.ConnectSessionID || locked.ConnectExpiresAt == nil || !locked.ConnectExpiresAt.After(time.Now()) {
		return nil, publishing.ErrConflict
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.capture_connect_view_refreshed", "platform_app_connection", id); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &CaptureConnectStart{IntentID: *row.ConnectIntentID, LiveViewURL: link, ExpiresAt: *row.ConnectExpiresAt}, nil
}

// FinishCaptureConnect records "I signed in" from the person who started this
// exact sign-in, once. It proves nothing: the worker must restore the state in
// a fresh browser before the connection counts as ready.
func (c *Configuration) FinishCaptureConnect(ctx context.Context, actor Actor, id, intent string) error {
	if err := c.authorizeAutomationAdmin(ctx, actor); err != nil {
		return err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	row, err := lockCaptureConnection(ctx, tx, actor.OrganizationID, id)
	if err != nil {
		return err
	}
	if intent == "" || row.ConnectIntentID == nil || *row.ConnectIntentID != intent || row.ConnectUserID == nil || *row.ConnectUserID != actor.UserID ||
		row.ConnectPhase == nil || *row.ConnectPhase != "OPEN" || row.ConnectExpiresAt == nil || !row.ConnectExpiresAt.After(time.Now()) || row.Status == platformappconnection.StatusREVOKED {
		return publishing.ErrConflict
	}
	if err := row.Update().SetConnectPhase("FINISHING").Exec(ctx); err != nil {
		return err
	}
	if err := captureOutbox(ctx, tx, actor.OrganizationID, EventCaptureConnectionFinish, "platform_app_connection", id, intent); err != nil {
		return err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.capture_connect_finished", "platform_app_connection", id); err != nil {
		return err
	}
	return tx.Commit()
}

// CompleteCaptureConnection is the worker's half: export what the person left,
// close their browser, then prove a fresh browser restores it as the expected
// account. Only then is the connection ready and waiting jobs resume.
func (c *Configuration) CompleteCaptureConnection(ctx context.Context, org, id string) error {
	if !c.CaptureAvailable() {
		return ErrAuthenticatedCaptureUnavailable
	}
	row, err := c.client.PlatformAppConnection.Query().Where(platformappconnection.ID(id), platformappconnection.OrganizationID(org)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if row.ConnectPhase == nil || *row.ConnectPhase != "FINISHING" || row.ConnectSessionID == nil || row.ConnectIntentID == nil {
		return nil
	}
	intent, session := *row.ConnectIntentID, *row.ConnectSessionID
	target := captureTarget(row)
	cleanup := context.WithoutCancel(ctx)
	state, discovered, err := c.captureRunner.ExportWithRoutes(ctx, session, target)
	_ = c.captureRunner.Close(cleanup, session)
	if err != nil {
		return c.failCaptureConnection(cleanup, org, id, intent, captureSignInFailure(err, browser.SignInIncomplete))
	}
	fresh, err := c.captureRunner.Allocate(ctx, row.Hosts, 3*time.Minute)
	if err != nil {
		return c.failCaptureConnection(cleanup, org, id, intent, err)
	}
	err = c.captureRunner.Verify(ctx, fresh, target, state)
	_ = c.captureRunner.Close(cleanup, fresh)
	if err != nil {
		return c.failCaptureConnection(cleanup, org, id, intent, captureSignInFailure(err, browser.SessionRestoreFailed))
	}
	actor := Actor{OrganizationID: org, Kind: "service", Display: "capture", RequestID: id}
	_, _, err = c.commitVerifiedConnectionState(ctx, actor, org, id, state, commitConnectionOptions{
		auditAction:    "product.capture_connection_ready",
		discovered:     discovered,
		expectedIntent: &intent,
	})
	return err
}

type commitConnectionOptions struct {
	auditAction       string
	discovered        []browser.DiscoveredRoute
	expectedIntent    *string
	rejectActiveLease bool
	resealedBootstrap *string
	// emailAuth fences an unattended email sign-in's commit to its attempt.
	emailAuth *emailAuthCommit
}

func (c *Configuration) commitVerifiedConnectionState(ctx context.Context, actor Actor, org, id string, state *browser.State, opts commitConnectionOptions) (*ent.PlatformAppConnection, *string, error) {
	body, err := state.Marshal()
	if err != nil {
		return nil, nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer tx.Rollback()
	locked, err := lockCaptureConnection(ctx, tx, org, id)
	if err != nil {
		return nil, nil, err
	}
	now := time.Now().UTC()
	if opts.emailAuth != nil {
		current, err := c.checkEmailAuthCommit(ctx, tx, locked, opts.emailAuth, now)
		if err != nil {
			return nil, nil, err
		}
		if !current {
			// Replaced, revoked or cancelled while verifying: nothing is saved.
			return nil, nil, tx.Commit()
		}
	} else if opts.expectedIntent != nil {
		// Revoked or replaced while verifying: this sign-in no longer counts.
		if locked.Status == platformappconnection.StatusREVOKED || locked.ConnectIntentID == nil || *locked.ConnectIntentID != *opts.expectedIntent || locked.ConnectPhase == nil || *locked.ConnectPhase != "FINISHING" {
			return nil, nil, tx.Commit()
		}
	} else if locked.Status == platformappconnection.StatusREVOKED {
		return nil, nil, publishing.ErrInvalidState
	}
	if opts.rejectActiveLease && locked.LeaseJobID != nil && locked.LeaseExpiresAt != nil && locked.LeaseExpiresAt.After(now) {
		return nil, nil, conflict("A capture job is currently using this connection. Try again when it finishes.")
	}
	var oldSession *string
	if opts.expectedIntent == nil && locked.ConnectSessionID != nil && *locked.ConnectSessionID != "" {
		s := *locked.ConnectSessionID
		oldSession = &s
	}
	generation := locked.Generation
	if locked.ValidatedAt != nil {
		generation++
	}
	binding := captureBinding(locked)
	binding.Generation = generation
	sealed, err := c.captureKeys.Seal(body, binding)
	if err != nil {
		return nil, nil, err
	}
	update := locked.Update().SetStatus(platformappconnection.StatusREADY).SetStateCiphertext(sealed).SetGeneration(generation).AddStateRevision(1).ClearConnectIntentID().ClearConnectUserID().ClearConnectSessionID().ClearConnectExpiresAt().ClearConnectPhase().ClearFailureCode().
		ClearLeaseJobID().ClearLeaseExpiresAt()
	// Only a person's Live View sign-in renews the 30-day human anchor. An
	// email sign-in, automatic or a test, may set it only when none exists.
	if opts.emailAuth != nil && locked.ValidatedAt != nil {
		// An automatic sign-in renews the session but never the person's
		// authorization: ValidatedAt and its 30-day cap stay where they were.
		expires := now.Add(c.captureStateAge)
		if limit := locked.ValidatedAt.Add(captureStateAbsoluteAge); expires.After(limit) {
			expires = limit
		}
		update.SetStateExpiresAt(expires).SetLastAutoAuthenticatedAt(now)
	} else {
		// A person's sign-in, or the first test of a never-authorized connection.
		update.SetValidatedAt(now).SetStateExpiresAt(now.Add(c.captureStateAge))
		if opts.emailAuth != nil {
			update.SetLastAutoAuthenticatedAt(now)
		}
	}
	if opts.resealedBootstrap != nil {
		update.SetBootstrapSecretCiphertext(*opts.resealedBootstrap)
	}
	if len(opts.discovered) > 0 {
		routes := make([]map[string]string, 0, len(opts.discovered))
		for _, r := range opts.discovered {
			routes = append(routes, map[string]string{"path": r.Path, "label": r.Label})
		}
		update.SetDiscoveredRoutes(routes)
	}
	updated, err := update.Save(ctx)
	if err != nil {
		return nil, nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, opts.auditAction, "platform_app_connection", id, map[string]any{"generation": generation}); err != nil {
		return nil, nil, err
	}
	if err := resumeCaptureJobs(ctx, tx, org, id, generation); err != nil {
		return nil, nil, err
	}
	if err := resumeBlockedAutomationRuns(ctx, tx, org, locked.SourceAppID); err != nil {
		return nil, nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, nil, err
	}
	return updated, oldSession, nil
}

// resumeBlockedAutomationRuns automatically re-queues recent release automation
// runs for this connection's source that stopped in needs_attention/needs_auth.
func resumeBlockedAutomationRuns(ctx context.Context, tx *ent.Tx, org string, sourceAppID *string) error {
	if sourceAppID == nil || *sourceAppID == "" {
		return nil
	}
	cutoff := time.Now().UTC().Add(-captureAuthDeadline)
	blocked, err := tx.ReleaseAutomationRun.Query().Where(
		releaseautomationrun.OrganizationID(org),
		releaseautomationrun.StatusEQ("needs_attention"),
		releaseautomationrun.FailureCodeEQ("needs_auth"),
		releaseautomationrun.CancelRequested(false),
		releaseautomationrun.CreatedAtGTE(cutoff),
		func(s *sql.Selector) {
			events := sql.Table(releasesourceevent.Table)
			matching := sql.Select(events.C(releasesourceevent.FieldID)).From(events).Where(sql.And(
				sql.EQ(events.C(releasesourceevent.FieldOrganizationID), org),
				sql.EQ(events.C(releasesourceevent.FieldSourceAppID), *sourceAppID),
			))
			s.Where(sql.In(s.C(releaseautomationrun.FieldEventID), matching))
		},
	).Order(ent.Desc(releaseautomationrun.FieldCreatedAt)).Limit(25).All(ctx)
	if err != nil {
		return err
	}
	for _, run := range blocked {
		n, err := tx.ReleaseAutomationRun.Update().Where(releaseautomationrun.ID(run.ID), releaseautomationrun.OrganizationID(org), releaseautomationrun.StatusEQ("needs_attention"), releaseautomationrun.CancelRequested(false), releaseautomationrun.RecoveryAttempt(run.RecoveryAttempt)).
			SetStatus("queued").ClearCompletedAt().SetFailureCode("").AddRecoveryAttempt(1).Save(ctx)
		if err != nil {
			return err
		}
		if n == 1 {
			if err := automationOutbox(ctx, tx, org, run.ID, EventReleaseAutomationDispatch, run.RecoveryAttempt+1); err != nil {
				return err
			}
		}
	}
	return nil
}

func validateBootstrapConfig(rawURL, rawSecret *string, hosts []string) (*string, string, error) {
	if rawURL == nil || strings.TrimSpace(*rawURL) == "" {
		return nil, "", nil
	}
	cleaned := strings.TrimSpace(*rawURL)
	parsed, err := url.Parse(cleaned)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || !capture.PublicPageURL(cleaned) || !browser.HostApproved(parsed.Hostname(), hosts) {
		return nil, "", invalid("Bootstrap URL must be an https endpoint on one of the connection's approved hosts.")
	}
	if rawSecret == nil || len(strings.TrimSpace(*rawSecret)) < 16 {
		return nil, "", invalid("Bootstrap signing secret must be at least 16 characters.")
	}
	return &cleaned, strings.TrimSpace(*rawSecret), nil
}

func signBootstrapPayload(secret []byte, now time.Time, reqBody []byte) string {
	stamp := strconv.FormatInt(now.Unix(), 10)
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(stamp + "."))
	mac.Write(reqBody)
	return "t=" + stamp + ",v1=" + hex.EncodeToString(mac.Sum(nil))
}

func fetchBootstrapState(ctx context.Context, client *http.Client, endpoint string, secret []byte, reqBody []byte, target browser.Target) (*browser.State, error) {
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(reqBody))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("x-shots-signature", signBootstrapPayload(secret, time.Now().UTC(), reqBody))
	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, &browser.Failure{Code: browser.SessionRestoreFailed}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, &browser.Failure{Code: browser.SessionRestoreFailed}
	}
	rawBody, err := io.ReadAll(io.LimitReader(resp.Body, maxBootstrapBodyBytes+1))
	if err != nil || len(rawBody) > maxBootstrapBodyBytes {
		return nil, &browser.Failure{Code: browser.SessionRestoreFailed}
	}
	parsedState, err := browser.UnmarshalState(rawBody)
	if err != nil {
		return nil, &browser.Failure{Code: browser.SessionRestoreFailed}
	}
	return browser.FilterBootstrapState(parsedState, target)
}

// BootstrapCaptureConnection exchanges a signed request to the customer's
// approved BootstrapURL for short-lived demo session cookies/localStorage,
// verifies them in a fresh isolated browser, seals them, and resumes parked work.
func (c *Configuration) BootstrapCaptureConnection(ctx context.Context, actor Actor, id string) (*CaptureConnectionRecord, error) {
	if err := c.authorizeAutomationAdmin(ctx, actor); err != nil {
		return nil, err
	}
	if !c.CaptureAvailable() {
		return nil, ErrAuthenticatedCaptureUnavailable
	}
	row, err := c.client.PlatformAppConnection.Query().Where(platformappconnection.ID(id), platformappconnection.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if row.Status == platformappconnection.StatusREVOKED {
		return nil, publishing.ErrInvalidState
	}
	if row.LeaseJobID != nil && row.LeaseExpiresAt != nil && row.LeaseExpiresAt.After(time.Now().UTC()) {
		return nil, conflict("A capture job is currently using this connection. Try again when it finishes.")
	}
	if row.BootstrapURL == nil || row.BootstrapSecretCiphertext == nil {
		return nil, invalid("This connection has no session bootstrap endpoint configured.")
	}
	bootstrapBinding := sessionstate.Binding{Organization: row.OrganizationID, Connection: row.ID, Environment: row.Environment}
	secretBytes, staleSecret, err := c.captureKeys.OpenBootstrap(*row.BootstrapSecretCiphertext, bootstrapBinding)
	if err != nil {
		return nil, err
	}
	reqBody, err := json.Marshal(map[string]string{
		"connectionId":    row.ID,
		"environment":     row.Environment,
		"expectedAccount": row.ExpectedAccount,
		"organizationId":  row.OrganizationID,
	})
	if err != nil {
		return nil, err
	}
	target := captureTarget(row)
	state, err := fetchBootstrapState(ctx, bootstrapHTTPClient, *row.BootstrapURL, secretBytes, reqBody, target)
	if err != nil {
		return nil, err
	}
	verifyCtx, cancelVerify := context.WithTimeout(ctx, 55*time.Second)
	defer cancelVerify()
	fresh, err := c.captureRunner.Allocate(verifyCtx, row.Hosts, 2*time.Minute)
	if err != nil {
		return nil, captureProviderError(err)
	}
	verifyErr := c.captureRunner.Verify(verifyCtx, fresh, target, state)
	_ = c.captureRunner.Close(context.WithoutCancel(ctx), fresh)
	if verifyErr != nil {
		return nil, captureSignInFailure(verifyErr, browser.SessionRestoreFailed)
	}
	var resealed *string
	if staleSecret {
		nextSealed, err := c.captureKeys.SealBootstrap(secretBytes, bootstrapBinding)
		if err != nil {
			return nil, err
		}
		resealed = &nextSealed
	}
	updated, oldSession, err := c.commitVerifiedConnectionState(ctx, actor, actor.OrganizationID, id, state, commitConnectionOptions{
		auditAction:       "product.capture_connection_bootstrapped",
		rejectActiveLease: true,
		resealedBootstrap: resealed,
	})
	if err != nil {
		return nil, err
	}
	if oldSession != nil {
		_ = c.captureRunner.Close(context.WithoutCancel(ctx), *oldSession)
	}
	record := captureConnectionRecord(updated)
	return &record, nil
}

func captureSignInFailure(err error, stage browser.Code) error {
	if stage == browser.SignInIncomplete && errors.Is(err, browser.ErrNoPages) {
		return &browser.Failure{Code: stage}
	}
	var failure *browser.Failure
	if errors.As(err, &failure) && failure.Code == browser.NeedsAuth {
		return &browser.Failure{Code: stage}
	}
	return err
}

func (c *Configuration) failCaptureConnection(ctx context.Context, org, id, intent string, cause error) error {
	code := string(browser.ProviderUnavailable)
	var failure *browser.Failure
	if errors.As(cause, &failure) {
		code = string(failure.Code)
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	locked, err := lockCaptureConnection(ctx, tx, org, id)
	if err != nil {
		return err
	}
	if locked.ConnectIntentID == nil || *locked.ConnectIntentID != intent {
		return tx.Commit()
	}
	update := locked.Update().SetFailureCode(code).ClearConnectIntentID().ClearConnectUserID().ClearConnectSessionID().ClearConnectExpiresAt().ClearConnectPhase()
	if locked.Status == platformappconnection.StatusCONNECTING {
		update.SetStatus(platformappconnection.StatusNEEDS_AUTH)
	}
	if err := update.Exec(ctx); err != nil {
		return err
	}
	return tx.Commit()
}

// RevokeCaptureConnection marks access gone first, deletes the state in the
// same commit, cancels waiting work, and then closes any browser still open.
// A late result fails on the generation and the fencing token.
func (c *Configuration) RevokeCaptureConnection(ctx context.Context, actor Actor, id string) error {
	if err := c.authorizeAutomationAdmin(ctx, actor); err != nil {
		return err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	row, err := lockCaptureConnection(ctx, tx, actor.OrganizationID, id)
	if err != nil {
		return err
	}
	sessions := []string{}
	if row.ConnectSessionID != nil {
		sessions = append(sessions, *row.ConnectSessionID)
	}
	open, err := openCaptureSessions(ctx, tx, actor.OrganizationID, id)
	if err != nil {
		return err
	}
	sessions = append(sessions, open...)
	if row.Status != platformappconnection.StatusREVOKED {
		now := time.Now().UTC()
		if err := row.Update().SetStatus(platformappconnection.StatusREVOKED).AddGeneration(1).ClearStateCiphertext().ClearBootstrapSecretCiphertext().ClearValidatedAt().ClearStateExpiresAt().ClearConnectIntentID().
			ClearConnectUserID().ClearConnectSessionID().ClearConnectExpiresAt().ClearConnectPhase().ClearLeaseJobID().ClearLeaseExpiresAt().AddLeaseToken(1).SetRevokedAt(now).Exec(ctx); err != nil {
			return err
		}
		if err := tx.CaptureJob.Update().Where(capturejob.OrganizationID(actor.OrganizationID), capturejob.AppConnectionID(id), capturejob.PhaseNotIn(capturejob.PhaseSUCCEEDED, capturejob.PhaseFAILED, capturejob.PhaseCANCELLED)).
			SetPhase(capturejob.PhaseCANCELLED).SetStatus(capturejob.StatusCANCELLED).SetFailureCode("connection_revoked").Exec(ctx); err != nil {
			return err
		}
		if err := appendConfigurationAudit(ctx, tx, actor, "product.capture_connection_revoked", "platform_app_connection", id); err != nil {
			return err
		}
	}
	// The test address stops routing with the connection's authority.
	if err := tx.CaptureEmailAuthConfig.Update().Where(captureemailauthconfig.OrganizationID(actor.OrganizationID), captureemailauthconfig.ConnectionID(id), captureemailauthconfig.StatusNEQ(captureemailauthconfig.StatusREVOKED)).
		SetStatus(captureemailauthconfig.StatusREVOKED).SetAutoReconnect(false).SetRevokedAt(time.Now().UTC()).AddRevision(1).Exec(ctx); err != nil {
		return err
	}
	autoSessions, err := cancelAuthAttempts(ctx, tx, actor.OrganizationID, id, authRevoked)
	if err != nil {
		return err
	}
	sessions = append(sessions, autoSessions...)
	if err := tx.Commit(); err != nil {
		return err
	}
	if c.captureRunner != nil {
		for _, session := range sessions {
			// The cleanup loop retries any close that fails here.
			_ = c.captureRunner.Close(context.WithoutCancel(ctx), session)
		}
	}
	return nil
}

// CaptureRecipeRecord is one immutable recipe version.
type CaptureRecipeRecord struct {
	ID           string         `json:"id"`
	Name         string         `json:"name"`
	Version      int            `json:"version"`
	Status       string         `json:"status"`
	SurfaceID    *string        `json:"surfaceId"`
	ConnectionID *string        `json:"connectionId"`
	Hash         *string        `json:"hash"`
	Definition   map[string]any `json:"definition"`
	TestedAt     *time.Time     `json:"testedAt"`
	CreatedAt    time.Time      `json:"createdAt"`
}

func captureRecipeRecord(row *ent.CaptureRecipe) CaptureRecipeRecord {
	return CaptureRecipeRecord{ID: row.ID, Name: row.Name, Version: row.Version, Status: string(row.Status), SurfaceID: row.SurfaceID, ConnectionID: row.AppConnectionID, Hash: row.DefinitionHash,
		Definition: row.Definition, TestedAt: row.TestedAt, CreatedAt: row.CreatedAt}
}

// CreateCaptureRecipeInput saves a new version of a screen's capture.
type CreateCaptureRecipeInput struct {
	Name         string         `json:"name"`
	SurfaceID    string         `json:"surfaceId"`
	ConnectionID string         `json:"connectionId"`
	Definition   browser.Recipe `json:"definition"`
}

func createCaptureRecipeInTx(ctx context.Context, tx *ent.Tx, actor Actor, input CreateCaptureRecipeInput) (*ent.CaptureRecipe, *ent.PlatformAppConnection, error) {
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" || utf8.RuneCountInString(input.Name) > 160 {
		return nil, nil, invalid("Name the recipe.")
	}
	if err := input.Definition.Validate(); err != nil {
		return nil, nil, invalid(err.Error())
	}
	hash, err := input.Definition.Hash()
	if err != nil {
		return nil, nil, err
	}
	encoded, err := json.Marshal(input.Definition)
	if err != nil {
		return nil, nil, err
	}
	definition := map[string]any{}
	if err := json.Unmarshal(encoded, &definition); err != nil {
		return nil, nil, err
	}
	connection, err := lockCaptureConnection(ctx, tx, actor.OrganizationID, input.ConnectionID)
	if err != nil {
		return nil, nil, err
	}
	if connection.Status == platformappconnection.StatusREVOKED {
		return nil, nil, publishing.ErrInvalidState
	}
	owned, err := tx.ProductSurface.Query().Where(productsurface.ID(input.SurfaceID), productsurface.OrganizationID(actor.OrganizationID)).Exist(ctx)
	if err != nil {
		return nil, nil, err
	}
	if !owned {
		return nil, nil, publishing.ErrNotFound
	}
	latest, err := tx.CaptureRecipe.Query().Where(capturerecipe.OrganizationID(actor.OrganizationID), capturerecipe.Name(input.Name)).Order(ent.Desc(capturerecipe.FieldVersion)).First(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, nil, err
	}
	version := 1
	if latest != nil {
		version = latest.Version + 1
	}
	row, err := tx.CaptureRecipe.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetNillableSourceAppID(connection.SourceAppID).SetName(input.Name).SetVersion(version).
		SetDefinition(definition).SetSurfaceID(input.SurfaceID).SetAppConnectionID(connection.ID).SetDefinitionHash(hash).SetCreatedByUserID(actor.UserID).Save(ctx)
	if ent.IsConstraintError(err) {
		return nil, nil, publishing.ErrConflict
	}
	if err != nil {
		return nil, nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.capture_recipe_created", "capture_recipe", row.ID, map[string]any{"version": version, "hash": hash}); err != nil {
		return nil, nil, err
	}
	return row, connection, nil
}

// CreateCaptureRecipe saves a draft version. It can run only as a test until a
// successful test lets an owner or admin activate this exact version.
func (c *Configuration) CreateCaptureRecipe(ctx context.Context, actor Actor, input CreateCaptureRecipeInput) (*CaptureRecipeRecord, error) {
	if err := c.authorizeAutomationAdmin(ctx, actor); err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	row, _, err := createCaptureRecipeInTx(ctx, tx, actor, input)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	record := captureRecipeRecord(row)
	return &record, nil
}

// ListCaptureRecipes shows recipes to any member.
func (c *Configuration) ListCaptureRecipes(ctx context.Context, actor Actor) ([]CaptureRecipeRecord, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	rows, err := c.client.CaptureRecipe.Query().Where(capturerecipe.OrganizationID(actor.OrganizationID), capturerecipe.AppConnectionIDNotNil()).Order(ent.Asc(capturerecipe.FieldName), ent.Desc(capturerecipe.FieldVersion)).All(ctx)
	if err != nil {
		return nil, err
	}
	records := make([]CaptureRecipeRecord, 0, len(rows))
	for _, row := range rows {
		records = append(records, captureRecipeRecord(row))
	}
	return records, nil
}

// ActivateCaptureRecipe enables capture after deployment for a tested version,
// replacing any earlier active version of the same recipe.
func (c *Configuration) ActivateCaptureRecipe(ctx context.Context, actor Actor, id string) (*CaptureRecipeRecord, error) {
	if err := c.authorizeAutomationAdmin(ctx, actor); err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	row, err := tx.CaptureRecipe.Query().Where(capturerecipe.ID(id), capturerecipe.OrganizationID(actor.OrganizationID), capturerecipe.AppConnectionIDNotNil()).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if row.TestedAt == nil {
		return nil, invalid("Run a successful test capture of this version first.")
	}
	if err := tx.CaptureRecipe.Update().Where(capturerecipe.OrganizationID(actor.OrganizationID), capturerecipe.Name(row.Name), capturerecipe.StatusEQ(capturerecipe.StatusACTIVE), capturerecipe.IDNEQ(row.ID)).SetStatus(capturerecipe.StatusARCHIVED).Exec(ctx); err != nil {
		return nil, err
	}
	row, err = row.Update().SetStatus(capturerecipe.StatusACTIVE).Save(ctx)
	if err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.capture_recipe_activated", "capture_recipe", id, map[string]any{"version": row.Version}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	record := captureRecipeRecord(row)
	return &record, nil
}

// ArchiveCaptureRecipe stops a recipe from running for future work.
func (c *Configuration) ArchiveCaptureRecipe(ctx context.Context, actor Actor, id string) error {
	if err := c.authorizeAutomationAdmin(ctx, actor); err != nil {
		return err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	n, err := tx.CaptureRecipe.Update().Where(capturerecipe.ID(id), capturerecipe.OrganizationID(actor.OrganizationID), capturerecipe.AppConnectionIDNotNil()).SetStatus(capturerecipe.StatusARCHIVED).Save(ctx)
	if err != nil {
		return err
	}
	if n != 1 {
		return publishing.ErrNotFound
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.capture_recipe_archived", "capture_recipe", id); err != nil {
		return err
	}
	return tx.Commit()
}
